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
    case 'capital-preservation': return 'support';
    case 'macro-rotation':
    case 'long-horizon-trend': return 'shares';
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
const CATALYST_REDUCING_ORDER_NOTE = 'A reducing order of yours (including a take-profit exit) has its own test: it is stale once it is still unfilled at the second heartbeat after submission, and only then: re-check it, and when your recorded exit plan still requires the close, cancel it, wait until the cancel is terminal, read its cumulative fills, reconcile the held quantity and every other working exit, then reprice only the remaining unreserved quantity at a fresh exact-contract quote under the pricing rules above. A stop or invalidation exit is never held for this review.';
const CATALYST_CANCEL_NOTE = '; judge whether it still qualifies with the recorded range and the confirmation rule, and a different reading of the same bars is not a reason to cancel';
const pricingLine = (g, family = '') => `- Option cost discipline: compute each exact OCC contract's spread as (ask - bid) / mid before you propose it and, among qualifying strikes and expiries, prefer the tightest spread. The platform's spread cap is applied by OP2 itself: it refuses an opening whose spread, measured on AlphaDesk's own quote of that exact contract, is above ${g.maxOptionSpreadPct}%. That quote can be wider than the one you saw, so prefer a clearly tighter contract; do not add a second spread veto of your own. A tighter spread cap written in your Strategy Rules still applies, and a stricter rule of your strategy always wins. Start an entry limit at the mid and never above the ask. To exit after your thesis or stop is invalidated, use a marketable limit at or just below the current bid of the same contract; to take profit, start at the mid and reprice on a later heartbeat. Any repricing follows the existing cancel, reconcile and new exact proposal rules, and a price is never changed to obtain a PASS. Option quotes can be indicative; say so when it matters. Do not add your own cost, edge or spread-versus-target veto beyond your Strategy Rules, these definitions and AlphaDesk; choose the tightest acceptable contract and price the limit at or near the midpoint. Limit prices are whole cents: the order and assessment tools round a buy down and a sell up to the cent, and the receipt shows the price used. Re-read the exact contract quote immediately before the guarded order and submit at once (aim for under 90 seconds); OP2 rejects quote evidence older than 2 minutes and that check still decides. Write your logs after the order call. Review an unfilled opening order at the second heartbeat after submission: re-check the setup and fills, and cancel it unless it still qualifies at the same limit${family === 'catalyst' ? CATALYST_CANCEL_NOTE : ''}. Copy order IDs exactly from the latest get_orders result; never retype them. Before any replacement, confirm the cancel is terminal and read its cumulative filled quantity; a replacement covers only the verified remaining quantity, never more. When your recorded exit plan still requires a position to close: after the cancel is terminal, reconcile fills, the held quantity and any other working exits, then submit a freshly priced replacement for the remaining unreserved quantity, preferably in the same heartbeat. If the cancel, fills, position or quote is uncertain, do not submit a duplicate exit; record the block with prophet_log_decision and continue at the next heartbeat. The second-heartbeat review above applies to opening orders only.${family === 'catalyst' ? ` ${CATALYST_REDUCING_ORDER_NOTE}` : ''}`;
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
export function renderAlphaDeskPolicyFacts(facts, { twoLeg = false } = {}) {
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
  if (cap !== null) parts.push(`OP2 refuses an opening whose spread, on AlphaDesk's own quote of the exact contract${twoLeg ? ' (for a two-leg order, of its widest leg)' : ''}, is above ${cap}% (that quote can be wider than the one you saw)`);
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
    '- Catalyst discovery: on every regular-session heartbeat, call prophet_get_alpaca_news first for your watch-list names (symbols in batches of up to 30, limit 20 per page). Discovery is bounded best-effort: it never proves complete coverage and it never delays a due exit or the management of a position you hold. Your first full scan of a session chooses a lookback (hours, at most 72) that reaches back to the previous regular-session close; if 72 hours cannot reach it, say which interval stays uncovered. Page with has_more and page_token using the same query arguments and process every page you retrieve before you decide to stop; results are ordered by updated_at, so an old created_at on one article never ends the scan. One work allowance of 5 pages per heartbeat is shared by every news call of that heartbeat (watch-list batches, market-wide discovery and catch-up). When it runs out, or a page_token is missing or repeated, or the provider fails, stop and state the coverage: which symbols and window you read and which backlog or interval stays deferred, and continue that backlog at later heartbeats; a symbol you did not read is never NO_SETUP. After the first full scan, later heartbeats page only until they reach articles you have already reviewed, but a known article id does not prove that older items were reviewed: an unfinished earlier scan stays an explicit backlog, and after a restart, a gap or an unfinished scan you repeat a covering lookback instead of a one-hour window. Count an article or event once by its id; a changed updated_at never makes it new. Then use prophet_get_news, prophet_search_news, prophet_get_market_news and the MarketWatch tools for targeted verification, missing timing or detail, wider discovery, or when Alpaca is empty, unavailable or insufficient; you do not need to find the original press release for every candidate. Find already-public, company-specific events (earnings results, guidance, major confirmed headlines) for liquid large-cap optionable stocks, including news from after the previous close and overnight. Verify that the item is a real published company event from a reliable source and note its publication time (anchor the event at the earliest publication time you have for it: an earlier event time you already know wins, otherwise the earliest created_at among the articles about the same event; record which article set the anchor; look further only when no article gives a time; later coverage, updated_at or fetched_at never restarts the catalyst clock). Alpaca is the news provider AlphaDesk reads, so a story found there is the evidence AlphaDesk is most likely to see; a story found only on Google or MarketWatch may not appear in its evidence, which can lower its score. Say which source each item came from. prophet_get_earnings_dates only warns you off positions ahead of a scheduled release; it is never entry evidence, and you never position ahead of a scheduled release.',
    '- Same news event: articles about the same company and the same subject within 36 hours are one event. Its time is the earliest publication time among them, and a later article never restarts the clock or the range. An article about a different subject is a separate event. A new event on the same company and the same direction, while you hold a position on it or after you were stopped out of it, counts as a new event only if it cites a distinct verified publication; otherwise it is the same event and the re-entering rule applies.',
    '- Direction: a bullish reaction is a call and a bearish reaction is a put; judge the economic meaning yourself. AlphaDesk checks your direction against the headline wording and requires price to be on the matching side of today\'s open, so it can disagree with you. If it does, record the result and move to the next qualified opportunity. Never switch call and put, or change the setup, to obtain a PASS, and never manufacture news evidence.',
    `- Initial post-news range: for news published before the open (including overnight and after the prior close), the high and low of the first ${g.catalystRangeMinutes} minutes of regular-session completed 5-minute bars. For news published during the session, the high and low of the first ${g.catalystRangeMinutes} minutes of completed 5-minute bars after the publication time. Request bars with prophet_get_historical_bars (timeframe 5Min) with explicit regular-session start and end timestamps, given as full UTC timestamps: the end is the actual session close (session_close_utc from get_datetime; early-close days end earlier), and the start is the session open for overnight or pre-open news (session_open_utc from get_datetime; a pre-market bar never forms the range) or the publication time for news published during the session. Take the open and the close in UTC only from those two get_datetime fields and never work a UTC time out from any other field. Use only bars marked complete=true, and state the feed. The window is exactly the completed bars whose start time falls from the session open (or from the publication time) up to but not including that start plus ${g.catalystRangeMinutes} minutes; a bar that starts at the end of the window is not part of the range. Check that every bar of the window is present, complete and from the same feed before you use the range. Enter only once minutes_since_open is at least ${g.catalystRangeMinutes} (OP2 also refuses an earlier opening). For news published before the open, the range belongs to that session and its window: another article about the same event, or a new anchor article, never restarts it. Record the range once per event, the first time you have the complete window, with prophet_log_decision using action RANGE_RECORDED (the symbol, the session date, the event publication time and the effective window start as two separate facts, the window, the feed, the high, the low and the midpoint) and reuse that recorded range, with the same anchor, for every later entry and stop on the same event. An earlier verified publication time that you find later wins only through an explicit correction that cites the article and the bars; the earlier record is not rewritten. When a recorded range is available to you (your own log or the plan context of a held position) use it and do not recompute it; when none is, compute it once from exactly the window bars, cite their start times, and a different result later needs a correction that cites the bars. If you later find the recorded range was wrong, record a correction that cites the bars, and do not rewrite earlier entries.`,
    '- Confirmation: a completed 5-minute bar closes above the range high (call) or below the range low (put), and that bar\'s volume is above the average volume of the 6 completed 5-minute bars immediately before it (fewer if fewer exist since the open; the baseline excludes the breakout bar and any bar still forming). Enter at a subsequent permitted evaluation, not inside the range window: the confirming bar must start at or after the end of the range window, and a bar inside the window never confirms.',
    '- Completed-bar conditions: a condition defined over completed 5-minute bars (the confirmation, the stop and the trail) is met when any eligible completed bar since its reference point satisfies it. Check every eligible bar since that point, never only the first bar or only the latest bar, and a later bar on the other side never undoes a trigger that an earlier eligible bar already met. Eligibility is unchanged: the bars that count for a confirmation start at or after the end of the range window, and the bars that count for a stop completed after your entry fill. A stop that was already triggered is acted on at the next evaluation. This does not change the target, which stays a price touch, and entering still follows every other rule. At each evaluation of a position you hold, list every exit that your Strategy Rules and the recorded plan define for it (the stop, the target, the trail, a failed-range or failed-reaction exit, invalidating news, the close-time exit) and test each one with its own rule as written; the timing or bar rule of one exit never changes the rule of another exit.',
    '- Range and confirmation arithmetic: prophet_get_range_confirmation (symbol, window_start as a full UTC timestamp, never rounded: the session open in UTC for news published before the open, or the publication time for news published during the session; window_minutes) reads the whole regular session from the open and returns the range and every completed bar after the window with its volume baseline and whether it confirms (true, false, or null when the data cannot verify it, which is neither a rejection nor a confirmation). Use it instead of calculating the range or a baseline by hand. It states facts only, so entries, stops and exits stay your decisions. When it returns no range because bars of the window are missing, still forming or unreadable, there is no range yet: do not estimate one. Its answer states anchor_requested and anchor_used: record and reuse anchor_used as the window start. When it refuses a date it cannot cover (an earlier session), use the range already recorded for that event and do not recompute it. For an event whose range is already recorded (a RANGE_RECORDED decision or the original exit plan context), do not call it for an earlier session at all: reuse the recorded range, anchor and bars. Reading the current session again with the recorded anchor, for a confirmation, stop or re-entry check, is allowed and never re-records or changes the range; call it to record a range only when none has been recorded yet. If a position you hold has no recorded range, say so in your decision; never estimate one or recompute it from a later session. Record RANGE_RECORDED once per event and cite it on later passes.',
    '- Re-entering an event: after you have been stopped out of an event, a later entry on the same event needs its own completed-bar confirmation that starts after the exit fill of that exact contract (read from the filled order of that contract, never from another contract or from a plan), the recorded range of the event, current evidence, and an earlier position that is fully reconciled (no remaining quantity and no active, planned or uncertain order). AlphaDesk is assessed as usual.',
    `- Exhausted gap: skip a setup when the gap from the previous close is more than ${g.catalystMaxGapPct}%.`,
    `- Stop (an exit-rule choice for paper trading, not a proven improvement): the pre-reaction invalidation level in your Strategy Rules is the point ${g.catalystStopRangeFraction} of the way into the initial post-news range, measured from the side that broke. For a call it is range_high - ${g.catalystStopRangeFraction} x (range_high - range_low); for a put it is range_low + ${g.catalystStopRangeFraction} x (range_high - range_low) (the midpoint when the fraction is 0.5). Exit when a completed 5-minute bar closes on the wrong side of it, using the exit pricing rule above: for a call the wrong side is below the level, for a put it is above the level. The bar must have completed after the broker-confirmed entry fill of that exact contract (take the fill time from the filled order of that exact contract, never from another contract, from a plan, from a position mark or from the time you looked): compare the bar's end time (a bar is stamped with its start, so its end is the start plus 5 minutes) with the fill time, using bars fetched in the same heartbeat. A bar that had already completed before your fill, and any bar inside the range window, never triggers the stop; a bar that was in progress at your fill and completes after it can. Cite the bar's start time, its close, the level and the feed when you exit on the stop. Target, time and invalidating-news exits are separate and are not affected by this. Before you enter, record the stop, the target and the size basis with prophet_log_decision. Size the position so that the loss at the stop, including the spread, fits your smaller-than-standard size within the account limits.`,
    `- Target (an exit-rule choice for paper trading, not a proven improvement): ${g.catalystTargetRangeMultiple} x the range height (range_high - range_low) beyond the broken level, so range_high + ${g.catalystTargetRangeMultiple} x height for a call and range_low - ${g.catalystTargetRangeMultiple} x height for a put. When price reaches it, close half of the broker-confirmed contracts rounded down to whole contracts, and trail the remainder by exiting on a completed 5-minute close back through the broken level. For the range-based target and trail defined here, the remaining call exits on a completed 5-minute close below its original recorded broken level and the remaining put exits on a completed 5-minute close above it (equality does not count); use the original event and position plan, not a later event or session range. This clarification does not replace an explicit different exit rule or historical override in your Strategy Rules or recorded plan. This target exit happens once per position and is based on the quantity held when the target is first reached (not on the quantity left after a partial exit): a position that was a single contract at that moment closes in full. Record that quantity and the order id when you place the target exit. A placed target order reserves that allocation but is not a confirmed fill: if it is cancelled without a fill you may complete the unfilled part of the same allocation, and you never create a second target allocation. Before you place any target order, read this position's own history since its entry fill: a TARGET_EXIT_SUBMITTED or TARGET_EXIT_FILLED decision for this position, or filled sells of this exact contract recorded as its target allocation, point to the broker-confirmed cumulative target fills. When the cumulative filled quantity already equals the allocation, the target is spent and you place no target order; a working or uncertain target order still reserves the allocation; when the filled quantity is less than the allocation and the order is terminal, you may complete only the unfilled, unreserved part, once. A later new position in the same contract has its own allocation. After the first target exit, a later touch of the target never closes the remainder; only the trail, the stop, invalidating news or a due close-time exit do. If price is already beyond that target when you would enter, measure the target instead as the same multiple of the range height beyond the underlying price at your entry, and record it before entry; never sell a newly opened position just because the original target was crossed. Manage only the broker-confirmed remaining quantity. Exit immediately if the reaction thesis is invalidated by new facts. Your Strategy Rules exit by the end of the session if the reaction has not developed; that is not an unconditional close of a working position.`,
    '- Close-time exit: an exit is due by the close only when the reaction has failed to develop or your recorded plan says to exit by the close; a working position may be held overnight. When such an exit is due, start it at your first regular-session evaluation with 30 minutes or less to the close (minutes_to_close from get_datetime, which follows early closes), or at once if you are already inside that window; do not wait for the last evaluation. Reconcile the broker orders and the confirmed quantity first. A stop or invalidation that is already due is acted on at the next evaluation as usual and is never delayed to this window. Leave a working exit order alone unless it is stale; to replace one, cancel it, wait until the broker shows it terminal, read its cumulative fills, then sell only the remaining broker-confirmed quantity at a fresh exact-contract quote. If there is no fresh quote, record DATA_BLOCK; never invent a price, never duplicate an order, and never leave a due exit to an evaluation after the close.',
    '- Option quotes: take the bid, ask, sizes and quote time of an option contract, a candidate or one you hold, from prophet_get_options_chain for its exact expiry and type. A position read (prophet_get_options_position) gives exposure and a mark, not an executable quote, and it reports not found for a contract you do not hold; prophet_get_quote is for stocks and ETFs and fails on an option symbol. When the chain does not return a usable quote for a contract you hold, read that exact contract once with prophet_get_options_quote (held contracts only, read-only): it returns the bid, ask, sizes and quote time with the same indicative quality, or says why it cannot. It is a quote, never a mark, and if it also has no fresh quote the existing no-quote rules apply.',
    '- Market-wide discovery: once on every regular-session heartbeat, also call prophet_get_alpaca_news with no symbols (limit 20) to see the newest market-wide headlines; this call counts against the shared page allowance of the heartbeat, and when the allowance is spent you record that market-wide coverage as deferred instead of skipping it silently. A liquid large-cap optionable company that appears there and is not on your start list is an extra name; it counts toward your extra-name limit and must pass every rule above.',
    '- Missing or incomplete data (no completed bars yet, unknown publication time, unverified source) is INCOMPLETE_RESEARCH, never confirmation. A news result with has_more true is not by itself incomplete research: say which symbols and window you checked and whether newer relevant items may remain.',
    '- Reusing a rejection: within one session you may reuse an earlier rejection only when it rests on a completed-daily-bar trend verdict whose inputs are unchanged (same session date, symbol, direction and event, same data as-of date, same failed values), and you record that you reused it. Never reuse a missing confirmation, a price or side-of-open check, a quote, a gap measured from the current price, unknown or missing data, or a scheduled-earnings rejection once the result is published or corrected; check those again when the evidence changes. A rejection of one direction or event never suppresses another direction or event, and re-entry after an exit still follows its own rule.',
    flatRisingLine(g),
    trendFallingLine(g),
    '- Use get_daily_features for the previous close, gap context, average volume and the daily-trend figures defined above; the range and the confirmation come from completed 5-minute bars.',
  ];
}

/** The Trading Guidance section added to the system prompt. */
export function renderTradingGuidance(guidance = DEFAULT_TRADING_GUIDANCE, options = {}) {
  const g = normalizeTradingGuidance(guidance);
  const family = strategyFamilyOf(options.strategyId);
  // A prompt without a start list block must not be told to "complete every listed symbol" (buildSystemPrompt passes the real value).
  const hasStartList = options.hasStartList !== false;
  const lines = [
    '## Trading Guidance',
    'This is how to read your strategy rules in practice. The user can change these settings. They never override your Strategy Rules, permissions or risk limits, and never create a trade or a reason to skip a rule.',
  ];
  if (family === 'shares') {
    // Share strategies (Compass, Anchor) are not activated and never open options; they get only the shared session lines.
    lines.push(
      '- Your strategy trades shares only and is not activated: do not open options positions, and do not place any order unless the operator has assigned you a share-trading slot with stock permissions.',
      sessionClockLine(),
      sessionCountLine(),
    );
    return lines.join('\n');
  }
  lines.push(
    family === 'catalyst' ? CATALYST_CONTRACT(g)
      : family === 'long-vol' ? DIRECTIONAL_CONTRACT(g)
        : family === 'prophet' ? PROPHET_CONTRACT(g)
          : CALLS_ONLY_CONTRACT(g),
  );
  const outsideList = hasStartList ? 'names outside your start list' : 'names you have not looked at';
  if (family === 'long-vol') {
    // Vega's own Strategy Rules decide entries and exits. No breakout, market-trend or sector test is added here;
    // the definitions below are information only, and the evidence line only points at the tools that exist.
    lines.push(
      '- Thesis: your Strategy Rules decide every entry and exit (a dated event inside the hold, a directional view consistent with the prevailing trend, and evidence that the premium is reasonably priced for the anticipated move). Trading Guidance adds no breakout, market-trend or sector test to them. Find dated events with prophet_get_earnings_dates (status unknown means unverified). For the anticipated move, use the at-the-money straddle price and the implied volatility of the event expiry compared with a nearer expiry in prophet_get_options_chain, and the underlying\'s recent realized moves from completed daily bars. Say which evidence you used and which you could not get; no tool returns an implied-volatility history.',
      dailyVolumeLine(),
      computedFieldsLine(),
      `- Market-wide discovery (advised, not required): prophet_get_alpaca_news with no symbols returns the newest market-wide headlines, which can surface ${outsideList}.`,
    );
  } else if (family === 'prophet') {
    lines.push(
      '- Your Strategy Rules decide every entry and exit (a breakout aligned with the higher timeframe, a completed-bar retest that holds, momentum resuming). Trading Guidance adds no further gate; use the option cost discipline line below. For scalps use completed intraday bars (complete=true only) and record the bar timeframe; for swings use completed daily bars and the weekly trend.',
      dailyVolumeLine(),
      computedFieldsLine(),
      `- Market-wide discovery (optional): prophet_get_alpaca_news with no symbols returns the newest market-wide headlines, which can surface ${outsideList}. It is never required.`,
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
  } else if (family === 'support') {
    // Guardian: calls on a pullback to tested support in an established uptrend; only the definitions its rules use.
    lines.push(
      nearSupportLine(g), flatRisingLine(g), dailyVolumeLine(), computedFieldsLine(),
      `- Market-wide discovery (optional): prophet_get_alpaca_news with no symbols returns the newest market-wide headlines, which can surface ${outsideList}. It is never required.`,
    );
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
    if (hasStartList) lines.push(g.extraSymbolsPerScan > 0
      ? `- Catalyst coverage: the CATALYST UNIVERSE in your prompt is a start list, not a limit. Check each listed name for fresh company news, and also any other liquid large-cap optionable stock that appears in today's company news (up to ${g.extraSymbolsPerScan} more). A listed name you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP. Name what you checked.`
      : '- Catalyst coverage: check only the names in your CATALYST UNIVERSE; a listed name you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.');
  } else if (hasStartList) {
    lines.push(g.extraSymbolsPerScan > 0
      ? `- Scan coverage: your SCAN UNIVERSE is a start list, not a limit. Complete every listed symbol first; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP. Then extend the search to up to ${g.extraSymbolsPerScan} more symbols that fit your strategy's universe. Count as extras only symbols that are not on the start list, and name them. If you checked no extras, say why.`
      : '- Scan coverage: check only the symbols in your SCAN UNIVERSE start list; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.');
  }
  lines.push(
    sessionClockLine(),
    sessionCountLine(),
    otherAgentPositionsLine(),
    pricingLine(g, family),
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
