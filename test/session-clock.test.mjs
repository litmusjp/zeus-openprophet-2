import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionFields, nyWallToInstantMs, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';

const day = (date, open = '09:30', close = '16:00') => ({ date, open, close });
const clock = (timestamp, is_open = true) => ({ timestamp, is_open });

test('regular winter day: open, 09:44:59, 09:45:00, last minute', () => {
  const s = [day('2026-11-12')];
  assert.equal(sessionFields(clock('2026-11-12T09:30:00-05:00'), s).minutes_since_open, 0);
  assert.equal(sessionFields(clock('2026-11-12T09:44:59-05:00'), s).minutes_since_open, 14);
  assert.equal(sessionFields(clock('2026-11-12T09:45:00-05:00'), s).minutes_since_open, 15);
  const late = sessionFields(clock('2026-11-12T15:59:30-05:00'), s);
  assert.equal(late.minutes_to_close, 0);
  assert.equal(late.session_time_et, '15:59');
});

test('the Nov 12 COST moment: 16:00 UTC is 11:00 ET, 299 minutes to close', () => {
  const f = sessionFields(clock('2026-11-12T16:00:09Z'), [day('2026-11-12')]);
  assert.equal(f.session_time_et, '11:00');
  assert.equal(f.minutes_since_open, 90);
  assert.equal(f.minutes_to_close, 299);
  assert.equal(f.session_open_et, '09:30');
  assert.equal(f.session_close_et, '16:00');
});

test('pre-open, closed market, after close, weekend: minutes are null but time is shown', () => {
  const s = [day('2026-11-12')];
  const pre = sessionFields(clock('2026-11-12T09:00:00-05:00', false), s);
  assert.equal(pre.minutes_since_open, null); assert.equal(pre.minutes_to_close, null); assert.equal(pre.session_time_et, '09:00');
  const after = sessionFields(clock('2026-11-12T16:05:00-05:00', false), s);
  assert.equal(after.minutes_since_open, null); assert.equal(after.minutes_to_close, null);
  const noRow = sessionFields(clock('2026-11-14T11:00:00-05:00', false), s);
  assert.equal(noRow.minutes_since_open, null); assert.equal(noRow.session_open_et, null);
});

test('is_open false inside the session window still gives null minutes (broker decides)', () => {
  const f = sessionFields(clock('2026-11-12T11:00:00-05:00', false), [day('2026-11-12')]);
  assert.equal(f.minutes_since_open, null);
});

test('early close day uses the broker close', () => {
  const s = [day('2026-11-27', '09:30', '13:00')];
  const f = sessionFields(clock('2026-11-27T12:30:00-05:00'), s);
  assert.equal(f.minutes_to_close, 30);
  assert.equal(f.session_close_et, '13:00');
});

test('daylight saving: summer (EDT) and the transition dates', () => {
  assert.equal(sessionFields(clock('2026-07-15T14:00:00Z'), [day('2026-07-15')]).minutes_since_open, 30); // 10:00 EDT
  assert.equal(sessionFields(clock('2026-03-09T13:45:00Z'), [day('2026-03-09')]).minutes_since_open, 15); // Monday after spring-forward, 09:45 EDT
  assert.equal(sessionFields(clock('2026-11-02T14:45:00Z'), [day('2026-11-02')]).minutes_since_open, 15); // Monday after fall-back, 09:45 EST
  assert.doesNotThrow(() => nyWallToInstantMs('2026-03-08', '02:30')); // wall time that does not exist: no throw (null is fine)
  assert.equal(nyWallToInstantMs('2026-03-08', '09:30'), Date.UTC(2026, 2, 8, 13, 30)); // 09:30 EDT on the transition Sunday
});

test('literal HH:MM:SS calendar rows are accepted (seconds ignored) and give the same minutes', () => {
  const s = [{ date: '2026-11-12', open: '09:30:00', close: '16:00:00' }];
  const f = sessionFields(clock('2026-11-12T09:45:00-05:00'), s);
  assert.equal(f.minutes_since_open, 15);
  assert.equal(f.minutes_to_close, 375);
  assert.equal(f.session_open_et, '09:30');
  assert.equal(f.session_close_et, '16:00');
});

test('missing or bad inputs give nulls', () => {
  for (const [c, s] of [[null, []], [{}, []], [{ timestamp: 'bogus', is_open: true }, [day('2026-11-12')]], [clock('2026-11-12T10:00:00-05:00'), null], [clock('2026-11-12T10:00:00-05:00'), [{ date: '2026-11-12', open: 'x', close: 'y' }]], [clock('2026-11-12T10:00:00-05:00'), [day('2026-11-12', '16:00', '09:30')]]]) {
    const f = sessionFields(c, s);
    assert.equal(f.minutes_since_open, null);
    assert.equal(f.minutes_to_close, null);
  }
});

test('parseMinOpeningMinutes accepts only whole numbers 1..120', () => {
  assert.equal(parseMinOpeningMinutes('15'), 15);
  for (const bad of [undefined, null, '', 'abc', '0', '-5', '1.5', '121']) assert.equal(parseMinOpeningMinutes(bad), 0);
});

test('openingGateDecision: no minimum means no gate', () => {
  assert.equal(openingGateDecision('', { minutes_since_open: null }).allowed, true);
  assert.equal(openingGateDecision(undefined, null).allowed, true);
});

test('openingGateDecision: minimum 15 refuses 14, allows 15, refuses unavailable clock', () => {
  assert.equal(openingGateDecision('15', { minutes_since_open: 14 }).allowed, false);
  assert.match(openingGateDecision('15', { minutes_since_open: 14 }).message, /minute 14/);
  assert.equal(openingGateDecision('15', { minutes_since_open: 15 }).allowed, true);
  assert.equal(openingGateDecision('15', { minutes_since_open: null }).allowed, false);
  assert.equal(openingGateDecision('15', null).allowed, false);
});

// ---- F3: long_gap (information under the Herald long-gap rule only; never an order authorization) ----
import { longGapFields } from '../session-clock.js';

const gapOf = (ts, sessions, extra = {}, isOpen = true) => {
  const c = { timestamp: ts, is_open: isOpen, ...extra };
  return longGapFields(c, sessionFields(c, sessions));
};
const UNAVAILABLE = { follows_session: null, single_leg_cutoff_utc: null, single_leg_open_allowed: null, status: 'unavailable' };

test('long_gap half-day Friday 27 Nov 2026: close 18:00Z, cutoff 16:00Z, equality is cut off', () => {
  const s = [day('2026-11-27', '09:30', '13:00')];
  const next = { next_open: '2026-11-30T09:30:00-05:00', next_close: '2026-11-27T13:00:00-05:00' };
  const at = ts => gapOf(ts, s, next);
  const early = at('2026-11-27T14:30:00Z');
  assert.deepEqual(early, { follows_session: true, single_leg_cutoff_utc: '2026-11-27T16:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' });
  assert.equal(at('2026-11-27T15:00:00Z').single_leg_open_allowed, true);
  assert.equal(at('2026-11-27T15:58:59Z').single_leg_open_allowed, true);   // 121 minutes to close
  assert.equal(at('2026-11-27T15:59:00Z').single_leg_open_allowed, true);   // exactly 121 minutes
  assert.equal(at('2026-11-27T15:59:30Z').single_leg_open_allowed, false);  // 120 whole minutes shown to the model: never more permissive than the rule text
  assert.equal(at('2026-11-27T16:00:00Z').single_leg_open_allowed, false);  // equality: minutes_to_close 120 is cut off
  assert.equal(at('2026-11-27T16:00:01Z').single_leg_open_allowed, false);
  assert.equal(at('2026-11-27T17:59:00Z').single_leg_open_allowed, false);
  assert.equal(at('2026-11-27T16:00:00Z').single_leg_cutoff_utc, '2026-11-27T16:00:00Z');
});

test('long_gap normal Friday: close 21:00Z, cutoff 19:00Z, weekend gap', () => {
  const s = [day('2026-11-20')];
  const next = { next_open: '2026-11-23T09:30:00-05:00', next_close: '2026-11-20T16:00:00-05:00' };
  assert.deepEqual(gapOf('2026-11-20T18:59:00Z', s, next), { follows_session: true, single_leg_cutoff_utc: '2026-11-20T19:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' });
  assert.equal(gapOf('2026-11-20T19:00:00Z', s, next).single_leg_open_allowed, false);
  assert.equal(gapOf('2026-11-20T20:30:00Z', s, next).single_leg_open_allowed, false);
});

test('long_gap ordinary weekday: next open the following morning is no long gap and there is no cutoff', () => {
  const s = [day('2026-11-17')];
  const next = { next_open: '2026-11-18T09:30:00-05:00', next_close: '2026-11-17T16:00:00-05:00' };
  assert.deepEqual(gapOf('2026-11-17T20:30:00Z', s, next), { follows_session: false, single_leg_cutoff_utc: null, single_leg_open_allowed: true, status: 'no_long_gap' });
});

test('long_gap holiday gap: Wednesday before Thanksgiving, next open Friday', () => {
  const s = [day('2026-11-25')];
  const next = { next_open: '2026-11-27T09:30:00-05:00', next_close: '2026-11-25T16:00:00-05:00' };
  const f = gapOf('2026-11-25T15:00:00Z', s, next);
  assert.equal(f.follows_session, true);
  assert.equal(f.single_leg_cutoff_utc, '2026-11-25T19:00:00Z');
  assert.equal(f.single_leg_open_allowed, true);
  assert.equal(gapOf('2026-11-25T19:00:00Z', s, next).single_leg_open_allowed, false);
});

test('long_gap across daylight-saving changes uses real UTC instants', () => {
  // Fri 30 Oct 2026 is still EDT (close 20:00Z); the clocks go back on Sun 1 Nov; Mon 2 Nov opens EST (14:30Z)
  const fall = gapOf('2026-10-30T17:59:00Z', [day('2026-10-30')], { next_open: '2026-11-02T14:30:00Z', next_close: '2026-10-30T20:00:00Z' });
  assert.deepEqual(fall, { follows_session: true, single_leg_cutoff_utc: '2026-10-30T18:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' });
  assert.equal(gapOf('2026-10-30T18:00:00Z', [day('2026-10-30')], { next_open: '2026-11-02T14:30:00Z' }).single_leg_open_allowed, false);
  // Fri 6 Mar 2026 is EST (close 21:00Z); the clocks go forward on Sun 8 Mar; Mon 9 Mar opens EDT (13:30Z)
  const spring = gapOf('2026-03-06T18:59:00Z', [day('2026-03-06')], { next_open: '2026-03-09T13:30:00Z', next_close: '2026-03-06T21:00:00Z' });
  assert.deepEqual(spring, { follows_session: true, single_leg_cutoff_utc: '2026-03-06T19:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' });
  // the Sunday-night DST shift makes a Sunday-evening style gap still above 24 h; a weekday spring-forward gap is not
  const weekday = gapOf('2026-03-04T15:00:00Z', [day('2026-03-04')], { next_open: '2026-03-05T14:30:00Z' });
  assert.equal(weekday.follows_session, false);
});

test('long_gap threshold is strictly more than 24 hours after this close', () => {
  const s = [day('2026-11-17')];
  assert.equal(gapOf('2026-11-17T15:00:00Z', s, { next_open: '2026-11-18T21:00:00Z' }).status, 'no_long_gap');
  assert.equal(gapOf('2026-11-17T15:00:00Z', s, { next_open: '2026-11-18T21:00:01Z' }).status, 'long_gap_follows');
});

test('long_gap missing, stale or inconsistent evidence is unavailable with null fields and never allowed', () => {
  const s = [day('2026-11-27', '09:30', '13:00')];
  const ok = { next_open: '2026-11-30T14:30:00Z', next_close: '2026-11-27T18:00:00Z' };
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, {}), UNAVAILABLE);                                  // no next_open
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, { next_open: 'garbage' }), UNAVAILABLE);
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', [], ok), UNAVAILABLE);                                  // no calendar row
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', null, ok), UNAVAILABLE);
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, ok, false), UNAVAILABLE);                            // broker says closed
  assert.deepEqual(gapOf('2026-11-27T18:00:00Z', s, ok), UNAVAILABLE);                                   // timestamp at/after the close
  assert.deepEqual(gapOf('2026-11-27T13:00:00Z', s, ok), UNAVAILABLE);                                   // before the open
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, { next_open: '2026-11-27T14:30:00Z' }), UNAVAILABLE); // next open not after the close
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, { ...ok, next_close: '2026-11-27T21:00:00Z' }), UNAVAILABLE); // next close disagrees with this close
  assert.deepEqual(gapOf('2026-11-27T14:00:00Z', s, { ...ok, next_close: 'garbage' }), UNAVAILABLE);
  assert.deepEqual(gapOf('not a time', s, ok), UNAVAILABLE);
  assert.deepEqual(longGapFields(null, null), UNAVAILABLE);
  assert.deepEqual(longGapFields({ timestamp: '2026-11-27T14:00:00Z', is_open: true, next_open: ok.next_open }, sessionFields(null, null)), UNAVAILABLE); // clock-only fallback
  assert.deepEqual(longGapFields(clock('2026-11-27T14:00:00Z'), { ...sessionFields(clock('2026-11-27T14:00:00Z'), s), minutes_to_close: 5 }), UNAVAILABLE); // inconsistent minutes
  // sessionFields carries the same long_gap object that get_datetime returns, and nulls it when evidence is missing
  assert.deepEqual(sessionFields(null, null).long_gap, UNAVAILABLE);
  assert.deepEqual(sessionFields(clock('2026-11-27T14:00:00Z'), s).long_gap, UNAVAILABLE); // no next_open on the clock
  assert.equal(sessionFields({ ...clock('2026-11-27T15:00:00Z'), next_open: '2026-11-30T14:30:00Z' }, s).long_gap.status, 'long_gap_follows');
});
