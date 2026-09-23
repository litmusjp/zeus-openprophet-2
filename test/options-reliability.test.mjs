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

test('MCP returns managed market_closed diagnostics before success-only handling', () => {
  const start = mcp.indexOf("case 'place_managed_position'");
  const end = mcp.indexOf("case 'get_managed_positions'", start);
  const handler = mcp.slice(start, end);
  assert.match(handler, /callTradingBot\('\/positions\/managed', 'POST', requestData\)/);
  assert.match(mcp, /diagnostics\?\.category === 'market_closed' && diagnostics\?\.status === 'market_closed'[\s\S]*?structuredContent: diagnostics,[\s\S]*?\n\s*};[\s\S]*?\n\s*}/);
  assert.ok(handler.indexOf('autoStoreSetup(') < handler.indexOf('return orderResponse(data, args)'));
  const marketClosed = mcp.slice(mcp.indexOf("if (diagnostics?.category === 'market_closed'"), mcp.indexOf("return {\n      content: [", mcp.indexOf("if (diagnostics?.category === 'market_closed'")));
  assert.match(marketClosed, /return \{/);
  assert.match(marketClosed, /structuredContent: diagnostics/);
  assert.doesNotMatch(marketClosed, /orderResponse|autoStoreSetup/);
});

test('MCP transport diagnostics retain a sanitized underlying error', () => {
  assert.match(mcp, /const transportError = String\(lastError\?\.code \|\| lastError\?\.message \|\| 'request failed'\)/);
  assert.match(mcp, /error: transportError/);
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
