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

test('portfolio refresh writes the selected account values and positions into its own sidebar fields', async () => {
  const elements = new Map();
  const stat = key => { if (!elements.has(key)) elements.set(key, { textContent: '', innerHTML: '', className: '' }); return elements.get(key); };
  const ctx = {
    selectedSandboxId: 'paper-a', config: { sandboxes: { 'paper-a': {}, 'paper-b': {} } },
    getEffectiveSandboxId: () => ctx.selectedSandboxId,
    document: { getElementById: id => stat('legacy:' + id), querySelector: selector => stat(selector.match(/data-stat="([^"]+)"/)?.[1] || '') },
    fetch: async url => ({ ok: true, json: async () => url.includes('/positions') ? [{ Symbol: 'IWM', UnrealizedPL: 5, UnrealizedPLPC: 0.125, Qty: 1, AvgEntryPrice: 40 }] : { PortfolioValue: 123, Cash: 100, BuyingPower: 200, DailyPnLValid: true, Equity: 123, LastEquity: 120 } }),
    _setData: (key, value) => { stat(key).textContent = value; },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function getEffectiveSandboxId()', 'function getSelectedSandbox()') + sourceBetween('function sandboxQueryString()', 'function withAuthUrl(') + sourceBetween('async function refreshPortfolio()', 'let verifiedTrades = [];'), ctx);
  await ctx.refreshPortfolio();
  assert.equal(stat('paper-a-portfolio').textContent, '$123.00');
  assert.equal(stat('paper-a-pnl').textContent, '+$3.00');
  assert.match(stat('paper-a-positions').innerHTML, /12\.5%/);
  assert.equal(stat('paper-b-portfolio').textContent, '');
});
