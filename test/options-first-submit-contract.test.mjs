import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../agent/harness.js';

test('owned options workflow keeps assessment and first submission on one ID, separate from planned retries', async () => {
  const prompt = await buildSystemPrompt({
    id: 'mean-reversion', sandboxId: 'sbx_956ff9e4', name: 'Pendulum',
    systemPromptTemplate: 'custom',
    customSystemPrompt: `Pendulum identity and strategy remain unchanged.\n\n### MARKET-OPEN ALPHADESK WORKFLOW\nBefore open: prepare research.\nAssess: call prophet_assess_options_trade.\nAfter PASS: call prophet_place_options_order with the same proposal.\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW`,
  }, { getStrategyById: () => ({ customRules: 'Fixture strategy.' }) });

  assert.match(prompt, /Generate one stable client_order_id before assessment and use that exact value as client_reference/i);
  assert.match(prompt, /assessment and its unchanged first submission after PASS are one intent/i);
  assert.ok(/For options that require assessment, the assessment and its unchanged first submission after PASS are one intent/i.test(prompt), 'Options assessment semantics must be explicitly scoped to options.');
  assert.match(prompt, /generate a fresh `client_order_id` before assessment, pass it as `client_reference`, and use the same ID for the first submission/i);
  assert.match(prompt, /This first submission is not a retry/i);
  assert.match(prompt, /ONLY with unchanged immutable fields for an eligible persisted planned retry after complete reconciliation/i);
  assert.match(prompt, /never blindly retry an uncertain order/i);
});
