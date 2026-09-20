import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('paper default loads persisted Litmus paper accounts without env paper flag or import', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-paper-startup-'));
  const configPath = path.join(dir, 'agent-config.json');
  const previous = {
    config: process.env.OPENPROPHET_CONFIG_PATH,
    mode: process.env.OPENPROPHET_EXECUTION_MODE,
    paper: process.env.ALPACA_PAPER,
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_SECRET_KEY,
  };
  await fs.writeFile(configPath, JSON.stringify({
    accounts: [
      { id: 'litmus1', name: 'Litmus1', brokerAccountId: 'paper-1', paper: true, baseUrl: 'https://paper-api.alpaca.markets', publicKey: 'pk1', secretKey: 'sk1' },
      { id: 'litmus2', name: 'Litmus2', brokerAccountId: 'paper-2', paper: true, baseUrl: 'https://paper-api.alpaca.markets', publicKey: 'pk2', secretKey: 'sk2' },
    ],
  }));
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  delete process.env.OPENPROPHET_EXECUTION_MODE;
  delete process.env.ALPACA_PAPER;
  process.env.ALPACA_API_KEY = 'must-not-import';
  process.env.ALPACA_SECRET_KEY = 'must-not-import';

  try {
    const store = await import(`../agent/config-store.js?paper-startup=${Date.now()}`);
    const config = await store.loadConfig();
    assert.deepEqual(config.accounts.map(account => account.name), ['Litmus1', 'Litmus2']);
    assert.deepEqual(config.accounts.map(account => account.brokerAccountId), ['paper-1', 'paper-2']);
  } finally {
    for (const [key, value] of Object.entries({
      OPENPROPHET_CONFIG_PATH: previous.config,
      OPENPROPHET_EXECUTION_MODE: previous.mode,
      ALPACA_PAPER: previous.paper,
      ALPACA_API_KEY: previous.key,
      ALPACA_SECRET_KEY: previous.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('paper default auto-import uses canonical paper endpoint despite endpoint settings', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-paper-import-'));
  const previous = {
    config: process.env.OPENPROPHET_CONFIG_PATH,
    mode: process.env.OPENPROPHET_EXECUTION_MODE,
    paper: process.env.ALPACA_PAPER,
    endpoint: process.env.ALPACA_BASE_URL,
    key: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_SECRET_KEY,
  };
  process.env.OPENPROPHET_CONFIG_PATH = path.join(dir, 'agent-config.json');
  delete process.env.OPENPROPHET_EXECUTION_MODE;
  delete process.env.ALPACA_PAPER;
  process.env.ALPACA_BASE_URL = 'https://api.alpaca.markets';
  process.env.ALPACA_API_KEY = 'paper-key';
  process.env.ALPACA_SECRET_KEY = 'paper-secret';
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://paper-api.alpaca.markets/v2/account');
    return { ok: true, status: 200, async json() { return { id: 'paper-broker' }; } };
  };

  try {
    const store = await import(`../agent/config-store.js?paper-import=${Date.now()}`);
    const config = await store.loadConfig();
    assert.equal(config.accounts[0].paper, true);
    assert.equal(config.accounts[0].baseUrl, 'https://paper-api.alpaca.markets');
  } finally {
    globalThis.fetch = previousFetch;
    for (const [key, value] of Object.entries({
      OPENPROPHET_CONFIG_PATH: previous.config,
      OPENPROPHET_EXECUTION_MODE: previous.mode,
      ALPACA_PAPER: previous.paper,
      ALPACA_BASE_URL: previous.endpoint,
      ALPACA_API_KEY: previous.key,
      ALPACA_SECRET_KEY: previous.secret,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(dir, { recursive: true, force: true });
  }
});
