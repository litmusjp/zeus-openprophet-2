import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
const harness = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');

test('MCP exposes structured options-chain availability instead of converting market_closed to isError', () => {
  const chainStart = mcp.indexOf("case 'get_options_chain'");
  const chainEnd = mcp.indexOf("case 'wait'", chainStart);
  const chain = mcp.slice(chainStart, chainEnd);
  assert.match(chain, /returnAvailability: true/);
  assert.match(mcp, /status === 503 && error\?\.response\?\.data\?\.category/);
});

test('agent instructions distinguish market closed, provider unavailable, and assessment authorization', () => {
  assert.match(harness, /market_closed.*means wait/);
  assert.match(harness, /provider_unavailable.*means do not trade/);
  assert.match(harness, /always one of PASS, FAIL, or UNAVAILABLE/);
  assert.match(harness, /PASS is never broker authorization/);
});

test('agent contract defines the deterministic first-session and managed-leg workflow', () => {
  assert.match(harness, /get_datetime.*account.*positions.*get_orders/s);
  assert.match(harness, /unavailable means fail closed/);
  assert.match(harness, /retry at most once/);
  assert.match(harness, /Never retry .*submission_uncertain.*blindly/);
  assert.match(harness, /risk_blocked.*rejected_before_submission.*broker attempts/s);
  assert.match(harness, /exactly one executable leg/);
  assert.match(harness, /do not send stop loss and take profit concurrently/);
  assert.match(harness, /cancel_order.*retry.*cleanup tool/);
});

test('MCP managed-position contract documents exactly one protection leg', () => {
  const start = mcp.indexOf("name: 'place_managed_position'");
  const end = mcp.indexOf("name: 'get_managed_positions'", start);
  const block = mcp.slice(start, end);
  assert.match(block, /exactly one executable protection leg/);
  assert.match(block, /oneOf/);
  assert.match(mcp, /market_closed/);
  assert.match(mcp, /planned_for_next_session/);
});
