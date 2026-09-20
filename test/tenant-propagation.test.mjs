import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGoBackendEnv } from '../agent/orchestrator.js';

const account = { id: 'tenant-account', brokerAccountId: 'broker-1', paper: true, publicKey: 'public', secretKey: 'secret' };

test('spawned Go env carries server-owned tenant for every sandbox', () => {
  const env = buildGoBackendEnv({}, { account, sandboxId: 'sandbox-2', processNonce: 'nonce', port: 4555, databasePath: 'db', activityLogDir: 'logs', permissions: {} });
  assert.equal(env.OPENPROPHET_TENANT_ID, account.id);
});

test('contradictory or missing server-owned tenant fails closed', () => {
  assert.throws(() => buildGoBackendEnv({ OPENPROPHET_TENANT_ID: 'caller-tenant' }, { account, sandboxId: 'sandbox-2', processNonce: 'nonce', port: 4555, databasePath: 'db', activityLogDir: 'logs', permissions: {} }), /conflicts/);
  assert.throws(() => buildGoBackendEnv({}, { account: { ...account, id: '' }, sandboxId: 'sandbox-2', processNonce: 'nonce', port: 4555, databasePath: 'db', activityLogDir: 'logs', permissions: {} }), /missing/);
});
