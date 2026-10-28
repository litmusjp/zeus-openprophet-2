import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { diagnoseHistoricalBarsRange, futureHistoricalBarsError } from '../historical-bars-time.js';

const now = '2026-10-28T13:30:00Z';

test('canonical UTC and equivalent local-offset historical bounds are preserved without warnings', () => {
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-10-28T13:29:00Z', now }), null);
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-10-28T09:29:00-04:00', now }), null);
});

test('future explicit offset gets an actionable UTC correction without changing the input', () => {
  const startDate = '2026-10-28T13:30:00-04:00';
  const diagnostic = diagnoseHistoricalBarsRange({ startDate, now });
  assert.match(diagnostic, /future/i);
  assert.match(diagnostic, /2026-10-28T17:30:00Z/);
  assert.match(diagnostic, /changing notation does not change the future instant/i);
  assert.match(diagnostic, /get_datetime.*iso_utc/i);
  assert.equal(startDate, '2026-10-28T13:30:00-04:00');
  const response = futureHistoricalBarsError(startDate, now);
  assert.equal(response.isError, true);
  assert.match(response.content[0].text, /2026-10-28T13:30:00-04:00/);
  assert.match(response.content[0].text, /2026-10-28T17:30:00Z/);
  assert.match(response.content[0].text, /2026-10-28T13:30:00Z/);
});

test('date-only New York trading dates keep their backend semantics', () => {
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-10-28', now }), null);
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-10-29', now }), null);
});

test('DST-sensitive explicit bounds are interpreted by their exact RFC3339 offsets', () => {
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-03-08T01:59:00-05:00', now: '2026-03-08T07:00:00Z' }), null);
  assert.equal(diagnoseHistoricalBarsRange({ startDate: '2026-03-08T03:01:00-04:00', now: '2026-03-08T07:02:00Z' }), null);
});

test('MCP branch returns the helper error and exposes its unambiguous UTC clock field', () => {
  const source = readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.match(source, /const diagnostic = futureHistoricalBarsError\(args\.start_date, new Date\(\)\.toISOString\(\)\);\s*if \(diagnostic\) return diagnostic;/);
  assert.match(source, /iso_utc: now\.toISOString\(\)/);
  assert.match(source, /Use iso_utc as the canonical UTC clock/);
});
