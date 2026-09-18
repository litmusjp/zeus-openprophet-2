import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentHarness, buildSystemPrompt } from '../agent/harness.js';

test('forced heartbeat intervals block agent overrides even with force=true', () => {
  const harness = new AgentHarness();
  harness._sandboxConfig = { heartbeat: { forceHeartbeatIntervals: true } };

  assert.equal(harness.isHeartbeatIntervalsForced(), true);
  assert.equal(harness.canAgentOverrideHeartbeat(), false);
  assert.equal(harness.canAgentOverrideHeartbeat(true), false);
});

test('unlocked heartbeat intervals retain the warm-up and force behavior', () => {
  const harness = new AgentHarness();
  harness._sandboxConfig = { heartbeat: { forceHeartbeatIntervals: false } };

  assert.equal(harness.canAgentOverrideHeartbeat(), false);
  assert.equal(harness.canAgentOverrideHeartbeat(true), true);

  harness._marketSessionDates.add('2026-09-17');
  harness._marketSessionDates.add('2026-09-18');
  assert.equal(harness.canAgentOverrideHeartbeat(), true);
});

test('forced heartbeat prompt tells the agent not to change cadence', async () => {
  const prompt = await buildSystemPrompt(
    { name: 'Test Agent', description: 'Test', systemPromptTemplate: 'custom', customSystemPrompt: 'You are a test agent.' },
    { heartbeatIntervalsForced: true },
  );

  assert.match(prompt, /HEARTBEAT GUARDRAIL/);
  assert.match(prompt, /Do not call apply_heartbeat_profile or set_heartbeat/);
  assert.doesNotMatch(prompt, /Use force=true only for an urgent/);
});

test('reloading a locked sandbox clears an active heartbeat override', async () => {
  const sandbox = {
    id: 'sbx_test',
    accountId: 'acct_test',
    heartbeat: { forceHeartbeatIntervals: true },
  };
  const harness = new AgentHarness({
    sandboxId: sandbox.id,
    accountId: sandbox.accountId,
    getSandbox: () => sandbox,
    getAccount: () => ({ id: sandbox.accountId, name: 'Test Account' }),
    getResolvedAgent: () => ({
      id: 'agent_test',
      name: 'Test Agent',
      description: 'Test',
      systemPromptTemplate: 'custom',
      customSystemPrompt: 'You are a test agent.',
      model: 'anthropic/claude-sonnet-4-6',
    }),
  });
  harness.state.heartbeatOverride = { seconds: 30, agentRequest: true };

  await harness.reloadConfig({ resetSession: false, silent: true });

  assert.equal(harness.state.heartbeatOverride, null);
  assert.match(harness.systemPrompt, /HEARTBEAT GUARDRAIL/);
});
