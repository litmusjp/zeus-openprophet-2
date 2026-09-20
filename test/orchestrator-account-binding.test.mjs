import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('non-active sandbox startup verifies and persists a missing broker binding, then fails closed on verification errors', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-orchestrator-binding-'));
  const configPath = path.join(dir, 'agent-config.json');
  const previous = { config: process.env.OPENPROPHET_CONFIG_PATH, mode: process.env.OPENPROPHET_EXECUTION_MODE };
  const previousFetch = globalThis.fetch;
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  process.env.OPENPROPHET_EXECUTION_MODE = 'paper';
  await fs.writeFile(configPath, JSON.stringify({
    activeAccountId: 'litmus1',
    activeSandboxId: 'sbx_litmus1',
    accounts: [
      { id: 'litmus1', name: 'Litmus1', brokerAccountId: 'paper-1', paper: true, baseUrl: 'https://paper-api.alpaca.markets', publicKey: 'pk1', secretKey: 'sk1' },
      { id: 'litmus2', name: 'Litmus2', brokerAccountId: '', paper: true, baseUrl: 'https://paper-api.alpaca.markets', publicKey: 'pk2', secretKey: 'sk2' },
    ],
  }));

  try {
    const store = await import('../agent/config-store.js');
    await store.loadConfig();
    const { AgentOrchestrator } = await import(`../agent/orchestrator.js?orchestrator-binding=${Date.now()}`);
    const orchestrator = new AgentOrchestrator({ projectRoot: dir });
    const runtime = {
      sandbox: { accountId: 'litmus2' },
      processNonce: '',
      identityHeaders: {},
      goAxios: { defaults: { headers: { common: {} } } },
      port: 4540,
      goProc: { pid: 1234 },
    };
    orchestrator.ensureRuntime = () => runtime;
    orchestrator.stopGoBackend = async () => {};
    orchestrator._ensureBinary = async () => { throw new Error('test stops before spawning'); };

    globalThis.fetch = async (url, options) => {
      assert.equal(url, 'https://paper-api.alpaca.markets/v2/account');
      assert.equal(options.headers['APCA-API-KEY-ID'], 'pk2');
      assert.equal(options.headers['APCA-API-SECRET-KEY'], 'sk2');
      return { ok: true, status: 200, async json() { return { id: 'paper-2-verified' }; } };
    };
    await assert.rejects(() => orchestrator.startGoBackend('sbx_litmus2'), /test stops before spawning/);
    assert.equal(store.getAccountById('litmus2').brokerAccountId, 'paper-2-verified');
    const persisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(persisted.accounts.find(account => account.id === 'litmus2').brokerAccountId, 'paper-2-verified');

    store.getAccountById('litmus2').brokerAccountId = '';
    await store.saveConfig();
    const events = [];
    let reachedBackendStart = false;
    orchestrator.stopGoBackend = async () => {
      events.push('stop');
      runtime.goProc = null;
    };
    orchestrator._ensureBinary = async () => { reachedBackendStart = true; };
    globalThis.fetch = async () => {
      events.push('verify');
      return { ok: false, status: 401 };
    };
    await assert.rejects(() => orchestrator.startGoBackend('sbx_litmus2'), /broker account verification returned HTTP 401/);
    assert.deepEqual(events, ['stop', 'verify']);
    assert.equal(runtime.goProc, null);
    assert.equal(reachedBackendStart, false);

    store.getAccountById('litmus2').brokerAccountId = 'paper-2-persisted';
    await store.saveConfig();
    events.length = 0;
    runtime.goProc = { pid: 1234 };
    reachedBackendStart = false;
    globalThis.fetch = async (url) => {
      events.push('verify');
      assert.equal(url, 'https://paper-api.alpaca.markets/v2/account');
      return { ok: true, status: 200, async json() { return { id: 'paper-2-provider' }; } };
    };
    await assert.rejects(
      () => orchestrator.startGoBackend('sbx_litmus2'),
      /broker account binding mismatch: persisted ID paper-2-persisted differs from provider ID paper-2-provider/,
    );
    assert.deepEqual(events, ['stop', 'verify']);
    assert.equal(runtime.goProc, null);
    assert.equal(reachedBackendStart, false);
    const mismatchPersisted = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(mismatchPersisted.accounts.find(account => account.id === 'litmus2').brokerAccountId, 'paper-2-persisted');
  } finally {
    globalThis.fetch = previousFetch;
    if (previous.config === undefined) delete process.env.OPENPROPHET_CONFIG_PATH;
    else process.env.OPENPROPHET_CONFIG_PATH = previous.config;
    if (previous.mode === undefined) delete process.env.OPENPROPHET_EXECUTION_MODE;
    else process.env.OPENPROPHET_EXECUTION_MODE = previous.mode;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
