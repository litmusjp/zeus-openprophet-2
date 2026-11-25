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
const { ChatStore } = await import('../agent/chat-store.js');

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
test('session index: ENOENT is a first index; a corrupt index with a good backup recovers; without one it is unavailable, never replaced by an empty one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-idx-'));
  const store = new ChatStore(dir);
  await store.startSession('acc1', 's1', { agentId: 'catalyst', agentName: 'Herald' });
  await store.addMessage('acc1', 's1', { role: 'assistant', content: 'one' });
  await store.addMessage('acc1', 's1', { role: 'assistant', content: 'two' });                // second save creates the .bak of the first
  const indexFile = store._sessionIndexFile('acc1');
  assert.ok(isJsonObjectBytes(fs.readFileSync(indexFile + '.bak')));
  const good = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  assert.equal(good.sessions[0].messageCount, 2);
  assert.equal(good.sessions[0].metadata.agentName, 'Herald');
  // corrupt the index: recovered from the backup, evidence kept, JSONL untouched
  const jsonl = store._sessionFile('acc1', 's1'); const jsonlBefore = fs.readFileSync(jsonl);
  fs.writeFileSync(indexFile, '{"sessions":[');
  const recovered = await store._loadSessionIndex('acc1');
  assert.equal(recovered.sessions.length, 1);
  assert.equal(recovered.sessions[0].metadata.agentName, 'Herald');
  assert.equal(fs.readdirSync(path.dirname(indexFile)).filter(n => n.includes('.corrupt-')).length, 1);
  // no backup either: unavailable, and a save is refused so the file stays as it is
  fs.rmSync(indexFile + '.bak');
  fs.writeFileSync(indexFile, '{"sessions":[');
  const lost = await quiet(() => store._loadSessionIndex('acc1'));
  assert.equal(lost.value.unavailable, true);
  assert.deepEqual(lost.value.sessions, []);
  await store.addMessage('acc1', 's1', { role: 'assistant', content: 'three' });             // the message is still appended; the index is not overwritten
  await quiet(() => store.startSession('acc1', 's2', { agentId: 'catalyst' }));            // a save is attempted for the new session: refused, file intact
  assert.equal(fs.readFileSync(indexFile, 'utf8'), '{"sessions":[');
  assert.ok(fs.readFileSync(jsonl).length > jsonlBefore.length, 'the message file is untouched apart from the new line');
  assert.ok(fs.readFileSync(jsonl).subarray(0, jsonlBefore.length).equals(jsonlBefore));
});

test('session index: an unreadable index (access error) is unavailable not empty, and concurrent appends keep their counts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-idx2-'));
  const store = new ChatStore(dir);
  await store.startSession('acc2', 's1', {});
  await Promise.all(Array.from({ length: 12 }, (_, i) => store.addMessage('acc2', 's1', { role: 'assistant', content: 'm' + i })));
  const index = JSON.parse(fs.readFileSync(store._sessionIndexFile('acc2'), 'utf8'));
  assert.equal(index.sessions[0].messageCount, 12);
  const indexFile = store._sessionIndexFile('acc2');
  fs.renameSync(indexFile, indexFile + '.moved'); fs.mkdirSync(indexFile);                  // EISDIR on read
  const unreadable = await quiet(() => store._loadSessionIndex('acc2'));
  assert.equal(unreadable.value.unavailable, true);
  fs.rmdirSync(indexFile); fs.renameSync(indexFile + '.moved', indexFile);                  // later writes work again
  await store.addMessage('acc2', 's1', { role: 'assistant', content: 'after' });
  assert.equal(JSON.parse(fs.readFileSync(indexFile, 'utf8')).sessions[0].messageCount, 13);
});
