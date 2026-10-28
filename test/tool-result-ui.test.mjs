import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const start = page.indexOf("es.addEventListener('tool_result'");
const end = page.indexOf("es.addEventListener('heartbeat_change'", start);
assert.ok(start >= 0 && end > start, 'production tool_result handler is present');
const handlerSource = page.slice(start, end);

function harness() {
  const sandbox = [], global = [], brokerActions = [];
  const context = {
    JSON,
    es: { addEventListener(name, callback) { if (name === 'tool_result') this.handler = callback; } },
    getEffectiveSandboxId: () => 'l1',
    fmtTime: () => '12:00',
    esc: value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])),
    formatSandboxPrefix: () => '[L1] ',
    logToSandbox: (id, html) => sandbox.push({ id, html }),
    logHtml: (html, type) => global.push({ html, type }),
    noteBrokerAction: event => brokerActions.push(event),
  };
  vm.runInNewContext(handlerSource, context);
  return {
    sandbox, global, brokerActions,
    emit(data) { context.es.handler({ data: JSON.stringify(data) }); },
  };
}

test('production tool_result handler shows bounded escaped errors in both log scopes', () => {
  const h = harness();
  h.emit({ sandboxId: 'l1', name: 'assess', result: '', error: '<img src=x onerror=alert(1)>' });
  assert.equal(h.sandbox[0].id, 'l1');
  assert.match(h.sandbox[0].html, /ERROR: &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(h.global[0].html, /\[L1\] assess: ERROR: &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(h.global[0].type, 'info');
  assert.equal(h.brokerActions.length, 1);
});

test('production tool_result handler safely falls back for null or missing result and preserves success display', () => {
  const h = harness();
  h.emit({ sandboxId: 'l2', name: 'missing', result: null });
  h.emit({ name: 'undefined' });
  h.emit({ name: 'success', result: 'done' });
  assert.match(h.sandbox[0].html, /\(no result\)/);
  assert.match(h.global[1].html, /\(no result\)/);
  assert.match(h.global[2].html, /\[L1\] success: done/);
  assert.deepEqual(h.sandbox.map(row => row.id), ['l2', 'l1', 'l1']);
  assert.equal(h.brokerActions.length, 3);
});

test('production tool_result handler bounds rendered error text to 200 characters', () => {
  const h = harness();
  h.emit({ name: 'long', error: 'E'.repeat(250), result: '' });
  assert.equal(h.global[0].html.match(/ERROR: (E+)/)[1].length, 200);
});
