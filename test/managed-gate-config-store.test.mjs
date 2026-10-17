import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('config store keeps managed gate requirement through load, plugin merge/save, and active legacy alias', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-managed-gate-config-'));
  const pathName = path.join(dir, 'agent-config.json');
  const oldPath = process.env.OPENPROPHET_CONFIG_PATH;
  const oldMode = process.env.OPENPROPHET_EXECUTION_MODE;
  process.env.OPENPROPHET_CONFIG_PATH = pathName;
  process.env.OPENPROPHET_EXECUTION_MODE = 'disabled';
  const sandbox = { id: 'sbx_fixture', accountId: 'account_fixture', name: 'Fixture', agent: { activeAgentId: 'default' }, plugins: { alphadesk: { enabled: true, url: 'https://api-production-4689.up.railway.app', apiKey: 'fixture', requireManagedApprovalGate: true } } };
  await fs.writeFile(pathName, JSON.stringify({ activeSandboxId: sandbox.id, sandboxes: { [sandbox.id]: sandbox }, accounts: [] }));
  try {
    const store = await import(`../agent/config-store.js?managed-gate-store=${Date.now()}`);
    await store.loadConfig();
    assert.equal(store.getPluginForSandbox(sandbox.id, 'alphadesk').requireManagedApprovalGate, true);
    await store.updatePluginForSandbox(sandbox.id, 'alphadesk', { enabled: true, url: sandbox.plugins.alphadesk.url });
    const saved = JSON.parse(await fs.readFile(pathName, 'utf8'));
    assert.equal(saved.sandboxes[sandbox.id].plugins.alphadesk.requireManagedApprovalGate, true);
    assert.equal(saved.plugins.alphadesk.requireManagedApprovalGate, true);
  } finally {
    if (oldPath === undefined) delete process.env.OPENPROPHET_CONFIG_PATH; else process.env.OPENPROPHET_CONFIG_PATH = oldPath;
    if (oldMode === undefined) delete process.env.OPENPROPHET_EXECUTION_MODE; else process.env.OPENPROPHET_EXECUTION_MODE = oldMode;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
