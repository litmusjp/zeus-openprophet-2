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
