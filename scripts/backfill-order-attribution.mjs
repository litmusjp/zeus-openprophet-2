// One-off, bounded recovery import: reads session-*.jsonl (including orphans) read-only and appends typed-actor evidence
// to each account's order-attribution journal. Dry run by default; --apply writes and REQUIRES a verified identity file.
// Never touches chat-history. Run it only while no other process writes the same journal (the write queue is per process).
// Usage: node scripts/backfill-order-attribution.mjs [--apply --identity-file FILE] [--data-dir DIR] --account ID [--account ID ...]
// Identity file (from the verified account inventory, e.g. /api/trades accountStates; no secrets):
//   { "<accountId>": { "brokerAccountId": "...", "paper": true, "sandboxId": "..." } }
import fs from 'node:fs/promises';
import path from 'node:path';
import { OrderAttributionJournal, assertAccountId, backfillOrderAttribution, verifiedIdentity } from '../agent/order-attribution-journal.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const dataDir = opt('--data-dir') || process.env.OPENPROPHET_DATA_DIR || path.join(process.cwd(), 'data');
const wanted = args.flatMap((a, i) => (a === '--account' ? [args[i + 1]] : []));
let identities = {};
if (opt('--identity-file')) {
  try { identities = JSON.parse(await fs.readFile(opt('--identity-file'), 'utf8')); } catch { console.log(JSON.stringify({ error: 'identity_file_unreadable' })); process.exit(1); }
}
const journal = new OrderAttributionJournal(dataDir);
const summary = {};
if (!wanted.length) { console.log(JSON.stringify({ error: 'account_required' })); process.exit(1); }
for (const accountId of wanted) {
  try {
    assertAccountId(accountId); // before any filesystem access
    const identity = verifiedIdentity(identities[accountId]);
    if (apply && !identity) { summary[accountId] = { error: 'identity_required' }; continue; }
    summary[accountId] = await backfillOrderAttribution({ dataDir, accountId, journal, apply, identity });
  } catch (err) { summary[accountId] = { error: String(err?.code || 'backfill_failed').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) }; }
}
console.log(JSON.stringify({ apply, accounts: summary }));
