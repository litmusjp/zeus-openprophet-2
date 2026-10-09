import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildSystemPrompt } from '../agent/harness.js';

const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
const harness = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');

test('shared heartbeat guidance separates current broker orders from application intents and avoids routine delegation', async () => {
  const prompt = await buildSystemPrompt({ name: 'Test', systemPromptTemplate: 'custom', customSystemPrompt: 'test' });
  assert.match(prompt, /prophet_get_orders\(status="active"\)/);
  assert.match(prompt, /prophet_get_orders\(status="planned_for_next_session"\)/);
  assert.match(prompt, /prophet_get_orders\(status="submission_uncertain"\)/);
  assert.match(prompt, /Do not repeatedly fetch all historical orders/);
  assert.match(prompt, /do not spawn native task or subagent workflows to summarize routine order history/i);
  assert.match(prompt, /Your Strategy Rules above/);
  assert.match(prompt, /Never retry .*submission_uncertain.*blindly/);
  assert.match(prompt, /complete broker reconciliation/);
});

test('MCP exposes structured options-chain availability instead of converting market_closed to isError', () => {
  const chainStart = mcp.indexOf("case 'get_options_chain'");
  const chainEnd = mcp.indexOf("case 'wait'", chainStart);
  const chain = mcp.slice(chainStart, chainEnd);
  assert.match(chain, /returnAvailability: true/);
  assert.match(mcp, /status === 503 && error\?\.response\?\.data\?\.category/);
});

test('agent instructions distinguish market closed, provider unavailable, and assessment authorization', () => {
  assert.match(harness, /market_closed.*means wait/);
  assert.match(harness, /provider_unavailable.*means fail closed/);
  assert.match(harness, /Decision is PASS, FAIL or UNAVAILABLE/);
  assert.match(harness, /Assessment PASS is trade-quality evidence only, never account permission or broker authorization/);
  assert.match(harness, /On PASS, attempt .*prophet_place_options_order/);
});

test('agent contract defines the deterministic first-session and managed-leg workflow', () => {
  assert.match(harness, /get_datetime.*account.*positions.*get_orders/s);
  assert.match(harness, /means fail closed/);
  assert.match(harness, /one eligible planned retry/);
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

test('MCP managed-position schema treats trailing stop as a stop-loss modifier', () => {
  const start = mcp.indexOf("name: 'place_managed_position'");
  const end = mcp.indexOf("name: 'get_managed_positions'", start);
  const block = mcp.slice(start, end);
  assert.match(block, /description: 'Enable trailing stop as a modifier on the required stop-loss leg'/);
  assert.match(block, /trailing_percent:[\s\S]*?minimum: 0/);
  assert.match(block, /trailing_percent:[\s\S]*?exclusiveMinimum: 0/);
  assert.doesNotMatch(block, /trailing_percent:[\s\S]*?exclusiveMinimum: true/);
  assert.match(block, /oneOf:[\s\S]*?stop_loss_price/);
  assert.match(block, /allOf:[\s\S]*?trailing_stop/);
});

test('MCP get_orders accepts safe status filters and defaults to all', () => {
  const schemaStart = mcp.indexOf("name: 'get_orders'");
  const schemaEnd = mcp.indexOf("name: 'place_buy_order'", schemaStart);
  const schema = mcp.slice(schemaStart, schemaEnd);
  assert.match(schema, /status/);
  for (const status of ['all', 'active', 'planned_for_next_session']) {
    assert.match(schema, new RegExp(`'${status}'`));
  }
  const handlerStart = mcp.indexOf("case 'get_orders'");
  const handlerEnd = mcp.indexOf("case 'place_buy_order'", handlerStart);
  const handler = mcp.slice(handlerStart, handlerEnd);
  assert.match(handler, /args\??\.status/);
  assert.match(handler, /encodeURIComponent/);
  assert.match(handler, /status \|\| 'all'/);
  assert.match(handler, /`\/orders\?status=\$\{encodeURIComponent\(status\)\}`/);
});

test('options execution contract requires exact broker evidence and same-contract reductions', async () => {
  const prompt = await buildSystemPrompt({ name: 'Test', systemPromptTemplate: 'custom', customSystemPrompt: 'test' });
  assert.match(prompt, /prophet_get_options_positions.*prophet_get_options_position/);
  assert.match(prompt, /prophet_get_options_chain.*exact underlying, expiry and call\/put type/);
  assert.match(prompt, /timestamped bid, ask and sizes/);
  assert.match(prompt, /never invent a premium/);
  assert.match(prompt, /broker-reconciled remaining quantity/);
  assert.match(prompt, /until broker reconciliation confirms zero remaining/);
  assert.match(prompt, /does not require AlphaDesk approval to reduce a long option/);
  assert.match(mcp, /name: 'get_options_positions',[\s\S]{0,280}broker-reconciled open options positions/);
  assert.match(mcp, /name: 'get_options_position',[\s\S]{0,280}broker-reconciled position/);
  assert.match(mcp, /name: 'place_options_order',[\s\S]{0,700}reductions use sell_to_close/);
  const lifecycle = prompt.slice(prompt.indexOf('## Execution Contract'), prompt.indexOf('## Phase Playbook'));
  const registered = new Set([...mcp.matchAll(/name:\s*['\"]([^'\"]+)['\"]/g)].map(([, name]) => `prophet_${name}`));
  for (const match of lifecycle.matchAll(/\bprophet_[a-z0-9_]+\b/g)) assert.ok(registered.has(match[0]), `lifecycle guidance references unregistered tool ${match[0]}`);
});
