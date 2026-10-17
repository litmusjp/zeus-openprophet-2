import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { savePluginAndApplyRuntime } from '../agent/plugin-runtime-apply.js';

test('saving a stopped AlphaDesk connection persists without starting any runtime', async () => {
  let saves = 0, starts = 0;
  const result = await savePluginAndApplyRuntime({ sandboxId: 'stopped-sandbox', pluginName: 'alphadesk', pluginBody: { enabled: true },
    getRunningRuntime: () => null, persist: async () => { saves++; }, restart: async () => { starts++; } });
  assert.deepEqual(result, { applied: false });
  assert.equal(saves, 1);
  assert.equal(starts, 0);
});

test('saving a running selected connection restarts that runtime and never reports stale policy as success', async () => {
  let saved = false;
  const restarted = [];
  const runtime = { goReady: true };
  const args = { sandboxId: 'selected-sandbox', pluginName: 'alphadesk', pluginBody: { apiKey: 'new' },
    getRunningRuntime: id => id === 'selected-sandbox' ? runtime : null,
    persist: async (id) => { assert.equal(id, 'selected-sandbox'); saved = true; },
    restart: async id => { restarted.push(id); return { goReady: true }; } };
  assert.deepEqual(await savePluginAndApplyRuntime(args), { applied: true });
  assert.equal(saved, true);
  assert.deepEqual(restarted, ['selected-sandbox']);

  await assert.rejects(savePluginAndApplyRuntime({ ...args, restart: async () => { throw new Error('restart failed'); } }), error => {
    assert.equal(error.status, 503);
    assert.equal(error.saved, true);
    assert.match(error.message, /Start or restart this sandbox/);
    return true;
  });
});

test('running connection without a safe restart lifecycle is rejected before persistence', async () => {
  let persisted = false;
  await assert.rejects(savePluginAndApplyRuntime({ sandboxId: 'selected-sandbox', pluginName: 'alphadesk', pluginBody: { enabled: false },
    getRunningRuntime: () => ({ goReady: true }), persist: async () => { persisted = true; } }), error => {
    assert.equal(error.status, 503);
    assert.match(error.message, /stop it before saving/);
    return true;
  });
  assert.equal(persisted, false);
});

test('running connection with an unavailable execution lifecycle is rejected before persistence', async () => {
  let persisted = false;
  await assert.rejects(savePluginAndApplyRuntime({ sandboxId: 'selected-sandbox', pluginName: 'alphadesk', pluginBody: { enabled: false },
    getRunningRuntime: () => ({ goReady: true }), canRestart: () => false, persist: async () => { persisted = true; }, restart: async () => ({ goReady: true }) }), error => {
    assert.equal(error.status, 503);
    return true;
  });
  assert.equal(persisted, false);
});

test('production plugin route delegates to scoped runtime apply and selected sandbox lifecycle', () => {
  const source = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("app.put('/api/plugins/:name'"), source.indexOf("app.post('/api/plugins/alphadesk/test'"));
  assert.match(route, /savePluginAndApplyRuntime\(/);
  assert.match(route, /orchestrator\.startGoBackend\(id\)/);
  assert.match(route, /startGoBackend\(getAccountById\(getSandbox\(id\)\.accountId\)\)/);
  assert.doesNotMatch(route, /Saving a connection is configuration only/);
});
