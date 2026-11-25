// Small, dependency-free helpers for writing state files without ever leaving a half-written file in place.
//
// Scope (Nov 25 hardening, H1): process-interruption-safe publication of one file. A unique exclusive temp file is written in the
// SAME directory, synced, and renamed over the target; the previous on-disk bytes (never an in-memory object) are kept as one known-good
// `.bak` when they validate. This is not a transactional filesystem: directory fsync is best effort and platform specific, a `.bak` is
// not a recovery of the private secrets store, and it is not a platform volume snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 'absent' (ENOENT), 'access' (any other fs error: EACCES, EPERM, EIO, EROFS ...), 'corrupt' (parse, shape or validation). */
export function classifyReadError(error) {
  if (error?.code === 'ENOENT') return 'absent';
  if (error?.code) return 'access';
  return 'corrupt';
}

/** Log line that never carries a file fragment: a stage and a code only. */
export function safeCode(error, fallback = 'error') {
  const code = typeof error?.code === 'string' ? error.code : (error instanceof SyntaxError ? 'SyntaxError' : fallback);
  return String(code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || fallback;
}

export const isJsonObjectBytes = bytes => {
  try {
    const value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch { return false; }
};

async function writeSynced(fsx, file, data, mode) {
  const handle = await fsx.open(file, 'wx', mode);   // exclusive: never reuses or follows an existing temp
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const tempName = file => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);

/**
 * Publishes `data` (string or Buffer) as `file`.
 *  - temp file in the same directory, restrictive mode from creation (the existing file's mode when it has one, else 0600), fsync, rename;
 *  - when `backup` is on and the CURRENT file validates (`validateExisting`), its exact bytes become `file + '.bak'` first (same temp+rename);
 *    an invalid or unreadable current file never replaces a good `.bak`;
 *  - any failure before the rename leaves the target untouched and removes the temp; a failure of the rename is thrown and the target is intact;
 *  - after a successful rename nothing can fail the call (the directory sync is best effort).
 * Returns { backup: 'written' | 'skipped_invalid' | 'failed' | 'none' }.
 */
export async function publishAtomic(file, data, { backup = false, validateExisting = isJsonObjectBytes, fsx = fs } = {}) {
  let mode = 0o600;
  let existing = null;
  try {
    const stat = await fsx.stat(file);
    mode = stat.mode & 0o777;
    existing = await fsx.readFile(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;      // an unreadable current file is not overwritten blindly
  }
  const tmp = tempName(file);
  try {
    await writeSynced(fsx, tmp, data, mode);
  } catch (error) {
    await fsx.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  let backupStatus = 'none';
  if (backup && existing) {
    if (validateExisting(existing)) {
      const backupTmp = tempName(file + '.bak');
      try {
        await writeSynced(fsx, backupTmp, existing, 0o600);
        await fsx.rename(backupTmp, file + '.bak');
        backupStatus = 'written';
      } catch {
        await fsx.rm(backupTmp, { force: true }).catch(() => {});
        backupStatus = 'failed';
      }
    } else {
      backupStatus = 'skipped_invalid';
    }
  }
  try {
    await fsx.rename(tmp, file);
  } catch (error) {
    await fsx.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  try {
    const dir = await fsx.open(path.dirname(file), 'r');
    try { await dir.sync(); } finally { await dir.close(); }
  } catch { /* directory sync is not supported everywhere; the rename itself is already done */ }
  return { backup: backupStatus };
}

/**
 * Keeps the exact bytes of a file we are about to stop trusting, once per distinct content, beside it (0600, exclusive create).
 * Never renames or deletes the original. Returns the evidence file name, or null when it could not be kept.
 */
export async function preserveEvidence(file, { fsx = fs } = {}) {
  try {
    const bytes = await fsx.readFile(file);
    const tag = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 12);
    const target = `${file}.corrupt-${tag}`;
    try {
      const handle = await fsx.open(target, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    return path.basename(target);
  } catch {
    return null;
  }
}
