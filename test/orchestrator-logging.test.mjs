import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowGoLogLine } from '../agent/go-log-filter.js';

const reconciliationNoise = [
  'time="2026-09-18T02:10:32Z" level=info msg="Reconcile: order not confirmed at broker, leaving as-is" client_order_id=op-example error="order not found for op-example (HTTP 404, Code 40410000)"',
  'time="2026-09-18T02:10:32Z" level=info msg="Reconcile: startup order reconciliation complete" reconciled=0 skipped=6 total=6',
  'time="2026-09-18T02:10:32Z" level=info msg="Startup order reconciliation complete" reconciled=0 skipped=6',
];

const startupNoise = [
  'time="2026-09-18T02:17:19Z" level=info msg="Starting Prophet Trader Bot..."',
  'time="2026-09-18T02:17:19Z" level=info msg="Initializing services..."',
  'time="2026-09-18T02:17:19Z" level=info msg="Testing Alpaca connection..."',
  'time="2026-09-18T02:17:19Z" level=info msg="Successfully connected to Alpaca" buying_power=406113.84',
  'time="2026-09-18T02:17:19Z" level=info msg="Loaded managed positions from database" count=0',
  '{"date":"2026-09-18","level":"info","msg":"Trading session started","starting_capital":101528.46}',
  'time="2026-09-18T02:17:19Z" level=info msg="Activity logging session started"',
  'time="2026-09-18T02:17:19Z" level=info msg="Position monitoring started"',
  'time="2026-09-18T02:17:19Z" level=info msg="Starting HTTP server..." host=127.0.0.1 port=4534',
];

test('hides routine order-reconciliation info from sandbox terminals', () => {
  for (const line of reconciliationNoise) {
    assert.equal(shouldShowGoLogLine(line), false, line);
  }
});

test('hides routine Go startup info from sandbox terminals', () => {
  for (const line of startupNoise) {
    assert.equal(shouldShowGoLogLine(line), false, line);
  }
});

test('keeps meaningful Go errors and non-reconciliation info visible', () => {
  assert.equal(
    shouldShowGoLogLine('time="2026-09-18T02:10:32Z" level=error msg="broker connection failed"'),
    true,
  );
  assert.equal(
    shouldShowGoLogLine('time="2026-09-18T02:10:32Z" level=info msg="Trading backend ready"'),
    true,
  );
});
