import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');

test('active Go startup derives tenant from the bound account and rejects inherited conflicts', () => {
  assert.match(source, /buildGoBackendEnv\(process\.env/);
  assert.doesNotMatch(source, /OPENPROPHET_TENANT_ID:\s*process\.env\.OPENPROPHET_TENANT_ID\s*\|\|\s*account\.id/);
  assert.match(source, /if \(order\.TenantID !== account\.id\) \{\s*localIdentityMismatch/);
  assert.match(source, /complete: !localIdentityMismatch && !unmatchedFilled/);
});
