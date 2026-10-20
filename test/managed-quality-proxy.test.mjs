import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createManagedGateProxy, createManagedQualityProxy, registerManagedQualityProxy, MANAGED_ALPHADESK_ORIGIN } from '../agent/managed-gate-proxy.js';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const keyId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const key = 'fixture-managed-api-key';
const control = 'fixture-managed-control-key';
const env = { ALPHADESK_CONTROL_KEY: control, ALPHADESK_CONTROL_WORKSPACE_ID: workspaceId, ALPHADESK_CONTROL_ASSESSMENT_KEY_ID: keyId,
  ALPHADESK_CONTROL_ASSESSMENT_KEY_SHA256: createHash('sha256').update(key).digest('hex') };
const ids = ['sbx_723be98b', 'sbx_956ff9e4'];

function setup() {
  const sandboxes = Object.fromEntries(ids.map(id => [id, { plugins: { alphadesk: { enabled: true, requireManagedApprovalGate: true, url: MANAGED_ALPHADESK_ORIGIN, apiKey: key } } }]));
  let record = { contract_version: 'managed-assessment-v1', scope: { workspace_id: workspaceId, assessment_key_id: keyId },
    defaults: { minimum_signal_score: 30, minimum_catalyst_confidence: 0.2, require_price_action_confirmation: true },
    effective: { minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true }, revision: 1 };
  let explicitlyPersisted = false;
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options }); assert.equal(new URL(url).origin, MANAGED_ALPHADESK_ORIGIN);
    assert.equal(options.headers['X-AlphaDesk-API-Key'], key);
    if (options.method === 'PUT') {
      assert.equal(options.headers['X-AlphaDesk-Control-Key'], control);
      const body = JSON.parse(options.body); assert.equal(body.expected_revision, record.revision);
      const { expected_revision: _, ...effective } = body;
      const changed = JSON.stringify(effective) !== JSON.stringify(record.effective);
      record = { ...record, effective, revision: record.revision + (!explicitlyPersisted || changed ? 1 : 0) };
      explicitlyPersisted = true;
    }
    const wireValue = value => ({ minimum_signal_score: String(value.minimum_signal_score), minimum_catalyst_confidence: String(value.minimum_catalyst_confidence), require_price_action_confirmation: value.require_price_action_confirmation });
    return new Response(JSON.stringify({ ...record, defaults: wireValue(record.defaults), effective: wireValue(record.effective) }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const proxy = createManagedQualityProxy({ env, fetchImpl, getSandbox: id => sandboxes[id], getPluginForSandbox: id => sandboxes[id]?.plugins?.alphadesk });
  return { proxy, calls, get record() { return record; } };
}
async function call(proxy, method, body = null, sandboxId = ids[0]) {
  const output = { statusCode: 200, headers: {}, set(name, value) { this.headers[name] = value; return this; }, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  await proxy.handle({ method, query: { sandboxId }, body: body && { sandboxId, ...body } }, output); return output;
}

test('quality proxy performs scoped GET and atomic PUT with authoritative readback', async () => {
  const state = setup();
  const before = await call(state.proxy, 'GET');
  assert.equal(before.body.status, 'effective'); assert.equal(before.body.revision, 1);
  assert.deepEqual(before.body.defaults, state.record.defaults);
  const saved = await call(state.proxy, 'PUT', { minimumSignalScore: 31, minimumCatalystConfidence: 0.2, requirePriceActionConfirmation: false, expectedRevision: 1 }, ids[1]);
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.revision, 2);
  assert.deepEqual(saved.body.effective, { minimum_signal_score: 31, minimum_catalyst_confidence: 0.2, require_price_action_confirmation: false });
  assert.equal(state.calls.filter(call => call.options.method === 'PUT').length, 1);
  assert.equal(saved.headers['Cache-Control'], 'no-store, max-age=0');
});

test('quality proxy rejects stale, cross-scope, non-finite and non-boolean writes', async () => {
  const state = setup();
  for (const [sandboxId, body, status] of [
    [ids[0], { minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 0 }, 422],
    [ids[0], { minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: 'true', expectedRevision: 1 }, 422],
    [ids[0], { minimumSignalScore: 101, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 1 }, 422],
    ['other', { minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 1 }, 404],
    [ids[0], { minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 2 }, 409],
  ]) { const result = await call(state.proxy, 'PUT', body, sandboxId); assert.equal(result.statusCode, status); }
  assert.equal(state.calls.filter(call => call.options.method === 'PUT').length, 0);
});

test('quality proxy accepts initial same-value persistence and verifies the independent revision', async () => {
  const state = setup();
  const saved = await call(state.proxy, 'PUT', { minimumSignalScore: 25, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 1 });
  assert.equal(saved.statusCode, 200); assert.equal(saved.body.revision, 2);
  assert.deepEqual(saved.body.effective, { minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true });
  assert.equal(state.calls.filter(call => call.options.method === 'PUT').length, 1);
});

test('quality proxy registers GET and PUT behind the existing operator-only middleware', () => {
  const routes = [], operatorOnly = () => {};
  registerManagedQualityProxy({ get: (...values) => routes.push(['GET', ...values]), put: (...values) => routes.push(['PUT', ...values]) }, { proxy: { handle() {} }, operatorOnly });
  assert.deepEqual(routes.map(([method, path, middleware]) => [method, path, middleware === operatorOnly]), [
    ['GET', '/api/plugins/alphadesk/managed-quality-settings', true], ['PUT', '/api/plugins/alphadesk/managed-quality-settings', true],
  ]);
});

test('managed review proxy accepts the actual AD response without a policy version', async () => {
  let gate = { required: false, revision: 9 };
  let gateScope = { workspace_id: workspaceId, assessment_key_id: keyId };
  const sandboxes = Object.fromEntries(ids.map(id => [id, { permissions: {}, plugins: { alphadesk: {
    enabled: true, requireManagedApprovalGate: true, url: MANAGED_ALPHADESK_ORIGIN, apiKey: key,
  } } }]));
  const proxy = createManagedGateProxy({ env, getSandbox: id => sandboxes[id], getPluginForSandbox: id => sandboxes[id]?.plugins?.alphadesk,
    fetchImpl: async () => new Response(JSON.stringify({ contract_version: 'managed-assessment-v1',
      approval_gate: { ...gate, scope: gateScope } }), { status: 200 }) });
  const valid = await proxy.read(ids[0]);
  assert.equal(valid.revision, 9);
  assert.equal(valid.required, false);
  assert.deepEqual(valid.scope, { workspace_id: workspaceId, assessment_key_id: keyId });
  for (const invalid of [
    { gate: { required: 'false', revision: 9 }, scope: gateScope },
    { gate: { required: false, revision: 0 }, scope: gateScope },
    { gate, scope: { workspace_id: workspaceId, assessment_key_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' } },
  ]) {
    gate = invalid.gate;
    gateScope = invalid.scope;
    await assert.rejects(proxy.read(ids[0]), /unknown/i);
  }
});
