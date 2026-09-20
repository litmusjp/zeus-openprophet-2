import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const read = (file) => fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('server-owned API auth token is propagated to both harness environments', async () => {
  const server = await read('agent/server.js');
  const orchestrator = await read('agent/orchestrator.js');
  assert.match(server, /AGENT_AUTH_TOKEN:\s*AUTH_TOKEN/);
  assert.match(orchestrator, /resolveApiAuthToken\(/);
  assert.match(orchestrator, /AGENT_AUTH_TOKEN:\s*agentAuthToken/);
});

test('MCP uses the server token fallback and remains fail-closed without credentials', async () => {
  const mcp = await read('mcp-server.js');
  assert.match(mcp, /process\.env\.AGENT_AUTH_TOKEN\s*\|\|\s*process\.env\.TRADING_BOT_TOKEN\s*\|\|\s*''/);
  assert.match(mcp, /authToken:\s*AGENT_AUTH_TOKEN/);
  const guard = await read('mcp-permission-guard.js');
  assert.match(guard, /if \(!authToken\)/);
});
