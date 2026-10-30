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
  assert.ok(l1Shared.includes('Standalone prophet_assess_options_trade is optional on-demand research, not a prerequisite.'));
  assert.doesNotMatch(l2Prompt, /Test prompt update|test rules/);
  assert.equal(store.getResolvedAgentForSandbox('sbx_l2').heartbeatOverrides.midday, 777);
  assert.equal(l1Shared, l2Shared);
  assert.match(l2Shared, /indicative\/testing_only.*permitted for this paper-advisory assessment/i);
  assert.match(l2Shared, /Missing OI is unknown, not zero; latest-trade size is not daily volume/i);
  assert.match(l2Shared, /seek qualifying opportunities under the assigned strategy and current controls/i);
  assert.match(l2Shared, /recoverable feed\/data objection.*not an all-day no-setup conclusion/i);
  assert.match(l2Shared, /For PAPER_ADVISORY_OP2 options discovery, each entry-eligible regular-session heartbeat/i);
  assert.match(l2Shared, /prophet_get_options_assessment_policy.*optional affordability research.*backend obtains and enforces current policy/i);
  assert.doesNotMatch(l2Shared, /require a valid POLICY_ONLY response|Skip the candidate if policy is unavailable/i);
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

test('selected rulesFile takes precedence over customRules, with customRules as fallback', async () => {
  const baseAgent = { id: 'source-check', sandboxId: 'sbx_other', name: 'Source check', systemPromptTemplate: 'default', strategyId: 'source-check-rules' };
  const fileWins = await buildSystemPrompt(baseAgent, { getStrategyById: () => ({ rulesFile: 'TRADING_RULES.md', customRules: 'STALE CUSTOM RULES' }) });
  assert.match(fileWins, /# Trading Rules/);
  assert.doesNotMatch(fileWins, /STALE CUSTOM RULES/);
  const customFallback = await buildSystemPrompt(baseAgent, { getStrategyById: () => ({ rulesFile: null, customRules: 'CUSTOM RULES FALLBACK' }) });
  assert.match(customFallback, /CUSTOM RULES FALLBACK/);
});

test('owned marker-delimited legacy text is removed while custom instructions and controls remain', async () => {
  const prompt = await buildSystemPrompt({
    id: 'momentum', sandboxId: 'sbx_956ff9e4', name: 'Surge', systemPromptTemplate: 'custom',
    customSystemPrompt: 'Surge identity\n### TEMPORARY_ALPHA_MVP_OVERRIDE\n### ALPHA_MVP_MODE: MULTI_SESSION\nquantity one; two entry-and-exit cycles\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n\n### MARKET-OPEN ALPHADESK WORKFLOW\nUse exact OCC quote; PASS before entry.\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW',
    strategyId: 'surge',
  }, { getStrategyById: () => ({ customRules: 'Surge strategy rules and custom risk exits.' }) });
  assert.match(prompt, /Surge identity/);
  assert.match(prompt, /Surge strategy rules and custom risk exits/);
  assert.match(prompt, /### MARKET-OPEN ALPHADESK WORKFLOW/);
  assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE|ALPHA_MVP_MODE|quantity one|two entry-and-exit cycles/);
  assert.match(prompt, /max-position and max-deployed/i);
  assert.match(prompt, /exact OCC contract/);
  assert.match(prompt, /fresh genuine PASS/i);
  assert.match(prompt, /backend independently obtains and enforces/i);
  assert.match(prompt, /entry-eligible regular-session heartbeat, seek qualifying opportunities/i);
});

test('effective prompts normalize both actual saved market-open workflows and remove the temporary block', async () => {
  const temporary = `### TEMPORARY_ALPHA_MVP_OVERRIDE\n### ALPHA_MVP_MODE: MULTI_SESSION\nMulti-session MVP: keep the existing relaxed ordinary entry filters in force. Two completed broker-confirmed entry-and-exit cycles are a validation checkpoint across sessions, not a per-day quota, deadline to sell, or ceiling on later ordinary opportunities. Validate only single-contract long calls or puts (quantity one); do not increase size to meet the checkpoint. Manage open exposure first; valid no-trade days are allowed. Count a carry-in closure once against its original broker-confirmed opening fill. Accepted, planned, unfilled orders and runtime counters are not cycles. Never close to complete a cycle, meet a daily target, or reset at a date boundary. Hold across sessions when the original thesis, strategy-specific conditional time exit, expiry and risk permit; risk exits stay immediate and losers are never extended. Record underlying or premium basis, target, numerical invalidation, time/expiry exit and allowed discretionary exit rationale. Current tools provide no broker-held continuous options stop/OCO. Standalone prophet_assess_options_trade is optional research, not a prerequisite. Prefer one guarded prophet_place_options_order call for the eligible unchanged proposal; the backend independently obtains and enforces a fresh genuine AlphaDesk PASS before broker submission. Do not use caller-evidence prophet_assess_options_strategy. Preserve all market, PAPER identity, permissions, risk, exits, expiry, account, review and reconciliation gates.\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE`;
  const actualWorkflow = `### MARKET-OPEN ALPHADESK WORKFLOW
Before the open: prepare a small ranked shortlist using confirmed news and completed historical data. Record underlying, direction, candidate expiry, budget and exit plan. Label it research only—not submitted. Do not place new options orders before the broker clock confirms the market is open.
At the open: reconcile options positions, active broker orders, planned intents and uncertain submissions. Refresh current price action and exact option-contract bid, ask, sizes and timestamps. Reuse useful research; do not restart everything from scratch.
Select one exact eligible single-leg proposal at quantity 1. Read current managed policy and OP2 confirmation; if either is ON or unknown, do not submit. Generate one stable client_order_id and submit this exact OCC contract, side='buy', quantity 1, and proposed positive limit premium once through prophet_place_options_order, which independently assesses at the broker boundary. Use the same client_order_id for this intent. The first submission is not a retry. A standalone assessment is optional research only and is not a prerequisite to this guarded call. If an optional standalone assessment has already been made, its first submission must occur before that receipt's op2_effective_expires_at; on a direct guarded call the backend obtains and enforces fresh assessment expiry.
AlphaDesk obtains its own evidence and score. Indicative/testing-only data is admissible for this paper-advisory workflow. Missing chain open interest is unknown, not zero; latest-trade size is not daily volume.
Read decision, signal_score, checks and blocking_reasons. Score alone is not approval. On FAIL, address the genuine failed criteria or research another candidate. On UNAVAILABLE, report or recheck the specific problem; never turn a missing score into zero.
After the guarded order call, read its actual assessment and broker result. Only its genuine PASS for the unchanged proposal can proceed; do not make a second submission. If any proposal field changes, requalify it. Discard stale assistant approval narratives. Never blindly retry uncertainty or sequence spread legs. OP2 performs its own final checks.
Verify and manage: confirm the broker result and fill. Never blindly retry an uncertain submission. Close the same contract with sell_to_close for the broker-reconciled remaining quantity, following the documented exit plan, and verify the outcome. Option exits are periodic agent-managed market/limit closes; they are not broker-held stops/OCO and do not provide guaranteed instantaneous protection.

### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;

  for (const [sandboxId, id, identity, strategy] of [
    ['sbx_723be98b', 'mean-reversion', 'You are Pendulum, a selective ETF mean-reversion trader who waits for a completed-bar rebound before entering.', '- Trade liquid broad-market and sector ETFs after a sharp short-term selloff; require completed bars.'],
    ['sbx_956ff9e4', 'momentum', 'You are Surge, a breakout-continuation trader who requires a completed daily close and volume confirmation.', '- Require a completed daily close above a clearly bounded range on volume above its recent average.'],
  ]) {
    const savedText = `${identity}\n\n${temporary}\n\n${actualWorkflow}`;
    const prompt = await buildSystemPrompt({
      id, sandboxId, systemPromptTemplate: 'custom', customSystemPrompt: savedText, strategyId: id,
    }, { getStrategyById: () => ({ customRules: strategy }) });
    assert.ok(prompt.includes(identity));
    assert.ok(prompt.includes(strategy));
    assert.equal(prompt.includes('Select one exact eligible single-leg proposal at quantity 1.'), false, `${id} legacy selector must not survive in the effective prompt`);
    assert.equal(prompt.includes("side='buy', quantity 1, and proposed positive limit premium"), false, `${id} legacy order quantity must not survive in the effective prompt`);
    assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE|ALPHA_MVP_MODE|quantity one|quantity 1|quantity 1,/i);
    assert.match(prompt, /Select an exact eligible single-leg proposal within available account capacity/);
    assert.match(prompt, /the exact proposed quantity/);
    assert.match(prompt, /current managed policy and OP2 confirmation/);
    assert.match(prompt, /same contract with sell_to_close for the broker-reconciled remaining quantity/);
    assert.match(prompt, /genuine AlphaDesk PASS/);
    assert.match(prompt, /backend independently obtains and enforces a fresh genuine PASS/);
    assert.match(prompt, /prophet_place_options_order/);
    assert.match(prompt, /max-position and max-deployed/i);
    assert.match(prompt, /settings-owned capacity/i);
    assert.doesNotMatch(prompt, /require a valid POLICY_ONLY response|Skip the candidate if policy is unavailable/i);
    assert.doesNotMatch(prompt, /bounded rotating shortlist|manage(?:ment)? (?:open )?(?:exposure|positions?) first|entry quota/i);
  }
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
