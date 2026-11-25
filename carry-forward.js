// Nov 26 W3: optional structured "carry" notes an agent attaches to its own prophet_log_decision calls, and the bounded SESSION CARRY-FORWARD block
// that code builds from them for the next heartbeat.
//
// What this is NOT: it is not market data, broker truth, a plan, or a verdict by OP2. The agent writes the notes; code only checks their SHAPE
// (whitelisted keys, enums, caps, real dates). A note can still be wrong, so the block says so and every live fact (positions, orders, fills, quotes)
// still comes from the live tools. Nothing here reads or changes an order, a setting or a permission; a call without carry behaves exactly as before.
//
// Pure module: no I/O, no clock reads (the caller passes nowMs), no awaits.
import { isRealIsoDay, nyDateOf } from './session-clock.js';

export const CARRY_KINDS = Object.freeze(['candidate', 'range', 'target_allocation']);
const CANDIDATE_STATUS = ['pending', 'rejected', 'accepted', 'dropped'];
const CANDIDATE_GATES = ['daily_trend', 'range', 'confirmation', 'earnings', 'quote', 'other'];
const CANDIDATE_NEXT = ['range', 'confirmation', 'quote', 'entry'];
const ALLOCATION_STATUS = ['submitted', 'partial', 'filled', 'cancelled'];

const TICKER = /^[A-Z][A-Z.]{0,9}$/;
const OCC = /^[A-Z.]{1,6}\d?\d{6}[CP]\d{8}$/;
const ID = /^[A-Za-z0-9:_.-]{1,64}$/;
const FAILED_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const upper = value => (typeof value === 'string' ? value.trim().toUpperCase() : '');
const id = value => (typeof value === 'string' && ID.test(value.trim()) ? value.trim() : undefined);
const day = value => (typeof value === 'string' && isRealIsoDay(value.trim()) ? value.trim() : undefined);
const iso = value => (typeof value === 'string' && ISO.test(value.trim()) && Number.isFinite(Date.parse(value.trim())) ? value.trim() : undefined);
const oneOf = (value, list) => (typeof value === 'string' && list.includes(value.trim()) ? value.trim() : undefined);
const num = value => (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1e9 ? value : undefined);
const posNum = value => (num(value) !== undefined && value > 0 ? value : undefined);
const wholeQty = (value, min, max) => (Number.isInteger(value) && value >= min && value <= max ? value : undefined);
const compact = object => Object.fromEntries(Object.entries(object).filter(([, v]) => v !== undefined));

/** Whitelist, cap and validate one carry object. Returns the normalised object, or null when it is not valid (the caller then ignores it). Never throws. */
export function sanitizeCarry(raw) {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const kind = typeof raw.kind === 'string' ? raw.kind.trim() : '';
    if (kind === 'candidate') {
      const symbol = upper(raw.symbol);
      const direction = oneOf(raw.direction, ['call', 'put']);
      const status = oneOf(raw.status, CANDIDATE_STATUS);
      if (!TICKER.test(symbol) || !direction || !status) return null;
      let failed;
      if (raw.failed !== undefined) {
        if (!raw.failed || typeof raw.failed !== 'object' || Array.isArray(raw.failed)) return null;
        const entries = Object.entries(raw.failed);
        if (entries.length > 4 || entries.some(([k, v]) => !FAILED_KEY.test(k) || num(v) === undefined)) return null;
        failed = Object.fromEntries(entries);
      }
      for (const [key, check] of [['event_id', id], ['data_as_of', day], ['gate', v => oneOf(v, CANDIDATE_GATES)], ['next', v => oneOf(v, CANDIDATE_NEXT)]]) {
        if (raw[key] !== undefined && check(raw[key]) === undefined) return null;
      }
      return compact({ kind, symbol, direction, status, event_id: id(raw.event_id), data_as_of: day(raw.data_as_of), gate: oneOf(raw.gate, CANDIDATE_GATES), failed, next: oneOf(raw.next, CANDIDATE_NEXT) });
    }
    if (kind === 'range') {
      const symbol = upper(raw.symbol);
      const eventId = id(raw.event_id);
      const anchor = iso(raw.anchor_used);
      const high = posNum(raw.range_high);
      const low = posNum(raw.range_low);
      if (!TICKER.test(symbol) || !eventId || !anchor || high === undefined || low === undefined || low > high) return null;
      let refused;
      if (raw.refused_anchors !== undefined) {
        if (!Array.isArray(raw.refused_anchors) || raw.refused_anchors.length > 4 || raw.refused_anchors.some(d => day(d) === undefined)) return null;
        refused = raw.refused_anchors.map(d => d.trim());
      }
      for (const [key, check] of [['direction', v => oneOf(v, ['call', 'put'])], ['entry_order_id', id], ['event_published_at', iso]]) {
        if (raw[key] !== undefined && check(raw[key]) === undefined) return null;
      }
      return compact({ kind, symbol, event_id: eventId, direction: oneOf(raw.direction, ['call', 'put']), entry_order_id: id(raw.entry_order_id), event_published_at: iso(raw.event_published_at), anchor_used: anchor, range_high: high, range_low: low, refused_anchors: refused });
    }
    if (kind === 'target_allocation') {
      const symbol = upper(raw.symbol);
      const entry = id(raw.entry_order_id);
      const order = id(raw.order_id);
      const status = oneOf(raw.status, ALLOCATION_STATUS);
      const filled = wholeQty(raw.filled_qty, 0, 10000);
      const original = wholeQty(raw.original_qty, 1, 10000);
      if (!OCC.test(symbol) || !entry || !order || !status || filled === undefined || original === undefined || filled > original) return null;
      return { kind, symbol, entry_order_id: entry, order_id: order, filled_qty: filled, original_qty: original, status };
    }
    return null;
  } catch { return null; }
}

const hhmm = ms => new Date(ms).toISOString().slice(11, 16) + 'Z';
// the underlying of an OCC contract: everything before the 15-character date/type/strike suffix (an adjusted-root digit is not part of the ticker)
const underlyingOfOcc = occ => occ.slice(0, -15).replace(/\d$/, '');

/**
 * items: [{ timestamp (record time, trusted metadata), actorId (trusted record/session metadata or null), actorName?, carry }] from the persisted
 * records of ONE account/sandbox. Each carry is re-validated here (raw tool arguments may hold an unsanitised object).
 * heldLots: [{ symbol, entryOrderId|null }] for the contracts currently held and matched to an original entry receipt.
 * Returns '' when there is nothing to show (the heartbeat is then identical to one without this feature).
 */
export function buildCarryForwardBlock({ items, nowMs, currentAgentId, heldLots = [], maxLines = 30, maxChars = 3000, lookbackDays = 30 } = {}) {
  try {
    if (!Array.isArray(items) || !items.length || !Number.isFinite(nowMs)) return '';
    const sessionDate = nyDateOf(nowMs);
    const valid = [];
    for (const item of items) {
      const carry = sanitizeCarry(item?.carry);
      const ts = Date.parse(item?.timestamp);
      if (!carry || !Number.isFinite(ts) || ts > nowMs + 60000) continue;
      valid.push({ ts, carry, actorId: typeof item.actorId === 'string' && item.actorId ? item.actorId : null, actorName: typeof item.actorName === 'string' ? item.actorName.replace(/[^A-Za-z0-9 _.-]+/g, ' ').replace(/ +/g, ' ').trim().slice(0, 40) : '' });
    }
    if (!valid.length) return '';
    valid.sort((a, b) => a.ts - b.ts);
    const mine = entry => currentAgentId && entry.actorId === currentAgentId;
    const sameSession = entry => nyDateOf(entry.ts) === sessionDate;
    const who = entry => (mine(entry) ? 'you' : `another agent${entry.actorName ? ` (${entry.actorName})` : entry.actorId ? ` (${entry.actorId.slice(0, 24)})` : ''}`);

    const sections = { held: [], ranges: [], pending: [], rejected: [] };
    let ignoredLinks = 0;

    // Held lots: exact lot identity (symbol + entry order id). A closed and re-opened contract has another entry order and inherits nothing.
    for (const lot of heldLots) {
      const symbol = upper(lot?.symbol);
      if (!OCC.test(symbol)) continue;
      const entryOrderId = id(lot?.entryOrderId);
      if (!entryOrderId) { sections.held.push(`LOT ${symbol}: no matched entry order, so no carried target allocation or range is shown for it; read this contract's own order history`); continue; }
      const allocations = valid.filter(e => e.carry.kind === 'target_allocation' && e.carry.symbol === symbol && e.carry.entry_order_id === entryOrderId);
      const byOrder = new Map();
      for (const e of allocations) {
        const prior = byOrder.get(e.carry.order_id);
        // a later note can never reduce an already-noted fill, and a later status only replaces an earlier one
        // the original quantity is whatever the first note said; a later note that disagrees makes the quantity inconsistent, never a shrinking denominator
        const originals = prior ? (prior.originals.includes(e.carry.original_qty) ? prior.originals : [...prior.originals, e.carry.original_qty]) : [e.carry.original_qty];
        byOrder.set(e.carry.order_id, { filled: Math.max(prior?.filled ?? 0, e.carry.filled_qty), originals, status: e.carry.status, entry: e });
      }
      if (byOrder.size) {
        const total = [...byOrder.values()].reduce((sum, o) => sum + o.filled, 0);
        const open = [...byOrder.values()].filter(o => o.status === 'submitted' || o.status === 'partial').length;
        sections.held.push(`TARGET ALLOCATION ${symbol} (entry order ${entryOrderId}): notes show ${total} contract(s) filled across ${byOrder.size} order note(s)${open ? `, ${open} still noted as working or unconfirmed` : ''}; this is a note, not a broker-confirmed fill: read this contract's orders before any target order`);
        for (const [orderId, o] of byOrder) sections.held.push(`  order ${orderId}: noted ${o.originals.length === 1 ? `${o.filled}/${o.originals[0]} filled` : `${o.filled} filled, original quantity noted inconsistently (${o.originals.join(' then ')})`}, last status ${o.status}, by ${who(o.entry)}`);
      } else {
        sections.held.push(`TARGET ALLOCATION ${symbol} (entry order ${entryOrderId}): no note in the last ${lookbackDays} days (not proof that none exists; read this contract's orders)`);
      }
      // a held lot's range is bound by BOTH its entry order id and the underlying of the held contract; a note that names the entry order but another
      // underlying is a known identity contradiction and is ignored (counted below), never shown as this lot's range and never rewritten
      const underlying = underlyingOfOcc(symbol);
      const linked = valid.filter(e => e.carry.kind === 'range' && e.carry.entry_order_id === entryOrderId);
      ignoredLinks += linked.filter(e => e.carry.symbol !== underlying).length;
      const ranges = linked.filter(e => e.carry.symbol === underlying);
      const latest = new Map();
      for (const e of ranges) latest.set(e.carry.event_id, e);
      for (const e of latest.values()) {
        const r = e.carry;
        sections.ranges.push(`RANGE ${r.symbol} event ${r.event_id} (held lot ${entryOrderId}): high ${r.range_high} low ${r.range_low}, anchor used ${r.anchor_used}${r.event_published_at ? `, published ${r.event_published_at}` : ''}${r.refused_anchors?.length ? `, refused anchor dates ${r.refused_anchors.join(' ')} (do not ask for them again)` : ''}, by ${who(e)}`);
      }
    }

    // Current-session ranges recorded by this agent (not tied to a held lot).
    const lotIds = new Set(heldLots.map(l => id(l?.entryOrderId)).filter(Boolean));
    const sessionRanges = new Map();
    for (const e of valid) {
      if (e.carry.kind !== 'range' || !mine(e) || !sameSession(e) || (e.carry.entry_order_id && lotIds.has(e.carry.entry_order_id))) continue;
      sessionRanges.set(`${e.carry.symbol}|${e.carry.event_id}`, e);
    }
    for (const e of sessionRanges.values()) {
      const r = e.carry;
      sections.ranges.push(`RANGE ${r.symbol} event ${r.event_id} (today): high ${r.range_high} low ${r.range_low}, anchor used ${r.anchor_used}${r.event_published_at ? `, published ${r.event_published_at}` : ''}${r.refused_anchors?.length ? `, refused anchor dates ${r.refused_anchors.join(' ')} (do not ask for them again)` : ''}`);
    }

    // Candidates: this agent's own notes of today's New York session only.
    const keyed = new Map();
    let foreign = 0;
    for (const e of valid) {
      if (e.carry.kind !== 'candidate' || !sameSession(e)) continue;
      if (!mine(e)) { foreign += 1; continue; }
      const key = `${e.carry.symbol}|${e.carry.direction}|${e.carry.event_id || '-'}`;
      const prior = keyed.get(key);
      keyed.set(key, { latest: e, firstPending: prior?.firstPending ?? (e.carry.status === 'pending' ? e.ts : null) });
      if (e.carry.status === 'pending' && keyed.get(key).firstPending === null) keyed.get(key).firstPending = e.ts;
    }
    const pending = [...keyed.values()].filter(v => v.latest.carry.status === 'pending').sort((a, b) => (a.firstPending ?? a.latest.ts) - (b.firstPending ?? b.latest.ts));
    for (const v of pending) {
      const c = v.latest.carry;
      sections.pending.push(`PENDING ${c.symbol} ${c.direction} event ${c.event_id || '-'}: noted ${hhmm(v.latest.ts)}${c.next ? `, next step ${c.next}` : ''}${c.data_as_of ? `, data as of ${c.data_as_of}` : ''}`);
    }
    const rejected = [...keyed.values()].filter(v => v.latest.carry.status === 'rejected').sort((a, b) => b.latest.ts - a.latest.ts);
    let notReusable = 0;
    for (const v of rejected) {
      const c = v.latest.carry;
      if (c.gate === 'daily_trend' && c.event_id && c.data_as_of && c.failed && Object.keys(c.failed).length) {
        sections.rejected.push(`REJECTED daily_trend ${c.symbol} ${c.direction} event ${c.event_id}: noted ${hhmm(v.latest.ts)}, data as of ${c.data_as_of}, failed ${Object.entries(c.failed).map(([k, val]) => `${k}=${val}`).join(' ')}`);
      } else notReusable += 1;
    }

    if (!sections.held.length && !sections.ranges.length && !sections.pending.length && !sections.rejected.length) return '';

    const header = 'SESSION CARRY-FORWARD (your own earlier notes from this account\'s logs: shape-checked by code, not market data and not broker truth; verify with live tools before acting):';
    const usage = [
      'How to use: finish PENDING names before repeating research, without delaying position management. Reuse a REJECTED note only if the symbol, direction, event, data-as-of date and failed values are all unchanged; a different or unknown event, a changed direction or a newer completed daily bar is re-evaluated. A recorded range and its refused anchor dates stand for that event: use them, never rebuild a range from another session.',
    ];
    const footerNotes = [];
    if (notReusable) footerNotes.push(`${notReusable} other rejection note(s) today are not reusable (re-check them if they matter).`);
    if (foreign) footerNotes.push(`${foreign} candidate note(s) written by another agent are ignored.`);
    if (ignoredLinks) footerNotes.push(`${ignoredLinks} range note(s) name a held lot's entry order but another underlying and are ignored.`);

    const lines = [header, ...usage];
    let chars = lines.join('\n').length;
    const reserve = 260; // room for the omission line
    const omitted = { held: 0, ranges: 0, pending: 0, rejected: 0 };
    const footerReserve = footerNotes.join(' ').length + 2;
    for (const name of ['held', 'ranges', 'pending', 'rejected']) {
      for (const line of sections[name]) {
        const fits = lines.length + 1 <= maxLines - 2 && chars + line.length + 1 <= maxChars - reserve - footerReserve - 12;
        if (fits && omitted[name] === 0) { lines.push(line); chars += line.length + 1; } else omitted[name] += 1;
      }
    }
    const omittedTotal = Object.values(omitted).reduce((a, b) => a + b, 0);
    if (omittedTotal) lines.push(`OMITTED: ${omittedTotal} note(s) did not fit this size limit (${Object.entries(omitted).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(', ')}). Omission does not mean dropped, rejected or already scanned; pending names are listed oldest first.`);
    if (footerNotes.length) lines.push(footerNotes.join(' '));
    const text = `\n\n${lines.join('\n')}\n`;
    // the reserve above makes an overflow impossible; if it ever happened, show nothing rather than a cut-off record
    if (text.length > maxChars || lines.length > maxLines) return '';
    return text;
  } catch { return ''; }
}
