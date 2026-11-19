import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeRangeConfirmation, getRangeConfirmation, parseStrictUtc } from '../range-confirmation.js';
import { compactHistoricalBars } from '../agent/audit-capture.js';

const nvda = JSON.parse(fs.readFileSync(new URL('../testdata/nov18-nvda-5min-bars.json', import.meta.url), 'utf8'));
const START = '2026-11-18T14:30:00Z';
const bar = (at, o = {}) => ({ Timestamp: at, Open: 10, High: 10.5, Low: 9.5, Close: 10, Volume: 1000, complete: true, ...o });
const t = (minutes) => new Date(Date.parse(START) + minutes * 60000).toISOString().replace('.000Z', 'Z');

test('the Nov 18 NVDA bars give the correct range and the first valid confirmation at the 15:15 bar', () => {
  const result = computeRangeConfirmation({ bars: nvda.bars, windowStart: START, symbol: 'NVDA', feed: nvda.feed });
  assert.equal(result.status, 'ok');
  assert.equal(result.range.high, 159.68);
  assert.equal(result.range.low, 154.43);
  assert.deepEqual(result.range.bar_starts, ['2026-11-18T14:30:00Z', '2026-11-18T14:35:00Z', '2026-11-18T14:40:00Z']);
  assert.equal(result.first_confirming.put, '2026-11-18T15:15:00Z');
  assert.equal(result.first_confirming.call, null);
  // The weaker first break (14:50, volume below its baseline) is listed and is not confirming; later bars still confirm.
  const row = at => result.confirmations.find(r => r.start === at);
  assert.equal(row('2026-11-18T14:50:00Z').confirming, false);
  assert.equal(row('2026-11-18T14:50:00Z').direction, 'put');
  assert.equal(row('2026-11-18T14:50:00Z').baseline_bars, 4);
  assert.equal(row('2026-11-18T15:15:00Z').baseline_bars, 6);
  assert.ok(result.confirmations.filter(r => r.confirming).length > 1, 'every confirming bar is listed, not only the first');
  // Bars inside the window never confirm and the bar that starts at the end of the window is not part of the range.
  assert.ok(result.confirmations.every(r => Date.parse(r.start) >= Date.parse('2026-11-18T14:45:00Z')));
  assert.ok(Math.abs(result.range.height - (159.68 - 154.43)) < 1e-9);
});

test('a bar that starts at the end of the window is not part of the range and never part of the window', () => {
  const bars = [bar(t(0)), bar(t(5)), bar(t(10)), bar(t(15), { High: 99, Close: 50 })];
  const result = computeRangeConfirmation({ bars, windowStart: START });
  assert.equal(result.range.high, 10.5);
  assert.equal(result.confirmations.length, 1);
  assert.equal(result.confirmations[0].start, t(15));
});

test('missing, still forming or unreadable window bars are reported and no partial range is returned', () => {
  const missing = computeRangeConfirmation({ bars: [bar(t(0)), bar(t(10))], windowStart: START });
  assert.equal(missing.status, 'window_incomplete');
  assert.equal(missing.range, null);
  assert.deepEqual(missing.window.missing_starts, [t(5)]);
  const forming = computeRangeConfirmation({ bars: [bar(t(0)), bar(t(5)), bar(t(10), { complete: false })], windowStart: START });
  assert.equal(forming.status, 'window_incomplete');
  assert.deepEqual(forming.window.incomplete_starts, [t(10)]);
  const unreadable = computeRangeConfirmation({ bars: [bar(t(0)), bar(t(5), { Volume: null }), bar(t(10))], windowStart: START });
  assert.equal(unreadable.status, 'window_incomplete');
  assert.deepEqual(unreadable.window.unusable_starts, [t(5)]);
  assert.equal(computeRangeConfirmation({ bars: [], windowStart: START }).status, 'window_incomplete');
});

test('duplicate bar times and invalid inputs are refused explicitly instead of guessed', () => {
  assert.equal(computeRangeConfirmation({ bars: [bar(t(0)), bar(t(0)), bar(t(5)), bar(t(10))], windowStart: START }).status, 'ambiguous_input');
  assert.equal(computeRangeConfirmation({ bars: [], windowStart: 'not-a-time' }).status, 'invalid_input');
  assert.equal(computeRangeConfirmation({ bars: [], windowStart: START, windowMinutes: 7 }).status, 'invalid_input');
});

test('confirmation needs a close beyond the range on volume above the baseline of up to 6 prior completed bars', () => {
  const bars = [bar(t(0)), bar(t(5)), bar(t(10)),
    bar(t(15), { High: 12, Close: 11, Volume: 1000 }), // beyond the high, volume equal to the baseline: not above
    bar(t(20), { High: 12, Close: 11, Volume: 1500 }), // beyond, above baseline
    bar(t(25), { Low: 7, Close: 8, Volume: 5000 }), // beyond the low, above baseline
    bar(t(30), { Close: 10, Volume: 9000 }), // inside the range: no direction
    bar(t(35), { High: 12, Close: 11, Volume: 100, complete: false }), // still forming: ignored entirely
  ];
  const result = computeRangeConfirmation({ bars, windowStart: START });
  const rows = Object.fromEntries(result.confirmations.map(r => [r.start, r]));
  assert.equal(rows[t(15)].direction, 'call');
  assert.equal(rows[t(15)].volume_above_baseline, false);
  assert.equal(rows[t(15)].confirming, false);
  assert.equal(rows[t(20)].confirming, true);
  assert.equal(rows[t(25)].direction, 'put');
  assert.equal(rows[t(25)].confirming, true);
  assert.equal(rows[t(30)].direction, null);
  assert.equal(rows[t(35)], undefined);
  assert.equal(result.first_confirming.call, t(20));
  assert.equal(result.first_confirming.put, t(25));
  assert.equal(result.latest_complete_bar.start, t(30));
  // Baseline excludes the bar itself: the 7th completed bar sees exactly 6 prior bars.
  const long = [bar(t(0)), bar(t(5)), bar(t(10)), bar(t(15)), bar(t(20)), bar(t(25)), bar(t(30), { High: 12, Close: 11, Volume: 2000 })];
  assert.equal(computeRangeConfirmation({ bars: long, windowStart: START }).confirmations.at(-1).baseline_bars, 6);
});

test('a session of more than 40 bars: the tool sees every bar while the saved audit record keeps the tail and flags the omission', () => {
  const bars = Array.from({ length: 73 }, (_, i) => bar(t(i * 5), i === 20 ? { High: 12, Close: 11, Volume: 5000 } : {}));
  const result = computeRangeConfirmation({ bars, windowStart: START });
  assert.equal(result.supplied_bars, 73);
  assert.equal(result.range.bar_starts[0], t(0));
  assert.equal(result.first_confirming.call, t(100));
  const raw = JSON.stringify({ symbol: 'X', timeframe: '5Min', feed: 'iex', count: bars.length, bars });
  const saved = JSON.parse(compactHistoricalBars(raw));
  assert.equal(saved.count, 73);
  assert.equal(saved.returned_rows, 40);
  assert.ok(saved.rows[0][0] !== t(0), 'the saved audit record is the tail only and its count and returned_rows reveal the omitted span');
});

test('the helper is arithmetic only: no order, broker or network reference', () => {
  const source = fs.readFileSync(new URL('../range-confirmation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\(|axios|callTradingBot|place_|cancel_|process\.env/);
});

// QA round 1 (B-B02, B-B03): non-grid publication anchors, session-open baselines through the real tool path, malformed candles.
const D = '2026-11-18';
const z = hhmm => `${D}T${hhmm}:00Z`;
const mk = (hhmm, o = {}) => ({ Timestamp: z(hhmm), Open: 10, High: 10.5, Low: 9.5, Close: 10, Volume: 100, complete: true, ...o });
const CAL = async () => ({ sessions: [
  { date: '2026-11-18', open: '09:30', close: '16:00' },
  { date: '2026-07-15', open: '09:30', close: '16:00' },
] });
const tool = (bars, extra = {}) => {
  const calls = [];
  const fetchBars = async (symbol, start, end) => { calls.push({ symbol, start, end }); return { symbol, feed: 'iex', count: bars.length, bars, ...extra }; };
  return { calls, fetchBars };
};

test('B-B02: a literal non-grid publication time uses the actual five-minute bar starts inside the half-open window', () => {
  const bars = [mk('15:00', { High: 99, Low: 1 }), // starts before the publication: never part of the window
    mk('15:05'), mk('15:10'), mk('15:15', { High: 12, Close: 11, Volume: 500 }), // 15:15 starts inside [15:02:17, 15:17:17): a window bar, never a confirming bar
    mk('15:20', { High: 12, Close: 11, Volume: 500 })];
  const result = computeRangeConfirmation({ bars, windowStart: `${D}T15:02:17Z` });
  assert.equal(result.status, 'ok');
  assert.equal(result.anchor, `${D}T15:02:17Z`, 'the publication timestamp is preserved, not rounded');
  assert.equal(result.window_end_exclusive, `${D}T15:17:17Z`);
  assert.equal(result.window.expected_bars, 3);
  assert.deepEqual(result.range.bar_starts, [z('15:05'), z('15:10'), z('15:15')]);
  assert.equal(result.range.high, 12);
  assert.equal(result.confirmations[0].start, z('15:20'), 'the first eligible candidate starts at or after the end of the window');
  assert.equal(computeRangeConfirmation({ bars: bars.filter(b => b.Timestamp !== z('15:10')), windowStart: `${D}T15:02:17Z` }).window.missing_starts[0], z('15:10'));
  // aligned anchor and the exclusive end boundary are unchanged
  const aligned = computeRangeConfirmation({ bars: [mk('15:00'), mk('15:05'), mk('15:10'), mk('15:15', { High: 50, Close: 40 })], windowStart: z('15:00') });
  assert.equal(aligned.range.high, 10.5);
  assert.equal(aligned.confirmations[0].start, z('15:15'));
});

test('B-B03 A: the tool reads from the session open so the baseline matches the rule (full series versus a window-only series)', async () => {
  const prior = ['14:30', '14:35', '14:40', '14:45', '14:50', '14:55'].map(h => mk(h, { Volume: 1000 }));
  const bars = [...prior, mk('15:00'), mk('15:05'), mk('15:10'), mk('15:15', { High: 12, Close: 11, Volume: 200 })];
  const { calls, fetchBars } = tool(bars);
  const result = await getRangeConfirmation({ symbol: 'nvda', window_start: z('15:00') }, { fetchBars, fetchCalendar: CAL, now: Date.parse(z('15:31')) });
  assert.deepEqual(calls, [{ symbol: 'NVDA', start: z('14:30'), end: z('15:31') }], 'fetch starts at the session open (09:30 New York) and ends at now');
  const row = result.confirmations.find(r => r.start === z('15:15'));
  assert.equal(row.baseline_volume, 550);
  assert.equal(row.baseline_bars, 6);
  assert.equal(row.confirming, false);
  // The shortened window-only series the first candidate used would have wrongly confirmed.
  const windowOnly = computeRangeConfirmation({ bars: bars.filter(b => Date.parse(b.Timestamp) >= Date.parse(z('15:00'))), windowStart: z('15:00') });
  assert.equal(windowOnly.confirmations[0].confirming, true);
});

test('B-B03 A: fewer bars are used only when fewer exist since the open; session bounds, DST and the session close are respected', async () => {
  const early = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45', { High: 12, Close: 11, Volume: 500 })];
  const t1 = tool(early);
  const r1 = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t1.fetchBars, fetchCalendar: CAL, now: Date.parse(z('14:55')) });
  assert.equal(r1.confirmations[0].baseline_bars, 3, 'only three bars exist since the open');
  assert.equal(r1.confirmations[0].confirming, true);
  // after the close the fetch ends at the regular close (16:00 New York = 21:00Z in November), not at now
  const t2 = tool(early);
  await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t2.fetchBars, fetchCalendar: CAL, now: Date.parse(`${D}T23:00:00Z`) });
  assert.equal(t2.calls[0].end, z('21:00'));
  // daylight time: the session opens at 13:30Z
  const t3 = tool([]);
  await getRangeConfirmation({ symbol: 'NVDA', window_start: '2026-07-15T13:30:00Z' }, { fetchBars: t3.fetchBars, fetchCalendar: CAL, now: Date.parse('2026-07-15T15:00:00Z') });
  assert.equal(t3.calls[0].start, '2026-07-15T13:30:00Z');
  assert.equal(t3.calls[0].end, '2026-07-15T15:00:00Z');
});

test('B-B03: the whole request is validated before any read', async () => {
  const bad = [
    [{ symbol: 'NVDA', window_start: z('14:00') }, /outside the regular session/], // before the open (pre-market)
    [{ symbol: 'NVDA', window_start: `${D}T21:00:00Z` }, /in the future/],
    [{ symbol: 'NVDA', window_start: '2026-02-30T15:00:00Z' }, /real RFC3339 UTC/],
    [{ symbol: 'NVDA', window_start: `${D}T15:00:00-05:00` }, /real RFC3339 UTC/],
    [{ symbol: 'NVDA', window_start: z('15:00'), window_minutes: 7 }, /multiple of 5/],
    [{ symbol: 'NVDA', window_start: z('15:00'), baseline_start: z('14:30') }, /baseline_start is not accepted/],
    [{ symbol: 'NV DA', window_start: z('15:00') }, /ticker/],
    [{ symbol: 'NVDA', window_start: z('20:00') }, /in the future/],
  ];
  for (const [args, pattern] of bad) {
    const { calls, fetchBars } = tool([]);
    const result = await getRangeConfirmation(args, { fetchBars, fetchCalendar: CAL, now: Date.parse(z('15:30')) });
    assert.equal(result.status, 'invalid_input', JSON.stringify(args));
    assert.match(result.error, pattern);
    assert.equal(calls.length, 0, 'no read is made for an invalid request');
  }
  assert.equal(parseStrictUtc('2026-11-18T15:00:00Z'), Date.parse('2026-11-18T15:00:00Z'));
  assert.equal(parseStrictUtc('2026-13-01T15:00:00Z'), null);
});

test('B-B03 B: an unreadable price field does not erase a prior volume, and unverifiable volume never affirms a confirmation', async () => {
  const base = [mk('14:30'), mk('14:35'), mk('14:40')];
  // prior completed bar with volume 1000 but an unreadable close: its volume stays in the baseline
  const withBadPrice = [...base, mk('14:45', { Volume: 1000, Close: null }), mk('14:50', { High: 12, Close: 11, Volume: 200 })];
  const t1 = tool(withBadPrice);
  const r1 = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t1.fetchBars, fetchCalendar: CAL, now: Date.parse(z('15:00')) });
  const row1 = r1.confirmations.find(r => r.start === z('14:50'));
  assert.equal(row1.baseline_volume, 325);
  assert.equal(row1.confirming, false);
  // prior completed bar with no readable volume: baseline unverified, confirming is null (not true)
  const noVolume = [...base, mk('14:45', { Volume: null }), mk('14:50', { High: 12, Close: 11, Volume: 5000 }), mk('14:55')];
  const t2 = tool(noVolume);
  const r2 = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t2.fetchBars, fetchCalendar: CAL, now: Date.parse(z('15:05')) });
  const row2 = r2.confirmations.find(r => r.start === z('14:50'));
  assert.equal(row2.confirming, null);
  assert.equal(row2.data_issue, 'baseline_unverified_unreadable_prior_volume');
  assert.equal(r2.confirmations.find(r => r.start === z('14:55')).confirming, false, 'a bar with no direction is simply not confirming');
  assert.equal(r2.first_confirming.call, null);
  // a candidate that is unreadable itself is not judged
  const badCandidate = computeRangeConfirmation({ bars: [...base, mk('14:45', { Close: null })], windowStart: z('14:30') });
  assert.equal(badCandidate.confirmations[0].confirming, null);
  assert.equal(badCandidate.confirmations[0].data_issue, 'candidate_bar_unreadable');
});

test('B-B03 B: impossible window candles produce no range, and a count that disagrees with the supplied bars is data-incomplete', async () => {
  for (const [name, patch] of [['high below low', { High: 9, Low: 10, Close: 9.5 }], ['close above the high', { Close: 11 }], ['negative volume', { Volume: -5 }], ['missing volume', { Volume: undefined }]]) {
    const result = computeRangeConfirmation({ bars: [mk('14:30'), mk('14:35', patch), mk('14:40')], windowStart: z('14:30') });
    assert.equal(result.status, 'window_incomplete', name);
    assert.equal(result.range, null, name);
    assert.deepEqual(result.window.unusable_starts, [z('14:35')], name);
  }
  const bars = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45')];
  const t = tool(bars, { count: 9 });
  const result = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t.fetchBars, fetchCalendar: CAL, now: Date.parse(z('14:55')) });
  assert.equal(result.status, 'data_incomplete');
  assert.equal(result.range, null);
});

test('the saved Nov 18 NVDA bars through the real tool path still give 154.43 / 159.68 and the 15:15 bar', async () => {
  const { fetchBars } = tool(nvda.bars);
  const result = await getRangeConfirmation({ symbol: 'NVDA', window_start: START }, { fetchBars, fetchCalendar: CAL, now: Date.parse('2026-11-18T20:00:00Z') });
  assert.equal(result.range.high, 159.68);
  assert.equal(result.range.low, 154.43);
  assert.equal(result.first_confirming.put, '2026-11-18T15:15:00Z');
});

// Hermes round 2 (B-B03 session bounds): the close comes from the broker market calendar, never from a fixed 16:00 assumption.
test('early-close day: the calendar close bounds the fetch, post-close anchors read nothing, and after-close bars are ignored', async () => {
  const day = '2026-11-27'; // the day after Thanksgiving: 09:30 to 13:00 Eastern, 14:30Z to 18:00Z
  const zz = hhmm => `${day}T${hhmm}:00Z`;
  const mkd = (hhmm, o = {}) => ({ Timestamp: zz(hhmm), Open: 10, High: 10.5, Low: 9.5, Close: 10, Volume: 100, complete: true, ...o });
  const calendar = async () => ({ sessions: [{ date: day, open: '09:30', close: '13:00' }] });
  const bars = [mkd('14:30'), mkd('14:35'), mkd('14:40'), mkd('14:45', { High: 12, Close: 11, Volume: 500 }),
    mkd('18:05', { High: 12, Close: 11, Volume: 900 })]; // an after-close print the source returned anyway
  const t = tool(bars);
  const result = await getRangeConfirmation({ symbol: 'NVDA', window_start: zz('14:30') }, { fetchBars: t.fetchBars, fetchCalendar: calendar, now: Date.parse(`${day}T20:00:00Z`) });
  assert.equal(t.calls[0].end, zz('18:00'), 'the fetch ends at the 13:00 Eastern close, not 16:00');
  assert.equal(t.calls[0].start, zz('14:30'));
  assert.equal(result.status, 'ok');
  assert.ok(!result.confirmations.some(r => r.start === zz('18:05')), 'the after-close bar is not a candidate');
  assert.match(result.notes.join(' '), /1 bar\(s\) outside the regular session/);
  assert.equal(result.latest_complete_bar.start, zz('14:45'));
  // an anchor after the real close (but before the usual 16:00) is refused with no bar read
  for (const late of ['18:00', '18:30', '20:00']) {
    const none = tool([]);
    const refused = await getRangeConfirmation({ symbol: 'NVDA', window_start: zz(late) }, { fetchBars: none.fetchBars, fetchCalendar: calendar, now: Date.parse(`${day}T20:30:00Z`) });
    assert.equal(refused.status, 'invalid_input', late);
    assert.match(refused.error, /outside the regular session/);
    assert.equal(none.calls.length, 0, 'no bar read for an anchor after the close');
  }
});

test('the calendar is authoritative: no session row, an unavailable calendar, or a source count that includes bars outside the session', async () => {
  const none = tool([]);
  const holiday = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('15:00') }, { fetchBars: none.fetchBars, fetchCalendar: async () => ({ sessions: [{ date: '2026-11-19', open: '09:30', close: '16:00' }] }), now: Date.parse(z('15:30')) });
  assert.equal(holiday.status, 'invalid_input');
  assert.match(holiday.error, /no regular session for 2026-11-18/);
  const down = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('15:00') }, { fetchBars: none.fetchBars, fetchCalendar: async () => { throw new Error('503'); }, now: Date.parse(z('15:30')) });
  assert.equal(down.status, 'invalid_input');
  assert.match(down.error, /calendar is unavailable/);
  assert.equal(none.calls.length, 0);
  // the reported count still has to agree with what the source returned, before out-of-session bars are dropped
  const bars = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45'), { ...mk('13:00'), Timestamp: z('13:00') }]; // 13:00Z is pre-market
  const t = tool(bars, { count: 5 });
  const ok = await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: t.fetchBars, fetchCalendar: CAL, now: Date.parse(z('14:55')) });
  assert.equal(ok.status, 'ok');
  assert.match(ok.notes.join(' '), /1 bar\(s\) outside the regular session/);
  const bad = tool(bars, { count: 9 });
  assert.equal((await getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: bad.fetchBars, fetchCalendar: CAL, now: Date.parse(z('14:55')) })).status, 'data_incomplete');
});

// Hermes calendar verification (B-B03-C1): the reported count is checked against the RAW source rows, before out-of-session bars are dropped.
test('B-B03-C1: the reported count must equal the raw rows returned, whatever the session filter does', async () => {
  const bars = [mk('14:30'), mk('14:35'), mk('14:40'), mk('14:45'), mk('13:00')]; // five raw rows, four inside the session (13:00Z is pre-market)
  const run = async count => getRangeConfirmation({ symbol: 'NVDA', window_start: z('14:30') }, { fetchBars: tool(bars, { count }).fetchBars, fetchCalendar: CAL, now: Date.parse(z('14:55')) });
  const short = await run(4); // raw 5, reported 4, filtered 4: inconsistent source
  assert.equal(short.status, 'data_incomplete');
  assert.equal(short.range, null);
  const ok = await run(5); // raw 5, reported 5, filtered 4: consistent, one bar ignored with a note
  assert.equal(ok.status, 'ok');
  assert.ok(ok.range);
  assert.match(ok.notes.join(' '), /1 bar\(s\) outside the regular session/);
  const high = await run(9); // raw 5, reported 9
  assert.equal(high.status, 'data_incomplete');
  assert.equal(high.range, null);
});
