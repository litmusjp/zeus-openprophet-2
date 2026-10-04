import test from 'node:test';
import assert from 'node:assert/strict';
import { testAlphaDeskAssessmentCapability } from '../agent/alphadesk-connection.js';

test('AlphaDesk connection probe requires authenticated assessment schema without sending evidence', async () => {
  for (const [code, status, ok] of [[401,'authentication',false],[403,'authentication',false],[404,'schema',false],[500,'evidence_unavailable',false],[302,'connection',false],[200,'schema',false],[422,'evidence_unavailable',false]]) {
    let calls = 0;
    const result = await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async (url, options) => {
      calls++;
      assert.equal(url, 'https://desk.example/api/v1/desk/strategy-assessments');
      assert.equal(options.headers['X-AlphaDesk-API-Key'], 'secret');
      assert.equal(options.body, '{}');
      assert.equal(options.redirect, 'manual');
      return { status: code };
    });
    assert.deepEqual([result.status, result.ok, calls], [status, ok, 1]);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  const timeout = await testAlphaDeskAssessmentCapability('https://desk.example', 'secret', async () => { throw new Error('secret timeout'); });
  assert.equal(timeout.status, 'connection');
  assert.doesNotMatch(JSON.stringify(timeout), /secret/);
  assert.equal((await testAlphaDeskAssessmentCapability('https://desk.example', '', async () => { throw new Error('should not call'); })).status, 'authentication');
});
