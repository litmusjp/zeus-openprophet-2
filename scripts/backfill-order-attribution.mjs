// One-off, bounded recovery import: reads session-*.jsonl (including orphans) read-only and appends typed-actor evidence
// to each account's order-attribution journal. Dry run by default; pass --apply to write. Never touches chat-history.
// Usage: node scripts/backfill-order-attribution.mjs [--apply] [--data-dir DIR] [--account ID ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrderAttributionJournal, backfillOrderAttribution } from '../agent/order-attribution-journal.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dataDir = opt('--data-dir') || process.env.OPENPROPHET_DATA_DIR || path.join(process.cwd(), 'data');
const wanted = args.flatMap((a, i) => (a === '--account' ? [args[i + 1]] : []));
const accounts = wanted.length ? wanted : (await fs.readdir(path.join(dataDir, 'sandboxes'), { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name);
const journal = new OrderAttributionJournal(dataDir);
const summary = {};
for (const accountId of accounts) {
  try { summary[accountId] = await backfillOrderAttribution({ dataDir, accountId, journal, apply }); }
  catch { summary[accountId] = { error: 'backfill_failed' }; }
}
console.log(JSON.stringify({ apply, accounts: summary }));
