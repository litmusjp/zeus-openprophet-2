import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { AgentHarness } from '../agent/harness.js';
import { DEFAULT_TRADING_GUIDANCE, openingGateMinutesFor, renderTradingGuidance } from '../agent/trading-guidance.js';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';
import { ordersFrom, isOptionExitOrder, buildPostCancelCheck, unverifiedPostCancelCheck } from '../cancel-check.js';

const source = await fsp.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');

function caseBody(start, endMarker) {
  const begin = source.indexOf(start);
  const end = source.indexOf(endMarker, begin + start.length);
  assert.ok(begin >= 0 && end > begin, start);
  return source.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
const helpers = { JSON, Number, Math, Date, Intl, Promise, Array, Object, String, Boolean, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, ordersFrom, isOptionExitOrder, buildPostCancelCheck, unverifiedPostCancelCheck };
const run = (body, ctx) => vm.runInNewContext(`(async (args) => {${body}})`, { ...helpers, ...ctx });

const SESSION = [{ date: '2026-11-12', open: '09:30', close: '16:00' }];
const calendarAt = timestamp => ({ clock: { timestamp, is_open: true, next_open: '2026-11-13T09:30:00-05:00', next_close: '2026-11-12T16:00:00-05:00' }, sessions: SESSION });
const SYM = 'COST261120C01100000';
const orderArgs = { symbol: SYM, underlying: 'COST', quantity: 2, side: 'buy', order_type: 'limit', position_intent: 'buy_to_open', limit_price: 10, client_order_id: 'c1', thesis: 't' };

function placeRunner({ now, env, calls }) {
  return run(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), {
    process: { env },
    capSyncAllowsOpening: async () => true, // the cap guard has its own tests (nov15-cap-unresolved)
    isOpeningIntent: p => typeof p !== 'string' || !p || p.includes('open'),
    autoStoreSetup: () => {},
    orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    callTradingBot: async (endpoint, ...rest) => {
      calls.push([endpoint, ...rest]);
      if (endpoint === '/calendar') return calendarAt(now);
      return { status: 'accepted' };
    },
  });
}

// ── A3: opening gate in place_options_order ───────────────────────────────────────────────────
test('A3: with a gate of 15, an opening at minute 14 is refused before any order call', async () => {
  const calls = [];
  const out = await placeRunner({ now: '2026-11-12T09:44:59-05:00', env: { OPENPROPHET_MIN_OPENING_MINUTES: '15' }, calls })({ ...orderArgs });
  assert.equal(out.isError, true);
  const body = JSON.parse(out.content[0].text);
  assert.equal(body.code, 'OPENING_RANGE_NOT_COMPLETE');
  assert.equal(body.minutes_since_open, 14);
  assert.equal(body.minimum_minutes_after_open, 15);
  assert.equal(body.execution_confirmed, false);
  assert.deepEqual(calls.map(c => c[0]), ['/calendar'], 'no /options/order call');
});

test('A3: the 9:41 AVGO moment (order sent 14:41:36Z) is refused, 9:45:00 is allowed', async () => {
  const refusedCalls = [];
  const refused = await placeRunner({ now: '2026-11-12T14:41:36Z', env: { OPENPROPHET_MIN_OPENING_MINUTES: '15' }, calls: refusedCalls })({ ...orderArgs });
  assert.equal(refused.isError, true);
  const okCalls = [];
  const ok = await placeRunner({ now: '2026-11-12T09:45:00-05:00', env: { OPENPROPHET_MIN_OPENING_MINUTES: '15' }, calls: okCalls })({ ...orderArgs });
  assert.equal(ok.isError, undefined);
  assert.equal(okCalls.at(-1)[0], '/options/order');
});

test('A3: unavailable clock refuses an opening; a reducing order is never gated', async () => {
  const calls = [];
  const noClock = run(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), {
    process: { env: { OPENPROPHET_MIN_OPENING_MINUTES: '15' } },
    capSyncAllowsOpening: async () => true, // the cap guard has its own tests (nov15-cap-unresolved)
    isOpeningIntent: p => p.includes('open'), autoStoreSetup: () => {}, orderResponse: d => ({ content: [{ type: 'text', text: JSON.stringify(d) }] }),
    callTradingBot: async endpoint => { calls.push(endpoint); if (endpoint === '/calendar') throw new Error('down'); return { status: 'accepted' }; },
  });
  assert.equal((await noClock({ ...orderArgs })).isError, true);
  const sell = await noClock({ ...orderArgs, side: 'sell', position_intent: 'sell_to_close' });
  assert.equal(sell.isError, undefined, 'sell_to_close at any time goes through');
  assert.equal(calls.at(-1), '/options/order');
});

test('A3: no environment value means no gate and no calendar call (Prophet and Guardian unchanged)', async () => {
  for (const env of [{}, { OPENPROPHET_MIN_OPENING_MINUTES: '' }, { OPENPROPHET_MIN_OPENING_MINUTES: 'junk' }]) {
    const calls = [];
    const out = await placeRunner({ now: '2026-11-12T09:35:00-05:00', env, calls })({ ...orderArgs });
    assert.equal(out.isError, undefined);
    assert.deepEqual(calls.map(c => c[0]), ['/options/order']);
  }
});

test('A3: the minimum cannot be set or lowered through tool arguments', async () => {
  const calls = [];
  const out = await placeRunner({ now: '2026-11-12T09:35:00-05:00', env: { OPENPROPHET_MIN_OPENING_MINUTES: '15' }, calls })({ ...orderArgs, min_opening_minutes: 0, OPENPROPHET_MIN_OPENING_MINUTES: '0', minimum_minutes_after_open: 0 });
  assert.equal(out.isError, true);
  assert.equal(JSON.parse(out.content[0].text).code, 'OPENING_RANGE_NOT_COMPLETE');
});

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
  proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
  queueMicrotask(() => { proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`); proc.emit('exit', 0, null); proc.emit('close', 0, null); });
  return proc;
}
async function spawnedEnv(strategyId, parentEnv = {}) {
  let captured;
  const harness = new AgentHarness({ opencodeEnv: { ...parentEnv }, spawnFn: (_c, _a, options) => { captured = options.env; return fakeProcess(); } });
  harness._agentConfig = strategyId === undefined ? null : { id: 'x', strategyId };
  await harness._runClaude('prompt', 'opencode/big-pickle');
  return captured;
}

test('A3: the harness sets the minimum for the news-catalyst strategy only, and overrides inherited values', async () => {
  assert.equal((await spawnedEnv('catalyst-news')).OPENPROPHET_MIN_OPENING_MINUTES, String(DEFAULT_TRADING_GUIDANCE.catalystRangeMinutes));
  for (const strategyId of ['default', 'equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'unknown-thing', undefined]) {
    assert.equal((await spawnedEnv(strategyId)).OPENPROPHET_MIN_OPENING_MINUTES, '', String(strategyId));
  }
  assert.equal((await spawnedEnv('default', { OPENPROPHET_MIN_OPENING_MINUTES: '15' })).OPENPROPHET_MIN_OPENING_MINUTES, '', 'inherited value cannot turn the gate on');
  assert.equal(openingGateMinutesFor('catalyst-news', { catalystRangeMinutes: 15 }), '15');
  assert.equal(openingGateMinutesFor('default', { catalystRangeMinutes: 15 }), '');
});

// ── A1: get_datetime ──────────────────────────────────────────────────────────────────────────
function datetimeRunner(calendarOrError, clockFallback) {
  const calls = [];
  const fn = run(caseBody("case 'get_datetime': {", "// Vector DB: Find similar trading setups"), {
    callTradingBot: async endpoint => {
      calls.push(endpoint);
      if (endpoint === '/calendar') { if (calendarOrError instanceof Error) throw calendarOrError; return calendarOrError; }
      if (endpoint === '/clock') { if (clockFallback instanceof Error) throw clockFallback; return clockFallback; }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  return { fn, calls };
}

test('A1: get_datetime returns ET session fields from the broker calendar and keeps the old fields', async () => {
  const { fn } = datetimeRunner(calendarAt('2026-11-12T16:00:09Z'));
  const out = JSON.parse((await fn({})).content[0].text);
  assert.equal(out.session_time_et, '11:00');
  assert.equal(out.minutes_since_open, 90);
  assert.equal(out.minutes_to_close, 299);
  assert.equal(out.session_open_et, '09:30');
  assert.equal(out.session_close_et, '16:00');
  assert.equal(out.session_fields_error, null);
  assert.equal(out.market_status, 'OPEN');
  assert.equal(out.broker_clock.is_open, true);
  for (const key of ['time', 'time_24h', 'date', 'iso_date', 'timezone', 'iso_utc', 'unix', 'market_status_source', 'broker_clock_error']) assert.ok(key in out, key);
});

test('A1: calendar failure falls back to /clock with null minutes and an error note; both failing keeps the old error', async () => {
  const clock = { timestamp: '2026-11-12T16:00:09Z', is_open: true };
  const { fn, calls } = datetimeRunner(new Error('calendar down'), clock);
  const out = JSON.parse((await fn({})).content[0].text);
  assert.deepEqual(calls, ['/calendar', '/clock']);
  assert.equal(out.minutes_since_open, null);
  assert.equal(out.session_time_et, '11:00');
  assert.equal(out.session_fields_error, 'calendar down');
  assert.equal(out.market_status, 'OPEN');
  const both = JSON.parse((await datetimeRunner(new Error('calendar down'), new Error('clock down')).fn({})).content[0].text);
  assert.equal(both.market_status, 'BROKER_CLOCK_UNAVAILABLE');
  assert.equal(both.broker_clock_error, 'clock down');
  assert.equal(both.minutes_since_open, null);
});

// ── A2: cancel_order follow-up (real DTO shapes: wrapped /orders, Go field names) ─────────────
function cancelRunner({ open, all, positions, failAfter = false, failBefore = false, hangBefore = false }) {
  const calls = [];
  const fn = run(caseBody("case 'cancel_order': {", "case 'get_quote': {"), {
    setTimeout, clearTimeout,
    callTradingBot: async (endpoint, method = 'GET') => {
      calls.push(`${method} ${endpoint}`);
      if (method === 'DELETE') return { message: 'Order canceled successfully' };
      if (endpoint === '/orders?status=open') { if (hangBefore) return new Promise(() => {}); if (failBefore) throw new Error('read failed'); return open; }
      if (endpoint === '/orders?status=all') { if (failAfter) throw new Error('read failed'); return all; }
      if (endpoint === '/options/positions') { if (failAfter) throw new Error('read failed'); return positions; }
      throw new Error(`unexpected ${endpoint}`);
    },
  });
  return { fn, calls };
}
const goOrder = (over = {}) => ({ ID: 'A1', ClientOrderID: 'c1', Symbol: SYM, Qty: 4, Side: 'sell', Type: 'limit', Status: 'new', FilledQty: 0, AssetClass: 'us_option', PositionIntent: 'sell_to_close', ...over });
const wrapped = (orders, over = {}) => ({ orders, complete: true, broker_state: 'available', ...over });
const goPos = (qty, symbol = SYM) => ({ Symbol: symbol, Qty: qty, Side: 'long' });

test('A2: cancelling an option exit with the position still held adds post_cancel_check with the verified remainder', async () => {
  const { fn } = cancelRunner({ open: wrapped([goOrder()]), all: wrapped([goOrder({ Status: 'canceled', FilledQty: 1 })]), positions: [goPos(3)] });
  const out = JSON.parse((await fn({ order_id: 'A1' })).content[0].text);
  assert.equal(out.message, 'Order canceled successfully');
  assert.equal(out.post_cancel_check.verified, true);
  assert.equal(out.post_cancel_check.held_qty_after_cancel, 3);
  assert.match(out.post_cancel_check.note, /replace only the 3 verified/);
});

test('A2: no advice when another working exit covers it, or the position is gone', async () => {
  const covered = JSON.parse((await cancelRunner({ open: wrapped([goOrder()]), all: wrapped([goOrder({ Status: 'canceled' }), goOrder({ ID: 'B2' })]), positions: [goPos(4)] }).fn({ order_id: 'A1' })).content[0].text);
  assert.match(covered.post_cancel_check.note, /already cover/);
  const gone = JSON.parse((await cancelRunner({ open: wrapped([goOrder()]), all: wrapped([goOrder({ Status: 'filled', FilledQty: 4 })]), positions: [] }).fn({ order_id: 'A1' })).content[0].text);
  assert.match(gone.post_cancel_check.note, /No position remains/);
});

test('A2: an HTTP-200 incomplete or local-only order list never becomes verified advice', async () => {
  const run1 = async over => JSON.parse((await cancelRunner({ open: wrapped([goOrder()]), all: wrapped([goOrder({ Status: 'canceled' })], over), positions: [goPos(4)] }).fn({ order_id: 'A1' })).content[0].text);
  for (const over of [{ complete: false }, { broker_state: 'unavailable' }]) {
    const out = await run1(over);
    assert.equal(out.message, 'Order canceled successfully', 'the DELETE outcome is unchanged');
    assert.equal(out.post_cancel_check.verified, false);
    assert.match(out.post_cancel_check.note, /Unverified/);
  }
  const bad = JSON.parse((await cancelRunner({ open: wrapped([goOrder()]), all: wrapped([goOrder({ Status: 'canceled' })]), positions: { error: 'x' } }).fn({ order_id: 'A1' })).content[0].text);
  assert.equal(bad.post_cancel_check.verified, false);
});

test('A2: ordinary cancels are unchanged (buy order, stock order, order not in the open list)', async () => {
  for (const open of [wrapped([goOrder({ Side: 'buy', PositionIntent: 'buy_to_open' })]), wrapped([goOrder({ Symbol: 'AAPL' })]), wrapped([])]) {
    const { fn, calls } = cancelRunner({ open, all: wrapped([]), positions: [] });
    const result = await fn({ order_id: 'A1' });
    assert.equal(result.content[0].text, JSON.stringify({ message: 'Order canceled successfully' }, null, 2));
    assert.deepEqual(calls, ['GET /orders?status=open', 'DELETE /orders/A1']);
  }
});

test('A2: a failed read never blocks or alters the cancel; after-read failure says unverified', async () => {
  const before = cancelRunner({ open: null, all: null, positions: null, failBefore: true });
  assert.equal(JSON.parse((await before.fn({ order_id: 'A1' })).content[0].text).message, 'Order canceled successfully');
  const after = JSON.parse((await cancelRunner({ open: wrapped([goOrder()]), all: null, positions: null, failAfter: true }).fn({ order_id: 'A1' })).content[0].text);
  assert.equal(after.message, 'Order canceled successfully');
  assert.equal(after.post_cancel_check.verified, false);
});

test('A2: a slow pre-read is abandoned after about 1.5 seconds and the cancel still runs', async () => {
  const { fn, calls } = cancelRunner({ hangBefore: true, open: null, all: null, positions: null });
  const started = Date.now();
  const out = JSON.parse((await fn({ order_id: 'A1' })).content[0].text);
  const took = Date.now() - started;
  assert.equal(out.message, 'Order canceled successfully');
  assert.ok(took >= 1400 && took < 4000, `took ${took} ms`);
  assert.deepEqual(calls, ['GET /orders?status=open', 'DELETE /orders/A1']);
  assert.equal(out.post_cancel_check, undefined);
});

// ── guidance reaches every strategy ───────────────────────────────────────────────────────────
test('A1/A2/A4: the new guidance lines appear once per agent prompt and carry no symbols or dates', () => {
  for (const id of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion', 'capital-preservation']) {
    const text = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
    for (const phrase of ['Session time: reason about time of day only from session_time_et', 'a replacement covers only the verified remaining quantity', 'The second-heartbeat review above applies to opening orders only']) {
      assert.equal(text.split(phrase).length - 1, 1, `${id}: ${phrase}`);
    }
    assert.doesNotMatch(text, /\b(AVGO|COST|AMD|2026-\d\d-\d\d|Nov(ember)? 1\d)\b/, id);
  }
  const herald = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, catalystRangeMinutes: 15 }, { strategyId: 'catalyst-news' });
  assert.equal(herald.split('This target exit happens once per position').length - 1, 1);
  assert.match(herald, /Enter only once minutes_since_open is at least 15 \(OP2 also refuses an earlier opening\)/);
  assert.match(herald, /the end is the actual session close \(session_close_et from get_datetime; early-close days end earlier\)/);
  assert.match(herald, /or the publication time for news published during the session/);
  assert.match(herald, /overnight or pre-open news \(session_open_et from get_datetime; a pre-market bar never forms the range\)/);
  assert.doesNotMatch(herald, /09:30 to 16:00 ET/);
  const other = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'default' });
  assert.doesNotMatch(other, /This target exit happens once|a pre-market bar never forms the range/);
});

test('A5: trend definitions are added for the catalyst strategy only; other strategies are unchanged', () => {
  const flat = '"Flat or rising average" means';
  const count = (id, s) => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id }).split(s).length - 1;
  assert.equal(count('catalyst-news', flat), 1);
  assert.equal(count('catalyst-news', '"Flat or falling average" means'), 1);
  assert.equal(count('etf-mean-reversion', flat), 1, 'mean-reversion keeps its single definition');
  for (const id of ['etf-mean-reversion', 'default', 'equity-momentum', 'long-premium-volatility', 'capital-preservation']) assert.equal(count(id, '"Flat or falling average" means'), 0, id);
  for (const id of ['default', 'equity-momentum', 'long-premium-volatility']) assert.equal(count(id, flat), 0, id);
});

test('A5/B1: both directional thresholds are mirrored at the boundary and follow the shared setting', () => {
  const text = avg => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, avgSlopeMinPct: avg }, { strategyId: 'catalyst-news' });
  // default -0.3: calls need a 5-session change of -0.3% or higher; puts need 0.3% or lower
  let t = text(-0.3);
  assert.match(t, /"Flat or rising average" means the 5-session change of the 20-day average is -0\.3% or higher/);
  assert.match(t, /"Flat or falling average" means the 5-session change of the 20-day average is 0\.3% or lower/);
  assert.doesNotMatch(t, /below -0\.3%/, 'no strict complement wording');
  // a different shared setting moves both sides together
  t = text(-0.5);
  assert.match(t, /is -0\.5% or higher/); assert.match(t, /is 0\.5% or lower/);
  // zero threshold: both sides meet at zero with no "-0"
  t = text(0);
  assert.match(t, /is 0% or higher/); assert.match(t, /is 0% or lower/); assert.doesNotMatch(t, /-0%/);
  // a positive setting is mirrored, not folded
  t = text(0.4);
  assert.match(t, /is 0\.4% or higher/); assert.match(t, /is -0\.4% or lower/);
});
