import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { buildSystemPrompt } from '../agent/harness.js';
import { DEFAULT_TRADING_GUIDANCE } from '../agent/trading-guidance.js';
import { renderPrefixedToolMenu, renderToolMenu, TOOL_CATALOG, HERALD_TOOL_CATALOG } from '../agent/tool-catalog.js';
import { MANAGER_ALLOWED_MCP_TOOLS, AGENT_DENIED_MCP_TOOLS, isAgentToolAllowed } from '../manager-safety-policy.js';
import { ChatStore } from '../agent/chat-store.js';

const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
const serverSource = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');

// the REAL handler body from mcp-server.js, run against a fake backend
const caseStart = mcp.indexOf("case 'get_alpaca_news': {");
const caseEnd = mcp.indexOf("case 'get_news_by_topic': {", caseStart);
assert.ok(caseStart >= 0 && caseEnd > caseStart, 'handler located');
const body = mcp.slice(caseStart, caseEnd).replace("case 'get_alpaca_news': {", '').trim().replace(/}\s*$/, '');
function invoke(args, reply) {
  const calls = [];
  const callTradingBot = async (endpoint, method, data, options) => { calls.push({ endpoint, method, data, options }); return reply; };
  return vm.runInNewContext(`(async (args) => {${body}})`, { callTradingBot, URLSearchParams, JSON })(args).then(result => ({ result, calls }));
}

test('the MCP tool is defined with the right schema, and the older tools point at it', () => {
  const start = mcp.indexOf("name: 'get_alpaca_news'");
  assert.ok(start > 0);
  const def = mcp.slice(start, mcp.indexOf("name: 'get_news_by_topic'", start));
  assert.match(def, /FIRST when you research company news/);
  assert.match(def, /Google\/MarketWatch tools stay available/);
  assert.match(def, /created_at is the article time, and updated_at or fetched_at never marks a new event/);
  assert.match(def, /required: \[\]/);
  assert.match(def, /omit it for the newest market-wide headlines/);
  for (const key of ['symbols', 'hours', 'limit', 'page_token']) assert.match(def, new RegExp(`${key}: \\{`));
  assert.match(mcp, /For company news use get_alpaca_news first; keep this for wider discovery and verification/);
});

test('the handler builds the account route, forwards every argument and returns compact JSON', async () => {
  const reply = { provider: 'alpaca', status: 'available', count: 1, has_more: true, next_page_token: 'T', articles: [{ id: 1, source: 'benzinga', created_at: 'a', updated_at: 'b' }] };
  const { result, calls } = await invoke({ symbols: ['AAPL', 'NVDA'], hours: 12, limit: 5, page_token: 'ABC' }, reply);
  assert.equal(calls.length, 1);
  assert.match(calls[0].endpoint, /^\/news\/alpaca\?/);
  const query = new URLSearchParams(calls[0].endpoint.split('?')[1]);
  assert.equal(query.get('symbols'), 'AAPL,NVDA');
  assert.equal(query.get('hours'), '12');
  assert.equal(query.get('limit'), '5');
  assert.equal(query.get('page_token'), 'ABC');
  assert.equal(calls[0].method, 'GET');
  assert.equal(JSON.stringify(calls[0].options), '{"returnAvailability":true}', 'a 503 with a category is passed through, not thrown');
  const text = result.content[0].text;
  assert.ok(!text.includes('\n'));
  assert.deepEqual(JSON.parse(text), reply);
  const minimal = await invoke({ symbols: ['SPY'] }, reply);
  assert.equal(minimal.calls[0].endpoint, '/news/alpaca?symbols=SPY');
  const wide = await invoke({ limit: 50 }, reply);
  assert.equal(wide.calls[0].endpoint, '/news/alpaca?limit=50', 'no symbols means a market-wide read with no empty symbols parameter');
  assert.equal((await invoke({}, reply)).calls[0].endpoint, '/news/alpaca?');
  assert.equal((await invoke({ symbols: [] }, reply)).calls[0].endpoint, '/news/alpaca?');
});

test('an unavailable result is returned as unavailable, never as an empty list', async () => {
  const failure = { status: 'unavailable', category: 'permission', endpoint: 'alpaca_news', http_status: 503 };
  const { result } = await invoke({ symbols: ['AAPL'] }, failure);
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.status, 'unavailable');
  assert.equal(parsed.category, 'permission');
  assert.equal(parsed.articles, undefined);
});

test('the tool is first in every agent menu and the other news tools stay available', () => {
  assert.equal(TOOL_CATALOG.News[0], 'get_alpaca_news');
  assert.equal(HERALD_TOOL_CATALOG.News[0], 'get_alpaca_news');
  for (const menu of [renderPrefixedToolMenu(), renderPrefixedToolMenu({ scope: 'herald' })]) {
    assert.match(menu, /prophet_get_alpaca_news, prophet_get_news, prophet_search_news, prophet_get_market_news/);
  }
  assert.match(renderToolMenu(), /get_alpaca_news, get_news/);
  assert.match(renderToolMenu({ scope: 'herald' }), /get_alpaca_news, get_news/);
  for (const kept of ['get_news', 'search_news', 'get_market_news']) assert.ok(HERALD_TOOL_CATALOG.News.includes(kept), kept);
});

test('the Manager may call it, trading agents are not blocked from it, and no broader access was added', () => {
  assert.ok(MANAGER_ALLOWED_MCP_TOOLS.has('get_alpaca_news'));
  for (const kept of ['get_news', 'search_news', 'get_market_news', 'get_marketwatch_topstories']) assert.ok(MANAGER_ALLOWED_MCP_TOOLS.has(kept), kept);
  assert.ok(!AGENT_DENIED_MCP_TOOLS.has('get_alpaca_news'));
  assert.equal(isAgentToolAllowed('agent', 'get_alpaca_news'), true);
  assert.equal(isAgentToolAllowed('manager', 'get_alpaca_news'), true);
  assert.ok(!MANAGER_ALLOWED_MCP_TOOLS.has('place_options_order'));
});

test('the Manager prompt prefers Alpaca first but keeps the other news tools', () => {
  assert.match(serverSource, /- get_alpaca_news: Company news from Alpaca \(the provider AlphaDesk reads\)\. Use it FIRST when you research company news; the other news tools stay available/);
  assert.match(serverSource, /- search_news, get_market_news, get_quick_market_intelligence: News \(Google and MarketWatch\)/);
});

const agent = (strategyId, extra = {}) => ({ id: 'x', name: 'X', sandboxId: 'sbx_x', systemPromptTemplate: 'custom', strategyId, customSystemPrompt: 'Identity.', ...extra });
const deps = { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: DEFAULT_TRADING_GUIDANCE };

test('every trading-agent family is told Alpaca first, with the others available and no new news rule', async () => {
  for (const strategyId of ['etf-mean-reversion', 'equity-momentum', 'catalyst-news', 'capital-preservation']) {
    const prompt = await buildSystemPrompt(agent(strategyId), deps);
    assert.match(prompt, /when you research news about a company, call prophet_get_alpaca_news first \(it is the news provider AlphaDesk reads\)/, strategyId);
    assert.match(prompt, /stay available for verification, the original announcement, wider discovery, or when Alpaca is empty, unavailable or insufficient; a successful Alpaca result does not stop you checking them/, strategyId);
    assert.match(prompt, /never present another source's evidence as Alpaca's/, strategyId);
    assert.match(prompt, /an updated_at, fetched_at or summary time never starts a new catalyst clock/, strategyId);
    assert.match(prompt, /This adds no new news scan or entry rule to your strategy/, strategyId);
    assert.match(prompt, /prophet_get_alpaca_news, prophet_get_news, prophet_search_news/, `${strategyId} menu`);
  }
});

test('technical agents get no news requirement; Herald discovers with Alpaca first and keeps Google for gaps', async () => {
  for (const strategyId of ['etf-mean-reversion', 'equity-momentum']) {
    const prompt = await buildSystemPrompt(agent(strategyId), deps);
    assert.doesNotMatch(prompt, /Catalyst discovery/, strategyId);
    assert.doesNotMatch(prompt, /call prophet_get_alpaca_news first for your watch-list names/, strategyId);
  }
  const herald = await buildSystemPrompt(agent('catalyst-news', { id: 'catalyst', sandboxId: 'sbx_723be98b' }), deps);
  assert.match(herald, /call prophet_get_alpaca_news first for your watch-list names \(symbols in batches of up to 30, the last 36 hours; follow has_more with page_token/);
  assert.match(herald, /Then use prophet_get_news, prophet_search_news, prophet_get_market_news and the MarketWatch tools for coverage gaps, wider discovery and the original announcement/);
  assert.match(herald, /Say which source each item came from/);
});

test('an Alpaca news outage is a History warning, not a failed activity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'op2-alpaca-news-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-n', 'session-n', { agentName: 'Herald' });
  const file = path.join(root, 'sandboxes', 'acct-n', 'chat-history', 'session-session-n.jsonl');
  const record = { timestamp: new Date(Date.UTC(2026, 10, 6, 14, 0, 0)).toISOString(), activityId: 'a', origin: 'Heartbeat', kind: 'tool_call', tool: 'get_alpaca_news', result: JSON.stringify({ status: 'unavailable', category: 'permission' }), status: 'error', error: '{"error":"Alpaca news is unavailable (permission)"}' };
  await fsp.appendFile(file, JSON.stringify(record) + '\n');
  const activity = (await store.listActivities('acct-n', { limit: 5 })).activities[0];
  assert.match(activity.outcome, /^Recorded \(warning: get_alpaca_news unavailable\)$/);
  assert.equal(activity.labels.includes('Error'), false);
});
