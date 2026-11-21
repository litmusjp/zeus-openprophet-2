import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTradeLedger } from '../agent/trade-ledger.js';

// Phase C, Step 4: a multi-leg spread is one trade in the realized ledger. Single-leg orders are unchanged.

const LOW = 'AAPL261218C00200000';
const HIGH = 'AAPL261218C00210000';
const legs = (intent, sides) => [
  { symbol: LOW, side: sides[0], ratio_qty: 1, position_intent: `${intent[0]}` },
  { symbol: HIGH, side: sides[1], ratio_qty: 1, position_intent: `${intent[1]}` },
];
const entry = (over = {}) => ({ ID: 'e1', ClientOrderID: 'grp-1', Symbol: LOW, Side: 'buy', Status: 'filled', FilledQty: 2, FilledAvgPrice: 3, FilledAt: '2026-11-23T15:00:00Z', option_legs: legs(['buy_to_open', 'sell_to_open'], ['buy', 'sell']), ...over });
const exit = (over = {}) => ({ ID: 'x1', ClientOrderID: 'grp-1-close', Symbol: LOW, Side: 'sell', Status: 'filled', FilledQty: 2, FilledAvgPrice: 4.5, FilledAt: '2026-11-24T15:00:00Z', option_legs: legs(['sell_to_close', 'buy_to_close'], ['sell', 'buy']), ...over });

test('a closed spread realises (credit - debit) x units x 100 as one trade', () => {
  const trades = buildTradeLedger([entry(), exit()]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 300); // (4.50 - 3.00) x 2 x 100
  assert.equal(trades[0].quantity, 2);
  assert.equal(trades[0].entryPrice, 3);
  assert.equal(trades[0].exitPrice, 4.5);
  assert.equal(trades[0].assetType, 'option');
  assert.equal(trades[0].structure, 'spread');
  assert.deepEqual(trades[0].legs, [LOW, HIGH]);
  assert.equal(trades[0].pnlPercent, 50);
});

test('the leg order and the parent symbol never change the match, and a losing exit is negative', () => {
  const reordered = exit({ Symbol: HIGH, option_legs: [...legs(['sell_to_close', 'buy_to_close'], ['sell', 'buy'])].reverse(), FilledAvgPrice: 1.0 });
  const trades = buildTradeLedger([entry(), reordered]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, -400); // (1.00 - 3.00) x 2 x 100
});

test('a partial close realises only the closed units and leaves the rest open', () => {
  const trades = buildTradeLedger([entry(), exit({ FilledQty: 1, FilledAvgPrice: 5 })]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].quantity, 1);
  assert.equal(trades[0].pnl, 200);
});

test('an open spread has no realised P/L, and mixed or unreadable legs are never booked as a single-leg trade', () => {
  assert.equal(buildTradeLedger([entry()]).length, 0);
  const mixed = exit({ option_legs: [{ symbol: LOW, side: 'sell', position_intent: 'sell_to_close' }, { symbol: HIGH, side: 'sell', position_intent: 'sell_to_open' }] });
  assert.equal(buildTradeLedger([entry(), mixed]).length, 0);
  const unreadable = exit({ option_legs: [{ symbol: LOW, position_intent: 'sell_to_close' }, { position_intent: 'buy_to_close' }] });
  assert.equal(buildTradeLedger([entry(), unreadable]).length, 0);
});

test('single-leg orders still match by symbol exactly as before', () => {
  const single = (id, side, price, at) => ({ ID: id, ClientOrderID: id, Symbol: LOW, Side: side, Status: 'filled', FilledQty: 1, FilledAvgPrice: price, FilledAt: at });
  const trades = buildTradeLedger([single('s1', 'buy', 5, '2026-11-23T15:00:00Z'), single('s2', 'sell', 6, '2026-11-23T16:00:00Z')]);
  assert.equal(trades.length, 1);
  assert.equal(trades[0].pnl, 100);
  assert.equal('structure' in trades[0], false);
  // A spread and a single leg on the same contract never net against each other.
  const mixedBook = buildTradeLedger([single('s1', 'buy', 5, '2026-11-23T15:00:00Z'), entry({ FilledAt: '2026-11-23T15:30:00Z' }), exit({ FilledAt: '2026-11-23T16:00:00Z' }), single('s2', 'sell', 6, '2026-11-23T17:00:00Z')]);
  assert.equal(mixedBook.length, 2);
  assert.deepEqual(mixedBook.map(trade => trade.pnl).sort((a, b) => a - b), [100, 300]);
});
