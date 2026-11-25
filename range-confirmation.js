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

import { isRealIsoDay, nyDateOf, nyWallToInstantMs } from './session-clock.js';

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

/**
 * Nov 26 W5, diagnostic only. When the caller also supplies event_published_at, say whether the anchor the window was computed from (anchor_used)
 * is the anchor that publication time implies: the exact publication time (seconds kept, never rounded) for news published during the event's
 * session, or that session's broker open for pre-open and overnight news. The event's session is the first listed session that has not closed at
 * the publication time. It is only judged when the broker calendar lists the publication's own New York date or an earlier day, so an event
 * older than the calendar coverage is reported as unavailable instead of being compared with the wrong session. It never changes the window or any
 * number, never refuses a read, and says nothing about whether the news itself is real or on time.
 */
export function eventAnchorCheck(rawPublished, rows, anchorUsedMs) {
  const published = parseStrictUtc(rawPublished);
  if (published === null) return { status: 'unavailable', reason: 'event_published_at is not a real RFC3339 UTC timestamp, so the anchor was not checked' };
  const sessions = [...rows].sort((a, b) => a.open - b.open);
  if (!sessions.length || sessions[0].date > nyDateOf(published)) {
    return { status: 'unavailable', event_published_at: iso(published), reason: 'the broker calendar does not list the event\'s own date, so its session cannot be judged; use the anchor recorded for the event' };
  }
  const session = sessions.find(s => published < s.close);
  if (!session) return { status: 'unavailable', event_published_at: iso(published), reason: 'the broker calendar lists no session after event_published_at' };
  const implied = published >= session.open ? published : session.open;
  const matches = implied === anchorUsedMs;
  return {
    status: matches ? 'matches' : 'mismatch',
    event_published_at: iso(published),
    reaction_session: session.date,
    implied_anchor: iso(implied),
    anchor_used: iso(anchorUsedMs),
    note: matches
      ? 'the anchor used is the anchor this publication time implies'
      : `the anchor this publication time implies is ${iso(implied)} (${implied === published ? 'the exact publication time, news published during the session' : 'the session open, news published before the open'}) but the window was computed from ${iso(anchorUsedMs)}; the numbers above are for the anchor you supplied. This is a consistency check on the two timestamps, not a check of the news`,
  };
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
 * The tool itself: validates the whole request first, takes the session bounds from the broker market calendar (the same source
 * get_datetime uses, so early closes and holidays are respected; no fixed-clock calendar), fetches the regular-session bars from the
 * open to the earlier of now and the session close, and computes. `fetchCalendar()` returns the calendar response
 * ({ sessions: [{ date, open, close }] }); `fetchBars(symbol, startIso, endIso)` returns the bars response ({ bars, feed, count }).
 * Bars outside the regular session are ignored. Nothing here can place or change an order.
 *
 * Pre-open anchors: a window_start that is strictly parsed, not in the future and falls on the CURRENT New York session date before
 * that session's open is moved to the session open (the rule for news published before the open), once the session has opened. The answer
 * carries both `anchor_requested` (the requested time in canonical form) and `anchor_used` (the full-UTC anchor the window was computed from)
 * on every computed answer (a refusal computes nothing and carries neither).
 * Nothing else is ever moved: a prior-date, after-close or in-session non-grid anchor is used or refused exactly as before.
 *
 * Refusals are structured. Every refusal has status `invalid_input` and a plain `error` text, except a validated date outside the calendar's
 * coverage, which is status `session_not_covered` with the requested date and the coverage it was checked against (the only refusal that
 * the activity label treats as a warning).
 */
export async function getRangeConfirmation(args, { fetchBars, fetchCalendar, now = Date.now() } = {}) {
  const symbol = typeof args?.symbol === 'string' ? args.symbol.trim().toUpperCase() : '';
  if (!/^[A-Z.]{1,10}$/.test(symbol)) return { status: 'invalid_input', error: 'symbol must be a stock ticker such as NVDA' };
  const requested = parseStrictUtc(args?.window_start);
  if (requested === null) return { status: 'invalid_input', error: 'window_start must be a real RFC3339 UTC timestamp ending in Z' };
  const minutes = args?.window_minutes === undefined ? 15 : args.window_minutes;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 || minutes % 5 !== 0) {
    return { status: 'invalid_input', error: 'window_minutes must be a multiple of 5 from 5 to 60' };
  }
  if (args?.baseline_start !== undefined) return { status: 'invalid_input', error: 'baseline_start is not accepted: the baseline always starts at the session open' };
  // The original input is validated BEFORE any correction: a future request is refused, never corrected into a past one.
  if (requested > now) return { status: 'invalid_input', error: `window_start ${iso(requested)} is in the future (current UTC ${iso(now)})` };
  let calendar;
  try { calendar = await fetchCalendar(); } catch (error) {
    return { status: 'invalid_input', error: `the broker market calendar is unavailable, so the session bounds cannot be verified (${error?.message || 'error'})` };
  }
  const listed = Array.isArray(calendar?.sessions) ? calendar.sessions : [];
  if (!listed.length) return { status: 'invalid_input', error: 'the broker market calendar answer has no readable sessions, so the session bounds cannot be verified' };
  // Coverage is only ever derived from a calendar whose EVERY row is readable: a real calendar date and an open and a close that convert
  // (close after open). One unreadable row makes the whole answer unverifiable; it is never dropped to shrink the calendar into a
  // supposed proof that a date is not covered.
  const rows = [];
  for (const entry of listed) {
    const rowOpen = entry && isRealIsoDay(entry.date) ? nyWallToInstantMs(entry.date, entry.open) : null;
    const rowClose = entry && isRealIsoDay(entry.date) ? nyWallToInstantMs(entry.date, entry.close) : null;
    if (rowOpen === null || rowClose === null || rowClose <= rowOpen) {
      return { status: 'invalid_input', error: 'the broker market calendar has a row that is not readable (a real date with an open before its close), so the session bounds cannot be verified' };
    }
    rows.push({ date: entry.date, open: rowOpen, close: rowClose });
  }
  const today = nyDateOf(now);
  const requestedDate = nyDateOf(requested);
  const dates = rows.map(s => s.date).sort();
  // The broker calendar lists today and the days after it. Coverage therefore starts at the earlier of today and its first row.
  const coverageStart = dates[0] < today ? dates[0] : today;
  const coverageEnd = dates[dates.length - 1];
  if (requestedDate < coverageStart || requestedDate > coverageEnd) {
    return {
      status: 'session_not_covered', reason: 'date_outside_calendar_coverage', requested_date: requestedDate,
      coverage_start: coverageStart, coverage_end: coverageEnd,
      message: `the requested date ${requestedDate} is outside the broker calendar's coverage (${coverageStart} to ${coverageEnd}), so this tool cannot read that session; use the range, anchor and plan recorded for the event; do not request an older anchor again and do not rebuild a missing range`,
    };
  }
  const row = rows.find(s => s.date === requestedDate);
  if (!row) return { status: 'invalid_input', error: `the broker market calendar has no regular session on ${requestedDate} (a weekend or a market holiday), so the range cannot be computed` };
  const { open, close } = row;
  let anchor = requested;
  let clamped = false;
  if (requested < open) {
    // Only a request on the current New York session date, made once that session has opened, is the pre-open news case.
    if (requestedDate !== today) return { status: 'invalid_input', error: `window_start ${iso(requested)} is before the open of ${requestedDate} (${iso(open)}); a pre-open time on an earlier date is not moved forward. Use window_start from the current session's open (session_open_utc from get_datetime)` };
    if (now < open) return { status: 'invalid_input', error: `the ${requestedDate} regular session has not opened yet (opens ${iso(open)}), so no completed range exists` };
    anchor = open;
    clamped = true;
  } else if (requested >= close) {
    return { status: 'invalid_input', error: `window_start is after the close of the regular session of ${requestedDate} (${iso(open)} to ${iso(close)}); a pre-market bar never forms the range and nothing after the close is used` };
  }
  const end = Math.min(now, close);
  const response = await fetchBars(symbol, iso(open), iso(end));
  const raw = Array.isArray(response?.bars) ? response.bars : [];
  const reportedCount = typeof response?.count === 'number' ? response.count : null;
  const bars = raw.filter(bar => { const at = typeof (bar?.Timestamp ?? bar?.timestamp ?? bar?.t) === 'number' ? (bar.Timestamp ?? bar.timestamp ?? bar.t) : Date.parse(bar?.Timestamp ?? bar?.timestamp ?? bar?.t); return Number.isFinite(at) && at >= open && at < close; });
  const common = { windowStart: anchor, windowMinutes: minutes, symbol, feed: response?.feed ?? null };
  const stamp = result => {
    result.anchor_requested = iso(requested);
    result.anchor_used = iso(anchor);
    // optional diagnostic (Nov 26 W5): only when the caller supplied event_published_at; absent, the answer is exactly as before
    if (args?.event_published_at !== undefined) result.anchor_check = eventAnchorCheck(args.event_published_at, rows, anchor);
    return result;
  };
  // The source count must agree with what the source returned BEFORE out-of-session bars are dropped; only then is the filtered set computed.
  if (reportedCount !== null && reportedCount !== raw.length) return stamp(computeRangeConfirmation({ bars: raw, ...common, reportedCount }));
  const result = stamp(computeRangeConfirmation({ bars, ...common, reportedCount: null }));
  if (clamped) result.notes.unshift(`window_start ${iso(requested)} is before the regular session open, so the window starts at the session open ${iso(anchor)} (anchor_used); the news time itself stays your recorded publication time`);
  if (bars.length !== raw.length) result.notes.push(`${raw.length - bars.length} bar(s) outside the regular session (${iso(open)} to ${iso(close)}) were ignored`);
  return result;
}
