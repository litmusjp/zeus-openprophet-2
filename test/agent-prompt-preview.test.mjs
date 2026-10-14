import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-prompt-preview-'));
const configPath = path.join(tempDir, 'agent-config.json');
process.env.OPENPROPHET_CONFIG_PATH = configPath;
process.env.OPENPROPHET_EXECUTION_MODE = 'inert';

await fs.writeFile(configPath, JSON.stringify({
  schemaVersion: 2,
  accounts: [
    { id: 'l1', name: 'L1', paper: true },
    { id: 'l2', name: 'L2', paper: true },
  ],
  activeAccountId: 'l2',
  activeSandboxId: 'sbx_l2',
  agents: [
    {
      id: 'pendulum', name: 'Pendulum', description: 'Pendulum identity',
      systemPromptTemplate: 'custom', customSystemPrompt: 'Pendulum identity', strategyId: 'pendulum-rules',
    },
    {
      id: 'catalyst', name: 'Herald', description: 'Herald identity',
      systemPromptTemplate: 'custom', customSystemPrompt: 'Herald identity', strategyId: 'herald-rules',
    },
  ],
  strategies: [
    { id: 'pendulum-rules', name: 'Pendulum Rules', customRules: 'Pendulum strategy rules' },
    { id: 'herald-rules', name: 'Herald Rules', customRules: 'Herald strategy rules' },
  ],
  sandboxes: {
    sbx_l1: {
      id: 'sbx_l1', accountId: 'l1',
      agent: { activeAgentId: 'catalyst', overrides: {} },
    },
    sbx_l2: {
      id: 'sbx_l2', accountId: 'l2',
      agent: {
        activeAgentId: 'pendulum',
        // Simulates a stale override written while this sandbox used Herald.
        overrides: {
          customSystemPrompt: 'Test prompt update — confirming this tool works.',
          systemPromptTemplate: 'custom',
          customStrategyRules: 'test rules',
          heartbeatOverrides: { midday: 777 },
        },
      },
    },
  },
}, null, 2));

const store = await import('../agent/config-store.js?agent-prompt-preview-regression');
const { buildSystemPrompt } = await import('../agent/harness.js');

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.OPENPROPHET_CONFIG_PATH;
  delete process.env.OPENPROPHET_EXECUTION_MODE;
});

test('previews resolve identity and strategy per sandbox while sharing system instructions', async () => {
  await store.loadConfig();
  const config = store.getConfig();
  const build = (sandboxId) => buildSystemPrompt(store.getResolvedAgentForSandbox(sandboxId), {
    getStrategyById: (id) => config.strategies.find(strategy => strategy.id === id),
  });

  const [l1Prompt, l2Prompt] = await Promise.all([build('sbx_l1'), build('sbx_l2')]);
  const l1Shared = l1Prompt.slice(l1Prompt.indexOf('## Available Tools'));
  const l2Shared = l2Prompt.slice(l2Prompt.indexOf('## Available Tools'));

  assert.match(l1Prompt, /Herald identity/);
  assert.match(l1Prompt, /Herald strategy rules/);
  assert.match(l2Prompt, /Pendulum identity/);
  assert.match(l2Prompt, /Pendulum strategy rules/);
  assert.ok(l1Prompt.includes('Herald identity'));
  assert.ok(l1Prompt.includes('Herald strategy rules'));
  assert.ok(l2Prompt.includes('Pendulum identity'));
  assert.ok(l2Prompt.includes('Pendulum strategy rules'));
  assert.ok(l1Shared.includes('Use prophet_assess_options_trade as the standalone on-demand assessment path.'));
  assert.doesNotMatch(l2Prompt, /Test prompt update|test rules/);
  assert.equal(store.getResolvedAgentForSandbox('sbx_l2').heartbeatOverrides.midday, 777);
  assert.equal(l1Shared, l2Shared);
  assert.match(l2Shared, /indicative\/testing_only.*permitted for this paper-advisory assessment/i);
  assert.match(l2Shared, /Missing OI is unknown, not zero; latest-trade size is not daily volume/i);
  assert.match(l2Shared, /freshly re-evaluate a bounded small set of relevant candidates/i);
  assert.match(l2Shared, /recoverable feed\/data objection.*not an all-day no-setup conclusion/i);
  assert.match(l2Shared, /For PAPER_ADVISORY_OP2 options discovery, each entry-eligible regular-session heartbeat/i);
});

test('shared operational instructions keep waits inside the heartbeat budget', async () => {
  await store.loadConfig();
  const config = store.getConfig();
  const prompt = await buildSystemPrompt(store.getResolvedAgentForSandbox('sbx_l2'), {
    getStrategyById: (id) => config.strategies.find(strategy => strategy.id === id),
  });
  assert.match(prompt, /wait.*maximum of 30 seconds/i);
  assert.match(prompt, /finish the current beat/i);
  assert.match(prompt, /existing next heartbeat/i);
  assert.match(prompt, /avoid repeated or multi-minute waits/i);
  assert.match(prompt, /a wait does not schedule a new heartbeat/i);
});

test('owned complete instruction markers scope the temporary entry exception and permanent workflow', async () => {
  const temp = `### TEMPORARY_ALPHA_MVP_OVERRIDE\nPaper validation objective: obtain at least one broker-confirmed options entry in your own account per regular market session.\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n\n### MARKET-OPEN ALPHADESK WORKFLOW\nBefore the open: prepare a small ranked shortlist using confirmed news and completed historical data. Record underlying, direction, candidate expiry, budget and exit plan. Label it research only—not submitted. Do not place new options orders before the broker clock confirms the market is open.\nAt the open: reconcile positions, active orders, planned intents and uncertain submissions. Refresh current price action and exact option-contract bid, ask, sizes and timestamps. Reuse useful research; do not restart everything from scratch.\nAssess: call prophet_assess_options_trade with legs: one exact OCC symbol, with side='buy'; quantity: 1; limit_price: the proposed positive quoted premium—not total dollar debit.\nAlphaDesk obtains its own evidence and score. Indicative/testing-only data is admissible for this paper-advisory workflow. Missing chain open interest is unknown, not zero; latest-trade size is not daily volume.\nRead decision, signal_score, checks and blocking_reasons. Score alone is not approval. On FAIL, address the genuine failed criteria or research another candidate. On UNAVAILABLE, report or recheck the specific problem; never turn a missing score into zero.\nExecute after PASS: call prophet_place_options_order with a new client_order_id, the same contract, quantity and price, its underlying, side='buy', position_intent='buy_to_open' and order_type='limit'. If the proposal changes, reassess. OP2 performs its own final checks.\nVerify and manage: confirm the broker fill. Never blindly retry an uncertain submission. Close the same contract with sell_to_close for the confirmed remaining quantity, following the documented exit plan, and verify the outcome.\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
  const complete = (body) => `Identity and original strategy: ${body}\n\n${temp}`;
  const build = (sandboxId, agentId, prompt) => buildSystemPrompt({
    id: agentId, sandboxId, name: agentId, systemPromptTemplate: 'custom',
    customSystemPrompt: prompt, strategyId: `${agentId}-rules`,
  }, { getStrategyById: () => ({ customRules: 'ORIGINAL STRATEGY: require entry filters; exits and risk remain mandatory.' }) });

  for (const [sandboxId, agentId] of [['sbx_723be98b', 'catalyst'], ['sbx_956ff9e4', 'mean-reversion']]) {
    const prompt = await build(sandboxId, agentId, complete(`${agentId} identity`));
    assert.match(prompt, /ORIGINAL STRATEGY: require entry filters; exits and risk remain mandatory\./);
    assert.equal((prompt.match(/### TEMPORARY_ALPHA_MVP_OVERRIDE/g) || []).length, 1);
    assert.equal((prompt.match(/### MARKET-OPEN ALPHADESK WORKFLOW/g) || []).length, 1);
    assert.match(prompt, /supersedes the ordinary strategy entry filters, discretionary no-trade conditions, and this test-tool exclusion/i);
    assert.doesNotMatch(prompt, /Do not trade to test tools\./);
    assert.match(prompt, /Market eligibility, paper-only permissions, risk and exits, AlphaDesk PASS, broker\/backend checks, and reconciliation remain hard gates/i);
    assert.doesNotMatch(prompt, /Your Strategy Rules above and the per-heartbeat GUARDRAILS are HARD limits/);
    assert.match(prompt, /temporary validation entry.*genuine AlphaDesk PASS.*hard gates.*documented exit/i);
    assert.match(prompt, /Never blindly retry an uncertain submission/);
    assert.match(prompt, /sell_to_close for the confirmed remaining quantity/);

    const withoutTemp = `${agentId} identity\n\n### MARKET-OPEN ALPHADESK WORKFLOW\nPermanent workflow\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
    const ordinary = await build(sandboxId, agentId, withoutTemp);
    assert.match(ordinary, /Do not trade to test tools\./);
    assert.match(ordinary, /ORIGINAL STRATEGY: require entry filters/);
    assert.match(ordinary, /### MARKET-OPEN ALPHADESK WORKFLOW/);
    assert.doesNotMatch(ordinary, /supersedes the ordinary strategy entry filters/i);
    assert.match(ordinary, /Your Strategy Rules above and the per-heartbeat GUARDRAILS are HARD limits/);
    assert.match(ordinary, /Do not trade to test tools\./);
    assert.doesNotMatch(ordinary, /For PAPER_ADVISORY_OP2 options discovery, each entry-eligible regular-session heartbeat/);
    assert.doesNotMatch(ordinary, /signal scores are nullable provider-owned evidence/);

    const malformed = await build(sandboxId, agentId, `${agentId} identity\n### TEMPORARY_ALPHA_MVP_OVERRIDE\npartial`);
    assert.match(malformed, /Do not trade to test tools\./);
    assert.doesNotMatch(malformed, /supersedes the ordinary strategy entry filters/i);

    const incompleteWorkflow = await build(sandboxId, agentId, `${agentId} identity\n\n### TEMPORARY_ALPHA_MVP_OVERRIDE\npartial\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n\n### MARKET-OPEN ALPHADESK WORKFLOW\npartial`);
    assert.match(incompleteWorkflow, /Do not trade to test tools\./);
    assert.match(incompleteWorkflow, /For PAPER_ADVISORY_OP2 options discovery, each entry-eligible regular-session heartbeat/);
  }

  const wrongSandbox = await build('sbx_other', 'catalyst', complete('Herald'));
  assert.match(wrongSandbox, /Do not trade to test tools\./);
  assert.doesNotMatch(wrongSandbox, /supersedes the ordinary strategy entry filters/i);

  // Stored custom text is inert when the selected template does not use it.
  const defaultTemplatePrompt = await buildSystemPrompt({
    id: 'catalyst', sandboxId: 'sbx_723be98b', name: 'catalyst',
    systemPromptTemplate: 'default', customSystemPrompt: complete('Herald'), strategyId: 'catalyst-rules',
  }, { getStrategyById: () => ({ customRules: 'ORIGINAL STRATEGY: require entry filters; exits and risk remain mandatory.' }) });
  assert.match(defaultTemplatePrompt, /Do not trade to test tools\./);
  assert.match(defaultTemplatePrompt, /Your Strategy Rules above and the per-heartbeat GUARDRAILS are HARD limits/);
  assert.doesNotMatch(defaultTemplatePrompt, /supersedes the ordinary strategy entry filters/i);
});

test('changing the selected agent clears stale overrides but preserves explicit customization for the new agent', async () => {
  await store.updateSandboxAgentSelection('sbx_l2', { activeAgentId: 'catalyst' });
  let resolved = store.getResolvedAgentForSandbox('sbx_l2');
  assert.equal(resolved.customSystemPrompt, 'Herald identity');
  assert.equal(resolved.customStrategyRules, null);

  await store.updateSandboxAgentSelection('sbx_l2', { activeAgentId: 'pendulum' });
  await store.updateSandboxAgentOverrides('sbx_l2', {
    systemPromptTemplate: 'custom',
    customSystemPrompt: 'Intentional Pendulum customization',
    customStrategyRules: 'Intentional Pendulum rules',
  });
  resolved = store.getResolvedAgentForSandbox('sbx_l2');
  assert.equal(resolved.customSystemPrompt, 'Intentional Pendulum customization');
  assert.equal(resolved.customStrategyRules, 'Intentional Pendulum rules');
});
