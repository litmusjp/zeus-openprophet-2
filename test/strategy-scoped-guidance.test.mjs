import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TRADING_GUIDANCE, normalizeTradingGuidance, renderTradingGuidance, strategyFamilyOf } from '../agent/trading-guidance.js';
import { buildSystemPrompt } from '../agent/harness.js';

test('strategy ids map to a family; anything else is unknown', () => {
  assert.equal(strategyFamilyOf('etf-mean-reversion'), 'mean-reversion');
  assert.equal(strategyFamilyOf('equity-momentum'), 'breakout');
  assert.equal(strategyFamilyOf('catalyst-news'), 'catalyst');
  assert.equal(strategyFamilyOf('capital-preservation'), 'unknown');
  assert.equal(strategyFamilyOf(undefined), 'unknown');
});

test('mean reversion sees only its own definitions and a calls-only contract', () => {
  const text = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId: 'etf-mean-reversion' });
  assert.match(text, /buy calls with delta about 0.4 to 0.7/);
  assert.match(text, /"Near support" means/);
  assert.match(text, /"Flat or rising average" means/);
  assert.match(text, /"Market supportive" means/);
  assert.doesNotMatch(text, /"Extended" means/);
  assert.doesNotMatch(text, /"Sector supportive"/);
  assert.doesNotMatch(text, /Catalyst|post-news range|buy a put/);
});

test('breakout sees extended, market and sector, and not the mean-reversion slope or support rules', () => {
  const text = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId: 'equity-momentum' });
  assert.match(text, /"Extended" means a completed close more than 4% above the broken level/);
  assert.match(text, /"Market supportive" means/);
  assert.match(text, /"Sector supportive"/);
  assert.match(text, /buy calls with delta about/);
  assert.doesNotMatch(text, /"Flat or rising average"/);
  assert.doesNotMatch(text, /"Near support"/);
  assert.doesNotMatch(text, /post-news range/);
  assert.match(text, /sector support\) only before you treat a setup as entry-ready/);
});

test('catalyst guidance is direction-aware, intraday, and drops the daily definitions', () => {
  const text = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId: 'catalyst-news' });
  // calls AND puts, absolute delta, option type follows the direction
  assert.match(text, /buy a call for a qualified bullish reaction or a put for a qualified bearish one/);
  assert.match(text, /delta magnitude of about 0.4 to 0.7 \(a put's delta is negative, so compare its absolute value\)/);
  assert.match(text, /the type that matches your direction \(call or put\)/);
  assert.doesNotMatch(text, /buy calls with delta about/);
  assert.doesNotMatch(text, /and type call\./);
  // discovery uses the news tools; earnings are never entry evidence
  assert.match(text, /prophet_get_news, prophet_search_news, prophet_get_market_news/);
  assert.match(text, /prophet_get_earnings_dates only warns you off positions ahead of a scheduled release; it is never entry evidence/);
  assert.match(text, /call prophet_get_alpaca_news first for your watch-list names/);
  assert.match(text, /follow has_more with page_token/);
  assert.match(text, /for targeted verification, missing timing or detail, wider discovery, or when Alpaca is empty, unavailable or insufficient/);
  assert.doesNotMatch(text, /only for names or events Alpaca does not cover/);
  assert.match(text, /anchor the event at the earliest publication time you have for it: an earlier event time you already know wins, otherwise the earliest created_at among the articles about the same event; record which article set the anchor; look further only when no article gives a time; later coverage, updated_at or fetched_at never restarts the catalyst clock/);
  assert.doesNotMatch(text, /verify the original event time/);
  assert.match(text, /a story found only on Google or MarketWatch may not appear in its evidence/);
  // the range is anchored to the news, with completed 5-minute bars only
  assert.match(text, /news published before the open .* the first 30 minutes of regular-session completed 5-minute bars/);
  assert.match(text, /news published during the session, the high and low of the first 30 minutes of completed 5-minute bars after the publication time/);
  assert.match(text, /timeframe 5Min.*explicit regular-session start and end timestamps.*complete=true/);
  // intraday volume baseline excludes the breakout and forming bars; daily volume rule is not used
  assert.match(text, /above the average volume of the 6 completed 5-minute bars immediately before it \(fewer if fewer exist since the open; the baseline excludes the breakout bar and any bar still forming\)/);
  assert.doesNotMatch(text, /average volume of the range's completed bars/);
  assert.doesNotMatch(text, /last_volume_to_avg_ratio above 1/);
  assert.match(text, /gap from the previous close is more than 12%/);
  assert.match(text, /INCOMPLETE_RESEARCH, never confirmation/);
  assert.match(text, /Never switch call and put, or change the setup, to obtain a PASS/);
  // daily-strategy definitions and the forming-bar analyze_stocks line are not rendered
  assert.doesNotMatch(text, /"Extended" means|"Near support"|"Sector supportive"|"Market supportive"/);
  // Nov 13: the daily-trend test for the catalyst strategy needs exactly these two trend definitions
  assert.equal(text.split('"Flat or rising average" means the 5-session change of the 20-day average is -0.3% or higher').length - 1, 1);
  assert.equal(text.split('"Falling average" means the 5-session change of the 20-day average is below -0.3%').length - 1, 1);
  assert.match(text, /Use get_daily_features for the previous close, gap context, average volume and the daily-trend figures defined above/);
  assert.doesNotMatch(text, /prophet_analyze_stocks/);
  assert.match(text, /Catalyst coverage: the CATALYST UNIVERSE/);
});

test('catalyst numbers follow the settings and are validated', () => {
  const custom = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, catalystRangeMinutes: 45, catalystMaxGapPct: 8 }, { strategyId: 'catalyst-news' });
  assert.match(custom, /first 45 minutes of regular-session completed 5-minute bars/);
  assert.match(custom, /first 45 minutes of completed 5-minute bars after the publication time/);
  assert.match(custom, /more than 8%/);
  assert.throws(() => normalizeTradingGuidance({ catalystRangeMinutes: 2 }, { strict: true }), /catalystRangeMinutes/);
  assert.throws(() => normalizeTradingGuidance({ catalystRangeMinutes: 30.5 }, { strict: true }), /whole number/);
  assert.throws(() => normalizeTradingGuidance({ catalystMaxGapPct: 40 }, { strict: true }), /catalystMaxGapPct/);
  assert.equal(normalizeTradingGuidance({ catalystRangeMinutes: 9999 }).catalystRangeMinutes, 30, 'a bad stored value falls back to the default');
});

test('every family keeps the shared rules: PASS wording, session quote context, advisory preference, outcome handling', () => {
  for (const strategyId of ['etf-mean-reversion', 'equity-momentum', 'catalyst-news', 'something-else']) {
    const text = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId });
    assert.match(text, /mark a rejected candidate REJECT or NO_SETUP, never PASS/, strategyId);
    assert.match(text, /Apply only the definitions above that your Strategy Rules use/, strategyId);
    assert.match(text, /prophet_get_quote also returns a session block/, strategyId);
    assert.match(text, /It is information, not a gate and not a prediction of a PASS/, strategyId);
    assert.match(text, /Preference \(advisory only\)/, strategyId);
    assert.match(text, /Never change price, quantity or direction merely to obtain a PASS/, strategyId);
    assert.doesNotMatch(text, /Daily AlphaDesk check/, strategyId);
  }
});

test('an unknown strategy sees every definition, each labelled with the kind of strategy that uses it', () => {
  const text = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId: 'capital-preservation' });
  assert.match(text, /"Extended" means .*\(Used by breakout strategies; apply only if your Strategy Rules use it\.\)/);
  assert.match(text, /"Near support" means .*\(Used by mean-reversion strategies\.\)/);
  assert.match(text, /"Flat or rising average" means .*\(Used by mean-reversion strategies\.\)/);
  assert.doesNotMatch(text, /post-news range/);
});

const baseAgent = (strategyId) => ({ id: 'x', name: 'X', sandboxId: 'sbx_x', systemPromptTemplate: 'custom', strategyId, customSystemPrompt: 'Identity.' });
const deps = { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: DEFAULT_TRADING_GUIDANCE };

test('the system prompt gives catalyst strategies the intraday operating rule, and daily strategies the daily one', async () => {
  const catalyst = await buildSystemPrompt(baseAgent('catalyst-news'), deps);
  assert.match(catalyst, /Catalyst setups are intraday\. On every regular-session heartbeat: reconcile, scan for new public company catalysts/);
  assert.doesNotMatch(catalyst, /Daily-bar facts only change after each close/);
  assert.doesNotMatch(catalyst, /do not poll bars that are still forming/);
  for (const strategyId of ['etf-mean-reversion', 'equity-momentum']) {
    const daily = await buildSystemPrompt(baseAgent(strategyId), deps);
    assert.match(daily, /Daily-bar facts only change after each close/, strategyId);
    assert.doesNotMatch(daily, /Catalyst setups are intraday/, strategyId);
  }
});
