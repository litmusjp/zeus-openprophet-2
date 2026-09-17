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

export async function migrateLegacyDataForAccount(accountId) {
  if (!accountId) return { migrated: false, copied: [] };

  const sandboxRoot = path.join(PROJECT_ROOT, 'data', 'sandboxes', accountId);
  const markerPath = path.join(sandboxRoot, '.migrated-from-root.json');
  if (await exists(markerPath)) {
    return { migrated: false, copied: [] };
  }

  const copied = [];
  const dirMappings = [
    ['activity_logs', path.join(sandboxRoot, 'activity_logs')],
    ['decisive_actions', path.join(sandboxRoot, 'decisive_actions')],
    ['news_summaries', path.join(sandboxRoot, 'news_summaries')],
  ];

  for (const [sourceName, targetDir] of dirMappings) {
    const sourceDir = path.join(PROJECT_ROOT, sourceName);
    if (await copyDirIfNeeded(sourceDir, targetDir)) {
      copied.push(sourceName);
    }
  }

  const dbSource = path.join(PROJECT_ROOT, 'data', 'prophet_trader.db');
  const dbTarget = path.join(sandboxRoot, 'prophet_trader.db');
  if (await copyFileIfNeeded(dbSource, dbTarget)) copied.push('prophet_trader.db');
  if (await copyFileIfNeeded(`${dbSource}-wal`, `${dbTarget}-wal`)) copied.push('prophet_trader.db-wal');
  if (await copyFileIfNeeded(`${dbSource}-shm`, `${dbTarget}-shm`)) copied.push('prophet_trader.db-shm');

  await fs.mkdir(sandboxRoot, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    migratedAt: new Date().toISOString(),
    copied,
  }, null, 2));

  return { migrated: copied.length > 0, copied };
}

export default {
  migrateLegacyDataForAccount,
};
