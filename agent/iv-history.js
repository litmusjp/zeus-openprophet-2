// IV-history collector (Nov 24, Q1). Research data only: it never trades, never touches a heartbeat, an order, a permission or the quote
// freshness rule. It captures at-the-money implied volatility near the regular-session close, WHILE the market is open (the chain route
// drops quotes older than two minutes and returns market_closed after the close), and appends one JSON line per symbol per session date.
//
// Capture window: from (close - 15 minutes) to (close - 10 minutes), taken from the broker calendar so early closes and holidays follow
// the real session. A restart may resume only while the clock is still inside that window; there is no after-close catch-up.
import fs from 'node:fs/promises';
import path from 'node:path';
import { nyDateOf, sessionFields } from '../session-clock.js';

export const IV_CAPTURE = Object.freeze({
  leadMinutes: 15,       // capture starts this long before the regular close
  windowMinutes: 5,      // and may run for this long (a hard time cap)
  minDte: 25,            // nearest confirmed expiry at least this many calendar days out
  maxDte: 37,            // expiry search window (the expirations read probes one provider call per weekday in it)
  universeCap: 30,
  attemptBudget: 500,    // provider attempts per day (Go provider attempts seen through the counter route, plus one per app-level quote/bars read)
  paceMs: 1500,          // pause between symbols
  symbolTimeoutMs: 15000,
  tickMs: 30000,
  freshMs: 2 * 60 * 1000, // the existing execution freshness rule; the collector only reads it, never widens it
  closesNeeded: 21,      // 21 completed daily closes = 20 log returns
});

const finite = v => typeof v === 'number' && Number.isFinite(v);
const norm = k => String(k).toLowerCase().replace(/_/g, '');
/** Case-insensitive field reader (Go structs without json tags serialise as Symbol/Timestamp; routes elsewhere use snake_case). */
export function pick(object, name) {
  if (!object || typeof object !== 'object') return undefined;
  const want = norm(name);
  for (const key of Object.keys(object)) if (norm(key) === want) return object[key];
  return undefined;
}

export function captureWindow(sessionCloseMs, cfg = IV_CAPTURE) {
  if (!finite(sessionCloseMs)) return null;
  return { startMs: sessionCloseMs - cfg.leadMinutes * 60000, endMs: sessionCloseMs - (cfg.leadMinutes - cfg.windowMinutes) * 60000 };
}

/** Nearest CONFIRMED expiry with dte >= minDte. Earlier eligible dates that could not be verified are reported, never assumed absent. */
export function pickExpiry(result, minDte = IV_CAPTURE.minDte) {
  const confirmed = Array.isArray(result?.expirations) ? result.expirations : null;
  if (!confirmed) return { reason: 'expirations_unreadable' };
  const unchecked = Array.isArray(result?.unchecked) ? result.unchecked : [];
  const eligible = confirmed.filter(e => e && typeof e.date === 'string' && finite(e.dte) && e.dte >= minDte).sort((a, b) => a.dte - b.dte);
  if (!eligible.length) return { reason: 'no_confirmed_expiry', uncheckedCount: unchecked.length };
  const chosen = eligible[0];
  const earlierUnchecked = unchecked.filter(u => u && typeof u.date === 'string' && finite(u.dte) && u.dte >= minDte && u.dte < chosen.dte).map(u => u.date).sort();
  return { expiry: chosen.date, dte: chosen.dte, basis: 'nearest_confirmed', earlierUnchecked };
}

/** Same strike and expiry for both legs: the strike nearest the underlying price (lower strike on a tie) that lists BOTH a call and a put. */
export function pickAtm(contracts, spot) {
  if (!Array.isArray(contracts) || !contracts.length) return { reason: 'chain_empty' };
  if (!finite(spot) || spot <= 0) return { reason: 'no_underlying_price' };
  const byStrike = new Map();
  for (const c of contracts) {
    const strike = pick(c, 'strikeprice');
    const type = String(pick(c, 'contracttype') || '').toLowerCase();
    if (!finite(strike) || (type !== 'call' && type !== 'put')) continue;
    const entry = byStrike.get(strike) || {};
    entry[type] = c;
    byStrike.set(strike, entry);
  }
  const pairs = [...byStrike.entries()].filter(([, v]) => v.call && v.put);
  if (!pairs.length) return { reason: 'no_call_put_pair' };
  pairs.sort((a, b) => Math.abs(a[0] - spot) - Math.abs(b[0] - spot) || a[0] - b[0]);
  const [strike, legs] = pairs[0];
  return { strike, call: legs.call, put: legs.put };
}

/** A leg's IV counts only when it is a finite, positive decimal (a value above 10 is a percent, not a decimal: refused, never rescaled). */
export function legIv(contract, nowMs, freshMs = IV_CAPTURE.freshMs) {
  const iv = pick(contract, 'impliedvolatility');
  if (iv === undefined || iv === null) return { reason: 'iv_missing' };
  if (!finite(iv) || iv <= 0) return { reason: 'iv_not_positive' };
  if (iv > 10) return { reason: 'iv_units' };
  const ts = Date.parse(pick(contract, 'quotetimestamp') || '');
  if (!Number.isFinite(ts)) return { reason: 'quote_timestamp_missing' };
  if (nowMs - ts > freshMs || ts - nowMs > 5000) return { reason: 'quote_stale' };
  return { iv };
}

/** Mean of the two legs only when BOTH are valid; one-sided or halved values never exist. */
export function meanIv(call, put, nowMs) {
  const c = legIv(call, nowMs), p = legIv(put, nowMs);
  if (c.reason || p.reason) return { reason: c.reason ? `call_${c.reason}` : `put_${p.reason}`, callIv: c.iv ?? null, putIv: p.iv ?? null };
  return { meanIv: (c.iv + p.iv) / 2, callIv: c.iv, putIv: p.iv };
}

/** Annualised realised volatility from the last 21 completed daily closes (20 log returns, sample stdev, sqrt(252)). */
export function realisedVol(closes) {
  const c = (Array.isArray(closes) ? closes : []).filter(x => finite(x) && x > 0);
  if (c.length < IV_CAPTURE.closesNeeded) return { value: null, reason: 'insufficient_history', closes: c.length };
  const last = c.slice(-IV_CAPTURE.closesNeeded);
  const r = [];
  for (let i = 1; i < last.length; i++) r.push(Math.log(last[i] / last[i - 1]));
  const mean = r.reduce((s, x) => s + x, 0) / r.length;
  const variance = r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1);
  return { value: Math.sqrt(variance) * Math.sqrt(252), window: r.length };
}

/** Underlying price from the last trade or a sane quote, both of which must be fresh by the existing two-minute rule. */
export function underlyingPrice(quote, nowMs, freshMs = IV_CAPTURE.freshMs) {
  const trade = pick(quote, 'last_trade');
  const tp = pick(trade, 'price'), tt = Date.parse(pick(trade, 'timestamp') || '');
  if (finite(tp) && tp > 0 && Number.isFinite(tt) && nowMs - tt <= freshMs) return { price: tp, at: new Date(tt).toISOString(), source: 'last_trade' };
  const bid = pick(quote, 'bidprice'), ask = pick(quote, 'askprice'), qt = Date.parse(pick(quote, 'timestamp') || '');
  if (finite(bid) && finite(ask) && bid > 0 && ask >= bid && Number.isFinite(qt) && nowMs - qt <= freshMs && String(pick(quote, 'quote_flag') || 'ok') === 'ok') {
    return { price: (bid + ask) / 2, at: new Date(qt).toISOString(), source: 'quote_mid' };
  }
  return { reason: 'no_fresh_underlying_price' };
}

/** Completed daily closes (oldest first) from the bars route; a bar marked complete=false is excluded. */
export function completedCloses(barsPayload) {
  const bars = Array.isArray(barsPayload) ? barsPayload : (pick(barsPayload, 'bars') || []);
  const rows = [];
  for (const b of bars) {
    if (pick(b, 'complete') === false) continue;
    const close = pick(b, 'close'), ts = Date.parse(pick(b, 'timestamp') || pick(b, 't') || '');
    if (finite(close) && close > 0 && Number.isFinite(ts)) rows.push({ ts, close });
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { closes: rows.map(r => r.close), lastCloseDate: rows.length ? new Date(rows[rows.length - 1].ts).toISOString().slice(0, 10) : null };
}

/** Start list of an agent prompt: the first line after the SCAN/CATALYST UNIVERSE header, text after its first colon up to the sentence end. */
export function parseStartList(prompt) {
  const text = String(prompt || '');
  const m = /### (?:SCAN|CATALYST) UNIVERSE[^\n]*\n([^\n]*)/.exec(text);
  if (!m) return [];
  const afterColon = m[1].includes(':') ? m[1].slice(m[1].indexOf(':') + 1) : '';
  const sentence = afterColon.split(/\.(?:\s|$)/)[0];
  return sentence.split(/\s+/).map(t => t.replace(/[.,]/g, '')).filter(t => /^[A-Z]{1,5}$/.test(t));
}

export function underlyingOf(occ) {
  const m = /^([A-Z]{1,6})\d{6}[CP]\d{8}$/.exec(String(occ || ''));
  return m ? m[1] : null;
}

/** Append-only JSONL, one file per month. Reads never trigger collection. */
export class IvHistoryStore {
  constructor(dir) { this.dir = dir; }
  fileFor(sessionDate) { return path.join(this.dir, `${String(sessionDate).slice(0, 7)}.jsonl`); }
  async append(row) {
    await fs.mkdir(this.dir, { recursive: true });
    await fs.appendFile(this.fileFor(row.sessionDate), JSON.stringify(row) + '\n', 'utf8');
  }
  async readMonth(month) {
    let text;
    try { text = await fs.readFile(path.join(this.dir, `${month}.jsonl`), 'utf8'); } catch { return []; }
    const rows = [];
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped, never repaired */ } }
    return rows;
  }
  async symbolsDone(sessionDate) {
    return new Set((await this.readMonth(String(sessionDate).slice(0, 7))).filter(r => r.sessionDate === sessionDate).map(r => r.symbol));
  }
  /** Stored rows for a symbol over the last `days` calendar days (bounded), newest last. */
  async read({ symbol, days = 30, nowMs = Date.now() }) {
    const sym = String(symbol || '').toUpperCase();
    const span = Math.min(Math.max(Number(days) || 30, 1), 120);
    const since = nyDateOf(nowMs - span * 86400000);
    const months = new Set([nyDateOf(nowMs).slice(0, 7), since.slice(0, 7)]);
    const out = [];
    for (const month of [...months].sort()) for (const r of await this.readMonth(month)) if (r.symbol === sym && r.sessionDate >= since) out.push(r);
    return out.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
  }
  /** Distinct session dates with a non-null mean IV, PER SYMBOL (never pooled). */
  static usableSessions(rows) {
    const bySymbol = {};
    for (const r of rows) if (finite(r.meanIv)) (bySymbol[r.symbol] ||= new Set()).add(r.sessionDate);
    return Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, v.size]));
  }
}

/**
 * One scheduler owner. `deps`:
 *   get(path)        -> response data from the trading backend (one HTTP attempt), throws on error
 *   attempts()       -> cumulative provider attempts counted by the backend's shared provider call point (null if unreadable)
 *   universe()       -> ordered list of symbols (the collector caps it)
 *   store, now(), sleep(ms), log(msg)
 */
export class IvHistoryCollector {
  constructor(deps, cfg = IV_CAPTURE) {
    this.deps = deps;
    this.cfg = cfg;
    this.running = false;
    this.completedDay = null;
  }

  async tick() {
    const { now, get, log } = this.deps;
    if (this.running) return { status: 'busy' };
    let fields;
    try {
      const calendar = await get('/api/v1/calendar');
      fields = sessionFields(calendar?.clock, calendar?.sessions);
    } catch (e) { return { status: 'calendar_unreadable' }; }
    const closeMs = Date.parse(fields.session_close_utc || '');
    const window = captureWindow(closeMs, this.cfg);
    const t = now();
    if (!window || fields.minutes_to_close === null || t < window.startMs || t >= window.endMs) return { status: 'outside_window' };
    const sessionDate = nyDateOf(t);
    if (this.completedDay === sessionDate) return { status: 'done_today' };
    this.running = true;
    try {
      const result = await this.captureSession({ sessionDate, window });
      if (result.attempted > 0 || result.finished) this.completedDay = sessionDate;
      return result;
    } catch (e) {
      log?.(`iv-history: capture stopped (${e.message})`);
      return { status: 'error', error: e.message };
    } finally { this.running = false; }
  }

  async captureSession({ sessionDate, window }) {
    const { store, now, sleep, log, universe } = this.deps;
    const cfg = this.cfg;
    const list = [...new Set((await universe()).map(s => String(s).toUpperCase()))].slice(0, cfg.universeCap);
    const done = await store.symbolsDone(sessionDate);
    this.window = window;
    const budget = { start: await this.safeAttempts(), appCalls: 0 };
    // If the provider-attempt counter cannot be read the day cannot be bounded: collect nothing rather than assume zero.
    if (budget.start === null) return { status: 'attempts_unreadable', attempted: 0, finished: false };
    let attempted = 0, skipped = 0, stored = 0;
    for (const symbol of list) {
      if (done.has(symbol)) continue;
      let skipReason = null;
      if (now() >= window.endMs) skipReason = 'time_cap';
      else if (this.used(budget) >= cfg.attemptBudget) skipReason = 'budget_exhausted';
      if (skipReason) {
        await store.append({ sessionDate, symbol, capturedAt: new Date(now()).toISOString(), meanIv: null, reason: skipReason, skipped: true });
        skipped += 1; stored += 1; continue;
      }
      attempted += 1;
      const row = await this.captureSymbol({ sessionDate, symbol, budget });
      await store.append(row);
      stored += 1;
      await sleep(cfg.paceMs);
    }
    log?.(`iv-history: ${sessionDate} attempted ${attempted}, skipped ${skipped}, provider attempts ${this.used(budget)}`);
    return { status: 'captured', sessionDate, attempted, skipped, stored, providerAttempts: this.used(budget), finished: true };
  }

  used(budget) { return Math.max(0, (budget.last ?? budget.start) - budget.start) + budget.appCalls; }
  async safeAttempts() { try { return await this.deps.attempts(); } catch { return null; } }
  async refresh(budget) { const v = await this.safeAttempts(); if (v !== null) budget.last = v; }

  async captureSymbol({ sessionDate, symbol, budget }) {
    const { get, now } = this.deps;
    const cfg = this.cfg;
    const row = { sessionDate, symbol, capturedAt: new Date(now()).toISOString(), meanIv: null, callIv: null, putIv: null, reason: null };
    const timeUp = () => now() >= this.window.endMs;
    const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('symbol_timeout')), cfg.symbolTimeoutMs))]);
    try {
      // 1. underlying price (app-level read, counted as one attempt)
      if (timeUp()) return { ...row, reason: 'time_cap', skipped: true };
      budget.appCalls += 1;
      const quote = await withTimeout(get(`/api/v1/market/quote/${symbol}`));
      const px = underlyingPrice(quote, now(), cfg.freshMs);
      if (px.reason) return { ...row, reason: px.reason };
      row.underlyingPrice = px.price; row.underlyingAt = px.at; row.underlyingSource = px.source;
      // 2. realised volatility from completed daily bars (one app-level read)
      budget.appCalls += 1;
      const end = new Date(now()).toISOString().slice(0, 10), start = new Date(now() - 60 * 86400000).toISOString().slice(0, 10);
      try {
        const bars = await withTimeout(get(`/api/v1/market/bars/${symbol}?start=${start}&end=${end}&timeframe=1D`));
        const { closes, lastCloseDate } = completedCloses(bars);
        const rv = realisedVol(closes);
        row.realisedVol20 = rv.value; row.realisedVolReason = rv.reason || null; row.lastCloseDate = lastCloseDate;
      } catch (e) { row.realisedVol20 = null; row.realisedVolReason = 'bars_unreadable'; row.lastCloseDate = null; }
      // 3. expiry (the read probes one provider call per weekday in the window; the backend counter sees them)
      await this.refresh(budget);
      if (this.used(budget) >= cfg.attemptBudget) return { ...row, reason: 'budget_exhausted', skipped: true };
      if (timeUp()) return { ...row, reason: 'time_cap', skipped: true };
      const expiries = await withTimeout(get(`/api/v1/options/expirations/${symbol}?min_dte=${cfg.minDte}&max_dte=${cfg.maxDte}`));
      const pe = pickExpiry({ expirations: expiries?.expirations, unchecked: expiries?.unchecked }, cfg.minDte);
      if (pe.reason) return { ...row, reason: pe.reason };
      row.expiry = pe.expiry; row.dte = pe.dte; row.expiryBasis = pe.basis; row.earlierUnchecked = pe.earlierUnchecked;
      // 4. chain for that exact expiry
      await this.refresh(budget);
      if (this.used(budget) >= cfg.attemptBudget) return { ...row, reason: 'budget_exhausted', skipped: true };
      if (timeUp()) return { ...row, reason: 'time_cap', skipped: true };
      const chain = await withTimeout(get(`/api/v1/options/chain/${symbol}?expiration=${pe.expiry}`));
      await this.refresh(budget);
      const atm = pickAtm(Array.isArray(chain) ? chain : pick(chain, 'contracts'), px.price);
      if (atm.reason) return { ...row, reason: atm.reason };
      const m = meanIv(atm.call, atm.put, now());
      row.strike = atm.strike; row.callSymbol = pick(atm.call, 'symbol'); row.putSymbol = pick(atm.put, 'symbol');
      row.callIv = m.callIv; row.putIv = m.putIv;
      row.feed = pick(atm.call, 'market_data_feed') || null; row.quality = pick(atm.call, 'market_data_quality') || null;
      row.quoteAt = pick(atm.call, 'quotetimestamp') || null;
      if (m.reason) return { ...row, reason: m.reason };
      return { ...row, meanIv: m.meanIv, reason: null };
    } catch (e) {
      const status = e?.response?.status;
      const category = e?.response?.data?.category;
      await this.refresh(budget);
      return { ...row, reason: category === 'market_closed' ? 'market_closed' : status ? `http_${status}` : (e.message === 'symbol_timeout' ? 'symbol_timeout' : 'read_failed') };
    }
  }
}

/** GET /api/iv-history?symbol=&days= : bounded, authenticated by the app, reads stored rows only and can never trigger collection. */
export function createIvHistoryHandler(store, now = () => Date.now()) {
  return async (req, res) => {
    const symbol = String(req.query?.symbol || '').toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(symbol)) return res.status(400).json({ error: 'symbol is required (1-6 letters)' });
    const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 120);
    const rows = await store.read({ symbol, days, nowMs: now() });
    return res.json({ symbol, days, rows, usableSessions: IvHistoryStore.usableSessions(rows) });
  };
}
