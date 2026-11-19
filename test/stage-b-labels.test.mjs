import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailures } from '../agent/chat-store.js';

const SYM = 'AMD261218P00500000';
const ACCT = 'acct-1';
const call = (tool, args, result, extra = {}) => ({ kind: 'tool_call', tool: `prophet_${tool}`, args, result: typeof result === 'string' ? result : JSON.stringify(result), ...extra });
const notFound = (symbol = SYM) => call('get_options_position', { symbol }, '', {
  error: '{"error":"Single options-position lookup: no open position found; this is not confirmation of a successful closure.","diagnostics":{"status":404}}',
});
const position = (qty = 1, account = ACCT) => [{ BrokerAccountID: account, Symbol: SYM, Qty: qty }];
const ack = (orderId = 'ord-close') => call('place_options_order', { symbol: SYM, position_intent: 'sell_to_close' }, { order_id: orderId, status: 'pending_new', filled_qty: 0, symbol: SYM });
const order = (over = {}) => ({
  BrokerAccountID: ACCT, ID: 'ord-close', Symbol: SYM, Qty: 1, Side: 'sell', Status: 'filled', FilledQty: 1, PositionIntent: 'sell_to_close', ...over,
});
const ordersRead = (orders, over = {}) => call('get_orders', { symbol: SYM, status: 'all' }, { broker_state: 'available', complete: true, orders, ...over });
const labelOf = records => classifyFailures(records);
const closeActivity = ({ positions = position(), orders = [order()], placed = [ack()] } = {}) => [
  call('get_options_positions', {}, positions), ...placed, notFound(), ordersRead(orders),
];

test('confirmed full close downgrades the not-found lookup to a warning, with older history rows allowed', () => {
  const history = [
    order({ ID: 'old-exp', Status: 'expired', FilledQty: 0 }),
    order({ ID: 'old-cx', Status: 'canceled', FilledQty: 0 }),
    order({ ID: 'entry', Side: 'buy', PositionIntent: 'buy_to_open', Status: 'filled' }),
  ];
  const result = labelOf(closeActivity({ orders: [order(), ...history] }));
  assert.equal(result.essential.length, 0);
  assert.deepEqual(result.warnings, ['get_options_position not found after confirmed full close']);
});

test('full close stays Failed on missing, partial, contradictory or unrelated evidence', () => {
  const cases = {
    'no placed order in the activity': closeActivity({ placed: [] }),
    'fill smaller than the held quantity': closeActivity({ positions: position(2), orders: [order({ Qty: 2, FilledQty: 1 })] }),
    'fill smaller than the order quantity': closeActivity({ orders: [order({ Qty: 2, FilledQty: 1 })] }),
    'order not yet filled': closeActivity({ orders: [order({ Status: 'new', FilledQty: 0 })] }),
    'opening intent': closeActivity({ orders: [order({ PositionIntent: 'buy_to_open', Side: 'buy' })] }),
    'different account': closeActivity({ orders: [order({ BrokerAccountID: 'acct-2' })] }),
    'ambiguous status spellings': closeActivity({ orders: [order({ status: 'canceled' })] }),
    'another working order for the contract': closeActivity({ orders: [order(), order({ ID: 'x', Status: 'new', FilledQty: 0 })] }),
    'a second closing fill': closeActivity({ orders: [order(), order({ ID: 'y', Status: 'filled', FilledQty: 1 })] }),
    'the order id is absent from the read': closeActivity({ orders: [order({ ID: 'other-order' })] }),
    'incomplete broker read': [call('get_options_positions', {}, position()), ack(), notFound(), ordersRead([order()], { complete: false })],
    'broker unavailable': [call('get_options_positions', {}, position()), ack(), notFound(), ordersRead([order()], { broker_state: 'unavailable' })],
    'the confirming read comes before the lookup': [call('get_options_positions', {}, position()), ack(), ordersRead([order()]), notFound()],
    'no held position was ever read': [ack(), notFound(), ordersRead([order()])],
    'position still held in a later read': [...closeActivity(), call('get_options_positions', {}, position())],
  };
  for (const [name, records] of Object.entries(cases)) {
    const { essential } = labelOf(records);
    assert.ok(essential.some(r => r.tool === 'prophet_get_options_position'), `${name}: the lookup must stay an essential failure`);
  }
});

const cancelActivity = ({ cancel = call('cancel_order', { order_id: 'ord-open' }, { message: 'Order canceled successfully' }), orders, positions = [] } = {}) => [
  call('get_options_positions', {}, positions), cancel, notFound(),
  ordersRead(orders || [order({ ID: 'ord-open', Side: 'buy', Qty: 5, Status: 'canceled', FilledQty: 0, PositionIntent: 'buy_to_open' })]),
];

test('a successful cancel plus a terminal zero-fill canceled read downgrades the lookup, including an order from an earlier beat', () => {
  const result = labelOf(cancelActivity());
  assert.equal(result.essential.length, 0);
  assert.deepEqual(result.warnings, ['get_options_position not found after confirmed cancel']);
});

test('the cancel trigger stays Failed on missing, partial, contradictory or unrelated evidence', () => {
  const open = over => order({ ID: 'ord-open', Side: 'buy', Qty: 5, Status: 'canceled', FilledQty: 0, PositionIntent: 'buy_to_open', ...over });
  const cases = {
    'partly filled before the cancel': cancelActivity({ orders: [open({ FilledQty: 2 })] }),
    'not terminal yet': cancelActivity({ orders: [open({ Status: 'pending_cancel' })] }),
    'filled': cancelActivity({ orders: [open({ Status: 'filled', FilledQty: 5 })] }),
    'a different order id was cancelled': cancelActivity({ orders: [open({ ID: 'someone-else' })] }),
    'the cancel itself failed': cancelActivity({ cancel: call('cancel_order', { order_id: 'ord-open' }, '', { error: 'order not cancelable' }) }),
    'a second cancel in the activity': [...cancelActivity(), call('cancel_order', { order_id: 'ord-2' }, { message: 'Order canceled successfully' })],
    'a replacement order is working': cancelActivity({ orders: [open(), order({ ID: 'repl', Side: 'buy', Status: 'new', FilledQty: 0, PositionIntent: 'buy_to_open' })] }),
    'the position is held in a read': cancelActivity({ positions: position() }),
    'quantity missing': cancelActivity({ orders: [open({ Qty: 0 })] }),
    'incomplete read': [...cancelActivity().slice(0, 3), ordersRead([open()], { complete: false })],
    'read before the cancel': [call('get_options_positions', {}, []), ordersRead([open()]), call('cancel_order', { order_id: 'ord-open' }, { message: 'Order canceled successfully' }), notFound()],
  };
  for (const [name, records] of Object.entries(cases)) {
    const { essential } = labelOf(records);
    assert.ok(essential.some(r => r.tool === 'prophet_get_options_position'), `${name}: the lookup must stay an essential failure`);
  }
});

test('other failures keep the Failed treatment: a stock quote on an option symbol and a refused file read', () => {
  const quote = call('get_quote', { symbol: SYM }, '', { error: '{"error":"Trading bot request failed: invalid symbol"}' });
  const read = call('read', { filePath: '/nonexistent' }, '', { error: 'The user rejected permission to use this specific tool call.' });
  assert.equal(labelOf([quote]).essential.length, 1);
  assert.equal(labelOf([read]).essential.length, 1);
});

test('the existing reconciled-close and unfilled-opening triggers are unchanged for their own evidence', () => {
  const lookup = notFound();
  const records = [call('get_options_positions', {}, []), lookup, call('get_orders', {}, { orders: [order()] })];
  assert.deepEqual(labelOf(records).warnings, ['get_options_position not found after confirmed close']);
});
