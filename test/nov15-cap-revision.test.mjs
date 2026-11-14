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
function fakeGo({ effective = 10, revision = 1, configured = true } = {}) {
  const go = { effective, revision, configured, orders: [], refused: [], onSubmit: null };
  // GET reports the backend's real configured flag; the first PUT configures it and moves the revision even when the stored
  // numeric placeholder already equals the pushed value (as the real backend does).
  go.invalid = false;
  const body = () => ({ effective_pct: go.effective, configured: go.configured, invalid: go.invalid, revision: go.revision });
  go.client = {
    get: async () => ({ data: body() }),
    put: async (_url, payload) => {
      if (!go.configured || go.invalid || payload.pct !== go.effective) go.revision += 1;
      go.effective = payload.pct; go.configured = true; go.invalid = false;
      return { data: body() };
    },
  };
  go.submit = async (endpoint, _method, data) => {
    if (endpoint !== '/options/order') return { ok: true };
    if (go.onSubmit) await go.onSubmit(); // a concurrent change landing while the opening is in flight
    if (data.cap_revision !== undefined && data.cap_revision !== go.revision) { go.refused.push(data); return { status: 'rejected_before_submission', error: 'OPTION_SPREAD_CAP_CHANGED' }; }
    if (go.configured && data.position_intent.endsWith('_to_open') && data.cap_revision === undefined) { go.refused.push(data); return { status: 'rejected_before_submission', error: 'OPTION_SPREAD_CAP_REVISION_REQUIRED' }; }
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

// ── sandboxes where no cap can be in force are left exactly as they were ───────────────────────────────────
test('not applicable: the controller saves and re-checks with read-only observations and never pushes', async () => {
  const calls = [];
  const client = { get: async () => { calls.push('get'); return { data: { configured: false, invalid: false } }; }, put: async () => { calls.push('put'); return { data: {} }; } };
  const saved = [];
  const controller = createOptionSpreadCapController({ getClient: () => client, getSaved: () => 8, applies: () => false, token: () => 't',
    save: async (id, patch, hooks) => { saved.push({ id, patch, hooks }); return { maxOptionSpreadPct: patch.maxOptionSpreadPct }; } });
  const result = await controller.save('s', { maxOptionSpreadPct: 10 });
  assert.equal(result.capSync, 'not_applicable');
  assert.equal(result.guidance.maxOptionSpreadPct, 10);
  assert.deepEqual(saved[0].hooks, {}, 'no push hook');
  assert.deepEqual(await controller.reconcile('s'), { state: 'not_applicable' });
  assert.deepEqual(calls, ['get', 'get'], 'one read-only observation per call (the save and the re-check) and no push');
});

test('not applicable: the opening helper returns undefined, the order carries no revision and goes through', async () => {
  const begin = mcpSource.indexOf('async function capSyncRevision() {');
  const end = mcpSource.indexOf('async function enforcePermissions(', begin);
  const source = mcpSource.slice(begin, end);
  const build = reply => vm.runInNewContext(`${source}; capSyncRevision`, { AGENT_URL: 'http://agent.test', AGENT_QUERY: { sandboxId: 's' }, agentAxios: { get: async () => reply } });
  assert.equal(await build({ data: { state: 'not_applicable', revision: null } })(), undefined);
  assert.equal(await build({ data: { state: 'in_sync', revision: 4 } })(), 4);
  assert.equal(await build({ data: { state: 'unknown' } })(), null);
  const go = fakeGo({ revision: 3, configured: false }); // no cap is configured on a backend where none can be in force
  const ctx = { ...ctxFor(go), capSyncRevision: async () => undefined };
  const result = await run(placeBody(), ctx)({ ...optionOrder });
  assert.equal(result.isError, undefined);
  assert.equal(go.orders[0].cap_revision, undefined);
  assert.doesNotMatch(placeBody(), /capRevision === undefined/, 'only null refuses');
});

// ── not_applicable is an observed backend state, never an inference from saved configuration ──────────────────
// The sync answer maps the controller's state exactly as the server route and the opening helper do.
const syncToRevision = result => (result.state === 'not_applicable' ? undefined : result.state === 'in_sync' ? result.revision : null);

function observedBackend(data, { throws = false, rejects = false } = {}) {
  const calls = { get: 0, put: 0 };
  const client = {
    get: async () => { calls.get += 1; if (throws) throw new Error('read failed'); if (rejects) return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5)); return { data }; },
    put: async () => { calls.put += 1; return { data: {} }; },
  };
  return { client, calls };
}

function nonApplicableController({ client, applicable = () => false, persisted = [] }) {
  const controller = createOptionSpreadCapController({
    getClient: () => client, getSaved: () => 8, applies: applicable, token: () => 't',
    save: async (id, patch) => { persisted.push({ id, patch }); return { maxOptionSpreadPct: patch.maxOptionSpreadPct }; },
  });
  return { controller, persisted };
}

test('observed: saved config says non-applicable while the running backend still has a cap -> unreconciled, no opening, no save, no push', async () => {
  const stuck = fakeGo({ effective: 10, revision: 5 }); // configured: true
  const calls = { put: 0 };
  const put = stuck.client.put; stuck.client.put = async (...a) => { calls.put += 1; return put(...a); };
  const persisted = [];
  const { controller } = nonApplicableController({ client: stuck.client, persisted });
  const reconciled = await controller.reconcile('s');
  assert.equal(reconciled.state, 'unreconciled');
  assert.notEqual(reconciled.state, 'not_applicable');
  // MCP: the opening is refused locally and nothing is submitted.
  const ctx = { ...ctxFor(stuck), capSyncRevision: async () => syncToRevision(await controller.reconcile('s')) };
  const refused = await run(placeBody(), ctx)({ ...optionOrder });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).code, 'OPTION_SPREAD_CAP_UNRESOLVED');
  assert.equal(stuck.orders.length, 0);
  // Save: fails before persistence, and nothing is pushed into an unsupported mode.
  await assert.rejects(() => controller.save('s', { maxOptionSpreadPct: 10 }), /nothing was saved/);
  assert.deepEqual(persisted, []);
  assert.equal(calls.put, 0);
});

test('observed: the running backend reports no cap (configured false, invalid false) -> not_applicable, ordinary order goes through, save allowed with zero pushes', async () => {
  const none = fakeGo({ effective: 10, revision: 0, configured: false });
  const calls = { put: 0 };
  const put = none.client.put; none.client.put = async (...a) => { calls.put += 1; return put(...a); };
  const persisted = [];
  const { controller } = nonApplicableController({ client: none.client, persisted });
  assert.deepEqual(await controller.reconcile('s'), { state: 'not_applicable' });
  const ctx = { ...ctxFor(none), capSyncRevision: async () => syncToRevision(await controller.reconcile('s')) };
  const result = await run(placeBody(), ctx)({ ...optionOrder });
  assert.equal(result.isError, undefined);
  assert.equal(none.orders.length, 1);
  assert.equal(none.orders[0].cap_revision, undefined, 'no revision is sent where no cap exists');
  const saved = await controller.save('s', { maxOptionSpreadPct: 10 });
  assert.equal(saved.capSync, 'not_applicable');
  assert.equal(persisted.length, 1);
  assert.equal(calls.put, 0);
});

test('observed: an invalid cap, missing or malformed flags and a failed read are all unreconciled, never converted to no-cap', async () => {
  const cases = {
    'invalid cap': { configured: false, invalid: true, revision: 1, effective_pct: 10 },
    'configured and invalid': { configured: true, invalid: true, revision: 1, effective_pct: 10 },
    'configured flag missing': { invalid: false, revision: 1 },
    'invalid flag missing': { configured: false, revision: 1 },
    'both missing': { revision: 1 },
    'flags as strings': { configured: 'false', invalid: 'false' },
    'flags as numbers': { configured: 0, invalid: 0 },
    'null flags': { configured: null, invalid: null },
    'empty answer': {},
    'no answer': null,
  };
  for (const [name, data] of Object.entries(cases)) {
    const { client, calls } = observedBackend(data);
    const persisted = [];
    const { controller } = nonApplicableController({ client, persisted });
    assert.equal((await controller.reconcile('s')).state, 'unreconciled', name);
    await assert.rejects(() => controller.save('s', { maxOptionSpreadPct: 10 }), /nothing was saved/, name);
    assert.deepEqual(persisted, [], name);
    assert.equal(calls.put, 0, `${name}: no push`);
  }
  for (const [name, options] of Object.entries({ 'read throws': { throws: true }, 'read times out': { rejects: true } })) {
    const { client, calls } = observedBackend({ configured: false, invalid: false }, options);
    const persisted = [];
    const { controller } = nonApplicableController({ client, persisted });
    assert.equal((await controller.reconcile('s')).state, 'unreconciled', name);
    await assert.rejects(() => controller.save('s', { maxOptionSpreadPct: 10 }), /nothing was saved/, name);
    assert.deepEqual(persisted, [], name);
    assert.equal(calls.put, 0, name);
  }
});

test('observed: with no ready backend the answer is no_backend (openings refuse through the null path) and offline guidance can still be saved', async () => {
  const persisted = [];
  const { controller } = nonApplicableController({ client: null, persisted });
  assert.deepEqual(await controller.reconcile('s'), { state: 'no_backend' });
  assert.equal(syncToRevision({ state: 'no_backend' }), null);
  const saved = await controller.save('s', { maxOptionSpreadPct: 10 });
  assert.equal(saved.capSync, 'no_backend');
  assert.equal(persisted.length, 1);
});

test('observed: applicability is decided inside the serialized queue, after earlier work, not when the call is made', async () => {
  const state = { applicable: false };
  const go = fakeGo({ effective: 8, revision: 2 });
  const order = [];
  const controller = createOptionSpreadCapController({
    getClient: () => go.client, getSaved: () => 8, token: () => 't',
    applies: () => { order.push(`applies:${state.applicable}`); return state.applicable; },
    save: async (id, patch, hooks) => { order.push('save-start'); await new Promise(resolve => setTimeout(resolve, 20)); if (hooks?.beforePersist) await hooks.beforePersist({ maxOptionSpreadPct: patch.maxOptionSpreadPct }); order.push('save-end'); return { maxOptionSpreadPct: patch.maxOptionSpreadPct }; },
  });
  state.applicable = true;
  const slow = controller.save('s', { maxOptionSpreadPct: 8 }); // runs first
  state.applicable = false;
  const queued = controller.reconcile('s'); // asked while the sandbox looks non-applicable...
  state.applicable = true; // ...but it is applicable again by the time the queue reaches it
  await slow;
  const result = await queued;
  assert.equal(result.state, 'in_sync', 'the applicable flow ran because the decision was made inside the queue');
  assert.equal(order.at(-1), 'applies:true');
});
