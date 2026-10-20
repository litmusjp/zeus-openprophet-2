import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const html = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const begin = html.indexOf('let _managedQualityRevision = null;');
const end = html.indexOf('function alphaDeskConfigBody()', begin);
assert.ok(begin >= 0 && end > begin);
const source = html.slice(begin, end);
function ui(fetchImpl) {
  const elements = Object.fromEntries(['alphadesk-quality-score', 'alphadesk-quality-catalyst', 'alphadesk-quality-price', 'alphadesk-quality-save', 'alphadesk-quality-state'].map(id => {
    let value = id.endsWith('score') ? '25' : '0.15'; const element = { checked: true, disabled: true, textContent: '', style: {} };
    Object.defineProperty(element, 'value', { get: () => value, set: next => { value = String(next); } }); return [id, element];
  }));
  let sandboxId = 'sbx_723be98b';
  const context = vm.createContext({ document: { getElementById: id => elements[id] }, fetch: fetchImpl, getEffectiveSandboxId: () => sandboxId, Number, Object, JSON, Error, console });
  vm.runInContext(source, context);
  return { context, elements, setSandbox: value => { sandboxId = value; }, run: code => vm.runInContext(code, context) };
}
const result = (effective = { minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true }, revision = 1) => ({ status: 'effective', revision, defaults: { minimum_signal_score: 30, minimum_catalyst_confidence: 0.2, require_price_action_confirmation: true }, effective, fetchedAt: 'fixture-time' });
const response = body => ({ ok: true, json: async () => body });

test('quality UI loads authoritative values and keeps failed state unknown', async () => {
  const state = ui(async () => response(result({ minimum_signal_score: 34, minimum_catalyst_confidence: 0.24, require_price_action_confirmation: false }, 7)));
  await state.run('loadManagedQuality()');
  assert.equal(state.elements['alphadesk-quality-score'].value, '34');
  assert.equal(state.elements['alphadesk-quality-catalyst'].value, '0.24');
  assert.equal(state.elements['alphadesk-quality-price'].checked, false);
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Effective/);

  const failed = ui(async () => ({ ok: false, json: async () => ({ error: 'upstream unknown' }) }));
  await failed.run('loadManagedQuality()');
  assert.match(failed.elements['alphadesk-quality-state'].textContent, /Unknown/);
  assert.equal(failed.elements['alphadesk-quality-price'].checked, true);
});

test('quality UI preserves dirty edits during fetch and stale account responses cannot replace selected scope', async () => {
  let finishFirst;
  const pending = [];
  const state = ui((url) => new Promise(resolve => pending.push({ url, resolve })));
  const first = state.run('loadManagedQuality()');
  state.elements['alphadesk-quality-score'].value = '44'; state.run('markManagedQualityDirty()');
  finishFirst = pending[0]; finishFirst.resolve(response(result(undefined, 3))); await first;
  assert.equal(state.elements['alphadesk-quality-score'].value, '44');
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Pending edits/);
  assert.equal(state.elements['alphadesk-quality-save'].disabled, false);

  const switched = ui((url) => new Promise(resolve => pending.push({ url, resolve })));
  const oldRequest = switched.run('loadManagedQuality()');
  switched.setSandbox('sbx_956ff9e4');
  const newRequest = switched.run('loadManagedQuality()');
  pending.at(-2).resolve(response(result({ minimum_signal_score: 29, minimum_catalyst_confidence: 0.19, require_price_action_confirmation: true }, 2)));
  pending.at(-1).resolve(response(result({ minimum_signal_score: 38, minimum_catalyst_confidence: 0.23, require_price_action_confirmation: false }, 5)));
  await Promise.all([oldRequest, newRequest]);
  assert.equal(switched.elements['alphadesk-quality-score'].value, '38');
  assert.equal(switched.elements['alphadesk-quality-catalyst'].value, '0.23');
});

test('quality UI submits strict values with the authoritative revision and confirms only matching readback', async () => {
  const calls = [];
  const state = ui(async (url, options) => { calls.push({ url, options }); return response(result({ minimum_signal_score: 25, minimum_catalyst_confidence: 0.15, require_price_action_confirmation: true }, options?.method === 'PUT' ? 2 : 1)); });
  await state.run('loadManagedQuality()'); state.elements['alphadesk-quality-score'].value = '27'; state.run('markManagedQualityDirty()');
  await state.run('saveManagedQuality()');
  assert.equal(calls.length, 2); assert.equal(calls[0].options.method, undefined); assert.equal(calls[1].options.method, 'PUT');
  assert.deepEqual(JSON.parse(calls[1].options.body), { sandboxId: 'sbx_723be98b', minimumSignalScore: 27, minimumCatalystConfidence: 0.15, requirePriceActionConfirmation: true, expectedRevision: 1 });
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Unknown/);
  assert.doesNotMatch(state.elements['alphadesk-quality-state'].textContent, /Effective/);
});

test('quality UI accepts authoritative no-op readback without a revision bump', async () => {
  const calls = [];
  const state = ui(async (url, options) => { calls.push(options); return response(result(undefined, 1)); });
  await state.run('loadManagedQuality()'); state.elements['alphadesk-quality-score'].value = '26'; state.run('markManagedQualityDirty()');
  state.elements['alphadesk-quality-score'].value = '25';
  await state.run('saveManagedQuality()');
  assert.equal(JSON.parse(calls[1].body).expectedRevision, 1);
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Effective/);
});

test('quality UI accepts AD first explicit save that advances revision with equal effective values', async () => {
  const calls = [];
  const state = ui(async (url, options) => {
    calls.push({ url, options });
    return response(result(undefined, options?.method === 'PUT' ? 2 : 1));
  });
  await state.run('loadManagedQuality()');
  state.run('markManagedQualityDirty()');
  await state.run('saveManagedQuality()');
  assert.equal(calls.filter(call => call.options?.method === 'PUT').length, 1);
  assert.equal(JSON.parse(calls[1].options.body).expectedRevision, 1);
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Effective/);
});

test('quality UI refuses an empty numeric setting instead of coercing it to zero', async () => {
  const state = ui(async () => response(result(undefined, 1)));
  await state.run('loadManagedQuality()'); state.elements['alphadesk-quality-score'].value = ''; state.run('markManagedQualityDirty()');
  await state.run('saveManagedQuality()');
  assert.match(state.elements['alphadesk-quality-state'].textContent, /Failed/);
});
