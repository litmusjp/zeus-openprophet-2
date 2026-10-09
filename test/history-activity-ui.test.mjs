import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const start = page.indexOf('function historySelectedLabels()');
const end = page.indexOf('function filteredVerifiedTrades()', start);
const source = page.slice(page.indexOf('function renderHistoryRecord(msg)'), start) + page.slice(start, end);

function createUI({ storageThrows = false, fetchImpl } = {}) {
  const elements = new Map();
  const element = id => {
    if (elements.has(id)) return elements.get(id);
    const listeners = {};
    const el = { id, value: '', style: {}, dataset: {}, checked: false, textContent: '', listeners,
      addEventListener(type, fn) { listeners[type] = fn; },
      dispatch(type) { return listeners[type]?.({ target: this }); },
      querySelector(selector) {
        if (selector === '#history-clear-labels') return this.clearButton || null;
        if (selector === '#history-record-more' && this.innerHTML.includes('history-record-more')) {
          return element('history-record-more');
        }
        return null;
      },
      querySelectorAll(selector) { return selector === 'input' ? (this.inputs || []) : []; },
      set innerHTML(value) {
        this._html = value;
        if (value.includes('history-clear-labels')) this.clearButton = { listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, dispatch(type) { return this.listeners[type]?.({ target: this }); } };
        this.inputs = [...value.matchAll(/<input type="checkbox" data-history-label="([^"]+)" (checked)?/g)].map(match => {
          const input = { checked: Boolean(match[2]), dataset: { historyLabel: match[1] }, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, dispatch(type) { return this.listeners[type]?.({ target: this }); } };
          return input;
        });
      },
      get innerHTML() { return this._html || ''; },
    };
    elements.set(id, el); return el;
  };
  const store = new Map();
  const ctx = {
    historyState: { activities: [], activityOffset: 0, activityTotal: 0, activityAccount: 'acct-a', accounts: [{ id: 'acct-a' }, { id: 'acct-b' }], activityCursors: {}, listRequest: 0, detailRequest: 0 },
    document: { getElementById: element },
    localStorage: { getItem(key) { if (storageThrows) throw new Error('denied'); return store.get(key) || null; }, setItem(key, value) { if (storageThrows) throw new Error('denied'); store.set(key, value); } },
    URLSearchParams, esc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c])),
    fetch: fetchImpl || (async url => ({ ok: true, async json() { return { activities: [], total: 0 }; } })),
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, element, store };
}

test('checkbox defaults, combined ANY, All, Clear, and storage failure retain in-memory choices', async () => {
  let requests = 0;
  const { ctx, element } = createUI({ fetchImpl: async () => { requests++; return { ok: true, async json() { return { activities: [], total: 0 }; } }; } });
  assert.deepEqual(Array.from(ctx.historySelectedLabels()), ['User', 'Trade', 'Error']);
  ctx.renderHistoryLabelControls();
  const heartbeat = element('history-label-controls').inputs.find(input => input.dataset.historyLabel === 'Heartbeat');
  heartbeat.checked = true; heartbeat.dispatch('change');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(ctx.historySelectedLabels()).sort(), ['Error', 'Heartbeat', 'Trade', 'User']);
  assert.deepEqual(JSON.parse(ctx.localStorage.getItem('op2-history-labels')).sort(), ['Error', 'Heartbeat', 'Trade', 'User']);
  const all = element('history-label-controls').inputs.find(input => input.dataset.historyLabel === 'All');
  all.checked = true; all.dispatch('change'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(Array.from(ctx.historySelectedLabels()).sort(), ['Error', 'Heartbeat', 'Trade', 'User']);
  element('history-label-controls').querySelector('#history-clear-labels').dispatch('click');
  assert.deepEqual(Array.from(ctx.historySelectedLabels()), []);
  assert.match(element('history-activities').innerHTML, /No activity matches your filters/);
  assert.equal(requests, 2, 'Clear must not fetch activity');

  const allContext = createUI();
  allContext.ctx.renderHistoryLabelControls();
  const allInitially = allContext.element('history-label-controls').inputs.find(input => input.dataset.historyLabel === 'All');
  allInitially.checked = true; allInitially.dispatch('change');
  assert.deepEqual(Array.from(allContext.ctx.historySelectedLabels()).sort(), ['Error', 'Heartbeat', 'Trade', 'User']);

  const fallback = createUI({ storageThrows: true });
  fallback.ctx.renderHistoryLabelControls();
  const selected = fallback.element('history-label-controls').inputs.find(input => input.dataset.historyLabel === 'Heartbeat');
  selected.checked = true; selected.dispatch('change'); await new Promise(resolve => setImmediate(resolve));
  assert.ok(fallback.ctx.historySelectedLabels().includes('Heartbeat'));
});

test('account selection and pagination send explicit account/filter cursors', async () => {
  const calls = [];
  const { ctx, element } = createUI({ fetchImpl: async url => { const parsed = new URL(url, 'http://local'); calls.push(parsed); return { ok: true, async json() { return { activities: Array.from({ length: 50 }, (_, i) => ({ activityId: `a-${parsed.searchParams.get('offset')}-${i}`, accountId: parsed.searchParams.get('accountId'), labels: ['Trade'], timestamp: '2026-01-01T00:00:00Z', title: 'saved' })), total: 51 }; } }; } });
  element('history-account').value = 'acct-b';
  ctx.saveHistoryLabels(['Trade', 'Error']);
  await ctx.loadActivities(true);
  assert.equal(calls[0].searchParams.get('accountId'), 'acct-b');
  assert.equal(calls[0].searchParams.get('labels'), 'Trade,Error');
  await ctx.loadActivities(false);
  assert.equal(calls[1].searchParams.get('offset'), '50');
  assert.equal(ctx.historyState.activities.length, 100);
  element('history-account').value = '*';
  await ctx.loadActivities(true);
  assert.deepEqual(calls.slice(2).map(call => call.searchParams.get('accountId')).sort(), ['acct-a', 'acct-b']);
});

test('stale activity list responses cannot overwrite the newer filter selection', async () => {
  let releaseFirst;
  let count = 0;
  const { ctx, element } = createUI({ fetchImpl: async () => {
    count++;
    if (count === 1) return await new Promise(resolve => { releaseFirst = resolve; });
    return { ok: true, async json() { return { activities: [{ activityId: 'new', accountId: 'acct-a', labels: ['Trade'], timestamp: '2026-01-02T00:00:00Z', title: 'new selection' }], total: 1 }; } };
  } });
  const oldRequest = ctx.loadActivities(true);
  await Promise.resolve();
  const newRequest = ctx.loadActivities(true);
  await newRequest;
  releaseFirst({ ok: true, async json() { return { activities: [{ activityId: 'old', accountId: 'acct-a', labels: ['Trade'], timestamp: '2026-01-01T00:00:00Z', title: 'old selection' }], total: 1 }; } });
  await oldRequest;
  assert.deepEqual(Array.from(ctx.historyState.activities, item => item.activityId), ['new']);
  assert.match(element('history-activities').innerHTML, /new selection/);
});

test('details append records and render escaped text, tool evidence, and truncation notice', async () => {
  let pageNo = 0;
  const { ctx, element } = createUI({ fetchImpl: async () => ({ ok: true, async json() { pageNo++; return { activity: { origin: 'User', activityId: 'id-1', accountId: 'acct-a', records: pageNo === 1 ? [{ role: 'user', kind: 'message', content: '<img src=x onerror=1>' }, { kind: 'tool_call', tool: 'place_buy_order', args: { symbol: 'XYZ' }, result: 'captured', resultLength: 70, resultTruncated: true }] : [{ role: 'assistant', kind: 'message', content: 'later' }], hasMore: pageNo === 1 } }; } }) });
  await ctx.openActivity('id-1', 'acct-a');
  const first = element('history-transcript').innerHTML;
  assert.match(first, /&lt;img/);
  assert.match(first, /place_buy_order/);
  assert.match(first, /retained 8 of 70 characters/);
  const more = element('history-transcript').querySelector('#history-record-more');
  assert.ok(more);
  await more.dispatch('click');
  const second = element('history-transcript').innerHTML;
  assert.match(second, /&lt;img/);
  assert.match(second, /later/);
  assert.equal(pageNo, 2);
});

test('stale activity detail responses cannot replace a newer selection', async () => {
  let releaseOld;
  let calls = 0;
  const { ctx, element } = createUI({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return await new Promise(resolve => { releaseOld = resolve; });
    return { ok: true, async json() { return { activity: { origin: 'User', activityId: 'new-id', accountId: 'acct-a', records: [{ role: 'assistant', kind: 'message', content: 'new detail' }], hasMore: false } }; } };
  } });
  const oldRequest = ctx.openActivity('old-id', 'acct-a'); await Promise.resolve();
  await ctx.openActivity('new-id', 'acct-a');
  releaseOld({ ok: true, async json() { return { activity: { origin: 'User', activityId: 'old-id', accountId: 'acct-a', records: [{ role: 'assistant', kind: 'message', content: 'old detail' }], hasMore: false } }; } });
  await oldRequest;
  assert.match(element('history-transcript').innerHTML, /new detail/);
  assert.doesNotMatch(element('history-transcript').innerHTML, /old detail/);
});

test('legacy transcript pages append and use the structured tool renderer', async () => {
  let pageNo = 0;
  const els = new Map();
  const getElementById = id => {
    if (!els.has(id)) {
      const listeners = {};
      els.set(id, { id, style: {}, scrollIntoView() {}, replaceChildren() {}, append() {}, addEventListener(type, fn) { listeners[type] = fn; }, dispatch(type) { return listeners[type]?.({ target: this }); }, set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html || ''; }, set textContent(v) { this._text = v; }, get textContent() { return this._text || ''; } });
    }
    return els.get(id);
  };
  const recordFn = page.slice(page.indexOf('function renderHistoryRecord(msg)'), page.indexOf('function renderHistoryTranscript', page.indexOf('function renderHistoryRecord(msg)')));
  const legacyFns = page.slice(page.indexOf('async function openChatSession'), page.indexOf('async function startSandbox'));
  const ctx = { historyState: { chatSessions: [], chatMessages: [], legacyRequest: 0, detailRequest: 0 }, document: { getElementById }, esc: value => String(value ?? '').replace(/</g, '&lt;'), fetch: async () => ({ ok: true, async json() { pageNo++; return { session: { id: 'safe-id', accountId: 'acct-a' }, messages: pageNo === 1 ? Array.from({ length: 500 }, (_, i) => ({ kind: 'tool_call', tool: 'get_orders', args: { page: i }, result: 'body', resultLength: 100, resultTruncated: true })) : [{ role: 'assistant', kind: 'message', content: 'appended legacy reply' }] }; } }) };
  vm.createContext(ctx); vm.runInContext(recordFn + legacyFns, ctx);
  await ctx.openChatSession('safe-id', 'acct-a');
  assert.match(getElementById('history-transcript').innerHTML, /Result truncated: retained 4 of 100/);
  assert.match(getElementById('history-transcript').innerHTML, /get_orders/);
  await getElementById('legacy-transcript-more').dispatch('click');
  assert.match(getElementById('history-transcript').innerHTML, /appended legacy reply/);
  assert.match(getElementById('history-transcript').innerHTML, /get_orders/);
});

test('Manager persistence assigns one shared explicit User activity identity', () => {
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const block = server.slice(server.indexOf('const activityId = randomBytes(16).toString'), server.indexOf('// Update session tracking'));
  assert.match(block, /kind: 'manager_message',[^\n]+activityId, origin: 'User'/);
  assert.match(block, /kind: 'manager_response',[^\n]+activityId, origin: 'User'/);
});
