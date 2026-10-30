import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('reading a known dormant sandbox returns default state without creating runtime resources', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'openprophet-orchestrator-state-read-'));
  const configPath = path.join(dir, 'agent-config.json');
  const previous = {
    config: process.env.OPENPROPHET_CONFIG_PATH,
    mode: process.env.OPENPROPHET_EXECUTION_MODE,
  };
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  process.env.OPENPROPHET_EXECUTION_MODE = 'inert';
  await fs.writeFile(configPath, JSON.stringify({
    accounts: [],
    sandboxes: { sbx_known: { id: 'sbx_known', accountId: 'acct_known' } },
  }));

  try {
    const store = await import('../agent/config-store.js');
    await store.loadConfig();
    const { AgentOrchestrator } = await import(`../agent/orchestrator.js?state-read=${Date.now()}`);
    const { AgentState } = await import(`../agent/harness.js?state-read=${Date.now()}`);
    const orchestrator = new AgentOrchestrator({ projectRoot: dir });

    const state = orchestrator.getState('sbx_known');

    assert.deepEqual(state, new AgentState().toJSON());
    assert.deepEqual(Object.keys(state), [
      'running', 'paused', 'phase', 'phaseLabel', 'heartbeatSeconds', 'heartbeatOverride',
      'beatCount', 'lastBeatTime', 'lastHeartbeatFailure', 'nextBeatTime', 'activeAgentId',
      'activeAccountId', 'activeModel', 'positionPlanContext', 'recentTrades', 'stats',
    ]);
    assert.equal(state.positionPlanContext.status, 'unavailable');
    assert.deepEqual(state.positionPlanContext.matches, []);
    assert.equal(orchestrator.runtimes.size, 0);
    assert.equal(orchestrator.portOwners.size, 0);

    const runtime = orchestrator.ensureRuntime('sbx_known');
    assert.equal(typeof runtime.harness.ensureBackendReady, 'function');
    assert.equal(typeof runtime.harness.getMarketCalendar, 'function');
    assert.equal(runtime.harness.state.stats.totalBeats, 0);
    await assert.rejects(runtime.harness.ensureBackendReady('sbx_known'), /execution mode is inert/);
    assert.equal(runtime.harness.state.stats.totalBeats, 0);
    runtime.harness.state.beatCount = 4;
    const current = orchestrator.getState('sbx_known');
    assert.equal(current.beatCount, 4);
    assert.equal(orchestrator.getSandboxRuntime('sbx_known'), runtime);
  } finally {
    if (previous.config === undefined) delete process.env.OPENPROPHET_CONFIG_PATH;
    else process.env.OPENPROPHET_CONFIG_PATH = previous.config;
    if (previous.mode === undefined) delete process.env.OPENPROPHET_EXECUTION_MODE;
    else process.env.OPENPROPHET_EXECUTION_MODE = previous.mode;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('reading an unknown sandbox remains not found without creating runtime resources', async () => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR || os.tmpdir(), 'openprophet-orchestrator-state-read-missing-'));
  const configPath = path.join(dir, 'agent-config.json');
  const previous = {
    config: process.env.OPENPROPHET_CONFIG_PATH,
    mode: process.env.OPENPROPHET_EXECUTION_MODE,
  };
  process.env.OPENPROPHET_CONFIG_PATH = configPath;
  process.env.OPENPROPHET_EXECUTION_MODE = 'inert';
  await fs.writeFile(configPath, JSON.stringify({ accounts: [], sandboxes: {} }));

  try {
    const store = await import('../agent/config-store.js');
    await store.loadConfig();
    const { AgentOrchestrator } = await import(`../agent/orchestrator.js?state-read-missing=${Date.now()}`);
    const orchestrator = new AgentOrchestrator({ projectRoot: dir });

    assert.throws(() => orchestrator.getState('sbx_missing'), /Sandbox not found: sbx_missing/);
    assert.equal(orchestrator.runtimes.size, 0);
    assert.equal(orchestrator.portOwners.size, 0);
  } finally {
    if (previous.config === undefined) delete process.env.OPENPROPHET_CONFIG_PATH;
    else process.env.OPENPROPHET_CONFIG_PATH = previous.config;
    if (previous.mode === undefined) delete process.env.OPENPROPHET_EXECUTION_MODE;
    else process.env.OPENPROPHET_EXECUTION_MODE = previous.mode;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
