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
