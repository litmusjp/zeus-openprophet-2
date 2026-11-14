import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createOptionSpreadCapController, reconcileOptionSpreadCap } from '../agent/option-spread-cap.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';

const mcpSource = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');

// A fake Go backend that enforces what the real one does: it counts every change of the enforced cap and refuses an
// opening whose confirmed revision is not the current one.
function fakeGo({ effective = 10, revision = 1 } = {}) {
  const go = { effective, revision, orders: [], refused: [], onSubmit: null };
  go.client = {
    get: async () => ({ data: { effective_pct: go.effective, configured: true, invalid: false, revision: go.revision } }),
    put: async (_url, payload) => { if (payload.pct !== go.effective) { go.effective = payload.pct; go.revision += 1; } return { data: { effective_pct: go.effective, configured: true, invalid: false, revision: go.revision } }; },
  };
  go.submit = async (endpoint, _method, data) => {
    if (endpoint !== '/options/order') return { ok: true };
    if (go.onSubmit) await go.onSubmit(); // a concurrent change landing while the opening is in flight
    if (data.cap_revision !== undefined && data.cap_revision !== go.revision) { go.refused.push(data); return { status: 'rejected_before_submission', error: 'OPTION_SPREAD_CAP_CHANGED' }; }
    if (data.position_intent.endsWith('_to_open') && data.cap_revision === undefined) { go.refused.push(data); return { status: 'rejected_before_submission', error: 'OPTION_SPREAD_CAP_REVISION_REQUIRED' }; }
    go.orders.push(data);
    return { status: 'accepted' };
  };
  return go;
}

const helpers = { JSON, Number, Math, Date, Intl, Promise, Array, Object, String, Boolean, Set, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, encodeURIComponent };
function mcpCase(start, endMarker) {
  const begin = mcpSource.indexOf(start);
  const end = mcpSource.indexOf(endMarker, begin + start.length);
  assert.ok(begin >= 0 && end > begin, start);
  return mcpSource.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
const placeBody = () => mcpCase("case 'place_options_order': {", "case 'withdraw_planned_intent': {");
const run = (body, ctx) => vm.runInNewContext(`(async (args) => {${body}})`, { ...helpers, ...ctx });
const optionOrder = { symbol: 'AAPL270115C00200000', underlying: 'AAPL', quantity: 1, side: 'buy', order_type: 'limit', position_intent: 'buy_to_open', limit_price: 1, client_order_id: 'x', thesis: 't' };

// The MCP process as the agent runs it: the cap helper asks the agent server, which reconciles and reads the backend's revision.
function ctxFor(go, { events = [] } = {}) {
  const controller = createOptionSpreadCapController({ getClient: () => go.client, getSaved: () => go.effective, save: async () => ({}), token: () => 't' });
  return {
    process: { env: {} },
    isOpeningIntent: p => typeof p !== 'string' || !p || p.includes('open'),
    autoStoreSetup: () => {},
    orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    callTradingBot: async (endpoint, method, data) => { events.push(`call:${endpoint}`); return go.submit(endpoint, method, data); },
    capSyncRevision: async () => { const r = await controller.reconcile('s'); events.push(`confirm:${r.state}`); return r.state === 'in_sync' ? r.revision : null; },
  };
}

test('revision: the opening carries the revision confirmed for it and the backend accepts it', async () => {
  const go = fakeGo({ revision: 5 });
  const result = await run(placeBody(), ctxFor(go))({ ...optionOrder });
  assert.equal(result.isError, undefined);
  assert.equal(go.orders.length, 1);
  assert.equal(go.orders[0].cap_revision, 5);
});

test('revision: a cap save or failed rollback landing between the confirmation and the submission is refused by the backend', async () => {
  const go = fakeGo({ effective: 10, revision: 5 });
  go.onSubmit = async () => { await go.client.put('/x', { pct: 9 }); await go.client.put('/x', { pct: 10 }); }; // save, then a failed rollback back to the saved value
  const result = await run(placeBody(), ctxFor(go))({ ...optionOrder });
  assert.equal(go.orders.length, 0, 'nothing was submitted');
  assert.equal(go.refused.length, 1);
  assert.equal(go.refused[0].cap_revision, 5, 'the stale confirmation is what was refused');
  assert.equal(go.revision, 7, 'the enforced value changed twice although it ended where it began');
  assert.match(JSON.parse(result.content[0].text).error, /OPTION_SPREAD_CAP_CHANGED/);
  go.onSubmit = null;
  const retry = await run(placeBody(), ctxFor(go))({ ...optionOrder, client_order_id: 'y' });
  assert.equal(retry.isError, undefined);
  assert.equal(go.orders.length, 1, 'a fresh confirmation lets the retry through');
  assert.equal(go.orders[0].cap_revision, 7);
});

test('revision: an unchanged value (an unrelated guidance save) does not invalidate an opening in flight', async () => {
  const go = fakeGo({ effective: 10, revision: 5 });
  go.onSubmit = async () => { await go.client.put('/x', { pct: 10 }); };
  assert.equal((await run(placeBody(), ctxFor(go))({ ...optionOrder })).isError, undefined);
  assert.equal(go.orders.length, 1);
});

test('revision: exits carry no revision and are never refused for the cap', async () => {
  const go = fakeGo({ effective: 10, revision: 5 });
  go.onSubmit = async () => { await go.client.put('/x', { pct: 8 }); };
  const events = [];
  const result = await run(placeBody(), ctxFor(go, { events }))({ ...optionOrder, side: 'sell', position_intent: 'sell_to_close' });
  assert.equal(result.isError, undefined);
  assert.equal(go.orders.length, 1);
  assert.equal(go.orders[0].cap_revision, undefined);
  assert.deepEqual(events, ['call:/options/order'], 'no cap confirmation was requested for an exit');
});

test('revision: it is taken after the other local checks, right before the order, not at the start', () => {
  const body = placeBody();
  const at = body.indexOf('capSyncRevision()');
  assert.ok(at > 0);
  for (const earlier of ["callTradingBot('/calendar')", 'normalizeOptionLimitPrice(args.limit_price', 'OPENING_RANGE_NOT_COMPLETE']) {
    assert.ok(body.indexOf(earlier) >= 0 && body.indexOf(earlier) < at, `${earlier} comes before the cap confirmation`);
  }
  assert.ok(body.indexOf("callTradingBot('/options/order'") > at, 'the order is sent after the confirmation');
  assert.match(body, /\.\.\.\(capRevision !== undefined && \{ cap_revision: capRevision \}\)/);
});

test('revision: the controller refuses to confirm a backend that reports no whole-number revision', async () => {
  const noRevision = { get: async () => ({ data: { effective_pct: 10, configured: true, invalid: false } }), put: async () => ({ data: { effective_pct: 10, configured: true, invalid: false } }) };
  assert.equal((await reconcileOptionSpreadCap(noRevision, 10, { token: 't' })).state, 'unreconciled');
  const ok = fakeGo({ revision: 9 });
  assert.deepEqual(await reconcileOptionSpreadCap(ok.client, 10, { token: 't' }), { state: 'in_sync', revision: 9 });
  const corrected = fakeGo({ effective: 8, revision: 9 });
  assert.deepEqual(await reconcileOptionSpreadCap(corrected.client, 10, { token: 't' }), { state: 'in_sync', revision: 10 });
});
