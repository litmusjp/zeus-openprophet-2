import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { ChatStore } from '../agent/chat-store.js';
import { BASELINE_CASES, GOLDEN_DIR, MIXED_ROWS, callMcpTool, startFakeBackend } from './nov17-support.mjs';

// ───────────────────────── Fix A: get_orders symbol filter (real mcp-server.js over stdio, fake backend) ─────────────────────────

async function withBackend(routes, fn) {
  const backend = await startFakeBackend(routes);
  try { return await fn(backend); } finally { await backend.close(); }
}
const ordersRoute = payload => ({ 'GET /orders': () => ({ body: payload }) });
// A Windows checkout may turn the golden file's LF into CRLF (git text=auto); the tool output itself is always LF, so only that is undone.
const readGolden = async file => (await fs.readFile(new URL(file, pathToFileURL(GOLDEN_DIR)), 'utf8')).replace(/\r\n/g, '\n');
const ids = parsed => (Array.isArray(parsed) ? parsed : parsed.orders).map(o => o.order_id);

test('get_orders without a symbol is byte-identical to the live build for every envelope shape', async () => {
  for (const [name, payload] of Object.entries(BASELINE_CASES)) {
    const golden = await readGolden(`${name}.txt`);
    await withBackend(ordersRoute(payload), async backend => {
      const { text, isError } = await callMcpTool(backend.url, 'get_orders', {});
      assert.equal(isError, false, name);
      assert.equal(text, golden, `no-symbol output changed for ${name}`);
      assert.equal(backend.ordersRequests().length, 1, name);
      assert.equal(backend.ordersRequests()[0].search, '?status=all', `${name}: the backend call must be unchanged`);
    });
  }
});

test('get_orders: symbol null behaves exactly like no symbol', async () => {
  const golden = await readGolden('object.txt');
  await withBackend(ordersRoute(BASELINE_CASES.object), async backend => {
    const { text } = await callMcpTool(backend.url, 'get_orders', { symbol: null });
    assert.equal(text, golden);
  });
});

test('get_orders: an exact OCC symbol returns only that contract and keeps the envelope', async () => {
  await withBackend(ordersRoute(BASELINE_CASES.object), async backend => {
    const { text, isError } = await callMcpTool(backend.url, 'get_orders', { status: 'active', symbol: 'BA261218P00170000' });
    assert.equal(isError, false);
    const parsed = JSON.parse(text);
    assert.deepEqual(ids(parsed), ['id-1']);
    assert.equal(parsed.symbol_filter, 'BA261218P00170000');
    assert.equal(parsed.broker_state, 'available');
    assert.equal(parsed.complete, true);
    assert.equal(backend.ordersRequests()[0].search, '?status=active', 'the status still goes to the backend; the symbol never does');
    assert.doesNotMatch(JSON.stringify(backend.requests), /BA261218P00170000/);
  });
});

test('get_orders: a ticker matches the stock order and every option on that underlying, lower case or not', async () => {
  await withBackend(ordersRoute(BASELINE_CASES.object), async backend => {
    const upper = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'BA' })).text);
    assert.deepEqual(ids(upper).sort(), ['id-1', 'id-2', 'id-3', 'id-5']);
    const lower = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'ba' })).text);
    assert.deepEqual(ids(lower).sort(), ['id-1', 'id-2', 'id-3', 'id-5']);
    const occLower = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: ' ba261218p00170000 ' })).text);
    assert.deepEqual(ids(occLower), ['id-1']);
    const planned = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'XOM261218P00165000' })).text);
    assert.deepEqual(ids(planned), ['id-4'], 'a planned intent row matches by its exact symbol');
  });
});

test('get_orders: the array form is filtered as an array; incomplete and unavailable envelopes keep their flags', async () => {
  await withBackend(ordersRoute(BASELINE_CASES.array), async backend => {
    const parsed = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'BA261218P00175000' })).text);
    assert.ok(Array.isArray(parsed));
    assert.deepEqual(ids(parsed), ['id-2']);
  });
  await withBackend(ordersRoute(BASELINE_CASES.incomplete), async backend => {
    const parsed = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'ZZZZ' })).text);
    assert.deepEqual(parsed.orders, [], 'a filtered empty list');
    assert.equal(parsed.complete, false, 'completeness metadata is preserved: an empty filtered list is not proof of a complete history');
    assert.equal(parsed.symbol_filter, 'ZZZZ');
  });
  await withBackend(ordersRoute(BASELINE_CASES.unavailable), async backend => {
    const parsed = JSON.parse((await callMcpTool(backend.url, 'get_orders', { symbol: 'BA' })).text);
    assert.equal(parsed.broker_state, 'unavailable');
    assert.equal(parsed.complete, false);
  });
});

test('get_orders: a bad symbol is refused locally before any backend call', async () => {
  for (const symbol of [5, '', '   ', 'BA; DROP', 'a'.repeat(30), { x: 1 }]) {
    await withBackend(ordersRoute(BASELINE_CASES.object), async backend => {
      const { text, isError } = await callMcpTool(backend.url, 'get_orders', { symbol });
      assert.equal(isError, true, `symbol ${JSON.stringify(symbol)} must be refused`);
      assert.match(text, /symbol must be an OCC option symbol or a ticker/);
      assert.equal(backend.ordersRequests().length, 0, `symbol ${JSON.stringify(symbol)} must not reach the backend`);
    });
  }
});

test('get_orders: a filtered answer is not size-bounded; nothing is truncated or capped', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ ...MIXED_ROWS[0], ID: `big-${i}`, ClientOrderID: `big-cid-${i}`, metadata: 'm'.repeat(2048) }));
  await withBackend(ordersRoute({ broker_state: 'available', complete: true, orders: many }), async backend => {
    const { text } = await callMcpTool(backend.url, 'get_orders', { symbol: 'BA261218P00170000' });
    assert.ok(text.length > 80000, `expected a large answer, got ${text.length} bytes`);
    assert.equal(JSON.parse(text).orders.length, 40);
  });
});

// ───────────────────────── Fix B: beat outcome and labels (public ChatStore list and detail) ─────────────────────────

const ACCOUNT = 'acct-n17';
async function activityFor(records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-nov17-'));
  try {
    const store = new ChatStore(root);
    await store.startSession(ACCOUNT, 'session-n17', { agentName: 'Herald' });
    const file = path.join(root, 'sandboxes', ACCOUNT, 'chat-history', 'session-session-n17.jsonl');
    const lines = records.map((record, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 16, 19, 51, i)).toISOString(), activityId: 'act-n17', origin: 'Heartbeat', ...record }));
    await fs.appendFile(file, lines.join('\n') + '\n');
    const list = (await store.listActivities(ACCOUNT, { limit: 5 })).activities[0];
    const detail = await store.getActivity(ACCOUNT, 'act-n17');
    return { list, detail };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
// Both public paths must agree on the outcome and on the Error label.
async function expectOutcome(name, records, outcome, errorLabel) {
  const { list, detail } = await activityFor(records);
  assert.equal(list.outcome, outcome, `${name}: list outcome`);
  assert.equal(detail.outcome, outcome, `${name}: detail outcome`);
  assert.equal(list.labels.includes('Error'), errorLabel, `${name}: list Error label`);
  assert.equal(detail.labels.includes('Error'), errorLabel, `${name}: detail Error label`);
}

const SYM = 'BA261218P00170000';
const OPENING_WARNING = 'Recorded (warning: get_options_position not found while opening order unfilled)';
const CLOSURE_WARNING = 'Recorded (warning: get_options_position not found after confirmed close)';
const CHAIN_WARNING = 'Recorded (warning: get_options_chain unavailable while market closed)';
const ack = (resultOver = {}, argsOver = {}) => ({ kind: 'tool_call', tool: 'place_options_order', args: { symbol: SYM, position_intent: 'buy_to_open', client_order_id: 'cid-n17-1', ...argsOver }, status: 'completed',
  result: JSON.stringify({ order_id: 'oid-n17-1', client_order_id: 'cid-n17-1', status: 'pending_new', symbol: SYM, filled_qty: 0, execution_confirmed: false, ...resultOver }) });
const notFound = (symbol = SYM) => ({ kind: 'tool_call', tool: 'get_options_position', args: { symbol }, status: 'error', error: 'Single options-position lookup: no open position found; options position not found: ' + symbol + ' status 404' });
const order = (over = {}) => ({ ID: 'oid-n17-1', order_id: 'oid-n17-1', ClientOrderID: 'cid-n17-1', client_order_id: 'cid-n17-1', Symbol: SYM, symbol: SYM, PositionIntent: 'buy_to_open', position_intent: 'buy_to_open', Status: 'new', status: 'new', FilledQty: 0, filled_qty: 0, ...over });
const read = (orders, envelope = {}, tool = 'get_orders') => ({ kind: 'tool_call', tool, args: { status: 'active' }, status: 'completed', result: JSON.stringify({ broker_state: 'available', complete: true, orders, ...envelope }) });
const positions = rows => ({ kind: 'tool_call', tool: 'get_options_positions', status: 'completed', result: typeof rows === 'string' ? rows : JSON.stringify(rows) });
const failed = (tool, message = 'failed') => ({ kind: 'tool_call', tool, args: {}, status: 'error', error: JSON.stringify({ error: message }) });
const chain = payload => ({ kind: 'tool_call', tool: 'get_options_chain', args: { symbol: 'LOW' }, status: 'completed', result: JSON.stringify(payload) });
const MARKET_CLOSED = { category: 'market_closed', endpoint: 'options_chain', error: 'options chain is unavailable while the regular market is closed', next_open: '2026-11-16T09:30:00-05:00', status: 'market_closed', http_status: 503 };
const truncated = { kind: 'tool_call', tool: 'get_orders', args: { status: 'all' }, status: 'completed', result: JSON.stringify({ broker_state: 'available', complete: true, orders: [order()] }).slice(0, 120) + '\n\n...116934 bytes truncated...\n\nThe tool call succeeded but the output was truncated.' };

test('unfilled-opening 404: affirmative same-order zero-fill reconciliation becomes the exact warning', async () => {
  await expectOutcome('real Herald shape', [ack(), notFound(), read([order()])], OPENING_WARNING, false);
  // an acknowledgement whose status is 'accepted' is also a recorded order status, which the outcome keeps showing
  await expectOutcome('accepted status', [ack({ status: 'accepted' }), notFound(), read([order({ Status: 'accepted', status: 'accepted' })])], 'Recorded: accepted (warning: get_options_position not found while opening order unfilled)', false);
  await expectOutcome('positions list read after', [ack(), notFound(), read([order()]), positions([])], OPENING_WARNING, false);
});

test('unfilled-opening 404: anything short of affirmative same-order evidence stays Failed with the Error label', async () => {
  const cases = {
    'no later get_orders': [ack(), notFound()],
    'get_orders only before the 404': [ack(), read([order()]), notFound()],
    'truncated get_orders': [ack(), notFound(), truncated],
    'complete false': [ack(), notFound(), read([order()], { complete: false })],
    'broker unavailable': [ack(), notFound(), read([order()], { broker_state: 'unavailable' })],
    'complete missing': [ack(), notFound(), { ...read([order()]), result: JSON.stringify({ broker_state: 'available', orders: [order()] }) }],
    'different id of the same symbol': [ack(), notFound(), read([order({ ID: 'oid-other', order_id: 'oid-other' })])],
    'same id, different client id': [ack(), notFound(), read([order({ ClientOrderID: 'cid-other', client_order_id: 'cid-other' })])],
    'same id, different symbol': [ack(), notFound(), read([order({ Symbol: 'BA261218P00175000', symbol: 'BA261218P00175000' })])],
    'same id, closing intent': [ack(), notFound(), read([order({ PositionIntent: 'sell_to_close', position_intent: 'sell_to_close' })])],
    'two orders with the id': [ack(), notFound(), read([order(), order()])],
    'ack filled_qty null': [ack({ filled_qty: null }), notFound(), read([order()])],
    'ack filled_qty blank': [ack({ filled_qty: '' }), notFound(), read([order()])],
    'ack filled_qty missing': [ack({ filled_qty: undefined }), notFound(), read([order()])],
    'ack filled_qty negative': [ack({ filled_qty: -1 }), notFound(), read([order()])],
    'ack filled_qty a string': [ack({ filled_qty: '0' }), notFound(), read([order()])],
    'ack filled_qty one': [ack({ filled_qty: 1 }), notFound(), read([order()])],
    'ack without order id': [ack({ order_id: undefined }), notFound(), read([order()])],
    'ack without client id': [ack({ client_order_id: undefined }), notFound(), read([order()])],
    'ack intent sell_to_close': [ack({}, { position_intent: 'sell_to_close' }), notFound(), read([order()])],
    'reconciled order partially filled': [ack(), notFound(), read([order({ Status: 'partially_filled', status: 'partially_filled', FilledQty: 2, filled_qty: 2 })])],
    'reconciled order filled': [ack(), notFound(), read([order({ Status: 'filled', status: 'filled', FilledQty: 6, filled_qty: 6 })])],
    'reconciled quantity null': [ack(), notFound(), read([order({ FilledQty: null, filled_qty: null })])],
    'reconciled quantity missing': [ack(), notFound(), read([order({ FilledQty: undefined, filled_qty: undefined })])],
    'reconciled quantity negative': [ack(), notFound(), read([order({ FilledQty: -1, filled_qty: -1 })])],
    'reconciled status canceled': [ack(), notFound(), read([order({ Status: 'canceled', status: 'canceled' })])],
    'a second read contradicts with a fill': [ack(), notFound(), read([order()]), read([order({ Status: 'filled', status: 'filled', FilledQty: 6, filled_qty: 6 })])],
    'the position list contains the contract': [ack(), notFound(), read([order()]), positions([{ Symbol: SYM, Qty: 6 }])],
    'the position list is unreadable': [ack(), notFound(), read([order()]), positions('not json')],
    'the position read failed': [ack(), notFound(), read([order()]), failed('get_options_positions', 'broker unavailable')],
    'two acknowledgements for the contract': [ack(), ack({ order_id: 'oid-n17-2', client_order_id: 'cid-n17-2' }, { client_order_id: 'cid-n17-2' }), notFound(), read([order()])],
    'the 404 comes before the order': [notFound(), ack(), read([order()])],
    'the order call itself failed': [{ ...ack(), status: 'error', error: '{"error":"boom"}' }, notFound(), read([order()])],
  };
  for (const [name, records] of Object.entries(cases)) await expectOutcome(name, records, 'Failed', true);
  // a recorded status is shown next to the failure, never instead of it
  await expectOutcome('ack status filled', [ack({ status: 'filled' }), notFound(), read([order()])], 'Failed (recorded: filled)', true);
});

test('closure 404: only a closing fill reconciles; an opening fill is never a confirmed close', async () => {
  const filled = (over = {}) => read([order({ Status: 'filled', status: 'filled', FilledQty: 6, filled_qty: 6, ...over })], {}, 'get_orders');
  await expectOutcome('sell_to_close fill', [positions([]), filled({ PositionIntent: 'sell_to_close', position_intent: 'sell_to_close' }), notFound()], CLOSURE_WARNING, false);
  await expectOutcome('buy_to_close fill', [positions([]), filled({ PositionIntent: 'buy_to_close', position_intent: 'buy_to_close' }), notFound()], CLOSURE_WARNING, false);
  await expectOutcome('filled opening', [positions([]), filled(), notFound()], 'Failed', true);
  await expectOutcome('filled order without an intent', [positions([]), filled({ PositionIntent: undefined, position_intent: undefined }), notFound()], 'Failed', true);
  await expectOutcome('truncated order history (the Guardian shape)', [positions([]), truncated, notFound()], 'Failed', true);
});

test('market-closed chain: only an exact structured market_closed answer is a warning', async () => {
  await expectOutcome('market_closed 503', [chain(MARKET_CLOSED)], CHAIN_WARNING, false);
  await expectOutcome('upstream_http', [chain({ ...MARKET_CLOSED, category: 'upstream_http', status: 'error', error: 'bad gateway' })], 'Failed', true);
  await expectOutcome('authentication', [chain({ category: 'authentication', error: 'unauthorized', status: 'error', http_status: 401 })], 'Failed', true);
  await expectOutcome('transport', [chain({ category: 'transport', error: 'connect ECONNREFUSED', status: 'error' })], 'Failed', true);
  await expectOutcome('prose only', [chain({ error: 'the market_closed condition prevented the chain', status: 'error' })], 'Failed', true);
  await expectOutcome('marked isError', [chain({ ...MARKET_CLOSED, isError: true })], 'Failed', true);
  await expectOutcome('another tool answering market_closed', [{ kind: 'tool_call', tool: 'get_options_positions', status: 'completed', result: JSON.stringify(MARKET_CLOSED) }], 'Failed', true);
});

test('essential failures are never hidden by a warning, a recorded status or a recovery marker', async () => {
  const accepted = { kind: 'tool_call', tool: 'place_options_order', args: { symbol: SYM, position_intent: 'buy_to_open' }, status: 'completed', result: '{"status":"accepted"}' };
  await expectOutcome('opening warning + failed cancel', [ack(), notFound(), read([order()]), failed('cancel_order')], 'Failed', true);
  await expectOutcome('opening warning + failed get_account', [ack(), notFound(), read([order()]), failed('get_account')], 'Failed', true);
  await expectOutcome('chain warning + accepted order + failed get_account', [chain(MARKET_CLOSED), accepted, failed('get_account')], 'Failed (recorded: accepted)', true);
  await expectOutcome('chain warning + accepted order alone', [chain(MARKET_CLOSED), accepted], 'Recorded: accepted (warning: get_options_chain unavailable while market closed)', false);
  await expectOutcome('recovered heartbeat failure + unrelated failed cancel', [{ kind: 'heartbeat_failure', content: 'failed' }, { kind: 'heartbeat_recovery', content: 'recovered' }, failed('cancel_order')], 'Failed', true);
  await expectOutcome('recovered heartbeat failure alone', [{ kind: 'heartbeat_failure', content: 'failed' }, { kind: 'heartbeat_recovery', content: 'recovered' }], 'Recovered', true);
  await expectOutcome('recovery marker without any failure', [chain(MARKET_CLOSED), { kind: 'heartbeat_recovery', content: 'recovered' }], 'Recovered (warning: get_options_chain unavailable while market closed)', false);
  await expectOutcome('failed cancel with a recorded rejected order', [{ ...accepted, result: '{"status":"rejected"}' }, failed('cancel_order')], 'Failed (recorded: rejected)', true);
  await expectOutcome('failed cancel alone', [failed('cancel_order')], 'Failed', true);
  await expectOutcome('failed place_options_order alone', [{ kind: 'tool_call', tool: 'place_options_order', args: { symbol: SYM, position_intent: 'buy_to_open' }, status: 'error', error: '{"error":"order rejected by broker"}' }], 'Failed', true);
});
