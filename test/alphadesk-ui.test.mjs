import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const html = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

test('AlphaDesk UI tests saved sandbox settings without saving or restarting', () => {
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
  assert.doesNotMatch(testSource, /saveAlphaDeskConfig\(/);
  assert.match(testSource, /JSON\.stringify\(\{sandboxId:sid\}\)/);
  assert.doesNotMatch(testSource, /apiKey/);
});

test('managed quality controls are separate, default ON, shared, and require authoritative scoped readback', () => {
  assert.match(html, /Managed assessment quality — shared L1 \+ L2/);
  assert.match(html, /Default: 30/);
  assert.match(html, /Default: 0\.20/);
  assert.match(html, /id="alphadesk-quality-price" checked/);
  assert.match(html, /managed-quality-settings\?sandboxId=/);
  assert.match(html, /expectedRevision: revision/);
  assert.match(html, /Independent(?:ly)? authoritative readback|independent authoritative readback/i);
  assert.match(html, /_managedQualityGeneration/);
  assert.match(html, /_managedQualityDirty/);
  assert.match(html, /typeof v\.requirePriceActionConfirmation === 'boolean'/);
});
