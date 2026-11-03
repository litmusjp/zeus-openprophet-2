import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentHarness, isEarlyOpenCodeCrash } from '../agent/harness.js';

function fakeProcess(lines, exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
    proc.emit('exit', exitCode, null);
    proc.emit('close', exitCode, null);
  });
  return proc;
}

function makeHarness(runs, writes) {
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async getRecentContext() { return []; },
      async startSession() {},
      async addMessage(account, session, message) { writes.push({ account, session, message }); },
    },
    spawnFn: () => fakeProcess(...runs.shift()),
  });
  harness._beatRetryDelayMs = 0;
  harness.state.running = true;
  harness.state.activeAccountId = 'a';
  harness.state.activeModel = 'opencode/model';
  return harness;
}

test('only an early crash with no tool call qualifies for a retry', () => {
  assert.equal(isEarlyOpenCodeCrash({ error: 'opencode exited with code 1 signal null', toolCalls: 0, toolEvents: [] }), true);
  assert.equal(isEarlyOpenCodeCrash({ error: 'opencode exited with code 1 signal null', toolCalls: 2, toolEvents: [] }), false);
  assert.equal(isEarlyOpenCodeCrash({ error: 'opencode exited with code 1', toolCalls: 0, toolEvents: [{ tool: 'get_account' }] }), false);
  assert.equal(isEarlyOpenCodeCrash({ error: 'opencode timed out after 300s; harness sent SIGTERM', toolCalls: 0, toolEvents: [] }), false);
  assert.equal(isEarlyOpenCodeCrash({ toolCalls: 0 }), false);
  assert.equal(isEarlyOpenCodeCrash(null), false);
});

test('a beat that crashes before any tool call is retried once and succeeds', async () => {
  const writes = [];
  let spawns = 0;
  const runs = [[[], 1], [[{ type: 'text', sessionID: 'fresh', part: { text: 'recovered answer' } }], 0]];
  const harness = makeHarness(runs, writes);
  const original = harness.spawnFn;
  harness.spawnFn = (...args) => { spawns++; return original(...args); };
  await harness._beat();
  assert.equal(spawns, 2, 'one retry');
  assert.equal(writes.filter(w => w.message?.kind === 'heartbeat_failure').length, 0);
  assert.equal(writes.filter(w => w.message?.kind === 'heartbeat').length, 1);
  assert.equal(harness.state.stats.errors, 0);
});

test('a second early crash is recorded as a failure that mentions the retry, with no third attempt', async () => {
  const writes = [];
  let spawns = 0;
  const runs = [[[], 1], [[], 1], [[], 1]];
  const harness = makeHarness(runs, writes);
  const original = harness.spawnFn;
  harness.spawnFn = (...args) => { spawns++; return original(...args); };
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  assert.equal(spawns, 2);
  const failure = writes.filter(w => w.message?.kind === 'heartbeat_failure');
  assert.equal(failure.length, 1);
  assert.match(failure[0].message.message, /after one retry/);
  assert.equal(harness.state.stats.errors, 1);
});

test('a crash after a tool call is never retried', async () => {
  const writes = [];
  let spawns = 0;
  const runs = [[[{ type: 'tool_use', sessionID: 's', part: { tool: 'prophet_get_account', state: { input: {}, output: 'ok' } } }], 1], [[], 0]];
  const harness = makeHarness(runs, writes);
  const original = harness.spawnFn;
  harness.spawnFn = (...args) => { spawns++; return original(...args); };
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  assert.equal(spawns, 1);
  assert.equal(writes.filter(w => w.message?.kind === 'heartbeat_failure').length, 1);
});

test('the trading agent cannot use the native to-do tool', async () => {
  let captured;
  const harness = new AgentHarness({
    opencodeEnv: { OPENCODE_CONFIG_CONTENT: '' },
    spawnFn: (_cmd, _args, options) => { captured = options.env; return fakeProcess([[{ type: 'text', part: { text: 'OK' } }], 0].flat().slice(0, 1)); },
  });
  await harness._runClaude('prompt', 'opencode/big-pickle');
  const config = JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
  const primary = config.agent[config.default_agent || 'build'];
  assert.equal(primary.permission.todowrite, 'deny');
  assert.equal(primary.permission.todoread, 'deny');
  assert.ok(Number.isInteger(primary.steps) && primary.steps > 0, 'the native step budget is still applied');
});
