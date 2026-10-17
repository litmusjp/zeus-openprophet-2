import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
function productionHandlers({ fetchImpl, selected = 'sbx_723be98b' }) {
  const start = html.indexOf('let _managedGateRevision = null;');
  const end = html.indexOf('async function testAlphaDesk()', start);
  assert.ok(start >= 0 && end > start, 'production managed gate handlers are present');
  const elements = {
    'alphadesk-review-required': { checked: false, disabled: false },
    'alphadesk-review-state': { textContent: '', style: {} },
  };
  const context = {
    document: { getElementById: id => elements[id] },
    fetch: fetchImpl,
    getEffectiveSandboxId: () => selected,
  };
  vm.runInNewContext(html.slice(start, end) + '\nglobalThis.handlers = { loadManagedReviewGate, saveManagedReviewGate };', context);
  return { ...context.handlers, elements, select: id => { selected = id; } };
}

test('actual AlphaDesk panel shows shared lock semantics and handler uses effective readback/CAS', async () => {
  assert.match(html, /Require human review — pause autonomous new entries/);
  assert.match(html, /Shared AlphaDesk connection: L1 \+ L2/);
  assert.match(html, /not a per-order approval queue/);
  assert.match(html, /does not guarantee execution or a fill/);
  const calls = [];
  let gate = { required: false, revision: 3 };
  const ui = productionHandlers({ fetchImpl: async (url, options = {}) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      assert.equal(body.expectedRevision, gate.revision);
      gate = { required: body.required, revision: gate.revision + 1 };
    }
    return new Response(JSON.stringify({ status: 'effective', ...gate, sharedConnection: 'Shared AlphaDesk connection: L1 + L2', op2RequireConfirmation: true, fetchedAt: '2026-10-17T00:00:00Z' }), { status: 200 });
  } });
  await ui.loadManagedReviewGate();
  assert.equal(ui.elements['alphadesk-review-required'].disabled, false);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /Effective.*revision 3.*OP2 confirmation ON/);
  ui.elements['alphadesk-review-required'].checked = true;
  await ui.saveManagedReviewGate();
  assert.equal(gate.revision, 4);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /Effective.*ON, revision 4/);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.match(calls[0].url, /sandboxId=sbx_723be98b/);
  assert.deepEqual(JSON.parse(calls[1].options.body), { sandboxId: 'sbx_723be98b', required: true, expectedRevision: 3 });
});

test('actual AlphaDesk panel refuses stale save and keeps failed readback unknown', async () => {
  let calls = 0;
  const ui = productionHandlers({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ status: 'effective', required: false, revision: 3, op2RequireConfirmation: false, fetchedAt: '2026-10-17T00:00:00Z' }), { status: 200 });
    return new Response(JSON.stringify({ error: 'Managed policy changed; reload current state', status: 'stale' }), { status: 409 });
  } });
  await ui.loadManagedReviewGate();
  ui.elements['alphadesk-review-required'].checked = true;
  await ui.saveManagedReviewGate();
  assert.equal(ui.elements['alphadesk-review-required'].disabled, true);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /Failed — state changed; reload required/);
  assert.equal(calls, 2);
});

test('actual AlphaDesk panel leaves the toggle disabled and labels a failed authoritative read unknown', async () => {
  const ui = productionHandlers({ fetchImpl: async () => new Response(JSON.stringify({ error: 'Managed policy state is unknown', status: 'unknown' }), { status: 502 }) });
  await ui.loadManagedReviewGate();
  assert.equal(ui.elements['alphadesk-review-required'].disabled, true);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /^Unknown/);
});
