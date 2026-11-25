import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';

// Nov 25: automatic daily in-volume backup of the settings and the TRADE RECORD (who placed each order and the AlphaDesk result for it).
const { runBackup, createDailyBackup, planBackup, backupStatusPayload, BACKUP_DEFAULTS } = await import('../agent/daily-backup.js');

const T1 = Date.parse('2026-11-25T23:00:00Z');     // 18:00 ET Nov 25 (after the 17:00 ET start)
const T2 = Date.parse('2026-11-26T23:00:00Z');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SENT = ['SENTINEL', 'KEY', 'MATERIAL', '77'].join('-');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-'));
  const w = (rel, text) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; };
  w('agent-config.json', '{"accounts":[],"sandboxes":{}}'); w('agent-config.json.bak', '{"accounts":[],"sandboxes":{}}');
  w('secrets.json', `{"accounts":{"a":{"secretKey":"${SENT}"}}}`); w('secrets.json.bak', '{}'); w('trading-guidance.json', '{"x":1}');
  w('iv-history/2026-11.jsonl', '{"symbol":"SPY","meanIv":0.2254}\n'); w('iv-history/budget-2026-11-24.json', '{"spent":460}');
  for (const sb of ['sbx_a', 'sbx_b']) {
    w(`sandboxes/${sb}/order-attribution.jsonl`, `{"v":1,"orderIds":["o-${sb}"],"agentId":"catalyst","agentName":"Herald"}\n`);
    w(`sandboxes/${sb}/daily-loss-lock.json`, '{}');
    w(`sandboxes/${sb}/chat-history/sessions.json`, '{"sessions":[]}');
    w(`sandboxes/${sb}/chat-history/session-s1.jsonl`, `{"tool":"place_options_order","result":"PASS signal_score 48.27 ${sb}"}\n`);
    w(`sandboxes/${sb}/activity_logs/a.json`, '{}'); w(`sandboxes/${sb}/decisive_actions/d1.json`, `{"market_data":{"assessment_signal_score":44.13}}`);
    w(`sandboxes/${sb}/news_summaries/n.json`, '{}');
    w(`sandboxes/${sb}/prophet_trader.db.recovery-20260926-0316.bak`, 'old recovery copy that must be skipped');
    w(`sandboxes/${sb}.opening.lock`, 'lock');
    const db = new Database(path.join(root, `sandboxes/${sb}/prophet_trader.db`)); db.exec("CREATE TABLE t (id INTEGER, note TEXT); INSERT INTO t VALUES (1, 'stored trade')"); db.close();
  }
  return root;
}
const manifestOf = (root, date) => JSON.parse(fs.readFileSync(path.join(root, 'recovery-backups/daily', date, 'MANIFEST.json'), 'utf8'));
const dated = root => fs.readdirSync(path.join(root, 'recovery-backups/daily')).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort();
const listing = dir => fs.readdirSync(dir, { recursive: true }).sort();

test('the backup contains the settings, the IV history and the whole trade record (agent attribution, AlphaDesk results, decisions, trade database), each verified by hash', async () => {
  const root = makeRoot();
  const result = await runBackup({ root, now: T1, minFreeBytes: 0 });
  assert.equal(result.status, 'ok'); assert.equal(result.errors, 0);
  const manifest = manifestOf(root, '2026-11-25');
  const rels = new Set(manifest.files.map(f => f.rel));
  for (const rel of ['agent-config.json', 'agent-config.json.bak', 'secrets.json', 'secrets.json.bak', 'trading-guidance.json', 'iv-history/2026-11.jsonl', 'iv-history/budget-2026-11-24.json'])
    assert.ok(rels.has(rel), rel);
  for (const sb of ['sbx_a', 'sbx_b'])
    for (const rel of ['order-attribution.jsonl', 'daily-loss-lock.json', 'chat-history/sessions.json', 'chat-history/session-s1.jsonl', 'activity_logs/a.json', 'decisive_actions/d1.json', 'news_summaries/n.json', 'prophet_trader.db'])
      assert.ok(rels.has(`sandboxes/${sb}/${rel}`), `${sb}/${rel}`);
  for (const f of manifest.files) {
    const copy = path.join(root, 'recovery-backups/daily/2026-11-25', f.rel);
    assert.equal(fs.statSync(copy).size, f.bytes);
    if (f.kind === 'file') assert.equal(sha(fs.readFileSync(copy)), f.sha256, f.rel);
  }
  // the trade record in the copy still names the agent and carries the AD score
  const attribution = fs.readFileSync(path.join(root, 'recovery-backups/daily/2026-11-25/sandboxes/sbx_a/order-attribution.jsonl'), 'utf8');
  assert.match(attribution, /"agentName":"Herald"/);
  assert.match(fs.readFileSync(path.join(root, 'recovery-backups/daily/2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /signal_score 48\.27/);
  // old recovery copies, lock files and dot files are not backed up
  assert.ok(![...rels].some(r => r.includes('.recovery-') || r.endsWith('.lock')));
});

test('a SQLite database is copied with the online backup API and opens with its rows', async () => {
  const root = makeRoot();
  await runBackup({ root, now: T1, minFreeBytes: 0 });
  const copy = new Database(path.join(root, 'recovery-backups/daily/2026-11-25/sandboxes/sbx_a/prophet_trader.db'), { readonly: true });
  try { assert.equal(copy.prepare('SELECT note FROM t WHERE id = 1').get().note, 'stored trade'); } finally { copy.close(); }
});

test('settings and secrets are written restricted (0600 files, 0700 folders) and the status payload never carries names or contents', async t => {
  const root = makeRoot();
  await runBackup({ root, now: T1, minFreeBytes: 0 });
  const day = path.join(root, 'recovery-backups/daily/2026-11-25');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(day).mode & 0o077, 0);
    assert.equal(fs.statSync(path.join(day, 'secrets.json')).mode & 0o077, 0);
  } else t.diagnostic('POSIX modes are checked on Linux CI');
  const root2 = makeRoot();
  const daily = createDailyBackup({ root: root2, now: () => T1, runOptions: { minFreeBytes: 0 } });
  await daily.tick();
  const payload = JSON.stringify(backupStatusPayload(daily, true));
  for (const forbidden of ['secrets', 'agent-config', 'sbx_a', 'order-attribution', SENT, root]) assert.ok(!payload.includes(forbidden), forbidden);
  assert.match(payload, /"status":"ok"/);
});

test('one backup per New York date: a second run the same day does nothing, and the live files are never modified', async () => {
  const root = makeRoot();
  const liveBefore = listing(root).filter(n => !n.startsWith('recovery-backups'));
  const hashes = Object.fromEntries(liveBefore.filter(n => fs.statSync(path.join(root, n)).isFile()).map(n => [n, sha(fs.readFileSync(path.join(root, n)))]));
  assert.equal((await runBackup({ root, now: T1, minFreeBytes: 0 })).status, 'ok');
  assert.equal((await runBackup({ root, now: T1 + 3600000, minFreeBytes: 0 })).status, 'exists');
  for (const [n, h] of Object.entries(hashes)) assert.equal(sha(fs.readFileSync(path.join(root, n))), h, n + ' unchanged');
  assert.deepEqual(listing(root).filter(n => !n.startsWith('recovery-backups')), liveBefore, 'no live file was created, moved or deleted');
});

test('unchanged files are hard-linked to the previous day (every day is a full snapshot), changed files are copied, and the next day sees the new content', async () => {
  const root = makeRoot();
  await runBackup({ root, now: T1, minFreeBytes: 0 });
  fs.appendFileSync(path.join(root, 'sandboxes/sbx_a/chat-history/session-s1.jsonl'), '{"tool":"log_decision","note":"new line"}\n');
  const next = await runBackup({ root, now: T2, minFreeBytes: 0 });
  assert.equal(next.status, 'ok');
  assert.ok(next.linked > 0 && next.copied >= 1, `linked ${next.linked}, copied ${next.copied}`);
  const m2 = manifestOf(root, '2026-11-26');
  assert.equal(m2.files.find(f => f.rel === 'sandboxes/sbx_a/chat-history/session-s1.jsonl').linked, false);
  assert.equal(m2.files.find(f => f.rel === 'agent-config.json').linked, true);
  assert.match(fs.readFileSync(path.join(root, 'recovery-backups/daily/2026-11-26/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /new line/);
  assert.doesNotMatch(fs.readFileSync(path.join(root, 'recovery-backups/daily/2026-11-25/sandboxes/sbx_a/chat-history/session-s1.jsonl'), 'utf8'), /new line/, 'the earlier day copy is never altered by the later run');
});

test('retention keeps the newest 14 dated folders and never deletes anything else (other folders, the older one-off snapshot)', async () => {
  const root = makeRoot();
  const base = path.join(root, 'recovery-backups/daily');
  fs.mkdirSync(path.join(root, 'recovery-backups/pre-hardening-20261125'), { recursive: true }); fs.writeFileSync(path.join(root, 'recovery-backups/pre-hardening-20261125/keep.txt'), 'x');
  fs.mkdirSync(path.join(base, 'not-a-date-folder'), { recursive: true });
  for (let d = 1; d <= 16; d++) fs.mkdirSync(path.join(base, `2026-10-${String(d).padStart(2, '0')}`), { recursive: true });
  const r = await runBackup({ root, now: T1, minFreeBytes: 0, keep: 14 });
  assert.equal(r.status, 'ok');
  const kept = dated(root);
  assert.equal(kept.length, 14); assert.equal(kept.at(-1), '2026-11-25'); assert.ok(!kept.includes('2026-10-01') && !kept.includes('2026-10-03') && kept.includes('2026-10-04'));
  assert.ok(fs.existsSync(path.join(base, 'not-a-date-folder')), 'foreign folders are untouched');
  assert.ok(fs.existsSync(path.join(root, 'recovery-backups/pre-hardening-20261125/keep.txt')), 'the earlier one-off snapshot is untouched');
});

test('failures never throw and never leave a half-written dated folder: a bad file is counted (partial), a total failure leaves nothing, low disk space skips', async () => {
  const root = makeRoot();
  const flaky = await runBackup({ root, now: T1, minFreeBytes: 0, sqliteBackup: async () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } });
  assert.equal(flaky.status, 'partial'); assert.equal(flaky.errors, 2);
  assert.ok(fs.existsSync(path.join(root, 'recovery-backups/daily/2026-11-25/MANIFEST.json')));
  assert.deepEqual(fs.readdirSync(path.join(root, 'recovery-backups/daily')).filter(n => n.startsWith('.tmp')), []);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-empty-'));
  assert.equal((await runBackup({ root: empty, now: T1, minFreeBytes: 0 })).status, 'failed');
  assert.deepEqual(fs.readdirSync(path.join(empty, 'recovery-backups/daily')).filter(n => n.startsWith('.tmp') || /^\d/.test(n)), []);
  const low = makeRoot();
  assert.equal((await runBackup({ root: low, now: T1, statfs: async () => ({ bavail: 1, bsize: 1 }) })).status, 'skipped_low_space');
  assert.ok(!fs.existsSync(path.join(low, 'recovery-backups/daily/2026-11-25')));
  const never = await runBackup({ root: '/definitely/not/a/path', now: T1, minFreeBytes: 0 });
  assert.equal(never.status, 'failed');
});

test('the scheduler waits until 17:00 ET, runs once per New York date, never overlaps, and swallows errors', async () => {
  const root = makeRoot();
  let clock = Date.parse('2026-11-25T20:00:00Z');            // 15:00 ET
  let calls = 0;
  const daily = createDailyBackup({ root, now: () => clock, run: async o => { calls += 1; return runBackup({ ...o, minFreeBytes: 0 }); } });
  assert.equal((await daily.tick()).status, 'waiting'); assert.equal(calls, 0);
  clock = T1;
  const [a, b] = await Promise.all([daily.tick(), daily.tick()]);
  assert.ok([a.status, b.status].includes('busy') && calls === 1, 'only one run at a time');
  assert.equal((await daily.tick()).status, 'done_today'); assert.equal(calls, 1);
  clock = T2;
  assert.equal((await daily.tick()).status, 'ok'); assert.equal(calls, 2);
  const broken = createDailyBackup({ root, now: () => T1, run: async () => { throw new Error('x'); } });
  assert.equal((await broken.tick()).status, 'failed');
});

test('the plan is bounded by a file cap and skips symlinks', async t => {
  const root = makeRoot();
  const plan = await planBackup(root, { maxFiles: 5 });
  assert.equal(plan.entries.length, 5); assert.equal(plan.truncated, true);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-bk-out-')); fs.writeFileSync(path.join(outside, 'big.txt'), 'x');
  try { fs.symlinkSync(outside, path.join(root, 'iv-history/link'), 'junction'); } catch { t.skip('symlink creation is not permitted here'); return; }
  const full = await planBackup(root);
  assert.ok(!full.entries.some(e => e.rel.includes('link')), 'links are never followed');
});

test('the server wires the backup after the auth middleware and the module has no delete outside its own dated folders', () => {
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const auth = server.indexOf("app.use('/api', authMiddleware)");
  assert.ok(auth > 0 && server.indexOf("app.get('/api/backup-status'") > auth);
  assert.match(server, /DAILY_BACKUP_ENABLED/);
  const source = fs.readFileSync(new URL('../agent/daily-backup.js', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/fsx\.rm\(/g)].length, 3, 'removals are limited to the temp folder (twice) and the dated retention folders');
  assert.doesNotMatch(source, /unlink|rmdir|fetch\(|axios/);
});
