// Deterministic arithmetic for the Herald range and confirmation rules. Read-only: it takes bars that were already fetched and
// returns facts. It never reads the broker, never places or changes an order and never decides to enter or exit.
//
// Rules implemented exactly as the strategy text states them:
// - the window is the completed 5-minute bars whose start time falls from the anchor up to, not including, the anchor plus the
//   window length; a bar that starts at the end of the window is not part of the range;
// - every bar of the window must be present and complete before a range exists (otherwise the missing starts are reported and no
//   range is returned: a partial range is never offered);
// - a confirming bar starts at or after the end of the window, completed, closes above the range high or below the range low, and
//   its volume is above the average volume of the (up to) 6 completed bars immediately before it (fewer if fewer exist since the
//   start of the supplied series); the baseline excludes the bar itself and any bar still forming.
const BAR_MS = 5 * 60 * 1000;
const BASELINE_BARS = 6;

const toMs = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
};
const iso = ms => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

export function normalizeBars(rawBars) {
  const out = [];
  for (const raw of Array.isArray(rawBars) ? rawBars : []) {
    const start = toMs(raw?.Timestamp ?? raw?.timestamp ?? raw?.t);
    const high = num(raw?.High ?? raw?.high ?? raw?.h);
    const low = num(raw?.Low ?? raw?.low ?? raw?.l);
    const close = num(raw?.Close ?? raw?.close ?? raw?.c);
    const volume = num(raw?.Volume ?? raw?.volume ?? raw?.v);
    if (start === null) continue;
    out.push({ start, high, low, close, volume, complete: raw?.complete === true, valid: high !== null && low !== null && close !== null && volume !== null });
  }
  return out.sort((a, b) => a.start - b.start);
}

export function computeRangeConfirmation({ bars, windowStart, windowMinutes = 15, symbol = null, feed = null } = {}) {
  const startMs = toMs(windowStart);
  const minutes = Number(windowMinutes);
  if (startMs === null || !Number.isInteger(minutes) || minutes < 5 || minutes > 60 || minutes % 5 !== 0) {
    return { status: 'invalid_input', error: 'window_start must be an RFC3339 timestamp and window_minutes a multiple of 5 from 5 to 60' };
  }
  const endMs = startMs + minutes * 60 * 1000;
  const all = normalizeBars(bars);
  const expectedStarts = [];
  for (let at = startMs; at < endMs; at += BAR_MS) expectedStarts.push(at);
  const byStart = new Map();
  const duplicates = [];
  for (const bar of all) {
    if (byStart.has(bar.start)) duplicates.push(iso(bar.start)); else byStart.set(bar.start, bar);
  }
  const result = {
    status: 'ok', symbol, feed, timeframe: '5Min', anchor: iso(startMs), window_minutes: minutes, window_end_exclusive: iso(endMs),
    supplied_bars: all.length, range: null, window: { expected_bars: expectedStarts.length, usable_bars: 0, missing_starts: [], incomplete_starts: [], unusable_starts: [] },
    confirmations: [], first_confirming: { call: null, put: null }, latest_complete_bar: null, notes: [],
  };
  if (duplicates.length) {
    result.status = 'ambiguous_input';
    result.notes.push(`duplicate bar start times were supplied: ${duplicates.join(', ')}; nothing was computed`);
    return result;
  }
  const usableWindow = [];
  for (const at of expectedStarts) {
    const bar = byStart.get(at);
    if (!bar) result.window.missing_starts.push(iso(at));
    else if (!bar.complete) result.window.incomplete_starts.push(iso(at));
    else if (!bar.valid) result.window.unusable_starts.push(iso(at));
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
  result.range = {
    high, low, midpoint: (high + low) / 2, height: high - low,
    bar_starts: usableWindow.map(bar => iso(bar.start)),
  };
  // Completed, readable bars in series order; the baseline for a bar is the (up to) 6 such bars immediately before it.
  const series = all.filter(bar => bar.complete && bar.valid);
  for (let index = 0; index < series.length; index += 1) {
    const bar = series[index];
    if (bar.start < endMs) continue; // inside or before the window: never a confirming bar
    const prior = series.slice(Math.max(0, index - BASELINE_BARS), index);
    const baseline = prior.length ? prior.reduce((sum, p) => sum + p.volume, 0) / prior.length : null;
    const direction = bar.close > high ? 'call' : bar.close < low ? 'put' : null;
    const volumeOk = baseline !== null && bar.volume > baseline;
    const row = {
      start: iso(bar.start), end: iso(bar.start + BAR_MS), close: bar.close, volume: bar.volume,
      baseline_volume: baseline, baseline_bars: prior.length, direction, volume_above_baseline: baseline === null ? null : volumeOk,
      confirming: direction !== null && volumeOk,
    };
    result.confirmations.push(row);
    if (row.confirming && !result.first_confirming[direction]) result.first_confirming[direction] = row.start;
  }
  const last = series[series.length - 1];
  result.latest_complete_bar = last ? { start: iso(last.start), end: iso(last.start + BAR_MS) } : null;
  const flagged = all.filter(bar => bar.start >= endMs && bar.complete && !bar.valid).map(bar => iso(bar.start));
  if (flagged.length) result.notes.push(`bars with unreadable fields were skipped: ${flagged.join(', ')}`);
  result.notes.push('Every completed bar after the window is listed. A confirming bar is any listed bar with confirming=true; first_confirming is only the earliest of them, not the only valid one. This tool is arithmetic only: it does not decide entries, stops or exits.');
  return result;
}
