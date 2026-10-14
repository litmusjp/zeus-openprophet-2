import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('async function saveAgentPrompt(');
const end = html.indexOf('\nasync function previewAgentPrompt(', start);
assert.ok(start >= 0 && end > start, 'saveAgentPrompt handler exists');
const source = `${html.slice(start, end)}\nthis.saveAgentPrompt = saveAgentPrompt;`;

function createHarness(putResponse) {
  const calls = [];
  const alerts = [];
  const events = [];
  const context = {
    document: { getElementById: () => ({ value: '  preserve this strategy text  ' }) },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return putResponse;
      return { ok: true, json: async () => ({ agents: [] }) };
    },
    encodeURIComponent,
    JSON,
    config: { original: true },
    renderAll: () => events.push('render'),
    logToSandbox: (...args) => events.push(['log', ...args]),
    fmtTime: () => 'time',
    esc: value => value,
    getEffectiveSandboxId: () => 'sandbox',
    alert: message => alerts.push(message),
  };
  vm.runInNewContext(source, context);
  return { run: () => context.saveAgentPrompt('herald'), calls, alerts, events, context };
}

test('successful prompt save preserves the PUT payload and refreshes the UI', async () => {
  const harness = createHarness({ ok: true, status: 200 });
  await harness.run();

  assert.equal(harness.calls[0].url, '/api/agents/herald');
  assert.equal(harness.calls[0].options.method, 'PUT');
  assert.deepEqual(JSON.parse(harness.calls[0].options.body), {
    customSystemPrompt: 'preserve this strategy text',
    systemPromptTemplate: 'custom',
  });
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.events[0], 'render');
  assert.match(harness.events[1][2], /Prompt saved for herald/);
  assert.deepEqual(harness.alerts, []);
});

test('rejected prompt save reports a safe error without refreshing or claiming success', async () => {
  const harness = createHarness({ ok: false, status: 400, text: 'private server detail' });
  await harness.run();

  assert.equal(harness.calls.length, 1);
  assert.deepEqual(harness.events, []);
  assert.equal(harness.alerts.length, 1);
  assert.match(harness.alerts[0], /400/);
  assert.doesNotMatch(harness.alerts[0], /private server detail/);
});
