import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

test('AlphaDesk UI saves typed URL and API key before testing persisted config', () => {
  assert.match(html, /onclick="saveAlphaDeskConfig\(\)">Save AlphaDesk settings/);
  assert.doesNotMatch(html, /id="alphadesk-enabled" onchange="saveAlphaDeskConfig\(\)"/);

  const bodyStart = html.indexOf('function alphaDeskConfigBody()');
  const saveStart = html.indexOf('async function saveAlphaDeskConfig()');
  const testStart = html.indexOf('async function testAlphaDesk()');
  const stopStart = html.indexOf('function stopPolling()', testStart);
  assert.ok(bodyStart >= 0 && testStart > saveStart && saveStart > bodyStart && stopStart > testStart);

  const saveSource = html.slice(bodyStart, testStart);
  const testSource = html.slice(testStart, stopStart);
  assert.match(saveSource, /body\.apiKey = key/);
  assert.match(saveSource, /await fetch\('\/api\/plugins\/alphadesk'/);
  assert.match(testSource, /if \(!await saveAlphaDeskConfig\(\)\) return;/);
  assert.ok(testSource.indexOf('await saveAlphaDeskConfig()') < testSource.indexOf("fetch('/api/plugins/alphadesk/test'"));
  assert.doesNotMatch(testSource, /apiKey/);
});
