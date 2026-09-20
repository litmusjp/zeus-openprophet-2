import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDailyPnl } from '../agent/daily-pnl.js';

test('account daily P&L uses broker equity, not portfolio value or cash', () => {
  assert.deepEqual(accountDailyPnl({ Equity: 9500, LastEquity: 10000, Cash: 12000, DailyPnLValid: true }), {
    equity: 9500, lastEquity: 10000, pnl: -500, percent: -5,
  });
});

test('account daily P&L fails closed for missing or invalid broker fields', () => {
  assert.equal(accountDailyPnl({ PortfolioValue: 9500, Cash: 12000, LastEquity: 10000 }), null);
  assert.equal(accountDailyPnl({ Equity: 9500, LastEquity: 0, DailyPnLValid: true }), null);
  assert.equal(accountDailyPnl({ Equity: 9500, LastEquity: 10000, DailyPnLValid: false }), null);
});
