import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldShowGoLogLine } from '../agent/go-log-filter.js';

const reconciliationNoise = [
  'time="2026-09-18T02:10:32Z" level=info msg="Reconcile: order not confirmed at broker, leaving as-is" client_order_id=op-example error="order not found for op-example (HTTP 404, Code 40410000)"',
  'time="2026-09-18T02:10:32Z" level=info msg="Reconcile: startup order reconciliation complete" reconciled=0 skipped=6 total=6',
  'time="2026-09-18T02:10:32Z" level=info msg="Startup order reconciliation complete" reconciled=0 skipped=6',
];

test('hides routine order-reconciliation info from sandbox terminals', () => {
  for (const line of reconciliationNoise) {
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
