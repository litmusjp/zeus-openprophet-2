// defaults.js — single source of built-in defaults for the Node side.
// Values are extracted verbatim from where they were previously hardcoded; centralizing them
// means a change is made in ONE place. Precedence for callers: explicit override → persisted
// agent/strategy config → environment → these built-in defaults. Security/idempotency/permission
// invariants intentionally do NOT live here — they are not operator-tunable.

// ── Models ─────────────────────────────────────────────────────────
// Kept as the current values on purpose; do not change an ID here without verifying the
// provider actually serves it (that needs a runtime capability check).
export const DEFAULT_AGENT_MODEL = 'anthropic/claude-sonnet-4-6';
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash-exp';

// Resolve the model to use: explicit run override → persisted agent choice → env → built-in.
export function resolveAgentModel({ explicit, persisted, env = process.env.OPENPROPHET_MODEL } = {}) {
  return explicit || persisted || env || DEFAULT_AGENT_MODEL;
}

// ── Alpaca endpoints ───────────────────────────────────────────────
export const ALPACA_PAPER_TRADING_URL = 'https://paper-api.alpaca.markets';
export const ALPACA_LIVE_TRADING_URL = 'https://api.alpaca.markets';
export const ALPACA_DATA_URL = 'https://data.alpaca.markets';

// Trading endpoint for an account. Never infers or auto-switches to live — paper is the default
// and live is used only when the account is explicitly non-paper.
export function alpacaTradingUrl(paper, _override) {
  // The account environment owns the endpoint. Custom overrides are not accepted
  // because they can route a paper account to a live or untrusted broker host.
  return paper ? ALPACA_PAPER_TRADING_URL : ALPACA_LIVE_TRADING_URL;
}

// ── Hosts & ports ──────────────────────────────────────────────────
export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_AGENT_PORT = 3737;
export const DEFAULT_TRADING_BOT_PORT = 4534;

// Per-agent trading-backend port allocation (sandbox mode). The hash is a stable contract —
// do not "improve" the algorithm without a migration, or running agents move ports.
export const AGENT_PORT_ALLOC = { base: 4535, slots: 10, algorithmVersion: 1 };
export function portForAgent(agentId, basePort = DEFAULT_TRADING_BOT_PORT) {
  let hash = 0;
  for (const char of String(agentId || 'default')) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  const offset = (hash % AGENT_PORT_ALLOC.slots) + 1; // ports base..base+slots-1
  return basePort + offset;
}

export function tradingPolicyEnvironment(permissions = {}) {
  permissions = permissions || {};
  const booleanValue = (key, fallback) => typeof permissions[key] === 'boolean' ? permissions[key] : fallback;
  const numberValue = (key, fallback) => Number.isFinite(Number(permissions[key])) ? Number(permissions[key]) : fallback;
  return {
    OPENPROPHET_ALLOW_LIVE_TRADING: String(booleanValue('allowLiveTrading', false)),
    OPENPROPHET_ALLOW_OPTIONS: String(booleanValue('allowOptions', false)),
    OPENPROPHET_ALLOW_STOCKS: String(booleanValue('allowStocks', false)),
    OPENPROPHET_ALLOW_0DTE: String(booleanValue('allow0DTE', false)),
    OPENPROPHET_REQUIRE_CONFIRMATION: String(booleanValue('requireConfirmation', true)),
    OPENPROPHET_MAX_ORDER_VALUE: String(numberValue('maxOrderValue', 0)),
    OPENPROPHET_MAX_POSITION_PCT: String(numberValue('maxPositionPct', 0)),
    OPENPROPHET_MAX_DEPLOYED_PCT: String(numberValue('maxDeployedPct', 0)),
    OPENPROPHET_MAX_OPEN_POSITIONS: String(numberValue('maxOpenPositions', 0)),
    OPENPROPHET_MAX_DAILY_LOSS: String(numberValue('maxDailyLoss', 0)),
  };
}

// ── Harness operational policy ─────────────────────────────────────
// Extracted verbatim from agent/harness.js. SIGKILL fallback + restart behavior remain
// invariants; only these durations/limits are named here.
export const BEAT_TIMEOUT_MS = 300000;        // hard cap per beat before SIGTERM
export const SIGKILL_GRACE_MS = 5000;         // wait after SIGTERM before SIGKILL
export const DEFAULT_MAX_TOOL_ROUNDS = 25;    // --max-turns default when perms don't set one
export const MAX_HEARTBEAT_SECONDS = 14400;  // four-hour maximum for operator/agent cadence
export const HEARTBEAT_OVERRIDE_WARMUP_SESSIONS = 2;
export const BEAT_BACKOFF = {
  threshold: 3,     // consecutive failures before backoff engages
  factor: 16,       // max multiplier cap (2^(n-2) capped here)
  capSeconds: 14400, // absolute ceiling on the backed-off interval (4 hours)
};
