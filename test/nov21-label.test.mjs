import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore } from '../agent/chat-store.js';

// Nov 21 build, item B1: a single-position lookup of an exact contract the account does not hold and has no order for is a
// warning, not a Failed beat, only when the same activity shows complete positions and orders evidence without the contract.

const ACCOUNT = 'acct-n21';
async function activityFor(records) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-nov21-'));
  try {
    const store = new ChatStore(root);
    await store.startSession(ACCOUNT, 'session-n21', { agentName: 'Herald' });
    const file = path.join(root, 'sandboxes', ACCOUNT, 'chat-history', 'session-session-n21.jsonl');
    const lines = records.map((record, i) => JSON.stringify({ timestamp: new Date(Date.UTC(2026, 10, 20, 18, 3, i)).toISOString(), activityId: 'act-n21', origin: 'Heartbeat', ...record }));
    await fs.appendFile(file, lines.join('\n') + '\n');
    const list = (await store.listActivities(ACCOUNT, { limit: 5 })).activities[0];
    const detail = await store.getActivity(ACCOUNT, 'act-n21');
    return { list, detail };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function expectOutcome(name, records, outcome, errorLabel) {
  const { list, detail } = await activityFor(records);
  assert.equal(list.outcome, outcome, `${name}: list outcome`);
  assert.equal(detail.outcome, outcome, `${name}: detail outcome`);
  assert.equal(list.labels.includes('Error'), errorLabel, `${name}: list Error label`);
  assert.equal(detail.labels.includes('Error'), errorLabel, `${name}: detail Error label`);
}

const PROBED = 'META261218P00580000';
const HELD = 'NVDA261218P00160000';
const WARNING = 'Recorded (warning: get_options_position not found for a contract not held)';
const diagnostics = (status = 404, extra = {}) => ({ endpoint: `/options/position/${PROBED}`, tool: 'options', status, category: 'upstream_http', attempts: 1, retryable: false, http_status: status, ...extra });
const lookup = (over = {}, symbol = PROBED) => ({ kind: 'tool_call', tool: 'get_options_position', args: { symbol }, status: 'error',
  error: JSON.stringify({ error: `Single options-position lookup: no open position found; this is not confirmation of a successful closure.\nTrading bot request failed: ${JSON.stringify(diagnostics())}`, diagnostics: diagnostics(), ...over }) });
const positions = rows => ({ kind: 'tool_call', tool: 'get_options_positions', args: {}, status: 'completed', result: typeof rows === 'string' ? rows : JSON.stringify(rows) });
const heldRow = (symbol = HELD, account = 'broker-acct-1') => ({ BrokerAccountID: account, Symbol: symbol, Qty: 2 });
const orderRow = (symbol, account = 'broker-acct-1') => ({ BrokerAccountID: account, ID: 'oid-1', ClientOrderID: 'cid-1', Symbol: symbol, Side: 'buy', Status: 'canceled', FilledQty: 0, PositionIntent: 'buy_to_open' });
const ordersRead = (orders, envelope = {}) => ({ kind: 'tool_call', tool: 'get_orders', args: { status: 'active' }, status: 'completed', result: JSON.stringify({ broker_state: 'available', complete: true, orders, ...envelope }) });
const placed = symbol => ({ kind: 'tool_call', tool: 'place_options_order', args: { symbol, position_intent: 'buy_to_open', client_order_id: 'cid-n21-1' }, status: 'completed',
  result: JSON.stringify({ order_id: 'oid-n21-1', client_order_id: 'cid-n21-1', status: 'pending_new', symbol, filled_qty: 0, execution_confirmed: false }) });
const failedTool = (tool, message = 'failed') => ({ kind: 'tool_call', tool, args: {}, status: 'error', error: JSON.stringify({ error: message }) });
const GOOD = () => [positions([heldRow()]), ordersRead([orderRow(HELD)]), lookup()];

test('B1: an exact structured 404 for a contract that is neither held nor ordered, with complete evidence, is the exact warning', async () => {
  await expectOutcome('real Herald shape', GOOD(), WARNING, false);
  await expectOutcome('empty positions and empty orders', [positions([]), ordersRead([]), lookup()], WARNING, false);
  await expectOutcome('evidence read after the lookup', [lookup(), positions([heldRow()]), ordersRead([orderRow(HELD)])], WARNING, false);
});

test('B1: anything short of complete evidence that the contract is not held and not ordered stays Failed with the Error label', async () => {
  const cases = {
    'the contract is held': [positions([heldRow(PROBED)]), ordersRead([]), lookup()],
    'no positions read': [ordersRead([orderRow(HELD)]), lookup()],
    'positions read failed': [failedTool('get_options_positions'), ordersRead([]), lookup()],
    'positions read not an array': [positions('not json'), ordersRead([]), lookup()],
    'one of two positions reads lists the contract': [positions([]), positions([heldRow(PROBED)]), ordersRead([]), lookup()],
    'no orders read': [positions([heldRow()]), lookup()],
    'orders read failed': [positions([heldRow()]), failedTool('get_orders'), lookup()],
    'orders read incomplete': [positions([heldRow()]), ordersRead([], { complete: false }), lookup()],
    'orders read broker unavailable': [positions([heldRow()]), ordersRead([], { broker_state: 'unavailable' }), lookup()],
    'an order of the contract exists': [positions([heldRow()]), ordersRead([orderRow(PROBED)]), lookup()],
    'the contract is ordered in the same activity': [positions([heldRow()]), ordersRead([]), placed(PROBED), lookup()],
    'the contract is ordered later in the activity': [positions([heldRow()]), ordersRead([]), lookup(), placed(PROBED)],
    'two broker accounts in the evidence': [positions([heldRow(HELD, 'broker-acct-1')]), ordersRead([orderRow(HELD, 'broker-acct-2')]), lookup()],
  };
  for (const [name, records] of Object.entries(cases)) await expectOutcome(name, records, 'Failed', true);
});

test('B1: only an unambiguous 404 qualifies (authentication, server, transport and plain-text answers stay Failed)', async () => {
  const bad = (status, extra = {}) => ({ kind: 'tool_call', tool: 'get_options_position', args: { symbol: PROBED }, status: 'error',
    error: JSON.stringify({ error: `Single options-position lookup: no open position found. Trading bot request failed: ${JSON.stringify(diagnostics(status))}`, diagnostics: diagnostics(status), ...extra }) });
  const base = [positions([heldRow()]), ordersRead([orderRow(HELD)])];
  for (const status of [401, 403, 429, 500, 503]) await expectOutcome(`status ${status}`, [...base, bad(status)], 'Failed', true);
  await expectOutcome('mixed statuses in the answer', [...base, bad(404, { diagnostics: diagnostics(404, { http_status: 500 }) })], 'Failed', true);
  await expectOutcome('plain text only', [...base, { kind: 'tool_call', tool: 'get_options_position', args: { symbol: PROBED }, status: 'error', error: 'options position not found: ' + PROBED + ' status 404' }], 'Failed', true);
  await expectOutcome('no symbol in the call', [...base, { ...lookup(), args: {} }], 'Failed', true);
});

test('B1: another essential failure in the same activity keeps the beat Failed', async () => {
  await expectOutcome('account read failed', [failedTool('get_account'), ...GOOD()], 'Failed', true);
  await expectOutcome('order placement failed with an unrelated error', [...GOOD(), { kind: 'tool_call', tool: 'place_options_order', args: { symbol: HELD }, status: 'error', error: JSON.stringify({ error: 'broker rejected: insufficient buying power' }) }], 'Failed', true);
});

test('B1: the existing warnings still win for their own shapes (opening unfilled, after confirmed close)', async () => {
  const SYM = 'BA261218P00170000';
  const ack = { kind: 'tool_call', tool: 'place_options_order', args: { symbol: SYM, position_intent: 'buy_to_open', client_order_id: 'cid-n21-9' }, status: 'completed',
    result: JSON.stringify({ order_id: 'oid-n21-9', client_order_id: 'cid-n21-9', status: 'pending_new', symbol: SYM, filled_qty: 0, execution_confirmed: false }) };
  const notFound = { kind: 'tool_call', tool: 'get_options_position', args: { symbol: SYM }, status: 'error', error: 'Single options-position lookup: no open position found; options position not found: ' + SYM + ' status 404' };
  const order = { ID: 'oid-n21-9', order_id: 'oid-n21-9', ClientOrderID: 'cid-n21-9', client_order_id: 'cid-n21-9', Symbol: SYM, symbol: SYM, PositionIntent: 'buy_to_open', position_intent: 'buy_to_open', Status: 'new', status: 'new', FilledQty: 0, filled_qty: 0 };
  await expectOutcome('unfilled opening', [ack, notFound, ordersRead([order])], 'Recorded (warning: get_options_position not found while opening order unfilled)', false);
});
