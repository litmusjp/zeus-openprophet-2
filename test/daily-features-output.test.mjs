import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { compactDailyFeatures } from '../agent/audit-capture.js';

// Run the REAL get_daily_features handler body from mcp-server.js against a representative Go reply.
const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
const caseStart = source.indexOf("case 'get_daily_features': {");
const caseEnd = source.indexOf("case 'get_option_expirations': {", caseStart);
assert.ok(caseStart >= 0 && caseEnd > caseStart, 'handler located');
const body = source.slice(caseStart, caseEnd).replace("case 'get_daily_features': {", '').trim().replace(/}\s*$/, '');
function invoke(args, reply) {
  return vm.runInNewContext(`(async (args) => {${body}})`, { callTradingBot: async () => reply, encodeURIComponent, JSON })(args);
}

const bar = (date, k = 0) => ({ date, open: 293.95 + k, high: 295.4 + k, low: 283.32 + k, close: 294.83 + k, volume: 8438738 + k });
function feature(symbol, i) {
  return {
    symbol, feed: 'sip', complete_bars: 70, last_complete_date: '2026-11-04',
    last: bar('2026-11-04', i), prior_session: bar('2026-11-03', i),
    sma20: 284.503 + i, sma20_slope_5_sessions_pct: 2.4651, last_close_vs_sma20_pct: 3.6298,
    high_prior_10_sessions: 298.74, low_prior_10_sessions: 278.01, high_prior_20_sessions: 298.74, low_prior_20_sessions: 264.09,
    avg_volume_prior_20_sessions: 5402240.05, last_volume_to_avg_ratio: 1.5621,
    low_vs_low_prior_20_sessions_pct: 7.2816, close_vs_high_prior_10_sessions_pct: -1.3091, close_vs_high_prior_20_sessions_pct: -1.3091,
    undercut_prior_session_low: false, close_above_open: true,
    recent_completed_bars: [0, 1, 2, 3, 4].map(k => bar(`2026-10-${28 + k}`, k)),
    notes: ['the forming session bar is excluded; the feed field says whether highs, lows and volume are consolidated (sip) or IEX-only (iex)'],
  };
}
const reply = {
  as_of: '2026-11-05T14:15:24Z', count: 25,
  basis: 'completed daily bars only; the session still forming is excluded; arithmetic facts, not signals. Each symbol states its feed (sip = consolidated market, iex = IEX only, whose highs, lows and volume can differ).',
  features: Array.from({ length: 25 }, (_, i) => feature(`SYM${i}`, i)),
};
reply.features[7] = { symbol: 'BAD', feed: 'sip', error: 'daily bars unavailable for this symbol' };

test('a 25-symbol get_daily_features reply is compact JSON well under the runtime inline cap', async () => {
  const result = await invoke({ symbols: reply.features.map(f => f.symbol) }, reply);
  const text = result.content[0].text;
  assert.equal(result.content[0].type, 'text');
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.ok(bytes < 40 * 1024, `reply is ${bytes} bytes, expected under 40 KB`);
  assert.ok(!text.includes('\n'), 'no indentation or newlines');
  const parsed = JSON.parse(text);
  assert.deepEqual(parsed, JSON.parse(JSON.stringify(reply)), 'every field, per-symbol error and feed is preserved');
  assert.equal(parsed.features[0].feed, 'sip');
  assert.equal(parsed.features[7].error, 'daily bars unavailable for this symbol');
  assert.equal(parsed.features[0].close_above_open, true);
  assert.equal(parsed.features[0].undercut_prior_session_low, false);
  // the old indented form of the same reply was over the cap, so this guards the regression
  assert.ok(Buffer.byteLength(JSON.stringify(reply, null, 2), 'utf8') > bytes * 1.4);
  // the audit compaction still parses it and keeps per-symbol feed and computed columns
  const compact = JSON.parse(compactDailyFeatures(text));
  assert.equal(compact.rows.length, 25);
  assert.equal(compact.rows[0][14], 'sip');
});
