import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildGoBackendEnv } from '../agent/orchestrator.js';
import { nativeOpenCodeEnv, stripOperatorSecrets } from '../agent/chatgpt-oauth.js';

test('scoped AD control credential never enters Go or native model environments', () => {
  const base = { ALPHADESK_CONTROL_KEY: 'secret', ALPHADESK_CONTROL_WORKSPACE_ID: 'workspace', BASIC_AUTH_USER: 'operator', BASIC_AUTH_PASS: 'pass', OPENAI_API_KEY: 'provider-key', ANTHROPIC_API_KEY: 'anthropic-key', PATH: 'path' };
  const go = buildGoBackendEnv(base, { account: { id: 'acct', publicKey: 'pk', secretKey: 'sk', brokerAccountId: 'broker', paper: true }, sandboxId: 'sbx', processNonce: 'nonce', port: 1234, databasePath: 'db', activityLogDir: 'logs', permissions: {}, alphaDesk: { enabled: true, apiKey: 'assessment' } });
  assert.equal(go.ALPHADESK_CONTROL_KEY, undefined);
  assert.equal(go.ALPHADESK_CONTROL_WORKSPACE_ID, undefined);
  assert.equal(go.OPENAI_API_KEY, 'provider-key');
  assert.equal(nativeOpenCodeEnv({ dataDir: 'data', env: base }).ALPHADESK_CONTROL_KEY, undefined);
  for (const child of [go, stripOperatorSecrets(base)]) {
    assert.equal(child.BASIC_AUTH_USER, undefined);
    assert.equal(child.BASIC_AUTH_PASS, undefined);
  }
  const otherProvider = stripOperatorSecrets(base);
  assert.equal(otherProvider.OPENAI_API_KEY, 'provider-key');
  assert.equal(otherProvider.ANTHROPIC_API_KEY, 'anthropic-key');
  const oauth = nativeOpenCodeEnv({ dataDir: 'data', env: base });
  assert.equal(oauth.OPENAI_API_KEY, undefined);
});

test('catalog, auth verification, and provider CLI children strip operator secrets without dropping other provider keys', () => {
  const configStore = fs.readFileSync(new URL('../agent/config-store.js', import.meta.url), 'utf8');
  const harness = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const oauth = fs.readFileSync(new URL('../agent/chatgpt-oauth.js', import.meta.url), 'utf8');
  assert.match(configStore, /opencode models 2>&1[^\n]*env: stripOperatorSecrets\(process\.env\)/);
  assert.match(harness, /opencode auth list 2>&1[^\n]*env: stripOperatorSecrets\(process\.env\)/);
  assert.match(server, /opencode auth list 2>&1[^\n]*env: stripOperatorSecrets\(process\.env\)/);
  assert.match(oauth, /const env = \{ \.\.\.minimalEnv\(dataDir\)/);
  assert.match(oauth, /spawn\('opencode',[\s\S]*?\{\s*cwd, env,/);
  const child = stripOperatorSecrets({ ALPHADESK_CONTROL_KEY: 'control', BASIC_AUTH_PASS: 'basic', ANTHROPIC_API_KEY: 'provider-key' });
  assert.equal(child.ALPHADESK_CONTROL_KEY, undefined);
  assert.equal(child.BASIC_AUTH_PASS, undefined);
  assert.equal(child.ANTHROPIC_API_KEY, 'provider-key');
});
