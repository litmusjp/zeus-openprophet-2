import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { migrateLegacyDataForSandboxAt } from '../agent/data-migration.js';

test('unverified legacy database and artifacts are quarantined, never activated', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-migration-'));
  const legacy = path.join(root, 'data', 'sandboxes', 'legacy-account');
  await fs.mkdir(path.join(legacy, 'activity_logs'), { recursive: true });
  await fs.writeFile(path.join(legacy, 'activity_logs', 'old.log'), 'legacy');
  await fs.writeFile(path.join(legacy, 'prophet_trader.db'), 'db');
  await fs.writeFile(path.join(legacy, 'prophet_trader.db-wal'), 'wal');

  const result = await migrateLegacyDataForSandboxAt(root, 'sbx-new', 'legacy-account');
  assert.deepEqual(result.copied, []);
  assert.deepEqual(result.quarantined, ['activity_logs', 'prophet_trader.db', 'prophet_trader.db-wal']);
  await assert.rejects(fs.access(path.join(root, 'data', 'sandboxes', 'sbx-new', 'prophet_trader.db')));
  const quarantine = JSON.parse(await fs.readFile(path.join(result.quarantinePath, 'QUARANTINED.json'), 'utf8'));
  assert.equal(quarantine.nonActionable, true);
  assert.equal(quarantine.provenance.legacyAccountId, 'legacy-account');
});
