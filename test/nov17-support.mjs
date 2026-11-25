// Shared harness for the Nov 17 tests: runs the real mcp-server.js over stdio against a local fake trading backend.
// Not a test file (the npm test glob is test/*.test.mjs), so it is only imported.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_FILE = fileURLToPath(new URL('../mcp-server.js', import.meta.url));
const REPO_ROOT = path.dirname(MCP_FILE);

// The MCP server verifies permissions with the agent server before every tool call; the fake answers that too.
const DEFAULT_ROUTES = { 'GET /api/permissions': () => ({ body: { allowPaperTrading: true, allowOptions: true, allowStocks: true, requireConfirmation: false, maxOrderValue: 100000 } }) };

// A fake trading backend. `routes` maps "GET /orders" style keys (path after /api/v1) to a function(query) -> { status, body }.
export async function startFakeBackend(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, search: url.search });
    const key = `${req.method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    const route = routes[key] || DEFAULT_ROUTES[key];
    if (!route) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}'); return; }
    const { status = 200, body } = route(url.searchParams);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    ordersRequests: () => requests.filter(r => r.path === '/api/v1/orders'),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// Runs one tools/call against the real MCP server and returns { text, isError }.
export async function callMcpTool(backendUrl, name, args, options = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-nov17-mcp-'));
  const child = spawn(process.execPath, [MCP_FILE], {
    cwd,
    env: {
      ...process.env,
      OPENPROPHET_EXECUTION_MODE: 'paper',
      OPENPROPHET_ROLE: 'agent',
      OPENPROPHET_ACCOUNT_ID: 'acct-n17',
      OPENPROPHET_SANDBOX_ID: 'sbx_acct-n17',
      TRADING_BOT_URL: backendUrl,
      AGENT_URL: backendUrl,
      TRADING_BOT_TOKEN: '',
      AGENT_AUTH_TOKEN: 'nov17-test-token',
      GEMINI_API_KEY: 'unused-test-value',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'nov17-test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });
  const deadline = Date.now() + 25000;
  let reply = null;
  while (Date.now() < deadline && !reply) {
    await new Promise(resolve => setTimeout(resolve, 50));
    reply = stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(m => m && m.id === 2) || null;
  }
  const closed = once(child, 'close');
  child.kill();
  await closed;
  if (options.beforeCleanup) await options.beforeCleanup(cwd);
  await fs.rm(cwd, { recursive: true, force: true });
  if (!reply) throw new Error(`no reply to ${name} within 25 s`);
  if (reply.error) throw new Error(`MCP error: ${JSON.stringify(reply.error)}`);
  return { text: reply.result.content[0].text, isError: reply.result.isError === true };
}

// Synthetic get_orders payloads (made-up ids; no real account data). Order field names follow the Go struct.
const row = (over) => ({
  BrokerAccountID: 'broker-n17', PaperLive: 'paper', TenantID: 'acct-n17', SandboxID: 'sbx_acct-n17',
  ID: 'id-0', ClientOrderID: 'cid-0', Symbol: 'BA261218P00170000', Qty: 6, Side: 'buy', Type: 'limit', TimeInForce: 'day',
  LimitPrice: 9, StopPrice: null, Status: 'new', FilledQty: 0, FilledAvgPrice: null, SubmittedAt: '2026-11-16T19:51:15.859Z',
  FilledAt: null, CanceledAt: null, ReplacedBy: '', AssetClass: 'us_option', Underlying: 'BA', PositionIntent: 'buy_to_open',
  Purpose: 'entry', ManagedPositionID: '', ManagedRole: '', NextEligibleAt: null, ExpiresAt: null, Revision: 4, SubmissionAttempted: true,
  metadata: '{"decision":"PASS"}', ...over,
});
export const MIXED_ROWS = [
  row({ ID: 'id-1', ClientOrderID: 'cid-1', Symbol: 'BA261218P00170000' }),
  row({ ID: 'id-2', ClientOrderID: 'cid-2', Symbol: 'BA261218P00175000', Status: 'canceled' }),
  row({ ID: 'id-3', ClientOrderID: 'cid-3', Symbol: 'BA', AssetClass: 'us_equity', Underlying: '', PositionIntent: '', Status: 'filled', FilledQty: 10, Qty: 10 }),
  row({ ID: 'id-4', ClientOrderID: 'cid-4', Symbol: 'XOM261218P00165000', Underlying: 'XOM', Status: 'planned_for_next_session' }),
  // a lower-case-keyed row, as the mapper's second form: exercises the symbol/underlying fallbacks
  { order_id: 'id-5', client_order_id: 'cid-5', symbol: 'ba261218c00180000', underlying: 'ba', status: 'new', asset_class: 'us_option', position_intent: 'buy_to_open' },
];
export const BASELINE_CASES = {
  object: { broker_state: 'available', complete: true, orders: MIXED_ROWS },
  array: MIXED_ROWS,
  empty: { broker_state: 'available', complete: true, orders: [] },
  incomplete: { broker_state: 'available', complete: false, orders: MIXED_ROWS.slice(0, 2) },
  unavailable: { broker_state: 'unavailable', complete: false, orders: [] },
};
export const GOLDEN_DIR = fileURLToPath(new URL('./fixtures/nov17-get-orders-baseline/', import.meta.url));
export { REPO_ROOT };
