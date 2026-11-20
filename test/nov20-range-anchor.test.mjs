import test from 'node:test';
import assert from 'node:assert/strict';
import { getRangeConfirmation } from '../range-confirmation.js';
import { sessionFields } from '../session-clock.js';

// D2 (Nov 20 build): a pre-open window request on the CURRENT New York session date is moved to the session open once the session has
// opened; nothing else is ever moved. Both the requested and the used anchor are returned. Every refusal is structured.
const D = '2026-11-18';
const z = (hhmm, day = D) => `${day}T${hhmm}:00Z`;
const mk = (hhmm, o = {}, day = D) => ({ Timestamp: z(hhmm, day), Open: 10, High: 10.5, Low: 9.5, Close: 10, Volume: 100, complete: true, ...o });
const CAL = async () => ({ sessions: [{ date: D, open: '09:30', close: '16:00' }, { date: '2026-11-19', open: '09:30', close: '16:00' }] });
const tool = (bars, extra = {}) => {
  const calls = [];
  const fetchBars = async (symbol, start, end) => { calls.push({ symbol, start, end }); return { symbol, feed: 'iex', count: bars.length, bars, ...extra }; };
  return { calls, fetchBars };
};
const BARS = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45', { High: 12, Close: 11, Volume: 500 })];
const run = (args, { calendar = CAL, now = Date.parse(z('15:00')), bars = BARS } = {}) => {
  const t = tool(bars);
  return getRangeConfirmation({ symbol: 'NVDA', ...args }, { fetchBars: t.fetchBars, fetchCalendar: calendar, now }).then(result => ({ result, calls: t.calls }));
};

test('D2 (+): a pre-open anchor on the current session date maps to the session open and reports both anchors', async () => {
  for (const early of ['13:30', '08:00', '14:29']) {
    const { result, calls } = await run({ window_start: z(early) });
    assert.equal(result.status, 'ok', early);
    assert.equal(result.anchor_requested, z(early));
    assert.equal(result.anchor_used, z('14:30'));
    assert.equal(result.anchor, z('14:30'));
    assert.deepEqual(result.range.bar_starts, [z('14:30'), z('14:35'), z('14:40')]);
    assert.equal(calls[0].start, z('14:30'), 'the baseline still starts at the session open');
    assert.match(result.notes[0], /window starts at the session open/);
  }
});

test('D2 (+): an early-close day clamps to its own open and an in-session anchor is returned unchanged', async () => {
  const day = '2026-11-27';
  const calendar = async () => ({ sessions: [{ date: day, open: '09:30', close: '13:00' }] });
  const bars = [mk('14:30', {}, day), mk('14:35', {}, day), mk('14:40', {}, day)];
  const early = await run({ window_start: z('13:00', day) }, { calendar, now: Date.parse(z('15:00', day)), bars });
  assert.equal(early.result.status, 'ok');
  assert.equal(early.result.anchor_used, z('14:30', day));
  const inside = await run({ window_start: z('14:30', day) }, { calendar, now: Date.parse(z('15:00', day)), bars });
  assert.equal(inside.result.anchor_requested, z('14:30', day));
  assert.equal(inside.result.anchor_used, z('14:30', day));
  assert.ok(!inside.result.notes.some(n => /window starts at the session open/.test(n)));
});

test('D2 (-): a valid in-session non-grid anchor is not moved (B-B02 unchanged)', async () => {
  const bars = [mk('15:00'), mk('15:05'), mk('15:10'), mk('15:15'), mk('15:20')];
  const { result } = await run({ window_start: '2026-11-18T15:02:17Z' }, { now: Date.parse(z('15:30')), bars: [mk('14:30'), mk('14:35'), mk('14:40'), ...bars] });
  assert.equal(result.anchor_requested, '2026-11-18T15:02:17Z');
  assert.equal(result.anchor_used, '2026-11-18T15:02:17Z');
  assert.equal(result.window_end_exclusive, '2026-11-18T15:17:17Z');
});

test('D2 (-): a prior-date anchor is not clamped (a date the calendar does not cover is session_not_covered)', async () => {
  const { result, calls } = await run({ window_start: '2026-11-17T14:30:00Z' });
  assert.equal(result.status, 'session_not_covered');
  assert.equal(result.reason, 'date_outside_calendar_coverage');
  assert.equal(result.requested_date, '2026-11-17');
  assert.equal(result.coverage_start, D);
  assert.equal(result.coverage_end, '2026-11-19');
  assert.equal(calls.length, 0);
  assert.equal(result.anchor_used, undefined, 'nothing was moved or computed');
});

test('D2 (-): a prior-date PRE-OPEN anchor is never rolled forward to today', async () => {
  // Overnight news time (the evening before): its New York date is the previous date, so it is refused, not moved to today open.
  const { result, calls } = await run({ window_start: '2026-11-18T01:01:50Z' });
  assert.equal(result.status, 'session_not_covered');
  assert.equal(result.requested_date, '2026-11-17');
  assert.equal(calls.length, 0);
});

test('D2 (-): an after-close anchor is not clamped and reads nothing', async () => {
  const { result, calls } = await run({ window_start: z('21:00') }, { now: Date.parse(z('22:00')) });
  assert.equal(result.status, 'invalid_input');
  assert.match(result.error, /after the close of the regular session/);
  assert.equal(calls.length, 0);
});

test('D2 (-): a future anchor is rejected before any correction, even a pre-open time of a later session', async () => {
  const future = await run({ window_start: z('15:30') }, { now: Date.parse(z('15:00')) });
  assert.equal(future.result.status, 'invalid_input');
  assert.match(future.result.error, /in the future/);
  const tomorrowPre = await run({ window_start: '2026-11-19T13:30:00Z' }, { now: Date.parse(z('15:00')) });
  assert.equal(tomorrowPre.result.status, 'invalid_input');
  assert.match(tomorrowPre.result.error, /in the future/);
  assert.equal(future.calls.length + tomorrowPre.calls.length, 0);
});

test('D2 (-): a malformed timestamp is rejected, not repaired', async () => {
  for (const bad of ['2026-11-18T13:30:00', '2026-11-18T13:30:00-05:00', '2026-02-30T13:30:00Z', '13:30', 'yesterday', 1779100000]) {
    const { result, calls } = await run({ window_start: bad });
    assert.equal(result.status, 'invalid_input', String(bad));
    assert.match(result.error, /real RFC3339 UTC/);
    assert.equal(calls.length, 0);
  }
});

test('D2 (-): after midnight UTC but before midnight New York the date resolves to the New York session', async () => {
  // Nov 18 evening New York time is Nov 19 UTC. The session date is still Nov 18, so the 15:00Z-of-Nov-18 anchor is in-session and
  // a Nov 19 UTC pre-open time (which is the evening of Nov 18 New York time) is NOT the Nov 19 session pre-open case.
  const lateNow = Date.parse('2026-11-19T02:00:00Z'); // 21:00 Nov 18 New York
  const inSession = await run({ window_start: z('14:30') }, { now: lateNow });
  assert.equal(inSession.result.status, 'ok');
  assert.equal(inSession.result.anchor_used, z('14:30'));
  const evening = await run({ window_start: '2026-11-19T01:00:00Z' }, { now: lateNow }); // 20:00 Nov 18 New York, after the close
  assert.equal(evening.result.status, 'invalid_input');
  assert.match(evening.result.error, /after the close of the regular session of 2026-11-18/);
  assert.equal(evening.calls.length, 0);
});

test('D2 (-): no session today (holiday): no clamp, a plain essential refusal', async () => {
  const calendar = async () => ({ sessions: [{ date: '2026-11-19', open: '09:30', close: '16:00' }] }); // today (the 18th) has no row
  const { result, calls } = await run({ window_start: z('13:30') }, { calendar });
  assert.equal(result.status, 'invalid_input');
  assert.match(result.error, /no regular session on 2026-11-18/);
  assert.equal(calls.length, 0);
});

test('D2 (-): a request before the session has opened is refused (nothing to read), never moved into a usable range', async () => {
  const { result, calls } = await run({ window_start: z('13:00') }, { now: Date.parse(z('13:45')) });
  assert.equal(result.status, 'invalid_input');
  assert.match(result.error, /has not opened yet/);
  assert.equal(calls.length, 0);
});

test('D2 (-): calendar unavailable, empty or unreadable stays an essential refusal', async () => {
  const down = await run({ window_start: z('14:30') }, { calendar: async () => { throw new Error('503'); } });
  assert.equal(down.result.status, 'invalid_input');
  assert.match(down.result.error, /calendar is unavailable/);
  const empty = await run({ window_start: z('14:30') }, { calendar: async () => ({ sessions: [] }) });
  assert.equal(empty.result.status, 'invalid_input');
  assert.match(empty.result.error, /no readable sessions/);
  const broken = await run({ window_start: z('14:30') }, { calendar: async () => ({ sessions: [{ date: D, open: 'x', close: 'y' }] }) });
  assert.equal(broken.result.status, 'invalid_input');
  assert.match(broken.result.error, /not readable/);
  assert.equal(down.calls.length + empty.calls.length + broken.calls.length, 0);
});

test('D2: the baseline, completeness and null behaviour are unchanged when an anchor was moved (B-B03)', async () => {
  const bars = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45', { High: 12, Close: 11, Volume: 20 })];
  const { result } = await run({ window_start: z('13:30') }, { bars });
  const row = result.confirmations.find(r => r.start === z('14:45'));
  assert.equal(row.baseline_bars, 3);
  assert.equal(row.baseline_volume, 100);
  assert.equal(row.confirming, false);
  const missing = await run({ window_start: z('13:30') }, { bars: [mk('14:30'), mk('14:40')] });
  assert.equal(missing.result.status, 'window_incomplete');
  assert.equal(missing.result.range, null);
  assert.equal(missing.result.anchor_used, z('14:30'));
});

test('get_datetime fields: full-UTC session bounds come from the broker calendar with the daylight-saving-correct conversion', () => {
  const clock = ts => ({ timestamp: ts, is_open: true });
  const winter = sessionFields(clock('2026-11-18T15:00:00Z'), [{ date: '2026-11-18', open: '09:30', close: '16:00' }]);
  assert.equal(winter.session_open_utc, '2026-11-18T14:30:00Z');
  assert.equal(winter.session_close_utc, '2026-11-18T21:00:00Z');
  const summer = sessionFields(clock('2026-07-15T15:00:00Z'), [{ date: '2026-07-15', open: '09:30', close: '16:00' }]);
  assert.equal(summer.session_open_utc, '2026-07-15T13:30:00Z');
  const early = sessionFields(clock('2026-11-27T15:00:00Z'), [{ date: '2026-11-27', open: '09:30', close: '13:00' }]);
  assert.equal(early.session_close_utc, '2026-11-27T18:00:00Z');
  const none = sessionFields(clock('2026-11-18T15:00:00Z'), []);
  assert.equal(none.session_open_utc, null);
  assert.equal(none.session_close_utc, null);
  assert.equal(sessionFields(null, []).session_open_utc, null);
});
