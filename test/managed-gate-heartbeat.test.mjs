import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import axios from 'axios';
import { AgentHarness } from '../agent/harness.js';
import { createManagedReviewPolicyReader } from '../agent/managed-policy-client.js';

const sandbox = { plugins: { alphadesk: { enabled: true, requireManagedApprovalGate: true } } };
const policy = { contract_version: 'managed-assessment-v1', assessment_authority: 'assessment_only', approval_gate: {
  required: true, revision: 12, scope: { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assessment_key_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
} };

async function beat(getManagedReviewPolicy, requireConfirmation = false) {
  const harness = new AgentHarness({
    sandboxId: 'sbx_fixture', accountId: 'acct', getSandbox: () => sandbox,
    getPermissions: () => ({ requireConfirmation }), getManagedReviewPolicy,
    getCurrentPhaseFn: () => 'closed',
  });
  harness.state.activeAccountId = 'acct'; harness.state.activeModel = 'fixture/model';
  let input = '';
  harness._runClaude = async prompt => { input = prompt; return { text: 'idle', sessionEpoch: harness._sessionEpoch }; };
  await harness._beat();
  return input;
}

test('assembled heartbeat user input includes fresh managed scope/revision and independent OP2 state', async () => {
  const input = await beat(async () => policy, true);
  assert.match(input, /AUTHORITATIVE OPTIONS REVIEW STATE \(fetched .* options only\)/);
  assert.match(input, /OP2 requireConfirmation=ON; AlphaDesk review lock=ON, revision=12/);
  assert.match(input, /workspace_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
  assert.match(input, /assessment_key_id=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/);
  assert.match(input, /prefer one guarded prophet_place_options_order call/);
  assert.match(input, /Never blindly retry/);
});

test('assembled heartbeat user input fails closed to unknown when current policy read fails', async () => {
  const input = await beat(async () => { throw new Error('private response must not surface'); });
  assert.match(input, /OP2 requireConfirmation=OFF; AlphaDesk review lock=UNKNOWN, revision=UNKNOWN, scope=UNKNOWN/);
  assert.match(input, /Do not request a new options entry/);
  assert.doesNotMatch(input, /private response/);
});

test('registered managed-policy reader calls the prefixed Go route on the current runtime and emits known OFF', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, sandbox: req.headers['x-openprophet-sandbox-id'], account: req.headers['x-openprophet-account-id'] });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ contract_version: 'managed-assessment-v1', assessment_authority: 'assessment_only', approval_gate: {
      required: false, revision: 13, scope: { workspace_id: policy.approval_gate.scope.workspace_id, assessment_key_id: policy.approval_gate.scope.assessment_key_id },
    } }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const runtime = { goReady: true, goAxios: axios.create({ baseURL: 'http://127.0.0.1:1', timeout: 5000 }) };
  const reader = createManagedReviewPolicyReader({ getClient: () => runtime.goAxios, isAvailable: () => runtime.goReady });
  const observedConfigs = [];
  runtime.goAxios = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, timeout: 5000,
    headers: { Authorization: 'Bearer fixture-token', 'X-OpenProphet-Sandbox-ID': 'sbx_fixture', 'X-OpenProphet-Account-ID': 'acct' } });
  runtime.goAxios.interceptors.request.use(config => { observedConfigs.push(config); return config; });
  const originalClient = runtime.goAxios;
  const source = fs.readFileSync(new URL('../agent/orchestrator.js', import.meta.url), 'utf8');
  const serverSource = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  assert.match(source, /getClient: id => this\.getSandboxRuntime\(id\)\?\.goAxios/);
  assert.match(serverSource, /createManagedReviewPolicyReader/);
  assert.match(serverSource, /getClient: sandboxId => isActiveSandbox\(sandboxId\) \? goAxios : orchestrator\.getSandboxRuntime\(sandboxId\)\?\.goAxios/);
  runtime.goAxios = originalClient;
  const input = await beat(reader, false);
  assert.deepEqual(requests.map(r => r.url), ['/api/v1/options/assessment-policy']);
  assert.equal(requests[0].authorization, 'Bearer fixture-token');
  assert.equal(requests[0].sandbox, 'sbx_fixture');
  assert.equal(requests[0].account, 'acct');
  assert.equal(observedConfigs[0].timeout, 5000);
  assert.match(input, /AlphaDesk review lock=OFF, revision=13/);
  assert.match(input, /workspace_id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
});
