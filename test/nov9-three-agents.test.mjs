import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_TRADING_GUIDANCE, normalizeTradingGuidance, renderTradingGuidance, strategyFamilyOf, TRADING_GUIDANCE_KEYS,
} from '../agent/trading-guidance.js';
import { buildSystemPrompt } from '../agent/harness.js';
import { buildScorecard, scorecardRow } from '../agent/trade-scorecard.js';
import { ChatStore } from '../agent/chat-store.js';

const g = DEFAULT_TRADING_GUIDANCE;
const guidance = (strategyId, over = {}) => renderTradingGuidance({ ...g, ...over }, { strategyId });

test('new guidance settings have the approved defaults and strict validation', () => {
  assert.equal(g.maxOptionSpreadPct, 10);
  assert.equal(g.catalystStopRangeFraction, 0.5);
  assert.equal(g.catalystTargetRangeMultiple, 1);
  assert.equal(g.assessmentDteMin, 1);
  assert.equal(g.assessmentDteMax, 180);
  for (const key of ['maxOptionSpreadPct', 'catalystStopRangeFraction', 'catalystTargetRangeMultiple', 'assessmentDteMin', 'assessmentDteMax']) {
    assert.ok(TRADING_GUIDANCE_KEYS.includes(key), key);
  }
  assert.throws(() => normalizeTradingGuidance({ maxOptionSpreadPct: 1 }, { strict: true }), /maxOptionSpreadPct/);
  assert.throws(() => normalizeTradingGuidance({ maxOptionSpreadPct: 30 }, { strict: true }), /maxOptionSpreadPct/);
  assert.throws(() => normalizeTradingGuidance({ catalystStopRangeFraction: 0 }, { strict: true }), /catalystStopRangeFraction/);
  assert.throws(() => normalizeTradingGuidance({ catalystTargetRangeMultiple: 9 }, { strict: true }), /catalystTargetRangeMultiple/);
  assert.throws(() => normalizeTradingGuidance({ assessmentDteMin: 50, assessmentDteMax: 20 }, { strict: true }), /must not exceed/);
  assert.throws(() => normalizeTradingGuidance({ assessmentDteMin: 2.5 }, { strict: true }), /whole number/);
  assert.equal(normalizeTradingGuidance({ maxOptionSpreadPct: 99 }).maxOptionSpreadPct, 10, 'a bad stored value falls back');
  assert.equal(normalizeTradingGuidance({ assessmentDteMin: 50, assessmentDteMax: 20 }).assessmentDteMax, 180);
});

test('strategy families: Vega and Prophet have their own; the others are unchanged', () => {
  assert.equal(strategyFamilyOf('long-premium-volatility'), 'long-vol');
  assert.equal(strategyFamilyOf('default'), 'prophet');
  assert.equal(strategyFamilyOf('catalyst-news'), 'catalyst');
  assert.equal(strategyFamilyOf('equity-momentum'), 'breakout');
  assert.equal(strategyFamilyOf('etf-mean-reversion'), 'mean-reversion');
  assert.equal(strategyFamilyOf('capital-preservation'), 'unknown');
  assert.equal(strategyFamilyOf(undefined), 'unknown');
});

test('Vega gets calls and puts, no breakout, market-trend or sector gate, and no claim about its rules beyond the live ones', () => {
  const text = guidance('long-premium-volatility');
  assert.match(text, /buy a call for a bullish thesis or a put for a bearish thesis/);
  assert.match(text, /your Strategy Rules decide every entry and exit \(a dated event inside the hold, a directional view consistent with the prevailing trend/);
  assert.match(text, /Trading Guidance adds no breakout, market-trend or sector test/);
  assert.match(text, /no tool returns an implied-volatility history/);
  assert.match(text, /at-the-money straddle price/);
  assert.doesNotMatch(text, /Market supportive|"Extended"|Sector supportive|Near support|Flat or rising average/);
  assert.doesNotMatch(text, /Initial post-news range|Catalyst discovery/);
  assert.match(text, /Market-wide discovery \(advised, not required\)/);
  assert.doesNotMatch(text, /only (buy )?calls|calls only/i);
});

test('Prophet follows its live rules (mainly calls, scalp or swing) and its expiries are limited to the AlphaDesk window', () => {
  const open = guidance('default');
  assert.match(open, /buy mainly calls; buy a put only for a clearly bearish setup, never as a hedge/);
  assert.match(open, /Label each position a scalp or a swing at entry/);
  assert.match(open, /expires 1 to 180 calendar days out/);
  assert.match(open, /scalp \(exit in the same session\): 2 to 10 calendar days to expiry \(OP2 blocks same-day expiry\); swing: 21 to 60 calendar days to expiry/);
  assert.match(open, /a breakout aligned with the higher timeframe, a completed-bar retest that holds, momentum resuming/);
  assert.match(open, /Market-wide discovery \(optional\)/);
  assert.doesNotMatch(open, /Market supportive|Sector supportive|Initial post-news range/);
  assert.doesNotMatch(open, /under 10% of mid|50 to 120|2 to 5 calendar/);

  const narrow = guidance('default', { assessmentDteMin: 14, assessmentDteMax: 45 });
  assert.match(narrow, /scalp: not available, because no expiry that OP2 allows is inside the AlphaDesk window; swing: 21 to 45 calendar days to expiry/);
  assert.match(narrow, /expires 14 to 45 calendar days out/);

  const below = guidance('default', { assessmentDteMin: 3, assessmentDteMax: 15 });
  assert.match(below, /scalp \(exit in the same session\): 3 to 10 calendar days to expiry/);
  assert.match(below, /swing: the usual 21 to 60 days does not overlap the AlphaDesk window, so swings are limited to 3 to 15 calendar days to expiry/);
});

test('every family gets the spread cap, pricing and AlphaDesk-record lines; a stricter strategy rule wins', () => {
  for (const strategyId of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion', 'capital-preservation']) {
    const text = guidance(strategyId, { maxOptionSpreadPct: 7 });
    // The platform cap is OP2's (on AlphaDesk's quote); the agent adds no second veto, and a tighter strategy cap still wins.
    assert.match(text, /The platform's spread cap is applied by OP2 itself: it refuses an opening whose spread, measured on AlphaDesk's own quote of that exact contract, is above 7%/, strategyId);
    assert.match(text, /do not add a second spread veto of your own\. A tighter spread cap written in your Strategy Rules still applies, and a stricter rule of your strategy always wins/, strategyId);
    assert.doesNotMatch(text, /Skip a contract whose spread is above/, strategyId);
    assert.match(text, /Start an entry limit at the mid and never above the ask/, strategyId);
    assert.match(text, /marketable limit at or just below the current bid/, strategyId);
    assert.match(text, /a price is never changed to obtain a PASS/, strategyId);
    assert.match(text, /If the score is not returned, write "unavailable"; never invent or estimate one/, strategyId);
  }
});

test('Herald gets the paper-experiment stop, target and market-wide discovery; others do not', () => {
  const text = guidance('catalyst-news', { catalystRangeMinutes: 15 });
  assert.match(text, /first 15 minutes of regular-session completed 5-minute bars/);
  assert.match(text, /Stop \(an exit-rule choice for paper trading, not a proven improvement\)/);
  assert.match(text, /point 0\.5 of the way into the initial post-news range/);
  assert.match(text, /range_high - 0\.5 x \(range_high - range_low\)/);
  assert.match(text, /range_low \+ 0\.5 x \(range_high - range_low\)/);
  assert.match(text, /Target \(an exit-rule choice for paper trading, not a proven improvement\)/);
  assert.match(text, /close half of the broker-confirmed contracts rounded down to whole contracts, and trail the remainder/);
  assert.match(text, /This target exit happens once per position and is based on the quantity held when the target is first reached: a position that was a single contract at that moment closes in full\. After the first target exit, a later touch of the target never closes the remainder/);
  assert.doesNotMatch(text, /\(a one-contract position closes in full\)/);
  assert.match(text, /the start is the session open for overnight or pre-open news \(session_open_et from get_datetime; a pre-market bar never forms the range\) or the publication time for news published during the session/);
  assert.match(text, /already beyond that target when you would enter, measure the target instead as the same multiple of the range height beyond the underlying price at your entry/);
  assert.match(text, /never sell a newly opened position just because the original target was crossed/);
  assert.doesNotMatch(text, /take the half at the first permitted evaluation/);
  assert.doesNotMatch(text, /already crossed the target/);
  assert.match(text, /not an unconditional close of a working position/);
  assert.match(text, /once on every regular-session heartbeat, also call prophet_get_alpaca_news with no symbols/i);
  assert.match(text, /has_more true is not by itself incomplete research/);
  const custom = guidance('catalyst-news', { catalystStopRangeFraction: 0.7, catalystTargetRangeMultiple: 1.5 });
  assert.match(custom, /point 0\.7 of the way/);
  assert.match(custom, /1\.5 x the range height/);
  for (const other of ['long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion', 'capital-preservation']) {
    const t = guidance(other);
    assert.doesNotMatch(t, /Stop \(an exit-rule choice/, other);
    assert.doesNotMatch(t, /once on every regular-session heartbeat, also call/i, other);
  }
});

test('Surge and Pendulum keep their breakout and mean-reversion definitions untouched', () => {
  const surge = guidance('equity-momentum');
  assert.match(surge, /"Extended" means/);
  assert.match(surge, /"Sector supportive"/);
  assert.match(surge, /"Market supportive" means/);
  const pendulum = guidance('etf-mean-reversion');
  assert.match(pendulum, /"Near support" means/);
  assert.match(pendulum, /"Flat or rising average" means/);
  assert.doesNotMatch(surge + pendulum, /prophet_get_alpaca_news with no symbols/);
});

const workflow = `### MARKET-OPEN ALPHADESK WORKFLOW
Select one exact eligible single-leg proposal at quantity 1. Read current managed policy and OP2 confirmation. Generate one stable client_order_id and submit this exact OCC contract, side='buy', quantity 1, and proposed positive limit premium once through prophet_place_options_order.
### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
const mvp = '### TEMPORARY_ALPHA_MVP_OVERRIDE\nforced entry text\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n';
const deps = { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: DEFAULT_TRADING_GUIDANCE };
const agent = (extra = {}) => ({ id: 'long-vol', name: 'Vega', sandboxId: 'sbx_956ff9e4', systemPromptTemplate: 'custom', strategyId: 'long-premium-volatility', customSystemPrompt: `You are Vega.\n\n${mvp}\n${workflow}`, ...extra });

test('Vega on L2 and Prophet on L3 are scoped: legacy MVP override stripped and quantity-one normalised', async () => {
  for (const a of [agent(), agent({ id: 'default', name: 'Prophet', sandboxId: 'sbx_0d35471e', strategyId: 'default' })]) {
    const prompt = await buildSystemPrompt(a, deps);
    assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE|forced entry text/, a.name);
    assert.doesNotMatch(prompt, /quantity 1/, a.name);
    assert.match(prompt, /the exact proposed quantity/, a.name);
    assert.match(prompt, /no less than 5% of current account equity/, a.name);
    assert.match(prompt, /Option cost discipline/, a.name);
  }
});

test('the scoping does not leak: other sandboxes and other agents keep their text', async () => {
  for (const extra of [{ sandboxId: 'sbx_723be98b' }, { sandboxId: 'sbx_0d35471e' }, { id: 'someone-else' }]) {
    const prompt = await buildSystemPrompt(agent(extra), deps);
    assert.match(prompt, /Select one exact eligible single-leg proposal at quantity 1\./, JSON.stringify(extra));
  }
});

test('the shared news line says has_more alone is not incomplete research and keeps the existing rules', async () => {
  const prompt = await buildSystemPrompt(agent(), deps);
  assert.match(prompt, /A result with has_more true is not by itself incomplete research/);
  assert.match(prompt, /This adds no new news scan or entry rule to your strategy\./);
  assert.match(prompt, /keep the report to a few lines/);
});

test('the scorecard summarises realized trades, never inventing an AlphaDesk score', () => {
  const trades = [
    { id: 'a', symbol: 'BA261204C00170000', assetType: 'option', quantity: 6, entryPrice: 9.3, exitPrice: 7.75, pnl: -930, pnlPercent: -16.67, entryTime: '2026-11-06T15:21:08Z', exitTime: '2026-11-06T15:45:58Z', entryAgentId: 'catalyst', entryAgentName: 'Herald', sandboxId: 'sbx_723be98b', entryAssessment: { decision: 'PASS', signalScore: 41 } },
    { id: 'b', symbol: 'X', quantity: 1, entryPrice: 1, exitPrice: 2, pnl: 100, entryTime: '2026-11-06T15:00:00Z', exitTime: '2026-11-07T15:00:00Z', agentId: 'long-vol', entryAssessment: null },
  ];
  const card = buildScorecard(trades);
  assert.equal(card.total.trades, 2);
  assert.equal(card.total.wins, 1);
  assert.equal(card.total.losses, 1);
  assert.equal(card.total.totalPnl, -830);
  assert.equal(card.byDay['2026-11-06'].totalPnl, -930);
  assert.equal(card.byDay['2026-11-07'].totalPnl, 100);
  assert.equal(card.byAgent.catalyst.totalPnl, -930);
  assert.equal(card.byAgent['long-vol'].trades, 1);
  const row = scorecardRow(trades[0]);
  assert.equal(row.holdMinutes, 25);
  assert.equal(row.assessmentDecision, 'PASS');
  assert.equal(row.assessmentScore, 41);
  const none = scorecardRow(trades[1]);
  assert.equal(none.assessmentDecision, 'unavailable');
  assert.equal(none.assessmentScore, 'unavailable');
  assert.deepEqual(buildScorecard(undefined).total, { trades: 0, wins: 0, losses: 0, totalPnl: 0 });
});

async function activityFor(records) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'op2-nov9-'));
  const store = new ChatStore(root);
  await store.startSession('acct-9', 'session-9', { agentName: 'Herald' });
  const file = path.join(root, 'sandboxes', 'acct-9', 'chat-history', 'session-session-9.jsonl');
  const base = { timestamp: new Date(Date.UTC(2026, 10, 6, 15, 50, 0)).toISOString(), activityId: 'act-1', origin: 'Heartbeat' };
  for (const record of records) await fsp.appendFile(file, JSON.stringify({ ...base, ...record }) + '\n');
  const activity = (await store.listActivities('acct-9', { limit: 5 })).activities[0];
  await fsp.rm(root, { recursive: true, force: true });
  return activity;
}
const SYMBOL = 'BA261204C00170000';
const notFound = { kind: 'tool_call', tool: 'get_options_position', args: { symbol: SYMBOL }, status: 'error', error: 'Single options-position lookup: no open position found; options position not found: ' + SYMBOL + ' status 404' };
const emptyPositions = { kind: 'tool_call', tool: 'get_options_positions', status: 'completed', result: '[]' };
const filledOrder = { kind: 'tool_call', tool: 'get_orders', status: 'completed', result: JSON.stringify({ orders: [{ Symbol: SYMBOL, Status: 'filled', FilledQty: 6 }] }) };

test('a position 404 is only a warning when the same activity reconciled zero positions and a filled order', async () => {
  const warned = await activityFor([emptyPositions, filledOrder, notFound]);
  assert.match(warned.outcome, /^Recorded \(warning: get_options_position not found after confirmed close\)$/);
  assert.equal(warned.labels.includes('Error'), false);
  for (const [name, records] of Object.entries({
    'no positions list': [filledOrder, notFound],
    'no filled order': [emptyPositions, notFound],
    'position still listed': [{ ...emptyPositions, result: JSON.stringify([{ Symbol: SYMBOL, Qty: 6 }]) }, filledOrder, notFound],
    'filled order for another symbol': [emptyPositions, { ...filledOrder, result: JSON.stringify({ orders: [{ Symbol: 'AAPL261204C00200000', Status: 'filled', FilledQty: 1 }] }) }, notFound],
    'unfilled order': [emptyPositions, { ...filledOrder, result: JSON.stringify({ orders: [{ Symbol: SYMBOL, Status: 'canceled', FilledQty: 0 }] }) }, notFound],
  })) {
    const failed = await activityFor(records);
    assert.equal(failed.outcome, 'Failed', name);
    assert.equal(failed.labels.includes('Error'), true, name);
  }
});
