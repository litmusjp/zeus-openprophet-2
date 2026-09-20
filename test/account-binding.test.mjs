import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

 test('account binding keeps local identity separate from broker identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-account-binding-'));
  const configPath = path.join(dir, 'agent-config.json');
  const previousConfigPath = process.env.OPENPROPHET_CONFIG_PATH;
  const previousFetch = globalThis.fetch;
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  globalThis.fetch = async (url, options) => {
    assert.match(url, /https:\/\/paper-api\.alpaca\.markets\/v2\/account$/);
    assert.equal(options.headers['APCA-API-KEY-ID'], 'test-key');
    assert.equal(options.headers['APCA-API-SECRET-KEY'], 'test-secret');
    return { ok: true, status: 200, async json() { return { id: 'broker-account-123' }; } };
  };

  try {
    const store = await import(`../agent/config-store.js?account-binding=${Date.now()}`);
    await store.loadConfig();
    const account = await store.addAccount({
      name: 'Paper test',
      publicKey: 'test-key',
      secretKey: 'test-secret',
      paper: true,
    });
    assert.notEqual(account.id, account.brokerAccountId);
    assert.equal(account.brokerAccountId, 'broker-account-123');
    assert.equal(store.getAccountById(account.id).brokerAccountId, 'broker-account-123');
  } finally {
    if (previousConfigPath === undefined) delete process.env.OPENPROPHET_CONFIG_PATH;
    else process.env.OPENPROPHET_CONFIG_PATH = previousConfigPath;
    globalThis.fetch = previousFetch;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('verified trade feed requires broker identity and positive fill evidence', async () => {
  const html = await fs.readFile(path.join(process.cwd(), 'agent', 'public', 'index.html'), 'utf8');
  assert.match(html, /function isBrokerConfirmedFill\(order\)/);
  assert.match(html, /verifiedOrders\.filter\(isBrokerConfirmedFill\)/);
  assert.match(html, /qty > 0/);
  assert.match(html, /price > 0/);
});
