import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentHarness, recoverHeldPositionPlans } from '../agent/harness.js';
import { ChatStore } from '../agent/chat-store.js';

const thesis = 'QQQ completed a daily rebound setup on 2026-10-23 by undercutting the preceding session low at 701.94 to a reversal low of 701.18 and closing above its open at 704.21. The current 2026-10-26 open has materially confirmed strength after the earlier rejected proposal: the latest completed 1-minute bar closed 708.06 above its 707.75 open, and the live underlying quote is 707.73 bid / 708.09 ask. QQQ remains below the calculated 20-day average of 735.20. Buy one November 20, 2026 732 call at an 8.15 premium limit, with an underlying target near 735.20, numerical invalidation on a completed daily close below 701.18, and a conditional time exit if no completed underlying daily close is above 708.06 by the end of the third completed trading session. This is a paper quantity-one entry; exits require agent-managed sell_to_close because broker-held option stops/OCO are unavailable.';
const position = {
  BrokerAccountID: 'c3051a39-0470-4852-9297-e348a407bb51', PaperLive: 'paper', TenantID: '723be98b', SandboxID: 'sbx_723be98b',
  Symbol: 'QQQ261120C00732000', Underlying: 'QQQ', Qty: 1, AvgEntryPrice: 8.03, Side: 'long',
};
const liveOrder = {
  BrokerAccountID: position.BrokerAccountID, PaperLive: 'paper', TenantID: position.TenantID, SandboxID: position.SandboxID,
  Symbol: position.Symbol, PositionIntent: 'buy_to_open', Side: 'buy', Status: 'filled', FilledQty: 1, FilledAvgPrice: 8.03,
  ID: '5321b8e6-b366-4157-a596-5dfe336a93e1', ClientOrderID: 'pendulum-20261026-qqq-c732-4b7e91',
};

async function seededStore(dir, accountId = '723be98b') {
  const store = new ChatStore(dir);
  await store.startSession(accountId, 'same-session', { sandboxId: 'sbx_723be98b', agentId: 'mean-reversion', agentName: 'Pendulum' });
  await store.addMessage(accountId, 'same-session', {
    kind: 'tool_call', eventType: 'tool_call', tool: 'place_options_order', status: 'completed',
    args: { client_order_id: liveOrder.ClientOrderID, symbol: liveOrder.Symbol, position_intent: 'buy_to_open', thesis },
    result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({
      broker_account_id: position.BrokerAccountID, paper_live: 'paper', tenant_id: position.TenantID,
      sandbox_id: position.SandboxID, order_id: liveOrder.ID, client_order_id: liveOrder.ClientOrderID,
      status: 'pending_new', filled_qty: 0, symbol: position.Symbol,
    }) }] }),
  });
  return store;
}

test('original plan reloads from persisted receipt each held-position management turn with account and lot binding', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'position-plan-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await seededStore(dir);
  const snapshot = { positions: [position], orders: [liveOrder], ordersComplete: true };
  const makeHarness = chatStore => {
    const prompts = [];
    const harness = new AgentHarness({ sandboxId: position.SandboxID, accountId: '723be98b', chatStore,
      getCurrentPhaseFn: () => 'closed', getHeldPositionSnapshot: async () => snapshot });
    harness.state.activeAccountId = '723be98b';
    harness._sessionId = 'same-session';
    harness._runClaude = async prompt => {
      prompts.push(prompt);
      return { text: 'ok', sessionId: 'same-session', sessionEpoch: harness._sessionEpoch, toolEvents: [] };
    };
    return { harness, prompts };
  };

  const first = makeHarness(store);
  await first.harness._beat();
  assert.match(first.prompts[0], /ORIGINAL EXIT PLAN CONTEXT \(historical entry receipts/);
  assert.ok(first.prompts[0].includes(thesis));
  assert.match(first.harness.state.toJSON().positionPlanContext.status, /^matched$/);
  assert.equal(first.harness.state.toJSON().positionPlanContext.matches[0].entryBrokerId, liveOrder.ID);
  first.harness.state.activeAccountId = '956ff9e4';
  assert.equal(first.harness.state.toJSON().positionPlanContext.status, 'unavailable');
  assert.equal(first.harness.state.toJSON().positionPlanContext.matches.length, 0);
  first.harness.state.activeAccountId = '723be98b';
  // The active session continues; the next scheduled turn fetches and injects again.
  await first.harness._beat();
  assert.ok(first.prompts[1].includes(thesis));
  first.harness.state.running = true;
  await first.harness._adHocBeat('What was the original exit plan?');
  assert.ok(first.prompts[2].includes(thesis));
  assert.match(first.prompts[2], /USER MESSAGE: What was the original exit plan\?/);

  // New ChatStore instance after a restart, retaining the same OpenCode session ID.
  const reopened = new ChatStore(dir);
  await reopened.startSession('723be98b', 'same-session', { sandboxId: position.SandboxID });
  const resumed = makeHarness(reopened);
  await resumed.harness._beat();
  assert.ok(resumed.prompts[0].includes(thesis));
  resumed.harness.state.running = true;
  await resumed.harness._adHocBeat('Show the original position plan.');
  assert.ok(resumed.prompts[1].includes(thesis));
  assert.match(resumed.prompts[1], /USER MESSAGE: Show the original position plan\./);

  const l2 = new AgentHarness({ sandboxId: 'sbx_956ff9e4', accountId: '956ff9e4', chatStore: reopened,
    getHeldPositionSnapshot: async () => ({ positions: [], orders: [], ordersComplete: true }) });
  l2.state.activeAccountId = '956ff9e4';
  const flat = await l2._heldPositionPlanContext('956ff9e4');
  assert.equal(l2.state.toJSON().positionPlanContext.status, 'flat');
  assert.match(flat, /no held option lot/);
  assert.doesNotMatch(flat, /735\.20|701\.18|708\.06/);

  const wrongScope = await makeHarness(reopened).harness._heldPositionPlanContext('956ff9e4');
  assert.doesNotMatch(wrongScope, /735\.20|701\.18|708\.06/);
});

test('failed or ambiguous entry evidence never supplies an original plan', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'position-plan-invalid-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = await seededStore(dir);
  await store.addMessage('723be98b', 'same-session', {
    kind: 'tool_call', eventType: 'tool_call', tool: 'place_options_order', status: 'error', error: 'rejected',
    args: { client_order_id: 'failed', symbol: position.Symbol, position_intent: 'buy_to_open', thesis: 'wrong plan' },
    result: '',
  });
  const harness = new AgentHarness({ sandboxId: position.SandboxID, accountId: '723be98b', chatStore: store,
    getHeldPositionSnapshot: async () => ({ positions: [position], orders: [liveOrder, { ...liveOrder, ID: 'duplicate-entry' }], ordersComplete: true }) });
  harness.state.activeAccountId = '723be98b';
  const context = await harness._heldPositionPlanContext('723be98b');
  assert.match(context, /no unique original entry receipt/);
  assert.doesNotMatch(context, /735\.20|wrong plan/);
});

test('plan recovery requires exact acknowledged broker and client IDs and excludes a closed old lot', () => {
  const receipt = {
    broker_account_id: position.BrokerAccountID, paper_live: 'paper', tenant_id: position.TenantID, sandbox_id: position.SandboxID,
    order_id: liveOrder.ID, client_order_id: liveOrder.ClientOrderID, status: 'pending_new', filled_qty: 0,
  };
  const record = (result, args = {}) => ({ kind: 'tool_call', tool: 'place_options_order', status: 'completed',
    args: { symbol: position.Symbol, position_intent: 'buy_to_open', client_order_id: liveOrder.ClientOrderID, thesis, ...args },
    result: JSON.stringify(result) });
  const recover = (receiptValue, liveOrders = [liveOrder], currentPosition = position) => recoverHeldPositionPlans({
    accountId: '723be98b', sandboxId: position.SandboxID, positions: [currentPosition], orders: liveOrders,
    ordersComplete: true, evidence: [{ accountId: '723be98b', messages: [record(receiptValue)] }],
  });

  assert.equal(recover({ ...receipt, status: 'submit_failed', order_id: undefined }).length, 0, 'same client ID with failed receipt and no broker ID');
  assert.equal(recover({ ...receipt, order_id: 'conflicting-broker-id' }).length, 0, 'client ID cannot bypass broker ID conflict');
  assert.equal(recover(receipt, [liveOrder, { ...liveOrder, ID: 'old-closed-lot' }]).length, 0, 'same-symbol old and new lots remain ambiguous');
  assert.equal(recover(receipt, [liveOrder], { ...position, TenantID: 'another-account' }).length, 0, 'tenant/account identity must match');
});
