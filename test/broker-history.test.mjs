import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { excludeBrokerIdentityCollisions, matchBrokerOrder, normalizeBrokerOrder, readPaperAccountOrderHistory } from '../agent/broker-history.js';

const account = { paper: true, publicKey: 'paper-key', secretKey: 'paper-secret', brokerAccountId: 'paper-2' };

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(), async json() { return body; } };
}

test('reads a non-active paper account directly without creating a runtime', async () => {
  const calls = [];
  const result = await readPaperAccountOrderHistory(account, {
    fetchImpl: async (url, options) => {
      calls.push([new URL(url), options]);
      return calls.length === 1 ? response({ id: 'paper-2' }) : response([{ id: 'broker-order-1' }]);
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.orders[0].ID, 'broker-order-1');
  assert.equal(calls[0][0].href, 'https://paper-api.alpaca.markets/v2/account');
  assert.equal(calls[1][0].href, 'https://paper-api.alpaca.markets/v2/orders?status=all&direction=asc&limit=500');
  assert.equal(calls[1][1].method, 'GET');
});

test('rejects a provider account identity mismatch and non-paper account', async () => {
  await assert.rejects(
    readPaperAccountOrderHistory(account, { fetchImpl: async () => response({ id: 'wrong-account' }) }),
    /identity mismatch/,
  );
  await assert.rejects(
    readPaperAccountOrderHistory({ ...account, paper: false }, { fetchImpl: async () => response({}) }),
    /only supports paper accounts/,
  );
});

test('normalizes direct Alpaca orders and paginates real array responses by order ID', async () => {
  const seen = [];
  const firstPage = Array.from({ length: 500 }, (_, index) => ({ id: `order-${index + 1}`, client_order_id: `client-${index + 1}`, symbol: 'AAPL', side: 'buy', status: 'filled', filled_qty: '1', filled_avg_price: '10', submitted_at: '2026-01-01T00:00:00Z' }));
  const result = await readPaperAccountOrderHistory(account, {
    fetchImpl: async url => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/account')) return response({ id: 'paper-2' });
      seen.push({ after: parsed.searchParams.get('after_order_id'), limit: parsed.searchParams.get('limit'), direction: parsed.searchParams.get('direction') });
      return seen.length === 1 ? response(firstPage) : response([{ id: 'order-501', client_order_id: 'client-501', symbol: 'AAPL', side: 'sell', status: 'filled', filled_qty: '1', filled_avg_price: '11' }]);
    },
  });
  assert.equal(result.complete, true);
  assert.equal(result.orders.length, 501);
  assert.deepEqual(result.orders[0], { ID: 'order-1', ClientOrderID: 'client-1', Symbol: 'AAPL', Side: 'buy', Status: 'filled', FilledQty: '1', FilledAvgPrice: '10', FilledAt: null, SubmittedAt: '2026-01-01T00:00:00Z' });
  assert.deepEqual(seen, [{ after: null, limit: '500', direction: 'asc' }, { after: 'order-500', limit: '500', direction: 'asc' }]);
});

test('marks pagination incomplete when a full page has no advancing order ID or a later page fails', async () => {
  const page = Array.from({ length: 500 }, (_, index) => ({ id: `order-${index + 1}` }));
  const stalled = await readPaperAccountOrderHistory(account, {
    fetchImpl: async url => new URL(url).pathname.endsWith('/account') ? response({ id: 'paper-2' }) : response(page.map(order => ({ ...order, id: 'same-id' }))),
  });
  assert.equal(stalled.complete, false);
  assert.match(stalled.error, /did not advance/);

  let orderPage = 0;
  const failed = await readPaperAccountOrderHistory(account, {
    fetchImpl: async url => {
      if (new URL(url).pathname.endsWith('/account')) return response({ id: 'paper-2' });
      orderPage += 1;
      return orderPage === 1 ? response(page) : response({ message: 'temporarily unavailable' }, 503);
    },
  });
  assert.equal(failed.complete, false);
  assert.match(failed.error, /request failed/);
});

test('matches local orders by either identity and rejects ambiguous collisions', () => {
  const first = normalizeBrokerOrder({ id: 'broker-1', client_order_id: 'client-1' });
  const second = normalizeBrokerOrder({ id: 'broker-2', client_order_id: 'client-2' });
  assert.equal(matchBrokerOrder({ ID: 'local-id', ClientOrderID: 'client-2' }, [first, second]), second);
  assert.equal(matchBrokerOrder({ ID: 'broker-1', ClientOrderID: 'client-2' }, [first, second]), null);
});

test('excludes broker identity collisions instead of overwriting records', () => {
  const result = excludeBrokerIdentityCollisions([
    normalizeBrokerOrder({ id: 'broker-1', client_order_id: 'client-1' }),
    normalizeBrokerOrder({ id: 'broker-1', client_order_id: 'client-2' }),
    normalizeBrokerOrder({ id: 'broker-3', client_order_id: 'client-3' }),
  ]);
  assert.equal(result.collisions, true);
  assert.deepEqual(result.orders.map(order => order.ID), ['broker-3']);
  assert.deepEqual([...result.ambiguousKeys].sort(), ['broker-1', 'client-1', 'client-2']);
});

test('runtime order envelopes must be complete and available before verified use', async () => {
  const server = await fs.readFile('agent/server.js', 'utf8');
  assert.match(server, /runtimeData\?\.complete === true && runtimeData\?\.broker_state === 'available'/);
  assert.match(server, /readPaperAccountOrderHistory\(account\)/);
  assert.match(server, /return \{ orders: \[\], complete: false, broker_state: 'unavailable'/);
});

test('paper-only reporting rejects live accounts before runtime history', async () => {
  const server = await fs.readFile('agent/server.js', 'utf8');
  assert.match(server, /account\?\.paper !== true/);
  assert.match(server, /paper_only_rejected/);
  assert.doesNotMatch(server, /provider_paper: account\.paper/);
});

test('reconciliation and frontend preserve account-scoped verified history', async () => {
  const server = await fs.readFile('agent/server.js', 'utf8');
  const page = await fs.readFile('agent/public/index.html', 'utf8');
  assert.match(server, /readPaperAccountOrderHistory\(account\)/);
  assert.match(server, /const healthy = health\.ready === true/);
  assert.doesNotMatch(server, /unmatchedBrokerFilled/);
  assert.match(server, /provider_account_id/);
  assert.match(server, /accountStates: accounts/);
  assert.match(page, /verifiedAccountStates = new Map/);
  assert.match(page, /data\.accounts/);
  assert.match(page, /verifiedAccountStates\.get\(t\.accountId \|\| t\.accountName\)\?\.complete === true/);
  assert.doesNotMatch(page, /verifiedTrades=verifiedReconciliationComplete \?/);
});
