import test from 'node:test';
import assert from 'node:assert/strict';
import { tradingPolicyEnvironment, DEFAULT_ALLOWED_STRUCTURES, KNOWN_STRUCTURES } from '../agent/defaults.js';

// Phase C, Step 4: the allowedStructures sandbox permission reaches the Go policy as OPENPROPHET_ALLOWED_STRUCTURES.

test('the default permission is today\'s behaviour: single long legs only', () => {
  assert.deepEqual(DEFAULT_ALLOWED_STRUCTURES, ['long_call', 'long_put']);
  assert.equal(tradingPolicyEnvironment({}).OPENPROPHET_ALLOWED_STRUCTURES, 'long_call,long_put');
  assert.equal(tradingPolicyEnvironment(null).OPENPROPHET_ALLOWED_STRUCTURES, 'long_call,long_put');
  assert.equal(tradingPolicyEnvironment({ allowedStructures: [] }).OPENPROPHET_ALLOWED_STRUCTURES, 'long_call,long_put');
  assert.equal(tradingPolicyEnvironment({ allowedStructures: 'bull_call_debit' }).OPENPROPHET_ALLOWED_STRUCTURES, 'long_call,long_put', 'a non-array value falls back to the default');
});

test('an explicit list is passed through unchanged for the Go policy to validate', () => {
  assert.equal(tradingPolicyEnvironment({ allowedStructures: ['long_call', 'bull_call_debit'] }).OPENPROPHET_ALLOWED_STRUCTURES, 'long_call,bull_call_debit');
  assert.equal(tradingPolicyEnvironment({ allowedStructures: ['butterfly'] }).OPENPROPHET_ALLOWED_STRUCTURES, 'butterfly', 'an unknown name is not hidden here; the Go policy marks itself invalid and blocks execution');
});

test('every other policy variable is unchanged by the new permission', () => {
  const env = tradingPolicyEnvironment({ allowOptions: true, maxPositionPct: 15, maxDeployedPct: 80, maxOpenPositions: 10, maxDailyLoss: 5, requireConfirmation: false });
  assert.equal(env.OPENPROPHET_ALLOW_OPTIONS, 'true');
  assert.equal(env.OPENPROPHET_MAX_DEPLOYED_PCT, '80');
  assert.equal(env.OPENPROPHET_REQUIRE_CONFIRMATION, 'false');
  assert.deepEqual(Object.keys(env).filter(key => key !== 'OPENPROPHET_ALLOWED_STRUCTURES').sort(), [
    'OPENPROPHET_ALLOW_0DTE', 'OPENPROPHET_ALLOW_LIVE_TRADING', 'OPENPROPHET_ALLOW_OPTIONS', 'OPENPROPHET_ALLOW_PAPER_TRADING', 'OPENPROPHET_ALLOW_STOCKS',
    'OPENPROPHET_MAX_DAILY_LOSS', 'OPENPROPHET_MAX_DEPLOYED_PCT', 'OPENPROPHET_MAX_OPEN_POSITIONS', 'OPENPROPHET_MAX_ORDER_VALUE', 'OPENPROPHET_MAX_POSITION_PCT', 'OPENPROPHET_REQUIRE_CONFIRMATION',
  ]);
});

test('the known structures are exactly the four the Go classifier supports', () => {
  assert.deepEqual([...KNOWN_STRUCTURES].sort(), ['bear_put_debit', 'bull_call_debit', 'long_call', 'long_put']);
});
