import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { AgentHarness, buildSystemPrompt, isProviderUsageLimitFailure, USAGE_LIMIT_RETRY_SECONDS } from '../agent/harness.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';
import { ChatStore } from '../agent/chat-store.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { BEAT_BACKOFF } from '../agent/defaults.js';

const guidance = strategyId => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId });

// ── C1: a model usage limit is retried on a fixed step ──────────────────────────────────────────
test('only a model-provider usage limit counts as a usage-limit failure', () => {
  assert.equal(isProviderUsageLimitFailure({ status: 429, message: 'APIError: HTTP 429: The usage limit has been reached' }), true);
  assert.equal(isProviderUsageLimitFailure({ message: 'APIError: HTTP 429: The usage limit has been reached' }), true);
  assert.equal(isProviderUsageLimitFailure({ status: 429, message: 'rate limited' }), false);
  assert.equal(isProviderUsageLimitFailure({ status: 500, message: 'usage limit' }), false);
  assert.equal(isProviderUsageLimitFailure({ status: 503, message: 'upstream_service_error' }), false);
  assert.equal(isProviderUsageLimitFailure({}), false);
  assert.equal(isProviderUsageLimitFailure(), false);
});

test('three usage-limit failures retry every 15 minutes; other failures keep the exponential backoff', () => {
  const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'midday', chatStore: null });
  const base = harness._baseHeartbeatSeconds();
  assert.ok(base > 0);
  harness._consecutiveErrors = BEAT_BACKOFF.threshold; harness._usageLimitErrors = BEAT_BACKOFF.threshold;
  assert.equal(harness._getHeartbeatSeconds(), Math.max(base, USAGE_LIMIT_RETRY_SECONDS));
  harness._consecutiveErrors = 8; harness._usageLimitErrors = 8;
  assert.equal(harness._getHeartbeatSeconds(), Math.max(base, USAGE_LIMIT_RETRY_SECONDS), 'does not grow with more failures');
  harness._consecutiveErrors = 5; harness._usageLimitErrors = 4; // a different failure in the run
  assert.equal(harness._getHeartbeatSeconds(), Math.min(base * Math.min(2 ** 3, BEAT_BACKOFF.factor), BEAT_BACKOFF.capSeconds));
  harness._consecutiveErrors = 2; harness._usageLimitErrors = 2; // below the threshold: unchanged
  assert.equal(harness._getHeartbeatSeconds(), base);
});

function fakeProcess(lines, exitCode = 0, stderr = '') {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
  proc.killed = false; proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
    if (stderr) proc.stderr.emit('data', stderr);
    proc.emit('exit', exitCode, null); proc.emit('close', exitCode, null);
  });
  return proc;
}

test('beat failures are counted as usage-limit failures only when they are, and a clean beat clears both counters', async () => {
  const runs = [
    [[{ type: 'error', error: { name: 'APIError', data: { message: 'HTTP 429: The usage limit has been reached', statusCode: 429 } } }], 1, 'APIError: HTTP 429: The usage limit has been reached'],
    [[{ type: 'error', error: { name: 'APIError', data: { message: 'provider returned 500' } } }], 1, 'APIError: provider returned 500'],
    [[{ type: 'text', sessionID: 's', part: { text: 'fine' } }], 0],
  ];
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: { async getRecentContext() { return []; }, async startSession() {}, async addMessage() {} },
    spawnFn: () => fakeProcess(...runs.shift()),
  });
  harness._beatRetryDelayMs = 0;
  harness.state.running = true; harness.state.activeAccountId = 'a'; harness.state.activeModel = 'opencode/model';
  const quiet = console.error; console.error = () => {};
  try {
    await harness._beat();
    assert.equal(harness._consecutiveErrors, 1);
    assert.equal(harness._usageLimitErrors, 1, 'the usage limit is counted');
    await harness._beat();
    assert.equal(harness._consecutiveErrors, 2);
    assert.equal(harness._usageLimitErrors, 0, 'a different failure resets the usage-limit run');
    await harness._beat();
    assert.equal(harness._consecutiveErrors, 0);
    assert.equal(harness._usageLimitErrors, 0);
  } finally { console.error = quiet; }
});

// ── C2: openings above 10 contracts are refused locally with a clear message ───────────────────
test('openings above 10 contracts get a specific local error; closes and 10-contract openings are untouched', async () => {
  const source = await fsp.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  const begin = source.indexOf("case 'place_options_order': {");
  const end = source.indexOf("case 'withdraw_planned_intent': {", begin);
  assert.ok(begin >= 0 && end > begin);
  const body = source.slice(begin, end).replace("case 'place_options_order': {", '').trim().replace(/}s*$/, '');
  const calls = [];
  const invoke = vm.runInNewContext(`(async (args) => {${body}})`, {
    JSON, Number, normalizeOptionLimitPrice,
    callTradingBot: async (...a) => { calls.push(a); return { status: 'accepted' }; },
    isOpeningIntent: intent => typeof intent !== 'string' || !intent || intent.includes('open'),
    autoStoreSetup: () => {}, orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  });
  const base = { symbol: 'OXY261218C00055000', underlying: 'OXY', side: 'buy', order_type: 'limit', limit_price: 3.67, thesis: 'fixture' };
  const refused = await invoke({ ...base, position_intent: 'buy_to_open', quantity: 14 });
  assert.equal(refused.isError, true);
  assert.equal(calls.length, 0, 'the backend is never called for an oversized opening');
  const body14 = JSON.parse(refused.content[0].text);
  assert.match(body14.error, /limited to 1-10 contracts per order. This proposal asked for 14/);
  assert.equal(body14.execution_confirmed, false);
  assert.equal(body14.max_quantity, 10);
  await invoke({ ...base, position_intent: 'buy_to_open', quantity: 10 });
  assert.equal(calls.length, 1, 'ten contracts go through');
  await invoke({ ...base, side: 'sell', position_intent: 'sell_to_close', quantity: 14 });
  assert.equal(calls.length, 2, 'a closing order is never limited here');
  assert.ok((await invoke({ ...base, quantity: 11 })).isError, 'a missing intent is treated as an opening, like isOpeningIntent');
  assert.ok(source.includes('Place one single-leg OCC options order (openings: 1-10 contracts)'));
});

// ── C3, C5, C6: rendered prompt text ─────────────────────────────────────────────────────────
test('the sizing rule, the UNAVAILABLE re-assessment and news paging reach the prompts', async () => {
  for (const id of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion']) {
    const text = guidance(id);
    assert.match(text, /you may on a later heartbeat run one read-only assess_options_strategy for the same still-qualified, locally valid proposal/, id);
    assert.match(text, /A local validation error \(for example a quantity above 10\) is not transient: fix the proposal instead/, id);
    assert.match(text, /Never change price, quantity or direction merely to obtain a PASS/, id);
    const prompt = await buildSystemPrompt({ id: 'a', name: 'A', strategyId: id, customStrategyRules: 'rules' }, {});
    assert.match(prompt, /AlphaDesk-guarded openings are limited to 10 contracts per order/, id);
    assert.match(prompt, /Never split one intent into several orders/, id);
  }
  const herald = guidance('catalyst-news');
  assert.match(herald, /after your first full scan of the day, keep paging only until you reach articles you have already reviewed, and say so if your step budget ran out first/);
  assert.match(herald, /follow has_more with page_token while your step budget allows/);
  assert.doesNotMatch(guidance('equity-momentum'), /keep paging only until you reach articles/);
});

// ── C4: AlphaDesk pre-broker blocks are History warnings; real failures stay failures ───────────
async function outcomeFor(t, tool, errorText, extra = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'op2-ad-block-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-b', 'session-b', { agentName: 'Vega' });
  const file = path.join(root, 'sandboxes', 'acct-b', 'chat-history', 'session-session-b.jsonl');
  const record = { timestamp: new Date(Date.UTC(2026, 10, 10, 15, 0, 0)).toISOString(), activityId: 'a', origin: 'Heartbeat', kind: 'tool_call', tool, result: '', status: 'error', error: errorText, ...extra };
  await fsp.appendFile(file, JSON.stringify(record) + '\n');
  return (await store.listActivities('acct-b', { limit: 5 })).activities[0];
}
const adError = (decision, over = {}) => JSON.stringify({ error: `Assessment diagnostic summary: {"assessment_decision":"${decision}"}
Trading bot request failed: ${JSON.stringify({ status: 'submit_failed', filled_qty: 0, execution_confirmed: false, fully_filled: false, assessment_decision: decision, ...over })}` });

test('a pre-broker AlphaDesk FAIL or UNAVAILABLE is a warning, not a failed heartbeat', async t => {
  const fail = await outcomeFor(t, 'place_options_order', adError('FAIL'));
  assert.match(fail.outcome, /^Recorded \(warning: AlphaDesk blocked \(FAIL\)\)$/);
  assert.equal(fail.labels.includes('Error'), false);
  const unavailable = await outcomeFor(t, 'place_options_order', adError('UNAVAILABLE'));
  assert.match(unavailable.outcome, /AlphaDesk blocked \(UNAVAILABLE\)/);
  assert.equal(unavailable.labels.includes('Error'), false);
  const quantity = await outcomeFor(t, 'place_options_order', JSON.stringify({ error: 'AlphaDesk-guarded openings are limited to 1-10 contracts per order. This proposal asked for 14.', category: 'local_validation', execution_confirmed: false, filled_qty: 0 }));
  assert.match(quantity.outcome, /AlphaDesk blocked \(quantity limit\)/);
  assert.equal(quantity.labels.includes('Error'), false);
});

test('anything else about an order stays a failure', async t => {
  const unknown = await outcomeFor(t, 'place_options_order', JSON.stringify({ error: 'Trading bot request failed: {"status":"uncertain","execution_confirmed":false}' }));
  assert.equal(unknown.outcome, 'Failed');
  assert.equal(unknown.labels.includes('Error'), true);
  const filled = await outcomeFor(t, 'place_options_order', adError('FAIL', { filled_qty: 2 }));
  assert.equal(filled.outcome, 'Failed');
  const submitted = await outcomeFor(t, 'place_options_order', adError('FAIL', { execution_confirmed: true }));
  assert.equal(submitted.outcome, 'Failed');
  const auth = await outcomeFor(t, 'place_options_order', JSON.stringify({ error: 'Trading bot request failed: {"status":401,"category":"authentication"}' }));
  assert.equal(auth.outcome, 'Failed');
  const otherTool = await outcomeFor(t, 'get_account', adError('FAIL'));
  assert.equal(otherTool.outcome, 'Failed', 'only the order tool is reclassified');
});
