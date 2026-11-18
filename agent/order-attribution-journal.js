// Durable order-to-agent attribution record (one append-only JSONL file per account, outside chat-history retention).
// Entry (v1): { v, accountId, sandboxId, brokerAccountId, paper, orderIds[], agentId, agentName, at, source }.
// No raw tool arguments, results or credentials are stored. Duplicate evidence is idempotent on read; conflicting actors
// for one order id stay unresolved (never last-write-wins). A failed append never throws into order handling: callers get a
// rejected promise to turn into a visible warning, and status() counts failures.
import fs from 'node:fs/promises';
import path from 'node:path';
import { actorOf, executionOrderIds, isSubmittingOrderToolCall } from './history-attribution.js';

export const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 64 * 1024 * 1024;
const MAX_LINE = 16 * 1024;
const MAX_IDS = 16;
const DEDUP_CAP = 5000;
const SAFE_ACCOUNT = /^[A-Za-z0-9_.-]{1,128}$/;
const str = (v, max = 256) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);

function dataDirDefault() {
  return process.env.OPENPROPHET_DATA_DIR || path.join(process.cwd(), 'data');
}

export class OrderAttributionJournal {
  constructor(dataDir = dataDirDefault()) {
    this.dataDir = dataDir;
    this._queues = new Map();
    this._seen = new Set();
    this._status = { appended: 0, failures: 0, lastFailureAt: null, lastFailureCode: null };
  }

  file(accountId) {
    if (!SAFE_ACCOUNT.test(String(accountId || ''))) throw Object.assign(new Error('invalid account'), { code: 'invalid_account' });
    return path.join(this.dataDir, 'sandboxes', accountId, 'order-attribution.jsonl');
  }

  status() { return { ...this._status }; }

  _enqueue(accountId, fn) {
    const prev = this._queues.get(accountId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._queues.set(accountId, next);
    return next;
  }

  _fail(err) {
    this._status.failures += 1;
    this._status.lastFailureAt = new Date().toISOString();
    this._status.lastFailureCode = String(err?.code || 'write_failed').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'write_failed';
  }

  // Appends one complete line, flushes it, and resolves only after the data reached the disk (fsync).
  // A torn tail left by an earlier crash is terminated with a newline first (never truncated or rewritten).
  async record({ accountId, sandboxId = null, brokerAccountId = null, paper = null, actor, orderIds, at, source = 'live' }) {
    try {
      const a = actor && str(actor.agentId) && str(actor.agentName) ? { agentId: str(actor.agentId), agentName: str(actor.agentName) } : null;
      const ids = [...new Set((orderIds || []).map(v => str(v)).filter(Boolean))].slice(0, MAX_IDS);
      if (!a || !ids.length) return { ok: false, skipped: true };
      const entry = {
        v: JOURNAL_VERSION, accountId, sandboxId: str(sandboxId), brokerAccountId: str(brokerAccountId),
        paper: typeof paper === 'boolean' ? paper : null, orderIds: ids, agentId: a.agentId, agentName: a.agentName,
        at: str(at, 64) || new Date().toISOString(), source: source === 'backfill' ? 'backfill' : 'live',
      };
      const key = `${accountId}\0${[...ids].sort().join('\u0001')}\0${a.agentId}\0${a.agentName}`;
      if (this._seen.has(key)) return { ok: true, duplicate: true };
      const file = this.file(accountId);
      await this._enqueue(accountId, async () => {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const handle = await fs.open(file, 'a+');
        try {
          const { size } = await handle.stat();
          let prefix = '';
          if (size > 0) {
            const last = Buffer.alloc(1);
            await handle.read(last, 0, 1, size - 1);
            if (last[0] !== 10) prefix = '\n';
          }
          await handle.appendFile(prefix + JSON.stringify(entry) + '\n');
          await handle.sync();
        } finally { await handle.close(); }
      });
      if (this._seen.size >= DEDUP_CAP) this._seen.clear();
      this._seen.add(key);
      this._status.appended += 1;
      return { ok: true };
    } catch (err) { this._fail(err); throw err; }
  }

  // Builds the same shape as buildOrderActorMap: `${accountId}\0${id}` -> Map(agentId\0agentName -> actor).
  async loadMap(accountId) {
    const map = new Map();
    const report = { entries: 0, malformed: 0, incompleteTail: false, tooLarge: false };
    let text;
    try {
      const file = this.file(accountId);
      const stat = await fs.stat(file);
      if (stat.size > MAX_JOURNAL_BYTES) { report.tooLarge = true; return { map, report }; }
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      if (err?.code === 'ENOENT') return { map, report };
      throw err;
    }
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] !== '') { report.incompleteTail = true; lines.pop(); } else lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let e;
      try { if (line.length > MAX_LINE) throw new Error('long'); e = JSON.parse(line); } catch { report.malformed += 1; continue; }
      if (!e || e.v !== JOURNAL_VERSION || e.accountId !== accountId || !Array.isArray(e.orderIds) || !str(e.agentId) || !str(e.agentName)) { report.malformed += 1; continue; }
      const actor = { agentId: e.agentId, agentName: e.agentName };
      for (const id of e.orderIds) {
        const sid = str(id); if (!sid) continue;
        const k = `${accountId}\0${sid}`;
        if (!map.has(k)) map.set(k, new Map());
        map.get(k).set(`${actor.agentId}\0${actor.agentName}`, actor);
      }
      report.entries += 1;
    }
    return { map, report };
  }
}

// Evidence for one completed tool call, using the production rules (executionEvidence + typed turn-start snapshot only).
export function attributionFromToolEvent(event) {
  if (!isSubmittingOrderToolCall(event)) return null;
  const actor = actorOf(event, null);
  if (!actor) return null;
  const ids = executionOrderIds(event);
  return ids.length ? { actor, orderIds: ids } : null;
}

// Bounded, read-only import of typed-actor evidence from chat-history session files (including orphans).
// Never calls ChatStore (which writes shared caches); only reads session-*.jsonl and appends to the journal.
export async function backfillOrderAttribution({ dataDir, accountId, journal, apply = false, identity = {}, maxLine = 2 * 1024 * 1024 }) {
  const dir = path.join(dataDir, 'sandboxes', accountId, 'chat-history');
  const out = { files: 0, rows: 0, candidates: 0, alreadyRecorded: 0, appended: 0, malformed: 0, oversized: 0, unreadable: 0 };
  let names = [];
  try { names = (await fs.readdir(dir)).filter(n => /^session-.+\.jsonl$/.test(n)).sort(); } catch { return { ...out, dirMissing: true }; }
  const existing = (await journal.loadMap(accountId)).map;
  for (const name of names) {
    out.files += 1;
    let text;
    try {
      const st = await fs.stat(path.join(dir, name));
      if (st.size > 256 * 1024 * 1024) { out.oversized += 1; continue; }
      text = await fs.readFile(path.join(dir, name), 'utf8');
    } catch { out.unreadable += 1; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      if (line.length > maxLine) { out.oversized += 1; continue; }
      let row; try { row = JSON.parse(line); } catch { out.malformed += 1; continue; }
      out.rows += 1;
      const ev = attributionFromToolEvent(row);
      if (!ev) continue;
      out.candidates += 1;
      const have = ev.orderIds.every(id => existing.get(`${accountId}\0${id}`)?.has(`${ev.actor.agentId}\0${ev.actor.agentName}`));
      if (have) { out.alreadyRecorded += 1; continue; }
      if (apply) {
        await journal.record({ accountId, sandboxId: identity.sandboxId, brokerAccountId: identity.brokerAccountId, paper: identity.paper,
          actor: ev.actor, orderIds: ev.orderIds, at: row.timestamp || row.completedAt, source: 'backfill' });
        for (const id of ev.orderIds) {
          const k = `${accountId}\0${id}`; if (!existing.has(k)) existing.set(k, new Map());
          existing.get(k).set(`${ev.actor.agentId}\0${ev.actor.agentName}`, ev.actor);
        }
      }
      out.appended += 1;
    }
  }
  return { ...out, applied: apply };
}
