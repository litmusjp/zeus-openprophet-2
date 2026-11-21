import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../agent/harness.js';

// Nov 21 build, item P2: Pendulum (mean-reversion) on L2 (sbx_956ff9e4) must get the same saved-workflow sizing normalisation that
// Pendulum already gets on L1. Inert until a switch: no other agent or account changes.
const IDENTITY = 'You are Pendulum, a selective ETF mean-reversion trader who waits for a completed-bar rebound before entering.';
const STRATEGY = '- Trade liquid broad-market and sector ETFs after a statistically stretched move; require a reversal signal before entering.';
const TEMPORARY = '### TEMPORARY_ALPHA_MVP_OVERRIDE\n### ALPHA_MVP_MODE: MULTI_SESSION\nquantity one; two entry-and-exit cycles\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE';
const WORKFLOW = `### MARKET-OPEN ALPHADESK WORKFLOW
At the open: reconcile options positions, active broker orders, planned intents and uncertain submissions.
Select one exact eligible single-leg proposal at quantity 1. Read current managed policy and OP2 confirmation; if either is ON or unknown, do not submit.
If every proposal field is unchanged, submit this exact OCC contract, side='buy', quantity 1, and proposed positive limit premium once, then read the broker result.

### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
const SAVED = `${IDENTITY}\n\n${TEMPORARY}\n\n${WORKFLOW}`;
const build = (sandboxId, id) => buildSystemPrompt({ id, sandboxId, systemPromptTemplate: 'custom', customSystemPrompt: SAVED, strategyId: id },
  { getStrategyById: () => ({ customRules: STRATEGY }) });

test('P2: Pendulum on L2 loses the old quantity-one workflow strings and the temporary override, and keeps its identity and strategy', async () => {
  const prompt = await build('sbx_956ff9e4', 'mean-reversion');
  assert.ok(prompt.includes(IDENTITY));
  assert.ok(prompt.includes(STRATEGY));
  assert.equal(prompt.includes('Select one exact eligible single-leg proposal at quantity 1.'), false);
  assert.equal(prompt.includes("side='buy', quantity 1, and proposed positive limit premium"), false);
  assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE|ALPHA_MVP_MODE|quantity one|quantity 1/i);
  assert.match(prompt, /Select an exact eligible single-leg proposal within available account capacity and existing controls\./);
  assert.match(prompt, /the exact proposed quantity, and proposed positive limit premium once/);
});

test('P2: Pendulum on L1 is unchanged by the L2 addition (same normalisation as before)', async () => {
  const prompt = await build('sbx_723be98b', 'mean-reversion');
  assert.equal(prompt.includes('Select one exact eligible single-leg proposal at quantity 1.'), false);
  assert.match(prompt, /Select an exact eligible single-leg proposal within available account capacity and existing controls\./);
});

test('P2: the addition is exact: L2 Guardian, L2 Surge and L3 Prophet keep their previous behaviour', async () => {
  // Surge on L2 was already normalised; Guardian (conservative) on L2 and Prophet (default) on L3 are not mean-reversion agents.
  const surge = await build('sbx_956ff9e4', 'momentum');
  assert.equal(surge.includes('quantity 1,'), false);
  const prophet = await build('sbx_0d35471e', 'default');
  assert.equal(prophet.includes('Select one exact eligible single-leg proposal at quantity 1.'), false);
  // Agent consistency release: the shared workflow no longer depends on the slot, so Pendulum on L3 gets it too.
  const l3 = await build('sbx_0d35471e', 'mean-reversion');
  assert.equal(l3.includes('Select one exact eligible single-leg proposal at quantity 1.'), false, 'the shared workflow applies on every slot');
  assert.match(l3, /Select an exact eligible single-leg proposal within available account capacity and existing controls\./);
});
