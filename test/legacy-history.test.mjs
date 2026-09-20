import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { labelLegacyRows, legacyHistoryCandidatePaths, readLegacyHistoryForSandboxAt } from '../agent/legacy-history.js';

test('legacy history is a read-only, unverified display projection bound to account mapping', async () => {
  const rows = labelLegacyRows([{ ID: 'old-order-1', Status: 'canceled', FilledQty: 0 }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].historySource, 'legacy');
  assert.equal(rows[0].verification, 'unverified');
  assert.equal(rows[0].broker_identity_verified, false);
  assert.equal(rows[0].identityVerified, false);
  assert.equal(rows[0].evidence, 'legacy_unverified');
});

test('legacy projection cannot be selected by an unrelated sandbox', async () => {
  assert.deepEqual(readLegacyHistoryForSandboxAt('C:/nonexistent-openprophet-test-root', { id: 'sbx-other', accountId: 'other-account' }), []);
  assert.deepEqual(readLegacyHistoryForSandboxAt('C:/nonexistent-openprophet-test-root', { id: 'sbx-litmus1', accountId: '../acct-litmus1' }), []);
});

test('legacy projection rejects unsafe path segments while preserving current IDs', async () => {
  const rejected = ['', '.', '..', 'bad/name', 'bad\\\\name', 'bad:name', 'bad.', 'bad ', 'CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'COM1', 'LPT9', 'bad\u0000name', 'bad\u0007name'];
  for (const id of rejected) assert.deepEqual(legacyHistoryCandidatePaths('C:/openprophet-test-root', { id }), [], id);
  assert.equal(legacyHistoryCandidatePaths('C:/openprophet-test-root', { id: 'sbx_litmus-1.2' }).length, 1);
});

test('legacy projection selects quarantine only and never falls back to account data', async () => {
  const root = 'C:/openprophet-test-root';
  assert.deepEqual(legacyHistoryCandidatePaths(root, { id: 'sandbox-1', accountId: 'account-1' }), [
    [path.join(root, 'data', 'quarantine', 'legacy', 'sandbox-1', 'prophet_trader.db'), 'quarantined-legacy-db'],
  ]);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-legacy-'));
  const accountDb = path.join(tempRoot, 'data', 'sandboxes', 'account-1', 'prophet_trader.db');
  await fs.mkdir(path.dirname(accountDb), { recursive: true });
  await fs.writeFile(accountDb, 'account data must not be selected');
  assert.deepEqual(await readLegacyHistoryForSandboxAt(tempRoot, { id: 'sandbox-1', accountId: 'account-1' }), []);
});

test('legacy projection rejects directories and symlinks that resolve outside the permitted roots', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-legacy-'));
  const quarantine = path.join(root, 'data', 'quarantine', 'legacy', 'sandbox-1');
  const sandboxes = path.join(root, 'data', 'sandboxes', 'account-1');
  await fs.mkdir(quarantine, { recursive: true });
  await fs.mkdir(sandboxes, { recursive: true });
  await fs.mkdir(path.join(quarantine, 'prophet_trader.db'));
  assert.deepEqual(await readLegacyHistoryForSandboxAt(root, { id: 'sandbox-1', accountId: 'account-1' }), []);
  await fs.rm(path.join(quarantine, 'prophet_trader.db'), { recursive: true });

  const outside = path.join(root, 'outside.db');
  await fs.writeFile(outside, 'not a database');
  try {
    await fs.symlink(outside, path.join(quarantine, 'prophet_trader.db'), 'file');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) throw error;
    return;
  }
  assert.deepEqual(await readLegacyHistoryForSandboxAt(root, { id: 'sandbox-1', accountId: 'account-1' }), []);
});

test('API keeps legacy history separate and fail-closed from verified rendering when reconciliation is incomplete', async () => {
  const server = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  const page = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  assert.match(server, /legacyOrders: legacyHistory/);
  assert.match(server, /buildTradeLedger\(sandboxOrders, metadata\)/);
  assert.match(server, /legacyHistory\.push/);
  assert.match(page, /legacyOrders=data\.legacyOrders\|\|\[\]/);
  assert.match(page, /verifiedReconciliationComplete = data\.complete !== false/);
  assert.match(page, /verifiedTrades=verifiedReconciliationComplete \? \(data\.trades\|\|\[\]\) : \[\]/);
  assert.match(page, /verifiedOrders=verifiedReconciliationComplete \? \(data\.orders\|\|\[\]\) : \[\]/);
  assert.match(page, /if \(!verifiedReconciliationComplete\)/);
  assert.match(page, /legacy \/ unverified \| realized P\/L unavailable/);
});
