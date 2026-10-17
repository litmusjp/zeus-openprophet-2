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

test('a real CAS save owns same-sandbox refreshes until authoritative write readback completes', async () => {
  let pending = [];
  const calls = [];
  const ui = productionHandlers({ fetchImpl: (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    return new Promise(resolve => pending.push(resolve));
  } });
  const initial = ui.loadManagedReviewGate();
  assert.equal(calls[0].method, 'GET');
  pending[0](new Response(JSON.stringify({ status: 'effective', required: false, revision: 3, op2RequireConfirmation: false }), { status: 200 }));
  await initial;
  ui.elements['alphadesk-review-required'].checked = true;
  const save = ui.saveManagedReviewGate();
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body, { sandboxId: 'sbx_723be98b', required: true, expectedRevision: 3 });
  const refresh = ui.loadManagedReviewGate();
  assert.equal(calls[2].method, 'GET');
  pending[2](new Response(JSON.stringify({ status: 'effective', required: false, revision: 3, op2RequireConfirmation: false }), { status: 200 }));
  await refresh;
  assert.equal(ui.elements['alphadesk-review-required'].disabled, true);
  assert.equal(ui.elements['alphadesk-review-required'].checked, true);
  pending[1](new Response(JSON.stringify({ status: 'effective', required: true, revision: 4, op2RequireConfirmation: false }), { status: 200 }));
  await save;
  assert.equal(ui.elements['alphadesk-review-required'].disabled, false);
  assert.equal(ui.elements['alphadesk-review-required'].checked, true);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /revision 4/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});

test('selection round-trip fences late save errors from the prior selected context', async () => {
  let pending = [];
  const ui = productionHandlers({ fetchImpl: (url, options = {}) => new Promise(resolve => pending.push({ resolve, method: options.method || 'GET' })) });
  const initial = ui.loadManagedReviewGate();
  pending[0].resolve(new Response(JSON.stringify({ status: 'effective', required: false, revision: 3 }), { status: 200 }));
  await initial;
  ui.elements['alphadesk-review-required'].checked = true;
  const save = ui.saveManagedReviewGate();
  assert.equal(pending.length, 2);
  ui.select('sbx_other');
  const latest = ui.loadManagedReviewGate();
  pending[2].resolve(new Response(JSON.stringify({ status: 'effective', required: false, revision: 3 }), { status: 200 }));
  await latest;
  ui.select('sbx_723be98b');
  const roundTrip = ui.loadManagedReviewGate();
  pending[3].resolve(new Response(JSON.stringify({ status: 'effective', required: false, revision: 5 }), { status: 200 }));
  await roundTrip;
  pending[1].resolve(new Response(JSON.stringify({ status: 'unknown', error: 'old failure' }), { status: 502 }));
  await save;
  assert.equal(pending.length, 5);
  pending[4].resolve(new Response(JSON.stringify({ status: 'effective', required: false, revision: 5 }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements['alphadesk-review-required'].disabled, false);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /revision 5/);
});

test('shared L2 view stays disabled during L1 write and refreshes after committed readback', async () => {
  let pending = [];
  const calls = [];
  const ui = productionHandlers({ fetchImpl: (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body && JSON.parse(options.body) });
    return new Promise(resolve => pending.push(resolve));
  } });
  const initial = ui.loadManagedReviewGate();
  assert.equal(calls[0].method, 'GET');
  pending[0](new Response(JSON.stringify({ status: 'effective', required: false, revision: 3 }), { status: 200 }));
  await initial;

  ui.elements['alphadesk-review-required'].checked = true;
  const save = ui.saveManagedReviewGate();
  assert.equal(calls[1].method, 'PUT');
  assert.deepEqual(calls[1].body, { sandboxId: 'sbx_723be98b', required: true, expectedRevision: 3 });

  ui.select('sbx_other');
  const l2Read = ui.loadManagedReviewGate();
  assert.equal(calls[2].method, 'GET');
  pending[2](new Response(JSON.stringify({ status: 'effective', required: false, revision: 3 }), { status: 200 }));
  await l2Read;
  assert.equal(ui.elements['alphadesk-review-required'].disabled, true);

  pending[1](new Response(JSON.stringify({ status: 'effective', required: true, revision: 4 }), { status: 200 }));
  await save;
  assert.equal(calls[3].method, 'GET');
  pending[3](new Response(JSON.stringify({ status: 'effective', required: true, revision: 4 }), { status: 200 }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.elements['alphadesk-review-required'].disabled, false);
  assert.equal(ui.elements['alphadesk-review-required'].checked, true);
  assert.match(ui.elements['alphadesk-review-state'].textContent, /revision 4/);
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
});
