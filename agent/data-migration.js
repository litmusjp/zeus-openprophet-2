import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function dirHasEntries(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function copyDirIfNeeded(sourceDir, targetDir) {
  if (!await dirHasEntries(sourceDir)) return false;
  if (await dirHasEntries(targetDir)) return false;
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true });
  return true;
}

async function copyFileIfNeeded(sourcePath, targetPath) {
  if (!await exists(sourcePath)) return false;
  if (await exists(targetPath)) return false;
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.copyFile(sourcePath, targetPath);
  return true;
}

async function readVerifiedProvenance(legacyRoot, expected) {
  const manifestPath = path.join(legacyRoot, 'legacy-provenance.json');
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    return manifest?.serverOwned === true &&
      manifest.accountId === expected.accountId &&
      manifest.tenantId === expected.tenantId &&
      manifest.sandboxId === expected.sandboxId &&
      manifest.brokerAccountId === expected.brokerAccountId;
  } catch {
    return false;
  }
}

export async function migrateLegacyDataForSandbox(sandboxId, legacyAccountId = '') {
  return migrateLegacyDataForSandboxAt(PROJECT_ROOT, sandboxId, legacyAccountId);
}

export async function migrateLegacyDataForSandboxAt(projectRoot, sandboxId, legacyAccountId = '') {
  if (!sandboxId) return { migrated: false, copied: [] };

  const sandboxRoot = path.join(projectRoot, 'data', 'sandboxes', sandboxId);
  const markerPath = path.join(sandboxRoot, '.migrated-from-legacy-v2.json');
  if (await exists(markerPath)) {
    return { migrated: false, copied: [] };
  }

  const canonicalSandboxId = legacyAccountId ? `sbx_${legacyAccountId}` : '';
  const legacySandboxRoot = legacyAccountId
    ? path.join(projectRoot, 'data', 'sandboxes', legacyAccountId)
    : '';
  const verified = Boolean(legacySandboxRoot && await readVerifiedProvenance(legacySandboxRoot, {
    accountId: legacyAccountId,
    tenantId: process.env.OPENPROPHET_TENANT_ID || '',
    sandboxId,
    brokerAccountId: process.env.ALPACA_ACCOUNT_ID || '',
  }));
  const canMigrateLegacyAccount = verified && Boolean(legacyAccountId && (sandboxId === canonicalSandboxId || sandboxId === legacyAccountId));
  const copied = [];
  const quarantined = [];
  const quarantineRoot = path.join(projectRoot, 'data', 'quarantine', 'legacy', sandboxId);
  const destinationRoot = canMigrateLegacyAccount ? sandboxRoot : quarantineRoot;
  const dirMappings = [
    ['activity_logs'],
    ['decisive_actions'],
    ['news_summaries'],
  ];

  for (const [sourceName] of dirMappings) {
    const legacyDir = legacySandboxRoot ? path.join(legacySandboxRoot, sourceName) : '';
    if (legacyDir && await copyDirIfNeeded(legacyDir, path.join(destinationRoot, sourceName))) {
      (canMigrateLegacyAccount ? copied : quarantined).push(sourceName);
    }
  }

  const legacyDb = legacySandboxRoot ? path.join(legacySandboxRoot, 'prophet_trader.db') : '';
  const dbSource = legacyDb && await exists(legacyDb) ? legacyDb : '';
  const dbTarget = path.join(destinationRoot, 'prophet_trader.db');
  if (await copyFileIfNeeded(dbSource, dbTarget)) (canMigrateLegacyAccount ? copied : quarantined).push('prophet_trader.db');
  if (await copyFileIfNeeded(`${dbSource}-wal`, `${dbTarget}-wal`)) (canMigrateLegacyAccount ? copied : quarantined).push('prophet_trader.db-wal');
  if (await copyFileIfNeeded(`${dbSource}-shm`, `${dbTarget}-shm`)) (canMigrateLegacyAccount ? copied : quarantined).push('prophet_trader.db-shm');

  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    migratedAt: new Date().toISOString(),
    legacyAccountId: legacyAccountId || null,
    verified,
    copied,
    quarantined,
    quarantinePath: quarantined.length ? quarantineRoot : null,
  }, null, 2));

  if (quarantined.length) {
    await fs.mkdir(quarantineRoot, { recursive: true });
    await fs.writeFile(path.join(quarantineRoot, 'QUARANTINED.json'), JSON.stringify({
      nonActionable: true,
      provenance: { legacyAccountId: legacyAccountId || null, requestedSandboxId: sandboxId },
      quarantined,
    }, null, 2));
  }
  return { migrated: copied.length > 0, copied, quarantined, quarantinePath: quarantined.length ? quarantineRoot : null };
}

export async function migrateLegacyDataForAccount(accountId) {
  return migrateLegacyDataForSandbox(accountId, accountId);
}

export default {
  migrateLegacyDataForAccount,
};
