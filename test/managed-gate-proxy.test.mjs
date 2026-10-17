import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'crypto';
import { once } from 'events';
import { createAuthMiddleware, createBasicAuthMiddleware, createBasicOperatorOnlyMiddleware } from '../agent/auth.js';
import { createManagedGateProxy, registerManagedGateProxy, MANAGED_ALPHADESK_ORIGIN } from '../agent/managed-gate-proxy.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const keyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const assessmentKey = 'local-assessment-fixture';
const controlKey = 'local-control-fixture';
const env = {
  ALPHADESK_CONTROL_KEY: controlKey,
  ALPHADESK_CONTROL_ASSESSMENT_KEY_SHA256: createHash('sha256').update(assessmentKey).digest('hex'),
  ALPHADESK_CONTROL_WORKSPACE_ID: workspaceId,
  ALPHADESK_CONTROL_ASSESSMENT_KEY_ID: keyId,
};
const sandboxIds = ['sbx_723be98b', 'sbx_956ff9e4'];

function fixture({ origin = MANAGED_ALPHADESK_ORIGIN, key = assessmentKey, managed = true } = {}) {
  const sandboxes = Object.fromEntries(sandboxIds.map((id, index) => [id, {
    id, permissions: { requireConfirmation: index === 1 },
    plugins: { alphadesk: { enabled: true, url: origin, apiKey: key, requireManagedApprovalGate: managed } },
  }]));
  let gate = { required: false, revision: 3 };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, MANAGED_ALPHADESK_ORIGIN);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-AlphaDesk-API-Key'], assessmentKey);
    if (options.method === 'PUT') {
      assert.equal(options.headers['X-AlphaDesk-Control-Key'], controlKey);
      const body = JSON.parse(options.body);
      assert.equal(body.expected_revision, gate.revision);
      if (body.required !== gate.required) gate = { required: body.required, revision: gate.revision + 1 };
    }
    return new Response(JSON.stringify({
      contract_version: 'managed-assessment-v1',
      approval_gate: { ...gate, scope: { workspace_id: workspaceId, assessment_key_id: keyId, injected_secret: 'must-not-escape' } },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const proxy = createManagedGateProxy({
    env, fetchImpl,
    getSandbox: id => sandboxes[id] || null,
    getPluginForSandbox: (id, name) => sandboxes[id]?.plugins?.[name] || null,
  });
  return { proxy, calls, get gate() { return gate; } };
}

async function withServer(t, setup = {}) {
  const app = express();
  app.use(express.json());
  const token = 'agent-api-fixture';
  app.use(createBasicAuthMiddleware({ username: 'operator', password: 'pass', apiToken: token }));
  app.use('/api', createAuthMiddleware({ token }));
  const state = fixture(setup);
  registerManagedGateProxy(app, { proxy: state.proxy, operatorOnly: createBasicOperatorOnlyMiddleware() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/plugins/alphadesk/managed-review-gate`;
  const basic = `Basic ${Buffer.from('operator:pass').toString('base64')}`;
  return { url, basic, token, ...state };
}

test('production proxy handler reads shared gate and saves with CAS plus exact authoritative readback', async t => {
  const ctx = await withServer(t);
  let response = await fetch(`${ctx.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const initial = await response.json();
  assert.equal(initial.status, 'effective');
  assert.equal(initial.required, false);
  assert.equal(initial.revision, 3);
  assert.equal(initial.sharedConnection, 'Shared AlphaDesk connection: L1 + L2');
  assert.equal(initial.op2RequireConfirmation, false);
  assert.deepEqual(Object.keys(initial.scope).sort(), ['assessment_key_id', 'workspace_id']);
  assert.equal(JSON.stringify(initial).includes('injected_secret'), false);

  response = await fetch(ctx.url, { method: 'PUT', headers: { Authorization: ctx.basic, 'Content-Type': 'application/json' }, body: JSON.stringify({ sandboxId: sandboxIds[1], required: true, expectedRevision: 3 }) });
  assert.equal(response.status, 200);
  const saved = await response.json();
  assert.equal(saved.required, true);
  assert.equal(saved.revision, 4);
  assert.equal(saved.op2RequireConfirmation, true);
  response = await fetch(`${ctx.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } });
  assert.deepEqual((await response.json()).approval_gate, undefined);
  const fromL1 = await fetch(`${ctx.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } }).then(r => r.json());
  assert.equal(fromL1.required, true);
  assert.equal(fromL1.revision, 4);
  assert.equal(ctx.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('generic API bearer and loopback do not satisfy the operator proof', async t => {
  const ctx = await withServer(t);
  for (const [headers, expectedStatus] of [[{ Authorization: `Bearer ${ctx.token}` }, 403], [{}, 401]]) {
    const response = await fetch(`${ctx.url}?sandboxId=${sandboxIds[0]}`, { headers });
    assert.equal(response.status, expectedStatus);
  }
  assert.equal(ctx.calls.length, 0);
});

test('stale writes, unrelated sandbox, wrong origin and wrong assessment key fail closed', async t => {
  const ctx = await withServer(t);
  const headers = { Authorization: ctx.basic, 'Content-Type': 'application/json' };
  let response = await fetch(ctx.url, { method: 'PUT', headers, body: JSON.stringify({ sandboxId: sandboxIds[0], required: true, expectedRevision: 2 }) });
  assert.equal(response.status, 409);
  response = await fetch(`${ctx.url}?sandboxId=other`, { headers: { Authorization: ctx.basic } });
  assert.equal(response.status, 404);
  const badOrigin = await withServer(t, { origin: 'https://replacement.example' });
  response = await fetch(`${badOrigin.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: badOrigin.basic } });
  assert.equal(response.status, 409);
  const badKey = await withServer(t, { key: 'wrong-assessment-key' });
  response = await fetch(`${badKey.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: badKey.basic } });
  assert.equal(response.status, 409);
});

test('altered authority paths and stalled or oversized response bodies remain unknown', async () => {
  const altered = fixture({ origin: `${MANAGED_ALPHADESK_ORIGIN}/changed` });
  await assert.rejects(altered.proxy.resolveBinding(sandboxIds[0]), /pinned authority/);
  for (const body of [
    { getReader: () => ({ read: () => new Promise(() => {}), cancel: async () => {} }) },
    { getReader: () => ({ read: async () => ({ done: false, value: new Uint8Array(128) }), cancel: async () => {} }) },
  ]) {
    const proxy = createManagedGateProxy({ env, timeoutMs: 10, maxBodyBytes: 64,
      getSandbox: id => ({ id, permissions: {} }),
      getPluginForSandbox: () => ({ enabled: true, requireManagedApprovalGate: true, url: MANAGED_ALPHADESK_ORIGIN, apiKey: assessmentKey }),
      fetchImpl: async () => ({ status: 200, headers: new Headers(), body, text: async () => '' }),
    });
    await assert.rejects(proxy.read(sandboxIds[0]));
  }
});
