import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { AgentHarness, planContextText, recoverHeldPositionPlans } from '../agent/harness.js';
import { ChatStore } from '../agent/chat-store.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';

const source = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
const serverSource = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');

// ── C1: the daily-loss lock never pauses; the harness and MCP tools only reflect it ───────────────
test('C1: the beat-end breaker asks Go to evaluate the lock and never pauses an agent', () => {
  const start = serverSource.indexOf("targetHarness.state.on('beat_end'");
  const end = serverSource.indexOf('scheduleDailySummaryForHarness(targetHarness)', start);
  assert.ok(start > 0 && end > start, 'breaker block located');
  const block = serverSource.slice(start, end);
  assert.match(block, /\/api\/v1\/risk\/daily-loss\/evaluate/);
  assert.doesNotMatch(block, /\.pause\(/);
  assert.doesNotMatch(block, /accountDailyPnl|dayLossPct/, 'no second percentage calculation in Node');
  assert.match(block, /newly_locked/);
  assert.doesNotMatch(serverSource, /auto-paused/);
});

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
  queueMicrotask(() => { proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`); proc.emit('exit', 0, null); proc.emit('close', 0, null); });
  return proc;
}

test('C1: the harness reads the lock each beat, tells the agent, and sets the MCP guard value (always set)', async () => {
  let reply = { locked: true, loss_pct: 5.4, session_date: '2026-11-16' };
  const harness = new AgentHarness({ sandboxId: 'sbx_x', getSessionLockFn: async () => reply });
  const text = await harness._sessionLockContext();
  assert.match(text, /DAILY LOSS LIMIT REACHED \(5\.4%\): OP2 refuses new openings until the next session\. Keep managing and exiting your positions/);
  assert.ok(harness._openingsBlocked);
  const envFor = async (parentEnv = {}) => {
    let captured;
    const h = new AgentHarness({ opencodeEnv: parentEnv, spawnFn: (_c, _a, options) => { captured = options.env; return fakeProcess(); } });
    h._openingsBlocked = harness._openingsBlocked;
    await h._runClaude('prompt', 'opencode/big-pickle');
    return captured;
  };
  assert.equal((await envFor()).OPENPROPHET_OPENINGS_BLOCKED, '1');
  reply = { locked: false };
  assert.equal(await harness._sessionLockContext(), '');
  assert.equal(harness._openingsBlocked, null);
  const h2 = new AgentHarness({ spawnFn: (_c, _a, options) => { h2.env = options.env; return fakeProcess(); }, opencodeEnv: { OPENPROPHET_OPENINGS_BLOCKED: '1' } });
  await h2._runClaude('prompt', 'opencode/big-pickle');
  assert.equal(h2.env.OPENPROPHET_OPENINGS_BLOCKED, '', 'an inherited value cannot switch the guard on');
  // A lock-read failure never breaks the beat (Go still enforces the lock).
  const failing = new AgentHarness({ sandboxId: 'sbx_x', getSessionLockFn: async () => { throw new Error('down'); } });
  assert.equal(await failing._sessionLockContext(), '');
});

test('C1: the GUARDRAILS text no longer says auto-pause', async () => {
  const text = await fs.readFile(new URL('../agent/harness.js', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /auto-pause if exceeded/);
  assert.match(text, /OP2 refuses new openings for the rest of that session; keep managing and exiting positions under your rules/);
});

const helpers = { JSON, Number, Math, Date, Intl, Promise, Array, Object, String, Boolean, Set, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, encodeURIComponent };
function caseBody(start, endMarker) {
  const begin = source.indexOf(start);
  const end = source.indexOf(endMarker, begin + start.length);
  assert.ok(begin >= 0 && end > begin, start);
  return source.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
const run = (body, ctx) => vm.runInNewContext(`(async (args) => {${body}})`, { ...helpers, ...ctx });
const BASE_CTX = calls => ({
  process: { env: { OPENPROPHET_OPENINGS_BLOCKED: '1' } },
  capSyncAllowsOpening: async () => true, // the cap guard has its own tests (nov15-cap-unresolved)
  isOpeningIntent: p => typeof p !== 'string' || !p || p.includes('open'),
  autoStoreSetup: () => {},
  orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  callTradingBot: async endpoint => { calls.push(endpoint); return { status: 'accepted' }; },
});
const optionOrder = { symbol: 'AAPL270115C00200000', underlying: 'AAPL', quantity: 1, side: 'buy', order_type: 'limit', position_intent: 'buy_to_open', limit_price: 1, client_order_id: 'x', thesis: 't' };

test('C1: the MCP guard refuses every opening tool while the lock is set, and never reducing orders', async () => {
  const calls = [];
  const place = run(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), BASE_CTX(calls));
  const refused = await place({ ...optionOrder });
  assert.equal(refused.isError, true);
  assert.equal(JSON.parse(refused.content[0].text).code, 'DAILY_LOSS_LIMIT_REACHED');
  assert.deepEqual(calls, [], 'no backend call for a refused opening');
  const closing = await place({ ...optionOrder, side: 'sell', position_intent: 'sell_to_close' });
  assert.equal(closing.isError, undefined);
  assert.equal(calls.at(-1), '/options/order');
  const buy = run(caseBody("case 'place_buy_order': {", "case 'place_sell_order': {"), BASE_CTX(calls));
  assert.equal(JSON.parse((await buy({ symbol: 'AAPL', quantity: 1, order_type: 'market' })).content[0].text).code, 'DAILY_LOSS_LIMIT_REACHED');
  const managed = run(caseBody("case 'place_managed_position': {", "case 'get_managed_positions': {"), BASE_CTX(calls));
  assert.equal(JSON.parse((await managed({ symbol: 'AAPL', side: 'buy', quantity: 1 })).content[0].text).code, 'DAILY_LOSS_LIMIT_REACHED');
  const free = BASE_CTX([]);
  free.process = { env: {} };
  const open = await run(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), free)({ ...optionOrder });
  assert.equal(open.isError, undefined, 'no lock means no refusal');
});

// ── Tool fix: get_daily_features batches ─────────────────────────────────────────────────────────
function featuresRunner(failBatch = -1) {
  const calls = [];
  const fn = run(caseBody("case 'get_daily_features': {", "case 'get_option_expirations': {"), {
    callTradingBot: async endpoint => {
      calls.push(endpoint);
      if (calls.length - 1 === failBatch) throw new Error('timeout');
      const symbols = decodeURIComponent(endpoint.split('symbols=')[1]).split(',');
      return { as_of: '2026-11-16T15:00:00Z', count: symbols.length, basis: 'completed daily bars only', features: symbols.map(symbol => ({ symbol, feed: 'sip' })) };
    },
  });
  return { fn, calls };
}
const names = n => Array.from({ length: n }, (_, i) => `S${i}`);

test('daily features: 25 or fewer symbols is one call, unchanged', async () => {
  const { fn, calls } = featuresRunner();
  const out = JSON.parse((await fn({ symbols: names(25) })).content[0].text);
  assert.equal(calls.length, 1);
  assert.equal(out.count, 25);
  assert.equal(out.batches, undefined);
});

test('daily features: 61 symbols are split into batches of 25, de-duplicated, merged in order', async () => {
  const { fn, calls } = featuresRunner();
  const list = [...names(60), 's5', ' S6 ', 'EXTRA'];
  const out = JSON.parse((await fn({ symbols: list })).content[0].text);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(c => decodeURIComponent(c.split('symbols=')[1]).split(',').length), [25, 25, 11]);
  assert.equal(out.count, 61);
  assert.equal(out.features.length, 61);
  assert.equal(out.batches, 3);
  assert.equal(out.features[0].symbol, 'S0');
  assert.equal(out.features[60].symbol, 'EXTRA');
  assert.equal(out.as_of, '2026-11-16T15:00:00Z');
});

test('daily features: a failed batch gives per-symbol errors and never loses the other batches', async () => {
  const { fn } = featuresRunner(1);
  const out = JSON.parse((await fn({ symbols: names(60) })).content[0].text);
  assert.equal(out.features.length, 60);
  const failed = out.features.filter(f => f.error);
  assert.equal(failed.length, 25);
  assert.match(failed[0].error, /batch failed: timeout/);
  assert.equal(out.features.filter(f => !f.error).length, 35);
});

// ── C2: opener status, adoption, 30-day window ──────────────────────────────────────────────────
const position = { BrokerAccountID: 'c3051a39-0470-4852-9297-e348a407bb51', PaperLive: 'paper', TenantID: '956ff9e4', SandboxID: 'sbx_956ff9e4', Symbol: 'DE261204C00700000', Underlying: 'DE', Qty: 2, AvgEntryPrice: 26.5, Side: 'long' };
const liveOrder = { BrokerAccountID: position.BrokerAccountID, PaperLive: 'paper', TenantID: position.TenantID, SandboxID: position.SandboxID, Symbol: position.Symbol, PositionIntent: 'buy_to_open', Side: 'buy', Status: 'filled', FilledQty: 2, FilledAvgPrice: 26.5, ID: 'order-de-1', ClientOrderID: 'vega-de-1' };
const THESIS = 'Buy two DE calls: daily trend above SMA20, invalidation 671.65, exit before earnings.';
const entryRecord = (extra = {}) => ({
  kind: 'tool_call', eventType: 'tool_call', tool: 'place_options_order', status: 'completed', timestamp: '2026-11-11T15:00:00.000Z',
  args: { client_order_id: liveOrder.ClientOrderID, symbol: liveOrder.Symbol, position_intent: 'buy_to_open', thesis: THESIS },
  result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ broker_account_id: position.BrokerAccountID, paper_live: 'paper', tenant_id: position.TenantID, sandbox_id: position.SandboxID, order_id: liveOrder.ID, client_order_id: liveOrder.ClientOrderID, status: 'filled', filled_qty: 2, symbol: position.Symbol }) }] }),
  ...extra,
});
const adoptRecord = (extra = {}) => ({ kind: 'tool_call', eventType: 'tool_call', tool: 'log_decision', status: 'completed', timestamp: '2026-11-16T14:20:00.000Z', args: { action: 'ADOPT', symbol: 'DE261204C00700000', market_data: { entry_order_id: 'order-de-1' }, reasoning: 'Adopted: my own stop 660, target 33, exit Nov 24.' }, ...extra });
const session = (agentId, messages, adoptions = [], createdAt = '2026-11-11T14:00:00.000Z') => ({ id: `s-${agentId || 'none'}-${messages.length}${adoptions.length}`, accountId: '956ff9e4', createdAt, metadata: agentId ? { agentId, agentName: agentId === 'long-vol' ? 'Vega' : 'Guardian' } : {}, messages, adoptions });
const recover = (evidence, currentAgentId) => recoverHeldPositionPlans({ accountId: '956ff9e4', sandboxId: position.SandboxID, positions: [position], orders: [liveOrder], ordersComplete: true, evidence, currentAgentId });

test('C2: own, other and unknown are decided only from the matched entry evidence', () => {
  assert.equal(recover([session('long-vol', [entryRecord()])], 'long-vol')[0].openerStatus, 'own');
  const other = recover([session('long-vol', [entryRecord()])], 'conservative')[0];
  assert.equal(other.openerStatus, 'other');
  assert.equal(other.opener.agentName, 'Vega');
  assert.equal(other.adopted, false);
  assert.equal(recover([session(null, [entryRecord()])], 'conservative')[0].openerStatus, 'unknown', 'no actor evidence is unknown, never other');
  assert.equal(recover([session('long-vol', [entryRecord()])], '')[0].openerStatus, 'unknown', 'without a current agent nothing is called inherited');
  assert.equal(recover([session('long-vol', [entryRecord({ actorSnapshot: { agentId: 'conservative', agentName: 'Guardian' } })])], 'conservative')[0].openerStatus, 'own', 'an explicit actor snapshot wins');
});

test('C2: missing or ambiguous entry evidence returns no plan (handled as opener not confirmed), not other', () => {
  assert.deepEqual(recover([], 'conservative'), []);
  assert.deepEqual(recover([session('long-vol', [entryRecord(), entryRecord()])], 'conservative'), [], 'two matching receipts are ambiguous');
});

test('C2: an ADOPT decision by the current agent sticks; others and earlier ones are ignored', () => {
  const entry = session('long-vol', [entryRecord()]);
  const own = session('conservative', [], [adoptRecord()], '2026-11-16T14:00:00.000Z');
  const adopted = recover([entry, own], 'conservative')[0];
  assert.equal(adopted.openerStatus, 'other');
  assert.equal(adopted.adopted, true);
  assert.match(adopted.adoptionPlan, /my own stop 660/);
  assert.equal(recover([entry, session('mean-reversion', [], [adoptRecord()])], 'conservative')[0].adopted, false, 'another agent\'s ADOPT does not count');
  assert.equal(recover([entry, session('conservative', [], [adoptRecord({ timestamp: '2026-11-10T00:00:00.000Z' })])], 'conservative')[0].adopted, false, 'an adoption before the entry does not count');
  const later = adoptRecord({ timestamp: '2026-11-17T14:20:00.000Z', args: { action: 'ADOPT', symbol: 'DE261204C00700000', market_data: { entry_order_id: 'order-de-1' }, reasoning: 'Newer plan.' } });
  assert.match(recover([entry, session('conservative', [], [adoptRecord(), later])], 'conservative')[0].adoptionPlan, /Newer plan/);
});

// Two inherited contracts on the same underlying, both opened by Vega.
const positionB = { ...position, Symbol: 'DE261218C00700000', AvgEntryPrice: 31.1 };
const liveOrderB = { ...liveOrder, Symbol: positionB.Symbol, FilledAvgPrice: 31.1, ID: 'order-de-2', ClientOrderID: 'vega-de-2' };
const entryRecordB = () => entryRecord({
  timestamp: '2026-11-11T15:30:00.000Z',
  args: { client_order_id: liveOrderB.ClientOrderID, symbol: positionB.Symbol, position_intent: 'buy_to_open', thesis: 'Buy DE December 18 calls: different plan.' },
  result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ broker_account_id: position.BrokerAccountID, paper_live: 'paper', tenant_id: position.TenantID, sandbox_id: position.SandboxID, order_id: liveOrderB.ID, client_order_id: liveOrderB.ClientOrderID, status: 'filled', filled_qty: 2, symbol: positionB.Symbol }) }] }),
});
const recoverTwo = (evidence, currentAgentId = 'conservative') => recoverHeldPositionPlans({ accountId: '956ff9e4', sandboxId: position.SandboxID, positions: [position, positionB], orders: [liveOrder, liveOrderB], ordersComplete: true, evidence, currentAgentId });
const byContract = plans => Object.fromEntries(plans.map(p => [p.symbol, p]));
const adoption = (args, extra = {}) => adoptRecord({ args: { action: 'ADOPT', reasoning: 'Plan for this contract.', ...args }, ...extra });
const twoEntries = session('long-vol', [entryRecord(), entryRecordB()]);
const adopter = (...adoptions) => session('conservative', [], adoptions, '2026-11-16T14:00:00.000Z');

test('C2: ADOPT binds to the exact contract and its opening entry, never to every contract on the underlying', () => {
  // an underlying-only ADOPT counts for neither contract
  let plans = byContract(recoverTwo([twoEntries, adopter(adoption({ symbol: 'DE', market_data: { entry_order_id: 'order-de-1' } }))]));
  assert.equal(plans.DE261204C00700000.adopted, false);
  assert.equal(plans.DE261218C00700000.adopted, false);
  // an exact-contract ADOPT citing its own entry adopts only that contract
  plans = byContract(recoverTwo([twoEntries, adopter(adoption({ symbol: 'DE261204C00700000', market_data: { entry_order_id: 'order-de-1' } }))]));
  assert.equal(plans.DE261204C00700000.adopted, true);
  assert.equal(plans.DE261218C00700000.adopted, false, 'the other contract on the same underlying is not adopted');
  assert.equal(plans.DE261218C00700000.openerStatus, 'other');
  // each contract keeps its own plan
  plans = byContract(recoverTwo([twoEntries, adopter(
    adoption({ symbol: 'DE261204C00700000', market_data: { entry_order_id: 'order-de-1' }, reasoning: 'Plan A.' }),
    adoption({ symbol: 'DE261218C00700000', market_data: { entry_order_id: 'order-de-2' }, reasoning: 'Plan B.' }),
  )]));
  assert.match(plans.DE261204C00700000.adoptionPlan, /Plan A/);
  assert.match(plans.DE261218C00700000.adoptionPlan, /Plan B/);
});

test('C2: an ADOPT must cite the matching entry id, with a valid timestamp after the entry', () => {
  const adopted = (args, extra) => recover([session('long-vol', [entryRecord()]), adopter(adoption({ symbol: 'DE261204C00700000', ...args }, extra))], 'conservative')[0].adopted;
  const good = { market_data: { entry_order_id: 'order-de-1' } };
  assert.equal(adopted(good), true);
  assert.equal(adopted({ market_data: { entry_client_order_id: 'vega-de-1' } }), true, 'the entry client order id is accepted too');
  assert.equal(adopted({}), false, 'no cited entry id');
  assert.equal(adopted({ market_data: {} }), false);
  assert.equal(adopted({ market_data: 'order-de-1' }), false, 'market_data must be an object');
  assert.equal(adopted({ market_data: { entry_order_id: 'order-de-2' } }), false, 'another contract\'s entry id');
  assert.equal(adopted(good, { timestamp: undefined }), false, 'undated');
  assert.equal(adopted(good, { timestamp: 'not a date' }), false, 'invalid date');
  assert.equal(adopted(good, { timestamp: '2026-11-10T00:00:00.000Z' }), false, 'before the entry');
  // an entry with an invalid timestamp cannot order anything
  const badEntry = recover([session('long-vol', [entryRecord({ timestamp: 'garbage' })]), adopter(adoption({ symbol: 'DE261204C00700000', ...good }))], 'conservative')[0];
  assert.equal(badEntry.openerStatus, 'other');
  assert.equal(badEntry.adopted, false);
});

test('C2: plan context text for own, other, adopted and unknown lots', () => {
  const own = { symbol: 'AAA', thesis: 'T1', openerStatus: 'own', adopted: false, opener: { agentName: 'Me' } };
  const text = planContextText([own]);
  assert.match(text, /^\n\nORIGINAL EXIT PLAN CONTEXT \(historical entry receipts; matched to current broker-held lots in this account\/sandbox; not fresh authorization\):\nAAA: T1\nPreserve the original rules and timeframe verbatim\. Reconcile live broker positions\/fills before acting/);
  assert.doesNotMatch(text, /another agent|not confirmed/);
  const other = planContextText([{ symbol: 'DE261204C00700000', entryBrokerId: 'order-de-1', thesis: 'T2', openerStatus: 'other', adopted: false, opener: { agentName: 'Vega' } }]);
  assert.match(other, /DE261204C00700000 \[entry order order-de-1\] \(opened by Vega, another agent; history, not your plan\): T2/);
  assert.match(other, /decide under your own Strategy Rules whether to adopt it \(record ADOPT with your own plan, the exact contract symbol and the entry order id shown above\) or exit it/);
  assert.doesNotMatch(other, /Preserve the original rules/);
  const adopted = planContextText([{ symbol: 'DE', entryBrokerId: 'order-de-1', thesis: 'T2', openerStatus: 'other', adopted: true, adoptionPlan: 'Plan B', opener: { agentName: 'Vega' } }]);
  assert.match(adopted, /DE \[entry order order-de-1\] \(opened by Vega, adopted by you\): Plan B/);
  assert.match(adopted, /keep the plan you recorded when you adopted it/);
  const unknown = planContextText([{ symbol: 'X', thesis: 'T3', openerStatus: 'unknown', adopted: false, opener: null }], ['LOW261204C00230000']);
  assert.match(unknown, /X \(opener not confirmed\): T3/);
  assert.match(unknown, /LOW261204C00230000 \(opener not confirmed; no matching entry receipt\)/);
  assert.match(unknown, /do not exit it only because its origin or receipt is missing/);
});

async function seedStore(dir) {
  const store = new ChatStore(dir);
  const sessionsFile = path.join(dir, 'sandboxes', '956ff9e4', 'chat-history', 'sessions.json');
  await store.startSession('956ff9e4', 'old-entry', { agentId: 'long-vol', agentName: 'Vega' });
  await store.addMessage('956ff9e4', 'old-entry', entryRecord());
  await store.startSession('956ff9e4', 'ancient', { agentId: 'long-vol', agentName: 'Vega' });
  await store.addMessage('956ff9e4', 'ancient', entryRecord({ args: { client_order_id: 'ancient-1', symbol: 'LOW261204C00230000', position_intent: 'buy_to_open', thesis: 'very old' } }));
  const index = JSON.parse(await fs.readFile(sessionsFile, 'utf8'));
  index.sessions.find(s => s.id === 'ancient').createdAt = new Date(Date.now() - 45 * 86400000).toISOString();
  index.sessions.find(s => s.id === 'old-entry').createdAt = new Date(Date.now() - 6 * 86400000).toISOString();
  await fs.writeFile(sessionsFile, JSON.stringify(index));
  await store.startSession('956ff9e4', 'adopt-1', { agentId: 'conservative', agentName: 'Guardian' });
  await store.addMessage('956ff9e4', 'adopt-1', adoptRecord());
  return { store, sessionsFile };
}

test('C2: the evidence window is 30 calendar days (not 100 sessions) and adoption decisions are included', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov14-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { store } = await seedStore(dir);
  const evidence = await store.listRecentOrderEvidence('956ff9e4', { sinceDays: 30 });
  const ids = evidence.map(s => s.id).sort();
  assert.deepEqual(ids, ['adopt-1', 'old-entry'], 'a 45-day-old session is outside the window; a 6-day-old one is inside');
  assert.equal(evidence.find(s => s.id === 'old-entry').messages.length, 1);
  assert.equal(evidence.find(s => s.id === 'adopt-1').adoptions.length, 1);
  // The index keeps only the newest 100 sessions. A 6-day-old entry dropped from it is still found from its file,
  // with the opener kept from the metadata cached while the index still listed it.
  for (let i = 0; i < 150; i++) await store.startSession('956ff9e4', `beat-${i}`, { agentId: 'conservative', agentName: 'Guardian' });
  const indexed = await store.listSessions('956ff9e4', 1000);
  assert.ok(indexed.length <= 100 && !indexed.some(s => s.id === 'old-entry'), 'the old session is gone from the index');
  const again = await store.listRecentOrderEvidence('956ff9e4', { sinceDays: 30 });
  assert.ok(again.some(s => s.id === 'old-entry' && s.messages.length === 1), 'but its evidence is still found');
  const plans = recover(again, 'conservative');
  assert.equal(plans[0].openerStatus, 'other', 'opener Vega kept from the cached metadata');
  assert.equal(plans[0].opener.agentName, 'Vega');
});

test('C2: a session file the index never listed is read, and its per-message actor decides the opener', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov14-orphan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const chatDir = path.join(dir, 'sandboxes', '956ff9e4', 'chat-history');
  await fs.mkdir(chatDir, { recursive: true });
  const row = entryRecord({ actorSnapshot: { agentId: 'long-vol', agentName: 'Vega' } });
  await fs.writeFile(path.join(chatDir, 'session-lost-1.jsonl'), JSON.stringify(row) + '\n');
  const store = new ChatStore(dir);
  const evidence = await store.listRecentOrderEvidence('956ff9e4', { sinceDays: 30 });
  assert.equal(evidence.length, 1);
  assert.equal(recover(evidence, 'conservative')[0].openerStatus, 'other');
  assert.equal(recover(evidence, 'long-vol')[0].openerStatus, 'own');
  // A file with no actor evidence at all stays unknown, never other.
  await fs.writeFile(path.join(chatDir, 'session-lost-2.jsonl'), JSON.stringify(entryRecord({ args: { client_order_id: 'other-1', symbol: 'LOW261204C00230000', position_intent: 'buy_to_open', thesis: 'x' } })) + '\n');
  const both = await store.listRecentOrderEvidence('956ff9e4', { sinceDays: 30 });
  assert.equal(both.length, 2);
});

test('C2: the per-session cache is reused and refreshed when a session changes', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nov14-cache-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const { store } = await seedStore(dir);
  await store.listRecentOrderEvidence('956ff9e4');
  const cacheFile = path.join(dir, 'sandboxes', '956ff9e4', 'chat-history', 'order-evidence-cache.json');
  const cache = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
  assert.deepEqual(Object.keys(cache.sessions).sort(), ['adopt-1', 'old-entry']);
  cache.sessions['old-entry'].messages = [];
  await fs.writeFile(cacheFile, JSON.stringify(cache));
  const cached = await store.listRecentOrderEvidence('956ff9e4');
  assert.equal(cached.find(s => s.id === 'old-entry').messages.length, 0, 'an unchanged session is served from the cache');
  await store.addMessage('956ff9e4', 'old-entry', { kind: 'heartbeat', content: 'x' });
  const refreshed = await store.listRecentOrderEvidence('956ff9e4');
  assert.equal(refreshed.find(s => s.id === 'old-entry').messages.length, 1, 'a changed session is rescanned');
});

// ── Guidance ─────────────────────────────────────────────────────────────────────────────────────
test('guidance: the new lines appear once per agent, only the news-event line is Herald-only, no symbols or dates', () => {
  for (const id of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion', 'capital-preservation']) {
    const text = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
    for (const phrase of ['- Positions another agent opened: when the ORIGINAL EXIT PLAN CONTEXT marks a held position as opened by another agent', '- Counting sessions: "the third completed session after entry" counts from the day after the entry day']) {
      assert.equal(text.split(phrase).length - 1, 1, `${id}: ${phrase.slice(0, 40)}`);
    }
    assert.doesNotMatch(text, /\b(AVGO|COST|AMD|MSFT|DE|LOW)\b/, id);
    assert.doesNotMatch(text, /2026-\d\d-\d\d/, id);
  }
  const herald = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'catalyst-news' });
  assert.equal(herald.split('- Same news event:').length - 1, 1);
  assert.match(herald, /within 36 hours are one event\. Its time is the earliest publication time among them/);
  assert.doesNotMatch(renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'default' }), /Same news event/);
});

test('guidance: the spread cap is OP2\'s (follows the saved setting); the agent adds no second veto and a tighter strategy cap still wins', () => {
  const text = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, maxOptionSpreadPct: 8 }, { strategyId: 'default' });
  assert.match(text, /The platform's spread cap is applied by OP2 itself: it refuses an opening whose spread, measured on AlphaDesk's own quote of that exact contract, is above 8%/);
  assert.match(text, /do not add a second spread veto of your own\. A tighter spread cap written in your Strategy Rules still applies, and a stricter rule of your strategy always wins/);
  assert.doesNotMatch(text, /Skip a contract whose spread is above/);
});
