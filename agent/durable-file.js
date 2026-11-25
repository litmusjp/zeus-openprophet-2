// Small, dependency-free helpers for writing state files without ever leaving a half-written file in place.
//
// Scope (Nov 25 hardening, H1): process-interruption-safe publication of one file. A unique exclusive temp file is written in the
// SAME directory, synced, and renamed over the target; the previous on-disk bytes (never an in-memory object) are kept as one known-good
// `.bak` when the caller's validator accepts them. This is not a transactional filesystem: directory fsync is best effort and platform specific,
// a `.bak` is not a recovery of the private secrets store, and it is not a platform volume snapshot.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** 'absent' (ENOENT), 'access' (any other fs error: EACCES, EPERM, EIO, EROFS, EISDIR ...), 'corrupt' (parse, shape or validation). */
export function classifyReadError(error) {
  if (error?.code === 'ENOENT') return 'absent';
  if (error?.code) return 'access';
  return 'corrupt';
}

/** Log token that never carries a file fragment: a short code only. */
export function safeCode(error, fallback = 'error') {
  const code = typeof error?.code === 'string' ? error.code : (error instanceof SyntaxError ? 'SyntaxError' : fallback);
  return String(code).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40) || fallback;
}

export const sha256Hex = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export const isJsonObjectBytes = bytes => {
  try {
    const value = JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch { return false; }
};

const failure = (code, message) => Object.assign(new Error(message || code), { code });

/**
 * Writes `data` to a NEW exclusive file, with the requested mode applied to the handle itself (so a restrictive umask can never leave it narrower
 * than asked and nothing is ever wider), syncs it, and (when `expected` is given) refuses to continue if the new inode does not carry the same
 * owner, group and mode as the file it will replace. Nothing is chmod-ed or chown-ed outside this one temp file.
 */
async function writeSynced(fsx, file, data, mode, expected = null) {
  const handle = await fsx.open(file, 'wx', mode);
  try {
    if (process.platform !== 'win32') { try { await handle.chmod(mode); } catch { /* the check below decides */ } }
    if (expected && process.platform !== 'win32') {
      const stat = await handle.stat();
      if (stat.uid !== expected.uid || stat.gid !== expected.gid) throw failure('OWNER_MISMATCH', 'owner_mismatch');
      if ((stat.mode & 0o777) !== (expected.mode & 0o777)) throw failure('MODE_MISMATCH', 'mode_mismatch');
    }
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const tempName = file => path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);

/**
 * Publishes `data` (string or Buffer) as `file`.
 *  - temp file in the same directory: restrictive mode from creation (the existing file's mode, never wider; 0600 for a new file), fsync, rename;
 *  - when the existing file has an owner, group or mode that the new inode cannot reproduce, the call fails BEFORE any replacement;
 *  - when `backup` is on and `validateExisting(existingBytes)` accepts the CURRENT file, its exact bytes become `file + '.bak'` first (same
 *    temp + rename); a file the validator rejects never replaces a good `.bak`;
 *  - `requireFallback`: when the backup could not be published and no valid `.bak` exists, the call fails BEFORE the primary rename, so there is
 *    never a state with a replaced primary and no fallback written by this call;
 *  - a failure before the rename leaves the target untouched and removes the temp; a failed rename throws with the target intact; after a
 *    successful rename nothing can fail the call (the directory sync is best effort).
 * Returns { backup: 'written' | 'skipped_invalid' | 'failed' | 'none' }.
 */
export async function publishAtomic(file, data, { backup = false, validateExisting = isJsonObjectBytes, validateFallback = validateExisting, requireFallback = false, fsx = fs } = {}) {
  let mode = 0o600;
  let existing = null;
  let expected = null;
  try {
    const stat = await fsx.stat(file);
    mode = stat.mode & 0o777;
    expected = { uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777 };
    existing = await fsx.readFile(file);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;      // an unreadable current file is not overwritten blindly
  }
  const tmp = tempName(file);
  try {
    await writeSynced(fsx, tmp, data, mode, expected);
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
  if (requireFallback && backupStatus === 'failed') {
    let fallback = false;
    try { fallback = validateFallback(await fsx.readFile(file + '.bak')); } catch { fallback = false; }
    if (!fallback) {
      await fsx.rm(tmp, { force: true }).catch(() => {});
      throw failure('BACKUP_REQUIRED', 'backup_required');
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
 * Keeps the exact bytes of a file we are about to stop trusting, beside it, once per distinct content (`<file>.corrupt-<sha12>`, 0600).
 * The copy is written to a temp file, synced, and published by rename (atomic: an interrupted earlier copy can never be mistaken for a complete one),
 * then READ BACK and compared with the original. Returns the evidence file name, or null when exact preservation could not be proven. The original
 * is never renamed or deleted.
 */
export async function preserveEvidence(file, { fsx = fs } = {}) {
  let tmp = null;
  try {
    const bytes = await fsx.readFile(file);
    const target = `${file}.corrupt-${sha256Hex(bytes).slice(0, 12)}`;
    let intact = false;
    try { intact = (await fsx.readFile(target)).equals(bytes); } catch { intact = false; }
    if (!intact) {
      tmp = tempName(target);
      await writeSynced(fsx, tmp, bytes, 0o600);
      await fsx.rename(tmp, target);                // replaces any partial copy atomically
      tmp = null;
    }
    const verified = (await fsx.readFile(target)).equals(bytes);
    return verified ? path.basename(target) : null;
  } catch {
    if (tmp) await fsx.rm(tmp, { force: true }).catch(() => {});
    return null;
  }
}
