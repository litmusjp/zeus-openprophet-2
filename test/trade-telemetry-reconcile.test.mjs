import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeTradeUpdate, reconcilePendingTrades } from '../agent/trade-telemetry.js';
import { AgentHarness } from '../agent/harness.js';

const pending = {
  type: 'order', orderId: 'order-1', clientOrderId: 'client-1', symbol: 'QQQ261127C00754000',
  side: 'buy', quantity: 1, requestedQuantity: 1, status: 'pending_new', lifecycle: 'submitted', executionConfirmed: false,
  accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a',
  brokerAccountId: 'broker-a', paperLive: 'paper', tenantId: 'acct-a',
};
const filled = {
  ID: 'order-1', ClientOrderID: 'client-1', Symbol: pending.symbol, Side: 'buy', Qty: 1,
  Status: 'filled', FilledQty: 1, FilledAvgPrice: 6.28, FilledAt: '2026-10-28T13:31:17.8Z',
  TenantID: 'acct-a', SandboxID: 'sbx-a', PaperLive: 'paper', BrokerAccountID: 'broker-a',
};

test('complete exact-identity broker evidence reconciles an actor-bound acknowledgement once', () => {
  const updates = reconcilePendingTrades({
    trades: [pending], orders: [filled], ordersComplete: true,
    accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a',
  });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    orderId: 'order-1', status: 'filled', lifecycle: 'filled', executionConfirmed: true,
    fullFill: true, quantity: 1, price: 6.28, filledAt: '2026-10-28T13:31:17.8Z',
  });
  const countedExecutions = new Set();
  const merged = mergeTradeUpdate([pending], { ...pending, ...updates[0] }, countedExecutions);
  const repeated = mergeTradeUpdate(merged.trades, { ...pending, ...updates[0] }, countedExecutions);
  assert.equal(repeated.trades.length, 1);
  assert.equal(merged.newlyConfirmed + repeated.newlyConfirmed, 1);
  assert.equal(repeated.trades[0].price, 6.28);
});

test('incomplete, mismatched, and malformed broker evidence cannot confirm a pending row', () => {
  for (const options of [
    { ordersComplete: false, orders: [filled], accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' },
    { ordersComplete: true, orders: [{ ...filled, ID: 'other-order' }], accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' },
    { ordersComplete: true, orders: [filled], accountId: 'acct-b', sandboxId: 'sbx-a', agentId: 'agent-a' },
    { ordersComplete: true, orders: [filled], accountId: 'acct-a', sandboxId: 'sbx-b', agentId: 'agent-a' },
    { ordersComplete: true, orders: [filled], accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-b' },
    { ordersComplete: true, orders: [{ ...filled, FilledAvgPrice: 0 }], accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' },
    { ordersComplete: true, orders: [{ ...filled, FilledAt: undefined }], accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' },
  ]) {
    assert.deepEqual(reconcilePendingTrades({ trades: [pending], ...options }), []);
  }
});

test('canceled partial broker fills keep their actual quantity, price, and fill time', () => {
  const updates = reconcilePendingTrades({
    trades: [pending], orders: [{ ...filled, Status: 'canceled', FilledQty: 0.4, Qty: 1, FilledAvgPrice: 6.11 }],
    ordersComplete: true, accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a',
  });
  assert.equal(updates[0]?.lifecycle, 'partially_filled_canceled');
  assert.equal(updates[0]?.quantity, 0.4);
  assert.equal(updates[0]?.price, 6.11);
});

test('native row identity and quantities must agree with acknowledgement and active scope', () => {
  const conflicts = [
    { ...filled, TenantID: 'acct-b' }, { ...filled, SandboxID: 'sbx-b' },
    { ...filled, PaperLive: 'live' }, { ...filled, BrokerAccountID: 'broker-b' },
    { ...filled, TenantID: undefined }, { ...filled, Qty: 2 }, { ...filled, FilledQty: 2 },
    { ...filled, Status: 'filled', FilledQty: 0.5 },
  ];
  for (const order of conflicts) assert.deepEqual(reconcilePendingTrades({
    trades: [pending], orders: [order], ordersComplete: true,
    accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a',
  }), []);
});

test('partial executions advance monotonically to full without double counting', () => {
  const partial = { ...filled, Status: 'partially_filled', FilledQty: 0.4, FilledAvgPrice: 6.1, FilledAt: '2026-10-28T13:31:17.5Z' };
  const partialUpdate = reconcilePendingTrades({ trades: [pending], orders: [partial], ordersComplete: true, accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' })[0];
  let trades = [pending];
  const counted = new Set();
  let counts = 0;
  for (const update of [partialUpdate, reconcilePendingTrades({ trades: [{ ...pending, ...partialUpdate }], orders: [filled], ordersComplete: true, accountId: 'acct-a', sandboxId: 'sbx-a', agentId: 'agent-a' })[0], partialUpdate, { ...pending, executionConfirmed: false, lifecycle: 'submitted' }]) {
    const result = mergeTradeUpdate(trades, { ...pending, ...update }, counted);
    trades = result.trades;
    counts += result.newlyConfirmed;
  }
  assert.equal(trades.length, 1);
  assert.equal(trades[0].lifecycle, 'filled');
  assert.equal(trades[0].quantity, 1);
  assert.equal(counts, 1);
});

test('duplicate acknowledgement callback upserts the matching order row', () => {
  const { trades, newlyConfirmed } = mergeTradeUpdate([pending], { ...pending, timestamp: 'later' });
  assert.equal(trades.length, 1);
  assert.equal(trades[0].timestamp, 'later');
  assert.equal(newlyConfirmed, 0);
});

test('heartbeat reconciliation updates one live row and counts once in the active account and run', async () => {
  const harness = new AgentHarness({
    sandboxId: 'sbx-a', accountId: 'acct-a',
    getHeldPositionSnapshot: async () => ({ positions: [], orders: [filled], ordersComplete: true }),
    chatStore: { listOrderActorEvidence: async () => [] },
  });
  harness.state.activeAccountId = 'acct-a';
  harness.state.activeSandboxId = 'sbx-a';
  harness.state.activeAgentId = 'agent-a';
  harness.state.addTrade(pending);
  harness.state.addTrade(pending); // repeated tool callback for the same order
  await harness._heldPositionPlanContext('acct-a');
  await harness._heldPositionPlanContext('acct-a'); // repeated complete snapshot
  assert.equal(harness.state.stats.trades, 1);
  assert.equal(harness.state.recentTrades.length, 1);
  assert.equal(harness.state.recentTrades[0].lifecycle, 'filled');
  assert.equal(harness.state.recentTrades[0].price, 6.28);

  harness.state.resetTradeTelemetry(); // same reset hook called by the ordinary start path
  assert.equal(harness.state.countedTradeExecutions.size, 0);
  harness.state.activeAccountId = 'acct-b';
  harness.state.activeSandboxId = 'sbx-b';
  harness.state.activeAgentId = 'agent-b';
  harness.state.addTrade(pending);
  await harness._heldPositionPlanContext('acct-b');
  assert.equal(harness.state.stats.trades, 0);
  assert.equal(harness.state.recentTrades[0].executionConfirmed, false);
});

test('stale tool callback from an earlier session cannot add trade telemetry', () => {
  const harness = new AgentHarness({ sandboxId: 'sbx-a', accountId: 'acct-a' });
  harness.state.activeAccountId = 'acct-a';
  harness.state.activeSandboxId = 'sbx-a';
  harness.state.activeAgentId = 'agent-a';
  harness._sessionEpoch = 2;
  harness._handleOpenCodeEvent({
    type: 'tool_use', sessionID: 'old-session',
    part: { tool: 'prophet_place_options_order', state: { input: { symbol: pending.symbol, side: 'buy', quantity: 1 }, output: JSON.stringify({ order_id: 'stale-order', status: 'pending_new' }) } },
  }, { sessionEpoch: 1, accountId: 'acct-a', sandboxId: 'sbx-a', actorSnapshot: { agentId: 'agent-a' }, setSession() {}, addToolCall() {}, recordToolEvent() {}, addCost() {}, addTokens() {} });
  assert.equal(harness.state.recentTrades.length, 0);
  assert.equal(harness.state.stats.trades, 0);
});
