import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { AgentHarness } from '../agent/harness.js';
import { buildGoBackendEnv } from '../agent/orchestrator.js';
import { stripOperatorSecrets } from '../agent/chatgpt-oauth.js';
import { CAP_CONTROL_ENV, CAP_CONTROL_HEADER, createOptionSpreadCapController, reconcileOptionSpreadCap } from '../agent/option-spread-cap.js';

const serverSource = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
const mcpSource = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');

// ── the cap credential is server-only ─────────────────────────────────────────────────────────────
test('credential: it is stripped from every agent and MCP child environment but reaches the Go backend', async () => {
  const env = stripOperatorSecrets({ [CAP_CONTROL_ENV]: 'secret', OPENPROPHET_CAP_CONTROL_OTHER: 'x', TRADING_BOT_TOKEN: 't', PATH: '/bin' });
  assert.equal(CAP_CONTROL_ENV in env, false);
  assert.equal('OPENPROPHET_CAP_CONTROL_OTHER' in env, false);
  assert.equal(env.TRADING_BOT_TOKEN, 't');
  assert.equal(env.PATH, '/bin');

  const account = { id: 'acct', publicKey: 'pk', secretKey: 'sk', brokerAccountId: 'broker', paper: true };
  const goEnv = buildGoBackendEnv({ [CAP_CONTROL_ENV]: 'secret' }, { account, sandboxId: 'sbx', processNonce: 'n', port: 1, databasePath: 'db', activityLogDir: 'l', permissions: {} });
  assert.equal(goEnv[CAP_CONTROL_ENV], 'secret', 'the Go backend verifies the credential');
  assert.equal(buildGoBackendEnv({}, { account, sandboxId: 'sbx', processNonce: 'n', port: 1, databasePath: 'db', activityLogDir: 'l', permissions: {} })[CAP_CONTROL_ENV], '', 'no credential means no cap changes');

  // The real child spawn: the value is in the server's environment and is not in what the agent process receives.
  const previous = process.env[CAP_CONTROL_ENV];
  process.env[CAP_CONTROL_ENV] = 'server-only-secret';
  try {
    let captured;
    const fakeProcess = () => {
      const proc = new EventEmitter();
      proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
      proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.kill = () => {};
      queueMicrotask(() => { proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`); proc.emit('exit', 0, null); proc.emit('close', 0, null); });
      return proc;
    };
    const harness = new AgentHarness({ opencodeEnv: { [CAP_CONTROL_ENV]: 'also-secret' }, spawnFn: (_c, _a, options) => { captured = options.env; return fakeProcess(); } });
    await harness._runClaude('prompt', 'opencode/big-pickle');
    assert.ok(captured, 'the child was spawned');
    assert.equal(CAP_CONTROL_ENV in captured, false, 'the agent child never receives the cap credential');
    assert.equal(JSON.stringify(captured).includes('server-only-secret') || JSON.stringify(captured).includes('also-secret'), false);
  } finally {
    if (previous === undefined) delete process.env[CAP_CONTROL_ENV]; else process.env[CAP_CONTROL_ENV] = previous;
  }
  assert.doesNotMatch(mcpSource, /CAP_CONTROL|risk\/option-spread-cap/, 'no MCP tool uses or exposes the cap credential or the cap-change endpoint');
  assert.match(serverSource, /if \(EXECUTION_START_ENABLED && !process\.env\.OPENPROPHET_CAP_CONTROL_TOKEN\)/);
});

// ── saved and enforced cap stay equal ───────────────────────────────────────────────────────────────
function backend({ effective = 8, failNext = null } = {}) {
  const state = { effective, configured: true, invalid: false, log: [], failNext, reachable: true, revision: 1 };
  const body = () => ({ effective_pct: state.effective, configured: state.configured, invalid: state.invalid, revision: state.revision });
  return {
    state,
    client: {
      get: async () => { state.log.push('get'); if (!state.reachable) throw new Error('unreachable'); return { data: body() }; },
      put: async (_url, payload, options) => {
        state.log.push(`put:${payload.pct}`);
        assert.ok(options.headers[CAP_CONTROL_HEADER], 'every change carries the cap credential');
        const mode = state.failNext; state.failNext = null;
        if (!state.reachable) throw new Error('unreachable');
        if (mode === 'refuse') throw new Error('refused');
        if (state.effective !== payload.pct || state.invalid) state.revision += 1; // the backend counts every change of the enforced value
        state.effective = payload.pct;
        state.invalid = false; // the backend clears an invalid start-up value when it is given a valid one
        if (mode === 'lose_response') throw new Error('response lost after the backend applied the value');
        return { data: body() };
      },
    },
  };
}

function harnessFor({ server, saved, failPersist = false, delay = 0 }) {
  const order = [];
  const controller = createOptionSpreadCapController({
    token: () => 'cap-token',
    getClient: () => server.client,
    getSaved: id => saved[id],
    save: async (id, patch, hooks) => {
      const next = { maxOptionSpreadPct: patch.maxOptionSpreadPct };
      order.push(`start:${next.maxOptionSpreadPct}`);
      await hooks.beforePersist(next);
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      if (failPersist) throw new Error('disk full');
      saved[id] = next.maxOptionSpreadPct;
      order.push(`saved:${next.maxOptionSpreadPct}`);
      return next;
    },
  });
  return { controller, order };
}

test('consistency: a successful save leaves the backend at the saved value, confirmed by reading it back', async () => {
  const server = backend({ effective: 8 }); const saved = { s: 8 };
  const { controller } = harnessFor({ server, saved });
  const result = await controller.save('s', { maxOptionSpreadPct: 10 });
  assert.equal(result.capSync, 'in_sync');
  assert.equal(saved.s, 10);
  assert.equal(server.state.effective, 10);
  assert.equal(server.state.log.at(-1), 'get', 'the last step reads the backend back');
});

test('consistency: a push the backend applied but whose answer was lost does not leave a different value running', async () => {
  const server = backend({ effective: 8, failNext: 'lose_response' }); const saved = { s: 8 };
  const { controller } = harnessFor({ server, saved });
  await assert.rejects(() => controller.save('s', { maxOptionSpreadPct: 10 }), /did not accept/);
  assert.equal(saved.s, 8, 'nothing was saved');
  assert.equal(server.state.effective, 8, 'the backend was put back to the saved value');
});

test('consistency: a refused push, and a failed write after a good push, both end with saved == enforced', async () => {
  let server = backend({ effective: 8, failNext: 'refuse' }); let saved = { s: 8 };
  await assert.rejects(() => harnessFor({ server, saved }).controller.save('s', { maxOptionSpreadPct: 10 }), /did not accept/);
  assert.deepEqual([saved.s, server.state.effective], [8, 8]);

  server = backend({ effective: 8 }); saved = { s: 8 };
  await assert.rejects(() => harnessFor({ server, saved, failPersist: true }).controller.save('s', { maxOptionSpreadPct: 10 }), /disk full/);
  assert.deepEqual([saved.s, server.state.effective], [8, 8], 'the pushed value was rolled back');
});

test('consistency: when the rollback cannot be confirmed the error says so and the next heartbeat corrects it', async () => {
  const server = backend({ effective: 8, failNext: 'lose_response' }); const saved = { s: 8 };
  const { controller } = harnessFor({ server, saved });
  // The backend applies the value, the answer is lost, and the backend then becomes unreachable (rollback cannot be confirmed).
  const applied = server.client.put;
  server.client.put = async (...args) => { try { return await applied(...args); } finally { server.state.reachable = false; } };
  await assert.rejects(() => controller.save('s', { maxOptionSpreadPct: 10 }), /re-checked and corrected before the next heartbeat/);
  assert.equal(saved.s, 8);
  assert.equal(server.state.effective, 10, 'the backend is stuck on the unsaved value');
  server.state.reachable = true;
  server.client.put = applied;
  const fixed = await controller.reconcile('s');
  assert.equal(fixed.state, 'in_sync');
  assert.equal(server.state.effective, 8, 'the heartbeat re-check restored the saved value');
});

test('consistency: overlapping saves run one at a time, in order, and end consistent', async () => {
  const server = backend({ effective: 8 }); const saved = { s: 8 };
  const { controller, order } = harnessFor({ server, saved, delay: 15 });
  const results = await Promise.allSettled([controller.save('s', { maxOptionSpreadPct: 10 }), controller.save('s', { maxOptionSpreadPct: 12 }), controller.reconcile('s'), controller.save('s', { maxOptionSpreadPct: 9 })]);
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
  assert.deepEqual(order, ['start:10', 'saved:10', 'start:12', 'saved:12', 'start:9', 'saved:9'], 'no interleaving');
  assert.equal(saved.s, 9);
  assert.equal(server.state.effective, 9);
  const puts = server.state.log.filter(entry => entry.startsWith('put:'));
  assert.deepEqual(puts.slice(0, 3), ['put:10', 'put:12', 'put:9']);
});

test('consistency: a failed save in the middle of overlapping saves does not poison the queue', async () => {
  const server = backend({ effective: 8 }); const saved = { s: 8 };
  const { controller } = harnessFor({ server, saved, delay: 5 });
  server.state.failNext = 'refuse';
  const first = controller.save('s', { maxOptionSpreadPct: 10 }).then(() => 'ok', () => 'failed');
  const second = controller.save('s', { maxOptionSpreadPct: 12 }).then(() => 'ok', () => 'failed');
  assert.deepEqual(await Promise.all([first, second]), ['failed', 'ok']);
  assert.deepEqual([saved.s, server.state.effective], [12, 12]);
});

test('consistency: the heartbeat re-check corrects drift, an invalid value and never throws', async () => {
  let server = backend({ effective: 8 });
  assert.equal((await reconcileOptionSpreadCap(server.client, 10, { token: 't' })).state, 'in_sync');
  assert.equal(server.state.effective, 10);
  server = backend({ effective: 10 }); server.state.invalid = true;
  assert.equal((await reconcileOptionSpreadCap(server.client, 10, { token: 't' })).state, 'in_sync', 'an invalid backend value is replaced');
  assert.equal(server.state.invalid, false);
  assert.equal((await reconcileOptionSpreadCap(null, 10)).state, 'no_backend');
  server = backend({ effective: 8 }); server.state.reachable = false;
  assert.equal((await reconcileOptionSpreadCap(server.client, 10, { token: 't' })).state, 'unreconciled');
  const { controller } = harnessFor({ server, saved: { s: 10 } });
  assert.equal((await controller.reconcile('s')).state, 'unreconciled');
});

// ── the heartbeat calls the re-check and survives its failure ─────────────────────────────────────────
async function beatWith(ensure) {
  const harness = new AgentHarness({ sandboxId: 'sbx_fixture', accountId: 'acct', getSandbox: () => ({}), getPermissions: () => ({}), getCurrentPhaseFn: () => 'closed', ensureOptionSpreadCapFn: ensure });
  harness.state.activeAccountId = 'acct'; harness.state.activeModel = 'fixture/model';
  let input = null;
  harness._runClaude = async prompt => { input = prompt; return { text: 'idle', sessionEpoch: harness._sessionEpoch }; };
  await harness._beat();
  return input;
}

test('heartbeat: the cap is re-checked before the agent acts, and a failing re-check never blocks the beat', async () => {
  const seen = [];
  assert.ok(await beatWith(async id => { seen.push(id); return { state: 'in_sync' }; }));
  assert.deepEqual(seen, ['sbx_fixture']);
  assert.ok(await beatWith(async () => { throw new Error('backend down'); }), 'the beat still runs');
  assert.ok(await beatWith(undefined), 'a harness without the hook (default) still runs');
});
