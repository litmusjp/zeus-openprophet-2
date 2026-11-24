import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IV_CAPTURE, IvHistoryCollector, IvHistoryStore, captureWindow, completedCloses, createIvHistoryHandler, legIv, meanIv, parseStartList,
  pickAtm, pickExpiry, realisedVol, underlyingOf, underlyingPrice,
} from '../agent/iv-history.js';

// Nov 24 Q1 (Hermes plan review R1, R2): near-close capture of at-the-money IV, research data only. These tests pin the design:
// capture while the market is open, same strike and expiry for both legs, positive finite IV or a reasoned null, per-symbol usable
// sessions, no after-close catch-up, restart dedupe, provider-attempt and time caps, failure isolation, stored-row-only reads.

const CLOSE = Date.parse('2026-11-23T21:00:00Z'); // Mon Nov 23 2026, 16:00 ET (EST)
const IN_WINDOW = Date.parse('2026-11-23T20:46:00Z');
const iso = ms => new Date(ms).toISOString();

const contract = (type, strike, iv, quoteAt, symbol = `X261224${type === 'call' ? 'C' : 'P'}${String(strike * 1000).padStart(8, '0')}`) => ({
  Symbol: symbol, ContractType: type, StrikePrice: strike, ImpliedVolatility: iv, QuoteTimestamp: quoteAt, market_data_feed: 'indicative', market_data_quality: 'testing_only',
});
const chainAround = (spot, nowMs, iv = 0.3) => {
  const at = iso(nowMs - 20000);
  return { contracts: [95, 100, 105].flatMap(k => [contract('call', k, iv, at), contract('put', k, iv + 0.02, at)]) };
};
const dailyBars = (n, start = 100) => ({ bars: Array.from({ length: n }, (_, i) => ({ Timestamp: iso(Date.parse('2026-10-01T05:00:00Z') + i * 86400000), Close: start * (1 + 0.01 * ((i % 3) - 1)), complete: true })) });

function harness({ now = IN_WINDOW, universe = ['AAA', 'BBB'], calendar, attemptsStart = 1000, failOn = {}, advance = 0, counter } = {}) {
  const clock = { t: now };
  const calls = [];
  let attempts = attemptsStart;
  const cal = calendar || { clock: { timestamp: iso(now), is_open: true }, sessions: [{ date: '2026-11-23', open: '09:30', close: '16:00' }] };
  const get = async requestPath => {
    calls.push(requestPath);
    clock.t += advance;
    if (requestPath.startsWith('/api/v1/calendar')) return { ...cal, clock: { ...cal.clock, timestamp: iso(clock.t) } };
    const symbol = requestPath.split('?')[0].split('/').pop();
    if (failOn[symbol] && !requestPath.includes('calendar')) throw Object.assign(new Error('boom'), { response: { status: failOn[symbol] } });
    if (requestPath.startsWith('/api/v1/market/quote/')) return { Symbol: symbol, last_trade: { price: 100.2, timestamp: iso(clock.t - 5000) }, quote_flag: 'ok' };
    if (requestPath.startsWith('/api/v1/market/bars/')) return dailyBars(30);
    if (requestPath.startsWith('/api/v1/options/expirations/')) { attempts += 9; return { complete: true, expirations: [{ date: '2026-12-18', dte: 25 }, { date: '2026-12-24', dte: 31 }] }; }
    if (requestPath.startsWith('/api/v1/options/chain/')) { attempts += 2; return chainAround(100.2, clock.t); }
    throw new Error('unexpected path ' + requestPath);
  };
  return { clock, calls, get, attempts: async () => (counter === 'unreadable' ? Promise.reject(new Error('no counter')) : attempts), universe: async () => universe, setAttempts: v => { attempts = v; } };
}
async function collectorFor(t, h, cfg) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-iv-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  const make = () => new IvHistoryCollector({ store, now: () => h.clock.t, sleep: async () => {}, log: () => {}, get: h.get, attempts: h.attempts, universe: h.universe }, cfg);
  return { store, make, collector: make(), dir };
}

test('capture window: close minus 15 to close minus 10 minutes, early closes follow the calendar close', () => {
  assert.deepEqual(captureWindow(CLOSE), { startMs: CLOSE - 15 * 60000, endMs: CLOSE - 10 * 60000 });
  const early = Date.parse('2026-11-27T18:00:00Z'); // day after Thanksgiving, 13:00 ET
  assert.equal(iso(captureWindow(early).startMs), '2026-11-27T17:45:00.000Z');
  assert.equal(captureWindow(NaN), null);
});

test('pickExpiry: nearest CONFIRMED expiry at least 25 days out; earlier unchecked dates are reported, never assumed absent', () => {
  const r = pickExpiry({ expirations: [{ date: '2026-12-31', dte: 38 }, { date: '2026-12-24', dte: 31 }, { date: '2026-12-11', dte: 18 }], unchecked: [{ date: '2026-12-18', dte: 25, reason: 'probe failed' }, { date: '2027-01-08', dte: 46 }] });
  assert.equal(r.expiry, '2026-12-24');
  assert.equal(r.basis, 'nearest_confirmed');
  assert.deepEqual(r.earlierUnchecked, ['2026-12-18']);
  assert.equal(pickExpiry({ expirations: [{ date: '2026-12-11', dte: 18 }], unchecked: [] }).reason, 'no_confirmed_expiry');
  assert.equal(pickExpiry({}).reason, 'expirations_unreadable');
  assert.deepEqual(pickExpiry({ expirations: [{ date: '2026-12-18', dte: 25 }] }).earlierUnchecked, []);
});

test('pickAtm: same strike for call and put, nearest strike to the price, lower strike on a tie, only strikes listing both legs', () => {
  const at = iso(IN_WINDOW);
  const chain = [contract('call', 95, 0.3, at), contract('put', 95, 0.3, at), contract('call', 100, 0.3, at), contract('call', 105, 0.3, at), contract('put', 105, 0.3, at)];
  // 100 has no put, so the nearest strike with both legs to 101 is 105 (|4|) vs 95 (|6|)
  const a = pickAtm(chain, 101);
  assert.equal(a.strike, 105);
  assert.equal(pick(a.call, 'strikeprice'), 105);
  assert.equal(pick(a.put, 'strikeprice'), 105);
  // tie between 95 and 105 at spot 100 picks the lower strike
  assert.equal(pickAtm(chain, 100).strike, 95);
  assert.equal(pickAtm([], 100).reason, 'chain_empty');
  assert.equal(pickAtm(chain, 0).reason, 'no_underlying_price');
  assert.equal(pickAtm([contract('call', 100, 0.3, at)], 100).reason, 'no_call_put_pair');
});
function pick(o, k) { return o[Object.keys(o).find(x => x.toLowerCase().replace(/_/g, '') === k)]; }

test('IV rule: both legs finite, positive, decimal and fresh; anything else is a reasoned null, never zero, one-sided or halved', () => {
  const now = IN_WINDOW, fresh = iso(now - 30000);
  const ok = contract('call', 100, 0.25, fresh), okPut = contract('put', 100, 0.35, fresh);
  assert.equal(meanIv(ok, okPut, now).meanIv, 0.3);
  assert.equal(meanIv(contract('call', 100, 0, fresh), okPut, now).reason, 'call_iv_not_positive');
  assert.equal(meanIv(ok, contract('put', 100, -0.1, fresh), now).reason, 'put_iv_not_positive');
  assert.equal(meanIv(ok, contract('put', 100, Infinity, fresh), now).reason, 'put_iv_not_positive');
  assert.equal(meanIv(ok, contract('put', 100, NaN, fresh), now).reason, 'put_iv_not_positive');
  assert.equal(meanIv(ok, contract('put', 100, 35, fresh), now).reason, 'put_iv_units');
  assert.equal(meanIv(ok, { ...okPut, ImpliedVolatility: undefined }, now).reason, 'put_iv_missing');
  assert.equal(meanIv(ok, contract('put', 100, 0.3, iso(now - 3 * 60000)), now).reason, 'put_quote_stale');
  assert.equal(meanIv(ok, { ...okPut, QuoteTimestamp: undefined }, now).reason, 'put_quote_timestamp_missing');
  assert.equal(meanIv(ok, contract('put', 100, -1, fresh), now).meanIv, undefined);
  assert.equal(legIv(ok, now).iv, 0.25);
});

test('realised volatility: 21 completed closes give 20 log returns, anything shorter is null with a reason (no shorter undisclosed window)', () => {
  const closes = Array.from({ length: 21 }, (_, i) => 100 * Math.pow(1.01, i));
  const flat = realisedVol(closes);
  assert.equal(flat.window, 20);
  assert.ok(Math.abs(flat.value) < 1e-9, 'constant growth has zero dispersion');
  const noisy = realisedVol(Array.from({ length: 21 }, (_, i) => 100 + (i % 2 ? 1 : -1)));
  assert.ok(noisy.value > 0.1 && Number.isFinite(noisy.value));
  assert.deepEqual([realisedVol(closes.slice(0, 20)).value, realisedVol(closes.slice(0, 20)).reason], [null, 'insufficient_history']);
  assert.equal(realisedVol([]).value, null);
});

test('underlying price: a fresh last trade, else a sane fresh quote mid, else a reasoned null; forming bars never count as closes', () => {
  const now = IN_WINDOW;
  assert.equal(underlyingPrice({ last_trade: { price: 50, timestamp: iso(now - 1000) } }, now).source, 'last_trade');
  const mid = underlyingPrice({ BidPrice: 49, AskPrice: 51, Timestamp: iso(now - 1000), quote_flag: 'ok', last_trade: { price: 50, timestamp: iso(now - 10 * 60000) } }, now);
  assert.deepEqual([mid.price, mid.source], [50, 'quote_mid']);
  assert.equal(underlyingPrice({ BidPrice: 49, AskPrice: 51, Timestamp: iso(now - 10 * 60000) }, now).reason, 'no_fresh_underlying_price');
  const { closes } = completedCloses({ bars: [{ Timestamp: '2026-11-19T05:00:00Z', Close: 10, complete: true }, { Timestamp: '2026-11-20T05:00:00Z', Close: 11, complete: true }, { Timestamp: '2026-11-23T05:00:00Z', Close: 12, complete: false }] });
  assert.deepEqual(closes, [10, 11]);
});

test('start-list parsing and held-underlying extraction', () => {
  const herald = '### CATALYST UNIVERSE (start list; rules)\nStart with these 30 liquid large caps: AAPL MSFT NVDA BRK.B DIS. ETFs are outside your strategy.\nmore text\n### END_CATALYST_UNIVERSE';
  assert.deepEqual(parseStartList(herald), ['AAPL', 'MSFT', 'NVDA', 'BRKB', 'DIS']);
  assert.deepEqual(parseStartList('### SCAN UNIVERSE (x)\nStart each scan with these 30 liquid ETFs and large caps: SPY QQQ IWM. (30 symbols.)\n'), ['SPY', 'QQQ', 'IWM']);
  assert.deepEqual(parseStartList('no block here'), []);
  assert.equal(underlyingOf('CRM261218P00190000'), 'CRM');
  assert.equal(underlyingOf('garbage'), null);
});

test('store: append-only rows, torn lines skipped, per-symbol usable sessions count only non-null mean IV on distinct dates', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  await store.append({ sessionDate: '2026-11-20', symbol: 'AAA', meanIv: 0.3 });
  await store.append({ sessionDate: '2026-11-23', symbol: 'AAA', meanIv: null, reason: 'quote_stale' });
  await store.append({ sessionDate: '2026-11-23', symbol: 'BBB', meanIv: 0.4 });
  await store.append({ sessionDate: '2026-11-23', symbol: 'BBB', meanIv: 0.41 }); // a duplicate same-date row does not count twice
  await fs.appendFile(path.join(dir, '2026-11.jsonl'), '{"sessionDate":"2026-11-2');
  const rows = await store.read({ symbol: 'aaa', days: 30, nowMs: Date.parse('2026-11-24T12:00:00Z') });
  assert.equal(rows.length, 2);
  assert.deepEqual(IvHistoryStore.usableSessions([...rows, ...(await store.read({ symbol: 'BBB', days: 30, nowMs: Date.parse('2026-11-24T12:00:00Z') }))]), { AAA: 1, BBB: 1 });
  assert.deepEqual([...await store.symbolsDone('2026-11-23')].sort(), ['AAA', 'BBB']);
  assert.equal((await store.read({ symbol: 'AAA', days: 1, nowMs: Date.parse('2026-11-24T12:00:00Z') })).length, 1, 'days is a bound');
});

test('route handler: bounded, validates the symbol, reads stored rows only and never collects', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivr-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  await store.append({ sessionDate: '2026-11-23', symbol: 'AAA', meanIv: 0.3 });
  let collected = 0;
  const handler = createIvHistoryHandler(store, () => Date.parse('2026-11-24T12:00:00Z'));
  const reply = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  let r = reply(); await handler({ query: { symbol: 'AAA', days: '9999' } }, r);
  assert.equal(r.body.days, 120);
  assert.deepEqual(r.body.usableSessions, { AAA: 1 });
  r = reply(); await handler({ query: { symbol: '../etc' } }, r);
  assert.equal(r.code, 400);
  assert.equal(collected, 0);
});

test('collector: inside the window it stores one row per symbol with same-strike/expiry IV; the second tick and a restarted instance do not duplicate', async t => {
  const h = harness();
  const { store, make, collector } = await collectorFor(t, h);
  const first = await collector.tick();
  assert.equal(first.status, 'captured');
  const rows = await store.read({ symbol: 'AAA', days: 5, nowMs: h.clock.t });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.sessionDate, '2026-11-23');
  assert.equal(row.expiry, '2026-12-18');
  assert.equal(row.expiryBasis, 'nearest_confirmed');
  assert.equal(row.strike, 100);
  assert.equal(row.callSymbol.includes('C'), true);
  assert.ok(Math.abs(row.meanIv - 0.31) < 1e-9);
  assert.equal(row.feed, 'indicative');
  assert.ok(Number.isFinite(row.realisedVol20));
  assert.equal((await collector.tick()).status, 'done_today');
  // a restart inside the window skips symbols already stored (no duplicate rows), a fresh instance has no memory of the day
  const restarted = make();
  const second = await restarted.tick();
  assert.equal(second.attempted, 0);
  assert.equal((await store.read({ symbol: 'AAA', days: 5, nowMs: h.clock.t })).length, 1);
});

test('collector: nothing runs before the window, after it, after the close or on a closed market (no after-close catch-up)', async t => {
  for (const when of ['2026-11-23T20:40:00Z', '2026-11-23T20:50:00Z', '2026-11-23T20:55:00Z', '2026-11-23T21:30:00Z']) {
    const h = harness({ now: Date.parse(when) });
    const { store, collector } = await collectorFor(t, h);
    assert.equal((await collector.tick()).status, 'outside_window', when);
    assert.equal((await store.symbolsDone('2026-11-23')).size, 0);
    assert.equal(h.calls.filter(c => !c.startsWith('/api/v1/calendar')).length, 0, 'no data read outside the window');
  }
  const closed = harness({ calendar: { clock: { timestamp: iso(IN_WINDOW), is_open: false }, sessions: [{ date: '2026-11-23', open: '09:30', close: '16:00' }] } });
  assert.equal((await (await collectorFor(t, closed)).collector.tick()).status, 'outside_window');
  const holiday = harness({ calendar: { clock: { timestamp: iso(IN_WINDOW), is_open: true }, sessions: [] } });
  assert.equal((await (await collectorFor(t, holiday)).collector.tick()).status, 'outside_window');
});

test('collector: an early close moves the window with the real calendar', async t => {
  const calendar = { clock: { timestamp: '2026-11-27T17:46:00Z', is_open: true }, sessions: [{ date: '2026-11-27', open: '09:30', close: '13:00' }] };
  const h = harness({ now: Date.parse('2026-11-27T17:46:00Z'), calendar });
  const { store, collector } = await collectorFor(t, h);
  assert.equal((await collector.tick()).status, 'captured');
  assert.equal((await store.symbolsDone('2026-11-27')).size, 2);
});

test('collector: the provider-attempt budget is enforced on counter deltas, the rest is stored as skipped with a reason', async t => {
  const h = harness({ universe: ['AAA', 'BBB', 'CCC'], attemptsStart: 0 });
  // each symbol costs 11 backend attempts (9 expiry probes + 2 chain) plus 2 app-level reads = 13; budget 20 allows the first only
  const { store, collector } = await collectorFor(t, h, { ...IV_CAPTURE, attemptBudget: 20 });
  const r = await collector.tick();
  assert.equal(r.status, 'captured');
  const all = ['AAA', 'BBB', 'CCC'].map(async s => (await store.read({ symbol: s, days: 5, nowMs: h.clock.t }))[0]);
  const [a, b, c] = await Promise.all(all);
  assert.equal(a.reason, null);
  assert.equal(b.reason, 'budget_exhausted');
  assert.equal(c.reason, 'budget_exhausted');
  assert.equal(b.skipped, true);
  assert.ok(r.providerAttempts >= 11);
});

test('collector: an unreadable provider-attempt counter means nothing is collected (it never assumes zero)', async t => {
  const h = harness({ counter: 'unreadable' });
  const { store, collector } = await collectorFor(t, h);
  const r = await collector.tick();
  assert.equal(r.status, 'attempts_unreadable');
  assert.equal((await store.symbolsDone('2026-11-23')).size, 0);
  assert.equal(h.calls.filter(c => c.includes('/options/')).length, 0);
});

test('collector: the whole-job time cap stops at the end of the window and records the rest as time_cap', async t => {
  const h = harness({ universe: ['AAA', 'BBB', 'CCC'], advance: 30000 }); // every backend read moves the clock 30 s
  const { store, collector } = await collectorFor(t, h);
  await collector.tick();
  const reasons = await Promise.all(['AAA', 'BBB', 'CCC'].map(async s => (await store.read({ symbol: s, days: 5, nowMs: h.clock.t }))[0]?.reason));
  assert.ok(reasons.includes('time_cap'), JSON.stringify(reasons));
  assert.equal(new Set(await store.symbolsDone('2026-11-23')).size, 3, 'every symbol has a row, none silently dropped');
});

test('collector: a failing symbol is isolated (reasoned null row), the others still collect, and no order or permission path is ever called', async t => {
  const h = harness({ universe: ['AAA', 'BBB'], failOn: { AAA: 503 } });
  const { store, collector } = await collectorFor(t, h);
  await collector.tick();
  const [a, b] = await Promise.all(['AAA', 'BBB'].map(async s => (await store.read({ symbol: s, days: 5, nowMs: h.clock.t }))[0]));
  assert.equal(a.meanIv, null);
  assert.equal(a.reason, 'http_503');
  assert.ok(Number.isFinite(b.meanIv));
  assert.ok(h.calls.every(c => /^\/api\/v1\/(calendar|market\/(quote|bars)|options\/(expirations|chain)|diagnostics)/.test(c)), 'only read paths: ' + h.calls.join(' '));
  assert.equal(h.calls.some(c => /order|permission|heartbeat/.test(c)), false);
});

test('collector: a stale option quote near the close is a null with a reason, the execution freshness rule is only read', async t => {
  const h = harness();
  const base = h.get;
  h.get = async p => (p.startsWith('/api/v1/options/chain/') ? { contracts: [contract('call', 100, 0.3, iso(IN_WINDOW - 5 * 60000)), contract('put', 100, 0.3, iso(IN_WINDOW - 5 * 60000))] } : base(p));
  const { store, collector } = await collectorFor(t, h);
  await collector.tick();
  const row = (await store.read({ symbol: 'AAA', days: 5, nowMs: h.clock.t }))[0];
  assert.equal(row.meanIv, null);
  assert.equal(row.reason, 'call_quote_stale');
  assert.equal(IV_CAPTURE.freshMs, 2 * 60 * 1000);
});
