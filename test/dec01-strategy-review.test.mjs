import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

// Dec 1 strategy-review release (approved by Julian after the Claude + Gemini review). TEXT and SETTINGS-DEFAULT changes only: these tests
// prove the exact rendered clauses, their scope and the Prophet config planner. None of them proves that a live model follows the text.
const { buildSystemPrompt } = await import('../agent/harness.js');
const { DEFAULT_TRADING_GUIDANCE, normalizeTradingGuidance, renderTradingGuidance } = await import('../agent/trading-guidance.js');
const { TOOL_CATALOG, HERALD_TOOL_CATALOG } = await import('../agent/tool-catalog.js');
const T = await import('../agent/dec01-targets.js');
const { PROPHET_PROMPT, PROPHET_RULES } = await import('../agent/consistency-targets.js');

const FAMILIES = ['catalyst-news', 'etf-mean-reversion', 'equity-momentum', 'long-premium-volatility', 'default', 'capital-preservation'];
const SHARES = ['macro-rotation', 'long-horizon-trend'];
const count = (text, part) => text.split(part).length - 1;
const options = { allowOptions: true, allowedStructures: ['long_call', 'long_put'] };
const fit = { 'catalyst-news': ['long_call', 'long_put'], 'etf-mean-reversion': ['long_call'], 'equity-momentum': ['long_call'], 'long-premium-volatility': ['long_call', 'long_put'], default: ['long_call', 'long_put'], 'capital-preservation': ['long_call'], 'macro-rotation': [], 'long-horizon-trend': [] };
const build = (strategyId, extra = {}) => buildSystemPrompt(
  { id: 'a', name: 'A', strategyId, customStrategyRules: 'rules' },
  { getStrategyById: () => ({ id: strategyId, optionStructures: fit[strategyId] }), heartbeatIntervalsForced: true, tradingGuidance: { ...DEFAULT_TRADING_GUIDANCE }, ...options, ...extra },
);

test('D1/D7 defaults: 3% entry floor and a 10% long-gap cap, validated like every other setting', () => {
  assert.equal(DEFAULT_TRADING_GUIDANCE.minEntryPct, 3);
  assert.equal(DEFAULT_TRADING_GUIDANCE.longGapSingleLegCapPct, 10);
  assert.equal(normalizeTradingGuidance({ longGapSingleLegCapPct: 8 }, { strict: true }).longGapSingleLegCapPct, 8);
  assert.throws(() => normalizeTradingGuidance({ longGapSingleLegCapPct: 51 }, { strict: true }), /longGapSingleLegCapPct must be a number from 1 to 50/);
  assert.equal(normalizeTradingGuidance({}).longGapSingleLegCapPct, 10, 'a slot saved before Dec 1 gets the default');
});

test('1c long gap: every options agent gets the rule once, with the setting value; share agents never do', async () => {
  for (const id of FAMILIES) {
    const p = await build(id);
    assert.equal(count(p, '- Long gaps (new openings only, never a reason to sell):'), 1, id);
    assert.match(p, /a long gap follows this session when the next regular session opens more than 24 hours after this session closes \(a weekend or a market holiday\)/, id);
    assert.match(p, /open no new single-leg option once minutes_to_close is 120 or less/, id);
    assert.match(p, /stays within 10% of current account equity/, id);
    assert.match(p, /Count each intent once: the filled part of a partly filled or retried opening is held cost, only its unfilled part is reserved, and the candidate is never added twice./, id);
    assert.match(p, /If session_close_utc or broker_clock.next_open is unavailable, treat the session as one before a long gap and record which time was missing./, id);
    assert.match(p, /Debit verticals are exempt from this rule but not from any other limit\. A position above this limit is never sold because of it, and this rule never delays an exit\./, id);
    assert.match(p, /the one exception is the long-gap test in Risk Discipline, which compares broker_clock.next_open with session_close_utc/, id);
    assert.match(p, /during the regular session compare broker_clock.next_open with session_close_utc, both from prophet_get_datetime/, id);
    assert.match(await build(id, { tradingGuidance: { ...DEFAULT_TRADING_GUIDANCE, longGapSingleLegCapPct: 8 } }), /stays within 8% of current account equity/, id);
  }
  for (const id of SHARES) {
    const p = await build(id, { allowOptions: false, allowedStructures: [] });
    assert.equal(count(p, 'Long gaps'), 0, id);
    assert.doesNotMatch(p, /long-gap test/, id);
  }
});

test('1c long gap: the rule sits right after the sizing rule and adds no date, time of day or symbol', async () => {
  const p = await build('catalyst-news');
  const line = p.split('\n').find(l => l.startsWith('- Long gaps'));
  assert.ok(p.indexOf('Never split one intent into several orders.') < p.indexOf('- Long gaps'));
  assert.doesNotMatch(line, /\b(20\d\d|Nov|Dec|Monday|Friday|Thanksgiving|[A-Z]{2,5}\d{6}[CP])\b/);
  assert.doesNotMatch(line, /\b\d{1,2}:\d{2}\b/);
});

test('1a contradictions are resolved in every options family', async () => {
  for (const id of [...FAMILIES, ...SHARES]) {
    const p = await build(id, SHARES.includes(id) ? { allowOptions: false, allowedStructures: [] } : {});
    assert.doesNotMatch(p, /so only contracts that fit your intended size come back/, id);
    assert.match(p, /pass `max_cost` only as a ceiling on the price of ONE contract \(or omit it\), never as a position budget/, id);
    assert.match(p, /its only permitted use is one read-only check after a transient AlphaDesk outage/, id);
    assert.equal(count(p, 'prophet_get_options_quote'), SHARES.includes(id) ? 1 : 2, `${id}: menu${SHARES.includes(id) ? '' : ' and the option-quotes line'}`);
    assert.doesNotMatch(p, /smaller-than-standard/, id);
    if (SHARES.includes(id)) continue;
    assert.doesNotMatch(p, /Write your logs after the order call/, id);
    assert.equal(count(p, 'Write first any decision log that your rules require before an order'), 1, id);
    assert.equal(count(p, '- Option quotes:'), 1, id);
    assert.match(p, /read-only prophet_assess_options_strategy \(its only permitted use\)/, id);
  }
  const herald = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'catalyst-news' });
  assert.match(herald, /Size the position by the sizing rule in Risk Discipline \(based on premium\), and record the estimated loss at the stop, including the spread, with the size basis\./);
  assert.deepEqual(TOOL_CATALOG.Options, HERALD_TOOL_CATALOG.Options, 'Herald and the others now list the same options tools');
});

test('1a: the log_decision schema describes a free-text action and reserves PASS', () => {
  const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.equal(count(source, "'The action taken (BUY, SELL, HOLD, PASS)'"), 0);
  assert.equal(count(source, 'Free-text action label, for example BUY, SELL, HOLD, WATCHLIST, RANGE_RECORDED, ADOPT, REJECT or NO_SETUP. PASS is reserved for a genuine AlphaDesk receipt and is not a log action.'), 1);
});

test('1b Prophet: daily-bar operating rule, swings only, numeric definitions; Vega keeps the intraday rule', async () => {
  const p = await build('default');
  assert.doesNotMatch(p, /scalp/i);
  assert.match(p, /Daily-bar facts only change after each close/);
  assert.doesNotMatch(p, /work through your strategy universe in batches/);
  for (const part of [
    '- Trend (the stand-in for the higher timeframe): for a call, the last completed daily close is above its 20-day average and the 5-session change of that average is 0% or higher; for a put, the close is below its 20-day average and that change is 0% or lower.',
    '- Breakout level: for a call, the highest high of the 20 completed sessions before the breakout bar; for a put, the lowest low of those 20 sessions.',
    'within the last 5 completed sessions',
    'read that symbol\'s completed daily bars with prophet_get_historical_bars (timeframe 1Day, about 30 sessions, complete=true bars only; state the feed) and take the level from the 20 sessions before the breakout bar',
    'Record the level, the breakout date and the feed in your WATCHLIST record after the close and reuse that record later; never estimate the level.',
    'for a call its low is within -0.5% to +2% of the breakout level',
    'for a put its high is within -2% to +0.5% of it',
    'No completed daily close since the breakout bar may be back through the level',
    "- Entry trigger: the latest completed daily close is above the previous session's high (call) or below the previous session's low (put), and that close is no more than 4% beyond the breakout level.",
    '- Failed retest: a completed daily close back through the breakout level',
    'Broken trend: a completed daily close on the wrong side of the 20-day average',
  ]) assert.equal(count(p, part), 1, part.slice(0, 70));
  const vega = await build('long-premium-volatility');
  assert.match(vega, /work through your strategy universe in batches/);
  for (const id of FAMILIES.filter(f => f !== 'default')) assert.doesNotMatch(await build(id), /- Breakout level:|- Entry trigger:/, id);
});

test('1b Prophet config planner: Nov 22 text -> Dec 1 text, idempotent, and it refuses unknown text', () => {
  const live = { agents: [{ id: 'default', customSystemPrompt: PROPHET_PROMPT, systemPromptTemplate: 'custom' }], strategies: [{ id: 'default', customRules: PROPHET_RULES }] };
  const plan = T.planDec01Edits(live);
  assert.deepEqual(plan, { agentPrompts: { default: { customSystemPrompt: T.PROPHET_DEC01_PROMPT, systemPromptTemplate: 'custom' } }, strategyEdits: { default: { customRules: T.PROPHET_DEC01_RULES } } });
  const applied = { agents: [{ id: 'default', customSystemPrompt: T.PROPHET_DEC01_PROMPT, systemPromptTemplate: 'custom' }], strategies: [{ id: 'default', customRules: T.PROPHET_DEC01_RULES }] };
  assert.deepEqual(T.planDec01Edits(applied), { agentPrompts: {}, strategyEdits: {} }, 'already applied: nothing to do');
  assert.throws(() => T.planDec01Edits({ ...live, agents: [{ id: 'default', customSystemPrompt: 'hand edited', systemPromptTemplate: 'custom' }] }), /neither the Nov 22 target nor the Dec 1 target/);
  assert.throws(() => T.planDec01Edits({ ...live, strategies: [{ id: 'default', customRules: 'hand edited' }] }), /neither the Nov 22 target nor the Dec 1 target/);
  assert.throws(() => T.planDec01Edits({ agents: [], strategies: [] }), /missing/);
  for (const text of [T.PROPHET_DEC01_PROMPT, T.PROPHET_DEC01_RULES]) {
    assert.doesNotMatch(text, /scalp|weekly trend|0\.6 to 0\.7|21 to 45/i, 'numbers come from Trading Guidance, not the config text');
    assert.doesNotMatch(text, /\b(20\d\d|Nov|Dec)\b/);
  }
  assert.ok(T.PROPHET_DEC01_PROMPT.includes('### SCAN UNIVERSE') && T.PROPHET_DEC01_PROMPT.includes('### END_SCAN_UNIVERSE'));
  assert.ok(T.PROPHET_DEC01_RULES.includes('same-expiry 1:1 debit vertical'), 'the spread sentence is kept');
});

test('Dec 1 manifest provenance: ids, anchors, scopes, and a sha256 tripwire', () => {
  const raw = fs.readFileSync(new URL('./fixtures/dec01/delta.json', import.meta.url), 'latin1').replace(/\r\n/g, '\n');
  const m = JSON.parse(raw);
  const keys = new Set([...['sbx_723be98b', 'sbx_956ff9e4', 'sbx_0d35471e'].map(s => `live:${s}`), ...['catalyst', 'conservative', 'default', 'long-vol', 'macro-rotation', 'mean-reversion', 'momentum', 'trend-follower'].map(a => `L1:${a}`)]);
  assert.equal(m.prompts.length, 15);
  assert.equal(m.guidance.length, 4);
  for (const e of [...m.prompts, ...m.guidance]) {
    assert.ok(e.old.length >= 40 && e.new.length > 0 && e.old !== e.new, e.id);
    assert.ok(typeof e.note === 'string' && e.note.length > 10, e.id);
    assert.ok(e.applies.length > 0, e.id);
  }
  for (const e of m.prompts) for (const k of e.applies) assert.ok(keys.has(k), `${e.id} ${k}`);
  for (const e of m.guidance) for (const k of e.applies) assert.match(k, /^guidance:/);
  assert.equal(new Set(m.prompts.map(e => e.id)).size, 15);
  const sha = crypto.createHash('sha256').update(Buffer.from(raw, 'latin1')).digest('hex');
  assert.equal(sha, 'be233fca124799a805c5113b988185a40315208885b648d8db6111f293c968b7', 'tripwire: a reviewed change to the manifest must update this in the same commit');
});
