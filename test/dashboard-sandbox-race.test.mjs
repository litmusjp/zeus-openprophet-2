import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
function sourceBetween(start, end) { return page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start))); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('operator heartbeat failure display separates history from active failure and switches sandboxes', () => {
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', classList: { toggle() {} } }), dom.get(id));
  const ctx = {
    config: { sandboxes: { l1: {}, l2: {} }, accounts: [], agents: [] }, sandboxSchedule: {},
    document: { getElementById: element }, getEffectiveSandboxId: () => 'l1', fmtInt: String,
    _set: (id, value) => { element(id).textContent = value; },
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function updateOperatorCard(s)', 'function noteBrokerAction('), ctx);
  ctx.updateOperatorCard({ sandboxId: 'l1', stats: { errors: 1 }, lastHeartbeatFailure: { beat: 3, time: '2026-10-05T00:00:00Z', status: 429, message: 'Endpoint unavailable', recoveredAt: null } });
  assert.match(element('operator-attention').textContent, /1 historical error.*active/);
  assert.match(element('operator-last-heartbeat-failure').textContent, /HTTP 429.*Active/);
  ctx.updateOperatorCard({ sandboxId: 'l1', stats: { errors: 1 }, lastHeartbeatFailure: { beat: 4, time: '2026-10-05T00:02:00Z', status: 'timeout', message: 'Request timed out', recoveredAt: null } });
  assert.match(element('operator-last-heartbeat-failure').textContent, /· timeout · Request timed out/);
  assert.doesNotMatch(element('operator-last-heartbeat-failure').textContent, /HTTP timeout/);
  ctx.updateOperatorCard({ sandboxId: 'l1', stats: { errors: 1 }, lastHeartbeatFailure: { beat: 3, time: '2026-10-05T00:00:00Z', status: 429, message: 'Endpoint unavailable', recoveredAt: '2026-10-05T00:01:00Z', recoveredByBeat: 4 } });
  assert.equal(element('operator-attention').textContent, '1 historical error');
  assert.match(element('operator-last-heartbeat-failure').textContent, /Recovered by heartbeat #4/);
  ctx.updateOperatorCard({ sandboxId: 'l2', stats: {} });
  assert.equal(element('operator-last-heartbeat-failure').textContent, 'Last heartbeat failure: none recorded');
  assert.equal(element('operator-attention').textContent, 'No active heartbeat failure');
  ctx.updateOperatorCard({ sandboxId: 'l2', stats: { errors: 2 } });
  assert.match(element('operator-attention').textContent, /details unavailable/i);
  assert.match(element('operator-last-heartbeat-failure').textContent, /details unavailable/i);
});

test('late dashboard and portfolio responses cannot repaint another selected sandbox', async () => {
  const dashboards = { l1: deferred(), l2: deferred() };
  const accounts = { l1: deferred(), l2: deferred() };
  const positions = { l1: deferred(), l2: deferred() };
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', innerHTML: '', className: '', style: {} }), dom.get(id));
  const ctx = {
    selectedSandboxId: 'l1', sandboxScoped: {}, config: { sandboxes: { l1: {}, l2: {} } },
    document: { getElementById: element, querySelector: () => null },
    fetch: url => {
      if (url.includes('/dashboard')) return dashboards[url.includes('l1') ? 'l1' : 'l2'].promise;
      if (url.includes('/portfolio/account')) return accounts[url.includes('l1') ? 'l1' : 'l2'].promise;
      if (url.includes('/portfolio/positions')) return positions[url.includes('l1') ? 'l1' : 'l2'].promise;
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    renderHeartbeat() {}, renderPermissions() {}, renderSlack() {}, renderAlphaDesk() {}, renderPromptPreview() {},
    updateState(s) { ctx.state = s; }, log() {}, _setData() {},
    clearPortfolioView() {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function getEffectiveSandboxId()', 'function getSelectedSandbox()') + sourceBetween('function sandboxQueryString()', 'function withAuthUrl(') + sourceBetween('async function refreshSelectedSandboxConfig()', '// ── Terminal logging') + sourceBetween('async function refreshPortfolio()', 'function clearPortfolioView('), ctx);
  const oldConfig = ctx.refreshSelectedSandboxConfig();
  const oldPortfolio = ctx.refreshPortfolio();
  ctx.selectedSandboxId = 'l2';
  const newConfig = ctx.refreshSelectedSandboxConfig();
  const newPortfolio = ctx.refreshPortfolio();
  dashboards.l2.resolve({ ok: true, json: async () => ({ agent: { id: 'l2-agent' }, state: { running: true } }) });
  accounts.l2.resolve({ ok: true, json: async () => ({ PortfolioValue: 200, Cash: 200, BuyingPower: 200 }) });
  positions.l2.resolve({ ok: true, json: async () => [] });
  await Promise.all([newConfig, newPortfolio]);
  dashboards.l1.resolve({ ok: true, json: async () => ({ agent: { id: 'l1-agent' }, state: { running: false } }) });
  accounts.l1.resolve({ ok: true, json: async () => ({ PortfolioValue: 100, Cash: 100, BuyingPower: 100 }) });
  positions.l1.resolve({ ok: true, json: async () => [] });
  await Promise.all([oldConfig, oldPortfolio]);
  assert.equal(ctx.sandboxScoped.agent.id, 'l2-agent');
  assert.equal(ctx.state.sandboxId, 'l2');
  assert.equal(element('portfolio-value').textContent, '$200.00');
});

test('late failed positions response cannot clear a newly selected portfolio', async () => {
  const oldAccount = deferred();
  const oldPositions = deferred();
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', innerHTML: '', style: {} }), dom.get(id));
  const ctx = {
    selectedSandboxId: 'l1', config: { sandboxes: { l1: {}, l2: {} } },
    document: { getElementById: element, querySelector: () => null },
    fetch: url => url.includes('l1') ? (url.includes('/positions') ? oldPositions.promise : oldAccount.promise) : Promise.resolve({
      ok: true, json: async () => url.includes('/positions') ? [] : { PortfolioValue: 200, Cash: 200, BuyingPower: 200 },
    }),
    _setData() {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function getEffectiveSandboxId()', 'function getSelectedSandbox()') + sourceBetween('function sandboxQueryString()', 'function withAuthUrl(') + sourceBetween('async function refreshPortfolio()', '// ──'), ctx);
  const oldRefresh = ctx.refreshPortfolio();
  ctx.selectedSandboxId = 'l2';
  await ctx.refreshPortfolio();
  oldAccount.resolve({ ok: false });
  oldPositions.resolve({ ok: false });
  await oldRefresh;
  assert.equal(element('portfolio-value').textContent, '$200.00');
  assert.match(element('positions-container').innerHTML, /No open positions/);
});

test('state and health null schedules clear the selected countdown', async () => {
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', style: {}, classList: { add() {}, toggle() {} } }), dom.get(id));
  const ctx = {
    selectedSandboxId: 'l1', sandboxSchedule: {}, sandboxRuntime: {}, config: { sandboxes: { l1: {} } }, window: {},
    document: { getElementById: element, querySelector: () => null },
    _set: (id, value) => { element(id).textContent = value; }, _setData() {}, fmtInt: String,
    updateInitialStateLabel() {}, updateOperatorCard() {}, updatePhase() {}, updateButtons() {}, startProgress() {},
    addTradeCard() {}, renderAccounts() {}, renderAgents() {}, renderSandboxTabs() {}, refreshSandboxButtons() {},
    getEffectiveSandboxId: () => ctx.selectedSandboxId,
    fetch: async () => ({ json: async () => ({ sandboxes: [{ sandboxId: 'l1', goReady: true, state: { running: true, paused: true, nextBeatTime: null, heartbeatSeconds: 30 } }] }) }),
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function updateState(s)', 'function updateButtons(status)') + sourceBetween('async function checkHealth()', 'async function checkAuth()'), ctx);
  ctx.updateState({ sandboxId: 'l1', running: true, nextBeatTime: '2026-10-05T13:30:00Z', heartbeatSeconds: 30 });
  ctx.updateState({ sandboxId: 'l1', running: false, nextBeatTime: null, heartbeatSeconds: 30 });
  assert.equal(ctx.sandboxSchedule.l1.nextBeatTime, null);
  assert.equal(vm.runInContext('nextBeatTime', ctx), null);
  assert.equal(element('hb-next').textContent, '--');
  ctx.updateState({ sandboxId: 'l1', running: true, nextBeatTime: '2026-10-05T13:30:00Z', heartbeatSeconds: 30 });
  await ctx.checkHealth();
  assert.equal(ctx.sandboxSchedule.l1.nextBeatTime, null);
  assert.equal(vm.runInContext('nextBeatTime', ctx), null);
  assert.equal(element('operator-next-heartbeat').textContent, '--');
});

test('uncached tab switch shows selected identity and hides mutation buttons while loading', async () => {
  const pending = deferred();
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', style: {}, className: '', classList: { add() {}, toggle() {} } }), dom.get(id));
  const ctx = {
    selectedSandboxId: 'l1', sandboxSchedule: {}, sandboxRuntime: { l1: { sandboxId: 'l1' } },
    config: { sandboxes: { l1: { name: 'Old' }, l2: { name: 'New', accountId: 'a2', agent: { activeAgentId: 'g2', model: 'opencode/new-model' } } }, accounts: [{ id: 'a2', name: 'New account', paper: false }], agents: [{ id: 'g2', name: 'New agent' }] },
    document: { getElementById: element },
    fetch: () => pending.promise, refreshSelectedSandboxConfig: () => pending.promise, refreshPortfolio: () => pending.promise,
    renderSandboxTabs() {}, renderAccounts() {}, _set: (id, value) => { element(id).textContent = value; },
    startProgress() {}, fmtInt: String, getEffectiveSandboxId: () => ctx.selectedSandboxId,
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function showSelectedSandboxRuntime()', 'function connectSSE()') + sourceBetween('function updateOperatorCard(s)', 'function noteBrokerAction(') + sourceBetween('function updateButtons(status)', 'function updatePhase(') + sourceBetween('async function switchSandboxTab(sandboxId)', 'function logToSandbox('), ctx);
  element('operator-account-name').textContent = 'Old account';
  element('btn-stop').style.display = '';
  const switching = ctx.switchSandboxTab('l2');
  assert.equal(element('operator-account-name').textContent, 'New account');
  assert.equal(element('operator-agent-name').textContent, 'New agent');
  assert.equal(element('operator-model-name').textContent, 'new-model');
  assert.equal(element('status-text').textContent, 'Checking state');
  for (const id of ['btn-start', 'btn-pause', 'btn-resume', 'btn-stop']) assert.equal(element(id).style.display, 'none');
  pending.resolve({ ok: false });
  await switching;
});

test('portfolio uses the Go fractional UnrealizedPLPC as a percentage', async () => {
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', innerHTML: '', className: '', style: {} }), dom.get(id));
  const ctx = {
    selectedSandboxId: 'l1', config: { sandboxes: { l1: {} } },
    document: { getElementById: element, querySelector: () => null },
    fetch: async url => ({ ok: true, json: async () => url.includes('/positions') ? [{ Symbol: 'IWM', UnrealizedPL: 5, UnrealizedPLPC: 0.125, Qty: 1, AvgEntryPrice: 40 }] : { PortfolioValue: 100, Cash: 100, BuyingPower: 100 } }),
    _setData() {}, clearPortfolioView() {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function getEffectiveSandboxId()', 'function getSelectedSandbox()') + sourceBetween('function sandboxQueryString()', 'function withAuthUrl(') + sourceBetween('async function refreshPortfolio()', 'function clearPortfolioView('), ctx);
  await ctx.refreshPortfolio();
  assert.match(element('positions-container').innerHTML, /12\.5%/);
});

test('SSE schedules stay sandbox scoped and reconnect refreshes stale state', () => {
  const dom = new Map();
  const element = id => dom.get(id) || (dom.set(id, { textContent: '', style: {} }), dom.get(id));
  let stream, refreshes = 0;
  class EventSource {
    constructor() { stream = this; this.handlers = new Map(); }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    close() {}
    emit(name, data) { this.handlers.get(name)({ data: JSON.stringify(data) }); }
  }
  const ctx = {
    selectedSandboxId: 'l1', sandboxSchedule: {}, sandboxRuntime: {},
    document: { getElementById: element, querySelector: () => null },
    EventSource, withAuthUrl: x => x, getEffectiveSandboxId: () => ctx.selectedSandboxId,
    _set: (id, value) => { element(id).textContent = value; }, _setData() {}, fmtInt: String, updatePhase() {}, startProgress() {},
    checkHealth: () => { refreshes++; }, refreshSelectedSandboxConfig: () => { refreshes++; }, refreshPortfolio: () => { refreshes++; },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('let _eventSource = null;', 'function _set(id, val)'), ctx);
  ctx.connectSSE();
  stream.emit('schedule', { sandboxId: 'l1', nextBeat: '2026-10-05T13:30:00Z', seconds: 30 });
  ctx.selectedSandboxId = 'l2';
  stream.emit('schedule', { sandboxId: 'l2', nextBeat: '2026-10-05T13:31:00Z', seconds: 60 });
  stream.emit('schedule', { sandboxId: 'l1', nextBeat: '2026-10-05T13:32:00Z', seconds: 30 });
  assert.equal(vm.runInContext('nextBeatTime.toISOString()', ctx), '2026-10-05T13:31:00.000Z');
  stream.onerror();
  assert.equal(element('operator-next-heartbeat').textContent, '--');
  stream.onopen();
  assert.equal(refreshes, 3);
});

test('trade chart limits date ticks and formats a single positive sign', () => {
  const svg = { children: [], appendChild(node) { this.children.push(node); this.firstChild = this.children[0]; }, removeChild(node) { this.children.shift(); this.firstChild = this.children[0]; } };
  const make = tag => ({ tag, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, addEventListener() {}, textContent: '' });
  const trades = Array.from({ length: 30 }, (_, i) => ({ timestamp: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), pnl: 2, accountId: 'l1', symbol: 'IWM' }));
  const ctx = {
    document: { getElementById: id => id === 'trade-chart' ? svg : id === 'trade-chart-empty' ? { hidden: true } : { value: 'timeseries' }, createElementNS: (_, tag) => make(tag) },
    filteredVerifiedTrades: () => trades, selectedTradeAccounts: () => new Set(['l1']), fmtPnl: v => (v >= 0 ? '+' : '') + '$' + Number(v).toFixed(2), hideTradeTooltip() {}, showTradeTooltip() {},
  };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function renderTradeChart()', 'function showTradeTooltip('), ctx);
  ctx.renderTradeChart();
  const labels = svg.children.filter(n => n.tag === 'text').map(n => n.textContent);
  assert.equal(labels[0], '+$2.00');
  assert.ok(labels.length <= 14, `too many overlapping labels: ${labels.length}`);
  assert.ok(labels.some(x => /Oct\s+\d+/.test(x)));
});

test('initial terminal state follows its own sandbox runtime', () => {
  const l1 = { textContent: '' }, l2 = { textContent: '' };
  const ctx = { sandboxTerminals: { l1: { termEl: { querySelector: () => l1 } }, l2: { termEl: { querySelector: () => l2 } } }, sandboxLabelById: sid => sid.toUpperCase() };
  vm.createContext(ctx);
  vm.runInContext(sourceBetween('function updateInitialStateLabel(', 'function updateOperatorCard('), ctx);
  ctx.updateInitialStateLabel('l1', { running: true });
  ctx.updateInitialStateLabel('l2', { running: false });
  assert.equal(l1.textContent, 'L1 running.');
  assert.equal(l2.textContent, 'L2 stopped.');
});
