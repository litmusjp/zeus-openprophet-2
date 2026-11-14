import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { AgentHarness } from '../agent/harness.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';

const serverSource = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
const mcpSource = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');

// ── unresolved cap: openings are refused, management and exits are not ─────────────────────────────────
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

test('unresolved cap: persistent failure keeps openings blocked on every beat and says so; recovery lifts it', async () => {
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

test('unresolved cap: a failing re-check fails closed, and a missing result does not block', async () => {
  const { seen: failing } = await beatsWith([new Error('re-check crashed'), new Error('again')]);
  assert.deepEqual(failing.map(s => s.unresolved), [true, true]);
  const { seen: none } = await beatsWith([undefined, { state: 'no_backend' }]);
  assert.deepEqual(none.map(s => s.unresolved), [false, false]);
});

test('unresolved cap: the agent child gets the MCP guard value (always set) and nothing inherited can change it', async () => {
  const fakeProcess = () => {
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
    queueMicrotask(() => { proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`); proc.emit('exit', 0, null); proc.emit('close', 0, null); });
    return proc;
  };
  const envFor = async (unresolved, inherited = {}) => {
    let captured;
    const h = new AgentHarness({ opencodeEnv: inherited, spawnFn: (_c, _a, options) => { captured = options.env; return fakeProcess(); } });
    h._capUnresolved = unresolved;
    await h._runClaude('prompt', 'opencode/big-pickle');
    return captured;
  };
  assert.equal((await envFor(true)).OPENPROPHET_CAP_UNRESOLVED, '1');
  assert.equal((await envFor(false, { OPENPROPHET_CAP_UNRESOLVED: '1' })).OPENPROPHET_CAP_UNRESOLVED, '', 'an inherited value cannot switch it on');
});

const helpers = { JSON, Number, Math, Date, Intl, Promise, Array, Object, String, Boolean, Set, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, encodeURIComponent };
function mcpCase(start, endMarker) {
  const begin = mcpSource.indexOf(start);
  const end = mcpSource.indexOf(endMarker, begin + start.length);
  assert.ok(begin >= 0 && end > begin, start);
  return mcpSource.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
const run = (body, ctx) => vm.runInNewContext(`(async (args) => {${body}})`, { ...helpers, ...ctx });
const ctxFor = (calls, env) => ({
  process: { env },
  isOpeningIntent: p => typeof p !== 'string' || !p || p.includes('open'),
  autoStoreSetup: () => {},
  orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  callTradingBot: async endpoint => { calls.push(endpoint); return { status: 'accepted' }; },
});
const optionOrder = { symbol: 'AAPL270115C00200000', underlying: 'AAPL', quantity: 1, side: 'buy', order_type: 'limit', position_intent: 'buy_to_open', limit_price: 1, client_order_id: 'x', thesis: 't' };
const codeOf = result => JSON.parse(result.content[0].text).code;
const placeBody = () => mcpCase("case 'place_options_order': {", "case 'withdraw_planned_intent': {");

test('unresolved cap: the MCP guard refuses every opening tool and never a closing or reducing order', async () => {
  const calls = [];
  const env = { OPENPROPHET_CAP_UNRESOLVED: '1' };
  const place = run(placeBody(), ctxFor(calls, env));
  const refused = await place({ ...optionOrder });
  assert.equal(refused.isError, true);
  assert.equal(codeOf(refused), 'OPTION_SPREAD_CAP_UNRESOLVED');
  assert.match(JSON.parse(refused.content[0].text).error, /OP2 cannot confirm its entry spread cap/);
  assert.deepEqual(calls, [], 'no backend call for a refused opening');
  const closing = await place({ ...optionOrder, side: 'sell', position_intent: 'sell_to_close' });
  assert.equal(closing.isError, undefined, 'an exit is not refused');
  assert.equal(calls.at(-1), '/options/order');
  const buy = run(mcpCase("case 'place_buy_order': {", "case 'place_sell_order': {"), ctxFor(calls, env));
  assert.equal(codeOf(await buy({ symbol: 'AAPL', quantity: 1, order_type: 'market' })), 'OPTION_SPREAD_CAP_UNRESOLVED');
  const managed = run(mcpCase("case 'place_managed_position': {", "case 'get_managed_positions': {"), ctxFor(calls, env));
  assert.equal(codeOf(await managed({ symbol: 'AAPL', side: 'buy', quantity: 1 })), 'OPTION_SPREAD_CAP_UNRESOLVED');
  const free = await run(placeBody(), ctxFor([], {}))({ ...optionOrder });
  assert.equal(free.isError, undefined, 'a confirmed cap means no refusal');
  const both = await run(placeBody(), ctxFor([], { OPENPROPHET_OPENINGS_BLOCKED: '1', OPENPROPHET_CAP_UNRESOLVED: '1' }))({ ...optionOrder });
  assert.equal(codeOf(both), 'DAILY_LOSS_LIMIT_REACHED', 'the daily-loss lock keeps its own message');
});

test('unresolved cap: only opening paths carry the guard (cancel and read tools are untouched)', () => {
  assert.equal((mcpSource.match(/OPENPROPHET_CAP_UNRESOLVED === '1'/g) || []).length, 3);
  for (const marker of ["case 'cancel_order': {", "case 'get_options_positions': {", "case 'get_orders': {"]) {
    const index = mcpSource.indexOf(marker);
    if (index < 0) continue;
    assert.doesNotMatch(mcpSource.slice(index, index + 800), /OPENPROPHET_CAP_UNRESOLVED/, marker);
  }
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
