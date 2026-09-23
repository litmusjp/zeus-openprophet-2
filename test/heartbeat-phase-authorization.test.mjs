import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { authorizeAndUpdateHeartbeatPhase } from '../mcp-heartbeat-guard.js';

test('forced heartbeat intervals reject phase mutation without calling the update API', async () => {
  let updated = false;
  const result = await authorizeAndUpdateHeartbeatPhase({
    role: 'operator',
    operatorToken: 'operator-token',
    getHeartbeatIntervalsForced: async () => true,
    update: async () => { updated = true; },
  });

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'heartbeat_intervals_forced', message: 'heartbeat phase updates are locked by the operator' },
  });
  assert.equal(updated, false);
});

test('missing operator capability rejects phase mutation before any agent API call', async () => {
  let checked = false;
  let updated = false;
  const result = await authorizeAndUpdateHeartbeatPhase({
    role: 'agent',
    operatorToken: '',
    getHeartbeatIntervalsForced: async () => { checked = true; return false; },
    update: async () => { updated = true; },
  });

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'operator_authorization_required', message: 'heartbeat phase updates require the operator role' },
  });
  assert.equal(checked, false);
  assert.equal(updated, false);
});

test('operator role without OPERATOR_TOKEN returns structured unavailability before mutation', async () => {
  let checked = false;
  let updated = false;
  const result = await authorizeAndUpdateHeartbeatPhase({
    role: 'operator',
    operatorToken: '',
    getHeartbeatIntervalsForced: async () => { checked = true; return false; },
    update: async () => { updated = true; },
  });

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'operator_authorization_unavailable', message: 'operator authorization is unavailable' },
  });
  assert.equal(checked, false);
  assert.equal(updated, false);
});

test('authorized operator can update an unlocked heartbeat phase', async () => {
  let updated = false;
  const result = await authorizeAndUpdateHeartbeatPhase({
    role: 'operator',
    operatorToken: 'operator-token',
    getHeartbeatIntervalsForced: async () => false,
    update: async () => { updated = true; },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(updated, true);
});

test('MCP passes the agent operator token and the direct phase mutation route is operator-gated', async () => {
  const mcp = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  const server = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');

  assert.match(mcp, /operatorToken:\s*OPERATOR_TOKEN/);
  assert.doesNotMatch(mcp, /operatorToken:\s*TRADING_BOT_OPERATOR_TOKEN/);
  assert.match(server, /app\.get\('\/api\/heartbeat\/phases', \(req, res\) =>/);
  assert.match(server, /app\.put\('\/api\/heartbeat\/phases', operatorAuthMiddleware, async \(req, res\) =>/);
});
