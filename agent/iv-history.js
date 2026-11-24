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
  windowMinutes: 5,      // and may run for this long: the hard end of every read the collector starts
  minDte: 25,            // nearest confirmed expiry at least this many calendar days out
  maxDte: 37,            // expiry search window (the expirations read probes one provider call per weekday in it)
  universeCap: 30,
  // Provider-attempt budget per session day. Backend attempts through the shared call point are read from the backend counter (exact for
  // the collector, over-counted when agents share that backend, which is the safe direction). Before EVERY read the collector reserves that
  // read's worst case, so the day's total cannot exceed the cap through the shared call point: expirations = one probe per weekday in the
  // window x 3 attempts, chain = up to 20 pages x 3 attempts (the backend's own ceilings). Reads that do not go through the shared call
  // point (the Alpaca SDK quote and bars routes) are charged at a fixed documented weight each (a quote route reads the latest quote, the
  // latest trade and daily bars).
  attemptBudget: 500,
  attemptsPerCall: 3,    // DoProviderRequest's MaxAttempts
  chainPageCeiling: 20,  // GetOptionsChain's page loop bound
  quoteWeight: 3,
  barsWeight: 3,
  paceMs: 1000,          // pause between symbols
  symbolTimeoutMs: 25000, // whole-symbol deadline (never longer than the window)
  tickMs: 30000,
  freshMs: 2 * 60 * 1000, // the existing execution freshness rule; the collector only reads it, never widens it
  closesNeeded: 21,      // 21 completed daily closes = 20 log returns
  accountingTimeoutMs: 3000, // each counter read: at most this long, never beyond the window end (floor below), always with an abort signal
  accountingFloorMs: 1000,
});

/** Worst-case provider attempts of one expirations read (one probe per weekday in the window) and of one chain read. */
export const expirationsReserve = (cfg = IV_CAPTURE) => (Math.ceil((cfg.maxDte - cfg.minDte + 1) * 5 / 7) + 1) * cfg.attemptsPerCall;
export const chainReserve = (cfg = IV_CAPTURE) => cfg.chainPageCeiling * cfg.attemptsPerCall;
export const symbolReserve = (cfg = IV_CAPTURE) => cfg.quoteWeight + cfg.barsWeight + expirationsReserve(cfg) + chainReserve(cfg);

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

/** Calendar date (YYYY-MM-DD) of a contract: its ExpirationDate field, else the date inside its OCC symbol. */
export function contractExpiry(c) {
  const field = pick(c, 'expirationdate');
  if (typeof field === 'string' && /^\d{4}-\d{2}-\d{2}/.test(field)) return field.slice(0, 10);
  const m = /^[A-Z]{1,6}(\d{2})(\d{2})(\d{2})[CP]\d{8}$/.exec(String(pick(c, 'symbol') || ''));
  return m ? `20${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Same strike and expiry for both legs: the strike nearest the underlying price (lower strike on a tie) that lists BOTH a call and a put.
 * When `expiry` is given, only contracts of exactly that expiry are considered (the chain route is trusted for nothing here).
 */
export function pickAtm(contracts, spot, expiry) {
  if (!Array.isArray(contracts) || !contracts.length) return { reason: 'chain_empty' };
  if (!finite(spot) || spot <= 0) return { reason: 'no_underlying_price' };
  const scoped = expiry ? contracts.filter(c => contractExpiry(c) === expiry) : contracts;
  if (!scoped.length) return { reason: 'expiry_mismatch' };
  const byStrike = new Map();
  for (const c of scoped) {
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

/**
 * A leg's IV counts only when it is a finite, positive decimal (a value above 10 is a percent, not a decimal: refused, never rescaled) and
 * its quote is fresh by the same rule the backend uses for execution: not older than two minutes and not in the future.
 */
export function legIv(contract, nowMs, freshMs = IV_CAPTURE.freshMs) {
  const iv = pick(contract, 'impliedvolatility');
  if (iv === undefined || iv === null) return { reason: 'iv_missing' };
  if (!finite(iv) || iv <= 0) return { reason: 'iv_not_positive' };
  if (iv > 10) return { reason: 'iv_units' };
  const ts = Date.parse(pick(contract, 'quotetimestamp') || '');
  if (!Number.isFinite(ts)) return { reason: 'quote_timestamp_missing' };
  if (ts > nowMs) return { reason: 'quote_future' };
  if (nowMs - ts > freshMs) return { reason: 'quote_stale' };
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

/** Underlying price from the last trade or a sane quote, both of which must be fresh and not in the future (the backend's own rule). */
export function underlyingPrice(quote, nowMs, freshMs = IV_CAPTURE.freshMs) {
  const trade = pick(quote, 'last_trade');
  const tp = pick(trade, 'price'), tt = Date.parse(pick(trade, 'timestamp') || '');
  if (finite(tp) && tp > 0 && Number.isFinite(tt) && tt <= nowMs && nowMs - tt <= freshMs) return { price: tp, at: new Date(tt).toISOString(), source: 'last_trade' };
  const bid = pick(quote, 'bidprice'), ask = pick(quote, 'askprice'), qt = Date.parse(pick(quote, 'timestamp') || '');
  if (finite(bid) && finite(ask) && bid > 0 && ask >= bid && Number.isFinite(qt) && qt <= nowMs && nowMs - qt <= freshMs && String(pick(quote, 'quote_flag') || 'ok') === 'ok') {
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

/** Months (YYYY-MM) from the month of `sinceDate` through the month of `untilDate`, inclusive, so a long range never skips a middle month. */
export function monthsBetween(sinceDate, untilDate) {
  let [y, m] = String(sinceDate).slice(0, 7).split('-').map(Number);
  const [ey, em] = String(untilDate).slice(0, 7).split('-').map(Number);
  const out = [];
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** Append-only JSONL, one file per month, one writer. Reads never trigger collection; an unreadable file is an error, never "empty history". */
export class IvHistoryStore {
  constructor(dir) { this.dir = dir; }
  fileFor(sessionDate) { return path.join(this.dir, `${String(sessionDate).slice(0, 7)}.jsonl`); }
  async append(row) {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(row.sessionDate);
    // A torn tail (a final line without its newline) is kept as it is; the next record starts on a fresh line so it cannot be swallowed.
    let prefix = '';
    try {
      const handle = await fs.open(file, 'r');
      try {
        const { size } = await handle.stat();
        if (size > 0) {
          const last = Buffer.alloc(1);
          await handle.read(last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        }
      } finally { await handle.close(); }
    } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    await fs.appendFile(file, prefix + JSON.stringify(row) + '\n', 'utf8');
  }
  async readMonth(month) {
    let text;
    try { text = await fs.readFile(path.join(this.dir, `${month}.jsonl`), 'utf8'); } catch (e) {
      if (e?.code === 'ENOENT') return [];
      throw Object.assign(new Error('iv history storage unreadable'), { code: 'storage_unreadable', cause: e });
    }
    const rows = [];
    for (const line of text.split('\n')) { if (!line.trim()) continue; try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped, never repaired */ } }
    return rows;
  }
  async symbolsDone(sessionDate) {
    return new Set((await this.readMonth(String(sessionDate).slice(0, 7))).filter(r => r.sessionDate === sessionDate).map(r => r.symbol));
  }
  /** Stored rows for a symbol over the last `days` calendar days (bounded), newest last, across EVERY month in the range. */
  async read({ symbol, days = 30, nowMs = Date.now() }) {
    const sym = String(symbol || '').toUpperCase();
    const span = Math.min(Math.max(Number(days) || 30, 1), 120);
    const since = nyDateOf(nowMs - span * 86400000);
    const out = [];
    for (const month of monthsBetween(since, nyDateOf(nowMs))) for (const r of await this.readMonth(month)) if (r.symbol === sym && r.sessionDate >= since) out.push(r);
    return out.sort((a, b) => (a.sessionDate < b.sessionDate ? -1 : a.sessionDate > b.sessionDate ? 1 : 0));
  }
  /** The day's persisted provider-attempt expenditure, so an interrupted capture resumed inside its window cannot reset its allowance. */
  budgetFile(sessionDate) { return path.join(this.dir, `budget-${sessionDate}.json`); }
  async readBudget(sessionDate) {
    let text;
    try { text = await fs.readFile(this.budgetFile(sessionDate), 'utf8'); } catch (e) {
      if (e?.code === 'ENOENT') return 0;
      throw Object.assign(new Error('iv history storage unreadable'), { code: 'storage_unreadable', cause: e });
    }
    try { const used = JSON.parse(text)?.used; return finite(used) && used >= 0 ? used : (() => { throw new Error('bad'); })(); } catch { throw Object.assign(new Error('iv history budget unreadable'), { code: 'storage_unreadable' }); }
  }
  async writeBudget(sessionDate, used) {
    await fs.mkdir(this.dir, { recursive: true });
    const tmp = this.budgetFile(sessionDate) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify({ sessionDate, used, updatedAt: new Date().toISOString() }), 'utf8');
    await fs.rename(tmp, this.budgetFile(sessionDate));
  }
  /** Distinct session dates with a non-null mean IV, PER SYMBOL (never pooled). */
  static usableSessions(rows) {
    const bySymbol = {};
    for (const r of rows) if (finite(r.meanIv)) (bySymbol[r.symbol] ||= new Set()).add(r.sessionDate);
    return Object.fromEntries(Object.entries(bySymbol).map(([k, v]) => [k, v.size]));
  }
}

class Stop extends Error { constructor(reason) { super(reason); this.reason = reason; } }

/**
 * One scheduler owner. `deps`:
 *   open()      -> { id, get(path, { signal, timeout }), attempts() } bound to ONE backend for the whole capture (never re-selected mid-run);
 *                  attempts() is the backend's cumulative provider-attempt counter and may throw
 *   universe()  -> ordered list of symbols (the collector caps it)
 *   store, now(), sleep(ms), log(msg)
 * The calendar is read through open().get as well. Reads only; no order, permission or heartbeat path is ever used.
 */
export class IvHistoryCollector {
  constructor(deps, cfg = IV_CAPTURE) {
    this.deps = deps;
    this.cfg = cfg;
    this.running = false;
    this.completedDay = null;
  }

  async tick() {
    const { now, log } = this.deps;
    if (this.running) return { status: 'busy' };
    let fields;
    try {
      const calendar = await this.deps.open().get('/api/v1/calendar', { timeout: 8000 });
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
      if (result.finished) this.completedDay = sessionDate;
      return result;
    } catch (e) {
      log?.(`iv-history: capture stopped (${e.message})`);
      return { status: e?.code === 'storage_unreadable' ? 'storage_unreadable' : 'error', error: e.message };
    } finally { this.running = false; }
  }

  async captureSession({ sessionDate, window }) {
    const { store, now, sleep, log, universe } = this.deps;
    const cfg = this.cfg;
    const backend = this.deps.open();            // one backend identity for the whole capture
    const budget = { spent: 0, appWeight: 0, base: 0, last: null, start: null };
    // Storage first: an unreadable store must not be mistaken for an empty one (dedupe and the persisted allowance depend on it).
    const done = await store.symbolsDone(sessionDate);
    budget.base = await store.readBudget(sessionDate);   // expenditure already persisted for this session day (interrupted capture)
    budget.start = await this.counter(backend);
    // If the provider-attempt counter cannot be read the day cannot be bounded: collect nothing rather than assume zero.
    if (budget.start === null) return { status: 'attempts_unreadable', attempted: 0, finished: false };
    budget.last = budget.start;
    const list = [...new Set((await universe()).map(s => String(s).toUpperCase()))].slice(0, cfg.universeCap);
    let attempted = 0, skipped = 0, stored = 0, stopReason = null, unsettled = false;
    for (const symbol of list) {
      if (done.has(symbol)) continue;
      let skipReason = stopReason;
      if (!skipReason && now() >= window.endMs) skipReason = 'time_cap';
      if (!skipReason && this.used(budget) + symbolReserve(cfg) > cfg.attemptBudget) skipReason = 'budget_exhausted';
      if (skipReason) {
        await store.append({ sessionDate, symbol, capturedAt: new Date(now()).toISOString(), meanIv: null, reason: skipReason, skipped: true });
        skipped += 1; stored += 1; continue;
      }
      attempted += 1;
      // The symbol's worst case is persisted BEFORE any provider work and stays persisted until the symbol is settled with known accounting;
      // an interruption, a failed append or lost accounting therefore keeps the outstanding reservation instead of rebaselining it away.
      await store.writeBudget(sessionDate, this.used(budget) + symbolReserve(cfg));
      const { row, stop, settle } = await this.captureSymbol({ sessionDate, symbol, budget, backend, window });
      await store.append(row);
      stored += 1;
      if (settle !== false) await store.writeBudget(sessionDate, this.used(budget));
      else unsettled = true;
      if (stop) stopReason = stop;
      else await sleep(cfg.paceMs);
    }
    if (!unsettled) await store.writeBudget(sessionDate, this.used(budget));
    log?.(`iv-history: ${sessionDate} attempted ${attempted}, skipped ${skipped}, provider attempts accounted ${this.used(budget)}`);
    return { status: 'captured', sessionDate, attempted, skipped, stored, providerAttempts: this.used(budget), finished: true };
  }

  /** Expenditure of the day: persisted base + backend counter delta + fixed weights for reads outside the shared call point. */
  used(budget) { return budget.base + Math.max(0, budget.last - budget.start) + budget.appWeight; }
  /** One counter read, bounded by a timeout and an abort signal (never the unbounded default). Null when unreadable. */
  async counter(backend, windowEndMs) {
    const cfg = this.cfg;
    const left = Number.isFinite(windowEndMs) ? windowEndMs - this.deps.now() : cfg.accountingTimeoutMs;
    const timeout = Math.max(cfg.accountingFloorMs, Math.min(cfg.accountingTimeoutMs, left));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try { const v = await backend.attempts({ signal: controller.signal, timeout }); return Number.isFinite(v) ? v : null; } catch { return null; } finally { clearTimeout(timer); }
  }
  /** Refresh the counter. A lost or RESET counter means the accounting is unknown, so collection stops. */
  async refresh(budget, backend, window) {
    const v = await this.counter(backend, window?.endMs);
    if (v === null || v < budget.last) throw new Stop('accounting_unknown');
    budget.last = v;
  }

  async captureSymbol({ sessionDate, symbol, budget, backend, window }) {
    const { now } = this.deps;
    const cfg = this.cfg;
    const row = { sessionDate, symbol, capturedAt: new Date(now()).toISOString(), meanIv: null, callIv: null, putIv: null, reason: null };
    const deadline = Math.min(window.endMs, now() + cfg.symbolTimeoutMs);
    // Every read gets the REMAINING time of min(whole-symbol deadline, window end) as its timeout and an abort signal.
    const read = async requestPath => {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Stop(now() >= window.endMs ? 'time_cap' : 'symbol_timeout');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try { return await backend.get(requestPath, { signal: controller.signal, timeout: remaining }); }
      catch (e) { if (controller.signal.aborted) throw new Stop(now() >= window.endMs ? 'time_cap' : 'symbol_timeout'); throw e; }
      finally { clearTimeout(timer); }
    };
    const need = reserve => { if (this.used(budget) + reserve > cfg.attemptBudget) throw new Stop('budget_exhausted'); };
    try {
      // 1. underlying price (SDK route outside the shared call point: fixed weight)
      need(symbolReserve(cfg));
      budget.appWeight += cfg.quoteWeight;
      const quote = await read(`/api/v1/market/quote/${symbol}`);
      const px = underlyingPrice(quote, now(), cfg.freshMs);
      if (px.reason) return { row: { ...row, reason: px.reason } };
      row.underlyingPrice = px.price; row.underlyingAt = px.at; row.underlyingSource = px.source;
      // 2. realised volatility from completed daily bars (SDK route: fixed weight)
      budget.appWeight += cfg.barsWeight;
      const end = new Date(now()).toISOString().slice(0, 10), start = new Date(now() - 60 * 86400000).toISOString().slice(0, 10);
      try {
        const bars = await read(`/api/v1/market/bars/${symbol}?start=${start}&end=${end}&timeframe=1D`);
        const { closes, lastCloseDate } = completedCloses(bars);
        const rv = realisedVol(closes);
        row.realisedVol20 = rv.value; row.realisedVolReason = rv.reason || null; row.lastCloseDate = lastCloseDate;
      } catch (e) {
        if (e instanceof Stop) throw e;
        row.realisedVol20 = null; row.realisedVolReason = 'bars_unreadable'; row.lastCloseDate = null;
      }
      // 3. expiry: one provider probe per weekday in the window on the shared call point; reserve the worst case, then read the counter
      await this.refresh(budget, backend, window);
      need(expirationsReserve(cfg) + chainReserve(cfg));
      const expiries = await read(`/api/v1/options/expirations/${symbol}?min_dte=${cfg.minDte}&max_dte=${cfg.maxDte}`);
      await this.refresh(budget, backend, window);
      const pe = pickExpiry({ expirations: expiries?.expirations, unchecked: expiries?.unchecked }, cfg.minDte);
      if (pe.reason) return { row: { ...row, reason: pe.reason } };
      row.expiry = pe.expiry; row.dte = pe.dte; row.expiryBasis = pe.basis; row.earlierUnchecked = pe.earlierUnchecked;
      // 4. chain for that exact expiry (page loop and retries counted by the backend counter; worst case reserved above)
      need(chainReserve(cfg));
      const chain = await read(`/api/v1/options/chain/${symbol}?expiration=${pe.expiry}`);
      await this.refresh(budget, backend, window);
      // A capture that finishes after the window is refused, never stored as usable IV.
      // A capture that finishes (accounting read included) after the whole-symbol deadline or the window is refused, never stored as usable IV.
      if (now() >= window.endMs) return { row: { ...row, reason: 'late_capture' }, stop: 'time_cap' };
      if (now() >= deadline) return { row: { ...row, reason: 'symbol_timeout' } };
      const atm = pickAtm(Array.isArray(chain) ? chain : pick(chain, 'contracts'), px.price, pe.expiry);
      if (atm.reason) return { row: { ...row, reason: atm.reason } };
      const m = meanIv(atm.call, atm.put, now());
      row.strike = atm.strike; row.callSymbol = pick(atm.call, 'symbol'); row.putSymbol = pick(atm.put, 'symbol');
      row.callIv = m.callIv; row.putIv = m.putIv;
      row.feed = pick(atm.call, 'market_data_feed') || null; row.quality = pick(atm.call, 'market_data_quality') || null;
      row.quoteAt = pick(atm.call, 'quotetimestamp') || null;
      if (m.reason) return { row: { ...row, reason: m.reason } };
      return { row: { ...row, meanIv: m.meanIv, reason: null } };
    } catch (e) {
      if (e instanceof Stop) {
        const bounded = e.reason === 'budget_exhausted' || e.reason === 'time_cap' || e.reason === 'symbol_timeout';
        let known = e.reason !== 'accounting_unknown';
        if (known) { try { await this.refresh(budget, backend, window); } catch { known = false; } }
        if (!known) return { row: { ...row, reason: 'accounting_unknown', detail: e.reason, skipped: false }, stop: 'accounting_unknown', settle: false };
        return { row: { ...row, reason: e.reason, skipped: bounded }, stop: e.reason === 'symbol_timeout' ? null : e.reason };
      }
      const status = e?.response?.status;
      const category = e?.response?.data?.category;
      try { await this.refresh(budget, backend, window); } catch (s) { return { row: { ...row, reason: s.reason || 'accounting_unknown' }, stop: 'accounting_unknown', settle: false }; }
      return { row: { ...row, reason: category === 'market_closed' ? 'market_closed' : status ? `http_${status}` : 'read_failed' } };
    }
  }
}

/** GET /api/iv-history?symbol=&days= : bounded, authenticated by the app, reads stored rows only and can never trigger collection. */
export function createIvHistoryHandler(store, now = () => Date.now()) {
  return async (req, res) => {
    const symbol = String(req.query?.symbol || '').toUpperCase();
    if (!/^[A-Z]{1,6}$/.test(symbol)) return res.status(400).json({ error: 'symbol is required (1-6 letters)' });
    const days = Math.min(Math.max(Number(req.query?.days) || 30, 1), 120);
    try {
      const rows = await store.read({ symbol, days, nowMs: now() });
      return res.json({ symbol, days, rows, usableSessions: IvHistoryStore.usableSessions(rows) });
    } catch (e) {
      return res.status(500).json({ error: e?.code === 'storage_unreadable' ? 'iv history storage unreadable' : 'iv history read failed' });
    }
  };
}
