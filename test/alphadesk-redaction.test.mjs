import assert from 'node:assert/strict';
import test from 'node:test';
import { redactSecrets } from '../agent/redaction.js';

test('AlphaDesk apiKey is fully masked in plugin and config serialization', () => {
  const configuredKey = 'alphadesk-write-only-key-1234';
  const pluginResponse = redactSecrets({ apiKey: configuredKey }, true);
  const configResponse = redactSecrets({
    plugins: {
      alphadesk: { apiKey: configuredKey },
      unrelated: { apiKey: configuredKey },
    },
  });

  assert.equal(pluginResponse.apiKey, '****');
  assert.equal(configResponse.plugins.alphadesk.apiKey, '****');
  assert.equal(configResponse.plugins.unrelated.apiKey, '****1234');
  assert.doesNotMatch(JSON.stringify(pluginResponse), /1234/);
  assert.doesNotMatch(JSON.stringify(configResponse.plugins.alphadesk), /alphadesk-write-only-key-1234|1234/);
});
