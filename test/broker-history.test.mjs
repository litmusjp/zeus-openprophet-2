import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { entryAssessmentsByBroker, excludeBrokerIdentityCollisions, matchBrokerOrder, normalizeBrokerOrder, readPaperAccountOrderHistory } from '../agent/broker-history.js';

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

test('entry assessment joins only one exact identity-scoped entry order and keeps score zero', () => {
  const identity = { brokerAccountId: 'acct', tenantId: 'tenant', sandboxId: 'sandbox' };
  const broker = normalizeBrokerOrder({ id: 'broker-entry', client_order_id: 'entry-client' });
  const metadata = JSON.stringify({ assessment_id: 'assessment-1', decision: 'PASS', signal_score: 0, observed_at: '2026-09-18T12:59:00Z', evidence: { score_profile: 'catalyst_momentum_v1', score_source: 'alphadesk_direct_market_data', catalyst_confidence: 0.71 } });
  const entry = { ID: 'broker-entry', ClientOrderID: 'entry-client', Purpose: 'entry', BrokerAccountID: 'acct', PaperLive: 'paper', TenantID: 'tenant', SandboxID: 'sandbox', Metadata: metadata };
  const joined = entryAssessmentsByBroker([entry], [broker], identity);
  assert.equal(joined.get(broker).signalScore, 0);
  assert.equal(joined.get(broker).assessmentId, 'assessment-1');
  assert.equal(joined.get(broker).catalystConfidence, 0.71);
  assert.equal(entryAssessmentsByBroker([{ ...entry, TenantID: 'other' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([{ ...entry, Purpose: 'close' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([entry, { ...entry }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([entry, { ...entry, Metadata: '{bad' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([{ ...entry, ID: 'wrong-broker-id' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([{ ...entry, ClientOrderID: 'wrong-client-id' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([{ ...entry, id: 'wrong-alias-id' }], [broker], identity).size, 0);
});

test('entry catalyst confidence accepts only finite numeric values in range', () => {
  const identity = { brokerAccountId: 'acct', tenantId: 'tenant', sandboxId: 'sandbox' };
  const broker = normalizeBrokerOrder({ id: 'broker-entry', client_order_id: 'entry-client' });
  const entry = value => ({ ID: 'broker-entry', ClientOrderID: 'entry-client', Purpose: 'entry', BrokerAccountID: 'acct', PaperLive: 'paper', TenantID: 'tenant', SandboxID: 'sandbox', Metadata: JSON.stringify({ assessment_id: 'assessment-1', decision: 'PASS', evidence: { catalyst_confidence: value } }) });
  for (const value of [true, '', '0.71', -0.01, 1.01, null]) {
    assert.equal(entryAssessmentsByBroker([entry(value)], [broker], identity).get(broker)?.catalystConfidence, undefined, String(value));
  }
  assert.equal(entryAssessmentsByBroker([entry(0)], [broker], identity).get(broker).catalystConfidence, 0);
  assert.equal(entryAssessmentsByBroker([entry(1)], [broker], identity).get(broker).catalystConfidence, 1);
  const missingScore = { ...entry(0), Metadata: JSON.stringify({ assessment_id: 'assessment-1', decision: 'PASS', signal_score: null }) };
  assert.equal(entryAssessmentsByBroker([missingScore], [broker], identity).get(broker).signalScore, null);
});

test('persisted AlphaDesk assessment projects score context from the actual standalone receipt DTO', async () => {
  const identity = { brokerAccountId: 'acct', tenantId: 'tenant', sandboxId: 'sandbox' };
  const broker = normalizeBrokerOrder({ id: 'broker-entry', client_order_id: 'entry-client' });
  const receipt = JSON.parse(await fs.readFile('services/testdata/op2-pass-receipt.json', 'utf8'));
  const dto = { assessment_id: receipt.assessment_id, decision: receipt.decision, signal_score: receipt.signal_score,
    score_source: receipt.score_source, observed_at: receipt.observed_at,
    score_observed_at: receipt.evidence_observed_at, evidence: receipt };
  const entry = { ID: 'broker-entry', ClientOrderID: 'entry-client', Purpose: 'entry', BrokerAccountID: 'acct', PaperLive: 'paper', TenantID: 'tenant', SandboxID: 'sandbox', Metadata: JSON.stringify(dto) };
  const assessment = entryAssessmentsByBroker([entry], [broker], identity).get(broker);
  assert.equal(assessment.signalScore, receipt.signal_score);
  assert.equal(assessment.scoreProfile, 'catalyst_momentum_v1');
  assert.equal(assessment.scoreType, 'alphadesk_direct_market_data');
  assert.equal(assessment.catalystConfidence, receipt.catalyst_confidence);
  assert.equal(assessment.directionalMomentum, 0.18);
  assert.equal(assessment.observedAt, receipt.evidence_observed_at);
  assert.equal(JSON.stringify(assessment).includes('trade_fingerprint'), false);
  assert.equal(entryAssessmentsByBroker([{ ...entry, SandboxID: 'foreign' }], [broker], identity).size, 0);
  assert.equal(entryAssessmentsByBroker([{ ...entry, Symbol: 'QQQ', TenantID: 'other', BrokerAccountID: 'foreign-account' }], [broker], identity).size, 0);
  for (const [profile, momentum, expected] of [
    ['catalyst_momentum_v1', 0, 0], ['catalyst_momentum_v1', 0.2, 0.2],
    ['catalyst_momentum_v1', -0.01, undefined], ['catalyst_momentum_v1', 0.201, undefined],
    ['other-profile', 0.18, undefined], ['catalyst_momentum_v1', '0.18', undefined],
  ]) {
    const malformed = { ...entry, Metadata: JSON.stringify({ ...dto, evidence: { score_profile: profile, score_components: { directional_momentum: momentum } } }) };
    assert.equal(entryAssessmentsByBroker([malformed], [broker], identity).get(broker)?.directionalMomentum, expected);
  }
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
