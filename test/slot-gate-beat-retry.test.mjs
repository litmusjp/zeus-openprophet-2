import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Switch-profile N04: a beat that the slot gate deferred is not lost. One retry timer (never two) runs it about 60 s later, after the gate is
// released. The deferred attempt itself does no model or tool work. Timers are injected (setTimeoutFn/clearTimeoutFn); nothing real is waited on.
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-gate-retry-'));
process.env.OPENPROPHET_CONFIG_PATH = path.join(tempDir, 'agent-config.json');
process.env.OPENPROPHET_DATA_DIR = path.join(tempDir, 'data');
process.env.OPENPROPHET_EXECUTION_MODE = 'inert';

const { AgentHarness } = await import('../agent/harness.js');
const { slotGate } = await import('../agent/slot-gate.js');

const A = 'sbx_a';
const B = 'sbx_b';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    proc.stdout.emit('data', `${JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'ok' } })}\n`);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
  });
  return proc;
}

function makeHarness(sandboxId = A, clock = { now: 1_000_000 }) {
  const timers = [];
  const spawns = [];
  const harness = new AgentHarness({
    sandboxId, accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: { async getRecentContext() { return []; }, async startSession() {}, async addMessage() {} },
    spawnFn: (...args) => { spawns.push(args); return fakeProcess(); },
    nowFn: () => clock.now,
    setTimeoutFn: (fn, ms) => { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
    clearTimeoutFn: timer => { if (timer && typeof timer === 'object' && 'fn' in timer) timer.cleared = true; else clearTimeout(timer); },
  });
  harness._beatRetryDelayMs = 0;
  harness.state.running = true;
  harness.state.activeAccountId = 'a';
  harness.state.activeModel = 'opencode/model';
  const live = () => timers.filter(timer => !timer.cleared && !timer.fired);
  const fire = async timer => { timer.fired = true; await timer.fn(); };
  return { harness, timers, spawns, live, fire };
}

const settleTicks = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
test.beforeEach(() => slotGate.reset());
test.after(async () => { slotGate.reset(); await fs.rm(tempDir, { recursive: true, force: true }); });

test('N04: a scheduled beat that hits the gate runs no model or tool, and exactly one 60 s retry is armed (a second deferral does not add a second timer)', async () => {
  const { harness, spawns, live } = makeHarness();
  const hold = slotGate.acquire(A, 'switch');
  const logs = [];
  harness.state.on?.('agent_log', entry => logs.push(entry.message));
  await harness._beat();
  assert.equal(spawns.length, 0, 'no model process');
  assert.equal(harness.state.beatCount, 0);
  assert.equal(harness._beating, false);
  assert.match(logs.join('\n'), /beat deferred: slot settings transition in progress/);
  assert.equal(live().length, 1);
  assert.equal(live()[0].ms, 60_000);
  const first = live()[0];
  await harness._beat(); // deferred again before the retry: still one live timer
  assert.equal(live().length, 1, 'never two retry timers');
  assert.equal(first.cleared, true, 'the earlier one was replaced');
  assert.equal(spawns.length, 0);
  hold.release();
  await harness.stop();
});

test('N04: after the release the retry fires once and runs one beat; nothing is armed afterwards and a second firing does nothing', async () => {
  const { harness, spawns, live, fire } = makeHarness();
  const hold = slotGate.acquire(A, 'switch');
  await harness._beat();
  const retry = live()[0];
  hold.release();
  await fire(retry);
  assert.equal(spawns.length, 1, 'the deferred beat ran once, after the release');
  assert.equal(harness.state.beatCount, 1);
  assert.equal(harness._gateRetryTimer, null);
  assert.equal(live().filter(timer => timer.ms === 60_000).length, 0, 'no retry left over');
  await fire(retry); // a stale firing (same timer again) is ignored
  assert.equal(spawns.length, 1);
  await harness.stop();
});

test('N04: a retry that finds the gate still held re-arms the same single timer and runs nothing; it runs once the gate opens', async () => {
  const { harness, spawns, live, fire } = makeHarness();
  const hold = slotGate.acquire(A, 'reapply');
  await harness._beat();
  await fire(live()[0]);
  assert.equal(spawns.length, 0);
  assert.equal(live().filter(timer => timer.ms === 60_000).length, 1, 'one re-armed timer');
  hold.release();
  await fire(live().find(timer => timer.ms === 60_000));
  assert.equal(spawns.length, 1);
  await harness.stop();
});

test('N04: stop() cancels the pending retry, and a stale firing afterwards runs nothing', async () => {
  const { harness, spawns, live, timers } = makeHarness();
  const hold = slotGate.acquire(A, 'switch');
  await harness._beat();
  const retry = live()[0];
  await harness.stop();
  assert.equal(retry.cleared, true);
  assert.equal(harness._gateRetryTimer, null);
  assert.equal(live().length, 0);
  hold.release();
  await retry.fn(); // even a timer that slipped through is ignored: stopped, and no longer the registered retry
  assert.equal(spawns.length, 0);
  assert.equal(timers.length, 1, 'the stale firing armed nothing new');
  assert.equal(live().length, 0);
});

test('N04: a paused or stopped agent drops the retry without a beat; a normal beat that starts clears a pending retry', async () => {
  let ctx = makeHarness();
  let hold = slotGate.acquire(A, 'switch');
  await ctx.harness._beat();
  const retry = ctx.live()[0];
  ctx.harness.state.paused = true;
  hold.release();
  await ctx.fire(retry);
  assert.equal(ctx.spawns.length, 0, 'paused: dropped');
  assert.equal(ctx.live().length, 0);
  await ctx.harness.stop();

  ctx = makeHarness();
  hold = slotGate.acquire(A, 'switch');
  await ctx.harness._beat();
  const pending = ctx.live()[0];
  hold.release();
  await ctx.harness._beat(); // a normal beat starts first
  assert.equal(ctx.spawns.length, 1);
  assert.equal(pending.cleared, true, 'the normal beat cleared the retry');
  assert.equal(ctx.harness._gateRetryTimer, null);
  await ctx.harness.stop();
});

test('N04: market-aware checks are unchanged (paused or stopped market-aware agents return before the gate: no retry), and another slot is never deferred', async () => {
  const ctx = makeHarness();
  ctx.harness._marketAwareEnabled = () => true;
  ctx.harness.state.paused = true;
  const hold = slotGate.acquire(A, 'switch');
  await ctx.harness._beat();
  assert.equal(ctx.live().length, 0, 'paused market-aware agent: no retry armed');
  ctx.harness.state.paused = false; ctx.harness.state.running = false;
  await ctx.harness._beat();
  assert.equal(ctx.live().length, 0, 'stopped agent: no retry armed');
  hold.release();

  const other = makeHarness(B);
  const heldA = slotGate.acquire(A, 'switch');
  await other.harness._beat();
  assert.equal(other.spawns.length, 1, 'slot B has its own gate');
  assert.equal(other.live().length, 0);
  heldA.release();
  await other.harness.stop();
  await ctx.harness.stop();
});

test('N04: an ad hoc (user message) deferral arms no heartbeat retry', async () => {
  const { harness, spawns, live } = makeHarness();
  const hold = slotGate.acquire(A, 'switch');
  await harness._adHocBeat('hello');
  assert.equal(spawns.length, 0);
  assert.equal(live().length, 0, 'a user message is not turned into a heartbeat');
  hold.release();
  await harness.stop();
});

test('N04: through the real scheduler timer: the scheduled beat hits the gate (no model), the normal cadence is re-armed, and the 60 s retry then runs the beat once', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const spawns = [];
  const harness = new AgentHarness({
    sandboxId: A, accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: { async getRecentContext() { return []; }, async startSession() {}, async addMessage() {} },
    spawnFn: (...args) => { spawns.push(args); return fakeProcess(); },
  });
  harness._beatRetryDelayMs = 0;
  harness.state.running = true; harness.state.activeAccountId = 'a'; harness.state.activeModel = 'opencode/model';
  const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setImmediate(resolve)); };
  const hold = slotGate.acquire(A, 'switch');
  harness._scheduleNext();
  assert.ok(harness._timer, 'the normal schedule is armed');
  t.mock.timers.tick(harness.state.heartbeatSeconds * 1000); // the scheduled beat is due while the slot is gated
  await settle();
  assert.equal(spawns.length, 0, 'no model run for the deferred beat');
  assert.ok(harness._gateRetryTimer, 'retry armed');
  assert.ok(harness._timer, 'the normal cadence continues');
  hold.release();
  t.mock.timers.tick(59_999);
  await settle();
  assert.equal(spawns.length, 0, 'not before 60 s');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(spawns.length, 1, 'the retry ran the deferred beat once');
  assert.equal(harness._gateRetryTimer, null);
  await harness.stop();
  t.mock.timers.reset();
});

test('N04 window: a gate held longer than 15 min stops the retries, logs one drop line, runs no beat on a later release, and the next normal beat works', async () => {
  const clock = { now: 1_000_000 };
  const { harness, spawns, live, fire, timers } = makeHarness(A, clock);
  const logs = [];
  harness.state.on?.('agent_log', entry => logs.push(entry.message));
  const hold = slotGate.acquire(A, 'switch');
  await harness._beat(); // first deferral: the chain starts
  let retries = 0;
  while (live().length) {
    clock.now += 60_000; // each retry fires 60 s later and finds the gate still held
    await fire(live()[0]);
    retries += 1;
    assert.ok(retries <= 20, 'the chain must end');
  }
  assert.equal(retries, 15, 'retried every minute for 15 minutes, then stopped');
  assert.equal(spawns.length, 0);
  assert.equal(logs.filter(m => m === 'deferred beat dropped after 15 min; normal schedule continues').length, 1, 'exactly one drop line');
  assert.equal(harness._gateRetryTimer, null);
  const created = timers.length;
  hold.release();
  clock.now += 60_000;
  await settleTicks();
  assert.equal(spawns.length, 0, 'no beat on release: only the normal schedule runs one');
  assert.equal(timers.length, created, 'no new timer after the drop');
  await harness._beat(); // the normal schedule firing later
  assert.equal(spawns.length, 1);
  await harness.stop();
});

test('N04 window: re-arming inside the window keeps working, and a beat that runs resets the chain so a later deferral gets a fresh window', async () => {
  const clock = { now: 1_000_000 };
  const { harness, spawns, live, fire } = makeHarness(A, clock);
  let hold = slotGate.acquire(A, 'switch');
  await harness._beat();
  for (let i = 0; i < 10; i += 1) { clock.now += 60_000; await fire(live()[0]); assert.equal(live().length, 1, 'still re-arming at ' + (i + 1) + ' min'); }
  hold.release();
  clock.now += 60_000;
  await fire(live()[0]);
  assert.equal(spawns.length, 1, 'the retry ran the beat after 11 min');
  assert.equal(harness._gateRetryFirstAt, null, 'chain reset');
  hold = slotGate.acquire(A, 'switch');
  clock.now += 20 * 60_000; // a much later deferral is a new chain, not an expired one
  await harness._beat();
  assert.equal(live().length, 1);
  hold.release();
  await harness.stop();
  assert.equal(harness._gateRetryFirstAt, null, 'stop resets the chain');
});
