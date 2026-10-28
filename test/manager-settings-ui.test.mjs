import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const part = page.slice(page.indexOf('let _managerSettings ='), page.indexOf('async function newManagerSession'));

test('Agents tab contains the single shared Manager editor above Agents & Strategies; terminal keeps chat controls only', () => {
  for (const match of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
  const agents = page.slice(page.indexOf('id="panel-agents"'), page.indexOf('id="panel-accounts"'));
  assert.ok(agents.indexOf('id="manager-settings-card"') < agents.indexOf('Agents &amp; Strategies'));
  assert.equal((page.match(/id="mgr-provider"/g) || []).length, 1);
  assert.equal((page.match(/id="mgr-model"/g) || []).length, 1);
  const terminal = page.slice(page.indexOf('function ensureManagerTerminal()'), page.indexOf('function updateManagerModelDropdown()'));
  for (const id of ['newManagerSession()', 'stopManager()', 'sendManagerMessage()']) assert.ok(terminal.includes(id));
  assert.doesNotMatch(terminal, /mgr-provider|mgr-model|mgr-custom-prompt/);
  assert.match(page, /function openManagerSettings\(\)[\s\S]*switchTab\('agents'\)/);
  assert.match(page, /fetch\('\/api\/models'\)/);
  assert.match(page, /instruction changes apply to a new conversation/i);
});

function setup({ fetchImpl, values = {} }) {
  const elements = new Map();
  for (const id of ['mgr-settings-status', 'mgr-model-note']) elements.set(id, { textContent: '' });
  const select = () => { let value = '', html = ''; const el = { options: [], get value() { return this.options.some(o => o.value === value) ? value : (this.options[0]?.value || ''); }, set value(v) { value = v; }, get innerHTML() { return html; }, set innerHTML(v) { html = v; this.options = [...v.matchAll(/<option value="([^"]*)"/g)].map(m => ({ value: m[1] })); value = this.options[0]?.value || ''; }, insertAdjacentHTML(_where, v) { html += v; const m = v.match(/<option value="([^"]*)"/); if (m) this.options.push({ value: m[1] }); } }; return el; };
  const provider = select(), model = select();
  const prompt = { value: '' };
  elements.set('mgr-provider', provider); elements.set('mgr-model', model); elements.set('mgr-custom-prompt', prompt);
  const ctx = { document: { getElementById: id => elements.get(id) || null }, fetch: fetchImpl, console, esc: value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;') };
  vm.createContext(ctx); vm.runInContext(part, ctx);
  return { ctx, elements, provider, model, prompt };
}
const ok = body => ({ ok: true, json: async () => body });

test('live catalogue is independent from empty config snapshot and unavailable saved model is preserved', async () => {
  let calls = 0;
  const ui = setup({ fetchImpl: async url => { calls++; return url === '/api/manager/config' ? ok({ model: 'anthropic/model-x', customPrompt: '<keep & safe>' }) : ok({ models: [{ id: 'anthropic/sonnet', name: '<Sonnet>' }, { id: 'google/gemini', name: 'Gemini' }] }); } });
  await ui.ctx.loadManagerSettings();
  assert.equal(calls, 2);
  assert.equal(ui.provider.value, 'anthropic');
  assert.equal(ui.model.value, 'anthropic/model-x');
  assert.match(ui.model.innerHTML, /anthropic\/model-x/);
  assert.match(ui.elements.get('mgr-model-note').textContent, /not in the current connected catalogue/);
  assert.equal(ui.prompt.value, '<keep & safe>');
  assert.match(ui.model.innerHTML, /&lt;Sonnet&gt;/);
});

test('provider option labels match Agents while provider IDs and saved models remain unchanged', async () => {
  const ui = setup({ fetchImpl: async url => url === '/api/manager/config' ? ok({ model: 'openai/gpt-example', customPrompt: '' }) : ok({ models: [{ id: 'openai/gpt-example', name: 'GPT Example' }, { id: 'anthropic/sonnet', name: 'Sonnet' }] }) });
  await ui.ctx.loadManagerSettings();
  assert.equal(ui.provider.value, 'openai');
  assert.match(ui.provider.innerHTML, /value="openai">ChatGPT \(subscription\)/);
  assert.equal(ui.model.value, 'openai/gpt-example');
  ui.provider.value = 'anthropic'; ui.ctx.updateManagerModelDropdown();
  assert.equal(ui.model.value, '');
  assert.match(ui.model.innerHTML, /<option value="">Choose a model<\/option>/);
  assert.equal(vm.runInContext('_managerSettings.model', ui.ctx), 'openai/gpt-example');
  assert.equal(vm.runInContext('_managerSettings.dirtyModel', ui.ctx), true);
});

test('provider edits do not write; refresh cannot overwrite a draft; successful save sends only changed fields and reloads', async () => {
  const calls = [];
  const ui = setup({ fetchImpl: async (url, init = {}) => { calls.push({ url, init }); return init.method === 'PUT' ? ok({}) : url === '/api/manager/config' ? ok({ model: 'anthropic/a', customPrompt: 'original' }) : ok({ models: [{ id: 'anthropic/a', name: 'A' }, { id: 'google/b', name: 'B' }] }); } });
  await ui.ctx.loadManagerSettings();
  ui.provider.value = 'google'; ui.model.options = []; ui.ctx.updateManagerModelDropdown();
  assert.equal(calls.filter(row => row.init.method === 'PUT').length, 0);
  ui.prompt.value = 'draft'; ui.ctx.markManagerDraft();
  await ui.ctx.loadManagerSettings();
  assert.equal(ui.prompt.value, 'draft');
  ui.model.value = 'google/b';
  await ui.ctx.saveManagerSettings();
  const payload = JSON.parse(calls.find(row => row.init.method === 'PUT').init.body);
  assert.deepEqual(payload, { model: 'google/b', customPrompt: 'draft' });
  assert.equal(ui.elements.get('mgr-settings-status').textContent, 'Saved');
});

test('an accepted explicit save is read back from Manager config on reload', async () => {
  const store = { model: 'anthropic/a', customPrompt: 'before' };
  const ui = setup({ fetchImpl: async (url, init = {}) => {
    if (init.method === 'PUT') { Object.assign(store, JSON.parse(init.body)); return ok({}); }
    if (url === '/api/manager/config') return ok({ ...store });
    return ok({ models: [{ id: 'anthropic/a', name: 'A' }] });
  } });
  await ui.ctx.loadManagerSettings(); ui.prompt.value = 'saved value'; ui.ctx.markManagerDraft('prompt');
  await ui.ctx.saveManagerSettings();
  ui.prompt.value = 'stale DOM'; vm.runInContext('_managerSettings.loaded = false', ui.ctx);
  await ui.ctx.loadManagerSettings();
  assert.equal(ui.prompt.value, 'saved value');
  assert.equal(ui.elements.get('mgr-settings-status').textContent, 'Saved settings loaded');
});

test('HTTP rejection, active-turn conflict, and network errors report failure and retain drafts', async () => {
  for (const response of [
    { ok: false, status: 400, json: async () => ({ error: 'unverified model' }) },
    { ok: false, status: 409, json: async () => ({ error: 'Manager is busy' }) },
  ]) {
    const ui = setup({ fetchImpl: async (url, init = {}) => init.method === 'PUT' ? response : url === '/api/manager/config' ? ok({ model: 'a/x', customPrompt: 'saved' }) : ok({ models: [{ id: 'a/x', name: 'X' }, { id: 'a/y', name: 'Y' }] }) });
    await ui.ctx.loadManagerSettings(); ui.prompt.value = 'draft retained'; ui.ctx.markManagerDraft(); ui.model.value = 'a/y';
    await ui.ctx.saveManagerSettings();
    assert.equal(ui.prompt.value, 'draft retained');
    assert.match(ui.elements.get('mgr-settings-status').textContent, /unverified model|Manager is busy/);
  }
  const ui = setup({ fetchImpl: async (url, init = {}) => { if (init.method === 'PUT') throw Error('offline'); return url === '/api/manager/config' ? ok({ model: 'a/x', customPrompt: 'saved' }) : ok({ models: [{ id: 'a/x', name: 'X' }, { id: 'a/y', name: 'Y' }] }); } });
  await ui.ctx.loadManagerSettings(); ui.prompt.value = 'network draft'; ui.ctx.markManagerDraft();
  await ui.ctx.saveManagerSettings();
  assert.equal(ui.prompt.value, 'network draft');
  assert.match(ui.elements.get('mgr-settings-status').textContent, /offline/);
});

test('settings load failures stay visible and a delayed load does not replace a draft', async () => {
  let finish;
  const ui = setup({ fetchImpl: url => url === '/api/manager/config' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(ok({ models: [] })) });
  const loading = ui.ctx.loadManagerSettings();
  ui.prompt.value = 'typed while loading'; ui.ctx.markManagerDraft();
  finish(ok({ model: 'a/b', customPrompt: 'old' })); await loading;
  assert.equal(ui.prompt.value, 'typed while loading');
  const failed = setup({ fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }) });
  await failed.ctx.loadManagerSettings();
  assert.match(failed.elements.get('mgr-settings-status').textContent, /503/);
});

test('prompt-only Save never changes the model implicitly, including when the catalogue is empty', async () => {
  const writes = [];
  const ui = setup({ fetchImpl: async (url, init = {}) => {
    if (init.method === 'PUT') { writes.push(JSON.parse(init.body)); return ok({}); }
    if (url === '/api/manager/config') return ok({ model: 'offline/model', customPrompt: 'saved' });
    return { ok: false, status: 503, json: async () => ({}) };
  } });
  await ui.ctx.loadManagerSettings();
  assert.equal(ui.model.value, 'offline/model');
  assert.match(ui.elements.get('mgr-settings-status').textContent, /catalogue unavailable/);
  ui.prompt.value = 'prompt only'; ui.ctx.markManagerDraft('prompt');
  await ui.ctx.saveManagerSettings();
  assert.deepEqual(writes, [{ customPrompt: 'prompt only' }]);
});

test('unconfigured Manager model uses explicit placeholders and dirty unavailable models are rejected', async () => {
  let puts = 0;
  const ui = setup({ fetchImpl: async (url, init = {}) => {
    if (init.method === 'PUT') { puts++; return ok({}); }
    return url === '/api/manager/config' ? ok({ model: '', customPrompt: '' }) : ok({ models: [{ id: 'a/x', name: 'X' }] });
  } });
  await ui.ctx.loadManagerSettings();
  assert.match(ui.provider.innerHTML, /Choose a provider/);
  assert.match(ui.model.innerHTML, /No saved model — choose a model/);
  ui.model.options.push({ value: 'a/removed' }); ui.model.value = 'a/removed'; ui.ctx.markManagerDraft('model');
  await ui.ctx.saveManagerSettings();
  assert.equal(puts, 0);
  assert.match(ui.elements.get('mgr-settings-status').textContent, /current connected catalogue/);
});

test('Save before initial load and duplicate saves are blocked; edits during an accepted save stay dirty', async () => {
  let finishPut;
  const writes = [];
  const makeUi = () => setup({ fetchImpl: async (url, init = {}) => {
    if (init.method === 'PUT') { writes.push(JSON.parse(init.body)); return new Promise(resolve => { finishPut = resolve; }); }
    return url === '/api/manager/config' ? ok({ model: 'a/x', customPrompt: 'saved' }) : ok({ models: [{ id: 'a/x', name: 'X' }] });
  } });
  const early = makeUi();
  early.prompt.value = 'too early'; early.ctx.markManagerDraft('prompt');
  await early.ctx.saveManagerSettings();
  assert.equal(writes.length, 0);
  assert.match(early.elements.get('mgr-settings-status').textContent, /Load saved settings/);
  const ui = makeUi();
  await ui.ctx.loadManagerSettings();
  ui.prompt.value = 'submitted'; ui.ctx.markManagerDraft('prompt');
  const pending = ui.ctx.saveManagerSettings();
  await Promise.resolve();
  ui.prompt.value = 'newer draft'; ui.ctx.markManagerDraft('prompt');
  await ui.ctx.saveManagerSettings();
  assert.equal(writes.length, 1);
  finishPut(ok({})); await pending;
  assert.equal(ui.prompt.value, 'newer draft');
  assert.match(ui.elements.get('mgr-settings-status').textContent, /newer changes remain unsaved/);
  assert.equal(vm.runInContext('_managerSettings.dirty', ui.ctx), true);
});

test('draft arriving while catalogue JSON is pending prevents the stale load from claiming success', async () => {
  let finishCatalogue;
  const ui = setup({ fetchImpl: url => url === '/api/manager/config'
    ? Promise.resolve(ok({ model: 'a/x', customPrompt: 'old' }))
    : Promise.resolve({ ok: true, json: () => new Promise(resolve => { finishCatalogue = resolve; }) }) });
  const loading = ui.ctx.loadManagerSettings();
  await new Promise(resolve => setImmediate(resolve));
  ui.prompt.value = 'typed during catalogue'; ui.ctx.markManagerDraft('prompt');
  finishCatalogue({ models: [{ id: 'a/x', name: 'X' }] });
  await loading;
  assert.equal(ui.prompt.value, 'typed during catalogue');
  assert.equal(ui.elements.get('mgr-settings-status').textContent, 'Unsaved changes');
  assert.equal(vm.runInContext('_managerSettings.loaded', ui.ctx), false);
});
