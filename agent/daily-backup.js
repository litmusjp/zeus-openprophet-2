// Daily in-volume backup of the settings and the trade record (Nov 25, requested by Julian).
//
// What is protected, and why: the settings (agent config, private key store, trading guidance), the IV history, and the TRADE RECORD, which is the only durable
// place that ties an order to its agent and to the AlphaDesk assessment (AlphaDesk computes scores per request and stores none): the order-to-agent
// journal, the chat and activity records (every assessment result lives in them), the decision logs, the daily-loss lock and the per-account trade database.
//
// How: one dated folder per day under `recovery-backups/daily/<YYYY-MM-DD>` (mode 700, files 0600), written to a temp folder and renamed into place; a file that did
// not change since the previous day's backup is HARD-LINKED to that copy (every day is a full snapshot, only changed files cost space); SQLite files use the
// SQLite online backup API (a consistent copy of a live database); every file is hashed into MANIFEST.json (names and hashes, never contents); the newest `keep`
// dated folders are kept and nothing else is ever deleted. It never throws into the app, never touches the live files, and skips when free space is low.
// It is a same-volume copy: it protects against bad saves, deletions and restored defaults, not against losing the volume (an off-volume copy is a separate decision).
import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeCode } from './durable-file.js';

export const BACKUP_DEFAULTS = { keep: 14, minFreeBytes: 600 * 1024 * 1024, startHourEt: 17, tickMs: 15 * 60 * 1000, maxFiles: 50000 };

const SETTINGS_FILES = ['agent-config.json', 'agent-config.json.bak', 'secrets.json', 'secrets.json.bak', 'trading-guidance.json'];
const SANDBOX_FILES = ['order-attribution.jsonl', 'daily-loss-lock.json'];
const SANDBOX_DIRS = ['chat-history', 'activity_logs', 'decisive_actions', 'news_summaries'];
const SQLITE_FILES = ['prophet_trader.db'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;

const nyParts = ms => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

async function exists(p, fsx = fs) { try { await fsx.stat(p); return true; } catch { return false; } }

async function defaultSqliteBackup(src, dest) {
  const { default: Database } = await import('better-sqlite3');
  const handle = await fs.open(dest, 'wx', 0o600); await handle.close();           // restrictive from creation; the backup writes into it
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try { await db.backup(dest); } finally { db.close(); }
}

/** The files to protect, as { rel, abs, kind }. Bounded; names starting with a dot, lock files and old recovery copies are skipped. */
export async function planBackup(root, { maxFiles = BACKUP_DEFAULTS.maxFiles, fsx = fs } = {}) {
  const entries = [];
  let truncated = false;
  const add = (rel, abs, kind = 'file') => { if (entries.length >= maxFiles) { truncated = true; return; } entries.push({ rel, abs, kind }); };
  const walk = async (relDir, absDir, depth = 0) => {
    if (depth > 6) { truncated = true; return; }
    let children;
    try { children = await fsx.readdir(absDir, { withFileTypes: true }); } catch { return; }
    for (const child of children) {
      if (child.name.startsWith('.') || child.isSymbolicLink()) continue;
      const rel = `${relDir}/${child.name}`, abs = path.join(absDir, child.name);
      if (child.isDirectory()) await walk(rel, abs, depth + 1);
      else if (child.isFile()) add(rel, abs);
    }
  };
  for (const name of SETTINGS_FILES) if (await exists(path.join(root, name), fsx)) add(name, path.join(root, name));
  await walk('iv-history', path.join(root, 'iv-history'));
  let sandboxes = [];
  try { sandboxes = (await fsx.readdir(path.join(root, 'sandboxes'), { withFileTypes: true })).filter(d => d.isDirectory() && !d.name.startsWith('.')); } catch { /* none yet */ }
  for (const sandbox of sandboxes) {
    const baseRel = `sandboxes/${sandbox.name}`, baseAbs = path.join(root, 'sandboxes', sandbox.name);
    for (const name of SANDBOX_FILES) if (await exists(path.join(baseAbs, name), fsx)) add(`${baseRel}/${name}`, path.join(baseAbs, name));
    for (const name of SQLITE_FILES) if (await exists(path.join(baseAbs, name), fsx)) add(`${baseRel}/${name}`, path.join(baseAbs, name), 'sqlite');
    for (const name of SANDBOX_DIRS) await walk(`${baseRel}/${name}`, path.join(baseAbs, name));
  }
  return { entries, truncated };
}

async function copyHashed(src, dest) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  const tap = new Transform({ transform(chunk, _enc, cb) { hash.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  await pipeline(createReadStream(src), tap, createWriteStream(dest, { flags: 'wx', mode: 0o600 }));
  return { bytes, sha256: hash.digest('hex') };
}

async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { bytes, sha256: hash.digest('hex') };
}

async function datedFolders(base, fsx = fs) {
  try { return (await fsx.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && DATED.test(d.name)).map(d => d.name).sort(); } catch { return []; }
}

/**
 * One backup run for the NY date of `now`. Returns a summary (counts only) and never throws.
 * status: 'ok' | 'partial' (some files failed; they are counted) | 'exists' (today's backup is already there) | 'skipped_low_space' | 'failed'.
 */
export async function runBackup({ root, now = Date.now(), keep = BACKUP_DEFAULTS.keep, minFreeBytes = BACKUP_DEFAULTS.minFreeBytes, maxFiles = BACKUP_DEFAULTS.maxFiles, fsx = fs, sqliteBackup = defaultSqliteBackup, statfs = fs.statfs } = {}) {
  const { date } = nyParts(now);
  const base = path.join(root, 'recovery-backups', 'daily');
  const final = path.join(base, date);
  const tmp = path.join(base, `.tmp-${date}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  const summary = { status: 'failed', date, files: 0, copied: 0, linked: 0, bytes: 0, errors: 0, truncated: false, kept: 0 };
  try {
    if (await exists(final, fsx)) return { ...summary, status: 'exists', kept: (await datedFolders(base, fsx)).length };
    try {
      const stats = await statfs(root);
      if (Number(stats.bavail) * Number(stats.bsize) < minFreeBytes) return { ...summary, status: 'skipped_low_space' };
    } catch { /* free space unknown: continue (the copy itself is small) */ }
    await fsx.mkdir(base, { recursive: true, mode: 0o700 });
    await fsx.mkdir(tmp, { mode: 0o700 });
    const previousDate = (await datedFolders(base, fsx)).filter(d => d < date).pop();
    let previous = null;
    if (previousDate) { try { previous = JSON.parse(await fsx.readFile(path.join(base, previousDate, 'MANIFEST.json'), 'utf8')); } catch { previous = null; } }
    const previousByRel = new Map((previous?.files || []).map(f => [f.rel, f]));
    const plan = await planBackup(root, { maxFiles, fsx });
    summary.truncated = plan.truncated;
    const manifest = [];
    for (const entry of plan.entries) {
      const dest = path.join(tmp, entry.rel);
      try {
        await fsx.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
        const stat = await fsx.stat(entry.abs);
        const prior = previousByRel.get(entry.rel);
        let record;
        if (entry.kind === 'file' && prior && prior.bytes === stat.size && prior.mtimeMs === Math.floor(stat.mtimeMs) && previousDate) {
          const priorFile = path.join(base, previousDate, entry.rel);
          let priorOk = false;
          try { priorOk = (await fsx.stat(priorFile)).size === prior.bytes; } catch { priorOk = false; }
          if (priorOk) { await fsx.link(priorFile, dest); record = { bytes: prior.bytes, sha256: prior.sha256, linked: true }; }
        }
        if (!record) {
          if (entry.kind === 'sqlite') { await sqliteBackup(entry.abs, dest); const h = await hashFile(dest); record = { ...h, linked: false }; }
          else { const h = await copyHashed(entry.abs, dest); record = { ...h, linked: false }; }
        }
        manifest.push({ rel: entry.rel, bytes: record.bytes, sha256: record.sha256, mtimeMs: Math.floor(stat.mtimeMs), linked: record.linked, kind: entry.kind });
        summary.files += 1; summary.bytes += record.bytes;
        if (record.linked) summary.linked += 1; else summary.copied += 1;
      } catch { summary.errors += 1; }
    }
    if (!manifest.length) { await fsx.rm(tmp, { recursive: true, force: true }); return { ...summary, status: 'failed' }; }
    await fsx.writeFile(path.join(tmp, 'MANIFEST.json'), JSON.stringify({ version: 1, date, createdAt: new Date(now).toISOString(), errors: summary.errors, truncated: plan.truncated, files: manifest }), { mode: 0o600 });
    await fsx.rename(tmp, final);                                              // atomic: a dated folder is either complete or absent
    summary.status = summary.errors ? 'partial' : 'ok';
    const dated = await datedFolders(base, fsx);
    for (const name of dated.slice(0, Math.max(0, dated.length - keep))) await fsx.rm(path.join(base, name), { recursive: true, force: true });
    summary.kept = Math.min(dated.length, keep);
    return summary;
  } catch (error) {
    await fsx.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ...summary, status: 'failed', code: safeCode(error) };
  }
}

/** A scheduler: at most one run at a time, one dated backup per New York date, only after `startHourEt` (after the close and the IV capture). */
export function createDailyBackup({ root, now = Date.now, run = runBackup, startHourEt = BACKUP_DEFAULTS.startHourEt, runOptions = {}, log = () => {} } = {}) {
  let running = false;
  let last = null;
  return {
    async tick() {
      if (running) return { status: 'busy' };
      const t = now();
      const { date, hour } = nyParts(t);
      if (hour < startHourEt) return { status: 'waiting' };
      if (last && last.date === date && (last.status === 'ok' || last.status === 'exists' || last.status === 'partial')) return { status: 'done_today' };
      running = true;
      try {
        last = await run({ root, now: t, ...runOptions });
        log(`daily-backup: ${last.status} (files ${last.files}, copied ${last.copied}, linked ${last.linked}, errors ${last.errors})`);
        return last;
      } catch (error) {
        last = { status: 'failed', date, code: safeCode(error) };
        return last;
      } finally { running = false; }
    },
    status() { return last ? { ...last } : { status: 'not_run_yet' }; },
  };
}

/** GET handler body: counts and labels only (never a file name or a path). */
export function backupStatusPayload(backup, enabled) {
  const s = backup.status();
  return { enabled, status: s.status, date: s.date || null, files: s.files ?? null, copied: s.copied ?? null, linked: s.linked ?? null, bytes: s.bytes ?? null, errors: s.errors ?? null, kept: s.kept ?? null };
}
