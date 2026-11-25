// Daily in-volume backup of the settings and the trade record (Nov 25, requested by Julian; corrected after Hermes' H7 findings, then the H7 final repair brief).
//
// What is protected, and why: the settings (agent config, private key store, trading guidance), the IV history, and the TRADE RECORD, which is the only durable
// place that ties an order to its agent and to the AlphaDesk assessment (AlphaDesk computes scores per request and stores none): the order-to-agent journal, the
// chat and activity records (every assessment result lives in them), the decision logs, the daily-loss lock, the per-account trade database, and the readable
// provenance-bound LEGACY QUARANTINE (non-actionable history the app still displays). Restore only records that were actually persisted; a backup cannot recreate a
// score that was never logged. Root-level legacy data and settings stored in unsupported custom locations are NOT inventoried (listed as excluded in every manifest).
//
// Guarantees and their limits (stated precisely):
//  - Per-file consistency, not a global transaction. Each file is captured from an opened regular-file handle up to the size seen at open (a growing source cannot extend
//    the capture); `.jsonl` files keep only COMPLETE records (a torn tail is discarded and counted); JSON settings and decision files must parse; SQLite databases use the
//    SQLite online backup API (a consistent copy of that database; a live WAL database is handled by the API).
//  - The copied config and private store are a PAIR: each attempt is captured into its own owned attempt folder, the COPIES are accepted only if both parse, pass the pure
//    structural check and the pure reference check (no live key state, no environment, no global bookkeeping), and only then are moved into place. A failed attempt never
//    replaces or removes an accepted pair; exhausted retries leave the snapshot incomplete. Before publication the manifest and counts are RECONCILED against the files
//    actually retained (existence, length, and hash for the settings).
//  - A dated folder `daily/<date>` is published ONLY for a complete snapshot. An incomplete run is kept for diagnosis under `daily/.incomplete/` (never a recovery point,
//    never a hard-link base, never allowed to evict a complete one); its state is persisted in `daily/STATE.json` (a cache: same-day completion is re-confirmed against an
//    owned complete dated manifest) and it is retried with a backoff, bounded per date. The rename gives complete-or-absent DIRECTORY visibility for a process interruption;
//    individual files are not fsynced, so no power-loss durability is claimed.
//  - Resource safety: admission budgets EVERY planned file as a possible full copy (SQLite at main plus WAL), plus retry allowance and a margin, on top of the live reserve;
//    actual opened sizes are re-evaluated before copying and growth that admission did not cover stops the run; per-file, remaining-run and free-space allowances apply to the
//    native SQLite copy as well (checked in its synchronous progress callback and again on the result). Elapsed time is counted from BEFORE planning and checked before work,
//    between chunks and native progress steps, and after the last copy before publication. THE DEADLINE IS COOPERATIVE: a single blocking native step or one stalled system
//    call cannot be interrupted; the run keeps ownership (the scheduler stays busy) until that operation settles, then stops without publishing. It runs sequentially in the
//    server process and shares the volume with the live service; a read-only SQLite handle takes part in normal locking.
//  - Containment: ONE rule (ordinary directories, resolved path inside the real data root, no link traversal) is applied to the daily root, staging, the `.incomplete` holding
//    folder and the scheduler state location BEFORE anything is read, written, enumerated or removed there. Retention and incomplete-pruning select only this module's
//    own owner/version manifests; foreign entries are never counted, sorted or deleted.
//  - Single writer: the guard against overlap covers one scheduler in one process, not two app instances.
//  - Hard links point to the PREVIOUS COMPLETE BACKUP COPY (never a live file) and are used only for non-critical files whose size and mtime match the previous capture (a
//    heuristic, reported as `inherited`, not re-verified). Settings are always copied and validated fresh. Restore by COPYING out, never by editing a snapshot in place.
//  - Same-volume copy: it protects against bad saves, deletions and restored defaults, not against losing the volume.
import fs from 'node:fs/promises';
import { constants as fsConstants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync, statSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeCode } from './durable-file.js';
import { referenceStatusAgainst, structureStatusOf } from './config-secrets.js';

export const BACKUP_DEFAULTS = {
  keep: 14, keepIncomplete: 3,
  reserveBytes: 1024 * 1024 * 1024, marginBytes: 64 * 1024 * 1024,
  maxRunBytes: 2 * 1024 * 1024 * 1024, maxFileBytes: 512 * 1024 * 1024, maxFiles: 50000, maxDepth: 8, maxRunMs: 10 * 60 * 1000,
  recheckEvery: 25, largeFileCheckBytes: 1024 * 1024, startHourEt: 17, tickMs: 15 * 60 * 1000, retryAfterMs: 60 * 60 * 1000, maxAttemptsPerDate: 3, staleStagingMs: 6 * 60 * 60 * 1000,
  pairRetries: 2, pairRetryDelayMs: 500,
};
export const OWNER = 'op2-daily-backup';
export const MANIFEST_VERSION = 2;

const SANDBOX_FILES = ['order-attribution.jsonl', 'daily-loss-lock.json', '.migrated-from-legacy-v2.json'];
const SANDBOX_DIRS = ['chat-history', 'activity_logs', 'decisive_actions', 'news_summaries'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;
const HOLD_NAME = /^\d{4}-\d{2}-\d{2}-\d+-[0-9a-f]{4}$/;
const CRITICAL = new Set(['agent-config.json', 'secrets.json', 'trading-guidance.json']);
const PAIR_RELS = ['agent-config.json', 'secrets.json'];
const EXCLUDED = ['root-level legacy data', 'settings in unsupported custom locations'];
const STATE_MAX_BYTES = 64 * 1024;

const coded = (code, message = code) => Object.assign(new Error(message), { code });
const abortError = label => Object.assign(new Error('abort_' + label), { code: 'ABORT', abort: label });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const nyParts = ms => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

async function lst(fsx, p) {
  try { const stat = await fsx.lstat(p); return { kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other', stat }; }
  catch (error) { return { kind: error?.code === 'ENOENT' ? 'absent' : 'error', code: safeCode(error) }; }
}

/** The ONE output-path rule: an ordinary directory (not a link) whose resolved path stays inside the real data root. Optionally created (mode 0700). Returns the real path. */
async function safeDir(fsx, realRoot, abs, { create = false } = {}) {
  let st = await lst(fsx, abs);
  if (st.kind === 'absent' && create) { await fsx.mkdir(abs, { mode: 0o700 }); st = await lst(fsx, abs); }
  if (st.kind !== 'dir') throw coded('OUTPUT_NOT_DIRECTORY', 'output_not_a_directory');
  const real = await fsx.realpath(abs);
  const rel = path.relative(realRoot, real);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw coded('OUTPUT_OUTSIDE_ROOT', 'output_outside_root');
  return real;
}

/** Validates (and creates when asked) root/recovery-backups/daily under the real data root. Returns { realRoot, base, realBase }. */
async function ensureOutput(root, fsx, { create = true } = {}) {
  const realRoot = await fsx.realpath(root);
  let current = root, realBase = realRoot;
  for (const part of ['recovery-backups', 'daily']) { current = path.join(current, part); realBase = await safeDir(fsx, realRoot, current, { create }); }
  return { realRoot, base: current, realBase };
}

/** The default sources for the settings, from their owners' paths. */
export function settingsSources({ root, configPath, secretsPath, guidancePath } = {}) {
  const config = configPath || path.join(root, 'agent-config.json');
  const secrets = secretsPath || path.join(root, 'secrets.json');
  const guidance = guidancePath || path.join(root, 'trading-guidance.json');
  return [
    { rel: 'agent-config.json', abs: config, required: true },
    { rel: 'agent-config.json.bak', abs: config + '.bak' },
    { rel: 'secrets.json', abs: secrets },
    { rel: 'secrets.json.bak', abs: secrets + '.bak' },
    { rel: 'trading-guidance.json', abs: guidance },
  ];
}

/**
 * Plans the sources. Returns { entries, errors, truncated, missing, skippedLinks }. Optional absence (ENOENT) is fine; any other I/O error, a link where a regular
 * file or folder is expected, or a hit of the file/depth cap is recorded and makes the snapshot incomplete. Traversal STOPS at the cap. `bound` is the most a copy of
 * the entry can need (a SQLite database: its main file PLUS its write-ahead log). `deadline` (optional) is called as the plan advances and may throw to stop it.
 */
export async function planBackup({ root, settings, maxFiles = BACKUP_DEFAULTS.maxFiles, maxDepth = BACKUP_DEFAULTS.maxDepth, fsx = fs, deadline = null } = {}) {
  const state = { entries: [], errors: [], truncated: false, missing: 0, skippedLinks: 0, stop: false };
  const add = entry => { if (state.entries.length >= maxFiles) { state.truncated = true; state.stop = true; return; } state.entries.push(entry); };
  const note = code => state.errors.push({ code });
  const tick = () => { if (deadline) deadline(); };

  const addFile = async (rel, abs, extra = {}) => {
    tick();
    const st = await lst(fsx, abs);
    if (st.kind === 'absent') return false;
    if (st.kind === 'link') { note('link_unsupported'); return false; }
    if (st.kind === 'error') { note(st.code); return false; }
    if (st.kind !== 'file') { note('not_a_file'); return false; }
    add({ rel, abs, kind: 'file', size: st.stat.size, bound: st.stat.size, mtimeMs: Math.floor(st.stat.mtimeMs), critical: CRITICAL.has(path.basename(rel)), jsonl: rel.endsWith('.jsonl'), ...extra });
    return true;
  };
  const addSqlite = async (rel, abs, st, extra = {}) => {
    let wal = 0;
    const w = await lst(fsx, abs + '-wal');
    if (w.kind === 'file') wal = w.stat.size; else if (w.kind === 'link') note('link_unsupported'); else if (w.kind === 'error') note(w.code);
    add({ rel, abs, kind: 'sqlite', size: st.stat.size, bound: st.stat.size + wal, walSize: wal, mtimeMs: Math.floor(st.stat.mtimeMs), critical: false, jsonl: false, ...extra });
  };
  const walk = async (relDir, absDir, depth, extra = {}) => {
    if (state.stop) return;
    tick();
    const start = await lst(fsx, absDir);
    if (start.kind === 'absent') return;
    if (start.kind === 'link') { note('link_unsupported'); return; }
    if (start.kind === 'error') { note(start.code); return; }
    if (start.kind !== 'dir') { note('not_a_directory'); return; }
    if (depth > maxDepth) { state.truncated = true; return; }
    let dir;
    try { dir = await fsx.opendir(absDir); } catch (error) { note(safeCode(error)); return; }
    try {
      for await (const child of dir) {
        if (state.stop) break;
        tick();
        if (child.name.startsWith('.') || child.name.endsWith('-wal') || child.name.endsWith('-shm')) continue;
        if (child.isSymbolicLink()) { state.skippedLinks += 1; continue; }
        const rel = `${relDir}/${child.name}`, abs = path.join(absDir, child.name);
        if (child.isDirectory()) await walk(rel, abs, depth + 1, extra);
        else if (child.isFile()) {
          if (child.name.endsWith('.db')) {
            const st = await lst(fsx, abs);
            if (st.kind === 'file') await addSqlite(rel, abs, st, extra);
            else note(st.kind === 'error' ? st.code : 'not_a_file');
          } else await addFile(rel, abs, extra);
        }
      }
    } catch (error) { if (error?.abort) throw error; note(safeCode(error)); }
    finally { try { await dir.close(); } catch { /* closed by the iterator */ } }
  };

  for (const source of settingsSources({ root, ...settings })) {
    const found = await addFile(source.rel, source.abs);
    if (!found && source.required) { const st = await lst(fsx, source.abs); if (st.kind === 'absent') state.missing += 1; }
  }
  await walk('iv-history', path.join(root, 'iv-history'), 0);
  const sandboxRoot = path.join(root, 'sandboxes');
  const top = await lst(fsx, sandboxRoot);
  if (top.kind === 'error') note(top.code);
  else if (top.kind === 'link') note('link_unsupported');
  else if (top.kind === 'dir') {
    let dir;
    try { dir = await fsx.opendir(sandboxRoot); } catch (error) { note(safeCode(error)); }
    if (dir) {
      try {
        for await (const child of dir) {
          if (state.stop) break;
          if (child.name.startsWith('.') || child.isSymbolicLink() || !child.isDirectory()) continue;
          const baseRel = `sandboxes/${child.name}`, baseAbs = path.join(sandboxRoot, child.name);
          for (const name of SANDBOX_FILES) await addFile(`${baseRel}/${name}`, path.join(baseAbs, name));
          const db = await lst(fsx, path.join(baseAbs, 'prophet_trader.db'));
          if (db.kind === 'file') await addSqlite(`${baseRel}/prophet_trader.db`, path.join(baseAbs, 'prophet_trader.db'), db);
          else if (db.kind === 'link') note('link_unsupported'); else if (db.kind === 'error') note(db.code);
          for (const name of SANDBOX_DIRS) await walk(`${baseRel}/${name}`, path.join(baseAbs, name), 0);
        }
      } catch (error) { if (error?.abort) throw error; note(safeCode(error)); }
      finally { try { await dir.close(); } catch { /* closed */ } }
    }
  }
  await walk('quarantine/legacy', path.join(root, 'quarantine', 'legacy'), 0, { legacy: true });
  return state;
}

async function readManifest(dir, fsx = fs) {
  try {
    if ((await lst(fsx, path.join(dir, 'MANIFEST.json'))).kind !== 'file') return null;     // a link (or anything but an ordinary file) is never trusted
    const manifest = JSON.parse(await fsx.readFile(path.join(dir, 'MANIFEST.json'), 'utf8'));
    return manifest && manifest.owner === OWNER && manifest.version === MANIFEST_VERSION && Array.isArray(manifest.files) ? manifest : null;
  } catch { return null; }
}

/** Dated folders that are COMPLETE snapshots owned by this module (anything else, including foreign date-named folders, is ignored). */
async function ownedSnapshots(base, fsx = fs) {
  const out = [];
  let names = [];
  try { names = (await fsx.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && !d.isSymbolicLink() && DATED.test(d.name)).map(d => d.name).sort(); } catch { return out; }
  for (const name of names) { const manifest = await readManifest(path.join(base, name), fsx); if (manifest && manifest.complete === true && manifest.date === name) out.push({ name, manifest }); }
  return out;
}

async function removeOwned(base, name, fsx) {
  const dir = path.join(base, name);
  const st = await lst(fsx, dir);
  if (st.kind !== 'dir') return false;
  const realBase = await fsx.realpath(base), real = await fsx.realpath(dir);
  if (!real.startsWith(realBase + path.sep)) return false;                    // a redirected folder is never removed
  await fsx.rm(dir, { recursive: true, force: true });
  return true;
}

async function cleanStaging(base, fsx, now, staleMs) {
  let names = [];
  try { names = (await fsx.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && !d.isSymbolicLink() && d.name.startsWith('.tmp-')).map(d => d.name); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    try {
      const owner = JSON.parse(await fsx.readFile(path.join(base, name, '.owner'), 'utf8'));
      if (owner?.owner === OWNER && now - Number(owner.startedAt) > staleMs && await removeOwned(base, name, fsx)) removed += 1;
    } catch { /* not provably ours: left alone */ }
  }
  return removed;
}

/** Keeps the newest `keep` of THIS module's valid incomplete folders in the (already validated) holding folder. Anything else in there is foreign: never counted or removed. */
async function pruneIncomplete(holding, fsx, keep) {
  let entries = [];
  try { entries = await fsx.readdir(holding, { withFileTypes: true }); } catch { return 0; }
  const owned = [];
  for (const d of entries) {
    if (!d.isDirectory() || d.isSymbolicLink() || !HOLD_NAME.test(d.name)) continue;
    const manifest = await readManifest(path.join(holding, d.name), fsx);
    if (manifest && manifest.complete === false) owned.push({ name: d.name, at: Date.parse(manifest.createdAt) || 0 });
  }
  owned.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  let removed = 0;
  for (const old of owned.slice(0, Math.max(0, owned.length - keep))) if (await removeOwned(holding, old.name, fsx)) removed += 1;
  return removed;
}

/** SQLite online backup of a read-only handle. `guard` is called SYNCHRONOUSLY from the progress callback (it may throw to stop the copy; it must not return a Promise). */
async function sqliteBackupDefault(src, dest, { guard } = {}) {
  const { default: Database } = await import('better-sqlite3');
  const handle = await fs.open(dest, 'wx', 0o600); await handle.close();
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try {
    const pageSize = Number(db.pragma('page_size', { simple: true })) || 4096;
    await db.backup(dest, { progress: info => { if (guard) guard({ pagesDone: info.totalPages - info.remainingPages, totalPages: info.totalPages, pageSize }); } });
  } finally { db.close(); }
}
async function sqliteVerifyDefault(dest) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dest, { readonly: true, fileMustExist: true });
  try { return db.pragma('quick_check', { simple: true }) === 'ok'; } finally { db.close(); }
}

/** Writes the WHOLE slice: loops on a partial write and fails on zero or missing progress (never assumes the full length was written). */
async function writeFully(handle, buffer, length, position) {
  let done = 0;
  while (done < length) {
    const result = await handle.write(buffer, done, length - done, position + done);
    const written = Number(result?.bytesWritten);
    if (!Number.isFinite(written) || written <= 0) throw coded('SHORT_WRITE', 'destination_write_made_no_progress');
    done += written;
  }
}

/** Bounded capture of ONE regular file: size fixed at open, re-evaluated by `onOpen` before any copy, `.jsonl` keeps complete records only. */
async function captureFile(entry, dest, { fsx, maxFileBytes, onOpen = null, deadline = null }) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const src = await fsx.open(entry.abs, flags);
  let out;
  try {
    const stat = await src.stat();
    if (!stat.isFile()) throw coded('NOT_A_FILE', 'not_a_file');
    if (stat.size > maxFileBytes) throw coded('OVERSIZED', 'oversized');
    if (onOpen) await onOpen(stat.size);
    const budget = stat.size;                                                   // fixed at open: later appends cannot extend this capture
    out = await fsx.open(dest, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(budget, 1)));
    let copied = 0, lastNewline = -1;
    while (copied < budget) {
      if (deadline) deadline();
      const { bytesRead } = await src.read(buffer, 0, Math.min(buffer.length, budget - copied), copied);
      if (!bytesRead) break;
      if (entry.jsonl) { const at = buffer.subarray(0, bytesRead).lastIndexOf(0x0a); if (at >= 0) lastNewline = copied + at; }
      await writeFully(out, buffer, bytesRead, copied);
      copied += bytesRead;
    }
    let kept = copied, discardedTail = 0;
    if (entry.jsonl && kept > 0 && lastNewline + 1 < kept) { discardedTail = kept - (lastNewline + 1); kept = lastNewline + 1; await out.truncate(kept); }
    else if (entry.jsonl && kept > 0 && lastNewline < 0) { discardedTail = kept; kept = 0; await out.truncate(0); }
    await out.sync();
    return { srcSize: stat.size, bytes: kept, written: copied, discardedTail };
  } finally {
    await src.close().catch(() => {});
    if (out) await out.close().catch(() => {});
  }
}

async function hashFile(file, fsx, deadline = null) {
  const hash = crypto.createHash('sha256');
  const handle = await fsx.open(file, 'r');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { if (deadline) deadline(); const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead; }
  } finally { await handle.close(); }
  return { bytes, sha256: hash.digest('hex') };
}

const resolveNow = now => { const v = typeof now === 'function' ? Number(now()) : Number(now); return Number.isFinite(v) ? v : Date.now(); };

/**
 * One backup run for the NY date of `now` (a number or a function; omitted means the current time). Returns a summary (counts only) and never throws. status:
 * 'ok' (complete snapshot published) | 'incomplete' (kept under .incomplete when it can be, not a recovery point) | 'exists' (today's COMPLETE snapshot is already there)
 * | 'skipped_low_space' | 'skipped_capacity_unknown' | 'skipped_run_too_large' | 'aborted_low_space' | 'blocked_foreign_folder' | 'failed'.
 */
export async function runBackup(options = {}) {
  const o = { ...BACKUP_DEFAULTS, ...options };
  const { root, settings = {}, fsx = fs, sqliteBackup = sqliteBackupDefault, sqliteVerify = sqliteVerifyDefault, statfs = fs.statfs } = o;
  const clock = typeof o.clock === 'function' ? o.clock : Date.now;
  const startedAt = clock();                                                    // elapsed accounting starts BEFORE planning
  const nowMs = resolveNow(o.now);
  const { date } = nyParts(nowMs);
  const summary = { status: 'failed', date, complete: false, files: 0, copied: 0, linked: 0, bytes: 0, errors: 0, truncated: false, missing: 0, discardedTails: 0, kept: 0 };
  const deadline = () => { if (clock() - startedAt > o.maxRunMs) throw abortError('time_budget'); };
  let tmp = null;
  try {
    deadline();
    const { base } = await ensureOutput(root, fsx);
    const final = path.join(base, date);
    const existing = await lst(fsx, final);
    if (existing.kind !== 'absent') {
      const manifest = existing.kind === 'dir' ? await readManifest(final, fsx) : null;
      if (manifest?.complete === true && manifest.date === date) return { ...summary, status: 'exists', complete: true, files: manifest.counts?.files ?? manifest.files.length, copied: manifest.counts?.copied ?? 0, linked: manifest.counts?.linked ?? 0, bytes: manifest.counts?.bytes ?? 0, kept: (await ownedSnapshots(base, fsx)).length };
      return { ...summary, status: 'blocked_foreign_folder' };
    }
    await cleanStaging(base, fsx, nowMs, o.staleStagingMs);
    const owned = await ownedSnapshots(base, fsx);
    const previous = owned.filter(s => s.name < date).pop() || null;
    const previousByRel = new Map((previous?.manifest.files || []).map(f => [f.rel, f]));

    let plan;
    try { plan = await planBackup({ root, settings, maxFiles: o.maxFiles, maxDepth: o.maxDepth, fsx, deadline }); }
    catch (error) { if (error?.abort) return { ...summary, status: 'incomplete', errors: 1 }; throw error; }
    summary.truncated = plan.truncated; summary.missing = plan.missing;
    let errorCount = plan.errors.length;
    const errorCodes = {};
    for (const e of plan.errors) errorCodes[e.code] = (errorCodes[e.code] || 0) + 1;
    const addError = code => { errorCount += 1; errorCodes[code] = (errorCodes[code] || 0) + 1; };

    const priorMatches = e => { const p = previousByRel.get(e.rel); return !!p && e.kind === 'file' && !e.critical && p.srcSize === e.size && p.mtimeMs === e.mtimeMs; };
    const pairOn = plan.entries.some(e => e.rel === 'agent-config.json');
    const pairEntries = pairOn ? plan.entries.filter(e => PAIR_RELS.includes(e.rel)) : [];
    const isPair = e => pairEntries.includes(e);
    // Admission: EVERY planned file is budgeted as a possible full copy (a hard link may not be possible when it is made), a SQLite database at main PLUS write-ahead log,
    // the settings pair once per retry, and a margin, on top of the live reserve.
    const pairBytes = pairEntries.reduce((n, e) => n + e.bound, 0);
    const estimate = plan.entries.reduce((n, e) => n + e.bound, 0) + pairBytes * o.pairRetries + o.marginBytes;
    if (estimate > o.maxRunBytes) return { ...summary, status: 'skipped_run_too_large', files: plan.entries.length };
    const freeBytes = async () => { try { const s = await statfs(root); const free = Number(s.bavail) * Number(s.bsize); return Number.isFinite(free) ? free : null; } catch { return null; } };
    const free0 = await freeBytes();
    if (free0 === null) return { ...summary, status: 'skipped_capacity_unknown' };
    if (free0 < o.reserveBytes + estimate) return { ...summary, status: 'skipped_low_space' };
    deadline();

    tmp = path.join(base, `.tmp-${date}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    await fsx.mkdir(tmp, { mode: 0o700 });
    await fsx.writeFile(path.join(tmp, '.owner'), JSON.stringify({ owner: OWNER, startedAt: nowMs, pid: process.pid }), { mode: 0o600 });
    const manifest = [];
    let spent = 0, sinceCheck = 0, aborted = null, failed = 0;
    let remaining = plan.entries.reduce((n, e) => n + e.bound, 0);              // outstanding ledger: planned bound of everything not yet processed, the pending settings pair INCLUDED
    let retryHeadroom = pairBytes * o.pairRetries;                               // temporary space the pending settings retries may need; held until the pair is done
    const othersAfter = entry => Math.max(0, remaining - entry.bound) + retryHeadroom;

    const admitOpen = entry => async actual => {                                // re-evaluates the ACTUAL opened size before an ordinary copy
      if (spent + actual > o.maxRunBytes) throw abortError('run_budget');
      const grew = actual > entry.bound;
      if (grew || actual >= o.largeFileCheckBytes) {
        const free = await freeBytes();
        if (free === null || free < o.reserveBytes + actual + othersAfter(entry)) throw abortError('low_space');   // this copy PLUS every other outstanding allocation must fit above the reserve
      }
    };
    const ctxFor = entry => ({ fsx, maxFileBytes: o.maxFileBytes, onOpen: admitOpen(entry), deadline });

    const copyOne = async entry => {
      const dest = path.join(tmp, entry.rel);
      await fsx.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      const prior = previousByRel.get(entry.rel);
      if (priorMatches(entry)) {
        const priorFile = path.join(base, previous.name, entry.rel);
        let ok = false;
        try { ok = (await fsx.lstat(priorFile)).size === prior.bytes; } catch { ok = false; }
        if (ok) { await fsx.link(priorFile, dest); return { bytes: prior.bytes, sha256: prior.sha256, srcSize: prior.srcSize, mtimeMs: prior.mtimeMs, discardedTail: prior.discardedTail || 0, linked: true }; }
      }
      if (entry.kind === 'sqlite') {
        const actualMain = (await fsx.lstat(entry.abs)).size;
        const wal = await lst(fsx, entry.abs + '-wal');
        const bound = actualMain + (wal.kind === 'file' ? wal.stat.size : 0);
        const free = await freeBytes();
        if (free === null) throw abortError('low_space');
        const others = othersAfter(entry);
        const allowance = Math.min(o.maxFileBytes, o.maxRunBytes - spent - others, free - o.reserveBytes - others);   // the native copy may use only what the other outstanding work leaves
        if (bound > o.maxFileBytes) throw coded('OVERSIZED', 'oversized');
        if (bound > o.maxRunBytes - spent - others) throw abortError('run_budget');
        if (bound > free - o.reserveBytes - others) throw abortError('low_space');
        const guard = () => { deadline(); let size = 0; try { size = statSync(dest).size; } catch { size = 0; } if (size > allowance) throw coded('OVERSIZED', 'native_copy_exceeded_allowance'); };
        try { await sqliteBackup(entry.abs, dest, { guard, allowance }); }
        catch (error) { await fsx.rm(dest, { force: true }).catch(() => {}); throw error; }
        const size = (await fsx.lstat(dest)).size;
        spent += size;
        if (size > allowance) { await fsx.rm(dest, { force: true }).catch(() => {}); throw coded('OVERSIZED', 'native_copy_exceeded_allowance'); }
        deadline();
        if (!(await sqliteVerify(dest))) throw coded('SQLITE_CHECK', 'sqlite_check');
        const h = await hashFile(dest, fsx, deadline);
        deadline();
        return { ...h, srcSize: entry.size, mtimeMs: entry.mtimeMs, discardedTail: 0, linked: false };
      }
      let captured;
      try { captured = await captureFile(entry, dest, ctxFor(entry)); }
      catch (error) { await fsx.rm(dest, { force: true }).catch(() => {}); throw error; }      // never retain an unlisted partial copy
      spent += captured.written;
      if (CRITICAL.has(path.basename(entry.rel).replace(/\.bak$/, '')) || entry.rel.endsWith('chat-history/sessions.json')) {   // only the files a restore depends on must parse
        const parses = async () => { try { const v = JSON.parse(await fsx.readFile(dest, 'utf8')); return v !== undefined; } catch { return false; } };
        if (!(await parses())) {                                                // an in-place writer may have been mid-write: one bounded retry
          await fsx.rm(dest, { force: true }); await sleep(250); deadline();
          captured = await captureFile(entry, dest, ctxFor(entry));
          spent += captured.written;
          if (!(await parses())) throw coded('INVALID_JSON', 'invalid_json');
        }
      }
      const h = await hashFile(dest, fsx, deadline);
      return { ...h, srcSize: captured.srcSize, mtimeMs: entry.mtimeMs, discardedTail: captured.discardedTail, linked: false };
    };

    const take = (entry, record) => manifest.push({ rel: entry.rel, kind: entry.kind, bytes: record.bytes, sha256: record.sha256, srcSize: record.srcSize, mtimeMs: record.mtimeMs, discardedTail: record.discardedTail, linked: record.linked, legacyNonActionable: entry.legacy === true });

    for (const entry of plan.entries) {
      if (isPair(entry)) continue;                                               // the settings pair stays in the ledger until it is processed below
      try {
        deadline();
        if (++sinceCheck >= o.recheckEvery) {
          sinceCheck = 0;
          const free = await freeBytes();
          if (free === null || free < o.reserveBytes) throw abortError('low_space');
        }
        const record = await copyOne(entry);
        take(entry, record);
      } catch (error) {
        if (error?.abort) { aborted = error.abort; break; }
        failed += 1; addError(safeCode(error));
      } finally { remaining -= entry.bound; }
    }

    // The copied config and private store: each attempt is captured into its OWN owned attempt folder, accepted only as a structurally valid, reference-resolving pair, and
    // only then moved into place. A failed attempt never replaces or removes an accepted pair; exhausted retries leave the snapshot incomplete.
    if (!aborted && pairEntries.length) {
      let accepted = null, lastCode = 'settings_pair_unresolved';
      try {
        for (let attempt = 0; attempt <= o.pairRetries && !accepted; attempt += 1) {
          deadline();
          const result = await pairAttempt(attempt);
          if (result.ok) accepted = result.records; else { lastCode = result.code; if (attempt < o.pairRetries) { await sleep(o.pairRetryDelayMs); } }
        }
      } catch (error) { if (error?.abort) aborted = error.abort; else throw error; }
      remaining -= pairBytes; retryHeadroom = 0;
      if (accepted) for (const r of accepted) take(r.entry, r.record);
      else if (!aborted) { failed += pairEntries.length; addError(lastCode); }
    }

    async function pairAttempt(n) {
      const dir = path.join(tmp, `.pair-${n}`);
      const placed = [];
      try {
        await fsx.mkdir(dir, { mode: 0o700 });
        const got = [];
        for (const entry of pairEntries) {
          deadline();
          const dest = path.join(dir, entry.rel);
          const c = await captureFile(entry, dest, { fsx, maxFileBytes: o.maxFileBytes, onOpen: admitOpen({ bound: entry.bound }), deadline });
          spent += c.written;
          got.push({ entry, dest, c, h: await hashFile(dest, fsx, deadline) });
        }
        const readJson = async file => JSON.parse(await fsx.readFile(file, 'utf8'));
        const configGot = got.find(g => g.entry.rel === 'agent-config.json'), secretsGot = got.find(g => g.entry.rel === 'secrets.json');
        let config, store = null;
        try { config = await readJson(configGot.dest); if (secretsGot) store = await readJson(secretsGot.dest); } catch { return { ok: false, code: 'INVALID_JSON' }; }
        if (!structureStatusOf(config, store).ok) return { ok: false, code: 'CONFIG_STRUCTURE_REJECTED' };
        if (!referenceStatusAgainst(config, store).ok) return { ok: false, code: 'settings_pair_unresolved' };
        for (const g of got) { const target = path.join(tmp, g.entry.rel); await fsx.rename(g.dest, target); placed.push(target); }
        return { ok: true, records: got.map(g => ({ entry: g.entry, record: { ...g.h, srcSize: g.c.srcSize, mtimeMs: g.entry.mtimeMs, discardedTail: g.c.discardedTail, linked: false } })) };
      } catch (error) {
        if (error?.abort) throw error;
        for (const target of placed) await fsx.rm(target, { force: true }).catch(() => {});
        return { ok: false, code: safeCode(error) };
      } finally { await fsx.rm(dir, { recursive: true, force: true }).catch(() => {}); }
    }

    if (!aborted) { try { deadline(); } catch (error) { if (error?.abort) aborted = error.abort; else throw error; } }   // after the last copy and pair retry, before anything is published
    if (aborted) addError('aborted_' + aborted);

    // Reconcile the manifest with the files actually retained: existence, length, and hash for the settings; counts come from what is really there.
    const retained = [];
    try {
      for (const m of manifest) {
        deadline();
        try {
          const st = await fsx.lstat(path.join(tmp, m.rel));
          if (!st.isFile() || st.size !== m.bytes) throw coded('MANIFEST_MISMATCH');
          if (CRITICAL.has(path.basename(m.rel).replace(/\.bak$/, '')) && !m.linked) { const h = await hashFile(path.join(tmp, m.rel), fsx, deadline); if (h.sha256 !== m.sha256) throw coded('MANIFEST_MISMATCH'); }
          retained.push(m);
        } catch (error) { if (error?.abort) throw error; failed += 1; addError('manifest_mismatch'); }
        deadline();
      }
    } catch (error) { if (error?.abort) { if (!aborted) { aborted = error.abort; addError('aborted_' + aborted); } } else throw error; }
    if (!aborted && retained.length + failed !== plan.entries.length) addError('inventory_mismatch');
    summary.files = retained.length;
    summary.copied = retained.filter(m => !m.linked).length;
    summary.linked = retained.filter(m => m.linked).length;
    summary.bytes = retained.reduce((n, m) => n + m.bytes, 0);
    summary.discardedTails = retained.filter(m => m.discardedTail).length;
    const buildManifest = isComplete => ({ version: MANIFEST_VERSION, owner: OWNER, date, createdAt: new Date(nowMs).toISOString(), complete: isComplete, counts: { files: summary.files, copied: summary.copied, linked: summary.linked, bytes: summary.bytes, errors: errorCount, discardedTails: summary.discardedTails, skippedLinks: plan.skippedLinks }, truncated: plan.truncated, missing: plan.missing, errorCodes, excluded: EXCLUDED, scope: 'canonical records + settings + iv-history + legacy quarantine (non-actionable)', files: retained });
    let complete = errorCount === 0 && !plan.truncated && plan.missing === 0 && !aborted;
    const lateExpiry = () => { try { deadline(); return false; } catch (error) { if (!error?.abort) throw error; aborted = aborted || error.abort; addError('aborted_' + error.abort); return true; } };
    if (complete && lateExpiry()) complete = false;
    summary.errors = errorCount;
    await fsx.writeFile(path.join(tmp, 'MANIFEST.json'), JSON.stringify(buildManifest(complete)), { mode: 0o600 });
    await fsx.rm(path.join(tmp, '.owner'), { force: true });
    if (complete && lateExpiry()) {                                              // expired while preparing the manifest: the folder must not become a recovery point
      complete = false; summary.errors = errorCount;
      await fsx.writeFile(path.join(tmp, 'MANIFEST.json'), JSON.stringify(buildManifest(false)), { mode: 0o600 });
    }
    if (complete) {
      await fsx.rename(tmp, final); tmp = null;                                  // complete-or-absent directory visibility; no power-loss claim
      summary.status = 'ok'; summary.complete = true;
      const snapshots = await ownedSnapshots(base, fsx);
      for (const old of snapshots.slice(0, Math.max(0, snapshots.length - o.keep))) await removeOwned(base, old.name, fsx);
      summary.kept = Math.min(snapshots.length, o.keep);
    } else {
      const { realRoot } = await ensureOutput(root, fsx, { create: false });
      const holding = path.join(base, '.incomplete');
      await safeDir(fsx, realRoot, holding, { create: true });                  // the same containment rule BEFORE anything is written or pruned there
      await fsx.rename(tmp, path.join(holding, `${date}-${nowMs}-${crypto.randomBytes(2).toString('hex')}`)); tmp = null;
      summary.status = aborted === 'low_space' ? 'aborted_low_space' : 'incomplete';
      await pruneIncomplete(holding, fsx, o.keepIncomplete);
      summary.kept = (await ownedSnapshots(base, fsx)).length;
    }
    return summary;
  } catch (error) {
    if (tmp) await fsx.rm(tmp, { recursive: true, force: true }).catch(() => {});
    if (error?.abort) return { ...summary, status: 'incomplete', errors: Math.max(1, summary.errors) };
    return { ...summary, status: 'failed', code: safeCode(error) };
  }
}

// ── scheduler state (daily/STATE.json): a typed, bounded CACHE; damaged or unsafe state never stops the service ─────────────────────────────────────────────
const KNOWN_STATUS = new Set(['not_run_yet', 'ok', 'incomplete', 'exists', 'skipped_low_space', 'skipped_capacity_unknown', 'skipped_run_too_large', 'aborted_low_space', 'blocked_foreign_folder', 'failed', 'state_unavailable', 'dated_point_missing']);
const NUMERIC_FIELDS = ['files', 'copied', 'linked', 'bytes', 'errors', 'missing', 'discardedTails', 'attempts', 'lastAttemptAt', 'kept'];

/** Reduces anything read from disk to the known labels and numbers; unknown keys, wrong types and unknown status labels are dropped. */
function sanitizeState(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = { status: KNOWN_STATUS.has(value.status) ? value.status : 'not_run_yet' };
  if (typeof value.date === 'string' && DATED.test(value.date)) out.date = value.date;
  if (value.lastCompleteDate === null || (typeof value.lastCompleteDate === 'string' && DATED.test(value.lastCompleteDate))) out.lastCompleteDate = value.lastCompleteDate;
  for (const key of ['complete', 'truncated']) if (typeof value[key] === 'boolean') out[key] = value[key];
  for (const key of NUMERIC_FIELDS) if (typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) out[key] = value[key];
  if (typeof value.code === 'string' && /^[A-Za-z0-9_:-]{1,40}$/.test(value.code)) out.code = value.code;
  return out;
}

/** Synchronous, containment-checked, bounded read at construction. Returns { state } or { unavailable: true }. An absent file is not an error. */
function loadStateSync(root) {
  let fd = null;
  try {
    const realRoot = realpathSync(root);
    let current = root;
    for (const part of ['recovery-backups', 'daily']) {
      current = path.join(current, part);
      let st; try { st = lstatSync(current); } catch (error) { if (error?.code === 'ENOENT') return { state: null }; throw error; }
      if (!st.isDirectory()) return { unavailable: true };
      const rel = path.relative(realRoot, realpathSync(current));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { unavailable: true };
    }
    const file = path.join(current, 'STATE.json');
    let st; try { st = lstatSync(file); } catch (error) { if (error?.code === 'ENOENT') return { state: null }; throw error; }
    if (!st.isFile() || st.nlink > 1 || st.size > STATE_MAX_BYTES) return { unavailable: true };   // a link, a hard-linked inode or an oversized file is never trusted
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.nlink > 1 || fst.size > STATE_MAX_BYTES) return { unavailable: true };
    const buffer = Buffer.alloc(fst.size);
    let read = 0;
    while (read < fst.size) { const n = readSync(fd, buffer, read, fst.size - read, read); if (!n) break; read += n; }
    const state = sanitizeState(JSON.parse(buffer.subarray(0, read).toString('utf8')));
    return state ? { state } : { unavailable: true };
  } catch { return { unavailable: true }; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } } }
}

/** Atomic publication of the state: an exclusive restricted temp file inside the validated daily folder, then a rename that replaces ONLY the name `STATE.json`. */
async function persistStateFile(root, fsx, state) {
  const { base } = await ensureOutput(root, fsx);
  const file = path.join(base, 'STATE.json');
  const temp = path.join(base, `.state-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  let handle = null;
  try {
    handle = await fsx.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(sanitizeState(state) || { status: 'not_run_yet' }));
    await handle.sync(); await handle.close(); handle = null;
    await fsx.rename(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fsx.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** True only if an owned COMPLETE dated manifest for `date` really exists in the validated daily folder. */
async function datedPointExists(root, fsx, date) {
  try {
    const { base, realBase } = await ensureOutput(root, fsx, { create: false });
    const leaf = path.join(base, date);
    if ((await lst(fsx, leaf)).kind !== 'dir') return false;                    // a linked or non-directory dated leaf is not a recovery point
    const rel = path.relative(realBase, await fsx.realpath(leaf));
    if (rel !== date) return false;
    const manifest = await readManifest(leaf, fsx);
    return !!manifest && manifest.complete === true && manifest.date === date;
  } catch { return false; }
}

/**
 * Scheduler: at most one run at a time; one COMPLETE snapshot per New York date after `startHourEt`; an incomplete or skipped run is retried with a backoff
 * (bounded attempts per date). Its state survives a restart (daily/STATE.json: counts and labels only) but is only a cache: a stored "complete" is re-confirmed against
 * an owned complete dated manifest before it is trusted. State problems degrade to in-memory state; they never throw into the service.
 */
export function createDailyBackup({ root, settings = {}, now = Date.now, run = runBackup, startHourEt = BACKUP_DEFAULTS.startHourEt, retryAfterMs = BACKUP_DEFAULTS.retryAfterMs, maxAttemptsPerDate = BACKUP_DEFAULTS.maxAttemptsPerDate, runOptions = {}, fsx = fs, log = () => {} } = {}) {
  let running = false;
  let state = { status: 'not_run_yet' };
  try { const loaded = loadStateSync(root); if (loaded.state) state = loaded.state; else if (loaded.unavailable) state = { status: 'state_unavailable' }; } catch { state = { status: 'state_unavailable' }; }
  const persist = async () => { try { await persistStateFile(root, fsx, state); } catch { /* the state is a cache; the in-memory copy stays authoritative for this process */ } };
  return {
    async tick() {
      if (running) return { status: 'busy' };
      const t = resolveNow(now);
      const { date, hour } = nyParts(t);
      if (hour < startHourEt) return { status: 'waiting' };
      running = true;
      try {
        if (state.date === date && state.complete === true) {
          if (await datedPointExists(root, fsx, date)) return { status: 'done_today' };
          state = { ...state, status: 'dated_point_missing', complete: false, attempts: 0, lastAttemptAt: 0 };   // the cache said done, the proof is gone
        }
        if (state.date === date && state.complete !== true) {
          if ((state.attempts || 0) >= maxAttemptsPerDate) return { status: 'gave_up_today' };
          if (t - Number(state.lastAttemptAt || 0) < retryAfterMs) return { status: 'retry_later' };
        }
        const result = await run({ root, settings, fsx, now: t, ...runOptions });
        const attempts = state.date === date ? (state.attempts || 0) + 1 : 1;
        state = { ...result, date, attempts, lastAttemptAt: t, lastCompleteDate: result.complete ? date : (state.lastCompleteDate || null) };
        if (result.status === 'exists') state.attempts = attempts;
        await persist();
        log(`daily-backup: ${result.status} (files ${result.files}, copied ${result.copied}, linked ${result.linked}, errors ${result.errors}, truncated ${result.truncated})`);
        return result;
      } catch (error) {
        state = { status: 'failed', date, complete: false, attempts: (state.date === date ? state.attempts || 0 : 0) + 1, lastAttemptAt: t, code: safeCode(error), lastCompleteDate: state.lastCompleteDate || null };
        await persist();
        return state;
      } finally { running = false; }
    },
    status() { return { ...state, running }; },
  };
}

/** GET handler body: allow-listed counts and labels only (never a file name, path or manifest). */
export function backupStatusPayload(backup, enabled) {
  const s = backup.status();
  const pick = k => (s[k] === undefined ? null : s[k]);
  return { enabled, running: s.running === true, status: s.status, date: pick('date'), complete: s.complete === true, files: pick('files'), copied: pick('copied'), linked: pick('linked'), bytes: pick('bytes'), errors: pick('errors'), truncated: s.truncated === true, missing: pick('missing'), discardedTails: pick('discardedTails'), attempts: pick('attempts'), lastAttemptAt: pick('lastAttemptAt'), lastCompleteDate: pick('lastCompleteDate'), kept: pick('kept') };
}
