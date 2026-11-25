// Read-only deploy preflight for the config and the private secrets store (Nov 25 hardening). It answers, with COUNTS AND LABELS ONLY, what the
// next ACTIVE start would do with the files on disk. Acceptance is decided by the SAME detached candidate validation the loader uses
// (`inspectConfigCandidate`: shape, key references, normalisation), so it cannot predict a load or a recovery that the loader would refuse.
// It never prints a key, a path, an account id or a file fragment, and it writes nothing unless `checkWrite` is set (then it creates, renames
// and removes ONE empty temp file in the data directory).
//
// Exit-status contract of scripts/config-preflight.mjs (derived from `nextStart` and the write check, see `exitCodeFor`):
//   0  load_primary (the primary is accepted) and, when requested, the write check passed
//   2  needs an operator decision: first_run_bootstrap (expected only on a brand-new volume) or recover_from_backup* (a recovery would run)
//   1  refuse_* / unknown, or the write check failed
// Exit 0 is the only "start will simply load" signal; anything else must be read by a human.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as secrets from './secrets-store.js';
import * as configSecrets from './config-secrets.js';
import { safeCode } from './durable-file.js';

async function fileReport(file, inspect) {
  const outcome = await inspect(file, { enforceRefs: true });
  if (outcome.status === 'absent') return { status: 'absent' };
  if (outcome.status === 'access') return { status: 'unreadable', code: outcome.code };
  if (outcome.status === 'corrupt') return { status: 'rejected', stage: outcome.stage };
  if (outcome.status === 'unresolved') return { status: 'unresolved', reason: outcome.reason };
  // accepted: counts only (a second, read-only look at the same bytes)
  let accounts = null, markers = null;
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    accounts = Array.isArray(parsed.accounts) ? parsed.accounts.length : 0;
    markers = configSecrets.referenceStatus(parsed).markers;
  } catch { /* counts are informational */ }
  return { status: 'accepted', accounts, markers, markersMissing: 0 };
}

async function privateStoreState() {
  if (secrets.isCorrupt()) return 'unreadable_or_corrupt';
  try { await fs.access(secrets.secretsPath()); return 'readable'; } catch (error) { return error?.code === 'ENOENT' ? 'absent' : 'unreadable_or_corrupt'; }
}

export function nextStartFor(primary, backup) {
  if (primary.status === 'accepted') return 'load_primary';
  if (primary.status === 'unresolved') return 'refuse_' + primary.reason;
  if (primary.status === 'absent' && backup.status === 'absent') return 'first_run_bootstrap';
  if (primary.status === 'absent' && backup.status === 'accepted') return 'recover_from_backup';
  if (primary.status === 'rejected' && backup.status === 'accepted') return 'recover_from_backup_after_evidence_copy';
  return 'refuse';
}

export function exitCodeFor(report) {
  if (typeof report.writeCheck === 'string' && report.writeCheck.startsWith('failed')) return 1;
  if (report.nextStart === 'load_primary') return 0;
  if (report.nextStart === 'first_run_bootstrap' || String(report.nextStart).startsWith('recover_from_backup')) return 2;
  return 1;
}

export async function inspectConfigState({ configPath, secretsPath, checkWrite = false } = {}) {
  if (secretsPath) process.env.OPENPROPHET_SECRETS_PATH = secretsPath;
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  secrets.initSecrets({ filePath: secretsPath || undefined, split: true });
  configSecrets.resetForTests();
  const { inspectConfigCandidate } = await import('./config-store.js');
  const dir = path.dirname(configPath);
  const primary = await fileReport(configPath, inspectConfigCandidate);
  const backup = await fileReport(configPath + '.bak', inspectConfigCandidate);
  const out = {
    acceptance: 'same_rules_as_loader',
    privateStore: await privateStoreState(),
    primary,
    backup,
    evidenceFiles: 0,
    writeCheck: checkWrite ? 'not_run' : 'skipped',
  };
  try { out.evidenceFiles = (await fs.readdir(dir)).filter(n => n.startsWith(path.basename(configPath) + '.corrupt-')).length; } catch { out.evidenceFiles = null; }
  if (checkWrite) {
    const tmp = path.join(dir, `.preflight-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      await fs.writeFile(tmp, '', { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, tmp + '.renamed');
      await fs.rm(tmp + '.renamed', { force: true });
      out.writeCheck = 'create_and_rename_ok';
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      await fs.rm(tmp + '.renamed', { force: true }).catch(() => {});
      out.writeCheck = 'failed:' + safeCode(error);
    }
  }
  out.nextStart = nextStartFor(primary, backup);
  out.exitCode = exitCodeFor(out);
  return out;
}
