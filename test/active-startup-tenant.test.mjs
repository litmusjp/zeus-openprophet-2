import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');

test('active Go startup derives tenant from the bound account and rejects inherited conflicts', () => {
  assert.match(source, /buildGoBackendEnv\(process\.env/);
  assert.doesNotMatch(source, /OPENPROPHET_TENANT_ID:\s*process\.env\.OPENPROPHET_TENANT_ID\s*\|\|\s*account\.id/);
  assert.match(source, /if \(order\.TenantID !== account\.id\) \{\s*localIdentityMismatch/);
  assert.match(source, /complete, broker_state: brokerResult\?\.broker_state/);
});

test('active Go startup preserves the existing binary during forced rebuilds', () => {
  assert.match(source, /if \(!force && existsSync\(binaryPath\)\) return binaryPath;/);
  assert.match(source, /execSync\('go version', \{ cwd: PROJECT_ROOT, stdio: 'pipe' \}\)/);
  assert.match(source, /replaceBinaryWithRollback\(binaryPath, temporaryPath => execSync/);
  assert.match(source, /ensureGoBinarySerialized/);
});

test('active Go startup serializes the global backend lifecycle queue', () => {
  assert.match(source, /let startTail = Promise\.resolve\(\);/);
  assert.match(source, /const run = startTail\.then\(\(\) => startGoBackendUnlocked\(account, sandboxId\)\);/);
  assert.match(source, /startTail = run\.catch\(\(\) => \{\}\);/);
  assert.doesNotMatch(source, /const startTails = new Map/);
});
