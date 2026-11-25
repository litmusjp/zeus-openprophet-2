// Nov 26 W1: a warning-only arithmetic check of the numbers an agent CITES when it sells to close for a stop, trail, invalidation or target.
//
// What it is: it tests the agent's own cited trigger for internal consistency (a call trail/stop is triggered by a completed 5-minute underlying
// close BELOW the level, a put by a close ABOVE it, equality never triggers; a target is a price touch by the bar high for a call or the bar low
// for a put). That is all it claims. It does not read the market, it does not know the recorded plan, it does not decide whether an EARLIER
// eligible bar triggered, and it never changes, delays or blocks an order. Pure module: no I/O, no awaits, nothing here can reach the broker path.
//
// Only one rule is interpreted numerically: a single-leg long option, an UNDERLYING price rule on COMPLETED 5-minute bars (rule_basis
// 'underlying_completed_5min_bar') for exit kinds stop, trail, invalidation or target. Every other exit (option-premium stops, time, news,
// close-time, overrides, multi-leg closes, another rule basis, malformed or incomplete evidence) is UNVERIFIABLE and says so.

export const EXIT_KINDS = Object.freeze(['stop', 'trail', 'invalidation', 'target', 'time', 'news', 'close_time', 'other']);
export const SUPPORTED_RULE_BASIS = 'underlying_completed_5min_bar';
const NUMERIC_KINDS = new Set(['stop', 'trail', 'invalidation', 'target']);
const BAR_MS = 5 * 60 * 1000;
const MAX_STRING = 80;

const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
const text = value => (typeof value === 'string' ? value.trim().slice(0, MAX_STRING) : undefined);
const price = value => (isFiniteNumber(value) && value > 0 && value < 10_000_000 ? value : undefined);

/** 'call' | 'put' from an OCC option symbol (ROOT + YYMMDD + C|P + 8 digits), else null. Direction is never taken from buy/sell. */
export function occDirection(symbol) {
  const match = /^[A-Z.]{1,6}\d{0,1}\d{6}([CP])\d{8}$/.exec(String(symbol || '').trim().toUpperCase());
  if (!match) return null;
  return match[1] === 'C' ? 'call' : 'put';
}

function isoMs(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whitelist and cap the optional exit_evidence object. Returns null when it is not an object. Unknown keys are dropped; nothing here throws. */
export function sanitizeExitEvidence(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const kind = text(raw.exit_kind);
  return {
    exit_kind: kind && EXIT_KINDS.includes(kind) ? kind : (kind ? 'unknown' : undefined),
    rule_basis: text(raw.rule_basis),
    trigger_level: price(raw.trigger_level),
    trigger_bar_start: text(raw.trigger_bar_start),
    trigger_bar_end: text(raw.trigger_bar_end),
    trigger_bar_close: price(raw.trigger_bar_close),
    trigger_bar_high: price(raw.trigger_bar_high),
    trigger_bar_low: price(raw.trigger_bar_low),
    bar_complete: raw.bar_complete === true ? true : raw.bar_complete === false ? false : undefined,
    feed: text(raw.feed),
    plan_ref: text(raw.plan_ref),
  };
}

const CHECKED = 'only the numbers you cited (not the market, not your recorded plan, not which bar was eligible)';

/**
 * order: { symbol, position_intent, legs }, evidence: the raw exit_evidence argument.
 * Returns null only when the call carries no exit_evidence at all (the old-call contract: nothing is added). Otherwise
 * { verdict: 'CONSISTENT' | 'MISMATCH' | 'UNVERIFIABLE', reason, checked }.
 */
export function auditExit(order, evidence) {
  if (!order || evidence === undefined || evidence === null) return null;
  const unverifiable = reason => ({ verdict: 'UNVERIFIABLE', reason, checked: CHECKED });
  if (order.legs !== undefined) return unverifiable('a multi-leg close has no numeric underlying-bar check');
  if (String(order.position_intent || '') !== 'sell_to_close') return unverifiable('exit_evidence applies only to a single-leg sell_to_close');
  const ev = sanitizeExitEvidence(evidence);
  if (!ev) return unverifiable('exit_evidence was not an object');
  if (!ev.exit_kind) return unverifiable('exit_kind is missing');
  if (!NUMERIC_KINDS.has(ev.exit_kind)) return unverifiable(`exit kind "${ev.exit_kind}" has no numeric underlying-bar check`);
  if (ev.rule_basis !== SUPPORTED_RULE_BASIS) return unverifiable(`rule_basis must be "${SUPPORTED_RULE_BASIS}" for a numeric check`);
  const direction = occDirection(order.symbol);
  if (!direction) return unverifiable('the contract symbol is not a single OCC option symbol');
  if (ev.trigger_level === undefined) return unverifiable('trigger_level is missing or not a positive number');
  if (ev.bar_complete !== true) return unverifiable('the cited bar is not stated as complete');
  const start = isoMs(ev.trigger_bar_start);
  const end = isoMs(ev.trigger_bar_end);
  if (start === null || end === null || end - start !== BAR_MS) return unverifiable('trigger_bar_start and trigger_bar_end must be UTC timestamps exactly five minutes apart');
  const level = ev.trigger_level;
  if (ev.exit_kind === 'target') {
    const touch = direction === 'call' ? ev.trigger_bar_high : ev.trigger_bar_low;
    if (touch === undefined) return unverifiable(`${direction === 'call' ? 'trigger_bar_high' : 'trigger_bar_low'} is missing`);
    const ok = direction === 'call' ? touch >= level : touch <= level;
    return {
      verdict: ok ? 'CONSISTENT' : 'MISMATCH',
      reason: `${direction} target ${level}: the cited bar ${direction === 'call' ? 'high' : 'low'} ${touch} ${ok ? 'reaches' : 'does not reach'} it`,
      checked: CHECKED,
    };
  }
  const close = ev.trigger_bar_close;
  if (close === undefined) return unverifiable('trigger_bar_close is missing');
  const ok = direction === 'call' ? close < level : close > level;
  return {
    verdict: ok ? 'CONSISTENT' : 'MISMATCH',
    reason: `${direction} ${ev.exit_kind} at ${level} is triggered by a completed-bar close ${direction === 'call' ? 'below' : 'above'} it (equality does not trigger); the cited close is ${close}`,
    checked: CHECKED,
  };
}

/** The line appended to the returned order text for a MISMATCH or UNVERIFIABLE verdict; '' for CONSISTENT or nothing to audit. */
export function exitAuditNote(audit) {
  if (!audit || audit.verdict === 'CONSISTENT') return '';
  return `\n\nEXIT_AUDIT: ${audit.verdict} (advisory note only; it checked ${audit.checked}). ${audit.reason}. This note does not change the order or its result above.`;
}

/**
 * The whole W1 surface in one pure, synchronous function. It runs only after the broker answer is in hand. `response` is returned unchanged
 * for a call without exit_evidence and for CONSISTENT verdicts; for MISMATCH or UNVERIFIABLE one advisory line is appended to the first text part
 * and nothing else changes (status, isError and every other part are preserved). `record` is an optional best-effort sink called once with the
 * verdict; it is never awaited, a returned promise is only given a catch handler, and a throw or a hang cannot reach the caller. Any failure here
 * returns the original response.
 */
export function withExitAudit(response, args, record) {
  try {
    if (!args || args.exit_evidence === undefined) return response;
    const audit = auditExit({ symbol: args.symbol, position_intent: args.position_intent, legs: args.legs }, args.exit_evidence);
    if (!audit) return response;
    try {
      const pending = record?.({ audit, evidence: sanitizeExitEvidence(args.exit_evidence) });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* best effort */ }
    const note = exitAuditNote(audit);
    const first = response?.content?.[0];
    if (!note || !first || first.type !== 'text' || typeof first.text !== 'string') return response;
    return { ...response, content: [{ ...first, text: first.text + note }, ...response.content.slice(1)] };
  } catch { return response; }
}
