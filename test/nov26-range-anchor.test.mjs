import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { getRangeConfirmation, eventAnchorCheck, parseStrictUtc } from '../range-confirmation.js';

// Nov 26 W5 (Hermes plan review): optional event_published_at is a DIAGNOSTIC. It compares the anchor actually used (anchor_used, so a legitimate
// pre-open clamp matches) with the anchor the event's own publication time implies, using the broker open of the event's reaction session and the
// exact seconds for in-session news. It never changes the window or a number, never refuses a read, and is not news verification. It does not by
// itself fix an agent's anchor choice: it only says when the two timestamps the agent supplied disagree.

const DAY = '2026-11-25';
const z = (hhmm, day = DAY) => `${day}T${hhmm}Z`;
const bar = (start, o = {}) => ({ Timestamp: start, Open: 10, High: 10.5, Low: 9.5, Close: 10, Volume: 100, complete: true, ...o });
const BARS = ['14:30:00', '14:35:00', '14:40:00', '14:45:00', '14:50:00'].map(t => bar(z(t)));
const CAL = async () => ({ sessions: [{ date: '2026-11-24', open: '09:30', close: '16:00' }, { date: DAY, open: '09:30', close: '16:00' }] });
const run = async (args, { calendar = CAL, now = Date.parse(z('15:00:00')), bars = BARS } = {}) => {
  const calls = [];
  const result = await getRangeConfirmation({ symbol: 'LLY', ...args }, { fetchCalendar: calendar, now, fetchBars: async (symbol, start, end) => { calls.push({ symbol, start, end }); return { symbol, feed: 'iex', count: bars.length, bars }; } });
  return { result, calls };
};
const strip = result => { const { anchor_check, ...rest } = result; return rest; };

test('LLY: a headline published 14:32:23Z with window_start 14:30:00Z is flagged as a mismatch and the numbers are those of the 14:30 window', async () => {
  const { result } = await run({ window_start: z('14:30:00'), event_published_at: z('14:32:23') });
  assert.equal(result.status, 'ok');
  assert.equal(result.anchor_used, z('14:30:00'));
  assert.equal(result.anchor_check.status, 'mismatch');
  assert.equal(result.anchor_check.implied_anchor, z('14:32:23'));
  assert.equal(result.anchor_check.anchor_used, z('14:30:00'));
  assert.equal(result.anchor_check.reaction_session, DAY);
  assert.match(result.anchor_check.note, /exact publication time, news published during the session/);
  assert.match(result.anchor_check.note, /the numbers above are for the anchor you supplied/);
  const baseline = await run({ window_start: z('14:30:00') });
  assert.deepEqual(strip(result), baseline.result, 'every number, note and field except anchor_check is identical');
});

test('the correct non-rounded anchor matches and keeps its seconds', async () => {
  const { result } = await run({ window_start: z('14:32:23'), event_published_at: z('14:32:23') });
  assert.equal(result.anchor_used, z('14:32:23'));
  assert.equal(result.anchor_check.status, 'matches');
  assert.equal(result.anchor_check.implied_anchor, z('14:32:23'));
});

test('a pre-open publication clamped to the open compares through anchor_used and matches; the check names the session open', async () => {
  const { result } = await run({ window_start: z('12:31:58'), event_published_at: z('12:31:58') });
  assert.equal(result.anchor_requested, z('12:31:58'));
  assert.equal(result.anchor_used, z('14:30:00'));
  assert.equal(result.anchor_check.status, 'matches');
  assert.equal(result.anchor_check.implied_anchor, z('14:30:00'));
  // asking for the open but claiming an in-session publication is the mismatch case, not the other way round
  const wrong = await run({ window_start: z('14:30:00'), event_published_at: z('14:31:00') });
  assert.equal(wrong.result.anchor_check.status, 'mismatch');
});

test('overnight publication: the implied anchor is the broker open of the NEXT session, not today\'s or the publication date\'s open', async () => {
  // published after the Nov 24 close; the calendar lists Nov 24, so the reaction session is Nov 25
  const { result } = await run({ window_start: z('09:00:00'), event_published_at: '2026-11-24T22:15:00Z' });
  assert.equal(result.anchor_used, z('14:30:00'));
  assert.equal(result.anchor_check.status, 'matches');
  assert.equal(result.anchor_check.reaction_session, DAY);
  // early-close publication day: the Nov 27 session closes at 13:00 ET (18:00Z); news at 19:00Z is already overnight for the next listed session
  const calendar = async () => ({ sessions: [{ date: '2026-11-27', open: '09:30', close: '13:00' }, { date: '2026-11-30', open: '09:30', close: '16:00' }] });
  const early = eventAnchorCheck('2026-11-27T19:00:00Z', [{ date: '2026-11-27', open: Date.parse('2026-11-27T14:30:00Z'), close: Date.parse('2026-11-27T18:00:00Z') }, { date: '2026-11-30', open: Date.parse('2026-11-30T14:30:00Z'), close: Date.parse('2026-11-30T21:00:00Z') }], Date.parse('2026-11-30T14:30:00Z'));
  assert.equal(early.status, 'matches');
  assert.equal(early.reaction_session, '2026-11-30');
  assert.ok(calendar);
});

test('an event older than the calendar coverage is unavailable, never compared with the wrong session', async () => {
  const { result } = await run({ window_start: z('14:30:00'), event_published_at: '2026-11-19T16:00:00Z' });
  assert.equal(result.status, 'ok');
  assert.equal(result.anchor_check.status, 'unavailable');
  assert.match(result.anchor_check.reason, /does not list the event's own date/);
  assert.equal(result.anchor_check.implied_anchor, undefined);
});

test('malformed or absent event_published_at never changes the answer; absent adds no field at all', async () => {
  const baseline = await run({ window_start: z('14:30:00') });
  assert.equal('anchor_check' in baseline.result, false, 'a call without the optional value is exactly as before');
  for (const bad of ['yesterday', '2026-11-25 14:32:23', '2026-02-30T10:00:00Z', 42, null, '', {}, []]) {
    const { result } = await run({ window_start: z('14:30:00'), event_published_at: bad });
    assert.equal(result.status, 'ok', JSON.stringify(bad));
    assert.equal(result.anchor_check.status, 'unavailable', JSON.stringify(bad));
    assert.deepEqual(strip(result), baseline.result, JSON.stringify(bad));
  }
});

test('existing refusals win and are unchanged by the optional value (future, prior date, after close, calendar unavailable, not covered)', async () => {
  const cases = [
    [{ window_start: '2026-11-25T23:00:00Z' }, {}],                                  // future
    [{ window_start: z('22:00:00') }, { now: Date.parse(z('23:00:00')) }],            // after the close
    [{ window_start: '2026-11-24T12:00:00Z' }, {}],                                  // pre-open on an earlier date
    [{ window_start: z('14:30:00') }, { calendar: async () => { throw new Error('down'); } }],
    [{ window_start: '2026-11-10T14:30:00Z' }, {}],                                  // outside the coverage
  ];
  for (const [args, opts] of cases) {
    const without = await run(args, opts);
    const withValue = await run({ ...args, event_published_at: z('14:32:23') }, opts);
    assert.deepEqual(withValue.result, without.result, JSON.stringify(args));
    assert.notEqual(without.result.status, 'ok', JSON.stringify(args));
  }
});

test('eventAnchorCheck is pure arithmetic on the supplied timestamps (no session, no calendar row, no verdict about the news)', () => {
  assert.equal(parseStrictUtc('2026-11-25T14:32:23Z'), Date.parse('2026-11-25T14:32:23Z'));
  assert.equal(eventAnchorCheck('nope', [], 0).status, 'unavailable');
  assert.equal(eventAnchorCheck(z('14:32:23'), [], 0).status, 'unavailable');
  const rows = [{ date: DAY, open: Date.parse(z('14:30:00')), close: Date.parse(z('21:00:00')) }];
  assert.equal(eventAnchorCheck(z('21:30:00'), rows, Date.parse(z('14:30:00'))).status, 'unavailable', 'no later session is listed');
});

test('the published tool schema declares event_published_at as an optional string; required stays symbol and window_start', async () => {
  const source = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.equal(source.split('event_published_at: { type: \'string\'').length - 1, 1);
  assert.match(source, /required: \['symbol', 'window_start'\]/);
});
