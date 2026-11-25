import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';

// Nov 25 H7 FINAL REPAIR (Hermes brief at reviewed baseline 28af884): the eleven frozen regression cases, each with a healthy control.
// Set H7_BASELINE_MODULE=../agent/daily-backup.baseline.tmp.js to run the SAME assertions against the old module (proves they distinguish the old behaviour).
// Fixtures are synthetic and live inside the OS temp folder; no live data, key or retention is touched.
const modulePath = process.env.H7_BASELINE_MODULE || '../agent/daily-backup.js';
const { runBackup, createDailyBackup, backupStatusPayload } = await import(modulePath);
const { inspectConfigState } = await import('../agent/config-preflight.js');
const { referenceStatusAgainst, structureStatusOf } = await import('../agent/config-secrets.js');

const T1 = Date.parse('2026-11-25T23:00:00Z');     // 18:00 ET Nov 25
const T2 = Date.parse('2026-11-26T23:00:00Z');
const T3 = Date.parse('2026-11-27T23:00:00Z');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const BIG = async () => ({ bavail: 1e9, bsize: 4096 });
const FAST = { statfs: BIG, reserveBytes: 0, marginBytes: 0, pairRetryDelayMs: 0 };
const run = (root, now, extra = {}) => runBackup({ root, now, ...FAST, ...extra });
const daily = root => path.join(root, 'recovery-backups/daily');
const dated = root => (fs.existsSync(daily(root)) ? fs.readdirSync(daily(root)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort() : []);
const heldDirs = root => { const h = path.join(daily(root), '.incomplete'); return fs.existsSync(h) ? fs.readdirSync(h).sort().map(n => path.join(h, n)) : []; };
const wrapFs = overrides => new Proxy(fsp, { get(target, prop) { if (overrides[prop]) return (...args) => overrides[prop](target[prop].bind(target), ...args); const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; } });
const eio = () => Object.assign(new Error('x'), { code: 'EIO' });
const tree = dir => { const out = {}; const walk = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name), r = rel ? rel + '/' + e.name : e.name; if (e.isDirectory()) { out[r + '/'] = ''; walk(p, r); } else out[r] = sha(fs.readFileSync(p)); } }; walk(dir, ''); return out; };
const executed = { containment: 0 };

function makeRoot({ withMarkers = false, config = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-h7r-'));
  const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const cfg = config ?? (withMarkers ? JSON.stringify({ accounts: [{ id: 'acc1', secretRef: 'account:acc1' }], sandboxes: {} }) : JSON.stringify({ accounts: [], sandboxes: {} }));
  w('agent-config.json', cfg); w('agent-config.json.bak', cfg);
  w('secrets.json', JSON.stringify({ accounts: withMarkers ? { acc1: { publicKey: 'PK-synthetic', secretKey: 'SK-synthetic' } } : {}, alphadesk: {} })); w('secrets.json.bak', '{}'); w('trading-guidance.json', '{"x":1}');
  w('iv-history/2026-11.jsonl', '{"symbol":"SPY","meanIv":0.2254}\n');
  for (const sb of ['sbx_a', 'sbx_b']) {
    w(`sandboxes/${sb}/order-attribution.jsonl`, `{"v":1,"orderIds":["o-${sb}"],"agentId":"catalyst"}\n`);
    w(`sandboxes/${sb}/daily-loss-lock.json`, '{}'); w(`sandboxes/${sb}/chat-history/sessions.json`, '{"sessions":[]}');
    w(`sandboxes/${sb}/chat-history/session-s1.jsonl`, `{"tool":"place_options_order","result":"PASS signal_score 48.27 ${sb}"}\n`);
    w(`sandboxes/${sb}/activity_logs/a.json`, '{}'); w(`sandboxes/${sb}/decisive_actions/d1.json`, '{"x":1}');
    const db = new Database(path.join(root, `sandboxes/${sb}/prophet_trader.db`)); db.exec("CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'stored trade')"); db.close();
  }
  return root;
}

/** Every file the manifest lists is really there with the listed length (and hash); the counts equal what is retained; nothing unlisted claims to be a record. */
function assertSnapshotConsistent(dir, label = '') {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
  for (const f of manifest.files) {
    const p = path.join(dir, f.rel);
    assert.ok(fs.existsSync(p), `${label} manifest lists ${f.rel} but it is missing`);
    assert.equal(fs.statSync(p).size, f.bytes, `${label} ${f.rel} length`);
    if (f.kind === 'file') assert.equal(sha(fs.readFileSync(p)), f.sha256, `${label} ${f.rel} hash`);
  }
  assert.equal(manifest.counts.files, manifest.files.length, label + ' counts.files');
  assert.equal(manifest.counts.bytes, manifest.files.reduce((n, f) => n + f.bytes, 0), label + ' counts.bytes');
  return manifest;
}

// ── 1. structural acceptance ─────────────────────────────────────────────────────────────────────────────────────────────────────
test('H7R-1 (A): a null, array or primitive config and a null or non-object account are INCOMPLETE and never evict a good point; legitimate legacy omissions stay complete', async () => {
  const bad = ['null', '[]', '"text"', '5', '{"accounts":[null],"sandboxes":{}}', '{"accounts":{}}', '{"accounts":[{"id":"a"},7]}', '{"accounts":[],"sandboxes":{"s":5}}'];
  for (const text of bad) {
    const root = makeRoot();
    assert.equal((await run(root, T1, { keep: 1 })).status, 'ok');
    fs.writeFileSync(path.join(root, 'agent-config.json'), text);
    const r = await run(root, T2, { keep: 1 });
    assert.equal(r.status, 'incomplete', text); assert.equal(r.complete, false, text); assert.ok(r.errors >= 1, text);
    assert.deepEqual(dated(root), ['2026-11-25'], text + ': no complete point was published and the good one was not evicted');
    for (const dir of heldDirs(root)) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')).complete, false);
  }
  // healthy controls: legacy omissions and a legacy plaintext layout are accepted exactly as the loader accepts them
  const good = ['{}', '{"accounts":[]}', '{"sandboxes":{}}', '{"accounts":[{"id":"a","publicKey":"pk","secretKey":"sk"}],"sandboxes":{"sbx_a":null}}', '{"accounts":null}'];
  for (const text of good) {
    const root = makeRoot({ config: text });
    const r = await run(root, T1);
    assert.equal(r.status, 'ok', text); assert.equal(r.errors, 0, text);
    assertSnapshotConsistent(path.join(daily(root), '2026-11-25'), text);
  }
  // loader-equal agreement: what the pure check accepts the real loader preflight loads; what it rejects the loader does not load
  for (const [text, accepted] of [['{}', true], ['{"accounts":[]}', true], ['{"accounts":[{"id":"a","publicKey":"pk","secretKey":"sk"}]}', true], ['null', false], ['[]', false], ['{"accounts":[null]}', false], ['{"accounts":{}}', false]]) {
    assert.equal(structureStatusOf(JSON.parse(text), null).ok, accepted, 'pure: ' + text);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-h7r-agree-'));
    fs.writeFileSync(path.join(dir, 'agent-config.json'), text);
    const report = await inspectConfigState({ configPath: path.join(dir, 'agent-config.json'), secretsPath: path.join(dir, 'secrets.json') });
    assert.equal(report.nextStart === 'load_primary', accepted, 'loader: ' + text + ' -> ' + report.nextStart);
  }
});

// ── 2. failed second recapture ────────────────────────────────────────────────────────────────────────────────────────────────────
test('H7R-2 (A): when the SECOND capture of the config fails, no manifest lists a missing file, the live source is unchanged and the failure is explicit; a healthy retry still succeeds', async () => {
  const root = makeRoot({ withMarkers: true });
  const configFile = path.join(root, 'agent-config.json'), secretsFile = path.join(root, 'secrets.json');
  const good = fs.readFileSync(secretsFile, 'utf8');
  fs.writeFileSync(secretsFile, JSON.stringify({ accounts: {}, alphadesk: {} }));          // the first attempt cannot resolve the markers
  const before = sha(fs.readFileSync(configFile));
  let opens = 0;
  const failing = wrapFs({ open: async (real, p, ...rest) => { if (String(p) === configFile && ++opens === 2) throw eio(); return real(p, ...rest); } });
  const r = await run(root, T1, { fsx: failing, pairRetries: 2 });
  assert.equal(r.status, 'incomplete'); assert.equal(r.complete, false); assert.ok(r.errors >= 1); assert.deepEqual(dated(root), []);
  const held = heldDirs(root); assert.equal(held.length, 1);
  const manifest = assertSnapshotConsistent(held[0], 'held');
  assert.ok(!manifest.files.some(f => f.rel === 'agent-config.json'), 'no manifest entry for a config that is not in the copy');
  assert.equal(sha(fs.readFileSync(configFile)), before, 'the live source is unchanged');
  // healthy control: the private store is fixed between attempts and every capture works
  const ok = makeRoot({ withMarkers: true });
  const okSecrets = path.join(ok, 'secrets.json');
  const okGood = fs.readFileSync(okSecrets, 'utf8');
  fs.writeFileSync(okSecrets, JSON.stringify({ accounts: {}, alphadesk: {} }));
  let n = 0;
  const racing = wrapFs({ open: async (real, p, ...rest) => { if (String(p) === okSecrets && ++n === 2) fs.writeFileSync(okSecrets, okGood); return real(p, ...rest); } });
  const r2 = await run(ok, T1, { fsx: racing, pairRetries: 2 });
  assert.equal(r2.status, 'ok'); assertSnapshotConsistent(path.join(daily(ok), '2026-11-25'), 'ok');
  assert.equal(good.length > 0, true);
});

// ── 3. restoration of valid pairs, pure validation ────────────────────────────────────────────────────────────────────────────────
test('H7R-3 (A): valid legacy and split pairs restore through the loader-equal acceptance from the COPIES; the pure validators leave globals and the environment untouched', async () => {
  const fixtures = {
    legacy: makeRoot({ config: JSON.stringify({ accounts: [{ id: 'a', publicKey: 'pk-synthetic', secretKey: 'sk-synthetic' }], sandboxes: {} }) }),
    split: makeRoot({ withMarkers: true }),
    markerFree: makeRoot(),
  };
  for (const [label, root] of Object.entries(fixtures)) {
    const r = await run(root, T1);
    assert.equal(r.status, 'ok', label);
    const snap = path.join(daily(root), '2026-11-25');
    assertSnapshotConsistent(snap, label);
    const restore = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-h7r-restore-'));
    for (const f of ['agent-config.json', 'secrets.json']) if (fs.existsSync(path.join(snap, f))) fs.copyFileSync(path.join(snap, f), path.join(restore, f));
    const report = await inspectConfigState({ configPath: path.join(restore, 'agent-config.json'), secretsPath: path.join(restore, 'secrets.json') });
    assert.equal(report.nextStart, 'load_primary', label + ' restores through the loader-equal acceptance');
  }
  const envDigest = () => sha(JSON.stringify(Object.entries(process.env).sort()));
  const envBefore = envDigest();
  const cfg = { accounts: [{ id: 'a', secretRef: 'account:a' }] };
  assert.equal(referenceStatusAgainst(cfg, { accounts: {} }).ok, false);
  assert.equal(structureStatusOf(cfg, { accounts: {} }).ok, true);
  assert.equal(structureStatusOf(cfg, [1]).ok, false, 'a private store that is not an object is rejected');
  assert.equal(envDigest(), envBefore, 'the pure validation did not touch the environment');
});

// ── 4. short destination writes ───────────────────────────────────────────────────────────────────────────────────────────────────
test('H7R-4 (A): a partial destination write is completed (exact bytes, once); a write that makes no progress makes the snapshot incomplete', async () => {
  const root = makeRoot();
  const target = path.join(root, 'sandboxes/sbx_a/order-attribution.jsonl');
  fs.writeFileSync(target, '{"orderIds":["o1"],"agentName":"Herald"}\n'.repeat(500));
  const withWrites = writer => wrapFs({ open: async (real, p, ...rest) => {
    const handle = await real(p, ...rest);
    if (!String(p).includes('order-attribution.jsonl') || String(p) === target) return handle;           // only the DESTINATION copy of the first file
    return new Proxy(handle, { get(h, prop) { if (prop === 'write') return (...a) => writer(h, ...a); const v = h[prop]; return typeof v === 'function' ? v.bind(h) : v; } });
  } });
  let first = true;
  const half = withWrites((h, buf, off, len, pos) => { if (first) { first = false; return h.write(buf, off, Math.ceil(len / 2), pos); } return h.write(buf, off, len, pos); });
  const r = await run(root, T1, { fsx: half });
  assert.equal(r.status, 'ok');
  const copy = fs.readFileSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/order-attribution.jsonl'));
  assert.equal(sha(copy), sha(fs.readFileSync(target)), 'the retained prefix is exactly the source (no gap, no duplicate)');
  assertSnapshotConsistent(path.join(daily(root), '2026-11-25'), 'short');
  const stuck = makeRoot();
  fs.writeFileSync(path.join(stuck, 'sandboxes/sbx_a/order-attribution.jsonl'), '{"a":1}\n'.repeat(100));
  const none = wrapFs({ open: async (real, p, ...rest) => {
    const handle = await real(p, ...rest);
    if (!String(p).includes('order-attribution.jsonl') || !String(p).includes('.tmp-')) return handle;
    return new Proxy(handle, { get(h, prop) { if (prop === 'write') return async () => ({ bytesWritten: 0 }); const v = h[prop]; return typeof v === 'function' ? v.bind(h) : v; } });
  } });
  const r2 = await run(stuck, T1, { fsx: none });
  assert.equal(r2.status, 'incomplete'); assert.ok(r2.errors >= 1); assert.deepEqual(dated(stuck), []);
});

// ── 5. incomplete holding folder ──────────────────────────────────────────────────────────────────────────────────────────────────
test('H7R-5 (B): a junction as the incomplete-holding folder is never written through or pruned; foreign holding entries are never counted or removed; owned ones are pruned', async () => {
  const flaky = { sqliteBackup: async () => { throw eio(); } };
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-h7r-outside-'));
  for (const n of ['0000-a.txt', '1111-b.txt', '2222-c.txt']) fs.writeFileSync(path.join(outside, n), 'outside ' + n);
  fs.mkdirSync(path.join(outside, '3333-dir')); fs.writeFileSync(path.join(outside, '3333-dir/x.txt'), 'x');
  const outsideBefore = tree(outside);
  const redirected = makeRoot();
  fs.mkdirSync(daily(redirected), { recursive: true });
  fs.symlinkSync(outside, path.join(daily(redirected), '.incomplete'), 'junction');
  const r = await run(redirected, T1, { ...flaky, keepIncomplete: 1 });
  executed.containment += 1;
  assert.notEqual(r.status, 'ok'); assert.equal(r.complete, false);
  assert.deepEqual(tree(outside), outsideBefore, 'nothing was written, moved or deleted outside through the holding junction');
  assert.deepEqual(fs.readdirSync(daily(redirected)).filter(n => n.startsWith('.tmp-')), [], 'staging is cleaned up');
  // foreign entries inside a REAL holding folder, with owned incompletes pruned around them
  const root = makeRoot();
  const hold = path.join(daily(root), '.incomplete');
  fs.mkdirSync(hold, { recursive: true });
  fs.mkdirSync(path.join(hold, '0000-foreign-dir')); fs.writeFileSync(path.join(hold, '0000-foreign-dir/keep.txt'), 'foreign');
  fs.writeFileSync(path.join(hold, '0001-notes.txt'), 'foreign file');
  const lookalike = path.join(hold, '2026-11-20-1-abcd'); fs.mkdirSync(lookalike);
  fs.writeFileSync(path.join(lookalike, 'MANIFEST.json'), JSON.stringify({ owner: 'someone-else', version: 2, complete: false, date: '2026-11-20', files: [] }));
  const foreignBefore = tree(hold);
  for (let i = 0; i < 4; i += 1) assert.equal((await run(root, T1 + i * 1000, { ...flaky, keepIncomplete: 2 })).status, 'incomplete');
  executed.containment += 1;
  const after = tree(hold);
  for (const [k, v] of Object.entries(foreignBefore)) assert.equal(after[k], v, 'foreign entry untouched: ' + k);
  const ownedNow = fs.readdirSync(hold).filter(n => /^\d{4}-\d{2}-\d{2}-\d+-[0-9a-f]{4}$/.test(n) && n !== '2026-11-20-1-abcd');
  assert.equal(ownedNow.length, 2, 'only this module\'s own incomplete folders are pruned, newest two kept');
});

// ── 6. scheduler state through the REAL scheduler ────────────────────────────────────────────────────────────────────────────────
test('H7R-6a (B): a STATE.json that is a hard link to the live config is not trusted and not written through; the config is unchanged and nothing throws', async () => {
  const root = makeRoot();
  fs.mkdirSync(daily(root), { recursive: true });
  const configFile = path.join(root, 'agent-config.json');
  const before = fs.readFileSync(configFile);
  fs.linkSync(configFile, path.join(daily(root), 'STATE.json'));
  let sched;
  assert.doesNotThrow(() => { sched = createDailyBackup({ root, now: () => T1, runOptions: { ...FAST } }); });
  executed.containment += 1;
  assert.equal(sched.status().status, 'state_unavailable', 'a hard-linked state file is not trusted');
  const result = await sched.tick();
  assert.equal(result.status, 'ok');
  assert.deepEqual(fs.readFileSync(configFile), before, 'the live config bytes are unchanged (the state was not written through the hard link)');
  const state = JSON.parse(fs.readFileSync(path.join(daily(root), 'STATE.json'), 'utf8'));
  assert.equal(state.status, 'ok'); assert.ok(!('accounts' in state));
  assert.equal(createDailyBackup({ root, now: () => T1, runOptions: { ...FAST } }).status().complete, true, 'the replaced state is a normal file and is read back');
});

test('H7R-6b (B): a STATE.json symlink is not followed (POSIX): the target is unchanged and the name is replaced atomically', async t => {
  const root = makeRoot();
  fs.mkdirSync(daily(root), { recursive: true });
  const configFile = path.join(root, 'agent-config.json');
  const before = fs.readFileSync(configFile);
  try { fs.symlinkSync(configFile, path.join(daily(root), 'STATE.json')); } catch { t.skip('file symlinks are not permitted here (runs on Linux CI)'); return; }
  const sched = createDailyBackup({ root, now: () => T1, runOptions: { ...FAST } });
  executed.containment += 1;
  assert.equal(sched.status().status, 'state_unavailable');
  assert.equal((await sched.tick()).status, 'ok');
  assert.deepEqual(fs.readFileSync(configFile), before, 'the symlink target is unchanged');
  assert.ok(!fs.lstatSync(path.join(daily(root), 'STATE.json')).isSymbolicLink(), 'the link name was replaced by a normal file');
});

test('H7R-6c (B): a redirected daily parent (junction) is never read for state or written; the run fails safely; no startup throw', async () => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-h7r-outside-'));
  fs.writeFileSync(path.join(outside, 'STATE.json'), JSON.stringify({ status: 'ok', date: '2026-11-25', complete: true, attempts: 1 }));
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  const before = tree(outside);
  fs.mkdirSync(path.join(root, 'recovery-backups'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, 'recovery-backups/daily'), 'junction');
  let sched;
  assert.doesNotThrow(() => { sched = createDailyBackup({ root, now: () => T1, runOptions: { ...FAST } }); });
  executed.containment += 1;
  assert.equal(sched.status().status, 'state_unavailable', 'the outside STATE.json is not trusted');
  const result = await sched.tick();
  assert.notEqual(result.status, 'done_today'); assert.notEqual(result.status, 'ok');
  assert.deepEqual(tree(outside), before, 'nothing outside was written, created or deleted');
});

test('H7R-6d (B): an interrupted state rename keeps the old usable state and leaves no temp file; damaged, wrong-typed or oversized state never crashes and is reduced to known labels', async () => {
  const root = makeRoot();
  const first = createDailyBackup({ root, now: () => T1, runOptions: { ...FAST } });
  assert.equal((await first.tick()).status, 'ok');
  const stateFile = path.join(daily(root), 'STATE.json');
  const old = fs.readFileSync(stateFile, 'utf8');
  const failing = wrapFs({ rename: async (real, from, to, ...rest) => { if (String(to).endsWith('STATE.json')) throw eio(); return real(from, to, ...rest); } });
  const second = createDailyBackup({ root, now: () => T2, fsx: failing, runOptions: { ...FAST } });
  assert.equal((await second.tick()).status, 'ok', 'the run itself is unaffected');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), old, 'the old state is still the usable state on disk');
  assert.deepEqual(fs.readdirSync(daily(root)).filter(n => n.includes('.state-')), [], 'no temp state file is left behind');
  assert.equal(createDailyBackup({ root, now: () => T2, runOptions: { ...FAST } }).status().date, '2026-11-25', 'a restart reads the intact old state');
  // damaged and hostile contents
  for (const text of ['{broken', '[]', 'null', '"x"', JSON.stringify({ status: { x: 1 }, attempts: 'lots', date: '../../x', complete: 'yes', errors: -4, bytes: 1e999 })]) {
    fs.writeFileSync(stateFile, text);
    let s;
    assert.doesNotThrow(() => { s = createDailyBackup({ root, now: () => T2, runOptions: { ...FAST } }); }, text);
    const payload = backupStatusPayload(s, true);
    assert.ok(['not_run_yet', 'state_unavailable'].includes(payload.status), text + ' -> ' + payload.status);
    for (const k of ['attempts', 'errors', 'bytes']) assert.ok(payload[k] === null || (Number.isFinite(payload[k]) && payload[k] >= 0), k);
    assert.ok(payload.date === null || /^\d{4}-\d{2}-\d{2}$/.test(payload.date));
  }
  fs.writeFileSync(stateFile, ' '.repeat(100 * 1024));
  assert.equal(createDailyBackup({ root, now: () => T2, runOptions: { ...FAST } }).status().status, 'state_unavailable', 'an oversized state file is not read');
});

// ── 7. same-day restart, backoff, cap, deleted or rejected dated point ──────────────────────────────────────────────────────────
test('H7R-7 (B): same-day status is accurate: a deleted dated point is not "done today", a rejected (foreign) one is blocked without evicting a good point, and the attempt cap survives a restart', async () => {
  const root = makeRoot();
  assert.equal((await run(root, T1, { keep: 1 })).status, 'ok');             // a good earlier point
  const sched = createDailyBackup({ root, now: () => T2, runOptions: { ...FAST, keep: 2 }, retryAfterMs: 0 });
  assert.equal((await sched.tick()).status, 'ok');
  assert.equal((await sched.tick()).status, 'done_today');
  fs.rmSync(path.join(daily(root), '2026-11-26'), { recursive: true });       // the dated point disappears behind the scheduler's back
  const again = await sched.tick();
  assert.equal(again.status, 'ok', 'the cache said done, the proof is gone: it runs again');
  assert.deepEqual(dated(root), ['2026-11-25', '2026-11-26']);
  // a rejected dated point: the folder is replaced by a foreign one
  fs.rmSync(path.join(daily(root), '2026-11-26'), { recursive: true });
  fs.mkdirSync(path.join(daily(root), '2026-11-26')); fs.writeFileSync(path.join(daily(root), '2026-11-26/x.txt'), 'foreign');
  const blocked = await sched.tick();
  assert.equal(blocked.status, 'blocked_foreign_folder'); assert.equal(sched.status().complete, false);
  assert.equal(fs.readFileSync(path.join(daily(root), '2026-11-26/x.txt'), 'utf8'), 'foreign');
  assert.ok(dated(root).includes('2026-11-25'), 'the good point was not evicted');
  // the attempt cap is persisted across a restart
  const capped = makeRoot();
  const flaky = { sqliteBackup: async () => { throw eio(); } };
  const s1 = createDailyBackup({ root: capped, now: () => T3, runOptions: { ...FAST, ...flaky }, retryAfterMs: 0, maxAttemptsPerDate: 2 });
  assert.equal((await s1.tick()).status, 'incomplete'); assert.equal((await s1.tick()).status, 'incomplete');
  const s2 = createDailyBackup({ root: capped, now: () => T3, runOptions: { ...FAST, ...flaky }, retryAfterMs: 0, maxAttemptsPerDate: 2 });
  assert.equal((await s2.tick()).status, 'gave_up_today', 'a restart does not reset the cap');
});

// ── 8. WAL-aware SQLite bounds ────────────────────────────────────────────────────────────────────────────────────────────────────
function walFixture() {
  const root = makeRoot();
  const dbFile = path.join(root, 'sandboxes/sbx_a/prophet_trader.db');
  const writer = new Database(dbFile); writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
  writer.exec('BEGIN'); const ins = writer.prepare('INSERT INTO t VALUES (?, ?)'); for (let i = 2; i < 2200; i += 1) ins.run(i, 'x'.repeat(900)); writer.exec('COMMIT');
  assert.ok(fs.statSync(dbFile + '-wal').size > 1_000_000, 'fixture: the WAL is large'); assert.ok(fs.statSync(dbFile).size < 20_000, 'fixture: the main file stays small');
  return { root, writer, dbFile };
}
test('H7R-8 (C): a small main file with a large WAL is bounded by main PLUS WAL: safe skip under small modeled capacity, file cap and run cap; an ordinary positive WAL snapshot still restores', async () => {
  const { root, writer } = walFixture();
  try {
    const small = await run(root, T1, { statfs: async () => ({ bavail: 64, bsize: 4096 }) });          // 256 KiB modeled
    assert.equal(small.status, 'skipped_low_space'); assert.deepEqual(dated(root), []);
    assert.equal((await run(root, T1, { maxFileBytes: 65536 })).status, 'incomplete', 'the file cap applies to the native copy');
    assert.equal((await run(root, T1, { maxRunBytes: 1024 * 1024 })).status, 'skipped_run_too_large');
    assert.deepEqual(dated(root), []); assert.deepEqual(fs.readdirSync(daily(root)).filter(n => n.startsWith('.tmp-')), []);
    const positive = await run(root, T1);                                                                // healthy control
    assert.equal(positive.status, 'ok');
    const copy = new Database(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/prophet_trader.db'), { readonly: true });
    try { assert.equal(copy.prepare('SELECT count(*) n FROM t').get().n, 2199); assert.equal(copy.pragma('quick_check', { simple: true }), 'ok'); } finally { copy.close(); }
    assertSnapshotConsistent(path.join(daily(root), '2026-11-25'), 'wal');
  } finally { writer.close(); }
});

test('H7R-8b (C): the native copy checks its allowance while it runs (a copy that outgrows it stops and leaves no file) and the real native progress callback enforces the deadline', async () => {
  const root = makeRoot();
  const grows = { sqliteBackup: async (src, dest, { guard, allowance }) => { fs.writeFileSync(dest, Buffer.alloc(allowance + 1)); guard({}); } };
  const r = await run(root, T1, { ...grows, maxFileBytes: 1024 * 1024 });
  assert.equal(r.status, 'incomplete'); assert.deepEqual(dated(root), []);
  assert.ok(!heldDirs(root).some(d => fs.existsSync(path.join(d, 'sandboxes/sbx_a/prophet_trader.db'))), 'the oversized native copy was removed');
  const { root: walRoot, writer } = walFixture();
  try {
    let walLooks = 0, jump = false;
    const fsx = wrapFs({ lstat: async (real, p, ...rest) => { if (String(p).endsWith(path.join('sbx_a', 'prophet_trader.db-wal')) && ++walLooks === 2) jump = true; return real(p, ...rest); } });
    const r2 = await run(walRoot, T1, { fsx, clock: () => Date.now() + (jump ? 1e9 : 0), maxRunMs: 60000 });
    assert.equal(r2.status, 'incomplete', 'the deadline was reached inside the native copy'); assert.deepEqual(dated(walRoot), []);
    assert.deepEqual(fs.readdirSync(daily(walRoot)).filter(n => n.startsWith('.tmp-')), []);
  } finally { writer.close(); }
});

// ── 9. missing prior copy and growth after planning ──────────────────────────────────────────────────────────────────────────────
test('H7R-9 (C): a missing inherited copy is budgeted as a full copy, growth after planning stops the run instead of an unreserved copy, and normal hard links still point to prior backup copies', async () => {
  const root = makeRoot();
  const session = path.join(root, 'sandboxes/sbx_a/chat-history/session-s1.jsonl');
  fs.writeFileSync(session, '{"tool":"x","n":1}\n'.repeat(16000));          // about 300 KB
  assert.equal((await run(root, T1)).status, 'ok');
  fs.rmSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'));            // the prior copy it would link to is gone
  const tight = await run(root, T2, { statfs: async () => ({ bavail: 200, bsize: 1024 }) });                // 200 KiB modeled
  assert.equal(tight.status, 'skipped_low_space', 'the fallback full copy was budgeted, not counted as zero');
  assert.deepEqual(dated(root), ['2026-11-25']);
  const healthy = await run(root, T2);
  assert.equal(healthy.status, 'ok'); assert.ok(healthy.linked > 0 && healthy.copied >= 1);
  const m = assertSnapshotConsistent(path.join(daily(root), '2026-11-26'), 'T2');
  assert.equal(m.files.find(f => f.rel === 'sandboxes/sbx_a/chat-history/session-s1.jsonl').linked, false);
  if (process.platform !== 'win32') {
    const rel = 'sandboxes/sbx_b/order-attribution.jsonl';
    assert.equal(fs.statSync(path.join(daily(root), '2026-11-25', rel)).ino, fs.statSync(path.join(daily(root), '2026-11-26', rel)).ino, 'linked to the prior backup copy');
    assert.notEqual(fs.statSync(path.join(root, rel)).ino, fs.statSync(path.join(daily(root), '2026-11-26', rel)).ino, 'never to the live file');
  }
  // growth after planning
  const grow = makeRoot();
  const ivFile = path.join(grow, 'iv-history/2026-11.jsonl');
  let calls = 0;
  const growing = wrapFs({ open: async (real, p, ...rest) => { if (String(p) === ivFile) fs.appendFileSync(ivFile, '{"symbol":"SPY","meanIv":0.2}\n'.repeat(8000)); return real(p, ...rest); } });
  const r = await run(grow, T1, { fsx: growing, statfs: async () => ({ bavail: ++calls <= 1 ? 1e9 : 1, bsize: 100 }) });
  assert.equal(r.status, 'aborted_low_space', 'growth that admission did not cover stopped the run');
  assert.deepEqual(dated(grow), []);
  assert.ok(!heldDirs(grow).some(d => fs.existsSync(path.join(d, 'iv-history/2026-11.jsonl'))), 'the grown file was not copied without reserved space');
});

// ── 10. time budget: planning, final copy, native copy, ownership ────────────────────────────────────────────────────────────────
test('H7R-10 (C): elapsed time is counted from before planning and checked in planning, after the last copy and before publication; no complete snapshot after an overrun', async () => {
  let t = 0;
  const slowPlan = wrapFs({ lstat: async (real, p, ...rest) => { t += 100; return real(p, ...rest); } });
  const r1 = await run(makeRoot(), T1, { fsx: slowPlan, clock: () => t, maxRunMs: 50 });
  assert.equal(r1.status, 'incomplete'); assert.equal(r1.complete, false);
  const root = makeRoot();
  let jump = false;
  const slowLast = wrapFs({ rm: async (real, p, ...rest) => { if (String(p).includes('.pair-')) jump = true; return real(p, ...rest); } });
  const r2 = await run(root, T1, { fsx: slowLast, clock: () => Date.now() + (jump ? 1e9 : 0), maxRunMs: 60000 });
  assert.equal(r2.status, 'incomplete', 'the overrun after the final pair copy is caught before publication'); assert.deepEqual(dated(root), []);
  assert.equal((await run(makeRoot(), T1, { clock: () => Date.now(), maxRunMs: 60000 })).status, 'ok', 'healthy control: within budget');
});

test('H7R-10b (C): a run keeps ownership while its I/O is outstanding (the scheduler stays busy), releases its handles after an overrun, and publishes nothing', async () => {
  const root = makeRoot();
  const target = path.join(root, 'sandboxes/sbx_a/order-attribution.jsonl');
  fs.writeFileSync(target, '{"o":1}\n'.repeat(1000));
  let jump = false, release;
  const gate = new Promise(resolve => { release = resolve; });
  let gated = false;
  const slow = wrapFs({ open: async (real, p, ...rest) => { if (String(p) === target && !gated) { gated = true; await gate; } return real(p, ...rest); } });
  const sched = createDailyBackup({ root, now: () => T1, runOptions: { ...FAST, fsx: slow, clock: () => Date.now() + (jump ? 1e9 : 0), maxRunMs: 60000 } });
  const pending = sched.tick();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal((await sched.tick()).status, 'busy', 'a second tick cannot start while the I/O is outstanding');
  assert.equal(sched.status().running, true);
  jump = true; release();
  const result = await pending;
  assert.equal(result.status, 'incomplete'); assert.equal(sched.status().running, false); assert.deepEqual(dated(root), []);
  assert.doesNotThrow(() => fs.rmSync(target), 'no handle on the source is left open');
});

test('H7R-10c: an omitted `now` means the current time (a function default is never used as a date)', async () => {
  const root = makeRoot();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(p => [p.type, p.value]));
  const r = await runBackup({ root, ...FAST });
  assert.equal(r.status, 'ok'); assert.equal(r.date, `${parts.year}-${parts.month}-${parts.day}`);
  assert.equal((await runBackup({ root: makeRoot(), now: () => T1, ...FAST })).date, '2026-11-25', 'a function is called');
});

// ── 11. evidence that the containment cases really executed (Linux CI) ──────────────────────────────────────────────────────────
test('H7R-11: the containment cases executed in this process (counted; on Linux CI none may be skipped)', t => {
  t.diagnostic(`containment cases executed: ${executed.containment}`);
  assert.ok(executed.containment >= 4, 'the junction/link containment cases ran');
  if (process.platform === 'linux') assert.ok(executed.containment >= 5, 'the symlink STATE case also ran on Linux');
});
