import test from 'node:test';
import assert from 'node:assert/strict';

import { compactHistoricalBars } from '../agent/audit-capture.js';

test('oversized historical bars keep a compact decision table including completeness', () => {
  const bars = Array.from({ length: 60 }, (_, i) => ({
    Symbol: 'SPY', Timestamp: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T04:00:00Z`,
    Open: 700 + i, High: 701 + i, Low: 699 + i, Close: 700.5 + i, Volume: 1000 + i, VWAP: 700, complete: i < 59,
  }));
  const text = JSON.stringify({ symbol: 'SPY', timeframe: '1Day', feed: 'iex', count: 60, bars }, null, 2);
  const compact = JSON.parse(compactHistoricalBars(text));
  assert.equal(compact.compact, 'historical_bars');
  assert.equal(compact.count, 60);
  assert.equal(compact.returned_rows, 40);
  assert.deepEqual(compact.rows.at(-1).slice(1), [759, 760, 758, 759.5, 1059, false]);
  assert.ok(JSON.stringify(compact).length < 6000);
});

test('non-bar or unparsable results are not compacted', () => {
  assert.equal(compactHistoricalBars('not json'), null);
  assert.equal(compactHistoricalBars('{"error":"x"}'), null);
});

test('daily features keep every symbol\'s decisive numbers in a compact table', async () => {
  const { compactDailyFeatures } = await import('../agent/audit-capture.js');
  const features = Array.from({ length: 25 }, (_, i) => ({
    symbol: `S${i}`, feed: 'iex', last_complete_date: '2026-11-03',
    last: { open: 100, high: 103, low: 99, close: 102, volume: 5000 + i }, prior_session: { low: 98.5, close: 100 },
    sma20: 99.1, sma20_slope_5_sessions_pct: 0.4, last_close_vs_sma20_pct: 2.9,
    high_prior_10_sessions: 101, low_prior_10_sessions: 95, high_prior_20_sessions: 104, low_prior_20_sessions: 92,
    avg_volume_prior_20_sessions: 4800, last_volume_to_avg_ratio: 1.04,
    low_vs_low_prior_20_sessions_pct: 7.61, close_vs_high_prior_10_sessions_pct: 0.99, close_vs_high_prior_20_sessions_pct: -1.92,
    undercut_prior_session_low: false, close_above_open: true,
    recent_completed_bars: Array.from({ length: 5 }, () => ({ date: 'x', open: 1, high: 1, low: 1, close: 1, volume: 1 })),
    notes: ['volume is IEX-feed volume, not consolidated; the forming session bar is excluded'],
  }));
  features[3] = { symbol: 'BAD', feed: 'iex', error: 'daily bars unavailable for this symbol' };
  const text = JSON.stringify({ as_of: '2026-11-04T14:15:00Z', feed: 'iex', count: 25, features }, null, 2);
  const compact = JSON.parse(compactDailyFeatures(text));
  assert.equal(compact.compact, 'daily_features');
  assert.equal(compact.rows.length, 25);
  assert.equal(compact.rows[0][0], 'S0');
  assert.deepEqual(compact.rows[0][2], [100, 103, 99, 102, 5000]);
  assert.equal(compact.rows[0][12], 1.04);
  assert.equal(compact.rows[3][0], 'BAD');
  assert.match(compact.rows[3][13], /unavailable/);
  // per-symbol feed and the computed distances/flags are retained (appended columns)
  assert.deepEqual(compact.columns.slice(14), ['feed', 'low_vs_low20_prior_pct', 'close_vs_high10_prior_pct', 'close_vs_high20_prior_pct', 'undercut_prior_low', 'close_above_open']);
  assert.deepEqual(compact.rows[0].slice(14), ['iex', 7.61, 0.99, -1.92, false, true]);
  assert.equal(compact.rows[3][14], 'iex');
  assert.deepEqual(compact.rows[3].slice(15), [null, null, null, null, null]);
  assert.equal(compact.rows[0].length, compact.columns.length);
  assert.ok(JSON.stringify(compact).length < 9000);
  assert.equal(compactDailyFeatures('not json'), null);
});
