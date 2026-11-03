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
