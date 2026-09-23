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
  assert.doesNotMatch(l2Prompt, /Test prompt update|test rules/);
  assert.equal(store.getResolvedAgentForSandbox('sbx_l2').heartbeatOverrides.midday, 777);
  assert.equal(l1Shared, l2Shared);
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
