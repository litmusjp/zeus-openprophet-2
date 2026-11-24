import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  IV_CAPTURE, IvHistoryCollector, IvHistoryStore, captureWindow, chainReserve, completedCloses, contractExpiry, createIvHistoryHandler, expirationsReserve,
  legIv, meanIv, monthsBetween, parseStartList, pickAtm, pickExpiry, realisedVol, symbolReserve, underlyingOf, underlyingPrice,
} from '../agent/iv-history.js';

// Nov 24 Q1 (Hermes plan review R1, R2, implementation QA QW-01..QW-04): near-close capture of at-the-money IV, research data only.
// These tests pin the design: capture while the market is open, same strike and expiry for both legs, positive finite IV or a reasoned
// null, per-symbol usable sessions, no after-close catch-up, restart dedupe and persisted allowance, a provider-attempt budget that
// reserves each read's worst case, accounting loss stops collection, a real per-symbol and window deadline, history reads across every
// month, append after a torn tail, and stored-row-only reads.

const CLOSE = Date.parse('2026-11-23T21:00:00Z'); // Mon Nov 23 2026, 16:00 ET (EST)
const IN_WINDOW = Date.parse('2026-11-23T20:46:00Z');
const WINDOW_END = CLOSE - 10 * 60000;
const iso = ms => new Date(ms).toISOString();
const occ = (expiry, type, strike) => `X${expiry.slice(2, 4)}${expiry.slice(5, 7)}${expiry.slice(8, 10)}${type === 'call' ? 'C' : 'P'}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

const contract = (type, strike, iv, quoteAt, expiry = '2026-12-18') => ({
  Symbol: occ(expiry, type, strike), ContractType: type, StrikePrice: strike, ExpirationDate: `${expiry}T00:00:00Z`, ImpliedVolatility: iv, QuoteTimestamp: quoteAt,
  market_data_feed: 'indicative', market_data_quality: 'testing_only',
});
const chainFor = (expiry, nowMs, iv = 0.3) => {
  const at = iso(nowMs - 20000);
  return { contracts: [95, 100, 105].flatMap(k => [contract('call', k, iv, at, expiry), contract('put', k, iv + 0.02, at, expiry)]) };
};
const dailyBars = n => ({ bars: Array.from({ length: n }, (_, i) => ({ Timestamp: iso(Date.parse('2026-10-01T05:00:00Z') + i * 86400000), Close: 100 * (1 + 0.01 * ((i % 3) - 1)), complete: true })) });

function harness({ now = IN_WINDOW, universe = ['AAA', 'BBB'], calendar, attemptsStart = 1000, failOn = {}, advance = 0, loseCounterAfter = null, resetCounterAfter = null, hang = {}, lateChainBy = 0, chainExpiryOverride = null } = {}) {
  const clock = { t: now };
  const calls = [];
  let attempts = attemptsStart, counterReads = 0;
  const cal = calendar || { clock: { timestamp: iso(now), is_open: true }, sessions: [{ date: '2026-11-23', open: '09:30', close: '16:00' }] };
  const get = async (requestPath, options = {}) => {
    calls.push({ path: requestPath, at: clock.t });
    const symbol = requestPath.split('?')[0].split('/').pop();
    if (hang[symbol] && !requestPath.includes('calendar')) await new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))));
    clock.t += advance;
    if (requestPath.startsWith('/api/v1/calendar')) return { ...cal, clock: { ...cal.clock, timestamp: iso(clock.t) } };
    if (failOn[symbol]) throw Object.assign(new Error('boom'), { response: { status: failOn[symbol] } });
    if (requestPath.startsWith('/api/v1/market/quote/')) return { Symbol: symbol, last_trade: { price: 100.2, timestamp: iso(clock.t - 5000) }, quote_flag: 'ok' };
    if (requestPath.startsWith('/api/v1/market/bars/')) return dailyBars(30);
    if (requestPath.startsWith('/api/v1/options/expirations/')) { attempts += 9; return { complete: true, expirations: [{ date: '2026-12-18', dte: 25 }, { date: '2026-12-24', dte: 31 }] }; }
    if (requestPath.startsWith('/api/v1/options/chain/')) {
      attempts += 2; clock.t += lateChainBy;
      const expiry = /expiration=([\d-]+)/.exec(requestPath)[1];
      return chainFor(chainExpiryOverride || expiry, clock.t);
    }
    throw new Error('unexpected path ' + requestPath);
  };
  const open = () => ({
    id: 'test-backend', get,
    attempts: async () => {
      counterReads += 1;
      if (loseCounterAfter !== null && counterReads > loseCounterAfter) throw new Error('counter lost');
      if (resetCounterAfter !== null && counterReads > resetCounterAfter) return 3;
      return attempts;
    },
  });
  return { clock, calls, open, universe: async () => universe, modeled: () => attempts - attemptsStart, dataCalls: () => calls.filter(c => !c.path.startsWith('/api/v1/calendar')) };
}
async function collectorFor(t, h, cfg, dirOverride) {
  const dir = dirOverride || await fs.mkdtemp(path.join(os.tmpdir(), 'op2-iv-'));
  if (!dirOverride) t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  const make = (universe = h.universe) => new IvHistoryCollector({ store, now: () => h.clock.t, sleep: async () => {}, log: () => {}, open: h.open, universe }, cfg);
  return { store, make, collector: make(), dir };
}
const rowOf = async (store, h, symbol) => (await store.read({ symbol, days: 5, nowMs: h.clock.t }))[0];

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

test('pickAtm: same strike and expiry for call and put, nearest strike, lower strike on a tie, only strikes listing both legs', () => {
  const at = iso(IN_WINDOW);
  const chain = [contract('call', 95, 0.3, at), contract('put', 95, 0.3, at), contract('call', 100, 0.3, at), contract('call', 105, 0.3, at), contract('put', 105, 0.3, at)];
  const a = pickAtm(chain, 101, '2026-12-18');
  assert.equal(a.strike, 105);
  assert.equal(contractExpiry(a.call), '2026-12-18');
  assert.equal(contractExpiry(a.put), '2026-12-18');
  assert.equal(pickAtm(chain, 100, '2026-12-18').strike, 95, 'a tie picks the lower strike');
  assert.equal(pickAtm([], 100, '2026-12-18').reason, 'chain_empty');
  assert.equal(pickAtm(chain, 0, '2026-12-18').reason, 'no_underlying_price');
  assert.equal(pickAtm([contract('call', 100, 0.3, at)], 100, '2026-12-18').reason, 'no_call_put_pair');
});

test('pickAtm validates the expiry of the selected contracts: a chain of another expiry is a null, never a silent mismatch', () => {
  const at = iso(IN_WINDOW);
  const dec24 = [contract('call', 100, 0.3, at, '2026-12-24'), contract('put', 100, 0.3, at, '2026-12-24')];
  assert.equal(pickAtm(dec24, 100, '2026-12-18').reason, 'expiry_mismatch');
  assert.equal(pickAtm(dec24, 100, '2026-12-24').strike, 100);
  // a mixed chain only offers the requested expiry's contracts
  const mixed = [...dec24, contract('call', 50, 0.3, at, '2026-12-18'), contract('put', 50, 0.3, at, '2026-12-18')];
  assert.equal(pickAtm(mixed, 100, '2026-12-18').strike, 50);
  // the OCC symbol date is used when the field is absent
  assert.equal(contractExpiry({ Symbol: 'AAPL261218C00150000' }), '2026-12-18');
});

test('IV rule: both legs finite, positive, decimal and fresh (not older than two minutes, never in the future); anything else is a reasoned null', () => {
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
  assert.equal(meanIv(ok, contract('put', 100, 0.3, iso(now + 1000)), now).reason, 'put_quote_future', 'same non-future rule as the backend');
  assert.equal(meanIv(ok, { ...okPut, QuoteTimestamp: undefined }, now).reason, 'put_quote_timestamp_missing');
  assert.equal(legIv(ok, now).iv, 0.25);
});

test('realised volatility: 21 completed closes give 20 log returns, anything shorter is null with a reason', () => {
  const closes = Array.from({ length: 21 }, (_, i) => 100 * Math.pow(1.01, i));
  const flat = realisedVol(closes);
  assert.equal(flat.window, 20);
  assert.ok(Math.abs(flat.value) < 1e-9, 'constant growth has zero dispersion');
  assert.ok(realisedVol(Array.from({ length: 21 }, (_, i) => 100 + (i % 2 ? 1 : -1))).value > 0.1);
  assert.deepEqual([realisedVol(closes.slice(0, 20)).value, realisedVol(closes.slice(0, 20)).reason], [null, 'insufficient_history']);
  assert.equal(realisedVol([]).value, null);
});

test('underlying price: a fresh, non-future last trade, else a sane fresh quote mid, else a reasoned null; forming bars never count', () => {
  const now = IN_WINDOW;
  assert.equal(underlyingPrice({ last_trade: { price: 50, timestamp: iso(now - 1000) } }, now).source, 'last_trade');
  assert.equal(underlyingPrice({ last_trade: { price: 50, timestamp: iso(now + 1000) } }, now).reason, 'no_fresh_underlying_price', 'a future timestamp is not fresh');
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

test('store: rows, per-symbol usable sessions on distinct dates with a non-null mean IV (null rows never advance it)', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivs-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  await store.append({ sessionDate: '2026-11-20', symbol: 'AAA', meanIv: 0.3 });
  await store.append({ sessionDate: '2026-11-23', symbol: 'AAA', meanIv: null, reason: 'quote_stale' });
  await store.append({ sessionDate: '2026-11-23', symbol: 'BBB', meanIv: 0.4 });
  await store.append({ sessionDate: '2026-11-23', symbol: 'BBB', meanIv: 0.41 }); // a duplicate same-date row does not count twice
  const now = Date.parse('2026-11-24T12:00:00Z');
  const rows = await store.read({ symbol: 'aaa', days: 30, nowMs: now });
  assert.equal(rows.length, 2);
  assert.deepEqual(IvHistoryStore.usableSessions([...rows, ...(await store.read({ symbol: 'BBB', days: 30, nowMs: now }))]), { AAA: 1, BBB: 1 });
  assert.deepEqual([...await store.symbolsDone('2026-11-23')].sort(), ['AAA', 'BBB']);
  assert.equal((await store.read({ symbol: 'AAA', days: 1, nowMs: now })).length, 1, 'days is a bound');
});

test('QW-02: a 120-day read returns observations from EVERY month in the range, through the route handler too', async t => {
  assert.deepEqual(monthsBetween('2025-11-15', '2026-03-15'), ['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivm-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  for (const d of ['2025-12-15', '2026-01-15', '2026-02-15', '2026-03-12']) await store.append({ sessionDate: d, symbol: 'AAA', meanIv: 0.3 });
  const handler = createIvHistoryHandler(store, () => Date.parse('2026-03-15T15:00:00Z'));
  const reply = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const r = reply(); await handler({ query: { symbol: 'AAA', days: '120' } }, r);
  assert.deepEqual(r.body.rows.map(x => x.sessionDate), ['2025-12-15', '2026-01-15', '2026-02-15', '2026-03-12']);
  assert.deepEqual(r.body.usableSessions, { AAA: 4 });
  const bad = reply(); await handler({ query: { symbol: '../etc' } }, bad);
  assert.equal(bad.code, 400);
  const clamped = reply(); await handler({ query: { symbol: 'AAA', days: '9999' } }, clamped);
  assert.equal(clamped.body.days, 120);
});

test('QW-03: a torn final line is kept, the next valid append starts on its own line and is read back and deduped', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivt-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  await store.append({ sessionDate: '2026-11-20', symbol: 'AAA', meanIv: 0.3 });
  await fs.appendFile(path.join(dir, '2026-11.jsonl'), '{"sessionDate":"2026-11-2');
  await store.append({ sessionDate: '2026-11-23', symbol: 'AAA', meanIv: 0.31 });
  const text = await fs.readFile(path.join(dir, '2026-11.jsonl'), 'utf8');
  assert.ok(text.includes('{"sessionDate":"2026-11-2\n'), 'the torn bytes are preserved, not rewritten');
  assert.deepEqual([...await store.symbolsDone('2026-11-23')], ['AAA']);
  assert.equal((await store.read({ symbol: 'AAA', days: 30, nowMs: Date.parse('2026-11-24T12:00:00Z') })).length, 2);
});

test('QW-03: an unreadable store is an error (never "empty history"); only a missing file is empty', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivu-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new IvHistoryStore(dir);
  assert.deepEqual(await store.readMonth('2026-11'), []);
  await fs.mkdir(path.join(dir, '2026-11.jsonl'));
  await assert.rejects(store.readMonth('2026-11'), e => e.code === 'storage_unreadable');
  await assert.rejects(store.symbolsDone('2026-11-23'), e => e.code === 'storage_unreadable');
  const handler = createIvHistoryHandler(store, () => Date.parse('2026-11-24T12:00:00Z'));
  const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } };
  await handler({ query: { symbol: 'AAA' } }, r);
  assert.equal(r.code, 500);
});

test('collector: inside the window it stores one row per symbol with same-strike, same-expiry IV; a second tick and a restart never duplicate', async t => {
  const h = harness();
  const { store, make, collector } = await collectorFor(t, h);
  assert.equal((await collector.tick()).status, 'captured');
  const row = await rowOf(store, h, 'AAA');
  assert.equal(row.sessionDate, '2026-11-23');
  assert.equal(row.expiry, '2026-12-18');
  assert.equal(row.expiryBasis, 'nearest_confirmed');
  assert.equal(row.strike, 100);
  assert.equal(contractExpiry({ Symbol: row.callSymbol }), '2026-12-18');
  assert.equal(contractExpiry({ Symbol: row.putSymbol }), '2026-12-18');
  assert.ok(Math.abs(row.meanIv - 0.31) < 1e-9);
  assert.equal(row.feed, 'indicative');
  assert.ok(Number.isFinite(row.realisedVol20));
  assert.equal((await collector.tick()).status, 'done_today');
  const restarted = await make().tick();
  assert.equal(restarted.attempted, 0);
  assert.equal((await store.read({ symbol: 'AAA', days: 5, nowMs: h.clock.t })).length, 1);
});

test('collector: nothing runs before the window, after it, after the close or on a closed market (no after-close catch-up), and no data is read', async t => {
  for (const when of ['2026-11-23T20:40:00Z', '2026-11-23T20:50:00Z', '2026-11-23T20:55:00Z', '2026-11-23T21:30:00Z']) {
    const h = harness({ now: Date.parse(when) });
    const { store, collector } = await collectorFor(t, h);
    assert.equal((await collector.tick()).status, 'outside_window', when);
    assert.equal((await store.symbolsDone('2026-11-23')).size, 0);
    assert.equal(h.dataCalls().length, 0, 'no data read outside the window');
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

test('QW-01: the budget reserves each read\'s worst case, so the modeled provider total NEVER exceeds the cap', async t => {
  assert.equal(chainReserve(), 60);
  assert.equal(expirationsReserve(), 33);
  assert.equal(symbolReserve(), 99);
  const h = harness({ universe: ['AAA', 'BBB', 'CCC', 'DDD'], attemptsStart: 0 });
  const cap = 120;
  const { store, collector } = await collectorFor(t, h, { ...IV_CAPTURE, attemptBudget: cap });
  const r = await collector.tick();
  const accounted = h.modeled() + (IV_CAPTURE.quoteWeight + IV_CAPTURE.barsWeight) * 2; // two symbols were admitted
  assert.ok(accounted <= cap, `accounted ${accounted} > cap ${cap}`);
  assert.ok(r.providerAttempts <= cap);
  const reasons = await Promise.all(['AAA', 'BBB', 'CCC', 'DDD'].map(async s => (await rowOf(store, h, s)).reason));
  assert.deepEqual(reasons, [null, null, 'budget_exhausted', 'budget_exhausted']);
  // a cap below one symbol's worst case admits nothing and reads no market data at all
  const tight = harness({ universe: ['AAA'], attemptsStart: 0 });
  const t2 = await collectorFor(t, tight, { ...IV_CAPTURE, attemptBudget: 50 });
  await t2.collector.tick();
  assert.equal(tight.dataCalls().length, 0);
  assert.equal((await rowOf(t2.store, tight, 'AAA')).reason, 'budget_exhausted');
});

test('QW-01: losing the counter after a good baseline stops all further data reads (remaining symbols are reasoned skips)', async t => {
  const h = harness({ universe: ['AAA', 'BBB', 'CCC'], loseCounterAfter: 3 }); // baseline + two reads succeed, then it is gone
  const { store, collector } = await collectorFor(t, h);
  await collector.tick();
  const reasons = await Promise.all(['AAA', 'BBB', 'CCC'].map(async s => (await rowOf(store, h, s)).reason));
  assert.ok(reasons.includes('accounting_unknown'), JSON.stringify(reasons));
  const usable = await Promise.all(['AAA', 'BBB', 'CCC'].map(async s => (await rowOf(store, h, s)).meanIv));
  assert.ok(usable.filter(v => v !== null).length < 3, 'not every symbol may still collect after the counter is lost');
  const lastRead = h.dataCalls().at(-1);
  const idx = h.calls.indexOf(lastRead);
  assert.ok(idx > 0);
  // a RESET counter (smaller than the last reading) is also unknown accounting
  const reset = harness({ universe: ['AAA', 'BBB'], resetCounterAfter: 2 });
  const rr = await collectorFor(t, reset);
  await rr.collector.tick();
  const resetReasons = await Promise.all(['AAA', 'BBB'].map(async s => (await rowOf(rr.store, reset, s)).reason));
  assert.ok(resetReasons.includes('accounting_unknown'), JSON.stringify(resetReasons));
});

test('QW-01: an unreadable counter at the start collects nothing, and the persisted allowance survives an interrupted restart', async t => {
  const none = harness({ loseCounterAfter: 0 });
  const a = await collectorFor(t, none);
  assert.equal((await a.collector.tick()).status, 'attempts_unreadable');
  assert.equal(none.dataCalls().length, 0);
  // interrupted capture: instance 1 handles AAA, a restarted instance continues with the persisted expenditure
  const h = harness({ universe: ['AAA'], attemptsStart: 0 });
  const cap = 120;
  const { store, make, dir } = await collectorFor(t, h, { ...IV_CAPTURE, attemptBudget: cap });
  const first = await make(async () => ['AAA']).tick();
  const spent1 = await store.readBudget('2026-11-23');
  assert.equal(spent1, first.providerAttempts);
  assert.ok(spent1 > 0 && spent1 <= cap);
  const second = await make(async () => ['AAA', 'BBB']).tick();   // a restarted process: no in-memory memory of the day
  const spent2 = await store.readBudget('2026-11-23');
  assert.ok(spent2 > spent1 && spent2 <= cap, `${spent1} -> ${spent2}`);
  const third = await make(async () => ['AAA', 'BBB', 'CCC']).tick();
  assert.equal((await rowOf(store, h, 'CCC')).reason, 'budget_exhausted', 'the allowance did not reset on restart');
  assert.ok(third.providerAttempts <= cap);
  assert.ok(dir);
});

test('QW-01: an unreadable store stops collection and reads no market data', async t => {
  const h = harness();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivx-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, '2026-11.jsonl'));
  const { collector } = await collectorFor(t, h, undefined, dir);
  assert.equal((await collector.tick()).status, 'storage_unreadable');
  assert.equal(h.dataCalls().length, 0);
});

test('QW-04: the window end is a hard stop: no read starts after it and a capture finishing after it is refused as late', async t => {
  // every backend read advances the fake clock by 90 s, so the window (5 min) ends mid-symbol
  const h = harness({ universe: ['AAA', 'BBB', 'CCC'], advance: 90000 });
  const { store, collector } = await collectorFor(t, h, { ...IV_CAPTURE, symbolTimeoutMs: 10 * 60000 });
  await collector.tick();
  assert.ok(h.dataCalls().every(c => c.at < WINDOW_END), 'no data read STARTED at or after the window end');
  const rows = await Promise.all(['AAA', 'BBB', 'CCC'].map(s => rowOf(store, h, s)));
  assert.ok(rows.every(r => r.meanIv === null), 'nothing usable was stored this late');
  assert.ok(rows.some(r => ['time_cap', 'late_capture'].includes(r.reason)), JSON.stringify(rows.map(r => r.reason)));
  assert.equal(rows.length, 3, 'every symbol has a row');
  // a chain that returns after the window end is never stored as a usable capture
  const late = harness({ universe: ['AAA', 'BBB'], lateChainBy: 6 * 60000 });
  const l = await collectorFor(t, late);
  await l.collector.tick();
  const lateRow = await rowOf(l.store, late, 'AAA');
  assert.equal(lateRow.reason, 'late_capture');
  assert.equal(lateRow.meanIv, null);
  assert.equal((await rowOf(l.store, late, 'BBB')).reason, 'time_cap');
});

test('QW-04: a read that never returns is aborted at the whole-symbol deadline, the next symbol still collects', async t => {
  const h = harness({ universe: ['AAA', 'BBB'], hang: { AAA: true } });
  const { store, collector } = await collectorFor(t, h, { ...IV_CAPTURE, symbolTimeoutMs: 40 });
  await collector.tick();
  assert.equal((await rowOf(store, h, 'AAA')).reason, 'symbol_timeout');
  assert.equal((await rowOf(store, h, 'AAA')).meanIv, null);
  assert.ok(Number.isFinite((await rowOf(store, h, 'BBB')).meanIv));
});

test('collector: a failing symbol is isolated (reasoned null row), the others still collect, and only read paths are used', async t => {
  const h = harness({ universe: ['AAA', 'BBB'], failOn: { AAA: 503 } });
  const { store, collector } = await collectorFor(t, h);
  await collector.tick();
  const [a, b] = await Promise.all(['AAA', 'BBB'].map(s => rowOf(store, h, s)));
  assert.equal(a.meanIv, null);
  assert.equal(a.reason, 'http_503');
  assert.ok(Number.isFinite(b.meanIv));
  assert.ok(h.calls.every(c => /^\/api\/v1\/(calendar|market\/(quote|bars)|options\/(expirations|chain))/.test(c.path)), 'only read paths: ' + h.calls.map(c => c.path).join(' '));
  assert.equal(h.calls.some(c => /order|permission|heartbeat/.test(c.path)), false);
});

test('collector: a chain of the wrong expiry or with stale or future quotes is a reasoned null, the freshness rule is only read', async t => {
  const mismatch = harness({ chainExpiryOverride: '2026-12-24' }); // the route is asked for Dec 18 but returns Dec 24 contracts
  const m = await collectorFor(t, mismatch);
  await m.collector.tick();
  assert.equal((await rowOf(m.store, mismatch, 'AAA')).reason, 'expiry_mismatch');
  assert.equal((await rowOf(m.store, mismatch, 'AAA')).meanIv, null);
  const stale = harness();
  const base = stale.open;
  stale.open = () => { const b = base(); const get = b.get; return { ...b, get: async (p, o) => (p.startsWith('/api/v1/options/chain/') ? { contracts: [contract('call', 100, 0.3, iso(IN_WINDOW - 5 * 60000)), contract('put', 100, 0.3, iso(IN_WINDOW - 5 * 60000))] } : get(p, o)) }; };
  const s = await collectorFor(t, stale);
  await s.collector.tick();
  assert.equal((await rowOf(s.store, stale, 'AAA')).reason, 'call_quote_stale');
  assert.equal(IV_CAPTURE.freshMs, 2 * 60 * 1000);
});

// ---- Hermes final recheck (R2): durable reservation before provider work, accounting loss in the timeout handler, bounded counter reads ----
const tmpStore = async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-ivf-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return new IvHistoryStore(dir);
};
const collectorWith = (store, h, cfg, universe = h.universe) => new IvHistoryCollector({ store, now: () => h.clock.t, sleep: async () => {}, log: () => {}, open: h.open, universe }, cfg);

test('R2 QW-01: the symbol reservation is persisted BEFORE provider work; an interruption before append keeps it and a restart cannot spend it again', async t => {
  const real = await tmpStore(t);
  const h = harness({ universe: ['AAA'], attemptsStart: 0 });
  let failAppend = true;
  const store = Object.assign(Object.create(real), { append: async row => { if (failAppend) throw new Error('disk gone'); return real.append(row); } });
  const cap = symbolReserve(); // exactly one symbol's worst case
  const cfg = { ...IV_CAPTURE, attemptBudget: cap };
  const first = await collectorWith(store, h, cfg).tick();
  assert.equal(first.status, 'error', 'the interrupted capture surfaces as an error');
  assert.equal(await real.readBudget('2026-11-23'), cap, 'the reservation stayed persisted (not settled, not rebaselined away)');
  const readsAfterFirst = h.dataCalls().length;
  failAppend = false;
  const second = await collectorWith(store, h, cfg).tick();   // a fresh instance: no memory of the interrupted symbol
  assert.equal(second.status, 'captured');
  assert.equal((await rowOf(real, h, 'AAA')).reason, 'budget_exhausted');
  assert.equal(h.dataCalls().length, readsAfterFirst, 'the restart read no further market data');
  assert.ok(h.modeled() <= cap, 'the modeled shared-call-point attempts stay within the cap across both instances');
});

test('R2 QW-01: if the reservation cannot be persisted, no provider work starts for that symbol', async t => {
  const real = await tmpStore(t);
  const h = harness({ universe: ['AAA'] });
  const store = Object.assign(Object.create(real), { writeBudget: async () => { throw new Error('cannot persist'); } });
  const r = await collectorWith(store, h).tick();
  assert.equal(r.status, 'error');
  assert.equal(h.dataCalls().length, 0);
});

test('R2 QW-01: lost accounting inside the timeout handler stops collection too, and the reservation stays outstanding', async t => {
  const store = await tmpStore(t);
  const h = harness({ universe: ['AAA', 'BBB'], hang: { AAA: true }, loseCounterAfter: 1 }); // baseline read ok, the refresh after AAA's timeout fails
  await collectorWith(store, h, { ...IV_CAPTURE, symbolTimeoutMs: 40, accountingTimeoutMs: 50, accountingFloorMs: 10 }).tick();
  assert.equal((await rowOf(store, h, 'AAA')).reason, 'accounting_unknown');
  assert.equal((await rowOf(store, h, 'AAA')).detail, 'symbol_timeout');
  assert.equal((await rowOf(store, h, 'BBB')).reason, 'accounting_unknown');
  assert.equal(h.calls.some(c => c.path.includes('/BBB')), false, 'no read started for the next symbol');
  assert.equal(await store.readBudget('2026-11-23'), symbolReserve(), 'the unsettled reservation is retained');
});

test('R2 QW-04: every counter read is bounded by a timeout and an abort signal, and a counter that never answers means accounting unknown', async t => {
  const store = await tmpStore(t);
  const h = harness({ universe: ['AAA', 'BBB'] });
  const seen = [];
  let reads = 0;
  const base = h.open;
  h.open = () => {
    const b = base();
    return { ...b, attempts: async options => {
      seen.push(options);
      reads += 1;
      if (reads === 1) return b.attempts(options);   // the baseline answers
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));   // later reads never answer
    } };
  };
  const cfg = { ...IV_CAPTURE, accountingTimeoutMs: 30, accountingFloorMs: 10 };
  await collectorWith(store, h, cfg).tick();
  assert.ok(seen.length >= 2);
  assert.ok(seen.every(o => o.signal instanceof AbortSignal && o.timeout >= 10 && o.timeout <= cfg.accountingTimeoutMs), JSON.stringify(seen.map(o => o.timeout)));
  assert.equal((await rowOf(store, h, 'AAA')).reason, 'accounting_unknown');
  assert.equal((await rowOf(store, h, 'AAA')).meanIv, null);
  assert.equal((await rowOf(store, h, 'BBB')).reason, 'accounting_unknown');
});

test('R2 QW-04: a capture that completes (accounting included) after the whole-symbol deadline is refused, not stored as usable IV', async t => {
  const store = await tmpStore(t);
  const h = harness({ universe: ['AAA'], lateChainBy: 5000 }); // the chain returns 5 s later, inside the window but past a 1 s symbol deadline
  await collectorWith(store, h, { ...IV_CAPTURE, symbolTimeoutMs: 1000 }).tick();
  const row = await rowOf(store, h, 'AAA');
  assert.equal(row.reason, 'symbol_timeout');
  assert.equal(row.meanIv, null);
});

// ---- Hermes final QA (R3): uncertain in-flight work keeps its allowance; the baseline counter read is window-clamped ----
test('R3 QW-01: an ABORTED read with a readable counter keeps the symbol\'s full worst case, and the next admission, a restart and the persisted file all include it', async t => {
  const store = await tmpStore(t);
  const h = harness({ universe: ['AAA', 'BBB'], hang: { AAA: true } });
  const cap = symbolReserve() + 50;   // room for exactly one symbol's worst case plus a little
  const cfg = { ...IV_CAPTURE, attemptBudget: cap, symbolTimeoutMs: 40 };
  await collectorWith(store, h, cfg).tick();
  const aaa = await rowOf(store, h, 'AAA');
  assert.equal(aaa.reason, 'symbol_timeout');
  assert.equal(h.calls.some(c => c.path.includes('/BBB')), false, 'the next symbol was NOT admitted: the aborted work is still allowance-covered');
  assert.equal((await rowOf(store, h, 'BBB')).reason, 'budget_exhausted');
  assert.equal(await store.readBudget('2026-11-23'), symbolReserve(), 'the persisted file keeps the whole reservation (it was not settled down to the measured 3)');
  // a restarted instance counts the retained allowance as well
  const again = harness({ universe: ['CCC'] });
  await collectorWith(store, again, cfg, async () => ['CCC']).tick();
  assert.equal((await rowOf(store, again, 'CCC')).reason, 'budget_exhausted');
  assert.equal(again.dataCalls().length, 0);
});

test('R3 QW-01: a transport failure with NO response is uncertain and retained; an HTTP error WITH a response is known and settles', async t => {
  const cap = symbolReserve() + 50;
  const cfg = { ...IV_CAPTURE, attemptBudget: cap };
  // no response at all (connection reset): the backend may still be working
  const storeA = await tmpStore(t);
  const a = harness({ universe: ['AAA', 'BBB'] });
  const baseA = a.open;
  a.open = () => { const b = baseA(); return { ...b, get: async (p, o) => { if (p.includes('/AAA') && p.includes('/market/quote/')) throw new Error('ECONNRESET'); return b.get(p, o); } }; };
  await collectorWith(storeA, a, cfg).tick();
  assert.equal((await rowOf(storeA, a, 'AAA')).reason, 'read_failed');
  assert.equal((await rowOf(storeA, a, 'BBB')).reason, 'budget_exhausted', 'uncertain work keeps its allowance');
  // a response (503) means the backend finished: settled, the next symbol is admitted
  const storeB = await tmpStore(t);
  const b = harness({ universe: ['AAA', 'BBB'], failOn: { AAA: 503 } });
  await collectorWith(storeB, b, cfg).tick();
  assert.equal((await rowOf(storeB, b, 'AAA')).reason, 'http_503');
  assert.ok(Number.isFinite((await rowOf(storeB, b, 'BBB')).meanIv), 'a known failure does not retain the allowance');
});

test('R3 QW-04: the baseline counter read is clamped to the window like every other counter read', async t => {
  const store = await tmpStore(t);
  const h = harness({ universe: ['AAA'], now: WINDOW_END - 500 });   // 0.5 s left in the capture window
  const seen = [];
  const base = h.open;
  h.open = () => { const b = base(); return { ...b, attempts: async o => { seen.push(o); return b.attempts(o); } }; };
  await collectorWith(store, h).tick();
  assert.ok(seen.length >= 1);
  assert.equal(seen[0].timeout, IV_CAPTURE.accountingFloorMs, 'the baseline got the one-second floor, not the full three seconds');
  assert.ok(seen.every(o => o.timeout <= IV_CAPTURE.accountingTimeoutMs && o.signal instanceof AbortSignal));
});
