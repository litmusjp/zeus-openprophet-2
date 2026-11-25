import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Nov 25 hardening H4: aggregate, bounded, cached, read-only size totals. No names, no contents, no deletion, never a throw, unavailable is null.
const { scanDataRoot, createDataUsage, BUCKET_NAMES } = await import('../agent/data-usage.js');

const SENTINEL_DIR = 'zz-sentinel-account-9f3a', SENTINEL_FILE = 'zz-secret-file-name-4c1d.json', SENTINEL_TEXT = 'zz-content-sentinel-77';
function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-usage-'));
  fs.mkdirSync(path.join(root, 'sandboxes', 'acc1', 'chat-history'), { recursive: true });
  fs.writeFileSync(path.join(root, 'sandboxes', 'acc1', 'chat-history', 'a.jsonl'), 'x'.repeat(100));
  fs.writeFileSync(path.join(root, 'sandboxes', 'acc1', 'b.json'), 'y'.repeat(50));
  fs.mkdirSync(path.join(root, 'iv-history'), { recursive: true });
  fs.writeFileSync(path.join(root, 'iv-history', '2026-11.jsonl'), 'z'.repeat(30));
  fs.mkdirSync(path.join(root, SENTINEL_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, SENTINEL_DIR, SENTINEL_FILE), SENTINEL_TEXT.repeat(10));
  fs.writeFileSync(path.join(root, 'agent-config.json'), '{}'.repeat(8));
  return root;
}
const tree = dir => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).map(e => path.join(e.parentPath || e.path, e.name)).sort();

test('buckets: logical bytes and file counts per allow-listed bucket; unknown folders fold into other; top-level files are their own bucket', async () => {
  const root = makeRoot();
  const result = await scanDataRoot(root);
  assert.equal(result.partial, false);
  assert.deepEqual(Object.keys(result.buckets).sort(), [...BUCKET_NAMES].sort());
  assert.deepEqual(result.buckets.sandboxes, { bytes: 150, files: 2 });
  assert.deepEqual(result.buckets.iv_history, { bytes: 30, files: 1 });
  assert.deepEqual(result.buckets.top_level_files, { bytes: 16, files: 1 });
  assert.equal(result.buckets.other.files, 1);
  assert.equal(result.buckets.other.bytes, SENTINEL_TEXT.length * 10);
});

test('the payload never carries a file or folder name, a path, or file contents, and scanning changes nothing on disk', async () => {
  const root = makeRoot();
  const before = tree(root), contents = before.filter(p => fs.statSync(p).isFile()).map(p => fs.readFileSync(p));
  const view = createDataUsage({ root });
  const text = JSON.stringify(await view.get());
  for (const secret of [SENTINEL_DIR, SENTINEL_FILE, SENTINEL_TEXT, 'acc1', 'chat-history', root, 'agent-config']) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(tree(root), before, 'no file created, moved or deleted');
  assert.deepEqual(before.filter(p => fs.statSync(p).isFile()).map(p => fs.readFileSync(p)), contents);
});

test('a missing or unreadable root is unavailable (null buckets), never 0 and never a throw; an empty root is a real zero', async () => {
  const missing = createDataUsage({ root: path.join(os.tmpdir(), 'op2-usage-does-not-exist-' + Date.now()) });
  const unavailable = await missing.get();
  assert.equal(unavailable.status, 'unavailable'); assert.equal(unavailable.buckets, null);
  const throwing = createDataUsage({ root: 'x', scan: async () => { throw new Error('boom'); } });
  assert.equal((await throwing.get()).status, 'unavailable');
  const empty = createDataUsage({ root: fs.mkdtempSync(path.join(os.tmpdir(), 'op2-usage-empty-')) });
  const zero = await empty.get();
  assert.equal(zero.status, 'ok'); assert.equal(zero.buckets.sandboxes.bytes, 0);
});

test('symlinks and junctions are not followed or counted (no escape out of the tree)', async t => {
  const root = makeRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-usage-outside-'));
  fs.writeFileSync(path.join(outside, 'big.bin'), 'q'.repeat(5000));
  try { fs.symlinkSync(outside, path.join(root, 'sandboxes', 'link'), 'junction'); fs.symlinkSync(path.join(outside, 'big.bin'), path.join(root, 'link-file')); }
  catch { t.skip('symlink creation is not permitted here'); return; }
  const result = await scanDataRoot(root);
  assert.equal(result.buckets.sandboxes.bytes, 150);
  assert.equal(result.buckets.top_level_files.bytes, 16);
});

test('bounds: entry count, depth and time end the scan as partial', async () => {
  const root = makeRoot();
  const byEntries = await scanDataRoot(root, { maxEntries: 3 });
  assert.equal(byEntries.partial, true);
  const deep = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-usage-deep-'));
  let dir = deep; for (let i = 0; i < 6; i++) { dir = path.join(dir, 'd' + i); fs.mkdirSync(dir); }
  fs.writeFileSync(path.join(dir, 'f'), 'x');
  assert.equal((await scanDataRoot(deep, { maxDepth: 3 })).partial, true);
  let tick = 0;
  const timed = await scanDataRoot(root, { maxMs: 5, now: () => (tick += 10) });
  assert.equal(timed.partial, true);
  const view = createDataUsage({ root, scanOptions: { maxEntries: 3 } });
  assert.equal((await view.get()).status, 'partial');
});

test('cache and coalescing: concurrent first requests share one scan; within the ttl no second scan; a stale answer is returned at once while ONE refresh runs', async () => {
  let scans = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  let clock = 1000;
  const view = createDataUsage({ root: 'x', ttlMs: 100, now: () => clock, scan: async () => { scans += 1; if (scans === 2) await gate; return { buckets: { sandboxes: { bytes: scans, files: 1 } }, partial: false }; } });
  const [a, b] = await Promise.all([view.get(), view.get()]);
  assert.equal(scans, 1, 'one scan for concurrent first requests');
  assert.equal(a.buckets.sandboxes.bytes, 1); assert.equal(b.buckets.sandboxes.bytes, 1);
  await view.get(); assert.equal(scans, 1, 'cached inside the ttl');
  clock += 500;                                                    // stale: the refresh stalls on the gate
  const stale = await view.get();
  assert.equal(stale.stale, true); assert.equal(stale.buckets.sandboxes.bytes, 1, 'the cached answer returns immediately');
  await view.get(); await view.get();
  assert.equal(scans, 2, 'at most one refresh in flight');
  release(); await new Promise(r => setTimeout(r, 10));
  const fresh = await view.get();
  assert.equal(fresh.buckets.sandboxes.bytes, 2);
});

test('the route sits behind the same auth as every other /api route, and /api/health is untouched', () => {
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const auth = server.indexOf("app.use('/api', authMiddleware)");
  const outer = server.indexOf('app.use(createBasicAuthMiddleware(');
  const route = server.indexOf("app.get('/api/data-usage'");
  assert.ok(outer > 0 && auth > outer && route > auth, 'registered after the outer and inner auth middleware');
  const healthStart = server.indexOf("app.get('/api/health'");
  const healthEnd = server.indexOf('\napp.', healthStart + 10);
  assert.ok(!server.slice(healthStart, healthEnd).includes('data-usage') && !server.slice(healthStart, healthEnd).includes('dataUsage'), 'health does not touch data usage');
});

test('no write, delete, move or network call exists in the module', () => {
  const source = fs.readFileSync(new URL('../agent/data-usage.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\b(writeFile|appendFile|unlink|rm\(|rmdir|rename|mkdir|copyFile|createWriteStream|fetch\(|axios|http\.)/);
  assert.doesNotMatch(source, /readFile\(/, 'contents are never read');
});
