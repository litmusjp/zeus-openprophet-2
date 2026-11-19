import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { computeRangeConfirmation } from '../range-confirmation.js';
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
    bar(t(15), { Close: 11, Volume: 1000 }), // beyond the high, volume equal to the baseline: not above
    bar(t(20), { Close: 11, Volume: 1500 }), // beyond, above baseline
    bar(t(25), { Close: 8, Volume: 5000 }), // beyond the low, above baseline
    bar(t(30), { Close: 10, Volume: 9000 }), // inside the range: no direction
    bar(t(35), { Close: 11, Volume: 100, complete: false }), // still forming: ignored entirely
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
  const long = [bar(t(0)), bar(t(5)), bar(t(10)), bar(t(15)), bar(t(20)), bar(t(25)), bar(t(30), { Close: 11, Volume: 2000 })];
  assert.equal(computeRangeConfirmation({ bars: long, windowStart: START }).confirmations.at(-1).baseline_bars, 6);
});

test('a session of more than 40 bars: the tool sees every bar while the saved audit record keeps the tail and flags the omission', () => {
  const bars = Array.from({ length: 73 }, (_, i) => bar(t(i * 5), i === 20 ? { Close: 11, Volume: 5000 } : {}));
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
