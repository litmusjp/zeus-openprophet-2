import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('both real Harness owners provide backend readiness and calendar adapters', () => {
  const server=fs.readFileSync(new URL('../agent/server.js',import.meta.url),'utf8');
  const secondary=fs.readFileSync(new URL('../agent/orchestrator.js',import.meta.url),'utf8');
  assert.match(server,/ensureBackendReadyFn: async sandboxId =>/);
  assert.match(server,/getMarketCalendarFn: async sandboxId =>/);
  assert.match(secondary,/ensureBackendReadyFn: async id =>/);
  assert.match(secondary,/getMarketCalendarFn: async id =>/);
});
