import test from 'node:test';
import assert from 'node:assert/strict';

import { checkPermissions, isOptionSymbol } from '../permissions.js';
import { tradeEventFromToolUse } from '../agent/harness.js';
import { buildTradeLedger } from '../agent/trade-ledger.js';

const enabled = {
  allowLiveTrading: true,
  allowOptions: true,
  allowStocks: true,
  allow0DTE: true,
  requireConfirmation: false,
  maxOrderValue: 1000,
};

test('OCC symbols are recognized as options', () => {
  assert.equal(isOptionSymbol('TSLA251219C00400000'), true);
  assert.equal(isOptionSymbol('TSLA  251219C00400000'), true);
  assert.equal(isOptionSymbol('TSLA'), false);
});

test('generic buy/sell tools reject OCC option symbols', () => {
  assert.throws(
    () => checkPermissions('place_buy_order', { symbol: 'TSLA251219C00400000', quantity: 1, limit_price: 1 }, enabled),
    /place_options_order/,
  );
  assert.throws(
    () => checkPermissions('place_sell_order', { symbol: 'TSLA251219C00400000', quantity: 1, limit_price: 1 }, enabled),
    /place_options_order/,
  );
});

test('option order permission requires explicit position intent', () => {
  assert.throws(
    () => checkPermissions('place_options_order', {
      symbol: 'TSLA251219C00400000', quantity: 1, side: 'buy', order_type: 'limit', limit_price: 1,
    }, enabled),
    /position_intent/,
  );
});

test('trade telemetry distinguishes broker acknowledgement from confirmed fill', () => {
  const accepted = tradeEventFromToolUse('prophet_place_options_order', {
    symbol: 'TSLA251219C00400000', side: 'buy', quantity: 1, position_intent: 'buy_to_open',
  }, JSON.stringify({ order_id: 'broker-1', status: 'accepted', filled_qty: 0 }));
  assert.equal(accepted.executionConfirmed, false);
  assert.equal(accepted.lifecycle, 'submitted');

  const filled = tradeEventFromToolUse('prophet_place_options_order', {
    symbol: 'TSLA251219C00400000', side: 'buy', quantity: 1, position_intent: 'buy_to_open',
  }, JSON.stringify({ order_id: 'broker-2', status: 'filled', filled_qty: 1, filled_avg_price: 2.5, execution_confirmed: true }));
  assert.equal(filled.executionConfirmed, true);
  assert.equal(filled.lifecycle, 'filled');
  assert.equal(filled.price, 2.5);

  const canceledPartial = tradeEventFromToolUse('prophet_place_options_order', {
    symbol: 'TSLA251219C00400000', side: 'sell', quantity: 2, position_intent: 'sell_to_close',
  }, JSON.stringify({ order_id: 'broker-3', status: 'canceled', filled_qty: 1, filled_avg_price: 1.2, execution_confirmed: true }));
  assert.equal(canceledPartial.executionConfirmed, true);
  assert.equal(canceledPartial.lifecycle, 'partially_filled_canceled');
});

test('ledger uses positive filled quantity even for terminal canceled status', () => {
  const trades = buildTradeLedger([
    { ID: 'entry', Symbol: 'AAPL', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 100, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'exit', Symbol: 'AAPL', Side: 'sell', Status: 'canceled', FilledQty: 1, FilledAvgPrice: 110, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 10);
});

test('ledger ignores positive fill fields on active or uncertain statuses', () => {
  const trades = buildTradeLedger([
    { ID: 'open', Symbol: 'AAPL', Side: 'buy', Status: 'accepted', FilledQty: 1, FilledAvgPrice: 100 },
    { ID: 'uncertain', Symbol: 'AAPL', Side: 'sell', Status: 'submission_uncertain', FilledQty: 1, FilledAvgPrice: 110 },
  ]);
  assert.equal(trades.length, 0);
});

test('ledger deduplicates broker snapshots by client order identity', () => {
  const trades = buildTradeLedger([
    { ID: 'broker-entry', ClientOrderID: 'client-entry', Symbol: 'AAPL', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 100, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'broker-entry-retry', ClientOrderID: 'client-entry', Symbol: 'AAPL', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 100, FilledAt: '2026-09-18T13:00:01Z' },
    { ID: 'broker-exit', ClientOrderID: 'client-exit', Symbol: 'AAPL', Side: 'sell', Status: 'filled', FilledQty: 1, FilledAvgPrice: 110, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 10);
});

test('ledger canonicalizes compact and padded OCC symbols into one lot', () => {
  const trades = buildTradeLedger([
    { ID: 'entry', Symbol: 'TSLA251219C00400000', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 1, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'exit', Symbol: 'TSLA  251219C00400000', Side: 'sell', Status: 'filled', FilledQty: 1, FilledAvgPrice: 2, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 100);
});
test('ledger applies option multiplier to padded OCC symbols', () => {
  const trades = buildTradeLedger([
    { ID: 'entry', Symbol: 'TSLA  251219C00400000', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 1, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'exit', Symbol: 'TSLA  251219C00400000', Side: 'sell', Status: 'expired', FilledQty: 1, FilledAvgPrice: 2, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 100);
  assert.equal(trades[0].assetType, 'option');
});