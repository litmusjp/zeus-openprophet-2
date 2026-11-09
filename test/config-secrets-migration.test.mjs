import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const secrets = await import('../agent/secrets-store.js');
const configSecrets = await import('../agent/config-secrets.js');
const { redactSecrets } = await import('../agent/redaction.js');

// Fake values are assembled at run time so a secret scanner does not mistake them for real credentials.
function fakePair(id, tag, digits) { return { id, publicKey: ['PKTEST', tag, '-public-', digits].join(''), secretKey: ['SKTEST', tag, '-secret-', digits, '-private'].join('') }; }
const KEYS = {
  a: fakePair('aaaa1111', 'A', '1111'),
  b: fakePair('bbbb2222', 'B', '2222'),
};
const C_PAIR = fakePair('cccc3333', 'C', '3333');
const AD_GLOBAL = ['AD', 'global', 'key', '0000'].join('-');
const AD_A = ['AD', 'sandbox', 'a', 'key', '1111'].join('-');
const AD_ROTATED = ['AD', 'rotated', 'key', '9999'].join('-');
const ALL_VALUES = [KEYS.a.publicKey, KEYS.a.secretKey, KEYS.b.publicKey, KEYS.b.secretKey, AD_GLOBAL, AD_A];

function account(k, name, brokerAccountId) {
  return { id: k.id, brokerAccountId, name, publicKey: k.publicKey, secretKey: k.secretKey, baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-01-01T00:00:00.000Z' };
}
function plaintextConfig() {
  return {
    schemaVersion: 2,
    activeAccountId: KEYS.a.id,
    activeSandboxId: 'sbx_' + KEYS.a.id,
    accounts: [account(KEYS.a, 'L1', 'broker-a'), account(KEYS.b, 'L2', 'broker-b')],
    plugins: { alphadesk: { enabled: true, url: 'https://ad.example.test', apiKey: AD_GLOBAL, requireManagedApprovalGate: true } },
    sandboxes: {
      ['sbx_' + KEYS.a.id]: { id: 'sbx_' + KEYS.a.id, accountId: KEYS.a.id, name: 'L1', plugins: { alphadesk: { enabled: true, url: 'https://ad.example.test', apiKey: AD_A } } },
      ['sbx_' + KEYS.b.id]: { id: 'sbx_' + KEYS.b.id, accountId: KEYS.b.id, name: 'L2' },
    },
  };
}

let counter = 0;
async function setup({ split, config = plaintextConfig(), secretsFile } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-cfg-secrets-'));
  const configPath = path.join(dir, 'agent-config.json');
  if (config) fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  const filePath = secretsFile || path.join(dir, 'secrets.json');
  secrets.initSecrets({ filePath, split });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  const store = await import('../agent/config-store.js?case=' + (++counter));
  return { dir, configPath, filePath, store };
}
const readDisk = (p) => fs.readFileSync(p, 'utf8');
// default agents and strategies carry load-time timestamps; everything that can hold a key is compared.
const keyed = (c) => JSON.parse(JSON.stringify({ accounts: c.accounts, plugins: c.plugins, sandboxes: c.sandboxes, activeAccountId: c.activeAccountId, activeSandboxId: c.activeSandboxId }));
// key ORDER matters too: the protected config hash is computed from the serialised config.
const ordered = (c) => JSON.stringify({ accounts: c.accounts, plugins: c.plugins, sandboxes: c.sandboxes });
async function silently(fn) {
  const logs = [];
  const { log, error, warn } = console;
  console.log = console.error = console.warn = (...args) => logs.push(args.join(' '));
  try { return { result: await fn(), logs }; } finally { console.log = log; console.error = error; console.warn = warn; }
}

test('migration: the loaded config is identical to the plain-layout one, the file holds markers, and nothing is printed', async () => {
  const baseline = await setup({ split: false });
  await baseline.store.loadConfig();
  const expected = keyed(baseline.store.getConfig());
  assert.ok(ALL_VALUES.every(v => JSON.stringify(expected).includes(v)), 'the baseline really holds the keys in memory');

  const migrated = await setup({ split: true });
  const { logs } = await silently(() => migrated.store.loadConfig());
  assert.deepEqual(keyed(migrated.store.getConfig()), expected, 'the in-memory config is unchanged by the move');
  assert.equal(ordered(migrated.store.getConfig()), ordered(baseline.store.getConfig()), 'same key order, so the config hash does not move');
  assert.deepEqual(redactSecrets(keyed(migrated.store.getConfig())), redactSecrets(expected), 'API output (redacted) is unchanged too');
  assert.ok(logs.every(line => !ALL_VALUES.some(v => line.includes(v))), 'no key is ever printed');
  assert.ok(logs.some(line => /Moved 4 stored key/.test(line)), 'the move is reported by count only');

  await migrated.store.saveConfig();
  const onDisk = readDisk(migrated.configPath);
  assert.ok(ALL_VALUES.every(v => !onDisk.includes(v)), 'agent-config.json holds no key');
  assert.match(onDisk, /"secretRef": "account:aaaa1111"/);
  assert.match(onDisk, /"apiKeyRef": "alphadesk:global"/);
  assert.match(onDisk, /"apiKeyRef": "alphadesk:sbx_aaaa1111"/);
  const store = JSON.parse(readDisk(migrated.filePath));
  assert.equal(store.accounts[KEYS.a.id].secretKey, KEYS.a.secretKey);
  assert.equal(store.accounts[KEYS.b.id].publicKey, KEYS.b.publicKey);
  // the existing legacy alias copies the active sandbox's AlphaDesk settings onto the global ones, as it always did
  assert.equal(store.alphadesk['alphadesk:global'], AD_A);
  assert.equal(store.alphadesk['alphadesk:sbx_aaaa1111'], AD_A);

  const backups = fs.readdirSync(path.dirname(migrated.configPath)).filter(n => n.startsWith('agent-config.pre-secrets-'));
  assert.equal(backups.length, 1, 'one backup of the original file');
  assert.ok(ALL_VALUES.every(v => readDisk(path.join(path.dirname(migrated.configPath), backups[0])).includes(v)), 'the backup is the original, keys included');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(path.dirname(migrated.configPath), backups[0])).mode & 0o777, 0o600);
});

test('a second start reads the markers back and gives the same config', async () => {
  const first = await setup({ split: true });
  await silently(() => first.store.loadConfig());
  const expected = keyed(first.store.getConfig());
  await first.store.saveConfig();

  // a new process: same files, fresh module state
  secrets.initSecrets({ filePath: first.filePath, split: true });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = first.configPath;
  const second = await import('../agent/config-store.js?case=' + (++counter));
  const { logs } = await silently(() => second.loadConfig());
  assert.deepEqual(keyed(second.getConfig()), expected);
  assert.equal(ordered(second.getConfig()), ordered(first.store.getConfig()), 'a reload from markers keeps the original key order');
  assert.ok(!logs.some(l => /Moved/.test(l)), 'nothing is moved a second time');
  await second.saveConfig();
  assert.equal(fs.readdirSync(path.dirname(first.configPath)).filter(n => n.startsWith('agent-config.pre-secrets-')).length, 1, 'no second backup');
});

test('new and changed keys reach the private file; a removed account is forgotten; the config file stays free of keys', async () => {
  const ctx = await setup({ split: true });
  await silently(() => ctx.store.loadConfig());
  await ctx.store.saveConfig();

  const config = ctx.store.getConfig();
  config.accounts.push(account(C_PAIR, 'L3', 'broker-c'));
  config.sandboxes.sbx_cccc3333 = { id: 'sbx_cccc3333', accountId: 'cccc3333', name: 'L3' };
  await ctx.store.updatePluginForSandbox('sbx_aaaa1111', 'alphadesk', { apiKey: AD_ROTATED });
  await ctx.store.saveConfig();
  let store = JSON.parse(readDisk(ctx.filePath));
  assert.equal(store.accounts.cccc3333.secretKey, C_PAIR.secretKey);
  assert.equal(store.alphadesk['alphadesk:sbx_aaaa1111'], AD_ROTATED);
  let onDisk = readDisk(ctx.configPath);
  for (const v of [C_PAIR.publicKey, C_PAIR.secretKey, AD_ROTATED, ...ALL_VALUES]) assert.ok(!onDisk.includes(v), 'no key in the config file');

  await ctx.store.removeAccount('bbbb2222');
  store = JSON.parse(readDisk(ctx.filePath));
  assert.equal(store.accounts.bbbb2222, undefined);
  assert.ok(store.accounts.aaaa1111 && store.accounts.cccc3333);
  onDisk = readDisk(ctx.configPath);
  assert.ok(!onDisk.includes('bbbb2222') || !onDisk.includes('"secretRef": "account:bbbb2222"'));
});

test('if the private file cannot be written the old layout is kept and the config still works', async () => {
  const blocker = path.join(os.tmpdir(), 'op2-not-a-folder-' + process.pid);
  fs.writeFileSync(blocker, 'x');
  try {
    const ctx = await setup({ split: true, secretsFile: path.join(blocker, 'secrets.json') });
    const { logs } = await silently(() => ctx.store.loadConfig());
    assert.equal(configSecrets.isActive(), false);
    // Windows reports the missing folder as a failed write (migration_failed...); Linux reports the non-folder parent
    // as an unreadable store when the store is opened. Either way the old layout stays in force.
    assert.ok(logs.some(l => /(migration_failed_old_layout_kept|store_unreadable_old_layout_kept)/.test(l)) || secrets.isCorrupt());
    assert.ok(logs.every(l => !ALL_VALUES.some(v => l.includes(v))));
    assert.ok(ALL_VALUES.every(v => JSON.stringify(ctx.store.getConfig()).includes(v)), 'keys still in memory');
    await ctx.store.saveConfig();
    assert.ok(ALL_VALUES.every(v => readDisk(ctx.configPath).includes(v)), 'the file keeps the plain layout');
  } finally { fs.rmSync(blocker, { force: true }); }
});

test('an unreadable private file keeps markers untouched and never writes empty keys over them', async () => {
  const seed = await setup({ split: true });
  await silently(() => seed.store.loadConfig());
  await seed.store.saveConfig();
  const markersOnly = readDisk(seed.configPath);
  fs.writeFileSync(seed.filePath, '{broken');

  secrets.initSecrets({ filePath: seed.filePath, split: true });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = seed.configPath;
  const again = await import('../agent/config-store.js?case=' + (++counter));
  await silently(() => again.loadConfig());
  assert.equal(configSecrets.isActive(), false);
  await again.saveConfig();
  const after = JSON.parse(readDisk(seed.configPath));
  assert.equal(after.accounts[0].secretRef, 'account:aaaa1111', 'the marker survives');
  assert.equal(after.accounts[0].publicKey, undefined);
  assert.equal(JSON.parse(markersOnly).accounts.length, after.accounts.length);
  assert.equal(readDisk(seed.filePath), '{broken', 'the unreadable file is left alone');
});

test('a marker whose key is missing stays a marker and the other keys are unaffected', async () => {
  const seed = await setup({ split: true });
  await silently(() => seed.store.loadConfig());
  await seed.store.saveConfig();
  const store = JSON.parse(readDisk(seed.filePath));
  delete store.accounts.bbbb2222;
  fs.writeFileSync(seed.filePath, JSON.stringify(store));

  secrets.initSecrets({ filePath: seed.filePath, split: true });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = seed.configPath;
  const again = await import('../agent/config-store.js?case=' + (++counter));
  const { logs } = await silently(() => again.loadConfig());
  assert.ok(logs.some(l => /account_keys_missing/.test(l)));
  assert.equal(again.getAccountById('bbbb2222').secretKey, undefined, 'the missing key is not invented');
  assert.equal(again.getAccountById('aaaa1111').secretKey, KEYS.a.secretKey);
  await again.saveConfig();
  const disk = JSON.parse(readDisk(seed.configPath));
  assert.equal(disk.accounts.find(a => a.id === 'bbbb2222').secretRef, 'account:bbbb2222', 'the marker is kept so the reference is not lost');
});

test('with the split off (tests, inert mode) nothing about the file layout changes', async () => {
  const ctx = await setup({ split: false });
  await ctx.store.loadConfig();
  await ctx.store.saveConfig();
  assert.ok(ALL_VALUES.every(v => readDisk(ctx.configPath).includes(v)));
  assert.ok(!fs.existsSync(ctx.filePath), 'no private file is created');
});
