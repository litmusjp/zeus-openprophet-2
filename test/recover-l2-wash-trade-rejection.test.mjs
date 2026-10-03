import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { main, TARGET } from '../scripts/recover-l2-wash-trade-rejection.mjs';

let sqliteUsable = true;
try { const probe = new Database(':memory:'); probe.close(); } catch { sqliteUsable = false; }
const sqliteOptions = { skip: !sqliteUsable, skipReason: 'better-sqlite3 native module requires the supported parent Node environment' };

function fixture({ evidence = true, duplicate = false, tenant = 'acct-1', brokerId = 'broker-1', rowBrokerId = brokerId, paper = 'paper', sandboxId = TARGET.sandboxId, evidenceType = 'tool', evidenceStatus = 'error', evidenceError = null, filled = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-recovery-'));
  const dbPath = path.join(dir, 'orders.db'); const evidencePath = path.join(dir, 'opencode.db'); const configPath = path.join(dir, 'config.json'); const backupDir = path.join(dir, 'backups');
  const db = new Database(dbPath); db.exec(`CREATE TABLE orders (id INTEGER PRIMARY KEY, sandbox_id TEXT, tenant_id TEXT, broker_account_id TEXT, paper_live TEXT, client_order_id TEXT, symbol TEXT, qty REAL, side TEXT, type TEXT, time_in_force TEXT, limit_price REAL, status TEXT, revision INTEGER, submission_attempted INTEGER, order_id TEXT, filled_qty REAL, filled_avg_price REAL, filled_at TEXT, metadata TEXT);`);
  db.prepare(`INSERT INTO orders (id, sandbox_id, tenant_id, broker_account_id, paper_live, client_order_id, symbol, qty, side, type, time_in_force, limit_price, status, revision, submission_attempted, order_id, filled_qty, filled_avg_price, filled_at, metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(1, sandboxId, tenant, rowBrokerId, paper, TARGET.clientOrderId, TARGET.symbol, TARGET.qty, TARGET.side, TARGET.type, TARGET.timeInForce, TARGET.limitPrice, TARGET.status, TARGET.revision, TARGET.submissionAttempted, filled ? 'broker-order' : '', filled ? 1 : 0, filled ? 280 : null, filled ? '2026-09-28T00:00:00Z' : null, 'prior'); db.close();
  const ev = new Database(evidencePath); ev.exec('CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)');
  const data = { type: evidenceType, tool: 'prophet_place_buy_order', state: { status: evidenceStatus, input: { client_order_id: TARGET.clientOrderId, symbol: TARGET.symbol, quantity: 10, order_type: 'limit', limit_price: 280, strategy: 'mean_reversion' }, error: { diagnostics: { error: evidenceError ?? `submission_uncertain: broker submission result is unknown: failed to place order with client_order_id ${TARGET.clientOrderId}: potential wash trade detected. use complex orders (HTTP 403, Code 40310000)` } } } };
  if (evidence) ev.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p1', 'm1', 's1', 1, 1, JSON.stringify(data));
  if (duplicate) ev.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)').run('p2', 'm1', 's1', 1, 1, JSON.stringify({ ...data, state: { ...data.state, error: data.state.error } }));
  ev.close();
  fs.writeFileSync(configPath, JSON.stringify({ sandboxes: { [TARGET.sandboxId]: { id: TARGET.sandboxId, accountId: tenant } }, accounts: [{ id: tenant, brokerAccountId: brokerId, publicKey: 'public', secretKey: 'secret', baseUrl: 'https://paper-api.alpaca.markets', paper: true }] }));
  return { dir, dbPath, evidencePath, configPath, backupDir };
}
function brokerFetch({ timeout = false, accountId = 'broker-1', lookupCode = 40410000 } = {}) {
  return async (_url, options) => { if (timeout) return new Promise((_, reject) => { options.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); }); }); const account = _url.endsWith('/v2/account'); return { ok: account, status: account ? 200 : 404, json: async () => ({ id: accountId }), text: async () => JSON.stringify({ code: lookupCode }) }; };
}
function args(f, apply = false) { return ['--config', f.configPath, '--db', f.dbPath, '--opencode-db', f.evidencePath, '--backup-dir', f.backupDir, ...(apply ? ['--apply'] : [])]; }

class ConcurrentMutationDatabase {
  constructor(...args) { this.db = new Database(...args); this.mutated = false; }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    if (sql === 'SELECT * FROM orders WHERE id = ?' && !this.mutated) return { get: (...values) => { const row = statement.get(...values); this.db.prepare('UPDATE orders SET symbol = ? WHERE id = ?').run('MUTATED', values[0]); this.mutated = true; return row; } };
    return statement;
  }
  transaction(fn) { return this.db.transaction(fn); }
  close() { this.db.close(); }
}

test('recovery dry run performs broker preflight and leaves databases/backups untouched', sqliteOptions, async () => { const f = fixture(); const result = await main(args(f), { Database, fetchFn: brokerFetch() }); assert.equal(result.mode, 'read-only'); assert.equal(fs.existsSync(f.backupDir), false); const db = new Database(f.dbPath, { readonly: true }); assert.equal(db.prepare('SELECT status, revision FROM orders').get().status, TARGET.status); db.close(); });
test('recovery apply updates one row, writes an auditable backup, and preserves evidence', sqliteOptions, async () => { const f = fixture(); const result = await main(args(f, true), { Database, fetchFn: brokerFetch() }); assert.equal(result.status, 'rejected'); assert.equal(result.revision, 4); const db = new Database(f.dbPath, { readonly: true }); assert.deepEqual(db.prepare('SELECT status, revision FROM orders').get(), { status: 'rejected', revision: 4 }); assert.deepEqual(JSON.parse(db.prepare('SELECT metadata FROM orders').get().metadata).priorMetadata, 'prior'); db.close(); if (process.platform !== 'win32') assert.equal(fs.statSync(result.backupPath).mode & 0o777, 0o600); else assert.equal(fs.existsSync(result.backupPath), true); });
for (const [name, options] of [['no evidence', { evidence: false }], ['multiple evidence', { duplicate: true }], ['mismatched account', { rowBrokerId: 'broker-other' }], ['broker 200', {}]]) test(`recovery refuses ${name} without mutation`, sqliteOptions, async () => { const f = fixture(options); const before = new Database(f.dbPath, { readonly: true }).prepare('SELECT status, revision FROM orders').get(); if (name === 'broker 200') await assert.rejects(main(args(f, true), { Database, fetchFn: brokerFetch({ lookupCode: 200 }) })); else await assert.rejects(main(args(f), { Database, fetchFn: brokerFetch() })); const after = new Database(f.dbPath, { readonly: true }).prepare('SELECT status, revision FROM orders').get(); assert.deepEqual(after, before); assert.equal(fs.existsSync(f.backupDir), false); });
test('recovery refuses broker timeout without mutation', sqliteOptions, async () => { const f = fixture(); await assert.rejects(main(args(f, true), { Database, fetchFn: brokerFetch({ timeout: true }) })); const db = new Database(f.dbPath, { readonly: true }); assert.equal(db.prepare('SELECT status FROM orders').get().status, TARGET.status); db.close(); assert.equal(fs.existsSync(f.backupDir), false); });
for (const [name, options] of [
  ['fake assistant/error text', { evidenceType: 'assistant', evidenceError: `submission_uncertain: broker submission result is unknown: failed to place order with client_order_id ${TARGET.clientOrderId}: potential wash trade detected. use complex orders (HTTP 403, Code 40310000)` }],
  ['nonerror tool state', { evidenceStatus: 'completed' }],
  ['row broker mismatch', { rowBrokerId: 'different-broker' }],
  ['broker fill evidence', { filled: true }],
  ['wrong sandbox', { sandboxId: 'sbx_other' }],
]) test(`recovery refuses ${name}`, sqliteOptions, async () => { const f = fixture(options); await assert.rejects(main(args(f), { Database, fetchFn: brokerFetch() })); assert.equal(fs.existsSync(f.backupDir), false); });
test('recovery refuses a concurrent immutable-row mutation inside the guarded transaction', sqliteOptions, async () => { const f = fixture(); await assert.rejects(main(args(f, true), { Database: ConcurrentMutationDatabase, fetchFn: brokerFetch() })); const db = new Database(f.dbPath, { readonly: true }); assert.equal(db.prepare('SELECT status FROM orders').get().status, TARGET.status); db.close(); assert.equal(fs.existsSync(f.backupDir), true); });
