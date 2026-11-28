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
    undercut_prior_session_low: false, close_above_open: true, sma200: 95.5, last_close_vs_sma200_pct: 6.81,
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
  assert.deepEqual(compact.columns.slice(14), ['feed', 'low_vs_low20_prior_pct', 'close_vs_high10_prior_pct', 'close_vs_high20_prior_pct', 'undercut_prior_low', 'close_above_open', 'sma200', 'close_vs_sma200_pct']);
  assert.deepEqual(compact.rows[0].slice(14), ['iex', 7.61, 0.99, -1.92, false, true, 95.5, 6.81]);
  // F5: sma200 columns are appended at the very end; no earlier index moved
  assert.equal(compact.columns.indexOf('sma200'), compact.columns.length - 2);
  assert.equal(compact.rows[0][12], 1.04);
  assert.equal(compact.rows[3][14], 'iex');
  assert.deepEqual(compact.rows[3].slice(15), [null, null, null, null, null, null, null]);
  assert.equal(compact.rows[0].length, compact.columns.length);
  assert.ok(JSON.stringify(compact).length < 9000);
  assert.equal(compactDailyFeatures('not json'), null);
});

// ---- F5: bounded audit forms for the persisted audit event only ----
import { AgentHarness } from '../agent/harness.js';
import { compactAuditDraft, fitAuditEvent, cropText, boundAuditArgs, AUDIT_RECORD_CAP_BYTES, AUDIT_ENVELOPE_RESERVE_BYTES } from '../agent/audit-capture.js';

const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8');

function runTool(tool, input, output, state = {}) {
  const harness = new AgentHarness();
  const events = [];
  const emitted = [];
  const origEmit = harness.state.emit.bind(harness.state);
  harness.state.emit = (name, payload) => { emitted.push([name, payload]); return origEmit(name, payload); };
  const ctx = { addToolCall() {}, recordToolEvent: e => events.push(e), addText() {}, setSession() {}, addCost() {}, addTokens() {} };
  harness._handleOpenCodeEvent({ type: 'tool_use', callID: 'c1', part: { id: 'p1', tool: `prophet_${tool}`, state: { input, output, status: 'completed', ...state } } }, ctx);
  assert.equal(events.length, 1);
  return { event: events[0], emitted };
}
const withEnvelope = event => ({ ...event, activityId: 'a'.repeat(36), origin: 'Heartbeat' });
const assertWithinCap = event => assert.ok(bytes(withEnvelope(event)) <= AUDIT_RECORD_CAP_BYTES, `record is ${bytes(withEnvelope(event))} bytes`);

const contract = i => ({
  Symbol: `SPY261204C${String(500000 + i * 1000).padStart(8, '0')}`, UnderlyingSymbol: 'SPY', ContractType: i % 2 ? 'put' : 'call', StrikePrice: 500 + i,
  ExpirationDate: '2026-12-04T00:00:00Z', Premium: 1.5, Bid: 1.4, Ask: 1.6, BidSize: 10, AskSize: 12, QuoteTimestamp: '2026-11-30T15:00:00Z',
  VolumeKnown: true, Volume: 100, OpenInterest: 50, OpenInterestPresent: true, ImpliedVolatility: 0.2, Delta: 0.31, Gamma: 0.1, Theta: -0.1, Vega: 0.2, DTE: 4,
  market_data_feed: 'indicative', market_data_quality: 'indicative',
});

test('malformed or non-object results fall back: no draft, the existing 1200-character clip stays', () => {
  for (const tool of ['get_market_snapshot', 'get_options_chain', 'get_alpaca_news', 'get_range_confirmation', 'get_datetime']) {
    assert.equal(compactAuditDraft(tool, '{"contracts":[{"Symbol":"x"', {}), null);
    assert.equal(compactAuditDraft(tool, 'plain text error', {}), null);
    assert.equal(compactAuditDraft(tool, '[1,2,3]', {}), null);
  }
  assert.equal(compactAuditDraft('get_account', '{"a":1}', {}), null);
  const broken = `{"contracts":[${'{"Symbol":"A"},'.repeat(200)}`; // malformed and longer than 1200
  const { event } = runTool('get_options_chain', { symbol: 'SPY' }, broken);
  assert.equal(event.result, broken.substring(0, 1200));
  assert.equal(event.resultTruncated, true);
});

test('huge options chain: parseable, within the byte cap, per-contract fields kept, marked partial', () => {
  const contracts = Array.from({ length: 4000 }, (_, i) => contract(i));
  contracts[1] = { ...contracts[1], Delta: undefined, ImpliedVolatility: undefined, BidSize: undefined };
  const output = JSON.stringify({ status: 'available', symbol: 'SPY', expiration: '2026-12-04', total: 4000, filtered: 4000, contracts }, null, 2);
  const { event } = runTool('get_options_chain', { symbol: 'SPY', expiration: '2026-12-04', type: 'call' }, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.compact, 'options_chain');
  assert.equal(r.partial, true); assert.equal(r.truncated, true);
  assert.equal(r.total_rows, 4000); assert.equal(r.returned_rows + r.omitted_rows, 4000); assert.equal(r.rows.length, r.returned_rows);
  assert.ok(r.returned_rows > 50);
  assert.equal(r.feed, 'indicative'); assert.equal(r.total, 4000); assert.deepEqual(r.query, { symbol: 'SPY', expiration: '2026-12-04', type: 'call' });
  assert.deepEqual(r.columns.slice(0, 5), ['occ', 'type', 'strike', 'expiry', 'bid']);
  assert.deepEqual(r.rows[0], ['SPY261204C00500000', 'call', 500, '2026-12-04', 1.4, 1.6, 10, 12, '2026-11-30T15:00:00Z', 'indicative', 'indicative', 0.31, 0.2, []]);
  assert.deepEqual(r.rows[1].at(-1), ['bid_size', 'delta', 'iv']); // missing-value state, not a silent zero
  assert.equal(r.rows[1][6], null); assert.equal(r.rows[1][11], null);
  assert.equal(event.resultTruncated, true); assert.equal(event.resultLength, output.length);
});

test('a small chain is kept complete: not partial, every row present', () => {
  const output = JSON.stringify({ status: 'available', symbol: 'SPY', expiration: '2026-12-04', total: 12, filtered: 12, contracts: Array.from({ length: 12 }, (_, i) => contract(i)) }, null, 2);
  const { event } = runTool('get_options_chain', { symbol: 'SPY' }, output);
  const r = JSON.parse(event.result);
  assert.equal(r.partial, false); assert.equal(r.truncated, false); assert.equal(r.rows.length, 12); assert.equal(r.omitted_rows, 0);
  assert.equal(event.resultTruncated, undefined);
});

test('news: id, symbols, created_at and updated_at kept, headline capped at 200 characters, pagination kept; multibyte safe', () => {
  const emoji = '\u{1F600}';
  const long = `${'日本語'.repeat(150)}`;           // 450 CJK characters
  const surrogates = emoji.repeat(300);                          // 300 code points, 600 UTF-16 units
  const articles = Array.from({ length: 60 }, (_, i) => ({
    id: 9000 + i, headline: i === 0 ? long : i === 1 ? surrogates : `Headline ${i} ${'x'.repeat(400)}`, source: 'benzinga', symbols: ['AAPL', 'MSFT'],
    created_at: '2026-11-30T14:00:00Z', updated_at: '2026-11-30T14:05:00Z', summary: 'S'.repeat(500), url: 'https://example.test/a',
  }));
  const output = JSON.stringify({ provider: 'alpaca', status: 'available', symbols: ['AAPL'], window_start: 'w0', window_end: 'w1', fetched_at: '2026-11-30T14:10:00Z',
    limit: 60, count: 60, has_more: true, next_page_token: 'tok123', duplicates_removed: 0, articles, note: 'n'.repeat(300) });
  const { event } = runTool('get_alpaca_news', { symbols: ['AAPL'], limit: 60 }, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.compact, 'alpaca_news'); assert.equal(r.provider, 'alpaca'); assert.equal(r.has_more, true); assert.equal(r.next_page_token, 'tok123');
  assert.equal(r.as_of, '2026-11-30T14:10:00Z'); assert.deepEqual(r.query, { symbols: ['AAPL'], limit: 60 });
  assert.deepEqual(r.rows[2].slice(0, 4), [9002, ['AAPL', 'MSFT'], '2026-11-30T14:00:00Z', '2026-11-30T14:05:00Z']);
  assert.equal(Array.from(r.rows[0][4]).length, 200);
  assert.ok(r.rows[0][4].endsWith('…'));
  assert.equal(Array.from(r.rows[1][4]).length, 200);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.rows[1][4]), 'no half surrogate pair');
  assert.ok(r.rows[2][4].length <= 200);
  assert.equal(JSON.stringify(r), JSON.stringify(JSON.parse(JSON.stringify(r))));
  assert.equal(cropText('abc', 200), 'abc');
});

test('news with many multibyte headlines is bounded by UTF-8 bytes, not characters', () => {
  const articles = Array.from({ length: 400 }, (_, i) => ({ id: i, headline: '日'.repeat(220), symbols: ['AAPL'], created_at: 'c', updated_at: 'u' }));
  const output = JSON.stringify({ provider: 'alpaca', status: 'available', count: 400, has_more: false, articles });
  const { event } = runTool('get_alpaca_news', {}, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.partial, true); assert.ok(r.returned_rows < 400); assert.equal(r.returned_rows + r.omitted_rows, 400); assert.equal(r.has_more, false);
});

test('market snapshot keeps every ^VIX history row with complete, calendar status, unavailable list and each index prev_close_date', () => {
  const history = Array.from({ length: 70 }, (_, i) => ({ date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, close: 15 + i / 10, complete: i < 69 }));
  const quote = (symbol, extra = {}) => ({ symbol, name: symbol, price: 100, prev_close: 99, prev_close_date: '2026-11-27', prev_close_available: true, prev_close_source: 'history', change_available: true, change: 1, change_pct: 1.01, currency: 'USD', exchange: 'X', ...extra });
  const output = JSON.stringify({ source: 'yahoo', timestamp: '2026-11-30T15:00:00Z', indexes: [quote('^GSPC'), quote('^IXIC', { prev_close_date: '2026-11-27' })], rates: [], commodities: [quote('GC=F')], crypto: [],
    volatility: [quote('^VIX', { calendar_status: 'ok', history })], unavailable: ['^TNX'] }, null, 2);
  const { event } = runTool('get_market_snapshot', {}, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.history_rows.length, 70); assert.equal(r.partial, false); assert.equal(r.vix_calendar_status, 'ok'); assert.deepEqual(r.unavailable, ['^TNX']);
  assert.deepEqual(r.history_rows.at(-1), ['^VIX', '2026-09-14', 15 + 69 / 10, false]);
  assert.deepEqual(r.history_rows[0].slice(0, 2), ['^VIX', '2026-09-01']);
  const idx = r.quotes.filter(q => q[0] === 'indexes');
  assert.deepEqual(idx.map(q => [q[1], q[4]]), [['^GSPC', '2026-11-27'], ['^IXIC', '2026-11-27']]);
  assert.equal(r.as_of, '2026-11-30T15:00:00Z'); assert.equal(r.provider, 'yahoo');
});

test('an oversized ^VIX history drops the oldest whole rows first and says so', () => {
  const history = Array.from({ length: 5000 }, (_, i) => ({ date: `2026-01-01#${i}`, close: i, complete: true }));
  const output = JSON.stringify({ source: 'yahoo', timestamp: 't', indexes: [], rates: [], commodities: [], crypto: [], volatility: [{ symbol: '^VIX', price: 1, history }] });
  const { event } = runTool('get_market_snapshot', {}, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.partial, true); assert.equal(r.history_rows.at(-1)[2], 4999); assert.equal(r.history_rows.length + r.omitted_rows, 5000);
});

test('error responses: failure status is kept in a bounded parseable form; short ones stay raw', () => {
  const error = JSON.stringify({ status: 'unavailable', category: 'provider_unavailable', endpoint: 'options_chain', upstream_status: 503, attempts: 3, error: 'e'.repeat(3000) });
  const { event } = runTool('get_options_chain', { symbol: 'SPY' }, error);
  const r = JSON.parse(event.result);
  assert.equal(r.failure.status, 'unavailable'); assert.equal(r.failure.category, 'provider_unavailable'); assert.equal(r.failure.upstream_status, 503);
  assert.ok(r.failure.error.length <= 400); assert.equal(r.rows.length, 0);
  assertWithinCap(event);
  const short = JSON.stringify({ status: 'unavailable', category: 'provider_unavailable', endpoint: 'news' });
  assert.equal(runTool('get_alpaca_news', {}, short).event.result, short);
  const refusal = JSON.stringify({ status: 'invalid_input', error: 'x'.repeat(2500) });
  const rr = JSON.parse(runTool('get_range_confirmation', { symbol: 'NVDA' }, refusal).event.result);
  assert.equal(rr.failure.status, 'invalid_input');
});

test('huge args are cropped for the audit record only and the record stays within the cap', () => {
  const symbols = Array.from({ length: 5000 }, (_, i) => `SYM${i}`);
  const input = { symbols, note: '日'.repeat(100000) };
  const output = JSON.stringify({ provider: 'alpaca', status: 'available', count: 3, has_more: false, articles: Array.from({ length: 3 }, (_, i) => ({ id: i, headline: 'h'.repeat(500), symbols: ['A'], created_at: 'c', updated_at: 'u' })) });
  const before = JSON.stringify(input);
  const { event } = runTool('get_alpaca_news', input, output);
  assertWithinCap(event);
  assert.equal(event.argsPartial, true); assert.ok(event.argsOriginalBytes > 100000);
  assert.equal(JSON.stringify(input), before); // execution input untouched
  JSON.parse(event.result);
  const small = boundAuditArgs({ a: 1 });
  assert.deepEqual(small, { args: { a: 1 }, partial: false });
});

test('range confirmation with a very long bar list stays bounded and keeps the latest bars and first_confirming', () => {
  const confirmations = Array.from({ length: 2000 }, (_, i) => ({ start: `s${i}`, end: `e${i}`, close: 100 + i, volume: 1000, baseline_volume: 900, baseline_bars: 6, direction: 'call', volume_above_baseline: true, confirming: true }));
  const output = JSON.stringify({ status: 'ok', symbol: 'NVDA', feed: 'sip', timeframe: '5Min', anchor: 'a', anchor_requested: 'ar', anchor_used: 'au', window_minutes: 15, window_end_exclusive: 'we', supplied_bars: 2010,
    range: { high: 130, low: 120, midpoint: 125, height: 10, bar_starts: ['x', 'y', 'z'] }, window: { expected_bars: 3, usable_bars: 3, missing_starts: [], incomplete_starts: [], unusable_starts: [] },
    confirmations, first_confirming: { call: 's0', put: null }, latest_complete_bar: { start: 's1999', end: 'e1999' }, notes: ['n'.repeat(2000)] });
  const { event } = runTool('get_range_confirmation', { symbol: 'NVDA', window_start: '2026-11-30T14:30:00Z', window_minutes: 15 }, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.partial, true); assert.equal(r.confirmation_rows.at(-1)[0], 's1999'); assert.deepEqual(r.first_confirming, { call: 's0', put: null });
  assert.equal(r.range.high, 130); assert.equal(r.query.anchor_used, 'au'); assert.equal(r.feed, 'sip');
  assert.ok(r.notes[0].length <= 300);
});

test('get_datetime keeps the session fields and long_gap in the audit form', () => {
  const output = JSON.stringify({ time: '10:00:00 AM', time_24h: '10:00:00', date: 'Friday, November 27, 2026', iso_date: '2026-11-27', day_of_week: 'Friday', timezone: 'America/New_York', iso: '2026-11-27T15:00:00.000Z', iso_utc: '2026-11-27T15:00:00.000Z',
    unix: 1, is_weekday: true, local_is_market_holiday_estimate: false, market_status: 'OPEN', markets_open_today: true, market_status_source: 'alpaca_clock', session_time_et: '10:00', session_open_et: '09:30', session_close_et: '13:00',
    session_open_utc: '2026-11-27T14:30:00Z', session_close_utc: '2026-11-27T18:00:00Z', minutes_since_open: 30, minutes_to_close: 180,
    long_gap: { follows_session: true, single_leg_cutoff_utc: '2026-11-27T16:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' }, long_gap_note: 'note',
    session_fields_error: null, broker_clock: { timestamp: '2026-11-27T10:00:00-05:00', is_open: true, next_open: '2026-11-30T09:30:00-05:00', next_close: '2026-11-27T13:00:00-05:00' }, broker_clock_error: null,
    pad: 'p'.repeat(1500) }, null, 2);
  const { event } = runTool('get_datetime', {}, output);
  assertWithinCap(event);
  const r = JSON.parse(event.result);
  assert.equal(r.compact, 'datetime'); assert.equal(r.partial, false); assert.equal(r.minutes_to_close, 180); assert.equal(r.session_close_utc, '2026-11-27T18:00:00Z');
  assert.deepEqual(r.long_gap, { follows_session: true, single_leg_cutoff_utc: '2026-11-27T16:00:00Z', single_leg_open_allowed: true, status: 'long_gap_follows' });
  assert.equal(r.broker_clock.next_open, '2026-11-30T09:30:00-05:00');
});

test('model-facing output and execution inputs are byte-for-byte unchanged by audit compaction', () => {
  const contracts = Array.from({ length: 3000 }, (_, i) => contract(i));
  const output = JSON.stringify({ status: 'available', symbol: 'SPY', total: 3000, filtered: 3000, contracts }, null, 2);
  const input = { symbol: 'SPY', expiration: '2026-12-04', authorization_note: 'Bearer abc.def', nested: { list: [1, 2, 3] } };
  const inputBefore = JSON.stringify(input);
  const outputBefore = String(output);
  const part = { id: 'p1', tool: 'prophet_get_options_chain', state: { input, output, status: 'completed' } };
  const harness = new AgentHarness();
  const events = []; const emitted = [];
  const orig = harness.state.emit.bind(harness.state);
  harness.state.emit = (name, payload) => { emitted.push([name, payload]); return orig(name, payload); };
  const ctx = { addToolCall() {}, recordToolEvent: e => events.push(e), addText() {}, setSession() {}, addCost() {}, addTokens() {} };
  harness._handleOpenCodeEvent({ type: 'tool_use', callID: 'c', part }, ctx);
  assert.equal(part.state.output, outputBefore);
  assert.equal(Buffer.compare(Buffer.from(part.state.output), Buffer.from(outputBefore)), 0);
  assert.equal(part.state.input, input);
  assert.equal(JSON.stringify(part.state.input), inputBefore);
  assert.equal(emitted.find(([n]) => n === 'tool_call')[1].args, input);          // the live tool_call event carries the very same input object
  assert.equal(emitted.find(([n]) => n === 'tool_result')[1].result, outputBefore.substring(0, 500));
  assert.equal(JSON.parse(events[0].result).compact, 'options_chain');            // only the persisted audit copy is compact
  assert.ok(events[0].args.authorization_note.includes('[REDACTED]'));            // redaction still applies to the audit copy
  assert.ok(JSON.stringify(input).includes('Bearer abc.def'));                    // and never to the real input
});

test('tools outside the bounded list keep their existing capture; critical tools keep the 128 KB limit', () => {
  const output = JSON.stringify({ x: 'y'.repeat(3000) });
  const { event } = runTool('get_news', {}, output);
  assert.equal(event.result, output.substring(0, 1200)); assert.equal(event.resultTruncated, true);
  const crit = runTool('get_account', {}, 'z'.repeat(5000));
  assert.equal(crit.event.result.length, 5000);
});

test('fitAuditEvent never exceeds the cap even when the header itself is oversized', () => {
  const draft = { head: { compact: 'options_chain', provider: null, feed: null, as_of: null, status: 'available', blob: 'b'.repeat(60000) }, rowsKey: 'rows', rows: [[1], [2]], keep: 'head' };
  const fitted = fitAuditEvent({ tool: 'get_options_chain', args: { a: 1 }, result: 'x' }, draft);
  assert.ok(bytes(fitted) <= AUDIT_RECORD_CAP_BYTES - AUDIT_ENVELOPE_RESERVE_BYTES);
  const r = JSON.parse(fitted.result);
  assert.equal(r.partial, true); assert.equal(r.omitted_rows, 2);
});
