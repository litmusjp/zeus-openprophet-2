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

// QA round 1 (B-B01): the seven negative controls that the first candidate wrongly downgraded. Each runs through the real classifier.
const edit = (records, tool, fn) => records.map(r => (r.tool === `prophet_${tool}` ? fn(r) : r));
const rewrite = (records, tool, fn) => edit(records, tool, r => ({ ...r, result: JSON.stringify(fn(JSON.parse(r.result))) }));
const stillFailed = (name, records) => {
  const { essential, warnings } = classifyFailures(records);
  assert.ok(essential.some(r => r.tool === 'prophet_get_options_position'), `${name}: must stay an essential failure (warnings: ${warnings})`);
};

test('B-B01: missing or conflicting identity, misleading diagnostics and stale reads never downgrade a lookup', () => {
  // 1. both account ids missing on the held position and the closing order
  let r = rewrite(closeActivity(), 'get_options_positions', rows => rows.map(({ BrokerAccountID, ...rest }) => rest));
  r = rewrite(r, 'get_orders', body => ({ ...body, orders: body.orders.map(({ BrokerAccountID, ...rest }) => rest) }));
  stillFailed('missing account ids', r);
  // 2. acknowledgement names another contract
  stillFailed('acknowledgement names another contract', rewrite(closeActivity(), 'place_options_order', ack => ({ ...ack, symbol: 'OTHER' })));
  // 3. broker row spells the symbol two ways with different values
  stillFailed('conflicting symbol aliases on the order row', rewrite(closeActivity(), 'get_orders', body => ({ ...body, orders: body.orders.map(o => ({ ...o, symbol: 'OTHER' })) })));
  // 4. structured 401 whose prose still says "no open position found"
  stillFailed('unauthorised diagnostics with not-found prose', closeActivity().map(x => (x.tool === 'prophet_get_options_position'
    ? { ...x, error: '{"error":"unauthorized: no open position found","diagnostics":{"status":401}}' } : x)));
  // 4b. a 404 in the diagnostics but a different status elsewhere in the answer
  stillFailed('mixed statuses', closeActivity().map(x => (x.tool === 'prophet_get_options_position'
    ? { ...x, error: '{"error":"no open position found","diagnostics":{"status":404,"http_status":401}}' } : x)));
  // 5. the confirming read comes after the cancel but BEFORE the lookup
  const open = { BrokerAccountID: ACCT, ID: 'ord-open', Symbol: SYM, Qty: 5, Side: 'buy', Status: 'canceled', FilledQty: 0, PositionIntent: 'buy_to_open' };
  stillFailed('cancel read before the lookup', [call('get_options_positions', {}, []),
    call('cancel_order', { order_id: 'ord-open' }, { message: 'Order canceled successfully' }), ordersRead([open]), notFound()]);
  // 6. the cancelled row has an ID and a conflicting order_id
  stillFailed('conflicting order id aliases', cancelActivity({ orders: [{ ...open, order_id: 'OTHER' }] }));
  // 7. the account read says one account and the cancelled row another
  stillFailed('account mismatch with the account read', [call('get_options_positions', {}, []), call('get_account', {}, { ID: ACCT }),
    call('cancel_order', { order_id: 'ord-open' }, { message: 'Order canceled successfully' }), notFound(), ordersRead([{ ...open, BrokerAccountID: 'acct-2' }])]);
  // 8. the cancelled order row has no account at all
  const { BrokerAccountID, ...noAccount } = open;
  stillFailed('cancelled row without an account', cancelActivity({ orders: [noAccount] }));
  // 9. position row and order row name different accounts
  stillFailed('position and order accounts differ', rewrite(closeActivity(), 'get_options_positions', rows => rows.map(p => ({ ...p, BrokerAccountID: 'acct-2' }))));
});

test('B-B01: the positive controls and the saved Nov 18 shapes still downgrade through the real classifier', () => {
  assert.deepEqual(classifyFailures(closeActivity()).warnings, ['get_options_position not found after confirmed full close']);
  assert.deepEqual(classifyFailures(cancelActivity()).warnings, ['get_options_position not found after confirmed cancel']);
  const accountRead = call('get_account', {}, { BrokerAccountID: ACCT, ID: ACCT });
  assert.equal(classifyFailures([accountRead, ...closeActivity()]).essential.length, 0, 'an agreeing account read is fine');
});
