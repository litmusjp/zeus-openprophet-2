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
    default: return 'unknown';
  }
}

const CALLS_ONLY_CONTRACT = g => `- Contract choice: buy calls with delta about ${g.contractDeltaMin} to ${g.contractDeltaMax}, expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent), then call prophet_get_options_chain with that expiration and type call. Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`;

const CATALYST_CONTRACT = g => `- Contract choice: buy a call for a qualified bullish reaction or a put for a qualified bearish one. Use a delta magnitude of about ${g.contractDeltaMin} to ${g.contractDeltaMax} (a put's delta is negative, so compare its absolute value), expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent), then call prophet_get_options_chain with that expiration and the type that matches your direction (call or put). Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`;

const marketSupportiveLine = g => `- "Market supportive" means ${g.marketSymbol} meets any one of: (a) its last completed close is no more than ${g.marketTolerancePct}% below its 20-day average; (b) its latest price now (last trade, or the bid/ask midpoint when quote_flag is ok) is above that 20-day average; (c) the 5-session change of that average is ${g.marketSlopeMinPct}% or higher. get_daily_features gives the average, the close versus the average and the 5-session change. Name the figures you used.`;
const extendedLine = g => `- "Extended" means a completed close more than ${g.extendedPct}% above the broken level (close_vs_high_prior_10_sessions_pct or close_vs_high_prior_20_sessions_pct, whichever matches the range you broke).`;
const sectorLine = () => `- "Sector supportive" (single stocks only) means the same test applied to the stock's sector ETF: XLK technology, XLF financials, XLY consumer discretionary, XLP consumer staples, XLE energy, XLV health care, XLI industrials, XLU utilities, XLB materials, XLC communication services, XLRE real estate, SMH semiconductors. Fetch the sector ETF in the same get_daily_features call and name it. ETFs use the market test only.`;
const nearSupportLine = g => `- "Near support" means the session low is within ${g.nearSupportPct}% (either side) of the lowest low of the prior 20 sessions (low_vs_low_prior_20_sessions_pct; negative means the low undercut it).`;
const flatRisingLine = g => `- "Flat or rising average" means the 5-session change of the 20-day average is ${g.avgSlopeMinPct}% or higher.`;
const dailyVolumeLine = () => '- "Volume above average" means the last completed volume is above the prior 20-session average volume (last_volume_to_avg_ratio above 1). Volume is IEX volume unless the response says otherwise.';
const computedFieldsLine = () => '- Use the ready-made fields from get_daily_features instead of calculating by hand: the signed distances above, undercut_prior_session_low, and close_above_open (strictly greater than the open; equal does not count).';

function catalystLines(g) {
  return [
    '- Catalyst discovery: on every regular-session heartbeat, call prophet_get_alpaca_news first for your watch-list names (symbols in batches of up to 30, the last 36 hours; follow has_more with page_token while your step budget allows). Then use prophet_get_news, prophet_search_news, prophet_get_market_news and the MarketWatch tools for coverage gaps, wider discovery and the original announcement; a successful Alpaca result does not stop you checking them. Find already-public, company-specific events (earnings results, guidance, major confirmed headlines) for liquid large-cap optionable stocks, including news from after the previous close and overnight. Verify that the item is a real published company event from a reliable source and note its publication time (created_at for an Alpaca item; an updated_at or fetched_at never resets the clock). Alpaca is the news provider AlphaDesk reads, so a story found there is the evidence AlphaDesk is most likely to see; a story found only on Google or MarketWatch may not appear in its evidence, which can lower its score. Say which source each item came from. prophet_get_earnings_dates only warns you off positions ahead of a scheduled release; it is never entry evidence, and you never position ahead of a scheduled release.',
    '- Direction: a bullish reaction is a call and a bearish reaction is a put; judge the economic meaning yourself. AlphaDesk reads direction from a short list of words in the headlines and requires price to be on the matching side of today\'s open, so it can disagree with you. If it does, record the result and move to the next qualified opportunity. Never switch call and put, or change the setup, to obtain a PASS, and never manufacture news evidence.',
    `- Initial post-news range: for news published before the open (including overnight and after the prior close), the high and low of the first ${g.catalystRangeMinutes} minutes of regular-session completed 5-minute bars. For news published during the session, the high and low of the first ${g.catalystRangeMinutes} minutes of completed 5-minute bars after the publication time. Request bars with prophet_get_historical_bars (timeframe 5Min) with explicit regular-session start and end timestamps (09:30 to 16:00 ET, given in UTC), use only bars marked complete=true, and state the feed.`,
    '- Confirmation: a completed 5-minute bar closes above the range high (call) or below the range low (put), and that bar\'s volume is above the average volume of the range\'s completed bars (the baseline excludes the breakout bar and any bar still forming). Enter at a subsequent permitted evaluation, not inside the range window.',
    `- Exhausted gap: skip a setup when the gap from the previous close is more than ${g.catalystMaxGapPct}%, or when the option already trades beyond a plausible remaining move.`,
    '- Missing or incomplete data (no completed bars yet, unknown publication time, unverified source) is INCOMPLETE_RESEARCH, never confirmation.',
    '- Use get_daily_features for the previous close, gap context and average volume only; the range and the confirmation come from completed 5-minute bars.',
  ];
}

/** The Trading Guidance section added to the system prompt. */
export function renderTradingGuidance(guidance = DEFAULT_TRADING_GUIDANCE, options = {}) {
  const g = normalizeTradingGuidance(guidance);
  const family = strategyFamilyOf(options.strategyId);
  const lines = [
    '## Trading Guidance',
    'This is how to read your strategy rules in practice. The user can change these settings. They never override your Strategy Rules, permissions or risk limits, and never create a trade or a reason to skip a rule.',
    family === 'catalyst' ? CATALYST_CONTRACT(g) : CALLS_ONLY_CONTRACT(g),
  ];
  if (family === 'mean-reversion') {
    lines.push(marketSupportiveLine(g), nearSupportLine(g), flatRisingLine(g), dailyVolumeLine(), computedFieldsLine());
  } else if (family === 'breakout') {
    lines.push(extendedLine(g), marketSupportiveLine(g), sectorLine(), dailyVolumeLine(), computedFieldsLine());
  } else if (family === 'catalyst') {
    lines.push(...catalystLines(g));
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
    '- Order of checks: apply the mandatory tests first. When one fails, stop researching that symbol and record the remaining checks as "not evaluated", never as passed. Check earnings and any other entry-readiness items (and, for breakout strategies, sector support) only before you treat a setup as entry-ready.',
    '- Wording in your own logs: mark a rejected candidate REJECT or NO_SETUP, never PASS. PASS means a genuine AlphaDesk receipt only, and a log entry or research note is not one.',
    'Apply only the definitions above that your Strategy Rules use; a field that is returned to you is information, not a rule.',
    '- prophet_get_quote also returns a session block (today\'s open, the previous close and the change from the open, with timestamps and feed). AlphaDesk measures price action against today\'s open, so use it as context for where the stock stands. It is information, not a gate and not a prediction of a PASS.',
    '- Preference (advisory only): among setups that already qualify under your own rules, prefer ones with recent company-specific news and strong current volume. This never adds or removes a rule.',
    '- AlphaDesk outcomes: on FAIL or UNAVAILABLE, record the decision and its reasons and move to the next qualified opportunity, or re-evaluate on a later heartbeat under the workflow rule. Never change price, quantity or direction merely to obtain a PASS, and never manufacture evidence.',
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

export function getTradingGuidanceForSandbox(sandboxId) {
  const saved = store.sandboxes[String(sandboxId)] || {};
  return normalizeTradingGuidance(saved);
}

export async function setTradingGuidanceForSandbox(sandboxId, patch) {
  const id = String(sandboxId || '');
  if (!id) throw new Error('sandboxId is required');
  const unknown = Object.keys(patch || {}).filter(key => !TRADING_GUIDANCE_KEYS.includes(key) && !RETIRED_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown trading guidance field: ${unknown[0]}`);
  const next = normalizeTradingGuidance(patch, { strict: true, base: getTradingGuidanceForSandbox(id) });
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
