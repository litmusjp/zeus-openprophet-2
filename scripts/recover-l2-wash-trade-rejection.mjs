#!/usr/bin/env node
// One-off, auditable L2 recovery. Read-only unless --apply is explicit.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

export const TARGET = Object.freeze({ sandboxId: 'sbx_956ff9e4', clientOrderId: 'op-iwm-stock-fallback-20260928', symbol: 'IWM', qty: 10, side: 'buy', type: 'limit', limitPrice: 280, timeInForce: 'day', status: 'submission_uncertain', revision: 3, submissionAttempted: 1 });
export const PAPER_BASE_URL = 'https://paper-api.alpaca.markets';
function arg(argv, name, fallback) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; }
function fail(message) { throw new Error(message); }
function numberEqual(a, b) { return Number.isFinite(Number(a)) && Math.abs(Number(a) - Number(b)) <= 1e-9; }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function parseJson(value) { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }

function rejectionFromError(value) {
  const parsed = parseJson(value);
  const actual = parsed?.diagnostics?.error;
  const expected = `submission_uncertain: broker submission result is unknown: failed to place order with client_order_id ${TARGET.clientOrderId}: potential wash trade detected. use complex orders (HTTP 403, Code 40310000)`;
  return actual === expected;
}

// Only the observed OpenCode part table is evidence. Do not scan arbitrary tables.
export function locateToolEvidence(database) {
  const rows = database.prepare('SELECT id, data FROM part WHERE data LIKE ?').all(`%${TARGET.clientOrderId}%`);
  const matches = rows.filter(row => {
    const part = parseJson(row.data); const input = part?.state?.input;
    return part?.type === 'tool' && part.tool === 'prophet_place_buy_order' && part.state?.status === 'error' && input
      && input.client_order_id === TARGET.clientOrderId && input.symbol === TARGET.symbol
      && numberEqual(input.quantity, TARGET.qty) && input.order_type === TARGET.type
      && numberEqual(input.limit_price, TARGET.limitPrice) && input.strategy === 'mean_reversion'
      && !Object.hasOwn(input, 'side') && !Object.hasOwn(input, 'type') && rejectionFromError(part.state?.error);
  });
  if (matches.length !== 1) fail(`expected exactly one matching structured OpenCode tool part; found ${matches.length}`);
  return matches[0];
}
function column(row, ...names) { for (const name of names) if (Object.hasOwn(row, name)) return row[name]; return undefined; }
function verifyRow(row, accountId, brokerAccountId) {
  if (!row || row.sandbox_id !== TARGET.sandboxId || row.tenant_id !== accountId || row.broker_account_id !== brokerAccountId || row.paper_live !== 'paper' || row.client_order_id !== TARGET.clientOrderId || row.symbol !== TARGET.symbol || !numberEqual(row.qty, TARGET.qty) || row.side !== TARGET.side || row.type !== TARGET.type || row.time_in_force !== TARGET.timeInForce || !numberEqual(row.limit_price, TARGET.limitPrice) || row.status !== TARGET.status || row.revision !== TARGET.revision || row.submission_attempted !== TARGET.submissionAttempted) fail('durable row immutable identity or expected-state check failed');
  if (column(row, 'order_id', 'broker_order_id') || Number(column(row, 'filled_qty', 'filledQty') || 0) !== 0 || column(row, 'filled_avg_price', 'filledAvgPrice') || column(row, 'filled_at', 'filledAt')) fail('durable row contains broker/fill evidence');
}
async function fetchWithTimeout(fetchFn, url, options, timeoutMs = 10000) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs); try { return await fetchFn(url, { ...options, signal: controller.signal }); } catch (error) { fail(`broker preflight failed or timed out: ${error.name === 'AbortError' ? 'timeout' : 'request error'}`); } finally { clearTimeout(timer); } }

export async function brokerReadback(row, account, fetchFn = fetch) {
  if (account.paper !== true || String(account.baseUrl || '').replace(/\/$/, '') !== PAPER_BASE_URL) fail('recovery requires the selected account paper endpoint and paper=true');
  const key = String(account.publicKey || '').trim(); const secret = String(account.secretKey || '').trim(); if (!key || !secret) fail('selected account credentials are required at runtime and were not found');
  const headers = { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret };
  const accountResponse = await fetchWithTimeout(fetchFn, `${PAPER_BASE_URL}/v2/account`, { headers }); if (!accountResponse.ok) fail(`broker account verification failed with HTTP ${accountResponse.status}`);
  const brokerAccount = await accountResponse.json(); if (brokerAccount.id !== account.brokerAccountId || brokerAccount.id !== row.broker_account_id) fail('broker account identity does not match selected account and durable row');
  const lookup = await fetchWithTimeout(fetchFn, `${PAPER_BASE_URL}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(TARGET.clientOrderId)}`, { headers }); const body = parseJson(await lookup.text());
  if (lookup.status !== 404 || !body || body.code !== 40410000) fail('broker client-order lookup did not return typed 40410000');
  return { accountId: brokerAccount.id, lookupStatus: lookup.status, lookupCode: body.code };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const apply = argv.includes('--apply'); const configPath = arg(argv, '--config', process.env.OPENPROPHET_CONFIG_PATH || '/app/data/agent-config.json'); const dbPath = arg(argv, '--db', '/app/data/sandboxes/sbx_956ff9e4/prophet_trader.db'); const opencodeDbPath = arg(argv, '--opencode-db', '/root/.local/share/opencode/opencode.db'); const backupDir = arg(argv, '--backup-dir', '/app/data/recovery-backups');
  const config = readJson(configPath); const sandbox = config.sandboxes?.[TARGET.sandboxId]; if (!sandbox || sandbox.id !== TARGET.sandboxId || !sandbox.accountId) fail('expected L2 sandbox configuration was not found'); const account = (config.accounts || []).find(candidate => candidate.id === sandbox.accountId); if (!account || account.id !== sandbox.accountId || !account.brokerAccountId) fail('selected sandbox account or broker identity was not found');
  const DB = deps.Database || Database; const database = new DB(dbPath, { readonly: !apply, fileMustExist: true });
  try {
    const rows = database.prepare('SELECT * FROM orders WHERE client_order_id = ?').all(TARGET.clientOrderId); if (rows.length !== 1) fail(`expected exactly one durable target row; found ${rows.length}`); const row = rows[0]; verifyRow(row, sandbox.accountId, account.brokerAccountId);
    const evidenceDb = new DB(opencodeDbPath, { readonly: true, fileMustExist: true }); let evidence; try { evidence = locateToolEvidence(evidenceDb); } finally { evidenceDb.close(); }
    const broker = await brokerReadback(row, account, deps.fetchFn || fetch);
    if (!apply) return { mode: 'read-only', clientOrderId: TARGET.clientOrderId, status: row.status, revision: row.revision, evidenceId: evidence.id, broker };
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 }); const backupPath = path.join(backupDir, `${TARGET.clientOrderId}-${Date.now()}.json`); fs.writeFileSync(backupPath, JSON.stringify({ row, evidence }, null, 2), { flag: 'wx', mode: 0o600 });
    const audit = JSON.stringify({ recovery: 'l2-wash-trade-rejection', verifiedAt: new Date().toISOString(), originalRevision: row.revision, priorMetadata: parseJson(row.metadata) ?? row.metadata, broker, evidenceId: evidence.id });
    const tx = database.transaction(() => {
      const fresh = database.prepare('SELECT * FROM orders WHERE id = ?').get(row.id); verifyRow(fresh, sandbox.accountId, account.brokerAccountId);
      for (const key of ['id', 'sandbox_id', 'tenant_id', 'broker_account_id', 'paper_live', 'client_order_id', 'symbol', 'qty', 'side', 'type', 'time_in_force', 'limit_price', 'submission_attempted', 'order_id', 'filled_qty', 'filled_avg_price', 'filled_at']) if (fresh[key] !== row[key]) fail('durable row changed concurrently before guarded recovery update');
      const result = database.prepare("UPDATE orders SET status = 'rejected', revision = revision + 1, metadata = ? WHERE id = ? AND client_order_id = ? AND sandbox_id = ? AND tenant_id = ? AND broker_account_id = ? AND paper_live = 'paper' AND symbol = ? AND qty = ? AND side = ? AND type = ? AND time_in_force = ? AND limit_price = ? AND revision = ? AND status = 'submission_uncertain' AND submission_attempted = 1 AND COALESCE(order_id, '') = '' AND COALESCE(filled_qty, 0) = 0 AND filled_avg_price IS NULL AND filled_at IS NULL").run(audit, fresh.id, TARGET.clientOrderId, TARGET.sandboxId, sandbox.accountId, account.brokerAccountId, TARGET.symbol, TARGET.qty, TARGET.side, TARGET.type, TARGET.timeInForce, TARGET.limitPrice, TARGET.revision);
      if (result.changes !== 1) fail('guarded recovery update did not affect exactly one row');
    }); tx();
    const updated = database.prepare('SELECT status, revision FROM orders WHERE id = ?').get(row.id); if (updated.status !== 'rejected' || updated.revision !== TARGET.revision + 1) fail('post-update readback failed'); return { mode: 'apply', clientOrderId: TARGET.clientOrderId, status: updated.status, revision: updated.revision, backupPath };
  } finally { database.close(); }
}
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (path.resolve(fileURLToPath(import.meta.url)) === invokedPath) Promise.resolve(main()).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(`recovery refused: ${error.message}`); process.exitCode = 1; });
