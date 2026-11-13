import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, ordersFrom, isOptionExitOrder, buildPostCancelCheck, unverifiedPostCancelCheck } from '../cancel-check.js';

const SYM = 'COST261120C01100000';
const exit = (over = {}) => normalizeOrder({ order_id: 'A1', symbol: SYM, side: 'sell', position_intent: 'sell_to_close', status: 'new', qty: 4, filled_qty: 0, ...over });
const pos = (qty = 4, symbol = SYM) => ({ Symbol: symbol, Qty: qty, Side: 'long' });

test('isOptionExitOrder: sell_to_close on an OCC symbol only', () => {
  assert.equal(isOptionExitOrder(exit()), true);
  assert.equal(isOptionExitOrder(exit({ position_intent: 'buy_to_open', side: 'buy' })), false);
  assert.equal(isOptionExitOrder(exit({ symbol: 'AAPL' })), false);
  assert.equal(isOptionExitOrder(exit({ position_intent: '', side: 'sell' })), true); // no intent: side decides
});

test('ordersFrom accepts arrays, wrapped lists and Go-style field names', () => {
  assert.equal(ordersFrom([{ ID: 'x', Symbol: SYM, Side: 'sell', PositionIntent: 'sell_to_close', Status: 'new', Qty: 2, FilledQty: 1 }])[0].filled, 1);
  assert.equal(ordersFrom({ orders: [{ order_id: 'y' }] })[0].id, 'y');
  assert.deepEqual(ordersFrom(null), []);
});

test('the Nov 12 case: cancelled exit, still held, no other exit -> replace the 4 verified', () => {
  const r = buildPostCancelCheck({ order: exit(), ordersAfter: [exit({ status: 'canceled' })], positions: [pos(4)] });
  assert.equal(r.verified, true);
  assert.equal(r.cancel_confirmed_terminal, true);
  assert.equal(r.held_qty_after_cancel, 4);
  assert.equal(r.unreserved_held_qty, 4);
  assert.match(r.note, /Position still open: 4 contract/);
  assert.match(r.note, /replace only the 4 verified/);
});

test('partially filled then cancelled: held is the remainder, never the original size', () => {
  const r = buildPostCancelCheck({ order: exit(), ordersAfter: [exit({ status: 'canceled', filled_qty: 1 })], positions: [pos(3)] });
  assert.equal(r.cancelled_order_filled_qty, 1);
  assert.equal(r.unreserved_held_qty, 3);
});

test('another working exit covers the position: no replacement needed', () => {
  const r =buildPostCancelCheck({ order: exit(), ordersAfter: [exit({ status: 'canceled' }), normalizeOrder({ order_id: 'B2', symbol: SYM, side: 'sell', position_intent: 'sell_to_close', status: 'new', qty: 4, filled_qty: 0 })], positions: [pos(4)] });
  assert.equal(r.other_working_exit_qty, 4);
  assert.equal(r.unreserved_held_qty, 0);
  assert.match(r.note, /other working exit orders already cover it/);
});

test('position gone: no replacement', () => {
  const r = buildPostCancelCheck({ order: exit(), ordersAfter: [exit({ status: 'filled', filled_qty: 4 })], positions: [] });
  assert.equal(r.held_qty_after_cancel, 0);
  assert.match(r.note, /No position remains/);
});

test('cancel not terminal (pending_cancel): do not replace yet', () => {
  const r = buildPostCancelCheck({ order: exit(), ordersAfter: [exit({ status: 'pending_cancel' })], positions: [pos(4)] });
  assert.equal(r.cancel_confirmed_terminal, false);
  assert.match(r.note, /not confirmed terminal/);
});

test('order missing from the list: unverified, no duplicate', () => {
  const r = buildPostCancelCheck({ order: exit(), ordersAfter: [], positions: [pos(4)] });
  assert.equal(r.verified, false);
  assert.match(r.note, /Unverified/);
});

test('read failure helper never throws and says unverified', () => {
  const r = unverifiedPostCancelCheck(SYM, new Error('timeout'));
  assert.equal(r.verified, false);
  assert.match(r.note, /Unverified.*timeout/);
});
