import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt } from '../agent/harness.js';

// The two legacy "quantity 1" sentences exactly as they sat in the copied workflow text.
const legacyWorkflow = `### MARKET-OPEN ALPHADESK WORKFLOW
At the open: reconcile positions, active broker orders, planned intents and uncertain submissions.
Select one exact eligible single-leg proposal at quantity 1. Read current managed policy and OP2 confirmation; if either is ON or unknown, do not submit. Generate one stable client_order_id and submit this exact OCC contract, side='buy', quantity 1, and proposed positive limit premium once through prophet_place_options_order, which independently assesses at the broker boundary.
### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
const deps = { getStrategyById: () => ({ customRules: 'Rules.' }) };
const agent = (extra = {}) => ({ id: 'catalyst', sandboxId: 'sbx_723be98b', name: 'Herald', systemPromptTemplate: 'custom', strategyId: 'catalyst-news', customSystemPrompt: `You are Herald.\n\n${legacyWorkflow}`, ...extra });

test('Herald on L1 no longer carries the legacy quantity-one constraint', async () => {
  const prompt = await buildSystemPrompt(agent(), deps);
  assert.doesNotMatch(prompt, /quantity 1/);
  assert.match(prompt, /Select an exact eligible single-leg proposal within available account capacity and existing controls\./);
  assert.match(prompt, /side='buy', the exact proposed quantity, and proposed positive limit premium once/);
  // the shared 5% minimum sizing rule is the one that now applies
  assert.match(prompt, /no less than 5% of current account equity/);
});

test('the normalisation stays scoped: other sandboxes and agents keep their text unchanged', async () => {
  for (const extra of [{ sandboxId: 'sbx_956ff9e4' }, { id: 'someone-else' }]) {
    const prompt = await buildSystemPrompt(agent(extra), deps);
    assert.match(prompt, /Select one exact eligible single-leg proposal at quantity 1\./, JSON.stringify(extra));
  }
});
