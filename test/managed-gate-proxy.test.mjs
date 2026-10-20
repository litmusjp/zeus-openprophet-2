import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHash } from 'crypto';
import { once } from 'events';
import { createAuthMiddleware, createBasicAuthMiddleware, createBasicOperatorOnlyMiddleware } from '../agent/auth.js';
import { createManagedGateProxy, registerManagedGateProxy, createManagedQualityProxy, registerManagedQualityProxy, MANAGED_ALPHADESK_ORIGIN } from '../agent/managed-gate-proxy.js';

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
  let quality = { defaults: { minimum_signal_score: 30, minimum_catalyst_confidence: 0.2, require_price_action_confirmation: true }, effective: { minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true }, revision: 1 };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    assert.equal(new URL(url).origin, MANAGED_ALPHADESK_ORIGIN);
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers['X-AlphaDesk-API-Key'], assessmentKey);
    if (url.endsWith('/managed-quality-settings')) {
      if (options.method === 'PUT') {
        assert.equal(options.headers['X-AlphaDesk-Control-Key'], controlKey);
        const body = JSON.parse(options.body);
        assert.equal(body.expected_revision, quality.revision);
        const { expected_revision, ...effective } = body;
        quality = { ...quality, effective, revision: quality.revision + 1 };
      }
      return new Response(JSON.stringify({ contract_version: 'managed-assessment-v1', scope: { workspace_id: workspaceId, assessment_key_id: keyId }, ...quality }), { status: 200 });
    }
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
  const qualityProxy = createManagedQualityProxy({ env, fetchImpl,
    getSandbox: id => sandboxes[id] || null,
    getPluginForSandbox: (id, name) => sandboxes[id]?.plugins?.[name] || null,
  });
  return { proxy, qualityProxy, calls, get gate() { return gate; }, get quality() { return quality; } };
}

async function withServer(t, setup = {}) {
  const app = express();
  app.use(express.json());
  const token = 'agent-api-fixture';
  app.use(createBasicAuthMiddleware({ username: 'operator', password: 'pass', apiToken: token }));
  app.use('/api', createAuthMiddleware({ token }));
  const state = fixture(setup);
  registerManagedGateProxy(app, { proxy: state.proxy, operatorOnly: createBasicOperatorOnlyMiddleware() });
  registerManagedQualityProxy(app, { proxy: state.qualityProxy, operatorOnly: createBasicOperatorOnlyMiddleware() });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/plugins/alphadesk/managed-review-gate`;
  const qualityUrl = `http://127.0.0.1:${server.address().port}/api/plugins/alphadesk/managed-quality-settings`;
  const basic = `Basic ${Buffer.from('operator:pass').toString('base64')}`;
  return { url, qualityUrl, basic, token, ...state };
}

test('managed quality proxy saves all settings atomically and independently reads scoped authoritative state', async t => {
  const ctx = await withServer(t);
  let response = await fetch(`${ctx.qualityUrl}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } });
  assert.equal(response.status, 200); const initial = await response.json();
  assert.deepEqual(initial.defaults, { minimum_signal_score: 30, minimum_catalyst_confidence: 0.2, require_price_action_confirmation: true });
  assert.deepEqual(initial.effective, { minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true });
  response = await fetch(ctx.qualityUrl, { method: 'PUT', headers: { Authorization: ctx.basic, 'Content-Type': 'application/json' }, body: JSON.stringify({ sandboxId: sandboxIds[1], minimumSignalScore: 31, minimumCatalystConfidence: 0.22, requirePriceActionConfirmation: false, expectedRevision: 1 }) });
  assert.equal(response.status, 200); const saved = await response.json();
  assert.deepEqual(saved.effective, { minimum_signal_score: 31, minimum_catalyst_confidence: 0.22, require_price_action_confirmation: false });
  assert.equal(saved.revision, 2);
  response = await fetch(`${ctx.qualityUrl}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } });
  assert.deepEqual((await response.json()).effective, saved.effective);
  assert.equal(ctx.calls.filter(call => call.url.endsWith('/managed-quality-settings') && call.options.method === 'PUT').length, 1);
});

test('managed quality proxy rejects stale revisions, coercible booleans and non-finite/out-of-range settings', async t => {
  const ctx = await withServer(t); const headers = { Authorization: ctx.basic, 'Content-Type': 'application/json' };
  for (const [body, status] of [
    [{ sandboxId: sandboxIds[0], minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 0 }, 422],
    [{ sandboxId: sandboxIds[0], minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: 'false', expectedRevision: 1 }, 422],
    [{ sandboxId: sandboxIds[0], minimumSignalScore: 101, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 1 }, 422],
    [{ sandboxId: sandboxIds[0], minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 2 }, 409],
  ]) {
    const response = await fetch(ctx.qualityUrl, { method: 'PUT', headers, body: JSON.stringify(body) }); assert.equal(response.status, status);
  }
});

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

test('managed gate proxy reads the actual AD gate response without policy metadata', async t => {
  const ctx = await withServer(t);
  let response = await fetch(`${ctx.url}?sandboxId=${sandboxIds[0]}`, { headers: { Authorization: ctx.basic } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.required, false);
  assert.equal(result.revision, 3);
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
