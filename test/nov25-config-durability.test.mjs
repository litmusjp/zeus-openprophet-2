import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Nov 25 hardening H1: a config (or session index) that cannot be read is never replaced by defaults, saves publish atomically, the
// known-good .bak is the previous ON-DISK form, and recovery never imports a broker or touches secrets from a rejected candidate.
// All keys here are synthetic sentinels assembled at run time. Injected fs errors are used where chmod would be bypassed by root.

const secrets = await import('../agent/secrets-store.js');
const configSecrets = await import('../agent/config-secrets.js');
const { publishAtomic, preserveEvidence, classifyReadError, isJsonObjectBytes } = await import('../agent/durable-file.js');
const { ChatStore, HistoryIndexUnavailableError, isHistoryIndexUnavailable } = await import('../agent/chat-store.js');

const PUB = ['PKTEST', 'DUR', '-public-', '4242'].join('');
const SEC = ['SKTEST', 'DUR', '-secret-', '4242', '-private'].join('');
const ENV_PUB = ['PKENV', '-public-', '7777'].join('');
const ENV_SEC = ['SKENV', '-secret-', '7777', '-private'].join('');
const ID = 'dur00001';

const account = () => ({ id: ID, brokerAccountId: 'broker-dur', name: 'L1', publicKey: PUB, secretKey: SEC, baseUrl: 'https://paper-api.alpaca.markets', paper: true, createdAt: '2026-01-01T00:00:00.000Z' });
const plaintextConfig = () => ({ schemaVersion: 2, activeAccountId: ID, activeSandboxId: 'sbx_' + ID, accounts: [account()], sandboxes: { ['sbx_' + ID]: { id: 'sbx_' + ID, accountId: ID, name: 'L1' } } });
const markerConfig = () => { const c = plaintextConfig(); delete c.accounts[0].publicKey; delete c.accounts[0].secretKey; c.accounts[0].secretRef = 'account:' + ID; return c; };

let counter = 0;
async function setup({ split = true, config, mode = 'paper', backup } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-dur-'));
  const configPath = path.join(dir, 'agent-config.json');
  if (config !== undefined) fs.writeFileSync(configPath, typeof config === 'string' ? config : JSON.stringify(config, null, 2));
  if (backup !== undefined) fs.writeFileSync(configPath + '.bak', typeof backup === 'string' ? backup : JSON.stringify(backup, null, 2));
  const filePath = path.join(dir, 'secrets.json');
  secrets.initSecrets({ filePath, split });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  process.env.OPENPROPHET_EXECUTION_MODE = mode;
  process.env.ALPACA_PUBLIC_KEY = ENV_PUB; process.env.ALPACA_SECRET_KEY = ENV_SEC;   // sentinel: a broker import would call fetch
  const store = await import('../agent/config-store.js?dur=' + (++counter));
  return { dir, configPath, filePath, store };
}
const calls = [];
const realFetch = globalThis.fetch;
test.before(() => { globalThis.fetch = async (...args) => { calls.push(String(args[0])); throw new Error('network is not allowed in this test'); }; });
test.after(() => { globalThis.fetch = realFetch; delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY; process.env.OPENPROPHET_EXECUTION_MODE = 'inert'; });
const quiet = async fn => { const lines = []; const { log, error, warn } = console; console.log = console.error = console.warn = (...a) => lines.push(a.join(' ')); try { return { value: await fn(), lines }; } catch (e) { return { error: e, lines }; } finally { console.log = log; console.error = error; console.warn = warn; } };
const listing = dir => fs.readdirSync(dir).sort();
const bytes = p => fs.readFileSync(p);
const idsOf = store => store.getConfig().accounts.map(a => a.id);

test('save is atomic: no temp file is left, the first save has no .bak, the second keeps the previous ON-DISK bytes as the known-good .bak', async () => {
  const s = await setup({ split: false, config: plaintextConfig() });
  const before = bytes(s.configPath);
  await quiet(() => s.store.loadConfig());                       // active load saves once
  assert.ok(!fs.existsSync(s.configPath + '.bak') || bytes(s.configPath + '.bak').equals(before), 'the .bak is the previous disk form');
  await s.store.saveConfig();
  assert.ok(isJsonObjectBytes(bytes(s.configPath + '.bak')));
  assert.deepEqual(listing(s.dir).filter(n => n.endsWith('.tmp')), [], 'no temp file left behind');
  assert.equal(calls.length, 0);
});

test('a truncated primary with a valid .bak is recovered from the backup; the original bytes are kept as evidence; the backup stays good; no broker import', async () => {
  const good = markerConfig();
  const s = await setup({ config: '{"accounts":[{"id":"x"', backup: good });
  secrets.setAccountKeys(ID, { publicKey: PUB, secretKey: SEC }); secrets.saveSecrets();
  const badBytes = bytes(s.configPath);
  const bakBefore = bytes(s.configPath + '.bak');
  const { error, lines } = await quiet(() => s.store.loadConfig());
  assert.equal(error, undefined);
  assert.deepEqual(idsOf(s.store), [ID]);
  const evidence = listing(s.dir).filter(n => n.includes('.corrupt-'));
  assert.equal(evidence.length, 1);
  assert.ok(bytes(path.join(s.dir, evidence[0])).equals(badBytes), 'the corrupt bytes are preserved exactly');
  assert.ok(bytes(s.configPath + '.bak').equals(bakBefore), 'a corrupt primary never replaces the good .bak');
  assert.ok(isJsonObjectBytes(bytes(s.configPath)), 'the primary is valid again');
  assert.equal(calls.length, 0, 'no broker import');
  assert.ok(lines.every(l => !l.includes('"id":"x"') && !l.includes(PUB) && !l.includes(SEC)), 'logs carry a stage and a code, never a file fragment or a key');
});

test('a corrupt primary with NO usable backup refuses to start, leaves the bytes untouched, imports no broker and writes nothing else but evidence', async () => {
  const s = await setup({ config: '{"accounts":[{"id":"x"' });
  const original = bytes(s.configPath);
  const { error } = await quiet(() => s.store.loadConfig());
  assert.equal(error?.code, 'CONFIG_UNRECOVERABLE');
  assert.ok(bytes(s.configPath).equals(original), 'primary untouched');
  assert.deepEqual(listing(s.dir).filter(n => !n.includes('.corrupt-') && n !== 'agent-config.json' && n !== 'secrets.json'), []);
  assert.equal(calls.length, 0);
});

test('both files unusable: refuse, both untouched', async () => {
  const s = await setup({ config: '{', backup: 'not json' });
  const a = bytes(s.configPath), b = bytes(s.configPath + '.bak');
  assert.equal((await quiet(() => s.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.ok(bytes(s.configPath).equals(a) && bytes(s.configPath + '.bak').equals(b));
  assert.equal(calls.length, 0);
});

test('valid JSON of the wrong shape (null, array, string) is corrupt, not a new virgin install', async () => {
  for (const text of ['null', '[]', '"x"', '42']) {
    const s = await setup({ config: text });
    assert.equal((await quiet(() => s.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE', text);
    assert.equal(bytes(s.configPath).toString(), text);
  }
  assert.equal(calls.length, 0);
});

test('a candidate that fails normalisation or secret preparation is rejected with its bookkeeping restored and nothing published', async () => {
  const s = await setup({ config: JSON.stringify({ accounts: [null], sandboxes: {} }) });
  const original = bytes(s.configPath);
  assert.equal((await quiet(() => s.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.ok(bytes(s.configPath).equals(original));
  assert.equal(configSecrets.unresolvedCount(), 0, 'no leaked bookkeeping from the rejected candidate');
  assert.equal(calls.length, 0);
});

test('a backup whose key references cannot be resolved is not used for recovery', async () => {
  const s = await setup({ config: '{', backup: markerConfig() });      // the private store holds no keys for the marker
  assert.equal((await quiet(() => s.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.equal(configSecrets.unresolvedCount(), 0);
  assert.ok(isJsonObjectBytes(bytes(s.configPath + '.bak')));
});

test('first run: a missing primary and no backup bootstraps defaults exactly as before (no refusal)', async () => {
  delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY;
  const s = await setup({});
  delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY;
  const { error } = await quiet(() => s.store.loadConfig());
  assert.equal(error, undefined);
  assert.deepEqual(s.store.getConfig().accounts, []);
  assert.ok(fs.existsSync(s.configPath));
});

test('an absent primary with a valid backup recovers from the backup (absent is not automatically a virgin install)', async () => {
  const s = await setup({ backup: plaintextConfig(), split: false });
  const { error } = await quiet(() => s.store.loadConfig());
  assert.equal(error, undefined);
  assert.deepEqual(idsOf(s.store), [ID]);
  assert.equal(calls.length, 0);
});

test('an unreadable primary (an access or storage error, here EISDIR) is never renamed or defaulted over: active mode refuses, inert mode starts on defaults and writes nothing', async () => {
  const active = await setup({});
  fs.mkdirSync(active.configPath);
  assert.equal((await quiet(() => active.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.ok(fs.statSync(active.configPath).isDirectory());
  const inert = await setup({ mode: 'inert' });
  fs.mkdirSync(inert.configPath);
  const before = listing(inert.dir);
  const { error } = await quiet(() => inert.store.loadConfig());
  assert.equal(error, undefined);
  assert.deepEqual(listing(inert.dir), before, 'inert inspection creates and renames nothing');
  assert.equal(calls.length, 0);
});

test('inert mode with a corrupt primary starts on defaults and writes nothing (no evidence file, no save)', async () => {
  const s = await setup({ mode: 'inert', config: '{broken' });
  const before = listing(s.dir), original = bytes(s.configPath);
  assert.equal((await quiet(() => s.store.loadConfig())).error, undefined);
  assert.deepEqual(listing(s.dir), before);
  assert.ok(bytes(s.configPath).equals(original));
});

test('secrets: the disk form and every backup hold markers, never hydrated keys; the legacy plaintext backup is restricted (0600)', async () => {
  const s = await setup({ split: true, config: plaintextConfig() });
  await quiet(() => s.store.loadConfig());                         // migrates: primary now holds markers; the previous plaintext form may be backed up
  await s.store.saveConfig();                                      // second save: .bak = the marker form
  const primary = bytes(s.configPath).toString(), bak = bytes(s.configPath + '.bak').toString();
  assert.ok(!primary.includes(PUB) && !primary.includes(SEC), 'primary holds markers only');
  assert.ok(!bak.includes(PUB) && !bak.includes(SEC), 'the newest .bak is the marker form, never the hydrated in-memory object');
  for (const name of listing(s.dir)) {
    if (!name.includes('pre-secrets') && !name.endsWith('.bak')) continue;
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(s.dir, name)).mode & 0o077, 0, name + ' is restricted');
  }
  assert.ok(s.store.getConfig().accounts[0].publicKey === PUB, 'memory still holds the real key for every reader');
});

// ── publishAtomic (injected failures) ─────────────────────────────────────────────────────────────────────────────────────────────
function failing(failOn) {
  const real = fs.promises;
  return new Proxy(real, { get(target, prop) {
    const value = target[prop];
    if (typeof value !== 'function') return value;
    return async (...args) => {
      if (failOn(String(prop), args)) throw Object.assign(new Error('injected'), { code: 'EIO' });
      return value.apply(target, args);
    };
  } });
}
const dirWith = (name, text) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-pub-')); const file = path.join(dir, name); if (text !== undefined) fs.writeFileSync(file, text); return { dir, file }; };

test('publishAtomic: a failed temp write or a failed rename leaves the target intact and no temp file; a success returns the backup status', async () => {
  const { dir, file } = dirWith('c.json', '{"accounts":[]}');
  const failOpen = failing((p, a) => p === 'open' && String(a[0]).endsWith('.tmp'));
  await assert.rejects(publishAtomic(file, '{"accounts":[1]}', { backup: true, fsx: failOpen }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts":[]}');
  const failRename = failing((p, a) => p === 'rename' && String(a[1]) === file);
  await assert.rejects(publishAtomic(file, '{"accounts":[2]}', { backup: true, fsx: failRename }));
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts":[]}', 'target intact after a failed rename');
  assert.deepEqual(listing(dir).filter(n => n.endsWith('.tmp')), []);
  const ok = await publishAtomic(file, '{"accounts":[3]}', { backup: true });
  assert.equal(ok.backup, 'written');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{"accounts":[]}');
});

test('publishAtomic: a failed backup publication does not block the primary; an invalid current file never replaces a good .bak; a directory sync failure after the rename is not an error', async () => {
  const { dir, file } = dirWith('c.json', '{"accounts":[]}');
  fs.writeFileSync(file + '.bak', '{"accounts":["good"]}');
  const failBak = failing((p, a) => p === 'rename' && String(a[1]).endsWith('.bak'));
  const r1 = await publishAtomic(file, '{"accounts":[1]}', { backup: true, fsx: failBak });
  assert.equal(r1.backup, 'failed');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts":[1]}');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{"accounts":["good"]}', 'the old good .bak survives a failed backup publication');
  fs.writeFileSync(file, '{corrupt');
  const r2 = await publishAtomic(file, '{"accounts":[2]}', { backup: true });
  assert.equal(r2.backup, 'skipped_invalid');
  assert.equal(fs.readFileSync(file + '.bak', 'utf8'), '{"accounts":["good"]}', 'a corrupt primary never replaces the good .bak');
  const syncFail = failing((p, a) => p === 'open' && String(a[1]) === 'r');
  const r3 = await publishAtomic(file, '{"accounts":[3]}', { backup: false, fsx: syncFail });
  assert.equal(r3.backup, 'none');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts":[3]}');
  assert.deepEqual(listing(dir).filter(n => n.endsWith('.tmp')), []);
});

test('publishAtomic keeps the existing file mode (never wider) and creates new files restricted', async () => {
  if (process.platform === 'win32') return;
  const { file } = dirWith('c.json', '{"accounts":[]}');
  fs.chmodSync(file, 0o640);
  await publishAtomic(file, '{"accounts":[1]}', { backup: false });
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  const fresh = dirWith('n.json');
  await publishAtomic(fresh.file, '{"accounts":[1]}');
  assert.equal(fs.statSync(fresh.file).mode & 0o077, 0);
});

test('preserveEvidence copies exact bytes once per distinct content (0600) and never moves the original', async () => {
  const { dir, file } = dirWith('c.json', '{"secret-ish": "x"');
  const name = await preserveEvidence(file);
  assert.ok(name && name.startsWith('c.json.corrupt-'));
  assert.equal(await preserveEvidence(file), name, 'idempotent for the same bytes');
  assert.equal(listing(dir).filter(n => n.includes('.corrupt-')).length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"secret-ish": "x"');
  assert.equal(classifyReadError({ code: 'ENOENT' }), 'absent');
  assert.equal(classifyReadError({ code: 'EACCES' }), 'access');
  assert.equal(classifyReadError(new SyntaxError('x')), 'corrupt');
});

// ── chat session index ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('session index (store level): a first index is empty; a corrupt index recovers from its backup with the evidence kept; without a backup it is a typed error, never replaced by an empty index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-idx-'));
  const store = new ChatStore(dir);
  assert.deepEqual((await store._loadSessionIndex('acc1')).sessions, [], 'ENOENT with no backup is a first index');
  await store.startSession('acc1', 's1', { agentId: 'catalyst', agentName: 'Herald' });
  await store.addMessage('acc1', 's1', { role: 'assistant', content: 'one' });
  await store.addMessage('acc1', 's1', { role: 'assistant', content: 'two' });                // the second save creates the .bak of the first
  const indexFile = store._sessionIndexFile('acc1');
  assert.ok(isJsonObjectBytes(fs.readFileSync(indexFile + '.bak')));
  const good = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(good.sessions[0].messageCount, 2);
  assert.equal(good.sessions[0].metadata.agentName, 'Herald');
  const jsonl = store._sessionFile('acc1', 's1'); const jsonlBefore = fs.readFileSync(jsonl);
  fs.writeFileSync(indexFile, '{"sessions":[');
  const recovered = await store._loadSessionIndex('acc1');
  assert.equal(recovered.sessions.length, 1);
  assert.equal(recovered.sessions[0].metadata.agentName, 'Herald');
  assert.equal(fs.readdirSync(path.dirname(indexFile)).filter(n => n.includes('.corrupt-')).length, 1, 'the corrupt bytes were kept as evidence');
  fs.rmSync(indexFile + '.bak');
  fs.writeFileSync(indexFile, '{"sessions":[');
  await assert.rejects(store._loadSessionIndex('acc1'), isHistoryIndexUnavailable);
  await assert.rejects(store.startSession('acc1', 's2', { agentId: 'catalyst' }), isHistoryIndexUnavailable);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"sessions":[', 'the unreadable index file is never overwritten');
  assert.ok(fs.readFileSync(jsonl).equals(jsonlBefore), 'the message files are untouched');
});

test('session index (store level): concurrent appends keep their counts and an unreadable index (access error) is a typed error, not empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-idx2-'));
  const store = new ChatStore(dir);
  await store.startSession('acc2', 's1', {});
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.addMessage('acc2', 's1', { role: 'assistant', content: 'm' + i })));
  const indexFile = store._sessionIndexFile('acc2');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).sessions[0].messageCount, 12);
  fs.renameSync(indexFile, indexFile + '.moved'); fs.mkdirSync(indexFile);                  // EISDIR on read
  await assert.rejects(store._loadSessionIndex('acc2'), isHistoryIndexUnavailable);
  fs.rmdirSync(indexFile); fs.renameSync(indexFile + '.moved', indexFile);                  // later writes work again
  await store.addMessage('acc2', 's1', { role: 'assistant', content: 'after' });
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).sessions[0].messageCount, 13);
});

// ── Hermes hardening QA corrections (H1-01 .. H1-06, N3, N4) ───────────────────────────────────────────────────────────────────────
import nodeFs from 'node:fs';
import fsp from 'node:fs/promises';
const { createChatsListHandler } = await import('../agent/chats-route.js');

const adSlot = () => ({ enabled: true, url: 'https://ad.example.test', apiKeyRef: 'alphadesk:global' });
async function reopen(s) {
  secrets.initSecrets({ filePath: s.filePath, split: true });
  configSecrets.resetForTests();
  process.env.OPENPROPHET_CONFIG_PATH = s.configPath;
  process.env.OPENPROPHET_EXECUTION_MODE = 'paper';
  return import('../agent/config-store.js?dur=' + (++counter));
}
const seedKeys = () => { secrets.setAccountKeys(ID, { publicKey: PUB, secretKey: SEC }); secrets.saveSecrets(); };

test('H1-01: markers that cannot be resolved refuse active startup for the PRIMARY too (no publication, no save, no fallback to an older backup); healthy and legacy plaintext controls load', async () => {
  const a = await setup({ config: markerConfig() });
  const before = bytes(a.configPath);
  const r1 = await quiet(() => a.store.loadConfig());
  assert.equal(r1.error?.code, 'CONFIG_UNRECOVERABLE'); assert.match(r1.error.message, /keys_missing/);
  assert.ok(bytes(a.configPath).equals(before) && !fs.existsSync(a.configPath + '.bak'), 'no rewrite, no backup');
  assert.equal(configSecrets.unresolvedCount(), 0);
  // a syntactically valid NEWER primary with missing keys is not silently replaced by an older, resolvable backup
  const b = await setup({ config: markerConfig(), backup: plaintextConfig() });
  const bBefore = bytes(b.configPath);
  assert.equal((await quiet(() => b.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.ok(bytes(b.configPath).equals(bBefore));
  // AlphaDesk key marker (global) missing while the account key exists
  const c = await setup({ config: { ...markerConfig(), plugins: { alphadesk: adSlot() } } });
  seedKeys();
  assert.match((await quiet(() => c.store.loadConfig())).error?.message || '', /keys_missing/);
  // markers + corrupt private store: refuse, and the corrupt private bytes are left exactly as they were
  const d = await setup({ config: markerConfig() });
  fs.writeFileSync(d.filePath, '{not json');
  secrets.initSecrets({ filePath: d.filePath, split: true }); configSecrets.resetForTests();
  const corruptBytes = bytes(d.filePath);
  assert.equal(secrets.isCorrupt(), true);
  const r4 = await quiet(() => d.store.loadConfig());
  assert.match(r4.error?.message || '', /private_store_unavailable/);
  assert.ok(bytes(d.filePath).equals(corruptBytes));
  // backup markers while the private store is corrupt: also refused (reference checking is not bypassed)
  const e = await setup({ config: '{', backup: markerConfig() });
  fs.writeFileSync(e.filePath, '{not json'); secrets.initSecrets({ filePath: e.filePath, split: true }); configSecrets.resetForTests();
  assert.equal((await quiet(() => e.store.loadConfig())).error?.code, 'CONFIG_UNRECOVERABLE');
  assert.equal(configSecrets.unresolvedCount(), 0, 'overlapping unresolved names across candidates leave no bookkeeping behind');
  // positive controls
  const ok = await setup({ config: markerConfig() }); seedKeys();
  assert.equal((await quiet(() => ok.store.loadConfig())).error, undefined);
  const legacy = await setup({ config: plaintextConfig() });
  assert.equal((await quiet(() => legacy.store.loadConfig())).error, undefined);
  assert.equal(calls.length, 0);
});

test('H1-02: an absent primary with an existing unusable backup is NOT a virgin install (malformed, unresolved, unreadable); two genuinely absent files still bootstrap', async () => {
  for (const [label, make] of [
    ['malformed', s => fs.writeFileSync(s.configPath + '.bak', '{bad')],
    ['unresolved', s => fs.writeFileSync(s.configPath + '.bak', JSON.stringify(markerConfig()))],
    ['unreadable', s => fs.mkdirSync(s.configPath + '.bak')],
  ]) {
    const s = await setup({});
    delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY;
    make(s);
    const { error } = await quiet(() => s.store.loadConfig());
    assert.equal(error?.code, 'CONFIG_UNRECOVERABLE', label);
    assert.ok(!fs.existsSync(s.configPath), label + ': no default primary was created');
    assert.equal(configSecrets.unresolvedCount(), 0);
  }
  const inert = await setup({ mode: 'inert' });
  fs.writeFileSync(inert.configPath + '.bak', '{bad');
  const before = listing(inert.dir);
  assert.equal((await quiet(() => inert.store.loadConfig())).error, undefined);
  assert.deepEqual(listing(inert.dir), before, 'inert inspection writes nothing');
  const virgin = await setup({});
  delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY;
  assert.equal((await quiet(() => virgin.store.loadConfig())).error, undefined);
  assert.ok(fs.existsSync(virgin.configPath));
});

test('H1-03: recovery never lets a parseable but rejected primary replace the good backup; normal saves back up the previous ACCEPTED disk form', async () => {
  const good = JSON.stringify(markerConfig(), null, 2);
  const s = await setup({ config: JSON.stringify({ accounts: [null], sandboxes: {} }), backup: good });
  seedKeys();
  const bakBytes = bytes(s.configPath + '.bak');
  assert.equal((await quiet(() => s.store.loadConfig())).error, undefined);
  assert.ok(bytes(s.configPath + '.bak').equals(bakBytes), 'the good .bak is byte-for-byte unchanged after recovery');
  await s.store.saveConfig();
  assert.ok(JSON.parse(bytes(s.configPath + '.bak').toString()).accounts.every(a => a && a.id), 'the rejected primary (a null account) never became the backup');
  const store2 = await reopen(s);
  assert.equal((await quiet(() => store2.loadConfig())).error, undefined);
  assert.deepEqual(store2.getConfig().accounts.map(a => a.id), [ID]);
  const n = await setup({ config: markerConfig() }); seedKeys();
  await quiet(() => n.store.loadConfig());
  const afterLoad = bytes(n.configPath);
  await n.store.saveConfig();
  assert.ok(bytes(n.configPath + '.bak').equals(afterLoad), 'the .bak holds the accepted previous bytes');
  assert.ok(!bytes(n.configPath + '.bak').toString().includes(PUB));
});

test('H1-04: a plain inert load never adopts or writes; the explicit rehearsal exception does; a failed migration restores the previous keys instead of deleting them; the evidence backup is created exclusively with 0600; errors never leak', async () => {
  const plain = await setup({ mode: 'inert', config: plaintextConfig(), split: true });
  const before = listing(plain.dir);
  delete process.env.OPENPROPHET_SECRETS_SPLIT;
  await quiet(() => plain.store.loadConfig());
  assert.deepEqual(listing(plain.dir), before, 'plain inert + split writes nothing (no private file, no pre-secrets backup)');
  const rehearsal = await setup({ mode: 'inert', config: plaintextConfig(), split: true });
  process.env.OPENPROPHET_SECRETS_SPLIT = '1';
  try { await quiet(() => rehearsal.store.loadConfig()); } finally { delete process.env.OPENPROPHET_SECRETS_SPLIT; }
  assert.ok(listing(rehearsal.dir).some(n => n.includes('pre-secrets')), 'the documented rehearsal exception does adopt');

  const OLD = { publicKey: ['PKOLD', '-public-', '1'].join(''), secretKey: ['SKOLD', '-secret-', '1'].join('') };
  const OTHER = { publicKey: ['PKOTH', '-public-', '2'].join(''), secretKey: ['SKOTH', '-secret-', '2'].join('') };
  const s = await setup({ split: true, config: plaintextConfig() });
  secrets.setAccountKeys(ID, OLD); secrets.setAccountKeys('other0001', OTHER); secrets.setAlphaDeskKey('alphadesk:global', 'AD-OLD-KEY-0'); secrets.saveSecrets();
  const realRead = nodeFs.readFileSync, SENTINEL = 'sentinel-eio-message-zz91';
  const opens = [], realOpen = nodeFs.openSync;
  let armed = true;
  nodeFs.readFileSync = function (p, ...rest) { if (armed && String(p) === s.filePath && new Error().stack.includes('readFromDiskFresh')) throw Object.assign(new Error(SENTINEL), { code: 'EIO' }); return realRead.call(this, p, ...rest); };
  nodeFs.openSync = function (p, flags, mode) { if (String(p).includes('pre-secrets')) opens.push({ flags, mode }); return realOpen.call(this, p, flags, mode); };
  let outcome;
  try { outcome = await quiet(() => s.store.loadConfig()); } finally { armed = false; nodeFs.readFileSync = realRead; nodeFs.openSync = realOpen; }
  const persisted = JSON.parse(realRead(s.filePath, 'utf8'));
  assert.deepEqual(persisted.accounts[ID], OLD, 'the previous account keys are restored, not deleted');
  assert.deepEqual(persisted.accounts.other0001, OTHER, 'unrelated keys are untouched');
  assert.equal(persisted.alphadesk['alphadesk:global'], 'AD-OLD-KEY-0');
  assert.ok(outcome.lines.every(l => !l.includes(SENTINEL) && !l.includes(PUB) && !l.includes(SEC)), 'no error message or key reaches the logs');
  assert.ok(opens.length >= 1 && opens.every(o => o.flags === 'wx' && o.mode === 0o600), 'the plaintext evidence backup is opened exclusively with 0600 from the first open');
});

test('H1-05: the original corrupt bytes are provably kept BEFORE any recovery overwrites them; a failed or partial evidence copy refuses or repairs', async () => {
  const bad = '{"accounts":[{"id":"x"';
  const s = await setup({ config: bad, backup: markerConfig() }); seedKeys();
  const realOpen = fsp.open;
  fsp.open = async function (p, ...rest) { if (String(p).includes('.corrupt-')) throw Object.assign(new Error('injected'), { code: 'EACCES' }); return realOpen.call(this, p, ...rest); };
  let refused;
  try { refused = await quiet(() => s.store.loadConfig()); } finally { fsp.open = realOpen; }
  assert.equal(refused.error?.code, 'CONFIG_UNRECOVERABLE'); assert.match(refused.error.message, /evidence_not_preserved/);
  assert.equal(bytes(s.configPath).toString(), bad, 'the corrupt original is still in place (never overwritten without a proven copy)');
  const tag = (await import('node:crypto')).createHash('sha256').update(Buffer.from(bad)).digest('hex').slice(0, 12);
  fs.writeFileSync(s.configPath + '.corrupt-' + tag, '{"acc');                       // an interrupted earlier copy
  const ok = await quiet(() => s.store.loadConfig());
  assert.equal(ok.error, undefined);
  assert.equal(fs.readFileSync(s.configPath + '.corrupt-' + tag, 'utf8'), bad, 'the partial copy was replaced by the exact original bytes');
  assert.deepEqual(s.store.getConfig().accounts.map(a => a.id), [ID]);
});

// ── session index through the PUBLIC API ──────────────────────────────────────────────────────────────────────────────────────────
test('H1-06: an unavailable session index is an explicit typed outcome on list/start/add and a 503 on /api/chats; the JSONL append truth is reported; later valid writes work; a backup survives a missing index', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-idx3-'));
  const store = new ChatStore(dir);
  await store.startSession('a1', 's1', { agentId: 'catalyst' });
  await store.addMessage('a1', 's1', { role: 'assistant', content: 'one' });
  const indexFile = store._sessionIndexFile('a1'), jsonl = store._sessionFile('a1', 's1');
  assert.ok(fs.existsSync(indexFile + '.bak'));
  fs.renameSync(indexFile, indexFile + '.hold');                                      // absent primary index + valid backup
  assert.equal((await store.listSessions('a1')).length, 1, 'the backup is returned, not an empty first index');
  fs.renameSync(indexFile + '.hold', indexFile);
  fs.rmSync(indexFile + '.bak'); fs.writeFileSync(indexFile, '{"sessions":[');        // corrupt index, no backup
  const jsonlBefore = fs.readFileSync(jsonl);
  await assert.rejects(store.listSessions('a1'), e => isHistoryIndexUnavailable(e) && e instanceof HistoryIndexUnavailableError);
  await assert.rejects(store.startSession('a1', 's2', {}), isHistoryIndexUnavailable);
  const add = await store.addMessage('a1', 's1', { role: 'assistant', content: 'two' }).then(() => null, e => e);
  assert.ok(isHistoryIndexUnavailable(add) && add.appended === true, 'the message was appended; the index update failed; no retry is implied');
  assert.ok(fs.readFileSync(jsonl).subarray(0, jsonlBefore.length).equals(jsonlBefore) && fs.readFileSync(jsonl).length > jsonlBefore.length);
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"sessions":[', 'no misleading replacement index was published');
  const res = () => { const r = { code: 200, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
  const handler = createChatsListHandler({ chatStore: store, getActiveAccountId: () => 'a1' });
  const bad = res(); await handler({ query: {} }, bad);
  assert.equal(bad.code, 503); assert.equal(bad.body.error, 'history_index_unavailable');
  fs.rmSync(indexFile); fs.mkdirSync(indexFile);                                      // unreadable (EISDIR) is unavailable too
  await assert.rejects(store.listSessions('a1'), isHistoryIndexUnavailable);
  fs.rmdirSync(indexFile); fs.writeFileSync(indexFile, JSON.stringify({ sessions: [{ id: 's1', messageCount: 2, metadata: {} }] }));
  await store.addMessage('a1', 's1', { role: 'assistant', content: 'three' });        // a later valid write works (the queue is not wedged)
  const good = res(); await handler({ query: {} }, good);
  assert.equal(good.code, 200); assert.equal(good.body.sessions[0].messageCount, 3);
  const none = res(); await createChatsListHandler({ chatStore: store, getActiveAccountId: () => null })({ query: {} }, none);
  assert.deepEqual(none.body, { sessions: [] });
});

test('H1-06: the trading loop never fails a beat on an unavailable history index (typed error is logged); other errors are not swallowed', async () => {
  const { AgentHarness } = await import('../agent/harness.js');
  const typed = new HistoryIndexUnavailableError('corrupt', { appended: true });
  const make = error => ({ _persistSessionUnguarded: async () => { throw error; }, _persistMessagesUnguarded: async () => { throw error; } });
  const lines = [];
  const realError = console.error; console.error = (...a) => lines.push(a.join(' '));
  try {
    const self = make(typed);
    assert.equal(await AgentHarness.prototype._persistSession.call(self, 's', {}), undefined);
    assert.equal(await AgentHarness.prototype._persistMessages.call(self, 's', []), undefined);
    await assert.rejects(AgentHarness.prototype._persistSession.call(make(new Error('other')), 's', {}), /other/);
  } finally { console.error = realError; }
  assert.ok(lines.some(l => l.includes('[history] index_unavailable')));
});

// ── backup policy (N3) and owner/mode (N4) ────────────────────────────────────────────────────────────────────────────────────────
test('N3: when the backup cannot be written the save fails BEFORE the primary is replaced if no valid .bak exists, and continues with a warning when an older valid .bak exists', async () => {
  const failBackupRename = failing((p, a) => p === 'rename' && String(a[1]).endsWith('.bak'));
  const none = dirWith('c.json', '{"accounts":[]}');
  await assert.rejects(publishAtomic(none.file, '{"accounts":[1]}', { backup: true, requireFallback: true, fsx: failBackupRename }), e => e.code === 'BACKUP_REQUIRED');
  assert.equal(fs.readFileSync(none.file, 'utf8'), '{"accounts":[]}', 'the primary is untouched');
  assert.deepEqual(listing(none.dir).filter(n => n.endsWith('.tmp')), []);
  const older = dirWith('c.json', '{"accounts":[]}'); fs.writeFileSync(older.file + '.bak', '{"accounts":["older"]}');
  const r = await publishAtomic(older.file, '{"accounts":[1]}', { backup: true, requireFallback: true, fsx: failBackupRename });
  assert.equal(r.backup, 'failed');
  assert.equal(fs.readFileSync(older.file, 'utf8'), '{"accounts":[1]}');
  assert.equal(fs.readFileSync(older.file + '.bak', 'utf8'), '{"accounts":["older"]}', 'the older valid backup stays the fallback');
});

test('N4: a new inode that cannot reproduce the existing owner/group/mode fails BEFORE replacement; the mode survives a restrictive umask', async t => {
  if (process.platform === 'win32') { t.skip('POSIX ownership and umask semantics'); return; }
  const { file } = dirWith('c.json', '{"accounts":[]}');
  fs.chmodSync(file, 0o640);
  const realOpen = fs.promises.open;
  const mismatching = new Proxy(fs.promises, { get(target, prop) {
    if (prop !== 'open') { const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; }
    return async (...args) => {
      const handle = await realOpen.apply(target, args);
      if (!String(args[0]).endsWith('.tmp')) return handle;
      return new Proxy(handle, { get(h, p) { if (p === 'stat') return async () => { const st = await h.stat(); return { uid: st.uid + 1, gid: st.gid, mode: st.mode }; }; const v = h[p]; return typeof v === 'function' ? v.bind(h) : v; } });
    };
  } });
  await assert.rejects(publishAtomic(file, '{"accounts":[1]}', { fsx: mismatching }), e => e.code === 'OWNER_MISMATCH');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"accounts":[]}', 'the original is preserved');
  const oldUmask = process.umask(0o077);
  try { await publishAtomic(file, '{"accounts":[2]}'); } finally { process.umask(oldUmask); }
  assert.equal(fs.statSync(file).mode & 0o777, 0o640, 'the existing mode is reproduced exactly, not narrowed by the umask');
});


// ── Hermes final QA (R2-01 .. R2-04): real integration cases ─────────────────────────────────────────────────────────────────────────
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MSG = n => ({ role: 'assistant', kind: n === 3 ? 'tool_call' : 'message', content: 'record ' + n, tool: n === 3 ? 'place_options_order' : undefined });
const jsonlLines = file => fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('R2-01: with a broken session index the REAL _persistMessages appends EVERY message (user, assistant, tool event) once, in order, without failing the beat; a healthy index still counts', async () => {
  const { AgentHarness } = await import('../agent/harness.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-r2a-'));
  const chatStore = new ChatStore(dir);
  await chatStore.startSession('acc', 's1', {});
  const self = Object.assign(Object.create(AgentHarness.prototype), { chatStore, state: { activeAccountId: 'acc' } });
  await AgentHarness.prototype._persistMessages.call(self, 's1', [MSG(1)]);                          // healthy baseline
  const jsonl = chatStore._sessionFile('acc', 's1'), indexFile = chatStore._sessionIndexFile('acc');
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).sessions[0].messageCount, 1, 'healthy index control');
  const prefix = fs.readFileSync(jsonl);
  fs.rmSync(indexFile + '.bak', { force: true }); fs.writeFileSync(indexFile, '{"sessions":[');   // corrupt index, no usable backup
  const lines = []; const realError = console.error; console.error = (...a) => lines.push(a.join(' '));
  try { await AgentHarness.prototype._persistMessages.call(self, 's1', [MSG(2), MSG(3), MSG(4)], 'acc', { agentId: 'catalyst', agentName: 'Herald' }); } finally { console.error = realError; }
  const records = jsonlLines(jsonl);
  assert.deepEqual(records.map(r => r.content), ['record 1', 'record 2', 'record 3', 'record 4'], 'all three later records were appended once, in order');
  assert.ok(fs.readFileSync(jsonl).subarray(0, prefix.length).equals(prefix), 'the earlier JSONL prefix is untouched');
  assert.ok(records.slice(1).every(r => r.actorSnapshot?.agentName === 'Herald'), 'the actor snapshot is kept on every record');
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"sessions":[', 'no fabricated index success');
  assert.equal(lines.filter(l => l.includes('[history] index_unavailable:message')).length, 3, 'logged per message with the appended truth');
});

// Injects a failure on one index operation without touching the JSONL append.
async function withIndexFailure(match, code, run) {
  const realRename = fsp.rename, realOpen = fsp.open;
  fsp.rename = async function (a, b, ...r) { if (match === 'rename' && String(b).endsWith('sessions.json')) throw Object.assign(new Error('injected'), { code }); return realRename.call(this, a, b, ...r); };
  fsp.open = async function (p, ...r) { if (match === 'open' && /sessions\.json.*\.tmp$/.test(String(p))) throw Object.assign(new Error('injected'), { code }); return realOpen.call(this, p, ...r); };
  try { return await run(); } finally { fsp.rename = realRename; fsp.open = realOpen; }
}

test('R2-02: an index PUBLICATION failure after a successful append (EACCES, EIO, ENOSPC, owner mismatch) is typed with appended truth, never fails the beat, never duplicates, and the queue recovers; a real append failure stays a real error', async () => {
  const { AgentHarness } = await import('../agent/harness.js');
  for (const [where, code] of [['rename', 'EACCES'], ['rename', 'EIO'], ['open', 'ENOSPC'], ['open', 'OWNER_MISMATCH']]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-r2b-'));
    const store = new ChatStore(dir);
    await store.startSession('acc', 's1', {});
    const jsonl = store._sessionFile('acc', 's1');
    const typed = await withIndexFailure(where, code, () => store.addMessage('acc', 's1', MSG(1)).then(() => null, e => e));
    assert.ok(isHistoryIndexUnavailable(typed) && typed.appended === true && typed.reason.includes(code), `${where}/${code}: typed, appended=true, safe code`);
    assert.equal(jsonlLines(jsonl).length, 1, 'one durable append, no retry');
    const self = Object.assign(Object.create(AgentHarness.prototype), { chatStore: store, state: { activeAccountId: 'acc' } });
    await withIndexFailure(where, code, () => AgentHarness.prototype._persistMessages.call(self, 's1', [MSG(2), MSG(3)]));
    assert.deepEqual(jsonlLines(jsonl).map(r => r.content), ['record 1', 'record 2', 'record 3'], 'later messages are still appended after an index failure');
    await store.addMessage('acc', 's1', MSG(4));                                              // the queue is not wedged
    assert.equal(jsonlLines(jsonl).at(-1).content, 'record 4');
    assert.equal(JSON.parse(fs.readFileSync(store._sessionIndexFile('acc'), 'utf8')).sessions[0].messageCount, 1, 'the index is usable again after a healthy write; it counts only what it saw (the JSONL is the truth for the 3 earlier messages)');
  }
  // startSession's own index write
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-r2c-'));
  const store = new ChatStore(dir);
  const started = await withIndexFailure('rename', 'EACCES', () => store.startSession('acc', 's9', {}).then(() => null, e => e));
  assert.ok(isHistoryIndexUnavailable(started) && started.appended === false, 'a session-only index failure is typed with appended=false');
  // a genuine append failure is NOT converted to success
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-r2d-'));
  const store2 = new ChatStore(dir2);
  await store2.startSession('acc', 's1', {});
  fs.mkdirSync(store2._sessionFile('acc', 'sx'));                                                   // appending to a directory path fails (EISDIR)
  await assert.rejects(store2.addMessage('acc', 'sx', MSG(1)), e => !isHistoryIndexUnavailable(e) && e.code === 'EISDIR');
});

// ── R2-03 fallback validation with the real loader semantics ───────────────────────────────────────────────────────────────────────
async function failBackupRename(run) {
  const realRename = fsp.rename;
  fsp.rename = async function (a, b, ...r) { if (String(b).endsWith('.bak')) throw Object.assign(new Error('injected'), { code: 'EIO' }); return realRename.call(this, a, b, ...r); };
  try { return await run(); } finally { fsp.rename = realRename; }
}

test('R2-03: a failed backup write continues ONLY when the older .bak is a fully loadable recovery source; weak shapes (null account, malformed, normalisation failure, unresolved markers) fail BEFORE the primary is replaced; the accepted fallback really loads in a fresh module', async () => {
  const mutate = async s => { const cfg = JSON.parse(bytes(s.configPath).toString()); cfg.accounts[0].name = 'renamed ' + Math.random(); return cfg; };
  for (const [label, fallback] of [
    ['null account', JSON.stringify({ accounts: [null], sandboxes: {} })],
    ['malformed', '{"accounts":['],
    ['normalisation failure', JSON.stringify({ accounts: [null] })],
    ['unresolved markers', JSON.stringify({ ...markerConfig(), accounts: [{ ...markerConfig().accounts[0], id: 'zzzz9999' }] })],
  ]) {
    const s = await setup({ config: markerConfig() }); seedKeys();
    await quiet(() => s.store.loadConfig());
    fs.writeFileSync(s.configPath + '.bak', fallback);
    const primaryBefore = bytes(s.configPath), bakBefore = bytes(s.configPath + '.bak');
    s.store.getConfig().accounts[0].name = 'changed ' + label;
    const failure = await failBackupRename(() => s.store.saveConfig().then(() => null, e => e));
    assert.equal(failure?.code, 'BACKUP_REQUIRED', label);
    assert.ok(bytes(s.configPath).equals(primaryBefore), label + ': the primary is preserved');
    assert.ok(bytes(s.configPath + '.bak').equals(bakBefore), label + ': the backup is untouched');
  }
  // a fully valid older backup permits the documented warned continuation, and a fresh module can actually recover from it
  const s = await setup({ config: markerConfig() }); seedKeys();
  await quiet(() => s.store.loadConfig());
  const olderValid = bytes(s.configPath);                                                           // a real, loadable previous disk form
  fs.writeFileSync(s.configPath + '.bak', olderValid);
  s.store.getConfig().accounts[0].name = 'changed after a failed backup write';
  const ok = await failBackupRename(() => s.store.saveConfig().then(() => 'saved', e => e));
  assert.equal(ok, 'saved');
  assert.match(bytes(s.configPath).toString(), /changed after a failed backup write/);
  assert.ok(bytes(s.configPath + '.bak').equals(olderValid), 'the older valid backup stays the fallback');
  fs.writeFileSync(s.configPath, '{corrupt');                                                       // later corruption: recovery from that fallback must really work
  const fresh = await reopen(s);
  assert.equal((await quiet(() => fresh.loadConfig())).error, undefined);
  assert.deepEqual(fresh.getConfig().accounts.map(a => a.id), [ID]);
  assert.equal(calls.length, 0, 'validating a fallback never imports a broker or rewrites a file');
});

// ── R2-04 preflight == loader ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const CLI = fileURLToPath(new URL('../scripts/config-preflight.mjs', import.meta.url));
const runCli = (configPath, extra = []) => spawnSync(process.execPath, [CLI, ...extra], { env: { ...process.env, OPENPROPHET_CONFIG_PATH: configPath, OPENPROPHET_SECRETS_PATH: path.join(path.dirname(configPath), 'secrets.json') }, encoding: 'utf8' });

test('R2-04: the preflight accepts and refuses exactly what the real loader does (healthy split, legacy plaintext, null account, normalisation failure, unresolved markers, bad backup, absent private store)', async () => {
  const { inspectConfigState } = await import('../agent/config-preflight.js');
  const cases = [
    ['healthy split', { config: markerConfig() }, true, 'load_primary'],
    ['legacy plaintext', { config: plaintextConfig() }, false, 'load_primary'],
    ['null account', { config: JSON.stringify({ accounts: [null], sandboxes: {} }) }, false, 'refuse'],
    ['normalisation failure', { config: JSON.stringify({ accounts: [null] }) }, false, 'refuse'],
    ['unresolved markers', { config: markerConfig() }, false, 'refuse_keys_missing'],
    ['corrupt primary + null-account backup', { config: '{', backup: JSON.stringify({ accounts: [null], sandboxes: {} }) }, false, 'refuse'],
    ['corrupt primary + good backup', { config: '{', backup: markerConfig() }, true, 'recover_from_backup_after_evidence_copy'],
    ['absent primary + good backup', { backup: markerConfig() }, true, 'recover_from_backup'],
    ['absent + absent', {}, false, 'first_run_bootstrap'],
  ];
  for (const [label, seed, keys, expected] of cases) {
    const s = await setup({ ...seed });
    if (keys) seedKeys();
    if (label === 'absent + absent') { delete process.env.ALPACA_PUBLIC_KEY; delete process.env.ALPACA_SECRET_KEY; }
    const report = await inspectConfigState({ configPath: s.configPath, secretsPath: s.filePath });
    assert.equal(report.nextStart, expected, label);
    // the real loader agrees on whether active startup would proceed
    const loaded = await quiet(() => s.store.loadConfig());
    const loaderProceeds = !loaded.error;
    const predictsProceed = !report.nextStart.startsWith('refuse');
    assert.equal(predictsProceed, loaderProceeds, `${label}: the preflight and the loader agree`);
  }
  assert.equal(calls.length, 0);
});

test('R2-04: an absent private store is reported as absent (not "readable"); a marker-free legacy plaintext config still loads without one', async () => {
  const { inspectConfigState } = await import('../agent/config-preflight.js');
  const s = await setup({ config: plaintextConfig() });
  const report = await inspectConfigState({ configPath: s.configPath, secretsPath: s.filePath });
  assert.equal(report.privateStore, 'absent');
  assert.equal(report.nextStart, 'load_primary');
  const withStore = await setup({ config: markerConfig() }); seedKeys();
  assert.equal((await inspectConfigState({ configPath: withStore.configPath, secretsPath: withStore.filePath })).privateStore, 'readable');
});

test('R2-04: the CLI exit-status contract (0 load, 2 operator decision, 1 refuse or failed write check) and its output never carries keys, paths, ids or fragments', async () => {
  const load = await setup({ config: markerConfig() }); seedKeys();
  const r0 = runCli(load.configPath, ['--check-write']);
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const bootstrap = await setup({});
  assert.equal(runCli(bootstrap.configPath).status, 2);
  const recover = await setup({ config: '{', backup: markerConfig() }); seedKeys();
  assert.equal(runCli(recover.configPath).status, 2);
  const refuse = await setup({ config: JSON.stringify({ accounts: [null], sandboxes: {} }) });
  assert.equal(runCli(refuse.configPath).status, 1);
  const unresolved = await setup({ config: markerConfig() });
  const r1 = runCli(unresolved.configPath);
  assert.equal(r1.status, 1);
  for (const result of [r0, r1, runCli(recover.configPath)]) {
    const text = result.stdout + result.stderr;
    for (const secret of [PUB, SEC, ID, load.dir, recover.dir, 'account:', '{"accounts"']) assert.ok(!text.includes(secret), secret);
  }
  assert.ok(!fs.existsSync(path.join(refuse.dir, 'agent-config.json.bak')), 'the CLI writes nothing');
});
