// User-adjustable "how to read your strategy rules" guidance. Prompt text only: it never changes a
// strategy, permission or risk limit (those stay in the strategy rules and OP2's backend checks).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TRADING_GUIDANCE = Object.freeze({
  contractDeltaMin: 0.40,
  contractDeltaMax: 0.70,
  expiryMinDays: 21,
  expiryMaxDays: 60,
  minEntryPct: 5,
  extendedPct: 4,
  marketSymbol: 'SPY',
  marketTolerancePct: 0.5,
  marketSlopeMinPct: -0.15,
  nearSupportPct: 2.5,
  avgSlopeMinPct: -0.30,
  extraSymbolsPerScan: 25,
  catalystRangeMinutes: 30,
  catalystMaxGapPct: 12,
  maxOptionSpreadPct: 10,
  catalystStopRangeFraction: 0.5,
  catalystTargetRangeMultiple: 1,
  assessmentDteMin: 1,
  assessmentDteMax: 180,
});

// Settings that no longer exist. A stored value is ignored and a save that still carries one (for
// example from a browser tab opened before the release) is accepted and dropped, not rejected.
const RETIRED_KEYS = Object.freeze(['dailyAlphaDeskCheck']);

// key -> [min, max, integer?]
const NUMERIC = Object.freeze({
  contractDeltaMin: [0.05, 0.95, false],
  contractDeltaMax: [0.05, 0.95, false],
  expiryMinDays: [1, 365, true],
  expiryMaxDays: [1, 365, true],
  minEntryPct: [0.5, 25, false],
  extendedPct: [0.5, 25, false],
  marketTolerancePct: [0, 5, false],
  marketSlopeMinPct: [-5, 5, false],
  nearSupportPct: [0.1, 10, false],
  avgSlopeMinPct: [-5, 5, false],
  extraSymbolsPerScan: [0, 100, true],
  catalystRangeMinutes: [5, 120, true],
  catalystMaxGapPct: [1, 25, false],
  maxOptionSpreadPct: [2, 25, false],
  catalystStopRangeFraction: [0.1, 1, false],
  catalystTargetRangeMultiple: [0.25, 5, false],
  assessmentDteMin: [1, 365, true],
  assessmentDteMax: [1, 365, true],
});
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,5}$/;

export const TRADING_GUIDANCE_KEYS = Object.freeze(Object.keys(DEFAULT_TRADING_GUIDANCE));

function coerce(key, value) {
  if (key === 'marketSymbol') {
    const symbol = String(value ?? '').trim().toUpperCase();
    if (!SYMBOL.test(symbol)) throw new Error('marketSymbol must be a ticker symbol such as SPY');
    return symbol;
  }
  const [min, max, integer] = NUMERIC[key];
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${key} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  }
  return number;
}

/**
 * Merge `input` over `base` (defaults when omitted) and validate. `strict` throws on bad input
 * (used when a user saves); non-strict drops bad stored values back to the default.
 */
export function normalizeTradingGuidance(input = {}, { strict = false, base = DEFAULT_TRADING_GUIDANCE } = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = { ...base };
  for (const key of TRADING_GUIDANCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    try { out[key] = coerce(key, source[key]); } catch (error) {
      if (strict) throw error;
      out[key] = DEFAULT_TRADING_GUIDANCE[key];
    }
  }
  if (out.contractDeltaMin >= out.contractDeltaMax) {
    if (strict) throw new Error('contractDeltaMin must be lower than contractDeltaMax');
    out.contractDeltaMin = DEFAULT_TRADING_GUIDANCE.contractDeltaMin;
    out.contractDeltaMax = DEFAULT_TRADING_GUIDANCE.contractDeltaMax;
  }
  if (out.expiryMinDays > out.expiryMaxDays) {
    if (strict) throw new Error('expiryMinDays must not exceed expiryMaxDays');
    out.expiryMinDays = DEFAULT_TRADING_GUIDANCE.expiryMinDays;
    out.expiryMaxDays = DEFAULT_TRADING_GUIDANCE.expiryMaxDays;
  }
  if (out.assessmentDteMin > out.assessmentDteMax) {
    if (strict) throw new Error('assessmentDteMin must not exceed assessmentDteMax');
    out.assessmentDteMin = DEFAULT_TRADING_GUIDANCE.assessmentDteMin;
    out.assessmentDteMax = DEFAULT_TRADING_GUIDANCE.assessmentDteMax;
  }
  return out;
}

/**
 * Which kind of strategy an assigned strategy id is, so the guidance only states definitions that
 * strategy actually uses. Unknown strategies get every definition, each labelled with its owner.
 */
export function strategyFamilyOf(strategyId) {
  switch (String(strategyId || '')) {
    case 'etf-mean-reversion': return 'mean-reversion';
    case 'equity-momentum': return 'breakout';
    case 'catalyst-news': return 'catalyst';
    case 'long-premium-volatility': return 'long-vol';
    case 'default': return 'prophet';
    default: return 'unknown';
  }
}

const CALLS_ONLY_CONTRACT = g => `- Contract choice: buy calls with delta about ${g.contractDeltaMin} to ${g.contractDeltaMax}, expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent), then call prophet_get_options_chain with that expiration and type call. Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`;

const CATALYST_CONTRACT = g => `- Contract choice: buy a call for a qualified bullish reaction or a put for a qualified bearish one. Use a delta magnitude of about ${g.contractDeltaMin} to ${g.contractDeltaMax} (a put's delta is negative, so compare its absolute value), expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent), then call prophet_get_options_chain with that expiration and the type that matches your direction (call or put). Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`;

const DIRECTIONAL_CONTRACT = g => `- Contract choice: buy a call for a bullish thesis or a put for a bearish thesis. Use a delta magnitude of about ${g.contractDeltaMin} to ${g.contractDeltaMax} (a put's delta is negative, so compare its absolute value), expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent; it lists dates that have listed call contracts, so confirm the put chain exists before proposing a put), then call prophet_get_options_chain with that expiration and the type that matches your direction (call or put). Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`;

// Prophet labels each position a scalp (exit in the same session) or a swing. AlphaDesk only accepts expiries
// inside its own window, so the text states the overlap instead of letting the agent pick a contract that cannot pass.
function prophetExpiryWindow(g) {
  const lo = g.assessmentDteMin, hi = g.assessmentDteMax;
  const scalp = [Math.max(2, lo), Math.min(10, hi)];
  const scalpOk = scalp[0] <= scalp[1];
  let swing = [Math.max(g.expiryMinDays, lo), Math.min(g.expiryMaxDays, hi)];
  let swingShortened = false;
  if (swing[0] > swing[1]) { swing = [lo, hi]; swingShortened = true; }
  const parts = [];
  parts.push(scalpOk ? `scalp (exit in the same session): ${scalp[0]} to ${scalp[1]} calendar days to expiry (OP2 blocks same-day expiry)` : 'scalp: not available, because no expiry that OP2 allows is inside the AlphaDesk window');
  parts.push(swingShortened
    ? `swing: the usual ${g.expiryMinDays} to ${g.expiryMaxDays} days does not overlap the AlphaDesk window, so swings are limited to ${swing[0]} to ${swing[1]} calendar days to expiry`
    : `swing: ${swing[0]} to ${swing[1]} calendar days to expiry`);
  return { text: parts.join('; '), scalpOk, swingOk: true, swing, scalp };
}
const PROPHET_CONTRACT = g => {
  const w = prophetExpiryWindow(g);
  return `- Contract choice: buy mainly calls; buy a put only for a clearly bearish setup, never as a hedge. Label each position a scalp or a swing at entry and keep that horizon. Choose an expiry beyond your intended hold, limited to what AlphaDesk accepts: AlphaDesk only passes an option that expires ${g.assessmentDteMin} to ${g.assessmentDteMax} calendar days out, so a contract outside that window cannot pass and is not a candidate. Expiry windows AlphaDesk accepts (your Strategy Rules decide which styles you may open): ${w.text}. Use a delta magnitude of about ${g.contractDeltaMin} to ${g.contractDeltaMax} (a put's delta is negative, so compare its absolute value). Pick the expiry first with prophet_get_option_expirations using a min_dte and max_dte inside that window (choose only a confirmed date; dates it lists as unchecked are unknown, not absent; it lists dates with listed call contracts, so confirm a put chain exists before proposing a put), then call prophet_get_options_chain with that expiration and the matching type. Use max_cost only as a ceiling on ONE contract, never as a position budget.`;
};
const pricingLine = g => `- Option cost discipline: compute each exact OCC contract's spread as (ask - bid) / mid before you propose it and, among qualifying strikes and expiries, prefer the tightest spread. The platform's spread cap is applied by OP2 itself: it refuses an opening whose spread, measured on AlphaDesk's own quote of that exact contract, is above ${g.maxOptionSpreadPct}%. That quote can be wider than the one you saw, so prefer a clearly tighter contract; do not add a second spread veto of your own. A tighter spread cap written in your Strategy Rules still applies, and a stricter rule of your strategy always wins. Start an entry limit at the mid and never above the ask. To exit after your thesis or stop is invalidated, use a marketable limit at or just below the current bid of the same contract; to take profit, start at the mid and reprice on a later heartbeat. Any repricing follows the existing cancel, reconcile and new exact proposal rules, and a price is never changed to obtain a PASS. Option quotes can be indicative; say so when it matters. Do not add your own cost, edge or spread-versus-target veto beyond your Strategy Rules, these definitions and AlphaDesk; choose the tightest acceptable contract and price the limit at or near the midpoint. Limit prices are whole cents: the order and assessment tools round a buy down and a sell up to the cent, and the receipt shows the price used. Re-read the exact contract quote immediately before the guarded order and submit at once (aim for under 90 seconds); OP2 rejects quote evidence older than 2 minutes and that check still decides. Write your logs after the order call. Review an unfilled opening order at the second heartbeat after submission: re-check the setup and fills, and cancel it unless it still qualifies at the same limit. Copy order IDs exactly from the latest get_orders result; never retype them. Before any replacement, confirm the cancel is terminal and read its cumulative filled quantity; a replacement covers only the verified remaining quantity, never more. When your recorded exit plan still requires a position to close: after the cancel is terminal, reconcile fills, the held quantity and any other working exits, then submit a freshly priced replacement for the remaining unreserved quantity, preferably in the same heartbeat. If the cancel, fills, position or quote is uncertain, do not submit a duplicate exit; record the block with prophet_log_decision and continue at the next heartbeat. The second-heartbeat review above applies to opening orders only.`;
const sessionClockLine = () => '- Session time: reason about time of day only from session_time_et, minutes_since_open and minutes_to_close in get_datetime. Use UTC timestamps and the next_open and next_close strings from the broker for API arguments, never to judge the time of day. These fields explain the time; they never authorize an order.';
const otherAgentPositionsLine = () => '- Positions another agent opened: when the ORIGINAL EXIT PLAN CONTEXT marks a held position as opened by another agent, review it at your first regular-session heartbeat against your own Strategy Rules (direction, setup, holding style and exit rules; the minimum entry size and any entry-only expiry window do not apply to a position you already hold) and against its current profit or loss at the executable bid. If it fits, adopt it once: record your own invalidation, target and time exit with prophet_log_decision using action ADOPT, the exact contract symbol as symbol, and the entry order id shown in the plan context as market_data.entry_order_id (an ADOPT without both does not count), then manage it under your rules. If it does not fit, exit it with your exit pricing rule. Never add to it or roll it. A position whose opener is not confirmed is not inherited: do not exit it only because its origin or receipt is missing.';
const sessionCountLine = () => '- Counting sessions: "the third completed session after entry" counts from the day after the entry day, one completed regular session at a time; review it at your first regular-session heartbeat after that session has closed, and state the dates you counted.';
const alphaDeskLogLine = () => '- AlphaDesk outcome record: after every assessment or guarded order call, record the decision, signal_score and the reasons or failed checks in prophet_log_decision. If the score is not returned, write "unavailable"; never invent or estimate one. It is a signal-quality score, not a forecast of profit. When the receipt also returns AlphaDesk\'s observed spread or its break-even, spread-cost and time-decay figures, record them too (information only).';

const factNumber = value => (typeof value === 'number' && Number.isFinite(value) ? String(Number(value.toFixed(4))) : null);

/**
 * The live AlphaDesk thresholds for the per-heartbeat state block, from the policy the backend just read. Facts only: they
 * explain why an assessment can fail and never create a trade, a rule or a reason to skip one. Returns '' when the policy
 * carried no facts (nothing is stated that is not known).
 */
export function renderAlphaDeskPolicyFacts(facts) {
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) return '';
  const score = factNumber(facts.minimum_signal_score);
  const confidence = factNumber(facts.minimum_catalyst_confidence);
  const parts = [];
  if (score !== null) parts.push(`signal score at least ${score}`);
  if (confidence !== null) parts.push(`catalyst confidence at least ${confidence}${Number(confidence) > 0.15 ? ' (every symbol then needs at least one Alpaca headline tagged to it in the last 36 hours; a failure for weak confidence is not retryable until news exists)' : ''}`);
  const minDte = factNumber(facts.minimum_dte), maxDte = factNumber(facts.maximum_dte);
  if (minDte !== null && maxDte !== null) parts.push(`option expiry ${minDte} to ${maxDte} calendar days`);
  if (facts.require_price_action_confirmation === true) parts.push('price must be on the matching side of today\'s open');
  const cap = factNumber(facts.op2_option_spread_cap_pct);
  if (cap !== null) parts.push(`OP2 refuses an opening whose spread, on AlphaDesk's own quote of the exact contract, is above ${cap}% (that quote can be wider than the one you saw)`);
  if (!parts.length) return '';
  const lines = [`\nALPHADESK POLICY FACTS (read now; information only, never order authority): ${parts.join('; ')}. These settings are shared by every agent that uses this AlphaDesk key.`];
  if (facts.score_profile === 'catalyst_momentum_v2') {
    lines.push('AlphaDesk verifies the direction you propose against its headline wording and today\'s open. Neutral headlines do not block a put; headlines that point the other way, or a setup on the wrong side of the open, fail. Record the result and move on; never switch direction or setup to obtain a PASS. Its break-even, spread-cost and time-decay figures are information only: copy them into your thesis, never use them to skip or take a trade.');
  }
  return lines.join('\n');
}

const marketSupportiveLine = g => `- "Market supportive" means ${g.marketSymbol} meets any one of: (a) its last completed close is no more than ${g.marketTolerancePct}% below its 20-day average; (b) its latest price now (last trade, or the bid/ask midpoint when quote_flag is ok) is above that 20-day average; (c) the 5-session change of that average is ${g.marketSlopeMinPct}% or higher. get_daily_features gives the average, the close versus the average and the 5-session change. Name the figures you used.`;
const extendedLine = g => `- "Extended" means a completed close more than ${g.extendedPct}% above the broken level (close_vs_high_prior_10_sessions_pct or close_vs_high_prior_20_sessions_pct, whichever matches the range you broke).`;
const sectorLine = () => `- "Sector supportive" (single stocks only) means the same test applied to the stock's sector ETF: XLK technology, XLF financials, XLY consumer discretionary, XLP consumer staples, XLE energy, XLV health care, XLI industrials, XLU utilities, XLB materials, XLC communication services, XLRE real estate, SMH semiconductors. Fetch the sector ETF in the same get_daily_features call and name it. ETFs use the market test only.`;
const nearSupportLine = g => `- "Near support" means the session low is within ${g.nearSupportPct}% (either side) of the lowest low of the prior 20 sessions (low_vs_low_prior_20_sessions_pct; negative means the low undercut it).`;
const trendFallingLine = g => `- "Flat or falling average" means the 5-session change of the 20-day average is ${-g.avgSlopeMinPct}% or lower (the mirror of the rising test above; the close versus the average decides direction). get_daily_features gives the 20-day average, the close versus the average and the 5-session change; name the figures you used for any daily-trend test in your Strategy Rules.`;
const flatRisingLine = g => `- "Flat or rising average" means the 5-session change of the 20-day average is ${g.avgSlopeMinPct}% or higher.`;
const dailyVolumeLine = () => '- "Volume above average" means the last completed volume is above the prior 20-session average volume (last_volume_to_avg_ratio above 1). Volume is IEX volume unless the response says otherwise.';
const computedFieldsLine = () => '- Use the ready-made fields from get_daily_features instead of calculating by hand: the signed distances above, undercut_prior_session_low, and close_above_open (strictly greater than the open; equal does not count).';

function catalystLines(g) {
  return [
    '- Catalyst discovery: on every regular-session heartbeat, call prophet_get_alpaca_news first for your watch-list names (symbols in batches of up to 30, the last 36 hours; follow has_more with page_token while your step budget allows; after your first full scan of the day, keep paging only until you reach articles you have already reviewed, and say so if your step budget ran out first). Then use prophet_get_news, prophet_search_news, prophet_get_market_news and the MarketWatch tools for targeted verification, missing timing or detail, wider discovery, or when Alpaca is empty, unavailable or insufficient; you do not need to find the original press release for every candidate. Find already-public, company-specific events (earnings results, guidance, major confirmed headlines) for liquid large-cap optionable stocks, including news from after the previous close and overnight. Verify that the item is a real published company event from a reliable source and note its publication time (anchor the event at the earliest publication time you have for it: an earlier event time you already know wins, otherwise the earliest created_at among the articles about the same event; record which article set the anchor; look further only when no article gives a time; later coverage, updated_at or fetched_at never restarts the catalyst clock). Alpaca is the news provider AlphaDesk reads, so a story found there is the evidence AlphaDesk is most likely to see; a story found only on Google or MarketWatch may not appear in its evidence, which can lower its score. Say which source each item came from. prophet_get_earnings_dates only warns you off positions ahead of a scheduled release; it is never entry evidence, and you never position ahead of a scheduled release.',
    '- Same news event: articles about the same company and the same subject within 36 hours are one event. Its time is the earliest publication time among them, and a later article never restarts the clock or the range. An article about a different subject is a separate event.',
    '- Direction: a bullish reaction is a call and a bearish reaction is a put; judge the economic meaning yourself. AlphaDesk checks your direction against the headline wording and requires price to be on the matching side of today\'s open, so it can disagree with you. If it does, record the result and move to the next qualified opportunity. Never switch call and put, or change the setup, to obtain a PASS, and never manufacture news evidence.',
    `- Initial post-news range: for news published before the open (including overnight and after the prior close), the high and low of the first ${g.catalystRangeMinutes} minutes of regular-session completed 5-minute bars. For news published during the session, the high and low of the first ${g.catalystRangeMinutes} minutes of completed 5-minute bars after the publication time. Request bars with prophet_get_historical_bars (timeframe 5Min) with explicit regular-session start and end timestamps, given as full UTC timestamps for that date: the end is the actual session close (session_close_et from get_datetime; early-close days end earlier), and the start is the session open for overnight or pre-open news (session_open_et from get_datetime; a pre-market bar never forms the range) or the publication time for news published during the session. Use only bars marked complete=true, and state the feed. Enter only once minutes_since_open is at least ${g.catalystRangeMinutes} (OP2 also refuses an earlier opening).`,
    '- Confirmation: a completed 5-minute bar closes above the range high (call) or below the range low (put), and that bar\'s volume is above the average volume of the 6 completed 5-minute bars immediately before it (fewer if fewer exist since the open; the baseline excludes the breakout bar and any bar still forming). Enter at a subsequent permitted evaluation, not inside the range window.',
    `- Exhausted gap: skip a setup when the gap from the previous close is more than ${g.catalystMaxGapPct}%.`,
    `- Stop (an exit-rule choice for paper trading, not a proven improvement): the pre-reaction invalidation level in your Strategy Rules is the point ${g.catalystStopRangeFraction} of the way into the initial post-news range, measured from the side that broke. For a call it is range_high - ${g.catalystStopRangeFraction} x (range_high - range_low); for a put it is range_low + ${g.catalystStopRangeFraction} x (range_high - range_low) (the midpoint when the fraction is 0.5). Exit when a completed 5-minute bar closes on the wrong side of it, using the exit pricing rule above. Before you enter, record the stop, the target and the size basis with prophet_log_decision. Size the position so that the loss at the stop, including the spread, fits your smaller-than-standard size within the account limits.`,
    `- Target (an exit-rule choice for paper trading, not a proven improvement): ${g.catalystTargetRangeMultiple} x the range height (range_high - range_low) beyond the broken level, so range_high + ${g.catalystTargetRangeMultiple} x height for a call and range_low - ${g.catalystTargetRangeMultiple} x height for a put. When price reaches it, close half of the broker-confirmed contracts rounded down to whole contracts, and trail the remainder by exiting on a completed 5-minute close back through the broken level. This target exit happens once per position and is based on the quantity held when the target is first reached: a position that was a single contract at that moment closes in full. After the first target exit, a later touch of the target never closes the remainder; only the trail, the stop, invalidating news or the session-end rule do. If price is already beyond that target when you would enter, measure the target instead as the same multiple of the range height beyond the underlying price at your entry, and record it before entry; never sell a newly opened position just because the original target was crossed. Manage only the broker-confirmed remaining quantity. Exit immediately if the reaction thesis is invalidated by new facts. Your Strategy Rules exit by the end of the session if the reaction has not developed; that is not an unconditional close of a working position.`,
    '- Market-wide discovery: once on every regular-session heartbeat, also call prophet_get_alpaca_news with no symbols (limit up to 50) to see the newest market-wide headlines. A liquid large-cap optionable company that appears there and is not on your start list is an extra name; it counts toward your extra-name limit and must pass every rule above.',
    '- Missing or incomplete data (no completed bars yet, unknown publication time, unverified source) is INCOMPLETE_RESEARCH, never confirmation. A news result with has_more true is not by itself incomplete research: say which symbols and window you checked and whether newer relevant items may remain.',
    flatRisingLine(g),
    trendFallingLine(g),
    '- Use get_daily_features for the previous close, gap context, average volume and the daily-trend figures defined above; the range and the confirmation come from completed 5-minute bars.',
  ];
}

/** The Trading Guidance section added to the system prompt. */
export function renderTradingGuidance(guidance = DEFAULT_TRADING_GUIDANCE, options = {}) {
  const g = normalizeTradingGuidance(guidance);
  const family = strategyFamilyOf(options.strategyId);
  const lines = [
    '## Trading Guidance',
    'This is how to read your strategy rules in practice. The user can change these settings. They never override your Strategy Rules, permissions or risk limits, and never create a trade or a reason to skip a rule.',
    family === 'catalyst' ? CATALYST_CONTRACT(g)
      : family === 'long-vol' ? DIRECTIONAL_CONTRACT(g)
        : family === 'prophet' ? PROPHET_CONTRACT(g)
          : CALLS_ONLY_CONTRACT(g),
  ];
  if (family === 'long-vol') {
    // Vega's own Strategy Rules decide entries and exits. No breakout, market-trend or sector test is added here;
    // the definitions below are information only, and the evidence line only points at the tools that exist.
    lines.push(
      '- Thesis: your Strategy Rules decide every entry and exit (a dated event inside the hold, a directional view consistent with the prevailing trend, and evidence that the premium is reasonably priced for the anticipated move). Trading Guidance adds no breakout, market-trend or sector test to them. Find dated events with prophet_get_earnings_dates (status unknown means unverified). For the anticipated move, use the at-the-money straddle price and the implied volatility of the event expiry compared with a nearer expiry in prophet_get_options_chain, and the underlying\'s recent realized moves from completed daily bars. Say which evidence you used and which you could not get; no tool returns an implied-volatility history.',
      dailyVolumeLine(),
      computedFieldsLine(),
      '- Market-wide discovery (advised, not required): prophet_get_alpaca_news with no symbols returns the newest market-wide headlines, which can surface names outside your start list.',
    );
  } else if (family === 'prophet') {
    lines.push(
      '- Your Strategy Rules decide every entry and exit (a breakout aligned with the higher timeframe, a completed-bar retest that holds, momentum resuming). Trading Guidance adds no further gate; use the option cost discipline line below. For scalps use completed intraday bars (complete=true only) and record the bar timeframe; for swings use completed daily bars and the weekly trend.',
      dailyVolumeLine(),
      computedFieldsLine(),
      '- Market-wide discovery (optional): prophet_get_alpaca_news with no symbols returns the newest market-wide headlines, which can surface names outside your start list. It is never required.',
    );
  }
  if (family === 'mean-reversion') {
    lines.push(marketSupportiveLine(g), nearSupportLine(g), flatRisingLine(g), dailyVolumeLine(), computedFieldsLine());
  } else if (family === 'breakout') {
    lines.push(extendedLine(g), marketSupportiveLine(g), sectorLine(), dailyVolumeLine(), computedFieldsLine());
  } else if (family === 'catalyst') {
    lines.push(...catalystLines(g));
  } else if (family === 'long-vol' || family === 'prophet') {
    // handled above: no extra definitions
  } else {
    // unknown strategy: every definition, each labelled with the kind of strategy that uses it
    lines.push(
      `${extendedLine(g)} (Used by breakout strategies; apply only if your Strategy Rules use it.)`,
      `${marketSupportiveLine(g)} (Used by breakout and mean-reversion strategies; apply only if your Strategy Rules use it.)`,
      `${sectorLine()} (Used by breakout strategies.)`,
      `${nearSupportLine(g)} (Used by mean-reversion strategies.)`,
      `${flatRisingLine(g)} (Used by mean-reversion strategies.)`,
      dailyVolumeLine(),
      computedFieldsLine(),
    );
  }
  if (family === 'catalyst') {
    lines.push(g.extraSymbolsPerScan > 0
      ? `- Catalyst coverage: the CATALYST UNIVERSE in your prompt is a start list, not a limit. Check each listed name for fresh company news, and also any other liquid large-cap optionable stock that appears in today's company news (up to ${g.extraSymbolsPerScan} more). A listed name you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP. Name what you checked.`
      : '- Catalyst coverage: check only the names in your CATALYST UNIVERSE; a listed name you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.');
  } else {
    lines.push(g.extraSymbolsPerScan > 0
      ? `- Scan coverage: your SCAN UNIVERSE is a start list, not a limit. Complete every listed symbol first; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP. Then extend the search to up to ${g.extraSymbolsPerScan} more symbols that fit your strategy's universe. Count as extras only symbols that are not on the start list, and name them. If you checked no extras, say why.`
      : '- Scan coverage: check only the symbols in your SCAN UNIVERSE start list; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.');
  }
  lines.push(
    sessionClockLine(),
    sessionCountLine(),
    otherAgentPositionsLine(),
    pricingLine(g),
    alphaDeskLogLine(),
    '- Order of checks: apply the mandatory tests first. When one fails, stop researching that symbol and record the remaining checks as "not evaluated", never as passed. Check earnings and any other entry-readiness items (and, for breakout strategies, sector support) only before you treat a setup as entry-ready.',
    '- Wording in your own logs: mark a rejected candidate REJECT or NO_SETUP, never PASS. PASS means a genuine AlphaDesk receipt only, and a log entry or research note is not one.',
    'Apply only the definitions above that your Strategy Rules use; a field that is returned to you is information, not a rule.',
    '- prophet_get_quote also returns a session block (today\'s open, the previous close and the change from the open, with timestamps and feed). AlphaDesk measures price action against today\'s open, so use it as context for where the stock stands. It is information, not a gate and not a prediction of a PASS.',
    '- Preference (advisory only): among setups that already qualify under your own rules, prefer ones with recent company-specific news and strong current volume. This never adds or removes a rule.',
    '- AlphaDesk outcomes: on FAIL or UNAVAILABLE, record the decision and its reasons and move to the next qualified opportunity, or re-evaluate on a later heartbeat under the workflow rule. Never change price, quantity or direction merely to obtain a PASS, and never manufacture evidence. When the block was UNAVAILABLE with category upstream_service_error, deadline_exceeded or transport_error, you may on a later heartbeat run one read-only assess_options_strategy for the same still-qualified, locally valid proposal with fresh evidence; only after a PASS, and after full reconciliation, create a new intent with a new client_order_id through the guarded path. A local validation error (for example a quantity above 10) is not transient: fix the proposal instead. An unresolved submission_uncertain intent never stops research: keep scanning and record candidates as WATCHLIST, but open nothing new until it is resolved.',
  );
  if (family !== 'catalyst') {
    lines.push('- prophet_analyze_stocks includes a bar that is still forming. Do not use it as completed-bar evidence; use get_daily_features.');
  }
  return lines.join('\n');
}

// ── per-sandbox storage (own file so the protected agent config is untouched) ──
const dataDir = () => process.env.OPENPROPHET_DATA_DIR || path.join(__dirname, '..', 'data');
const filePath = () => path.join(dataDir(), 'trading-guidance.json');
let store = { version: 1, sandboxes: {} };
let writeChain = Promise.resolve();

export async function loadTradingGuidance() {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath(), 'utf-8'));
    store = { version: 1, sandboxes: parsed && typeof parsed.sandboxes === 'object' && parsed.sandboxes ? parsed.sandboxes : {} };
  } catch {
    store = { version: 1, sandboxes: {} };
  }
  return store;
}

// Trusted opening gate for the harness: only the news-catalyst strategy gets a minimum (its own range length, in
// minutes after the session open). Every other strategy gets an empty value, which means no gate.
export function openingGateMinutesFor(strategyId, guidance) {
  if (strategyFamilyOf(strategyId) !== 'catalyst') return '';
  return String(normalizeTradingGuidance(guidance || DEFAULT_TRADING_GUIDANCE).catalystRangeMinutes);
}

export function getTradingGuidanceForSandbox(sandboxId) {
  const saved = store.sandboxes[String(sandboxId)] || {};
  return normalizeTradingGuidance(saved);
}

export async function setTradingGuidanceForSandbox(sandboxId, patch, { beforePersist } = {}) {
  const id = String(sandboxId || '');
  if (!id) throw new Error('sandboxId is required');
  const unknown = Object.keys(patch || {}).filter(key => !TRADING_GUIDANCE_KEYS.includes(key) && !RETIRED_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown trading guidance field: ${unknown[0]}`);
  const next = normalizeTradingGuidance(patch, { strict: true, base: getTradingGuidanceForSandbox(id) });
  // A save that must also reach a running backend (the entry spread cap) fails as a whole when that fails.
  if (typeof beforePersist === 'function') await beforePersist(next);
  const snapshot = { version: 1, sandboxes: { ...store.sandboxes, [id]: { ...next, updatedAt: new Date().toISOString() } } };
  writeChain = writeChain.catch(() => {}).then(async () => {
    await fs.mkdir(dataDir(), { recursive: true });
    const tmp = `${filePath()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2));
    await fs.rename(tmp, filePath());
  });
  await writeChain;
  store = snapshot;
  return next;
}

export function resetTradingGuidanceStoreForTests() { store = { version: 1, sandboxes: {} }; }
