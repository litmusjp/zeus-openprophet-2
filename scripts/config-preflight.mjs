#!/usr/bin/env node
// Usage (run where the data volume is mounted):  node scripts/config-preflight.mjs [--check-write]
// Prints counts and labels only (never a key, path, account id or file fragment) and decides acceptance with the SAME rules as the loader.
// Exit status: 0 = the next start will simply load the primary (and the write check passed when requested);
//              2 = an operator decision is needed (first-run bootstrap on a brand-new volume, or a recovery from the backup would run);
//              1 = the next active start would refuse, state is unknown, or the write check failed.
// Only exit 0 means "start will load"; read the JSON for anything else.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectConfigState } from '../agent/config-preflight.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.OPENPROPHET_CONFIG_PATH || path.join(here, '..', 'data', 'agent-config.json');
try {
  const report = await inspectConfigState({ configPath, secretsPath: process.env.OPENPROPHET_SECRETS_PATH, checkWrite: process.argv.includes('--check-write') });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.exitCode;
} catch {
  console.log(JSON.stringify({ nextStart: 'unknown', exitCode: 1 }));
  process.exitCode = 1;
}
