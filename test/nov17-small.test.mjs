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

// ───────────────────────── Round 2 (Hermes N17-B01, B02, B03) ─────────────────────────
// Every case goes through the public ChatStore list AND detail paths (expectOutcome checks both, and the Error label).

const goNames = o => ({ ID: o.ID, ClientOrderID: o.ClientOrderID, Symbol: o.Symbol, PositionIntent: o.PositionIntent, Status: o.Status, FilledQty: o.FilledQty });
const snakeNames = o => ({ order_id: o.order_id, client_order_id: o.client_order_id, symbol: o.symbol, position_intent: o.position_intent, status: o.status, filled_qty: o.filled_qty });

test('N17-B01: conflicting spellings of one order field are ambiguous evidence (nothing is trusted); equal or single spellings still pass', async () => {
  const ambiguous = {
    'FilledQty 0 hides filled_qty 2 (Hermes U3)': order({ FilledQty: 0, filled_qty: 2 }),
    'FilledQty 2 with filled_qty 0': order({ FilledQty: 2, filled_qty: 0 }),
    'FilledQty null falls through to filled_qty 0': order({ FilledQty: null, filled_qty: 0 }),
    'Status new vs status filled': order({ Status: 'new', status: 'filled' }),
    'Status new vs status canceled': order({ Status: 'new', status: 'canceled' }),
    'Status new vs status partially_filled': order({ Status: 'new', status: 'partially_filled' }),
    'ID matches but order_id differs': order({ order_id: 'oid-other' }),
    'order_id matches but ID differs': order({ ID: 'oid-other' }),
    'ClientOrderID matches but client_order_id differs': order({ client_order_id: 'cid-other' }),
    'Symbol matches but symbol differs': order({ symbol: 'BA261218P00175000' }),
    'PositionIntent buy_to_open vs position_intent sell_to_close': order({ position_intent: 'sell_to_close' }),
  };
  for (const [name, o] of Object.entries(ambiguous)) await expectOutcome(name, [ack(), notFound(), read([o])], 'Failed', true);
  await expectOutcome('an ambiguous read before the 404 also rules the warning out', [ack(), read([order({ FilledQty: 0, filled_qty: 2 })]), notFound(), read([order()])], 'Failed', true);
  await expectOutcome('an ambiguous read after the confirming read also rules it out', [ack(), notFound(), read([order()]), read([order({ FilledQty: 0, filled_qty: 2 })])], 'Failed', true);
  await expectOutcome('the held contract is named by either spelling in the positions list', [ack(), notFound(), read([order()]), positions([{ Symbol: 'AAPL261218C00200000', symbol: SYM, Qty: 6 }])], 'Failed', true);
  const base = order();
  await expectOutcome('both spellings, equal', [ack(), notFound(), read([base])], OPENING_WARNING, false);
  await expectOutcome('Go names only', [ack(), notFound(), read([goNames(base)])], OPENING_WARNING, false);
  await expectOutcome('snake_case names only', [ack(), notFound(), read([snakeNames(base)])], OPENING_WARNING, false);
  // the closing-intent requirement added in this release is held to the same rule
  const closeFill = over => read([order({ Status: 'filled', status: 'filled', FilledQty: 6, filled_qty: 6, PositionIntent: 'sell_to_close', position_intent: 'sell_to_close', ...over })]);
  await expectOutcome('closing fill, both spellings agree', [positions([]), closeFill({}), notFound()], CLOSURE_WARNING, false);
  await expectOutcome('closing intent contradicted by the other spelling', [positions([]), closeFill({ position_intent: 'buy_to_open' }), notFound()], 'Failed', true);
});

const chainRec = over => ({ kind: 'tool_call', tool: 'get_options_chain', args: { symbol: 'LOW' }, status: 'completed', ...over });
const CLOSED = JSON.stringify(MARKET_CLOSED);
const textPart = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });

test('N17-B02: a nested market_closed fragment never hides contradictory outer, sibling or second-source failure information', async () => {
  const bad = {
    'authentication wrapper around market_closed (Hermes C1)': chainRec({ result: JSON.stringify({ category: 'authentication', http_status: 401, error: 'unauthorized', data: MARKET_CLOSED }) }),
    'isError wrapper around market_closed (Hermes C2)': chainRec({ result: JSON.stringify({ data: MARKET_CLOSED, isError: true }) }),
    'content with market_closed and a transport failure (Hermes C3)': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED), { category: 'transport', status: 'error', error: 'ECONNREFUSED' }] }) }),
    'status error wrapper': chainRec({ result: JSON.stringify({ status: 'error', result: MARKET_CLOSED }) }),
    'payload with http_status 401': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, http_status: 401 }) }),
    'payload with status error': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, status: 'error' }) }),
    'content with a second, authentication part': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED), textPart({ category: 'authentication', error: 'unauthorized' })] }) }),
    'wrapper with an unknown message field': chainRec({ result: JSON.stringify({ message: 'chain request failed', data: MARKET_CLOSED }) }),
    'content with market_closed and plain prose': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED), textPart('provider returned 500')] }) }),
    'two market_closed payloads in one result': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED), textPart(MARKET_CLOSED)] }) }),
    'result market_closed, error is an authentication failure': chainRec({ result: CLOSED, error: JSON.stringify({ category: 'authentication', error: 'unauthorized' }) }),
    'result market_closed, error is prose': chainRec({ result: CLOSED, error: 'ECONNREFUSED 127.0.0.1:4534' }),
    'error market_closed, result is a different failure': chainRec({ result: JSON.stringify({ category: 'upstream_http', error: 'bad gateway', status: 'error' }), error: CLOSED }),
    'error market_closed, result is prose': chainRec({ result: 'chain request failed', error: CLOSED }),
  };
  for (const [name, record] of Object.entries(bad)) await expectOutcome(name, [record], 'Failed', true);
  // unchanged negatives from the first candidate
  await expectOutcome('marked isError on the payload', [chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, isError: true }) })], 'Failed', true);
  await expectOutcome('market_closed only in prose', [chainRec({ result: JSON.stringify({ error: 'the market_closed condition prevented the chain', status: 'error' }) })], 'Failed', true);
});

test('N17-B03: an exact structured market_closed answer is a warning from the result or from the error alone, in the permitted wrappers only', async () => {
  const good = {
    'result only (the Nov 16 shape)': chainRec({ result: CLOSED }),
    'wrapped in data': chainRec({ result: JSON.stringify({ data: MARKET_CLOSED }) }),
    'wrapped in result': chainRec({ result: JSON.stringify({ result: MARKET_CLOSED }) }),
    'MCP content array': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED)], isError: false }) }),
    'error only, empty result string': chainRec({ result: '', error: CLOSED }),
    'error only, result {} (Hermes C4)': chainRec({ result: '{}', error: CLOSED }),
    'error only, no result field': chainRec({ error: CLOSED }),
    'error only, record status error': chainRec({ status: 'error', result: '', error: CLOSED }),
    'error wrapped in an MCP content array': chainRec({ result: '', error: JSON.stringify({ content: [textPart(MARKET_CLOSED)] }) }),
    'result and error both say market_closed': chainRec({ result: CLOSED, error: CLOSED }),
  };
  for (const [name, record] of Object.entries(good)) await expectOutcome(name, [record], CHAIN_WARNING, false);
  await expectOutcome('error-only positive next to a failed get_account stays Failed', [chainRec({ result: '{}', error: CLOSED }), failed('get_account')], 'Failed', true);
});

// ───────────────────────── Round 3 (Hermes N17-B02-R2) ─────────────────────────
// A payload that says market_closed is only the exact shape the backend produces (controllers/order_controller.go, options chain while the
// market is closed: status, category, endpoint, next_open, error, plus the http_status the MCP server adds). Anything else inside or beside
// it, at any depth, keeps the answer essential. Cases R2-* are the records of Hermes's HERMES-ROUND2-EXTRA-PROBE.json.

const AUTH_DESCENDANT = { category: 'authentication', http_status: 401, error: 'unauthorized' };

test('N17-B02-R2: a market_closed object that carries any other property is not a market-closed answer', async () => {
  const bad = {
    'R2-authentication-in-data-descendant': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, data: AUTH_DESCENDANT }) }),
    'R2-transport-text-in-content': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, content: [{ type: 'text', text: 'transport error: ECONNREFUSED' }] }) }),
    'R2-result-isError': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, result: { isError: true, error: 'broker unavailable' } }) }),
    'R2-second-market-closed-under-data': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, data: MARKET_CLOSED }) }),
    'R2-contradictory-payload-under-benign-wrapper': chainRec({ result: JSON.stringify({ data: { ...MARKET_CLOSED, data: AUTH_DESCENDANT } }) }),
    'R2-structural-error-object-authentication': chainRec({ result: CLOSED, error: JSON.stringify({ category: 'authentication', error: 'unauthorized' }) }),
    'R2-second-source-contradictory-payload': chainRec({ result: CLOSED, error: JSON.stringify({ data: AUTH_DESCENDANT }) }),
    'same hybrid inside the error instead of the result': chainRec({ result: '{}', error: JSON.stringify({ ...MARKET_CLOSED, data: AUTH_DESCENDANT }) }),
    'hybrid inside an MCP content part': chainRec({ result: JSON.stringify({ content: [textPart({ ...MARKET_CLOSED, data: AUTH_DESCENDANT })] }) }),
    'hybrid inside a result wrapper': chainRec({ result: JSON.stringify({ result: { ...MARKET_CLOSED, result: { isError: true } } }) }),
    'hybrid two wrappers deep': chainRec({ result: JSON.stringify({ result: { data: { ...MARKET_CLOSED, text: 'ECONNREFUSED' } } }) }),
    'payload with an isError flag of any value': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, isError: false }) }),
    'payload with an unknown extra key': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, message: 'also: provider returned 500' }) }),
    'payload with a retry flag': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, retryable: true }) }),
    'payload whose error is an object': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, error: { category: 'authentication' } }) }),
    'payload whose error text is not the market-closed text': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, error: 'unauthorized' }) }),
    'payload whose status is an object': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, status: { code: 'error' } }) }),
    'payload for another endpoint': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, endpoint: 'orders' }) }),
    'payload whose next_open is an object': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, next_open: { error: 'x' } }) }),
  };
  for (const [name, record] of Object.entries(bad)) await expectOutcome(name, [record], 'Failed', true);
});

test('N17-B02-R2: the exact backend payload, in any permitted place, is still a warning', async () => {
  const good = {
    'C0 direct payload (the real Nov 16 shape)': chainRec({ result: CLOSED }),
    'C4 error only, result {}': chainRec({ result: '{}', error: CLOSED }),

    'next_open null': chainRec({ result: JSON.stringify({ ...MARKET_CLOSED, next_open: null }) }),
    'in data': chainRec({ result: JSON.stringify({ data: MARKET_CLOSED }) }),
    'in an MCP content part': chainRec({ result: JSON.stringify({ content: [textPart(MARKET_CLOSED)], isError: false }) }),
    'result and error agree': chainRec({ result: CLOSED, error: CLOSED }),
  };
  for (const [name, record] of Object.entries(good)) await expectOutcome(name, [record], CHAIN_WARNING, false);
});
