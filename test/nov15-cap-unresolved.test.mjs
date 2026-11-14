import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { AgentHarness } from '../agent/harness.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';

const serverSource = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
const mcpSource = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
const harnessSource = await fs.readFile(new URL('../agent/harness.js', import.meta.url), 'utf8');

// ── the agent is told on every beat while the cap cannot be confirmed ───────────────────────────────────────
async function beatsWith(states) {
  const harness = new AgentHarness({
    sandboxId: 'sbx_fixture', accountId: 'acct', getSandbox: () => ({}), getPermissions: () => ({}), getCurrentPhaseFn: () => 'closed',
    ensureOptionSpreadCapFn: async () => { const next = states.shift(); if (next instanceof Error) throw next; return next; },
  });
  harness.state.activeAccountId = 'acct'; harness.state.activeModel = 'fixture/model';
  const seen = [];
  harness._runClaude = async prompt => { seen.push({ unresolved: harness._capUnresolved, prompt }); return { text: 'idle', sessionEpoch: harness._sessionEpoch }; };
  const count = states.length;
  for (let i = 0; i < count; i += 1) await harness._beat();
  return { harness, seen };
}

test('unresolved cap: persistent failure is stated on every beat; recovery lifts it; nothing is paused', async () => {
  const U = { state: 'unreconciled' };
  const { harness, seen } = await beatsWith([U, U, U, U, { state: 'in_sync' }, { state: 'no_backend' }]);
  assert.deepEqual(seen.map(s => s.unresolved), [true, true, true, true, false, false]);
  for (const beat of seen.slice(0, 4)) {
    assert.match(beat.prompt, /OP2 ENTRY SPREAD CAP UNCONFIRMED/);
    assert.match(beat.prompt, /Keep managing and exiting your positions under your rules; closing and reducing orders are not affected/);
  }
  for (const beat of seen.slice(4)) assert.doesNotMatch(beat.prompt, /ENTRY SPREAD CAP UNCONFIRMED/);
  assert.equal(harness.state.paused, false, 'the agent is never paused');
});

test('unresolved cap: a failing re-check is reported as unresolved, and a missing result is not', async () => {
  const { seen: failing } = await beatsWith([new Error('re-check crashed'), new Error('again')]);
  assert.deepEqual(failing.map(s => s.unresolved), [true, true]);
  const { seen: none } = await beatsWith([undefined, { state: 'no_backend' }]);
  assert.deepEqual(none.map(s => s.unresolved), [false, false]);
});

test('unresolved cap: no start-up flag exists any more; the child environment carries no cap state', () => {
  assert.doesNotMatch(mcpSource, /OPENPROPHET_CAP_UNRESOLVED/);
  assert.doesNotMatch(harnessSource, /OPENPROPHET_CAP_UNRESOLVED/);
});

// ── the MCP server checks the trusted cap state at each options opening ───────────────────────────────────────
const helpers = { JSON, Number, Math, Date, Intl, Promise, Array, Object, String, Boolean, Set, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, encodeURIComponent };
function mcpCase(start, endMarker) {
  const begin = mcpSource.indexOf(start);
  const end = mcpSource.indexOf(endMarker, begin + start.length);
  assert.ok(begin >= 0 && end > begin, start);
  return mcpSource.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
const run = (body, ctx) => vm.runInNewContext(`(async (args) => {${body}})`, { ...helpers, ...ctx });
// `capState` is the trusted state the agent server would report right now; a test can change it between calls.
function ctxFor(calls, capState, checks = []) {
  return {
    process: { env: {} },
    isOpeningIntent: p => typeof p !== 'string' || !p || p.includes('open'),
    autoStoreSetup: () => {},
    orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    callTradingBot: async endpoint => { calls.push(endpoint); return { status: 'accepted' }; },
    capSyncRevision: async () => { checks.push(capState.value); return capState.value === 'in_sync' ? (capState.revision ?? 7) : null; },
  };
}
const optionOrder = { symbol: 'AAPL270115C00200000', underlying: 'AAPL', quantity: 1, side: 'buy', order_type: 'limit', position_intent: 'buy_to_open', limit_price: 1, client_order_id: 'x', thesis: 't' };
const codeOf = result => JSON.parse(result.content[0].text).code;
const placeBody = () => mcpCase("case 'place_options_order': {", "case 'withdraw_planned_intent': {");

test('cap guard: a mismatch that appears after the child started refuses the next opening, and recovery allows it again', async () => {
  const calls = []; const checks = []; const capState = { value: 'in_sync' };
  const place = run(placeBody(), ctxFor(calls, capState, checks));
  assert.equal((await place({ ...optionOrder })).isError, undefined, 'confirmed cap: the opening goes through');
  // A cap save or a failed rollback happens during the same long beat: the very next opening sees it.
  capState.value = 'unreconciled';
  const refused = await place({ ...optionOrder, client_order_id: 'y' });
  assert.equal(refused.isError, true);
  assert.equal(codeOf(refused), 'OPTION_SPREAD_CAP_UNRESOLVED');
  assert.match(JSON.parse(refused.content[0].text).error, /checked at every opening/);
  assert.deepEqual(calls, ['/options/order'], 'no backend call for the refused opening');
  capState.value = 'in_sync';
  assert.equal((await place({ ...optionOrder, client_order_id: 'z' })).isError, undefined, 'the next confirmed check lets openings through');
  assert.deepEqual(checks, ['in_sync', 'unreconciled', 'in_sync'], 'one trusted check per opening');
});

test('cap guard: every state other than in_sync, and an unreachable check, fails closed', async () => {
  for (const state of ['unreconciled', 'no_backend', 'unknown', undefined, null, '', 'IN_SYNC']) {
    const calls = [];
    const refused = await run(placeBody(), ctxFor(calls, { value: state }))({ ...optionOrder });
    assert.equal(codeOf(refused), 'OPTION_SPREAD_CAP_UNRESOLVED', String(state));
    assert.deepEqual(calls, []);
  }
  const unreachable = { ...ctxFor([], { value: 'in_sync' }), capSyncRevision: async () => null };
  assert.equal(codeOf(await run(placeBody(), unreachable)({ ...optionOrder })), 'OPTION_SPREAD_CAP_UNRESOLVED');
});

test('cap guard: it does not depend on any heartbeat, so an ad-hoc or message beat is covered', async () => {
  // A fresh tool process that never saw a heartbeat (a user message or ad-hoc beat): the check is made at the opening itself.
  const checks = [];
  const adHoc = run(placeBody(), ctxFor([], { value: 'unreconciled' }, checks));
  assert.equal(codeOf(await adHoc({ ...optionOrder })), 'OPTION_SPREAD_CAP_UNRESOLVED');
  assert.deepEqual(checks, ['unreconciled']);
  assert.equal((await run(placeBody(), ctxFor([], { value: 'in_sync' }))({ ...optionOrder })).isError, undefined);
  assert.doesNotMatch(placeBody(), /OPENPROPHET_CAP|_capUnresolved/, 'the guard reads no state fixed at start-up');
});

test('cap guard: exits, reducing orders and the equity paths never call the check', async () => {
  const calls = []; const checks = []; const capState = { value: 'unreconciled' };
  const place = run(placeBody(), ctxFor(calls, capState, checks));
  const closing = await place({ ...optionOrder, side: 'sell', position_intent: 'sell_to_close' });
  assert.equal(closing.isError, undefined, 'an exit is not refused');
  assert.equal(calls.at(-1), '/options/order');
  assert.deepEqual(checks, [], 'no cap check for an exit');
  const buy = await run(mcpCase("case 'place_buy_order': {", "case 'place_sell_order': {"), ctxFor(calls, capState, checks))({ symbol: 'AAPL', quantity: 1, order_type: 'market' });
  assert.equal(buy.isError, undefined, 'the options spread cap does not govern equity orders');
  assert.deepEqual(checks, []);
  assert.equal((mcpSource.match(/capSyncRevision\(\)/g) || []).length, 2, 'one definition and one use: the options opening guard');
  for (const marker of ["case 'cancel_order': {", "case 'get_options_positions': {", "case 'get_orders': {", "case 'place_buy_order': {", "case 'place_managed_position': {"]) {
    const index = mcpSource.indexOf(marker);
    if (index < 0) continue;
    assert.doesNotMatch(mcpSource.slice(index, index + 900), /capSyncRevision/, marker);
  }
});

test('cap guard: the daily-loss lock keeps its own message and order of precedence', async () => {
  const ctx = ctxFor([], { value: 'unreconciled' });
  ctx.process = { env: { OPENPROPHET_OPENINGS_BLOCKED: '1' } };
  assert.equal(codeOf(await run(placeBody(), ctx)({ ...optionOrder })), 'DAILY_LOSS_LIMIT_REACHED');
});

test('cap guard: the real check reads the agent server and returns a revision only for in_sync', async () => {
  const begin = mcpSource.indexOf('async function capSyncRevision() {');
  const end = mcpSource.indexOf('async function enforcePermissions(', begin);
  assert.ok(begin > 0 && end > begin);
  const source = mcpSource.slice(begin, end);
  const seen = [];
  const build = reply => vm.runInNewContext(`${source}; capSyncRevision`, {
    AGENT_URL: 'http://agent.test', AGENT_QUERY: { sandboxId: 'sbx_1' },
    agentAxios: { get: async (url, options) => { seen.push({ url, options }); if (reply instanceof Error) throw reply; return reply; } },
  });
  assert.equal(await build({ data: { state: 'in_sync', revision: 12 } })(), 12);
  assert.equal(seen[0].url, 'http://agent.test/api/option-spread-cap/sync');
  assert.deepEqual(seen[0].options.params, { sandboxId: 'sbx_1' });
  assert.ok(seen[0].options.timeout > 0, 'bounded wait');
  for (const reply of [{ data: { state: 'unreconciled', revision: 3 } }, { data: { state: 'no_backend', revision: 3 } }, { data: { state: 'in_sync' } }, { data: { state: 'in_sync', revision: null } }, { data: { state: 'in_sync', revision: '3' } }, { data: { state: 'in_sync', revision: 1.5 } }, { data: {} }, { data: null }, undefined, new Error('agent server down')]) {
    assert.equal(await build(reply)(), null, String(reply?.message || JSON.stringify(reply)));
  }
});

test('cap guard: the agent server answers from a reconcile that is serialized with saves', () => {
  const start = serverSource.indexOf("app.get('/api/option-spread-cap/sync'");
  assert.ok(start > 0, 'route present');
  const route = serverSource.slice(start, serverSource.indexOf("app.put('/api/trading-guidance'", start));
  assert.match(route, /optionSpreadCap\.reconcile\(sandboxId\)/);
  assert.match(route, /revision: result\.state === 'in_sync' \? result\.revision : null/);
  assert.match(route, /status\(404\)\.json\(\{ state: 'unknown'/);
  assert.match(route, /status\(503\)\.json\(\{ state: 'unknown'/);
});

// ── the logout invocation no longer inherits server secrets ──────────────────────────────────────────────
test('credential: every opencode invocation in the server filters its environment, including logout', () => {
  const lines = serverSource.split('\n');
  const starts = lines.map((line, index) => (/execSync\(|spawn\(/.test(line) && /opencode/.test(line) ? index : -1)).filter(index => index >= 0);
  assert.ok(starts.length >= 3, 'opencode invocations located');
  for (const index of starts) {
    // a multi-line call carries its env a few lines below the call
    const call = lines.slice(index, index + 6).join('\n');
    if (/env:\s*managerEnv\b/.test(call)) {
      // the manager child takes its environment from a variable: every assignment of it must be filtered
      const assignments = lines.map((line, i) => (/managerEnv = \{/.test(line) ? i : -1)).filter(i => i >= 0);
      assert.ok(assignments.length >= 2, 'both managerEnv assignments located');
      for (const i of assignments) assert.match(lines.slice(i, i + 4).join('\n'), /stripOperatorSecrets\(process\.env\)|nativeOpenCodeEnv\(/, `managerEnv at line ${i + 1}`);
      continue;
    }
    assert.match(call, /stripOperatorSecrets\(process\.env\)/, lines[index].trim().slice(0, 100));
  }
  assert.match(serverSource, /opencode auth logout 2>&1', \{ timeout: 10000, encoding: 'utf-8', env: stripOperatorSecrets\(process\.env\) \}/);
});
