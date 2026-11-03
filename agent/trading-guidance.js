// User-adjustable "how to read your strategy rules" guidance. Prompt text only: it never changes a
// strategy, permission or risk limit (those stay in the strategy rules and OP2's backend checks).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TRADING_GUIDANCE = Object.freeze({
  contractDeltaMin: 0.45,
  contractDeltaMax: 0.65,
  expiryMinDays: 30,
  expiryMaxDays: 60,
  minEntryPct: 5,
  extendedPct: 3,
  marketSymbol: 'SPY',
  nearSupportPct: 1.5,
  avgSlopeMinPct: -0.15,
  extraSymbolsPerScan: 25,
  dailyAlphaDeskCheck: true,
});

// key -> [min, max, integer?]
const NUMERIC = Object.freeze({
  contractDeltaMin: [0.05, 0.95, false],
  contractDeltaMax: [0.05, 0.95, false],
  expiryMinDays: [1, 365, true],
  expiryMaxDays: [1, 365, true],
  minEntryPct: [0.5, 25, false],
  extendedPct: [0.5, 25, false],
  nearSupportPct: [0.1, 10, false],
  avgSlopeMinPct: [-5, 5, false],
  extraSymbolsPerScan: [0, 100, true],
});
const SYMBOL = /^[A-Z][A-Z0-9.\-]{0,5}$/;

export const TRADING_GUIDANCE_KEYS = Object.freeze(Object.keys(DEFAULT_TRADING_GUIDANCE));

function coerce(key, value) {
  if (key === 'dailyAlphaDeskCheck') {
    if (typeof value !== 'boolean') throw new Error('dailyAlphaDeskCheck must be true or false');
    return value;
  }
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
    `- Contract choice: buy calls with delta about ${g.contractDeltaMin} to ${g.contractDeltaMax}, expiring ${g.expiryMinDays} to ${g.expiryMaxDays} calendar days out and also beyond your intended hold. Pick the expiry first with prophet_get_option_expirations, then call prophet_get_options_chain with that expiration and type call. Use max_cost only as a ceiling on ONE contract, never as a position budget. Go further from the money only if your strategy says so.`,
    `- "Extended" means a completed close more than ${g.extendedPct}% above the broken level.`,
    `- "Market supportive" means ${g.marketSymbol} closed above its 20-day average, or that average is rising (get_daily_features gives both).`,
    `- "Near support" means the session low is within ${g.nearSupportPct}% of the lowest low of the prior 20 sessions.`,
    `- "Flat or rising average" means the 5-session change of the 20-day average is ${g.avgSlopeMinPct}% or higher.`,
    '- "Volume above average" means the last completed volume is above the prior 20-session average volume (last_volume_to_avg_ratio above 1). Volume is IEX volume unless the response says otherwise.',
    g.extraSymbolsPerScan > 0
      ? `- Scan breadth: your SCAN UNIVERSE is a start list, not a limit. After checking it, extend the search to up to ${g.extraSymbolsPerScan} more symbols that fit your strategy's universe and name the ones you checked.`
      : '- Scan breadth: check only the symbols in your SCAN UNIVERSE start list.',
  ];
  if (g.dailyAlphaDeskCheck) {
    lines.push('- Daily AlphaDesk check (research only): once per trading day, during the regular session, when you hold a concrete candidate, you may call prophet_assess_options_trade for that exact contract to see how AlphaDesk would judge it. It is not an order and not permission: any real entry still needs its own fresh genuine AlphaDesk PASS inside prophet_place_options_order, and FAIL or UNAVAILABLE still blocks the order. Log the decision and blocking reasons.');
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
  const unknown = Object.keys(patch || {}).filter(key => !TRADING_GUIDANCE_KEYS.includes(key));
  if (unknown.length) throw new Error(`Unknown trading guidance field: ${unknown[0]}`);
  const next = normalizeTradingGuidance(patch, { strict: true, base: getTradingGuidanceForSandbox(id) });
  const snapshot = { version: 1, sandboxes: { ...store.sandboxes, [id]: { ...next, updatedAt: new Date().toISOString() } } };
  writeChain = writeChain.then(async () => {
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
