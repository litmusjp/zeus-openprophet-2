#!/usr/bin/env node
// Usage (run where the data volume is mounted):  node scripts/config-preflight.mjs [--check-write]
// Prints counts and labels only (never a key, path or account id). Reads OPENPROPHET_CONFIG_PATH / OPENPROPHET_SECRETS_PATH or the default data folder.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectConfigState } from '../agent/config-preflight.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const configPath = process.env.OPENPROPHET_CONFIG_PATH || path.join(here, '..', 'data', 'agent-config.json');
const report = await inspectConfigState({ configPath, secretsPath: process.env.OPENPROPHET_SECRETS_PATH, checkWrite: process.argv.includes('--check-write') });
console.log(JSON.stringify(report, null, 2));
