import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';

// Nov 25 H7 (corrected after Hermes' final QA): the automatic daily backup of the settings and the TRADE RECORD (which agent placed each order and the AlphaDesk result for it).
// The fixtures are synthetic and live inside the OS temp folder; no live data, key or retention is touched.
const { runBackup, createDailyBackup, planBackup, backupStatusPayload, OWNER } = await import('../agent/daily-backup.js');
const { inspectConfigState } = await import('../agent/config-preflight.js');
const { referenceStatusAgainst } = await import('../agent/config-secrets.js');

const T1 = Date.parse('2026-11-25T23:00:00Z');     // 18:00 ET Nov 25 (after the 17:00 ET start)
const T2 = Date.parse('2026-11-26T23:00:00Z');
const T3 = Date.parse('2026-11-27T23:00:00Z');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SENT = ['SENTINEL', 'KEY', 'MATERIAL', '77'].join('-');
const BIG = async () => ({ bavail: 1e9, bsize: 4096 });
const FAST = { statfs: BIG, reserveBytes: 0, marginBytes: 0, pairRetryDelayMs: 0 };
const run = (root, now, extra = {}) => runBackup({ root, now, ...FAST, ...extra });
const daily = root => path.join(root, 'recovery-backups/daily');
const dated = root => fs.readdirSync(daily(root)).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
const manifestOf = (root, date) => JSON.parse(fs.readFileSync(path.join(daily(root), date, 'MANIFEST.json'), 'utf8'));
const treeNames = dir => fs.readdirSync(dir, { recursive: true }).sort();
const wrapFs = overrides => new Proxy(fsp, { get(target, prop) { if (overrides[prop]) return (...args) => overrides[prop](target[prop].bind(target), ...args); const v = target[prop]; return typeof v === 'function' ? v.bind(target) : v; } });

function makeRoot({ withMarkers = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-'));
  const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  const config = withMarkers ? { accounts: [{ id: 'acc1', secretRef: 'account:acc1' }], sandboxes: {} } : { accounts: [], sandboxes: {} };
  w('agent-config.json', JSON.stringify(config)); w('agent-config.json.bak', JSON.stringify(config));
  w('secrets.json', JSON.stringify({ accounts: withMarkers ? { acc1: { publicKey: 'PK-' + SENT, secretKey: 'SK-' + SENT } } : {}, alphadesk: {} })); w('secrets.json.bak', '{}'); w('trading-guidance.json', '{"x":1}');
  w('iv-history/2026-11.jsonl', '{"symbol":"SPY","meanIv":0.2254}\n'); w('iv-history/budget-2026-11-24.json', '{"spent":460}');
  for (const sb of ['sbx_a', 'sbx_b']) {
    w(`sandboxes/${sb}/order-attribution.jsonl`, `{"v":1,"orderIds":["o-${sb}"],"agentId":"catalyst","agentName":"Herald"}\n`);
    w(`sandboxes/${sb}/daily-loss-lock.json`, '{}'); w(`sandboxes/${sb}/.migrated-from-legacy-v2.json`, '{"verified":true}');
    w(`sandboxes/${sb}/chat-history/sessions.json`, '{"sessions":[]}');
    w(`sandboxes/${sb}/chat-history/session-s1.jsonl`, `{"tool":"place_options_order","result":"PASS signal_score 48.27 ${sb}"}\n`);
    w(`sandboxes/${sb}/activity_logs/a.json`, '{}'); w(`sandboxes/${sb}/decisive_actions/d1.json`, '{"market_data":{"assessment_signal_score":44.13}}'); w(`sandboxes/${sb}/news_summaries/n.json`, '{}');
    w(`sandboxes/${sb}/prophet_trader.db.recovery-20260926-0316.bak`, 'old recovery copy that must be skipped'); w(`sandboxes/${sb}.opening.lock`, 'lock');
    const db = new Database(path.join(root, `sandboxes/${sb}/prophet_trader.db`)); db.exec("CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'stored trade')"); db.close();
  }
  // readable, provenance-bound legacy quarantine (non-actionable history the app still displays)
  w('quarantine/legacy/sbx_a/QUARANTINED.json', '{"nonActionable":true,"provenance":{"legacyAccountId":"legacy1","requestedSandboxId":"sbx_a"}}');
  w('quarantine/legacy/sbx_a/activity_logs/legacy.json', '{}');
  const legacy = new Database(path.join(root, 'quarantine/legacy/sbx_a/prophet_trader.db')); legacy.exec("CREATE TABLE trades (id INTEGER, note TEXT); INSERT INTO trades VALUES (1, 'legacy trade')"); legacy.close();
  return root;
}

// ── coverage ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('the snapshot covers the settings, the IV history, the whole trade record and the readable legacy quarantine with its provenance, each verified by hash; the manifest states what it excludes', async () => {
  const root = makeRoot();
  const result = await run(root, T1);
  assert.equal(result.status, 'ok'); assert.equal(result.complete, true); assert.equal(result.errors, 0);
  const manifest = manifestOf(root, '2026-11-25');
  assert.equal(manifest.owner, OWNER); assert.equal(manifest.complete, true);
  const rels = new Set(manifest.files.map(f => f.rel));
  for (const rel of ['agent-config.json', 'agent-config.json.bak', 'secrets.json', 'secrets.json.bak', 'trading-guidance.json', 'iv-history/2026-11.jsonl', 'iv-history/budget-2026-11-24.json',
    'quarantine/legacy/sbx_a/QUARANTINED.json', 'quarantine/legacy/sbx_a/prophet_trader.db', 'quarantine/legacy/sbx_a/activity_logs/legacy.json']) assert.ok(rels.has(rel), rel);
  for (const sb of ['sbx_a', 'sbx_b'])
    for (const rel of ['order-attribution.jsonl', 'daily-loss-lock.json', '.migrated-from-legacy-v2.json', 'chat-history/sessions.json', 'chat-history/session-s1.jsonl', 'activity_logs/a.json', 'decisive_actions/d1.json', 'news_summaries/n.json', 'prophet_trader.db'])
      assert.ok(rels.has(`sandboxes/${sb}/${rel}`), `${sb}/${rel}`);
  assert.ok(manifest.files.filter(f => f.rel.startsWith('quarantine/')).every(f => f.legacyNonActionable === true), 'legacy records are marked non-actionable');
  assert.ok(manifest.excluded.some(e => /root-level legacy/.test(e)), 'unsupported scope is stated, not silently claimed');
  for (const f of manifest.files) { const copy = path.join(daily(root), '2026-11-25', f.rel); assert.equal(fs.statSync(copy).size, f.bytes); if (f.kind === 'file') assert.equal(sha(fs.readFileSync(copy)), f.sha256, f.rel); }
  assert.match(fs.readFileSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/order-attribution.jsonl'), 'utf8'), /"agentName":"Herald"/);
  assert.match(fs.readFileSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /signal_score 48\.27/);
  assert.ok(![...rels].some(r => r.includes('.recovery-') || r.endsWith('.lock')));
  const legacyCopy = new Database(path.join(daily(root), '2026-11-25/quarantine/legacy/sbx_a/prophet_trader.db'), { readonly: true });
  try { assert.equal(legacyCopy.prepare('SELECT note FROM trades WHERE id = 1').get().note, 'legacy trade'); } finally { legacyCopy.close(); }
});

test('SQLite: the online backup API copies a LIVE WAL database with uncheckpointed rows while its writer stays open, and the writer keeps working', async () => {
  const root = makeRoot();
  const dbFile = path.join(root, 'sandboxes/sbx_a/prophet_trader.db');
  const writer = new Database(dbFile); writer.pragma('journal_mode = WAL'); writer.pragma('wal_autocheckpoint = 0');
  writer.exec("INSERT INTO t VALUES (2, 'wal row 1'), (3, 'wal row 2')");
  try {
    assert.equal((await run(root, T1)).status, 'ok');
    const copy = new Database(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/prophet_trader.db'), { readonly: true });
    try { assert.deepEqual(copy.prepare('SELECT id FROM t ORDER BY id').all().map(r => r.id), [1, 2, 3]); } finally { copy.close(); }
    writer.exec("INSERT INTO t VALUES (4, 'after the backup')");                                   // the live writer is not blocked
    assert.equal(writer.prepare('SELECT count(*) n FROM t').get().n, 4);
  } finally { writer.close(); }
});

// ── H7-01 planning errors and truncation never report success ───────────────────────────────────────────────────────────────
test('H7-01: an unreadable subtree, an unreadable settings file, a missing required config or a hit file cap is INCOMPLETE (never a published success) while true optional absence is fine', async () => {
  const cases = [
    ['unreadable chat-history', { fsx: wrapFs({ opendir: (real, p, ...r) => /chat-history/.test(String(p)) && /sbx_a/.test(String(p)) ? Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) : real(p, ...r) }) }],
    ['unreadable settings file', { fsx: wrapFs({ lstat: (real, p, ...r) => String(p).endsWith('secrets.json') ? Promise.reject(Object.assign(new Error('x'), { code: 'EACCES' })) : real(p, ...r) }) }],
    ['file cap', { maxFiles: 3 }],
  ];
  for (const [label, extra] of cases) {
    const root = makeRoot();
    const r = await run(root, T1, extra);
    assert.equal(r.status, 'incomplete', label); assert.equal(r.complete, false, label);
    assert.ok(r.errors > 0 || r.truncated, label);
    assert.deepEqual(dated(root), [], label + ': no dated recovery point was published');
    assert.equal(fs.readdirSync(path.join(daily(root), '.incomplete')).length, 1, label + ': kept for diagnosis only');
  }
  const noConfig = makeRoot(); fs.rmSync(path.join(noConfig, 'agent-config.json'));
  const missing = await run(noConfig, T1);
  assert.equal(missing.status, 'incomplete'); assert.equal(missing.missing, 1);
  const minimal = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-min-')); fs.writeFileSync(path.join(minimal, 'agent-config.json'), '{"accounts":[]}');
  assert.equal((await run(minimal, T1)).status, 'ok', 'a virgin layout (no sandboxes, no IV, no quarantine) is complete: absence is optional');
  const plan = await planBackup({ root: makeRoot(), maxFiles: 2 });
  assert.equal(plan.entries.length, 2); assert.equal(plan.truncated, true, 'traversal stops at the cap');
});

// ── H7-02 bounded complete records and the copied settings pair ─────────────────────────────────────────────────────────────
test('H7-02: a torn JSONL tail is discarded (only complete records are kept), a growing source cannot extend the capture, and the source stays intact', async () => {
  const root = makeRoot();
  const journal = path.join(root, 'sandboxes/sbx_a/order-attribution.jsonl');
  const complete = '{"orderIds":["o1"],"agentName":"Herald"}\n';
  fs.writeFileSync(journal, complete + '{"orderIds":["o2"],"agentNa');                           // a record caught mid-append
  const r = await run(root, T1);
  assert.equal(r.status, 'ok'); assert.equal(r.discardedTails, 1);
  const copy = fs.readFileSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/order-attribution.jsonl'), 'utf8');
  assert.equal(copy, complete, 'exactly the complete records, ending with a newline');
  copy.trim().split('\n').forEach(line => JSON.parse(line));
  fs.appendFileSync(journal, 'me":"Pendulum"}\n');                                              // the writer finishes later: the source is valid and was never altered
  assert.doesNotThrow(() => fs.readFileSync(journal, 'utf8').trim().split('\n').forEach(line => JSON.parse(line)));
  // growth during the copy: the capture is fixed at the size seen on open
  const big = makeRoot();
  const target = path.join(big, 'sandboxes/sbx_a/chat-history/session-s1.jsonl');
  const record = '{"tool":"x","n":1}\n';
  fs.writeFileSync(target, record.repeat(200000));                                              // about 3.8 MB
  const sizeAtOpen = fs.statSync(target).size;
  let grew = false;
  const growing = wrapFs({ open: async (real, p, ...rest) => {
    const handle = await real(p, ...rest);
    if (String(p) !== target) return handle;
    return new Proxy(handle, { get(h, prop) {
      if (prop === 'read') return async (...a) => { if (!grew) { grew = true; fs.appendFileSync(target, record.repeat(50000) + '{"partial'); } return h.read(...a); };
      const v = h[prop]; return typeof v === 'function' ? v.bind(h) : v;
    } });
  } });
  assert.equal((await run(big, T1, { fsx: growing })).status, 'ok');
  const grown = fs.readFileSync(path.join(daily(big), '2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8');
  assert.ok(grew && grown.length <= sizeAtOpen, 'the capture never exceeded the size seen at open');
  assert.ok(grown.endsWith('\n') && grown.trim().split('\n').every(l => { try { JSON.parse(l); return true; } catch { return false; } }), 'every retained record parses');
});

test('H7-02: invalid critical JSON is incomplete; the copied config and private store must work together (checked on the COPIES, retried for a settings race, never from live key state)', async () => {
  const bad = makeRoot(); fs.writeFileSync(path.join(bad, 'agent-config.json'), '{broken');
  const r1 = await run(bad, T1);
  assert.equal(r1.status, 'incomplete'); assert.ok(r1.errors >= 1);
  // markers whose keys are missing from the copied private store
  const unresolved = makeRoot({ withMarkers: true });
  fs.writeFileSync(path.join(unresolved, 'secrets.json'), JSON.stringify({ accounts: {}, alphadesk: {} }));
  const r2 = await run(unresolved, T1, { pairRetries: 0 });
  assert.equal(r2.status, 'incomplete'); assert.equal(dated(unresolved).length, 0);
  // a race: the private store is mid-change on the first capture and good on the retry
  const race = makeRoot({ withMarkers: true });
  const secretsFile = path.join(race, 'secrets.json');
  const good = fs.readFileSync(secretsFile, 'utf8');
  fs.writeFileSync(secretsFile, JSON.stringify({ accounts: {}, alphadesk: {} }));
  let opens = 0;
  const racing = wrapFs({ open: async (real, p, ...rest) => { if (String(p) === secretsFile && ++opens === 2) fs.writeFileSync(secretsFile, good); return real(p, ...rest); } });
  const r3 = await run(race, T1, { fsx: racing, pairRetries: 2 });
  assert.equal(r3.status, 'ok', 'the bounded retry captured a consistent pair');
  // positive control + isolated restore dry-run from the COPIES (never from the live volume)
  const ok = makeRoot({ withMarkers: true });
  assert.equal((await run(ok, T1)).status, 'ok');
  const restore = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-restore-'));
  for (const f of ['agent-config.json', 'secrets.json']) fs.copyFileSync(path.join(daily(ok), '2026-11-25', f), path.join(restore, f));
  const report = await inspectConfigState({ configPath: path.join(restore, 'agent-config.json'), secretsPath: path.join(restore, 'secrets.json') });
  assert.equal(report.nextStart, 'load_primary', 'the restored pair is accepted by the same rules as startup');
  // the pure check does not read or change any global state
  assert.equal(referenceStatusAgainst({ accounts: [{ id: 'a', secretRef: 'account:a' }] }, { accounts: {} }).ok, false);
  assert.equal(referenceStatusAgainst({ accounts: [{ id: 'a', secretRef: 'account:a' }] }, null).reason, 'private_store_unavailable');
});

// ── H7-03 state, retry, retention ownership ─────────────────────────────────────────────────────────────────────────────────────
test('H7-03: an incomplete run keeps its failure state across a restart, does not consume the date, never evicts a good recovery point, and is retried with a backoff until it succeeds', async () => {
  const root = makeRoot();
  assert.equal((await run(root, T1, { keep: 1 })).status, 'ok');
  const flaky = { sqliteBackup: async () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
  const first = createDailyBackup({ root, now: () => T2, runOptions: { ...FAST, keep: 1, ...flaky }, retryAfterMs: 3600000 });
  const result = await first.tick();
  assert.equal(result.status, 'incomplete'); assert.ok(result.errors >= 1);
  assert.deepEqual(dated(root), ['2026-11-25'], 'the good snapshot is still there and today is NOT published');
  assert.equal(fs.readdirSync(path.join(daily(root), '.incomplete')).length, 1);
  // restart: the failure state is read from disk, not forgotten
  let clock = T2;
  const restarted = createDailyBackup({ root, now: () => clock, runOptions: { ...FAST, keep: 1 }, retryAfterMs: 3600000 });
  assert.equal(restarted.status().complete, false); assert.ok(restarted.status().errors >= 1); assert.equal(restarted.status().date, '2026-11-26');
  assert.equal((await restarted.tick()).status, 'retry_later');
  clock = T2 + 3600001;
  const retried = await restarted.tick();
  assert.equal(retried.status, 'ok'); assert.deepEqual(dated(root), ['2026-11-26'], 'keep 1: the new COMPLETE snapshot replaces the old one only after it exists');
  assert.equal(restarted.status().attempts, 2);
  assert.equal((await restarted.tick()).status, 'done_today');
  // bounded attempts per date
  const stubborn = createDailyBackup({ root: makeRoot(), now: () => T3, runOptions: { ...FAST, ...flaky }, retryAfterMs: 0, maxAttemptsPerDate: 2 });
  assert.equal((await stubborn.tick()).status, 'incomplete'); assert.equal((await stubborn.tick()).status, 'incomplete'); assert.equal((await stubborn.tick()).status, 'gave_up_today');
});

test('H7-03: retention counts and removes only COMPLETE snapshots owned by this module; foreign or partial date-named folders are never selected or deleted; remaining hard-linked files stay identical', async () => {
  const root = makeRoot();
  const base = daily(root);
  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(path.join(base, '2026-09-01'), { recursive: true }); fs.writeFileSync(path.join(base, '2026-09-01/keepme.txt'), 'foreign');          // no manifest
  fs.mkdirSync(path.join(base, '2026-09-02'), { recursive: true }); fs.writeFileSync(path.join(base, '2026-09-02/MANIFEST.json'), JSON.stringify({ owner: 'someone-else', version: 2, complete: true, date: '2026-09-02', files: [] }));
  fs.mkdirSync(path.join(base, '2026-09-03'), { recursive: true }); fs.writeFileSync(path.join(base, '2026-09-03/MANIFEST.json'), JSON.stringify({ owner: OWNER, version: 2, complete: false, date: '2026-09-03', files: [] }));
  const days = [T1, T2, T3, Date.parse('2026-11-28T23:00:00Z')];
  for (const t of days) assert.equal((await run(root, t, { keep: 2 })).status, 'ok');
  assert.deepEqual(dated(root).filter(d => d >= '2026-11'), ['2026-11-27', '2026-11-28'], 'keep 2: the oldest two COMPLETE snapshots were removed');
  for (const foreign of ['2026-09-01', '2026-09-02', '2026-09-03']) assert.ok(fs.existsSync(path.join(base, foreign)), foreign + ' untouched');
  const m = manifestOf(root, '2026-11-28');
  for (const f of m.files) assert.equal(sha(fs.readFileSync(path.join(base, '2026-11-28', f.rel))), f.sha256, 'remaining snapshot readable and identical: ' + f.rel);
  // a foreign folder that squats on today's date is never overwritten
  const squat = makeRoot(); fs.mkdirSync(path.join(daily(squat), '2026-11-25'), { recursive: true }); fs.writeFileSync(path.join(daily(squat), '2026-11-25/x.txt'), 'x');
  assert.equal((await run(squat, T1)).status, 'blocked_foreign_folder'); assert.equal(fs.readFileSync(path.join(daily(squat), '2026-11-25/x.txt'), 'utf8'), 'x');
});

// ── H7-04 resource safety ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('H7-04: capacity is a reserve plus a pessimistic estimate, unknown capacity skips, free space is rechecked during the copy, and every run is bounded; abandoned OWNED staging is cleaned', async () => {
  const live = makeRoot();
  const liveBefore = sha(fs.readFileSync(path.join(live, 'agent-config.json')));
  assert.equal((await run(live, T1, { statfs: async () => { throw new Error('unknown'); } })).status, 'skipped_capacity_unknown');
  assert.equal((await run(live, T1, { statfs: async () => ({ bavail: 1, bsize: 1024 * 1024 * 1024 }), reserveBytes: 100 * 1024 * 1024 })).status, 'ok', 'plenty above reserve + estimate runs');
  const tight = makeRoot();
  assert.equal((await run(tight, T1, { statfs: async () => ({ bavail: 1, bsize: 600 * 1024 * 1024 }), reserveBytes: 600 * 1024 * 1024 })).status, 'skipped_low_space', 'free equal to the reserve leaves no room for the estimate');
  // the free space shrinks while copying
  const shrinking = makeRoot();
  let calls = 0;
  const r = await run(shrinking, T1, { recheckEvery: 1, reserveBytes: 1000, statfs: async () => ({ bavail: ++calls <= 1 ? 1e9 : 10, bsize: 1 }) });
  assert.equal(r.status, 'aborted_low_space');
  assert.deepEqual(dated(shrinking), []); assert.deepEqual(fs.readdirSync(daily(shrinking)).filter(n => n.startsWith('.tmp')), [], 'staging removed');
  // an oversized file, a run budget, a time budget
  assert.equal((await run(makeRoot(), T1, { maxFileBytes: 20 })).status, 'incomplete');
  assert.equal((await run(makeRoot(), T1, { maxRunBytes: 10 })).status, 'skipped_run_too_large');
  assert.equal((await run(makeRoot(), T1, { maxRunMs: -1 })).status, 'incomplete');
  // abandoned staging: only provably owned and old
  const staged = makeRoot();
  fs.mkdirSync(daily(staged), { recursive: true });
  const old = path.join(daily(staged), '.tmp-2026-11-01-1-abc'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, '.owner'), JSON.stringify({ owner: OWNER, startedAt: T1 - 7 * 3600000 }));
  const recent = path.join(daily(staged), '.tmp-2026-11-25-1-def'); fs.mkdirSync(recent, { recursive: true }); fs.writeFileSync(path.join(recent, '.owner'), JSON.stringify({ owner: OWNER, startedAt: T1 - 60000 }));
  const foreign = path.join(daily(staged), '.tmp-foreign'); fs.mkdirSync(foreign, { recursive: true });
  await run(staged, T1);
  assert.ok(!fs.existsSync(old), 'old owned staging removed'); assert.ok(fs.existsSync(recent), 'a recent one may belong to a running task'); assert.ok(fs.existsSync(foreign), 'not provably ours: untouched');
  assert.equal(sha(fs.readFileSync(path.join(live, 'agent-config.json'))), liveBefore, 'live files unchanged');
});

// ── H7-05 containment ────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('H7-05: links are never followed: a settings-file link, a source-root link, a sandbox-root link or a redirected output parent leave the snapshot incomplete/failed and nothing outside is read, written or deleted', async t => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-outside-'));
  fs.writeFileSync(path.join(outside, 'secret-target.json'), '{"outside":true}'); fs.mkdirSync(path.join(outside, 'dir')); fs.writeFileSync(path.join(outside, 'dir/file.jsonl'), '{"o":1}\n');
  const outsideBefore = treeNames(outside);
  const link = (target, at) => fs.symlinkSync(target, at, 'junction');
  let supported = true;
  const settingsLink = makeRoot();
  try { fs.rmSync(path.join(settingsLink, 'trading-guidance.json')); fs.symlinkSync(path.join(outside, 'secret-target.json'), path.join(settingsLink, 'trading-guidance.json')); } catch { supported = false; }
  if (!supported) { t.skip('symlink creation is not permitted here (runs on Linux CI)'); return; }
  const a = await run(settingsLink, T1);
  assert.equal(a.status, 'incomplete'); assert.ok(!fs.existsSync(path.join(daily(settingsLink), '.incomplete')) || !treeNames(path.join(daily(settingsLink), '.incomplete')).some(n => n.includes('trading-guidance')), 'the link target was not copied');
  const ivLink = makeRoot(); fs.rmSync(path.join(ivLink, 'iv-history'), { recursive: true }); link(path.join(outside, 'dir'), path.join(ivLink, 'iv-history'));
  const b = await run(ivLink, T1); assert.equal(b.status, 'incomplete');
  const sbLink = makeRoot(); fs.rmSync(path.join(sbLink, 'sandboxes'), { recursive: true }); link(outside, path.join(sbLink, 'sandboxes'));
  const c = await run(sbLink, T1); assert.equal(c.status, 'incomplete');
  const nested = makeRoot(); link(path.join(outside, 'dir'), path.join(nested, 'sandboxes/sbx_a/chat-history/linkdir'));
  const d = await run(nested, T1); assert.equal(d.status, 'ok'); assert.ok(!treeNames(path.join(daily(nested), '2026-11-25')).some(n => n.includes('linkdir')), 'ordinary nested links are skipped');
  assert.equal(manifestOf(nested, '2026-11-25').counts.skippedLinks, 1);
  const redirected = makeRoot(); fs.mkdirSync(path.join(redirected, 'recovery-backups'), { recursive: true }); link(outside, path.join(redirected, 'recovery-backups/daily'));
  const e = await run(redirected, T1); assert.equal(e.status, 'failed');
  assert.deepEqual(treeNames(outside), outsideBefore, 'nothing was written, copied or deleted outside through any link');
});

// ── hard links, heuristics and status ───────────────────────────────────────────────────────────────────────────────────────────
test('hard links point to the previous COMPLETE backup copy, never to a live file; unchanged non-critical files are inherited, settings are always re-copied and validated, and an earlier day is never altered', async t => {
  const root = makeRoot();
  await run(root, T1);
  const chat = path.join(root, 'sandboxes/sbx_a/chat-history/session-s1.jsonl');
  fs.appendFileSync(chat, '{"tool":"log_decision","note":"new line"}\n');
  // same-size, same-mtime replacement of a settings file: settings are never inherited, so the new content is captured
  const guidance = path.join(root, 'trading-guidance.json'); const mtime = fs.statSync(guidance).mtime;
  fs.writeFileSync(guidance, '{"x":2}'); fs.utimesSync(guidance, mtime, mtime);
  const next = await run(root, T2);
  assert.equal(next.status, 'ok'); assert.ok(next.linked > 0 && next.copied >= 1);
  const m2 = manifestOf(root, '2026-11-26');
  assert.equal(m2.files.find(f => f.rel === 'sandboxes/sbx_a/chat-history/session-s1.jsonl').linked, false);
  assert.equal(m2.files.find(f => f.rel === 'trading-guidance.json').linked, false, 'settings are never hard-linked');
  assert.equal(fs.readFileSync(path.join(daily(root), '2026-11-26/trading-guidance.json'), 'utf8'), '{"x":2}');
  assert.match(fs.readFileSync(path.join(daily(root), '2026-11-26/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /new line/);
  assert.doesNotMatch(fs.readFileSync(path.join(daily(root), '2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /new line/, 'the earlier day is never altered');
  assert.equal(fs.readFileSync(path.join(daily(root), '2026-11-25/trading-guidance.json'), 'utf8'), '{"x":1}');
  if (process.platform === 'win32') { t.diagnostic('inode identity is asserted on Linux CI'); return; }
  const linkedRel = 'sandboxes/sbx_b/order-attribution.jsonl';
  const a = fs.statSync(path.join(daily(root), '2026-11-25', linkedRel)), b = fs.statSync(path.join(daily(root), '2026-11-26', linkedRel));
  assert.equal(a.ino, b.ino); assert.ok(b.nlink >= 2);
  assert.notEqual(fs.statSync(path.join(root, linkedRel)).ino, b.ino, 'never linked to the live file');
});

test('settings and secrets are written restricted and the status payload is an exact allow-list of counts and labels (incomplete and truncated visible, no names, paths or key text)', async t => {
  const root = makeRoot({ withMarkers: true });
  await run(root, T1);
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(daily(root), '2026-11-25')).mode & 0o077, 0); assert.equal(fs.statSync(path.join(daily(root), '2026-11-25/secrets.json')).mode & 0o077, 0); } else t.diagnostic('POSIX modes are checked on Linux CI');
  const sched = createDailyBackup({ root: makeRoot(), now: () => T1, runOptions: { ...FAST, maxFiles: 3 } });
  await sched.tick();
  const payload = backupStatusPayload(sched, true);
  assert.deepEqual(Object.keys(payload).sort(), ['attempts', 'bytes', 'complete', 'copied', 'date', 'discardedTails', 'enabled', 'errors', 'files', 'kept', 'lastAttemptAt', 'lastCompleteDate', 'linked', 'missing', 'running', 'status', 'truncated']);
  assert.equal(payload.complete, false); assert.equal(payload.truncated, true); assert.equal(payload.status, 'incomplete');
  const text = JSON.stringify(payload);
  for (const forbidden of ['secrets', 'agent-config', 'sbx_a', 'order-attribution', SENT, root]) assert.ok(!text.includes(forbidden), forbidden);
  assert.equal(backupStatusPayload(createDailyBackup({ root: makeRoot() }), true).status, 'not_run_yet');
});

test('the scheduler waits until 17:00 ET, runs one complete snapshot per New York date, never overlaps and swallows errors', async () => {
  const root = makeRoot();
  let clock = Date.parse('2026-11-25T20:00:00Z');            // 15:00 ET
  let calls = 0;
  const sched = createDailyBackup({ root, now: () => clock, run: async o => { calls += 1; return runBackup({ ...o, ...FAST }); } });
  assert.equal((await sched.tick()).status, 'waiting'); assert.equal(calls, 0);
  clock = T1;
  const [a, b] = await Promise.all([sched.tick(), sched.tick()]);
  assert.ok([a.status, b.status].includes('busy') && calls === 1);
  assert.equal((await sched.tick()).status, 'done_today');
  clock = T2; assert.equal((await sched.tick()).status, 'ok'); assert.equal(calls, 2);
  const broken = createDailyBackup({ root: makeRoot(), now: () => T1, run: async () => { throw new Error('x'); } });
  assert.equal((await broken.tick()).status, 'failed');
  assert.equal((await runBackup({ root: path.join(os.tmpdir(), 'op2-bk-no-such-root-' + crypto.randomBytes(4).toString('hex')), now: T1, ...FAST })).status, 'failed');
});

test('the server wires the backup after the auth middleware, passes the settings owners\' paths, and the module never fetches, unlinks, chmods or follows links', () => {
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const auth = server.indexOf("app.use('/api', authMiddleware)");
  assert.ok(auth > 0 && server.indexOf("app.get('/api/backup-status'") > auth);
  assert.match(server, /DAILY_BACKUP_ENABLED/); assert.match(server, /secretsPath: secretsStore\.secretsPath\(\)/);
  const source = fs.readFileSync(new URL('../agent/daily-backup.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /unlink|rmdir|fetch\(|axios|http\./);
  assert.doesNotMatch(source, /chmod|chown/, 'the live tree is never repaired by changing modes');
});
