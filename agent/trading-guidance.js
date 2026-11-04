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

/** The Trading Guidance section added to the system prompt. */
export function renderTradingGuidance(guidance = DEFAULT_TRADING_GUIDANCE) {
  const g = normalizeTradingGuidance(guidance);
  const lines = [
    '## Trading Guidance',
    'This is how to read your strategy rules in practice. The user can change these settings. They never override your Strategy Rules, permissions or risk limits, and never create a trade or a reason to skip a rule.',
    `- Contract choice: buy calls with delta about ${g.contractDeltaMin} to ${g.contractDeltaMax}, expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations (choose only a confirmed date; dates it lists as unchecked are unknown, not absent), then call prophet_get_options_chain with that expiration and type call. Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`,
    `- "Extended" means a completed close more than ${g.extendedPct}% above the broken level (close_vs_high_prior_10_sessions_pct or close_vs_high_prior_20_sessions_pct, whichever matches the range you broke).`,
    `- "Market supportive" means ${g.marketSymbol} meets any one of: (a) its last completed close is no more than ${g.marketTolerancePct}% below its 20-day average; (b) its latest price now (last trade, or the bid/ask midpoint when quote_flag is ok) is above that 20-day average; (c) the 5-session change of that average is ${g.marketSlopeMinPct}% or higher. get_daily_features gives the average, the close versus the average and the 5-session change. Name the figures you used.`,
    `- "Sector supportive" (single stocks only) means the same test applied to the stock's sector ETF: XLK technology, XLF financials, XLY consumer discretionary, XLP consumer staples, XLE energy, XLV health care, XLI industrials, XLU utilities, XLB materials, XLC communication services, XLRE real estate, SMH semiconductors. Fetch the sector ETF in the same get_daily_features call and name it. ETFs use the market test only.`,
    `- "Near support" means the session low is within ${g.nearSupportPct}% (either side) of the lowest low of the prior 20 sessions (low_vs_low_prior_20_sessions_pct; negative means the low undercut it).`,
    `- "Flat or rising average" means the 5-session change of the 20-day average is ${g.avgSlopeMinPct}% or higher.`,
    '- "Volume above average" means the last completed volume is above the prior 20-session average volume (last_volume_to_avg_ratio above 1). Volume is IEX volume unless the response says otherwise.',
    '- Use the ready-made fields from get_daily_features instead of calculating by hand: the signed distances above, undercut_prior_session_low, and close_above_open (strictly greater than the open; equal does not count).',
    g.extraSymbolsPerScan > 0
      ? `- Scan coverage: your SCAN UNIVERSE is a start list, not a limit. Complete every listed symbol first; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP. Then extend the search to up to ${g.extraSymbolsPerScan} more symbols that fit your strategy's universe. Count as extras only symbols that are not on the start list, and name them. If you checked no extras, say why.`
      : '- Scan coverage: check only the symbols in your SCAN UNIVERSE start list; a listed symbol you could not evaluate is INCOMPLETE_RESEARCH, not NO_SETUP.',
    '- Order of checks: apply the mandatory tests first. When one fails, stop researching that symbol and record the remaining checks as "not evaluated", never as passed. Check sector support and earnings only before you treat a setup as entry-ready.',
    '- Wording in your own logs: mark a rejected candidate REJECT or NO_SETUP, never PASS. PASS means a genuine AlphaDesk receipt only, and a log entry or research note is not one.',
    '- prophet_analyze_stocks includes a bar that is still forming. Do not use it as completed-bar evidence; use get_daily_features.',
  ];
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
