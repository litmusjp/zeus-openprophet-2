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
  assert.equal(tradeEventFromToolUse('prophet_place_options_order', { symbol: 'TSLA251219C00400000', quantity: 1 }, '', 'price_action_not_confirming'), null);
  assert.equal(tradeEventFromToolUse('prophet_place_options_order', { symbol: 'TSLA251219C00400000', quantity: 1 }, JSON.stringify({ status: 'rejected', filled_qty: 0 })), null);
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

  const rejectedPartial = tradeEventFromToolUse('prophet_place_options_order', {
    symbol: 'TSLA251219C00400000', side: 'buy', quantity: 2, position_intent: 'buy_to_open',
  }, JSON.stringify({ order_id: 'broker-4', status: 'rejected', filled_qty: 1, filled_avg_price: 2.1, execution_confirmed: true }));
  assert.equal(rejectedPartial.executionConfirmed, true);
  assert.equal(rejectedPartial.lifecycle, 'partially_filled_rejected');
  assert.equal(rejectedPartial.quantity, 1);
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

test('realized ledger carries only verified entry AlphaDesk context, including score zero', () => {
  const metadata = JSON.stringify({ assessment_id: 'entry-assessment', decision: 'PASS', signal_score: 0,
    score_source: 'alphadesk_direct_market_data', observed_at: '2026-09-18T12:59:00Z',
    op2_effective_expires_at: '2026-09-18T13:01:00Z', evidence: { score_profile: 'catalyst_momentum_v1' } });
  const trades = buildTradeLedger([
    { ID: 'entry', ClientOrderID: 'entry-client', Symbol: 'AAPL', Side: 'buy', Purpose: 'entry',
      broker_identity_verified: true, entry_assessment: { assessmentId: 'entry-assessment', decision: 'PASS', signalScore: 0,
        scoreType: 'alphadesk_direct_market_data', observedAt: '2026-09-18T12:59:00Z', effectiveExpiresAt: '2026-09-18T13:01:00Z', scoreProfile: 'catalyst_momentum_v1' },
      Status: 'filled', FilledQty: 1, FilledAvgPrice: 100, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'exit', ClientOrderID: 'exit-client', Symbol: 'AAPL', Side: 'sell', Purpose: 'close', broker_identity_verified: true,
      broker_identity_verified: true, Metadata: JSON.stringify({ assessment_id: 'exit-must-not-attach', decision: 'PASS' }),
      Status: 'filled', FilledQty: 1, FilledAvgPrice: 110, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(trades.length, 1);
  assert.deepEqual(trades[0].entryAssessment, {
    assessmentId: 'entry-assessment', decision: 'PASS', signalScore: 0,
    scoreSource: 'alphadesk_direct_market_data', scoreProfile: 'catalyst_momentum_v1',
    observedAt: '2026-09-18T12:59:00Z', effectiveExpiresAt: '2026-09-18T13:01:00Z',
  });
  const unverified = buildTradeLedger([
    { ID: 'entry2', Symbol: 'MSFT', Side: 'buy', Purpose: 'entry', entry_assessment: { assessmentId: 'nope', decision: 'PASS', signalScore: 0 }, Status: 'filled', FilledQty: 1, FilledAvgPrice: 100, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'exit2', Symbol: 'MSFT', Side: 'sell', Status: 'filled', FilledQty: 1, FilledAvgPrice: 110, FilledAt: '2026-09-18T14:00:00Z' },
  ]);
  assert.equal(unverified[0].entryAssessment, null);
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

test('application lifecycle statuses never create trade telemetry', () => {
  for (const status of ['planned_for_next_session', 'risk_blocked', 'rejected_before_submission', 'planned_intent_not_broker_visible']) {
    assert.equal(tradeEventFromToolUse('prophet_place_options_order', { symbol: 'TSLA251219C00400000', quantity: 1 }, JSON.stringify({ status, filled_qty: 0 })), null, status);
  }
  for (const status of ['submit_failed', 'submission_uncertain']) {
    assert.equal(tradeEventFromToolUse('prophet_place_options_order', { symbol: 'TSLA251219C00400000', quantity: 1 }, JSON.stringify({ status, filled_qty: 0 })), null, status);
  }
});

test('ledger reconciles two broker-confirmed XLF close fills without duplicating either leg', () => {
  const trades = buildTradeLedger([
    { ID: 'xlf-entry', ClientOrderID: 'xlf-entry-client', Symbol: 'XLF', Side: 'buy', Status: 'filled', FilledQty: 100, FilledAvgPrice: 40, FilledAt: '2026-09-18T13:00:00Z' },
    { ID: 'xlf-close-43', ClientOrderID: 'xlf-close-43-client', Symbol: 'XLF', Side: 'sell', Status: 'filled', FilledQty: 43, FilledAvgPrice: 42, FilledAt: '2026-09-18T14:00:00Z' },
    { ID: 'xlf-close-57', ClientOrderID: 'xlf-close-57-client', Symbol: 'XLF', Side: 'sell', Status: 'filled', FilledQty: 57, FilledAvgPrice: 41, FilledAt: '2026-09-18T15:00:00Z' },
  ]);
  assert.equal(trades.length, 2);
  assert.deepEqual(trades.map(trade => trade.quantity).sort((a, b) => a - b), [43, 57]);
  assert.equal(trades.reduce((sum, trade) => sum + trade.pnl, 0), 143);
  assert.deepEqual([...new Set(trades.map(trade => trade.orderId))].sort(), ['xlf-close-43', 'xlf-close-57']);
});

test('zero maxOrderValue leaves permitted stock orders uncapped', () => {
  assert.doesNotThrow(() => checkPermissions('place_sell_order', {
    symbol: 'XLF', quantity: 10, limit_price: 100,
  }, { ...enabled, maxOrderValue: 0 }));
});

test('positive maxOrderValue still caps permitted stock orders', () => {
  assert.throws(
    () => checkPermissions('place_sell_order', {
      symbol: 'XLF', quantity: 11, limit_price: 100,
    }, { ...enabled, maxOrderValue: 1000 }),
    /exceeds max allowed/,
  );
});
