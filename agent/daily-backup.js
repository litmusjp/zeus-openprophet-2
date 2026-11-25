// Daily in-volume backup of the settings and the trade record (Nov 25, requested by Julian; corrected after Hermes' H7 findings).
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
//    SQLite online backup API (a consistent copy of that database; a live WAL database is handled by the API); the copied config and private store are validated AS A PAIR
//    from the copies (pure check, no live key state is read or changed), retrying the pair capture a bounded number of times.
//  - A dated folder `daily/<date>` is published ONLY for a complete snapshot (no errors, no truncation, nothing required missing, within time and size budgets). An incomplete
//    run is kept for diagnosis under `daily/.incomplete/` (never counted as a recovery point, never used as a hard-link base, never allowed to evict a complete one), its
//    state is persisted in `daily/STATE.json` (survives restart) and it is retried with a backoff, bounded per date. The rename gives complete-or-absent DIRECTORY visibility
//    for a process interruption; individual files are not fsynced, so no power-loss durability is claimed.
//  - Resource safety: admission needs free space >= live reserve + a pessimistic estimate of the new copies; free space is rechecked during the copy; unknown capacity skips;
//    the run, each file, the file count and the elapsed time are bounded; abandoned OWNED staging folders are removed after a bounded age. It runs sequentially in the server
//    process and shares the volume with the live service; it cannot guarantee zero interaction (a read-only SQLite handle participates in normal locking).
//  - Containment: fixed source files, source roots and the output namespace are checked with lstat/realpath; links are never followed, read, written or deleted through.
//    Retention removes only complete snapshots that carry this module's owner manifest; foreign date-named folders are never touched.
//  - Hard links point to the PREVIOUS COMPLETE BACKUP COPY (never a live file) and are used only for non-critical files whose size and mtime match the previous capture (a
//    heuristic, reported as `inherited`, not re-verified). Settings are always copied and validated fresh. Restore by COPYING out, never by editing a snapshot in place.
//  - Same-volume copy: it protects against bad saves, deletions and restored defaults, not against losing the volume.
import fs from 'node:fs/promises';
import { constants as fsConstants, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeCode } from './durable-file.js';
import { referenceStatusAgainst } from './config-secrets.js';

export const BACKUP_DEFAULTS = {
  keep: 14, keepIncomplete: 3,
  reserveBytes: 1024 * 1024 * 1024, marginBytes: 64 * 1024 * 1024,
  maxRunBytes: 2 * 1024 * 1024 * 1024, maxFileBytes: 512 * 1024 * 1024, maxFiles: 50000, maxDepth: 8, maxRunMs: 10 * 60 * 1000,
  recheckEvery: 25, startHourEt: 17, tickMs: 15 * 60 * 1000, retryAfterMs: 60 * 60 * 1000, maxAttemptsPerDate: 3, staleStagingMs: 6 * 60 * 60 * 1000,
  pairRetries: 2, pairRetryDelayMs: 500,
};
export const OWNER = 'op2-daily-backup';
export const MANIFEST_VERSION = 2;

const SANDBOX_FILES = ['order-attribution.jsonl', 'daily-loss-lock.json', '.migrated-from-legacy-v2.json'];
const SANDBOX_DIRS = ['chat-history', 'activity_logs', 'decisive_actions', 'news_summaries'];
const DATED = /^\d{4}-\d{2}-\d{2}$/;
const CRITICAL = new Set(['agent-config.json', 'secrets.json', 'trading-guidance.json']);
const EXCLUDED = ['root-level legacy data', 'settings in unsupported custom locations'];

const nyParts = ms => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false }).formatToParts(new Date(ms)).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) % 24 };
};

async function lst(fsx, p) {
  try { const stat = await fsx.lstat(p); return { kind: stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other', stat }; }
  catch (error) { return { kind: error?.code === 'ENOENT' ? 'absent' : 'error', code: safeCode(error) }; }
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
 * file or folder is expected, or a hit of the file/depth cap is recorded and makes the snapshot incomplete. Traversal STOPS at the cap.
 */
export async function planBackup({ root, settings, maxFiles = BACKUP_DEFAULTS.maxFiles, maxDepth = BACKUP_DEFAULTS.maxDepth, fsx = fs } = {}) {
  const state = { entries: [], errors: [], truncated: false, missing: 0, skippedLinks: 0, stop: false };
  const add = entry => { if (state.entries.length >= maxFiles) { state.truncated = true; state.stop = true; return; } state.entries.push(entry); };
  const note = code => state.errors.push({ code });

  const addFile = async (rel, abs, extra = {}) => {
    const st = await lst(fsx, abs);
    if (st.kind === 'absent') return false;
    if (st.kind === 'link') { note('link_unsupported'); return false; }
    if (st.kind === 'error') { note(st.code); return false; }
    if (st.kind !== 'file') { note('not_a_file'); return false; }
    add({ rel, abs, kind: 'file', size: st.stat.size, mtimeMs: Math.floor(st.stat.mtimeMs), critical: CRITICAL.has(path.basename(rel)), jsonl: rel.endsWith('.jsonl'), ...extra });
    return true;
  };
  const walk = async (relDir, absDir, depth, extra = {}) => {
    if (state.stop) return;
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
        if (child.name.startsWith('.') || child.name.endsWith('-wal') || child.name.endsWith('-shm')) continue;
        if (child.isSymbolicLink()) { state.skippedLinks += 1; continue; }
        const rel = `${relDir}/${child.name}`, abs = path.join(absDir, child.name);
        if (child.isDirectory()) await walk(rel, abs, depth + 1, extra);
        else if (child.isFile()) {
          if (child.name.endsWith('.db')) {
            const st = await lst(fsx, abs);
            if (st.kind === 'file') add({ rel, abs, kind: 'sqlite', size: st.stat.size, mtimeMs: Math.floor(st.stat.mtimeMs), critical: false, jsonl: false, ...extra });
            else note(st.kind === 'error' ? st.code : 'not_a_file');
          } else await addFile(rel, abs, extra);
        }
      }
    } catch (error) { note(safeCode(error)); }
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
          if (db.kind === 'file') add({ rel: `${baseRel}/prophet_trader.db`, abs: path.join(baseAbs, 'prophet_trader.db'), kind: 'sqlite', size: db.stat.size, mtimeMs: Math.floor(db.stat.mtimeMs), critical: false, jsonl: false });
          else if (db.kind === 'link') note('link_unsupported'); else if (db.kind === 'error') note(db.code);
          for (const name of SANDBOX_DIRS) await walk(`${baseRel}/${name}`, path.join(baseAbs, name), 0);
        }
      } catch (error) { note(safeCode(error)); }
      finally { try { await dir.close(); } catch { /* closed */ } }
    }
  }
  await walk('quarantine/legacy', path.join(root, 'quarantine', 'legacy'), 0, { legacy: true });
  return state;
}

async function readManifest(dir, fsx = fs) {
  try {
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

async function ensureOutput(root, fsx) {
  const realRoot = await fsx.realpath(root);
  let current = root;
  for (const part of ['recovery-backups', 'daily']) {
    current = path.join(current, part);
    const st = await lst(fsx, current);
    if (st.kind === 'absent') await fsx.mkdir(current, { mode: 0o700 });
    else if (st.kind !== 'dir') throw Object.assign(new Error('output_not_a_directory'), { code: 'OUTPUT_NOT_DIRECTORY' });
  }
  const realBase = await fsx.realpath(current);
  const rel = path.relative(realRoot, realBase);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw Object.assign(new Error('output_outside_root'), { code: 'OUTPUT_OUTSIDE_ROOT' });
  return { base: current, realBase };
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
  try { names = (await fsx.readdir(base, { withFileTypes: true })).filter(d => d.isDirectory() && d.name.startsWith('.tmp-')).map(d => d.name); } catch { return 0; }
  let removed = 0;
  for (const name of names) {
    try {
      const owner = JSON.parse(await fsx.readFile(path.join(base, name, '.owner'), 'utf8'));
      if (owner?.owner === OWNER && now - Number(owner.startedAt) > staleMs && await removeOwned(base, name, fsx)) removed += 1;
    } catch { /* not provably ours: left alone */ }
  }
  return removed;
}

async function sqliteBackupDefault(src, dest) {
  const { default: Database } = await import('better-sqlite3');
  const handle = await fs.open(dest, 'wx', 0o600); await handle.close();
  const db = new Database(src, { readonly: true, fileMustExist: true });
  try { await db.backup(dest); } finally { db.close(); }
}
async function sqliteVerifyDefault(dest) {
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dest, { readonly: true, fileMustExist: true });
  try { return db.pragma('quick_check', { simple: true }) === 'ok'; } finally { db.close(); }
}

/** Bounded capture of ONE regular file: size fixed at open, `.jsonl` keeps complete records only, JSON must parse. */
async function captureFile(entry, dest, { fsx, maxFileBytes }) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const src = await fsx.open(entry.abs, flags);
  let out;
  try {
    const stat = await src.stat();
    if (!stat.isFile()) throw Object.assign(new Error('not_a_file'), { code: 'NOT_A_FILE' });
    if (stat.size > maxFileBytes) throw Object.assign(new Error('oversized'), { code: 'OVERSIZED' });
    const budget = stat.size;                                                   // fixed at open: later appends cannot extend this capture
    out = await fsx.open(dest, 'wx', 0o600);
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(budget, 1)));
    let copied = 0, lastNewline = -1;
    while (copied < budget) {
      const { bytesRead } = await src.read(buffer, 0, Math.min(buffer.length, budget - copied), copied);
      if (!bytesRead) break;
      if (entry.jsonl) { const at = buffer.subarray(0, bytesRead).lastIndexOf(0x0a); if (at >= 0) lastNewline = copied + at; }
      await out.write(buffer, 0, bytesRead, copied);
      copied += bytesRead;
    }
    let kept = copied, discardedTail = 0;
    if (entry.jsonl && kept > 0 && lastNewline + 1 < kept) { discardedTail = kept - (lastNewline + 1); kept = lastNewline + 1; await out.truncate(kept); }
    else if (entry.jsonl && kept > 0 && lastNewline < 0) { discardedTail = kept; kept = 0; await out.truncate(0); }
    await out.sync();
    return { srcSize: stat.size, bytes: kept, discardedTail };
  } finally {
    await src.close().catch(() => {});
    if (out) await out.close().catch(() => {});
  }
}

async function hashFile(file, fsx) {
  const hash = crypto.createHash('sha256');
  const handle = await fsx.open(file, 'r');
  let bytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, bytes); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); bytes += bytesRead; }
  } finally { await handle.close(); }
  return { bytes, sha256: hash.digest('hex') };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * One backup run for the NY date of `now`. Returns a summary (counts only) and never throws. status:
 * 'ok' (complete snapshot published) | 'incomplete' (kept under .incomplete, not a recovery point) | 'exists' (today's COMPLETE snapshot is already there)
 * | 'skipped_low_space' | 'skipped_capacity_unknown' | 'skipped_run_too_large' | 'aborted_low_space' | 'blocked_foreign_folder' | 'failed'.
 */
export async function runBackup(options = {}) {
  const o = { ...BACKUP_DEFAULTS, ...options };
  const { root, settings = {}, fsx = fs, now = Date.now, sqliteBackup = sqliteBackupDefault, sqliteVerify = sqliteVerifyDefault, statfs = fs.statfs } = o;
  const { date } = nyParts(now);
  const summary = { status: 'failed', date, complete: false, files: 0, copied: 0, linked: 0, bytes: 0, errors: 0, truncated: false, missing: 0, discardedTails: 0, kept: 0 };
  let tmp = null;
  try {
    const { base } = await ensureOutput(root, fsx);
    const final = path.join(base, date);
    const existing = await lst(fsx, final);
    if (existing.kind !== 'absent') {
      const manifest = existing.kind === 'dir' ? await readManifest(final, fsx) : null;
      if (manifest?.complete === true && manifest.date === date) return { ...summary, status: 'exists', complete: true, files: manifest.counts?.files ?? manifest.files.length, copied: manifest.counts?.copied ?? 0, linked: manifest.counts?.linked ?? 0, bytes: manifest.counts?.bytes ?? 0, kept: (await ownedSnapshots(base, fsx)).length };
      return { ...summary, status: 'blocked_foreign_folder' };
    }
    await cleanStaging(base, fsx, now, o.staleStagingMs);
    const owned = await ownedSnapshots(base, fsx);
    const previous = owned.filter(s => s.name < date).pop() || null;
    const previousByRel = new Map((previous?.manifest.files || []).map(f => [f.rel, f]));

    const plan = await planBackup({ root, settings, maxFiles: o.maxFiles, maxDepth: o.maxDepth, fsx });
    summary.truncated = plan.truncated; summary.missing = plan.missing;
    let errorCount = plan.errors.length;
    const errorCodes = {};
    for (const e of plan.errors) errorCodes[e.code] = (errorCodes[e.code] || 0) + 1;
    const addError = code => { errorCount += 1; errorCodes[code] = (errorCodes[code] || 0) + 1; };

    // pessimistic admission: everything that cannot be inherited counts at full size (SQLite at size plus a WAL allowance), plus a margin, on top of the live reserve
    const priorMatches = e => { const p = previousByRel.get(e.rel); return !!p && e.kind === 'file' && !e.critical && p.srcSize === e.size && p.mtimeMs === e.mtimeMs; };
    const estimate = plan.entries.reduce((n, e) => n + (priorMatches(e) ? 0 : (e.kind === 'sqlite' ? e.size * 2 : e.size)), 0) + o.marginBytes;
    if (estimate > o.maxRunBytes) return { ...summary, status: 'skipped_run_too_large', files: plan.entries.length };
    const freeBytes = async () => { try { const s = await statfs(root); const free = Number(s.bavail) * Number(s.bsize); return Number.isFinite(free) ? free : null; } catch { return null; } };
    const free0 = await freeBytes();
    if (free0 === null) return { ...summary, status: 'skipped_capacity_unknown' };
    if (free0 < o.reserveBytes + estimate) return { ...summary, status: 'skipped_low_space' };

    tmp = path.join(base, `.tmp-${date}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    await fsx.mkdir(tmp, { mode: 0o700 });
    await fsx.writeFile(path.join(tmp, '.owner'), JSON.stringify({ owner: OWNER, startedAt: now, pid: process.pid }), { mode: 0o600 });
    const startedAt = Date.now();
    const manifest = [];
    let runBytes = 0, sinceCheck = 0, aborted = null;

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
        await sqliteBackup(entry.abs, dest);
        if (!(await sqliteVerify(dest))) throw Object.assign(new Error('sqlite_check'), { code: 'SQLITE_CHECK' });
        const h = await hashFile(dest, fsx);
        return { ...h, srcSize: entry.size, mtimeMs: entry.mtimeMs, discardedTail: 0, linked: false };
      }
      let captured = await captureFile(entry, dest, { fsx, maxFileBytes: o.maxFileBytes });
      if (CRITICAL.has(path.basename(entry.rel).replace(/\.bak$/, '')) || entry.rel.endsWith('chat-history/sessions.json')) {   // only the files a restore depends on must parse
        const parses = async () => { try { const v = JSON.parse(await fsx.readFile(dest, 'utf8')); return v !== undefined; } catch { return false; } };
        if (!(await parses())) {                                                // an in-place writer may have been mid-write: one bounded retry
          await fsx.rm(dest, { force: true }); await sleep(250);
          captured = await captureFile(entry, dest, { fsx, maxFileBytes: o.maxFileBytes });
          if (!(await parses())) throw Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' });
        }
      }
      const h = await hashFile(dest, fsx);
      return { ...h, srcSize: captured.srcSize, mtimeMs: entry.mtimeMs, discardedTail: captured.discardedTail, linked: false };
    };

    for (const entry of plan.entries) {
      if (Date.now() - startedAt > o.maxRunMs) { aborted = 'time_budget'; break; }
      if (runBytes > o.maxRunBytes) { aborted = 'run_budget'; break; }
      if (++sinceCheck >= o.recheckEvery) {
        sinceCheck = 0;
        const free = await freeBytes();
        if (free === null || free < o.reserveBytes) { aborted = 'low_space'; break; }
      }
      try {
        const record = await copyOne(entry);
        manifest.push({ rel: entry.rel, kind: entry.kind, bytes: record.bytes, sha256: record.sha256, srcSize: record.srcSize, mtimeMs: record.mtimeMs, discardedTail: record.discardedTail, linked: record.linked, legacyNonActionable: entry.legacy === true });
        summary.files += 1; summary.bytes += record.bytes; runBytes += record.linked ? 0 : record.bytes;
        if (record.linked) summary.linked += 1; else summary.copied += 1;
        if (record.discardedTail) summary.discardedTails += 1;
      } catch (error) { addError(safeCode(error)); }
    }

    // the copied config and private store must work together (pure check on the COPIES; bounded retry for a settings race)
    const copiedJson = async rel => { try { return JSON.parse(await fsx.readFile(path.join(tmp, rel), 'utf8')); } catch { return null; } };
    if (!aborted) {
      let pairOk = false;
      for (let attempt = 0; attempt <= o.pairRetries && !pairOk; attempt += 1) {
        const config = await copiedJson('agent-config.json');
        if (!config) { pairOk = true; break; }                                  // already counted as missing or invalid above
        const store = await copiedJson('secrets.json');
        pairOk = referenceStatusAgainst(config, store).ok;
        if (!pairOk && attempt < o.pairRetries) {
          await sleep(o.pairRetryDelayMs);
          for (const entry of plan.entries.filter(e => e.rel === 'agent-config.json' || e.rel === 'secrets.json')) {
            try { await fsx.rm(path.join(tmp, entry.rel), { force: true }); const r = await captureFile(entry, path.join(tmp, entry.rel), { fsx, maxFileBytes: o.maxFileBytes }); const h = await hashFile(path.join(tmp, entry.rel), fsx); const m = manifest.find(x => x.rel === entry.rel); if (m) Object.assign(m, { bytes: h.bytes, sha256: h.sha256, srcSize: r.srcSize, linked: false }); } catch { /* the next check decides */ }
          }
        }
      }
      if (!pairOk) addError('settings_pair_unresolved');
    }
    if (aborted) addError('aborted_' + aborted);

    summary.errors = errorCount;
    const complete = errorCount === 0 && !plan.truncated && plan.missing === 0 && !aborted;
    const body = { version: MANIFEST_VERSION, owner: OWNER, date, createdAt: new Date(now).toISOString(), complete, counts: { files: summary.files, copied: summary.copied, linked: summary.linked, bytes: summary.bytes, errors: errorCount, discardedTails: summary.discardedTails, skippedLinks: plan.skippedLinks }, truncated: plan.truncated, missing: plan.missing, errorCodes, excluded: EXCLUDED, scope: 'canonical records + settings + iv-history + legacy quarantine (non-actionable)', files: manifest };
    await fsx.writeFile(path.join(tmp, 'MANIFEST.json'), JSON.stringify(body), { mode: 0o600 });
    await fsx.rm(path.join(tmp, '.owner'), { force: true });
    if (complete) {
      await fsx.rename(tmp, final); tmp = null;                                  // complete-or-absent directory visibility; no power-loss claim
      summary.status = 'ok'; summary.complete = true;
      const snapshots = await ownedSnapshots(base, fsx);
      for (const old of snapshots.slice(0, Math.max(0, snapshots.length - o.keep))) await removeOwned(base, old.name, fsx);
      summary.kept = Math.min(snapshots.length, o.keep);
    } else {
      const holding = path.join(base, '.incomplete');
      if ((await lst(fsx, holding)).kind === 'absent') await fsx.mkdir(holding, { mode: 0o700 });
      await fsx.rename(tmp, path.join(holding, `${date}-${now}-${crypto.randomBytes(2).toString('hex')}`)); tmp = null;
      summary.status = aborted === 'low_space' ? 'aborted_low_space' : 'incomplete';
      const kept = (await fsx.readdir(holding)).sort();
      for (const name of kept.slice(0, Math.max(0, kept.length - o.keepIncomplete))) await fsx.rm(path.join(holding, name), { recursive: true, force: true });
      summary.kept = (await ownedSnapshots(base, fsx)).length;
    }
    return summary;
  } catch (error) {
    if (tmp) await fsx.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return { ...summary, status: 'failed', code: safeCode(error) };
  }
}

const stateFile = root => path.join(root, 'recovery-backups', 'daily', 'STATE.json');

/**
 * Scheduler: at most one run at a time; one COMPLETE snapshot per New York date after `startHourEt`; an incomplete or skipped run is retried with a backoff
 * (bounded attempts per date) and its state survives a restart (daily/STATE.json: counts and labels only).
 */
export function createDailyBackup({ root, settings = {}, now = Date.now, run = runBackup, startHourEt = BACKUP_DEFAULTS.startHourEt, retryAfterMs = BACKUP_DEFAULTS.retryAfterMs, maxAttemptsPerDate = BACKUP_DEFAULTS.maxAttemptsPerDate, runOptions = {}, log = () => {} } = {}) {
  let running = false;
  let state = { status: 'not_run_yet' };
  try { const saved = JSON.parse(readFileSync(stateFile(root), 'utf8')); if (saved && typeof saved === 'object') state = saved; } catch { /* first run, or no state yet */ }
  const persist = () => { try { writeFileSync(stateFile(root), JSON.stringify(state), { mode: 0o600 }); } catch { /* state is advisory */ } };
  return {
    async tick() {
      if (running) return { status: 'busy' };
      const t = now();
      const { date, hour } = nyParts(t);
      if (hour < startHourEt) return { status: 'waiting' };
      if (state.date === date && state.complete === true) return { status: 'done_today' };
      if (state.date === date && state.complete !== true) {
        if ((state.attempts || 0) >= maxAttemptsPerDate) return { status: 'gave_up_today' };
        if (t - Number(state.lastAttemptAt || 0) < retryAfterMs) return { status: 'retry_later' };
      }
      running = true;
      try {
        const result = await run({ root, settings, now: t, ...runOptions });
        const attempts = state.date === date ? (state.attempts || 0) + 1 : 1;
        state = { ...result, date, attempts, lastAttemptAt: t, lastCompleteDate: result.complete ? date : (state.lastCompleteDate || null) };
        if (result.status === 'exists') state.attempts = attempts;
        persist();
        log(`daily-backup: ${result.status} (files ${result.files}, copied ${result.copied}, linked ${result.linked}, errors ${result.errors}, truncated ${result.truncated})`);
        return result;
      } catch (error) {
        state = { status: 'failed', date, complete: false, attempts: (state.date === date ? state.attempts || 0 : 0) + 1, lastAttemptAt: t, code: safeCode(error), lastCompleteDate: state.lastCompleteDate || null };
        persist();
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
