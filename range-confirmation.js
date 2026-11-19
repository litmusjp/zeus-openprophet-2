// Deterministic arithmetic for the Herald range and confirmation rules. Read-only: it takes bars that were already fetched and
// returns facts. It never reads the broker, never places or changes an order and never decides to enter or exit.
//
// Rules implemented as the strategy text states them:
// - the window is the completed 5-minute bars whose start time falls from the anchor up to, not including, the anchor plus the window
//   length. The anchor is used exactly as given (a publication time is never rounded); the bars that belong to the window are the
//   actual five-minute-grid starts inside that half-open interval, and a bar that starts at the end of the window is not part of it;
// - every bar of the window must be present, complete and readable (finite high, low and close, high not below low, close inside the
//   bar, finite non-negative volume) before a range exists; otherwise the missing starts are reported and no range is returned;
// - a confirming bar starts at or after the end of the window, is completed and readable, closes above the range high or below the
//   range low, and its volume is above the average volume of the 6 completed 5-minute bars immediately before it (fewer only if fewer
//   exist since the session open, which is why the caller supplies the series from the session open); the baseline excludes the bar
//   itself and any bar still forming. A prior bar's VOLUME counts even when one of its price fields is unreadable; if a prior bar
//   needed for the baseline has no readable volume the baseline is unverified and no confirmation is affirmed (confirming is null).
const BAR_MS = 5 * 60 * 1000;
const BASELINE_BARS = 6;

const iso = ms => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const UTC_STRICT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/i;

/** Strict RFC3339 UTC parse: a real calendar date and clock time, nothing normalised or rolled over. Returns ms or null. */
export function parseStrictUtc(value) {
  if (typeof value !== 'string') return null;
  const match = UTC_STRICT.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || check.getUTCHours() !== hour || check.getUTCMinutes() !== minute || check.getUTCSeconds() !== second) return null;
  const fraction = /\.(\d+)Z$/i.exec(value);
  return fraction ? ms + Math.floor(Number(`0.${fraction[1]}`) * 1000) : ms;
}

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const nyParts = ms => Object.fromEntries(NY.formatToParts(new Date(ms)).filter(p => p.type !== 'literal').map(p => [p.type, Number(p.value)]));
function nyLocalToUtc(year, month, day, hour, minute) {
  for (const offset of [4, 5]) {
    const ms = Date.UTC(year, month - 1, day, hour + offset, minute);
    const p = nyParts(ms);
    if (p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute) return ms;
  }
  return null;
}
/** Regular-session bounds (09:30 to 16:00 America/New_York) of the New York date that contains the instant. */
export function regularSessionUtc(ms) {
  const p = nyParts(ms);
  const open = nyLocalToUtc(p.year, p.month, p.day, 9, 30);
  const close = nyLocalToUtc(p.year, p.month, p.day, 16, 0);
  return open === null || close === null ? null : { open, close };
}

export function normalizeBars(rawBars) {
  const out = [];
  for (const raw of Array.isArray(rawBars) ? rawBars : []) {
    const rawStart = raw?.Timestamp ?? raw?.timestamp ?? raw?.t;
    const start = typeof rawStart === 'number' ? rawStart : Date.parse(rawStart);
    if (!Number.isFinite(start)) continue;
    const high = finite(raw?.High ?? raw?.high ?? raw?.h);
    const low = finite(raw?.Low ?? raw?.low ?? raw?.l);
    const close = finite(raw?.Close ?? raw?.close ?? raw?.c);
    const volume = finite(raw?.Volume ?? raw?.volume ?? raw?.v);
    const priceValid = high !== null && low !== null && close !== null && high >= low && close >= low && close <= high;
    out.push({ start, high, low, close, volume, complete: raw?.complete === true, priceValid, volumeValid: volume !== null && volume >= 0 });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function computeRangeConfirmation({ bars, windowStart, windowMinutes = 15, symbol = null, feed = null, reportedCount = null } = {}) {
  const startMs = typeof windowStart === 'number' ? windowStart : parseStrictUtc(windowStart);
  const minutes = Number(windowMinutes);
  if (startMs === null || !Number.isFinite(startMs) || !Number.isInteger(minutes) || minutes < 5 || minutes > 60 || minutes % 5 !== 0) {
    return { status: 'invalid_input', error: 'window_start must be an RFC3339 UTC timestamp ending in Z and window_minutes a multiple of 5 from 5 to 60' };
  }
  const endMs = startMs + minutes * 60 * 1000;
  const all = normalizeBars(bars);
  // The five-minute-grid bar starts inside the half-open window [anchor, anchor + length).
  const expectedStarts = [];
  for (let at = Math.ceil(startMs / BAR_MS) * BAR_MS; at < endMs; at += BAR_MS) expectedStarts.push(at);
  const byStart = new Map();
  const duplicates = [];
  for (const bar of all) {
    if (byStart.has(bar.start)) duplicates.push(iso(bar.start)); else byStart.set(bar.start, bar);
  }
  const result = {
    status: 'ok', symbol, feed, timeframe: '5Min', anchor: iso(startMs), window_minutes: minutes, window_end_exclusive: iso(endMs),
    supplied_bars: all.length, range: null,
    window: { expected_bars: expectedStarts.length, usable_bars: 0, missing_starts: [], incomplete_starts: [], unusable_starts: [] },
    confirmations: [], first_confirming: { call: null, put: null }, latest_complete_bar: null, notes: [],
  };
  if (duplicates.length) {
    result.status = 'ambiguous_input';
    result.notes.push(`duplicate bar start times were supplied: ${duplicates.join(', ')}; nothing was computed`);
    return result;
  }
  if (reportedCount !== null && reportedCount !== all.length) {
    result.status = 'data_incomplete';
    result.notes.push(`the data source reported ${reportedCount} bars but ${all.length} were supplied; nothing was computed`);
    return result;
  }
  const usableWindow = [];
  for (const at of expectedStarts) {
    const bar = byStart.get(at);
    if (!bar) result.window.missing_starts.push(iso(at));
    else if (!bar.complete) result.window.incomplete_starts.push(iso(at));
    else if (!bar.priceValid || !bar.volumeValid) result.window.unusable_starts.push(iso(at));
    else usableWindow.push(bar);
  }
  result.window.usable_bars = usableWindow.length;
  if (usableWindow.length !== expectedStarts.length) {
    result.status = 'window_incomplete';
    result.notes.push('Not every bar of the window is present, complete and readable, so no range is returned. A partial range is not a range.');
    return result;
  }
  const high = Math.max(...usableWindow.map(bar => bar.high));
  const low = Math.min(...usableWindow.map(bar => bar.low));
  result.range = { high, low, midpoint: (high + low) / 2, height: high - low, bar_starts: usableWindow.map(bar => iso(bar.start)) };
  // Completed bars in series order. The baseline for a bar is the (up to) 6 completed bars immediately before it; a prior bar's volume
  // counts whatever its price fields look like, and a prior bar without a readable volume makes the baseline unverified.
  const series = all.filter(bar => bar.complete);
  const skipped = [];
  for (let index = 0; index < series.length; index += 1) {
    const bar = series[index];
    if (bar.start < endMs) continue; // inside or before the window: never a confirming bar
    const prior = series.slice(Math.max(0, index - BASELINE_BARS), index);
    const baselineKnown = prior.length > 0 && prior.every(p => p.volumeValid);
    const baseline = baselineKnown ? prior.reduce((sum, p) => sum + p.volume, 0) / prior.length : null;
    const readable = bar.priceValid && bar.volumeValid;
    const direction = readable ? (bar.close > high ? 'call' : bar.close < low ? 'put' : null) : null;
    let confirming = false;
    let issue = null;
    if (!readable) { confirming = null; issue = 'candidate_bar_unreadable'; skipped.push(iso(bar.start)); }
    else if (prior.length === 0) { confirming = direction === null ? false : null; issue = direction === null ? null : 'no_prior_bars_for_baseline'; }
    else if (!baselineKnown) { confirming = direction === null ? false : null; issue = direction === null ? null : 'baseline_unverified_unreadable_prior_volume'; }
    else confirming = direction !== null && bar.volume > baseline;
    const row = {
      start: iso(bar.start), end: iso(bar.start + BAR_MS), close: bar.close, volume: bar.volume,
      baseline_volume: baseline, baseline_bars: prior.length, direction,
      volume_above_baseline: baseline === null || !readable ? null : bar.volume > baseline, confirming,
    };
    if (issue) row.data_issue = issue;
    result.confirmations.push(row);
    if (confirming === true && !result.first_confirming[direction]) result.first_confirming[direction] = row.start;
  }
  const last = series[series.length - 1];
  result.latest_complete_bar = last ? { start: iso(last.start), end: iso(last.start + BAR_MS) } : null;
  if (skipped.length) result.notes.push(`bars after the window with unreadable fields cannot be judged (confirming is null): ${skipped.join(', ')}`);
  if (result.confirmations.some(row => row.confirming === null)) result.notes.push('confirming=null means the bar or its baseline could not be verified from the data: it is not a rejection and not a confirmation.');
  result.notes.push('Every completed bar after the window is listed. A confirming bar is any listed bar with confirming=true; first_confirming is only the earliest of them, not the only valid one. This tool is arithmetic only: it does not decide entries, stops or exits.');
  return result;
}

/**
 * The tool itself: validates the whole request first, fetches the regular-session bars from the session open (so volume baselines see the
 * bars since the open) to the earlier of now and the session close, and computes. `fetchBars(symbol, startIso, endIso)` returns the bars
 * response ({ bars, feed, count }). Nothing here can place or change an order.
 */
export async function getRangeConfirmation(args, { fetchBars, now = Date.now() } = {}) {
  const symbol = typeof args?.symbol === 'string' ? args.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z.]{1,10}$/.test(symbol)) return { status: 'invalid_input', error: 'symbol must be a stock ticker such as NVDA' };
  const anchor = parseStrictUtc(args?.window_start);
  if (anchor === null) return { status: 'invalid_input', error: 'window_start must be a real RFC3339 UTC timestamp ending in Z' };
  const minutes = args?.window_minutes === undefined ? 15 : args.window_minutes;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 || minutes % 5 !== 0) {
    return { status: 'invalid_input', error: 'window_minutes must be a multiple of 5 from 5 to 60' };
  }
  if (args?.baseline_start !== undefined) return { status: 'invalid_input', error: 'baseline_start is not accepted: the baseline always starts at the session open' };
  const session = regularSessionUtc(anchor);
  if (!session) return { status: 'invalid_input', error: 'the regular session for window_start could not be determined' };
  if (anchor < session.open || anchor >= session.close) {
    return { status: 'invalid_input', error: `window_start is outside the regular session (${iso(session.open)} to ${iso(session.close)}); for news published before the open use the session open as window_start, a pre-market bar never forms the range` };
  }
  if (anchor > now) return { status: 'invalid_input', error: `window_start ${iso(anchor)} is in the future (current UTC ${iso(now)})` };
  const end = Math.min(now, session.close);
  const response = await fetchBars(symbol, iso(session.open), iso(end));
  const bars = Array.isArray(response?.bars) ? response.bars : [];
  return computeRangeConfirmation({
    bars, windowStart: anchor, windowMinutes: minutes, symbol, feed: response?.feed ?? null,
    reportedCount: typeof response?.count === 'number' ? response.count : null,
  });
}
