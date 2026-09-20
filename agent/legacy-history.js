// Read-only compatibility projection for pre-durable-identity order history.
// This module is intentionally separate from execution/reconciliation storage.
import path from 'path';
import { readFileSync, realpathSync, statSync } from 'fs';
import Database from 'better-sqlite3';

function safeSegment(value) {
  if (typeof value !== 'string' || value.length === 0 || value === '.' || value === '..') return null;
  if (/\p{Cc}/u.test(value) || value.includes(':') || /[. ]$/.test(value)) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null;
  const deviceName = value.split('.')[0].toUpperCase();
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(deviceName)) return null;
  return value;
}

function columnMap(db) {
  return new Set(db.prepare('PRAGMA table_info(orders)').all().map(column => column.name));
}

function selectColumn(columns, name, alias, fallback = 'NULL') {
  return columns.has(name) ? `${name} AS ${alias}` : `${fallback} AS ${alias}`;
}

function readOrders(db) {
  const columns = columnMap(db);
  if (!columns.size) return [];
  const sql = `SELECT
    ${selectColumn(columns, 'order_id', 'ID')},
    ${selectColumn(columns, 'client_order_id', 'ClientOrderID')},
    ${selectColumn(columns, 'symbol', 'Symbol')},
    ${selectColumn(columns, 'qty', 'Qty')},
    ${selectColumn(columns, 'side', 'Side')},
    ${selectColumn(columns, 'type', 'Type')},
    ${selectColumn(columns, 'status', 'Status')},
    ${selectColumn(columns, 'filled_qty', 'FilledQty')},
    ${selectColumn(columns, 'filled_avg_price', 'FilledAvgPrice')},
    ${selectColumn(columns, 'submitted_at', 'SubmittedAt')},
    ${selectColumn(columns, 'filled_at', 'FilledAt')}
    FROM orders ORDER BY SubmittedAt ASC`;
  return db.prepare(sql).all();
}

function readFile(filePath, source) {
  let db;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
    return labelLegacyRows(readOrders(db), source);
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch {}
  }
}

function isPathUnderRoot(candidatePath, rootPath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeDatabasePath(databasePath, allowedRoot) {
  try {
    const resolvedRoot = realpathSync(allowedRoot);
    const resolvedDatabase = realpathSync(databasePath);
    if (!statSync(resolvedDatabase).isFile()) return null;
    return isPathUnderRoot(resolvedDatabase, resolvedRoot) ? resolvedDatabase : null;
  } catch {
    return null;
  }
}

export function legacyQuarantineProvenanceMatches(databasePath, sandbox) {
  try {
    const manifest = JSON.parse(readFileSync(path.join(path.dirname(databasePath), 'QUARANTINED.json'), 'utf8'));
    const provenance = manifest?.provenance;
    return manifest?.nonActionable === true && provenance?.requestedSandboxId === sandbox?.id
      && provenance?.legacyAccountId === sandbox?.accountId;
  } catch {
    return false;
  }
}

export function labelLegacyRows(rows, source = 'quarantined-legacy-db') {
  return rows.map(order => ({
    ...order,
    historySource: 'legacy',
    verification: 'unverified',
    legacy: true,
    broker_identity_verified: false,
    identityVerified: false,
    legacySource: source,
    evidence: 'legacy_unverified',
  }));
}

export function legacyHistoryCandidatePaths(projectRoot, sandbox) {
  const sandboxId = safeSegment(sandbox?.id);
  if (!sandboxId) return [];
  return [
    [path.join(projectRoot, 'data', 'quarantine', 'legacy', sandboxId, 'prophet_trader.db'), 'quarantined-legacy-db'],
  ];
}

export function readLegacyHistoryForSandboxAt(projectRoot, sandbox) {
  const roots = legacyHistoryCandidatePaths(projectRoot, sandbox);
  // Quarantine is the only display source; missing or invalid quarantine data is empty.
  const allowedRoot = path.join(projectRoot, 'data', 'quarantine', 'legacy');
  const candidate = roots
    .map(([dbPath, source]) => [safeDatabasePath(dbPath, allowedRoot), dbPath, source])
    .filter(([safePath, dbPath]) => safePath && legacyQuarantineProvenanceMatches(dbPath, sandbox))
    .find(([safePath]) => safePath);
  return candidate ? readFile(candidate[0], candidate[2]) : [];
}

export function readLegacyHistoryForSandbox(projectRoot, sandbox) {
  return readLegacyHistoryForSandboxAt(projectRoot, sandbox);
}

export default { readLegacyHistoryForSandboxAt };
