import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {
  nextDailySummaryAt, shouldNotifyTradeLifecycle, formatTradeSlackNotification,
  formatDailySummary, sanitizeSlackFailure, createSlackDailyCollector, runDailySummaryTick,
} from '../agent/slack-notifications.js';

test('daily summary scheduling uses the next 16:30 New York wall time across DST', () => {
  assert.equal(nextDailySummaryAt(new Date('2026-03-08T20:00:00Z')).toISOString(), '2026-03-08T20:30:00.000Z');
  assert.equal(nextDailySummaryAt(new Date('2026-11-01T22:00:00Z')).toISOString(), '2026-11-02T21:30:00.000Z');
});

test('trade lifecycle watermark suppresses unchanged snapshots but retains state changes', () => {
  const seen = new Map(), event = { accountId: 'a1', orderId: 'o1', lifecycle: 'partially_filled', filledQty: '1' };
  assert.equal(shouldNotifyTradeLifecycle(seen, event), true);
  assert.equal(shouldNotifyTradeLifecycle(seen, event), false);
  assert.equal(shouldNotifyTradeLifecycle(seen, { ...event, filledQty: '2' }), true);
  assert.equal(shouldNotifyTradeLifecycle(seen, { ...event, accountId: 'a2' }), true);
});

test('trade notification separates broker state from verified fill and preserves assessment zero', () => {
  const base = { account: 'Paper A', agent: 'Mean Reversion', side: 'buy', symbol: 'QQQ', requestedQty: '2', status: 'accepted', brokerOrderId: 'o1', timestamp: '2026-10-29T14:00:00Z' };
  const message = formatTradeSlackNotification({ ...base, confirmedQty: '1', brokerIdentityVerified: true,
    assessment: { decision: 'PASS', signalScore: 0, catalystConfidence: 0, scoreProfile: 'catalyst_momentum_v1', scoreType: 'alphadesk', directionalMomentum: 0 } });
  assert.match(message, /Broker status: accepted/);
  assert.match(message, /Broker-confirmed fill: 1/);
  assert.match(message, /At-entry assessment: PASS/);
  assert.match(message, /Signal score: 0\/100/);
  assert.match(message, /Catalyst confidence: 0%/);
  assert.match(message, /Directional momentum contribution: 0 of 0\.20 weighted fraction/);
  assert.match(message, /Source: alphadesk/);
  assert.match(formatTradeSlackNotification({ ...base, confirmedQty: '1' }), /Broker-confirmed fill: Unavailable/);
  assert.match(formatTradeSlackNotification({ side: 'sell' }), /Signal score: Unavailable/);
  assert.match(formatTradeSlackNotification({ ...base, assessment: { scoreProfile: 'other', directionalMomentum: 0.18 } }), /Directional momentum contribution: Unavailable/);
});

test('daily summary renders valid account values and the real ManagedPosition DTO without false zeros', () => {
  const message = formatDailySummary({ date: '2026-10-29', accountName: 'Paper A', complete: false,
    account: { Equity: '12000', LastEquity: '11900', Cash: '3000', DailyPnLValid: true },
    positions: [{ symbol: 'QQQ', quantity: 1, entry_price: 20, unrealized_pl: 0 }], orders: [], trades: [] });
  assert.match(message, /2026-10-29 ET \(00:00–23:59\)/);
  assert.match(message, /Account: Paper A \(account-wide\)/);
  assert.match(message, /Daily account-wide change: \+\$100\.00/);
  assert.match(message, /Cash: \$3000\.00/);
  assert.match(message, /QQQ 1 \(unrealized P\/L \$0\.00\)/);
  assert.match(message, /Order activity: Incomplete/);
  assert.match(formatDailySummary({ account: { Equity: '', LastEquity: '5', DailyPnLValid: true } }), /Daily account change: Unavailable/);
});

test('daily activity counts unique verified broker orders by fill time and labels matched P/L before fees', () => {
  const message = formatDailySummary({ date: '2026-10-29', accountName: 'Paper A', complete: true, positions: [],
    orders: [
      { ID: 'today', FilledQty: '1', FilledAt: '2026-10-29T12:00:00Z', broker_identity_verified: true, inSummaryWindow: true },
      { ID: 'today', FilledQty: '2', FilledAt: '2026-10-29T12:01:00Z', broker_identity_verified: true, inSummaryWindow: true },
      { ID: 'unverified', FilledQty: '5', FilledAt: '2026-10-29T12:00:00Z', inSummaryWindow: true },
      { ID: 'old', FilledQty: '4', FilledAt: '2026-10-28T12:00:00Z', broker_identity_verified: true, inSummaryWindow: false },
    ], trades: [{ pnl: 12.5, inSummaryWindow: true }, { pnl: 88, inSummaryWindow: false }] });
  assert.match(message, /Order activity: 1 broker-confirmed orders with fills/);
  assert.match(message, /Matched realized P\/L before fees: \$12\.50/);
});

test('shared collector reads account, positions, and reconciled orders; absent backend remains unavailable', async () => {
  const at = new Date('2026-10-29T16:00:00Z'); let gets = 0, reconciles = 0;
  const collector = createSlackDailyCollector({ now: () => at,
    getSandbox: id => id === 'sbx-a' ? { id, accountId: 'acct-a' } : null,
    getAccount: id => id === 'acct-a' ? { name: 'Paper A' } : null,
    getClient: () => ({ get: async route => { gets += 1; return { data: route.endsWith('account')
      ? { Equity: 100, LastEquity: 90, Cash: 20, DailyPnLValid: true }
      : [{ symbol: 'QQQ', quantity: 2, entry_price: 4, unrealized_pl: 0 }] }; } }),
    reconcile: async () => { reconciles += 1; return { complete: true, orders: [
      { ID: 'o1', FilledQty: '1', FilledAt: '2026-10-29T15:00:00Z', broker_identity_verified: true },
      { ID: 'o2', FilledQty: '0', FilledAt: '2026-10-29T15:00:00Z' },
    ] }; }, buildLedger: () => [{ pnl: 3, exitTime: '2026-10-29T15:30:00Z' }],
  });
  const report = await collector('sbx-a', at);
  assert.equal(gets, 2); assert.equal(reconciles, 1);
  assert.match(report.summary, /QQQ 2 \(unrealized P\/L \$0\.00\)/);
  assert.match(report.summary, /Order activity: 1 broker-confirmed orders with fills/);
  assert.match(report.summary, /Matched realized P\/L before fees: \$3\.00/);
  const missing = createSlackDailyCollector({ getSandbox: () => ({ accountId: 'a' }), getAccount: () => ({ name: 'Paper' }), getClient: () => null,
    reconcile: async () => ({ complete: false, orders: [] }), buildLedger: () => [], now: () => at });
  assert.match((await missing('sbx-a', at)).summary, /Daily account change: Unavailable/);
});

test('daily scheduler seam reschedules after send failure and missing backend report', async () => {
  let rescheduled = 0, errors = 0, delivered = '';
  await runDailySummaryTick({ sandboxId: 'sbx-a', at: new Date(), enabled: () => true,
    collect: async () => ({ summary: 'incomplete report' }), deliver: async summary => { delivered = summary; throw new Error('send failed'); },
    onError: () => { errors += 1; }, reschedule: () => { rescheduled += 1; } });
  assert.equal(delivered, 'incomplete report'); assert.equal(errors, 1); assert.equal(rescheduled, 1);
});

test('production preview handler uses shared collector and performs no delivery or settings writes', async () => {
  const server = await fs.readFile('agent/server.js', 'utf8');
  const start = server.indexOf('function scheduleDailySummaryForHarness'), end = server.indexOf('function bindOperationalHooks', start);
  const scheduler = server.slice(start, end);
  const preview = server.slice(server.indexOf("app.get('/api/plugins/slack/preview'"), server.indexOf("app.post('/api/plugins/slack/test'"));
  const verify = server.slice(server.indexOf("app.post('/api/plugins/slack/test'"), server.indexOf('// Verified trade ledger'));
  assert.match(scheduler, /runDailySummaryTick/); assert.match(scheduler, /collect: collectSlackDailySummary/);
  assert.match(preview, /collectSlackDailySummary\(sandboxId\)/);
  assert.doesNotMatch(preview, /notifySlack|slackDeliveryStatus|saveConfig|orchestrator\.start/);
  assert.match(verify, /VERIFICATION/); assert.match(verify, /collectSlackDailySummary\(sandboxId\)/);
  assert.match(server, /getClient: getExistingGoClientForSandbox/);
  assert.match(server, /slackDelivery:\s*slackStatusForSandbox\(req\.params\.id\)/);
  const ui = await fs.readFile('agent/public/index.html', 'utf8');
  const slack = ui.slice(ui.indexOf('function renderSlack()'), ui.indexOf('let _slackTimer'));
  const prompt = ui.slice(ui.indexOf('async function renderPromptPreview()'), ui.indexOf('async function activateSelectedSandbox()'));
  assert.match(slack, /slack-delivery-status/); assert.doesNotMatch(prompt, /slack-delivery-status/);
});

test('Slack failure text is bounded and strips webhook secrets', () => {
  const text = sanitizeSlackFailure(new Error('POST https://hooks.slack.com/services/T123/B456/secret failed: socket hang up'));
  assert.doesNotMatch(text, /T123|B456|secret/); assert.ok(text.length <= 160);
});
