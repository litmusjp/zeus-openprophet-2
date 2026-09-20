import { existsSync, renameSync, rmSync, readdirSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';

function matchingBackupPaths(binaryPath, fsOps) {
  if (typeof fsOps.readdirSync !== 'function') return [];
  const directory = path.dirname(binaryPath);
  const prefix = `${path.basename(binaryPath)}.backup-`;
  let entries;
  try {
    entries = fsOps.readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .map(entry => typeof entry === 'string' ? entry : entry.name)
    .filter(name => typeof name === 'string' && name.startsWith(prefix))
    .map(name => path.join(directory, name));
}

function recoverOrCleanBackups(binaryPath, fsOps) {
  const backups = matchingBackupPaths(binaryPath, fsOps);
  if (!backups.length) return;

  if (!fsOps.existsSync(binaryPath)) {
    // Restore before building. If this rename fails, leave the backup in place
    // and fail closed rather than replacing the only known-good binary.
    fsOps.renameSync(backups.sort()[0], binaryPath);
  }

  // A primary now exists, so remove only backups belonging to this binary.
  for (const backupPath of matchingBackupPaths(binaryPath, fsOps)) {
    try { fsOps.rmSync(backupPath, { force: true }); } catch { /* retain a recoverable copy */ }
  }
}

// Build into a unique path, move the known-good binary out of the way, then
// promote the completed build. This is safe on platforms where rename refuses
// to overwrite an existing destination.
export function replaceBinaryWithRollback(binaryPath, build, fsOps = { existsSync, renameSync, rmSync, readdirSync }) {
  const temporaryPath = `${binaryPath}.tmp-${process.pid}-${randomUUID()}`;
  const backupPath = `${binaryPath}.backup-${process.pid}-${randomUUID()}`;
  let backupCreated = false;
  let promoted = false;

  try {
    recoverOrCleanBackups(binaryPath, fsOps);
    build(temporaryPath);
    if (fsOps.existsSync(binaryPath)) {
      fsOps.renameSync(binaryPath, backupPath);
      backupCreated = true;
    }
    try {
      fsOps.renameSync(temporaryPath, binaryPath);
      promoted = true;
    } catch (promotionError) {
      if (backupCreated) {
        try {
          if (fsOps.existsSync(binaryPath)) fsOps.rmSync(binaryPath, { force: true });
          fsOps.renameSync(backupPath, binaryPath);
          backupCreated = false;
        } catch (restoreError) {
          promotionError.restoreError = restoreError;
        }
      }
      throw promotionError;
    }
  } finally {
    try { fsOps.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original error */ }
    if (promoted && backupCreated) {
      try { fsOps.rmSync(backupPath, { force: true }); } catch { /* leave a recoverable backup */ }
    }
  }
}
