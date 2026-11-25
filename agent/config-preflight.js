// Read-only deploy preflight for the config and the private secrets store (Nov 25 hardening). It answers, with COUNTS AND LABELS ONLY, the questions
// that the startup matrix will ask at the next start: is the primary config readable and valid, is its backup, do every marker's keys resolve,
// is the private store readable, and (optionally) can this process create and rename a file in the data directory. It never prints a key, a
// path, a file fragment or an account id, and it writes nothing unless `checkWrite` is set (then it creates and removes ONE empty temp file).
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import * as secrets from './secrets-store.js';
import * as configSecrets from './config-secrets.js';
import { classifyReadError, safeCode } from './durable-file.js';

async function fileStatus(file) {
  try {
    const bytes = await fs.readFile(file);
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'corrupt', stage: 'parse' }; }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'corrupt', stage: 'shape' };
    const refs = configSecrets.referenceStatus(parsed);
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts.length : 0;
    return { status: 'readable', accounts, markers: refs.markers, markersMissing: refs.missing, referencesOk: refs.ok, referenceProblem: refs.ok ? null : refs.reason };
  } catch (error) {
    return { status: classifyReadError(error), code: safeCode(error) };
  }
}

export async function inspectConfigState({ configPath, secretsPath, checkWrite = false } = {}) {
  if (secretsPath) process.env.OPENPROPHET_SECRETS_PATH = secretsPath;
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  secrets.initSecrets({ filePath: secretsPath || undefined, split: true });
  const dir = path.dirname(configPath);
  const out = {
    privateStore: secrets.isCorrupt() ? 'unreadable_or_corrupt' : 'readable',
    primary: await fileStatus(configPath),
    backup: await fileStatus(configPath + '.bak'),
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
  // What the next active start would do with this state (a summary of the matrix, not a promise):
  const p = out.primary, b = out.backup;
  if (p.status === 'readable') out.nextStart = p.referencesOk && out.privateStore === 'readable' ? 'load_primary' : (p.markers === 0 ? 'load_primary' : 'refuse_' + (p.referenceProblem || 'private_store_unavailable'));
  else if (p.status === 'absent' && b.status === 'absent') out.nextStart = 'first_run_bootstrap';
  else if (p.status === 'absent' && b.status === 'readable' && b.referencesOk) out.nextStart = 'recover_from_backup';
  else if (p.status === 'corrupt' && b.status === 'readable' && b.referencesOk) out.nextStart = 'recover_from_backup_after_evidence_copy';
  else out.nextStart = 'refuse';
  return out;
}
