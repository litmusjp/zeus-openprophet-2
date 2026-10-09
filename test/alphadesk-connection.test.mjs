import test from 'node:test';
import assert from 'node:assert/strict';
import { testAlphaDeskAssessmentCapability } from '../agent/alphadesk-connection.js';

const endpoint = 'https://desk.example/api/v2/option-trade-assessments/policy';
const policy = {
  scope: 'TRADE_ASSESSMENT',
  policy_version: 'standalone-paper-advisory-v1:abc123',
  minimum_passing_score: '72.5',
  supported_strategies: ['long_call', 'long_put', 'bull_call_debit_spread', 'bear_put_debit_spread'],
  policy_snapshot: { minimum_signal_score: 72.5 },
  execution_allowed: false,
  paper_only: true,
  human_approval_required: true,
};
const successMessage = /authenticated assessment policy is available.*market evidence\/readiness, trade decisions and broker execution were NOT tested/i;

function response(status, body = policy, jsonError = null) {
  return { status, async json() { if (jsonError) throw jsonError; return body; } };
}

function assertRequest(url, options) {
  assert.equal(url, endpoint);
  assert.equal(options.method, 'GET');
  assert.equal(options.headers['X-AlphaDesk-API-Key'], 'secret');
  assert.equal(options.redirect, 'manual');
  assert.equal(options.signal?.aborted, false);
  assert.equal('body' in options, false);
  assert.equal(url, 'https://desk.example/api/v2/option-trade-assessments/policy', 'never call assessment submission or order routes');
}

test('valid standalone policy succeeds using only the authenticated read-only policy endpoint', async () => {
  let calls = 0;
  const result = await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
    calls++;
    assertRequest(url, options);
    return response(200);
  });
  assert.equal(calls, 1);
  assert.deepEqual([result.ok, result.status], [true, 'connected']);
  assert.match(result.message, successMessage);
  assert.doesNotMatch(JSON.stringify(result), /secret|abc123|72\.5/);
});

test('classifies authentication, endpoint, redirect, and server responses without leaking payloads', async () => {
  for (const [code, status] of [[401,'authentication'],[403,'authentication'],[404,'schema'],[405,'schema'],[302,'connection'],[500,'service']]) {
    const result = await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
      assertRequest(url, options);
      return { status: code, async json() { return { detail: 'secret provider payload' }; } };
    });
    assert.deepEqual([result.ok, result.status], [false, status]);
    assert.doesNotMatch(JSON.stringify(result), /secret|provider payload/);
  }
});

test('rejects invalid JSON, arbitrary success bodies, and malformed policy metadata', async () => {
  const malformed = [null, '<html>ok</html>', {}, ...[
    ['scope', 'OTHER'], ['policy_version', ' '], ['paper_only', false],
    ['execution_allowed', true], ['human_approval_required', false],
    ['supported_strategies', []], ['supported_strategies', ['long_call', 4]],
    ['minimum_passing_score', 'NaN'], ['minimum_passing_score', -1],
    ['minimum_passing_score', 101],
  ].map(([key, value]) => ({ ...policy, [key]: value }))];
  const results = [
    await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
      assertRequest(url, options); return response(200, null, new Error('secret JSON error'));
    }),
    ...await Promise.all(malformed.map(body => testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
      assertRequest(url, options); return response(200, body);
    }))),
  ];
  for (const result of results) {
    assert.deepEqual([result.ok, result.status], [false, 'schema']);
    assert.doesNotMatch(JSON.stringify(result), /secret|provider payload/);
  }
});

test('missing key makes no request; transport timeout stays secret-safe', async () => {
  let calls = 0;
  const missing = await testAlphaDeskAssessmentCapability('https://desk.example', '', async () => { calls++; });
  assert.deepEqual([missing.ok, missing.status, calls], [false, 'authentication', 0]);
  const timeout = await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
    assertRequest(url, options); throw new Error('secret timeout');
  });
  assert.deepEqual([timeout.ok, timeout.status], [false, 'connection']);
  assert.doesNotMatch(JSON.stringify(timeout), /secret/);
});
