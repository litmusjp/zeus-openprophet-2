import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { callMcpTool, startFakeBackend } from './nov17-support.mjs';
import { classifyFailures } from '../agent/chat-store.js';
import { HERALD_TOOL_CATALOG, TOOL_CATALOG, renderPrefixedToolMenu } from '../agent/tool-catalog.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

// Nov 20 build, end to end through the real mcp-server.js over stdio against a fake backend: D3 (exact quote), D4 (earnings), D1/D2 (range refusal).
const HELD = 'NVDA261218P00158000';
const withBackend = async (routes, fn) => {
  const backend = await startFakeBackend(routes);
  try { return await fn(backend); } finally { await backend.close(); }
};
const apiCalls = backend => backend.requests.filter(r => r.path.startsWith('/api/v1/'));

const GOOD = { status: 'available', source: 'exact_contract_snapshot', symbol: HELD, bid: 11.61, bid_size: 126, ask: 11.78, ask_size: 56, quote_timestamp: '2026-11-19T15:40:26.105Z', quote_age_seconds: 4.2, market_data_feed: 'indicative', market_data_quality: 'testing_only', note: 'Exact-contract quote of a contract you hold.' };

test('D3 (+): a held contract that the chain does not return is priced by the exact-contract tool through one GET', async () => {
  await withBackend({
    'GET /options/chain/NVDA': () => ({ body: { status: 'available', symbol: 'NVDA', expiration: '2026-12-18', total: 1, filtered: 0, contracts: [], message: 'no usable contracts returned by this request' } }),
    [`GET /options/quote/${HELD}`]: () => ({ body: GOOD }),
  }, async backend => {
    const chain = await callMcpTool(backend.url, 'get_options_chain', { symbol: 'NVDA', expiration: '2026-12-18', type: 'put' });
    assert.equal(JSON.parse(chain.text).filtered, 0);
    const quote = await callMcpTool(backend.url, 'get_options_quote', { symbol: HELD });
    assert.equal(quote.isError, false);
    const parsed = JSON.parse(quote.text);
    assert.equal(parsed.bid, 11.61);
    assert.equal(parsed.market_data_quality, 'testing_only');
    const quoteCalls = apiCalls(backend).filter(r => r.path.includes('/options/quote/'));
    assert.equal(quoteCalls.length, 1);
    assert.equal(quoteCalls[0].method, 'GET');
    assert.equal(quoteCalls[0].path, `/api/v1/options/quote/${HELD}`);
    assert.deepEqual(apiCalls(backend).filter(r => r.method !== 'GET'), [], 'the exact quote path makes no write call');
  });
});

test('D3 (-): a stale-quote refusal keeps its structured answer and carries no price', async () => {
  const refusal = { status: 'unavailable', category: 'quote_stale_or_invalid', endpoint: 'options_quote', error: 'the exact contract quote is stale or invalid, so it is not usable for a price', symbol: HELD };
  await withBackend({ [`GET /options/quote/${HELD}`]: () => ({ status: 503, body: refusal }) }, async backend => {
    const { text } = await callMcpTool(backend.url, 'get_options_quote', { symbol: HELD });
    const parsed = JSON.parse(text);
    assert.equal(parsed.category, 'quote_stale_or_invalid');
    for (const key of ['bid', 'ask', 'mark', 'current_price']) assert.equal(parsed[key], undefined, key);
  });
});

test('D3 (-): a contract that is not held is refused (an error answer, no price)', async () => {
  const refusal = { status: 'not_held', category: 'not_a_held_contract', endpoint: 'options_quote', error: 'this tool quotes only a contract held in this account', symbol: HELD };
  await withBackend({ [`GET /options/quote/${HELD}`]: () => ({ status: 404, body: refusal }) }, async backend => {
    const { text, isError } = await callMcpTool(backend.url, 'get_options_quote', { symbol: HELD });
    assert.equal(isError, true);
    assert.doesNotMatch(text, /"bid"|"ask"/);
  });
});

test('D3: the tool is registered once, read-only and only on the Herald menu', async () => {
  const source = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.equal(source.split("name: 'get_options_quote'").length - 1, 1);
  assert.equal(source.split("case 'get_options_quote':").length - 1, 1);
  const handler = source.slice(source.indexOf("case 'get_options_quote':"), source.indexOf("case 'get_options_chain':"));
  assert.match(handler, /callTradingBot\(`\/options\/quote\//);
  assert.doesNotMatch(handler, /'POST'|'DELETE'|'PUT'|place_|cancel_|\/orders|\/options\/order|assessment/);
  assert.ok(HERALD_TOOL_CATALOG.Options.includes('get_options_quote'));
  assert.ok(!TOOL_CATALOG.Options.includes('get_options_quote'));
  assert.match(renderPrefixedToolMenu({ scope: 'herald' }), /prophet_get_options_quote/);
  assert.doesNotMatch(renderPrefixedToolMenu(), /get_options_quote/);
  const main = await fs.readFile(new URL('../cmd/bot/main.go', import.meta.url), 'utf8');
  assert.equal(main.split('/options/quote/:symbol').length - 1, 1);
  assert.match(main, /api\.GET\("\/options\/quote\/:symbol", orderController\.GetOptionsQuote\)/);
});

test('D3: the Herald guidance names the exact-contract quote once, as a quote and never a mark; no other family mentions it', () => {
  const herald = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'catalyst-news' });
  assert.equal(herald.split('prophet_get_options_quote').length - 1, 1);
  assert.match(herald, /held contracts only, read-only/);
  assert.match(herald, /It is a quote, never a mark, and if it also has no fresh quote the existing no-quote rules apply/);
  assert.match(herald, /If there is no fresh quote, record DATA_BLOCK/); // the default stays
  for (const id of ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation', 'unknown-x']) {
    assert.doesNotMatch(renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id }), /get_options_quote/, id);
  }
});

test('D3 (-): the market-closed chain warning still matches its exact payload and nothing wider', () => {
  const closed = { category: 'market_closed', endpoint: 'options_chain', error: 'options chain is unavailable while the regular market is closed', next_open: '2026-11-20T09:30:00-05:00', status: 'market_closed', http_status: 503 };
  const rec = payload => ({ kind: 'tool_call', tool: 'prophet_get_options_chain', args: { symbol: 'LOW' }, status: 'completed', result: JSON.stringify(payload) });
  assert.deepEqual(classifyFailures([rec(closed)]).warnings, ['get_options_chain unavailable while market closed']);
  // the new empty-answer wording is a successful answer, not a failure or a warning
  const empty = classifyFailures([rec({ status: 'available', total: 0, filtered: 0, contracts: [], message: 'no usable contracts returned by this request' })]);
  assert.equal(empty.essential.length, 0);
  assert.deepEqual(empty.warnings, []);
  assert.equal(classifyFailures([rec({ ...closed, message: 'extra' })]).essential.length, 1);
});

test('D4 end to end: 61 symbols reach the backend as 30 + 30 + 1 and come back merged', async () => {
  const symbols = Array.from({ length: 61 }, (_, i) => `S${String(i + 1).padStart(3, '0')}`);
  await withBackend({
    'GET /market/earnings': params => {
      const batch = params.get('symbols').split(',');
      return { body: { source: 'public-calendar', window_start: '2026-11-20', window_end: '2026-12-11', complete: true, results: batch.map(symbol => ({ symbol, status: 'none_found_in_window' })), note: 'Public calendar data.' } };
    },
  }, async backend => {
    const { text, isError } = await callMcpTool(backend.url, 'get_earnings_dates', { symbols, days: 21 });
    assert.equal(isError, false);
    const parsed = JSON.parse(text);
    assert.equal(parsed.results.length, 61);
    assert.deepEqual(parsed.results.map(r => r.symbol), symbols);
    assert.equal(parsed.complete, true);
    const calls = apiCalls(backend).filter(r => r.path === '/api/v1/market/earnings');
    assert.deepEqual(calls.map(r => new URLSearchParams(r.search).get('symbols').split(',').length), [30, 30, 1]);
    assert.ok(calls.every(r => new URLSearchParams(r.search).get('days') === '21'));
  });
});

test('D4 end to end: a failing batch marks only its own symbols unknown', async () => {
  const symbols = Array.from({ length: 35 }, (_, i) => `T${String(i + 1).padStart(3, '0')}`);
  await withBackend({
    'GET /market/earnings': params => {
      const batch = params.get('symbols').split(',');
      if (batch.length === 5) return { status: 500, body: { error: 'calendar unavailable' } };
      return { body: { source: 'public-calendar', window_start: '2026-11-20', window_end: '2026-12-11', complete: true, results: batch.map(symbol => ({ symbol, status: 'none_found_in_window' })), note: 'x' } };
    },
  }, async backend => {
    const parsed = JSON.parse((await callMcpTool(backend.url, 'get_earnings_dates', { symbols })).text);
    assert.equal(parsed.complete, false);
    assert.equal(parsed.results.filter(r => r.status === 'unknown').length, 5);
    assert.equal(parsed.results.filter(r => r.status === 'none_found_in_window').length, 30);
  });
});

test('D1/D2 end to end: a date outside the calendar coverage returns the structured refusal and the label calls it a warning', async () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  await withBackend({
    'GET /calendar': () => ({ body: { sessions: [{ date: today, open: '09:30', close: '16:00' }] } }),
    'GET /market/bars/DIS': () => { throw new Error('no bar read is expected'); },
  }, async backend => {
    const args = { symbol: 'DIS', window_start: '2020-01-02T15:00:00Z', window_minutes: 15 };
    const { text, isError } = await callMcpTool(backend.url, 'get_range_confirmation', args);
    assert.equal(isError, true);
    const payload = JSON.parse(text);
    assert.equal(payload.status, 'session_not_covered');
    assert.equal(payload.requested_date, '2020-01-02');
    assert.equal(apiCalls(backend).filter(r => r.path.startsWith('/api/v1/market/bars')).length, 0);
    const record = { kind: 'tool_call', tool: 'prophet_get_range_confirmation', args, status: 'error', error: text };
    assert.deepEqual(classifyFailures([record]).warnings, ['get_range_confirmation date outside the calendar coverage']);
    // a malformed timestamp through the same tool stays a plain essential error
    const bad = await callMcpTool(backend.url, 'get_range_confirmation', { ...args, window_start: '2020-01-02T15:00:00' });
    assert.equal(bad.isError, true);
    assert.equal(classifyFailures([{ kind: 'tool_call', tool: 'prophet_get_range_confirmation', args: { ...args, window_start: '2020-01-02T15:00:00' }, status: 'error', error: bad.text }]).essential.length, 1);
  });
});
