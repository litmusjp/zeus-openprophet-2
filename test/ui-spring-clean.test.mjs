import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
function sourceBetween(start, end) { return page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start))); }

test('static About and mobile Portfolio surfaces are removed while the terminal drawer remains', () => {
  for (const fragment of ['data-tab="about"', 'id="panel-about"', 'data-tab="portfolio"', 'id="panel-portfolio"', 'id="m-portfolio"', 'id="m-cash"', 'id="m-bp"', 'id="m-pnl"', 'id="m-positions"', 'portfolio-value', 'cash-value', 'bp-value', 'day-pnl', 'positions-container']) assert.equal(page.includes(fragment), false, `unexpected static UI fragment: ${fragment}`);
  for (const image of ['img/jake.jpg', 'img/anyrentcloud.png']) assert.equal(page.includes(image), false, `unexpected About image reference: ${image}`);
  for (const image of ['jake.jpg', 'anyrentcloud.png']) assert.equal(fs.existsSync(new URL('../agent/public/img/' + image, import.meta.url)), false, `approved About image still exists: ${image}`);
  assert.match(page, /class="sidebar-toggle" onclick="toggleMobileSidebar\('/);
  assert.match(page, /function toggleMobileSidebar\(sandboxId\)/);
  assert.match(page, /data-overlay="\$\{sandboxId\}"/);
  assert.match(page, /class="sidebar"/);
});

test('Plugins keeps active integrations and account-quality controls without placeholder cards', () => {
  assert.doesNotMatch(page, /More Plugins Coming|Coming Soon|Discord webhook notifications|Telegram bot notifications/);
  assert.match(page, /Slack Notifications/);
  assert.match(page, /AlphaDesk Options Assessment/);
  assert.match(page, /alphadesk-quality-score/);
});

test('Terminal mobile sidebar toggle opens and closes the account sidebar overlay', () => {
  const sidebar = { open: false, classList: { contains(name) { return name === 'mobile-open' && sidebar.open; }, toggle(name) { if (name === 'mobile-open') sidebar.open = !sidebar.open; } } };
  const overlay = { style: { display: 'none' } };
  const wrapper = { querySelector(selector) { return selector === '.sidebar' ? sidebar : selector === '[data-overlay]' ? overlay : null; } };
  const ctx = { document: { getElementById: id => id === 'term-wrap-sbx' ? wrapper : null } };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function toggleMobileSidebar(sandboxId)', 'function formatSandboxPrefix('), ctx);
  ctx.toggleMobileSidebar('sbx');
  assert.equal(sidebar.open, true);
  assert.equal(overlay.style.display, 'block');
  ctx.toggleMobileSidebar('sbx');
  assert.equal(sidebar.open, false);
  assert.equal(overlay.style.display, 'none');
});

test('Settings permission saves omit legacy live capability and preserve stored values', async () => {
  const elements = new Map();
  for (const [id, value] of Object.entries({
    'perm-paper': { checked: true }, 'perm-live': { checked: true }, 'perm-options': { checked: true }, 'perm-stocks': { checked: true },
    'perm-0dte': { checked: false }, 'perm-confirm': { checked: false }, 'perm-maxpos': { value: '15' },
    'perm-maxdeploy': { value: '80' }, 'perm-maxloss': { value: '5' }, 'perm-maxopen': { value: '10' },
    'perm-maxorder': { value: '0' }, 'perm-maxtools': { value: '25' }, 'perm-blocked': { value: '' },
  })) elements.set(id, value);
  const calls = [];
  let timer;
  const ctx = {
    document: { getElementById: id => elements.get(id) },
    setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {}, getEffectiveSandboxId: () => 'sbx',
    fetch: async (_url, options) => { calls.push(JSON.parse(options.body)); return { ok: true }; }, refreshSelectedSandboxConfig: async () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('let _permTimer = null;', 'function clearChatGPTFlowCode'), ctx);
  for (const stored of [true, false]) {
    calls.length = 0;
    ctx.savePermissions();
    await timer();
    assert.equal(Object.hasOwn(calls[0], 'allowLiveTrading'), false);
    const merged = { allowLiveTrading: stored, ...calls[0] };
    assert.equal(merged.allowLiveTrading, stored);
    assert.equal(calls[0].sandboxId, 'sbx');
  }
});

test('Settings permission save binds the edited payload to its account before debounce and reports failures', async () => {
  const elements = new Map(Object.entries({
    'perm-paper': { checked: true }, 'perm-options': { checked: true }, 'perm-stocks': { checked: true },
    'perm-0dte': { checked: false }, 'perm-confirm': { checked: false }, 'perm-maxpos': { value: '15' },
    'perm-maxdeploy': { value: '80' }, 'perm-maxloss': { value: '5' }, 'perm-maxopen': { value: '10' },
    'perm-maxorder': { value: '0' }, 'perm-maxtools': { value: '25' }, 'perm-blocked': { value: '' },
  }));
  let selected = 'account-a'; let timer; const writes = []; let refreshes = 0; const toasts = [];
  const ctx = {
    document: { getElementById: id => elements.get(id) },
    setTimeout(fn) { timer = fn; return 1; }, clearTimeout() {}, getEffectiveSandboxId: () => selected,
    fetch: async (_url, options) => { writes.push(JSON.parse(options.body)); return { ok: true }; },
    refreshSelectedSandboxConfig: async () => { refreshes++; }, showToast: (...args) => toasts.push(args),
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('let _permTimer = null;', 'function clearChatGPTFlowCode'), ctx);
  ctx.savePermissions(); selected = 'account-b'; await timer();
  assert.equal(writes[0].sandboxId, 'account-a');
  assert.equal(refreshes, 0, 'a stale save must not refresh whichever account is now selected');

  let rejectPending;
  ctx.fetch = () => new Promise((_resolve, reject) => { rejectPending = reject; });
  selected = 'account-a';
  ctx.savePermissions(); const pendingSave = timer();
  selected = 'account-b'; rejectPending(new Error('account A network down'));
  await pendingSave;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(refreshes, 0);
  assert.equal(toasts.length, 0, 'a stale rejection must not toast over the newly selected account');

  ctx.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: 'HTTP 500' }) });
  ctx.savePermissions(); const httpSave = timer();
  await httpSave;
  assert.match(toasts.at(-1)[0], /HTTP 500/i, 'an active-account HTTP failure remains visible');
  assert.notEqual(toasts.at(-1)[1], 'success');

  ctx.fetch = async () => { throw new Error('network down'); };
  ctx.savePermissions(); const networkSave = timer();
  await networkSave;
  assert.match(toasts.at(-1)[0], /network down/i);
  assert.notEqual(toasts.at(-1)[1], 'success');
  assert.equal(refreshes, 0);
});

test('Agent Builder permission save omits legacy live capability', async () => {
  const elements = new Map();
  const put = (id, value = '', checked = false) => elements.set(id, { value, checked, textContent: '', disabled: false, style: {} });
  for (const id of ['builder-next', 'f-ag-name', 'f-ag-desc', 'f-ag-strat', 'f-ag-model', 'f-ag-ptype', 'f-ag-prompt', 'b-perm-blocked']) put(id, id === 'f-ag-name' ? 'Agent' : '');
  for (const id of ['b-perm-paper','b-perm-live','b-perm-options','b-perm-stocks','b-perm-0dte','b-perm-confirm']) put(id, '', id === 'b-perm-paper' || id === 'b-perm-live' || id === 'b-perm-options' || id === 'b-perm-stocks');
  for (const [id, value] of Object.entries({ 'b-perm-maxpos':'15', 'b-perm-maxdeploy':'80', 'b-perm-maxloss':'5', 'b-perm-maxopen':'10', 'b-perm-maxorder':'0', 'b-perm-maxtools':'25' })) put(id, value);
  put('review-activate');
  const calls = [];
  const ctx = {
    _builder: { isEdit: true, agentId: 'agent', sandboxId: 'sbx', permsDirty: true },
    document: { getElementById: id => elements.get(id) || null },
    fetch: async (url, options = {}) => { calls.push({ url, options }); return { ok: true, json: async () => url === '/api/config' ? {} : { agent: { id: 'agent' } } }; },
    closeModal() {},
    _builderValidateStep1: () => true, _builderGoStep() {}, _builderClearError() {}, _builderShowError: assert.fail,
    refreshSelectedSandboxConfig: async () => {}, renderAll() {}, showToast() {}, config: {},
  };
  vm.createContext(ctx);
  vm.runInContext('function v(id) { const e=document.getElementById(id); return e ? (e.type===\'checkbox\'?e.checked:e.value) : \'\'; }' + sourceBetween('async function _builderSubmit()', 'function editStrategy('), ctx);
  await ctx._builderSubmit();
  const permissionCall = calls.find(call => call.url === '/api/permissions');
  assert.ok(permissionCall);
  const body = JSON.parse(permissionCall.options.body);
  assert.equal(Object.hasOwn(body, 'allowLiveTrading'), false);
  for (const stored of [true, false]) assert.equal(({ allowLiveTrading: stored, ...body }).allowLiveTrading, stored);
});

test('Agent Builder rejection of permissions blocks activation and retry reuses the created agent', async () => {
  const elements = new Map();
  const put = (id, value = '', checked = false) => elements.set(id, { value, checked, textContent: '', disabled: false, style: {} });
  for (const id of ['builder-next', 'f-ag-name', 'f-ag-desc', 'f-ag-strat', 'f-ag-model', 'f-ag-ptype', 'f-ag-prompt', 'b-perm-blocked']) put(id, id === 'f-ag-name' ? 'Agent' : '');
  for (const id of ['b-perm-paper','b-perm-live','b-perm-options','b-perm-stocks','b-perm-0dte','b-perm-confirm']) put(id, '', id !== 'b-perm-0dte' && id !== 'b-perm-confirm');
  for (const [id, value] of Object.entries({ 'b-perm-maxpos':'15', 'b-perm-maxdeploy':'80', 'b-perm-maxloss':'5', 'b-perm-maxopen':'10', 'b-perm-maxorder':'0', 'b-perm-maxtools':'25' })) put(id, value);
  put('review-activate', '', true);
  const calls = []; const errors = []; let activations = 0; let closes = 0; let refreshes = 0;
  const ctx = {
    _builder: { isEdit: false, agentId: null, sandboxId: 'account-a', permsDirty: true, accountLabel: 'Account A' },
    document: { getElementById: id => elements.get(id) || null },
    fetch: async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/agents' && options.method === 'POST') return { ok: true, json: async () => ({ agent: { id: 'created-agent' } }) };
      if (url === '/api/permissions' && calls.filter(call => call.url === url).length === 1) return { ok: false, json: async () => { throw new SyntaxError('not json'); } };
      if (url.endsWith('/agent')) {
        activations++;
        if (activations === 1) return { ok: false, json: async () => ({ error: 'Activation rejected' }) };
      }
      if (url === '/api/config') return { ok: true, json: async () => ({}) };
      return { ok: true, json: async () => ({}) };
    },
    closeModal() { closes++; },
    _builderValidateStep1: () => true, _builderGoStep() {}, _builderClearError() {}, _builderShowError: message => errors.push(message),
    refreshSelectedSandboxConfig: async () => { refreshes++; }, renderAll() {}, showToast() {}, config: {},
  };
  vm.createContext(ctx);
  vm.runInContext('function v(id) { const e=document.getElementById(id); return e ? (e.type===\'checkbox\'?e.checked:e.value) : \'\'; }' + sourceBetween('async function _builderSubmit()', 'function editStrategy('), ctx);
  await ctx._builderSubmit();
  assert.equal(calls.some(call => call.url.includes('/agent') && call.url !== '/api/agents'), false);
  assert.equal(ctx._builder.agentId, 'created-agent');
  assert.match(errors.at(-1), /permission/i);
  assert.equal(closes, 0);
  assert.equal(refreshes, 0);

  ctx.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/agent')) return { ok: false, json: async () => ({ error: 'Activation rejected' }) };
    return { ok: true, json: async () => ({}) };
  };
  await ctx._builderSubmit();
  assert.match(errors.at(-1), /activation rejected/i);
  assert.equal(closes, 0);
  assert.equal(refreshes, 0);

  ctx.fetch = async (url, options = {}) => { calls.push({ url, options }); return { ok: true, json: async () => ({}) }; };
  await ctx._builderSubmit();
  assert.equal(closes, 1);
  assert.equal(calls.filter(call => call.url === '/api/agents' && call.options.method === 'POST').length, 1);
  assert.ok(calls.some(call => call.url === '/api/agents/created-agent' && call.options.method === 'PUT'));
  assert.equal(calls.filter(call => call.url.endsWith('/agent')).length, 2);
});

test('portfolio refresh writes the selected account values and positions into its own sidebar fields', async () => {
  const elements = new Map();
  const stat = key => { if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '', className: '' }); return elements.get(key); };
  const encodeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const ctx = {
    selectedSandboxId: 'paper-a', config: { sandboxes: { 'paper-a': {}, 'paper-b': {} } },
    getEffectiveSandboxId: () => ctx.selectedSandboxId,
    document: { getElementById: id => stat('legacy:' + id), querySelector: selector => stat(selector.match(/data-stat="([^"]+)"/)?.[1] || ''),
      createElement: () => { let text = ''; return { set textContent(value) { text = encodeHTML(value); }, get innerHTML() { return text; } }; } },
    fetch: async url => ({ ok: true, json: async () => url.includes('/positions') ? [{ Symbol: 'IWM', UnrealizedPL: 5, UnrealizedPLPC: 0.125, Qty: 1, AvgEntryPrice: 40 }] : { PortfolioValue: 123, Cash: 100, BuyingPower: 200, DailyPnLValid: true, Equity: 123, LastEquity: 120 } }),
    _setData: (key, value) => { stat(key).textContent = value; },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function esc(s)', 'function fmtTime()') + sourceBetween('function getEffectiveSandboxId()', 'function getSelectedSandbox()') + sourceBetween('function sandboxQueryString()', 'function withAuthUrl(') + sourceBetween('async function refreshPortfolio()', 'let verifiedTrades = [];'), ctx);
  await ctx.refreshPortfolio();
  assert.equal(stat('paper-a-portfolio').textContent, '$123.00');
  assert.equal(stat('paper-a-pnl').textContent, '+$3.00');
  assert.match(stat('paper-a-positions').innerHTML, /12\.5%/);
  assert.equal(stat('paper-b-portfolio').textContent, '');
});
