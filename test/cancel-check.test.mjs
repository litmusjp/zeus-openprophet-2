import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, ordersFrom, isOptionExitOrder, buildPostCancelCheck, unverifiedPostCancelCheck } from '../cancel-check.js';

const SYM = 'COST261120C01100000';
// Real DTOs: the Go Order and OptionsPosition structs serialise with Go field names, and /orders wraps the list.
const goOrder = (over = {}) => ({ ID: 'A1', ClientOrderID: 'c1', Symbol: SYM, Qty: 4, Side: 'sell', Type: 'limit', Status: 'canceled', FilledQty: 0, AssetClass: 'us_option', PositionIntent: 'sell_to_close', ...over });
const wrapped = (orders, over = {}) => ({ orders, complete: true, broker_state: 'available', ...over });
const goPos = (qty, symbol = SYM, over = {}) => ({ Symbol: symbol, Underlying: 'COST', Qty: qty, Side: 'long', ...over });
const order = normalizeOrder(goOrder({ Status: 'new' }));
const check = (ordersResponse, positions) => buildPostCancelCheck({ order, ordersResponse, positions });

test('isOptionExitOrder: sell_to_close on an OCC symbol only', () => {
  assert.equal(isOptionExitOrder(order), true);
  assert.equal(isOptionExitOrder(normalizeOrder(goOrder({ PositionIntent: 'buy_to_open', Side: 'buy' }))), false);
  assert.equal(isOptionExitOrder(normalizeOrder(goOrder({ Symbol: 'AAPL' }))), false);
  assert.equal(isOptionExitOrder(normalizeOrder(goOrder({ PositionIntent: '', Side: 'sell' }))), true);
});

test('ordersFrom (pre-cancel identification) accepts arrays, the wrapped response and both key styles', () => {
  assert.equal(ordersFrom(wrapped([goOrder()]))[0].id, 'A1');
  assert.equal(ordersFrom([{ order_id: 'y', symbol: SYM }])[0].id, 'y');
  assert.deepEqual(ordersFrom(null), []);
  assert.equal(normalizeOrder(goOrder({ Qty: undefined })).qty, null, 'a missing quantity is unknown, not zero');
});

test('the Nov 12 case: cancelled exit, held, nothing else working -> verified remainder', () => {
  const r = check(wrapped([goOrder()]), [goPos(4)]);
  assert.equal(r.verified, true);
  assert.equal(r.cancel_confirmed_terminal, true);
  assert.equal(r.unreserved_held_qty, 4);
  assert.match(r.note, /replace only the 4 verified/);
  assert.match(r.note, /snapshot, not a reservation/);
});

test('partially filled then cancelled: the remainder held, not the original size', () => {
  const r = check(wrapped([goOrder({ FilledQty: 1 })]), [goPos(3)]);
  assert.equal(r.cancelled_order_filled_qty, 1);
  assert.equal(r.unreserved_held_qty, 3);
});

test('another working exit covers the position; position gone', () => {
  const covered = check(wrapped([goOrder(), goOrder({ ID: 'B2', Status: 'new', Qty: 4 })]), [goPos(4)]);
  assert.equal(covered.other_working_exit_qty, 4);
  assert.equal(covered.unreserved_held_qty, 0);
  assert.match(covered.note, /already cover/);
  const gone = check(wrapped([goOrder({ Status: 'filled', FilledQty: 4 })]), []);
  assert.equal(gone.verified, true);
  assert.match(gone.note, /No position remains/);
});

test('cancel not terminal (pending_cancel): do not replace yet', () => {
  const r = check(wrapped([goOrder({ Status: 'pending_cancel' })]), [goPos(4)]);
  assert.equal(r.verified, true);
  assert.equal(r.cancel_confirmed_terminal, false);
  assert.match(r.note, /not confirmed terminal/);
});

// ── Hermes finding 1: incomplete or malformed evidence must never become "verified" ──────────
test('HTTP 200 with complete:false or broker_state unavailable (local-only records) is unverified', () => {
  for (const over of [{ complete: false }, { broker_state: 'unavailable' }, { complete: false, broker_state: 'unavailable' }, { complete: undefined }]) {
    const r = check(wrapped([goOrder()], over), [goPos(4)]);
    assert.equal(r.verified, false, JSON.stringify(over));
    assert.match(r.note, /Unverified/);
    assert.equal(r.unreserved_held_qty, undefined, 'no replacement quantity is offered');
  }
});

test('a bare array, a missing list or a non-object response is unverified', () => {
  for (const resp of [[goOrder()], null, undefined, 'x', { complete: true, broker_state: 'available' }, { orders: 'nope', complete: true, broker_state: 'available' }]) {
    assert.equal(check(resp, [goPos(4)]).verified, false, JSON.stringify(resp));
  }
});

test('malformed or missing positions never read as flat', () => {
  const orders = wrapped([goOrder()]);
  for (const positions of [null, undefined, {}, 'x', { positions: [] }]) assert.equal(check(orders, positions).verified, false, JSON.stringify(positions));
  assert.equal(check(orders, [null]).verified, false);
  assert.equal(check(orders, [{ Qty: 4 }]).verified, false, 'a record with no symbol');
  for (const bad of [undefined, null, 'abc', NaN, -1]) assert.equal(check(orders, [goPos(bad)]).verified, false, `qty ${bad}`);
  assert.equal(check(orders, [goPos(undefined, 'OTHER261120C00100000')]).verified, true, 'unrelated contracts are ignored');
});

test('unknown quantities on the cancelled order or another working exit are unverified, not zero', () => {
  assert.equal(check(wrapped([goOrder({ FilledQty: undefined })]), [goPos(4)]).verified, false);
  assert.equal(check(wrapped([goOrder({ FilledQty: 9 })]), [goPos(4)]).verified, false, 'filled above qty');
  assert.equal(check(wrapped([goOrder(), goOrder({ ID: 'B2', Status: 'new', Qty: undefined })]), [goPos(4)]).verified, false);
  assert.equal(check(wrapped([goOrder(), goOrder({ ID: 'B2', Status: 'new', Qty: 4, FilledQty: 'x' })]), [goPos(4)]).verified, false);
  assert.equal(check(wrapped([goOrder(), { not: 'an order' }, null]), [goPos(4)]).verified, false, 'unreadable record in the list');
});

test('the cancelled order missing from an otherwise complete list is unverified', () => {
  assert.equal(check(wrapped([]), [goPos(4)]).verified, false);
});

test('an unrelated contract with an unknown quantity does not block this check', () => {
  const other = goOrder({ ID: 'Z9', Symbol: 'AAPL261120C00100000', Status: 'new', Qty: undefined });
  assert.equal(check(wrapped([goOrder(), other]), [goPos(4)]).verified, true);
});

test('read-failure helper never throws and says unverified', () => {
  const r = unverifiedPostCancelCheck(SYM, new Error('timeout'));
  assert.equal(r.verified, false);
  assert.match(r.note, /Unverified: timeout/);
});
