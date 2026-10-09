import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');
const filterStart = page.indexOf('function isBrokerConfirmedFill(order)');
const filterEnd = page.indexOf('function selectedTradeAccounts()', filterStart);
const loadStart = page.indexOf('async function loadVerifiedTrades()', filterEnd);
const loadEnd = page.indexOf('const TOOL_REFERENCE', loadStart);
const source = page.slice(filterStart, filterEnd) + page.slice(loadStart, loadEnd);
const fill = (overrides = {}) => ({
  ID: 'o1', accountId: 'a1', accountName: 'Alpha', agentId: 'g1', agentName: 'Agent One',
  Symbol: 'AAPL', Status: 'filled', Side: 'buy', FilledQty: 2, FilledAvgPrice: 10,
  FilledAt: new Date(2026, 0, 1, 12).toISOString(), ...overrides,
});

class MockElement {
  constructor(id = '') {
    this.id = id; this.value = ''; this.textContent = ''; this.style = {}; this.dataset = {};
    this.checked = false; this.hidden = false; this.children = []; this.listeners = {};
    this._html = '';
  }
  set innerHTML(value) {
    this._html = value; this.children = [];
    this.inputs = [...value.matchAll(/<input type="checkbox" data-vfilter="([^"]+)" value="([^"]+)" ?(checked)?/g)].map(match => {
      const input = new MockElement(); input.value = match[2]; input.checked = Boolean(match[3]);
      input.dataset.vfilter = match[1]; return input;
    });
    this.buttons = [...value.matchAll(/<button[^>]+data-(vall|vclear)="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map(match => {
      const button = new MockElement(); button.dataset[match[1]] = match[2]; button.textContent = match[3]; return button;
    });
  }
  get innerHTML() { return this._html; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  dispatch(type, target = this) { return this.listeners[type]?.({ target }); }
  querySelectorAll(selector) {
    const match = selector.match(/\[data-vfilter="([^"]+)"\](?::checked)?/);
    const inputs = this.inputs || [];
    return inputs.filter(input => !match || input.dataset.vfilter === match[1]).filter(input => !selector.endsWith(':checked') || input.checked);
  }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = nodes; }
}

function setup(orders = [], { trades = [], accounts = [], fetchImpl } = {}) {
  const ids = [
    'verified-trade-filters', 'verified-account-filters', 'verified-agent-filters', 'verified-asset-filters',
    'verified-right-filters', 'verified-side-filters', 'verified-trade-search', 'verified-date-from',
    'verified-date-to', 'verified-date-preset', 'verified-date-error', 'verified-timezone',
    'verified-trade-count', 'verified-trade-more', 'verified-filter-reset', 'trades-feed',
    'trade-account-toggles', 'trade-chart-summary', 'trade-ledger-status',
  ];
  const elements = new Map(ids.map(id => [id, new MockElement(id)]));
  const root = elements.get('verified-trade-filters');
  root.querySelectorAll = selector => {
    const match = selector.match(/\[data-vfilter="([^"]+)"\](?::checked)?/);
    const groups = ['verified-account-filters','verified-agent-filters','verified-asset-filters','verified-right-filters','verified-side-filters'];
    const inputs = groups.flatMap(id => elements.get(id).inputs || []);
    return inputs.filter(input => !match || input.dataset.vfilter === match[1]).filter(input => !selector.endsWith(':checked') || input.checked);
  };
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, new MockElement(id)); return elements.get(id); },
    createElement(tag) { return new MockElement(tag); },
    createTextNode(text) { const node = new MockElement(); node.textContent = text; return node; },
  };
  const ctx = {
    verifiedOrders: orders, verifiedTrades: trades, verifiedTradesLoading: false,
    verifiedReconciliationComplete: true, verifiedAccountStates: new Map(accounts.map(account => [account.accountId, account])),
    verifiedTradeFilterState: { accounts: null, agents: null, pageSize: 50, preset: 'all', from: '', to: '', search: '', assets: null, rights: null, sides: null },
    document, Date, Number, String, Boolean, Set, Map, Intl,
    esc: value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char])),
    fmtPnl: value => value == null ? 'P/L pending' : `$${Number(value).toFixed(2)}`,
    clearTradeFeed() { const feed = document.getElementById('trades-feed'); feed.innerHTML = ''; feed.children = []; return feed; },
    renderTradeChart() {}, updateTradeChart() {}, fetch: fetchImpl || (async () => ({ ok: true, async json() { return {}; } })),
  };
  vm.createContext(ctx); vm.runInContext(source, ctx);
  return { ctx, elements };
}
const idsOf = result => Array.from(result, order => order.ID);
const group = (elements, id) => elements.get(id).inputs;
const change = (root, input, checked) => { input.checked = checked; root.dispatch('change', input); };

test('real account/agent Clear and All handlers, including missing agent IDs', () => {
  const { ctx, elements } = setup([fill(), fill({ ID:'unassigned', accountId:'a2', agentId:null, agentName:'Stale label' })], {
    accounts: [{ accountId:'a1', accountName:'Alpha', agentId:'g1', agentName:'Agent One' }, { accountId:'a2', accountName:'Beta' }],
  });
  ctx.renderVerifiedTradeFeed();
  assert.ok(group(elements, 'verified-agent-filters').some(input => input.value === '__unassigned__'));
  assert.equal(elements.get('verified-agent-filters').innerHTML.includes('Stale label'), false);
  elements.get('verified-trade-filters').dispatch('click', elements.get('verified-account-filters').buttons.find(button => button.dataset.vclear));
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), []);
  assert.ok(group(elements, 'verified-account-filters').every(input => !input.checked));
  elements.get('verified-trade-filters').dispatch('click', elements.get('verified-account-filters').buttons.find(button => button.dataset.vall));
  assert.equal(ctx.filteredVerifiedOrders().length, 2);
  assert.ok(group(elements, 'verified-account-filters').every(input => input.checked));
});

test('asset, option-right, and side All/Clear handlers update only their own groups', () => {
  const orders = [
    fill(), fill({ ID:'sell', accountId:'a2', agentId:'g2', Side:'sell' }),
    fill({ ID:'call', Symbol:'XOM261016C00160000' }),
  ];
  const { ctx, elements } = setup(orders);
  ctx.renderVerifiedTradeFeed();
  const root = elements.get('verified-trade-filters');
  const cases = [
    { id:'verified-asset-filters', field:'assets', expectedAfterClear:[] },
    { id:'verified-right-filters', field:'rights', expectedAfterClear:['o1','sell'] },
    { id:'verified-side-filters', field:'sides', expectedAfterClear:[] },
  ];
  for (const item of cases) {
    const host = elements.get(item.id);
    root.dispatch('click', host.buttons.find(button => button.dataset.vclear));
    assert.deepEqual(Array.from(ctx.verifiedTradeFilterState[item.field]), []);
    assert.ok(group(elements, item.id).every(input => !input.checked));
    assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()).sort(), item.expectedAfterClear.sort());
    assert.equal(ctx.verifiedTradeFilterState.accounts, null);
    assert.equal(ctx.verifiedTradeFilterState.agents, null);
    root.dispatch('click', elements.get(item.id).buttons.find(button => button.dataset.vall));
    assert.equal(ctx.verifiedTradeFilterState[item.field], null);
    assert.ok(group(elements, item.id).every(input => input.checked));
    assert.equal(ctx.filteredVerifiedOrders().length, 3);
    assert.equal(ctx.verifiedTradeFilterState.accounts, null);
    assert.equal(ctx.verifiedTradeFilterState.agents, null);
  }
  root.dispatch('click', { dataset:{vclear:'unknown-filter-group'} });
  assert.equal(ctx.filteredVerifiedOrders().length, 3);
});

test('filter, Reset, then filter again uses the current state object', () => {
  const { ctx, elements } = setup([fill(), fill({ ID:'sell', Side:'sell' })]);
  ctx.renderVerifiedTradeFeed();
  const root = elements.get('verified-trade-filters');
  change(root, group(elements, 'verified-side-filters').find(input => input.value === 'buy'), false);
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), ['sell']);
  root.dispatch('click', elements.get('verified-filter-reset'));
  assert.equal(ctx.verifiedTradeFilterState.pageSize, 50);
  change(root, group(elements, 'verified-side-filters').find(input => input.value === 'sell'), false);
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), ['o1']);
});

test('reset then Load more updates the reset page size and matching/displayed count', () => {
  const { ctx, elements } = setup(Array.from({ length: 130 }, (_, i) => fill({ ID:`o${i}` })));
  ctx.renderVerifiedTradeFeed();
  assert.equal(elements.get('verified-trade-count').textContent, '130 matching / 50 displayed');
  elements.get('verified-trade-filters').dispatch('click', elements.get('verified-filter-reset'));
  elements.get('verified-trade-filters').dispatch('click', elements.get('verified-trade-more'));
  assert.equal(ctx.verifiedTradeFilterState.pageSize, 100);
  assert.equal(elements.get('verified-trade-count').textContent, '130 matching / 100 displayed');
  assert.equal(elements.get('trades-feed').children.length, 100);
});

test('refresh retains chosen filters and rerenders using refreshed data', async () => {
  const { ctx, elements } = setup([fill()], { accounts: [{accountId:'a1',accountName:'Alpha',complete:true}] });
  ctx.renderVerifiedTradeFeed();
  const root = elements.get('verified-trade-filters');
  change(root, group(elements, 'verified-account-filters').find(input => input.value === 'a1'), false);
  ctx.fetch = async () => ({ ok:true, async json() { return {
    accounts:[{accountId:'a1',accountName:'Alpha',complete:true}],
    orders:[fill(),fill({ID:'new',accountId:'a2',accountName:'Beta'})], trades:[], complete:true,
  }; } });
  await ctx.loadVerifiedTrades();
  assert.doesNotMatch(elements.get('trade-chart-summary').textContent, /Unable to load/);
  assert.deepEqual(Array.from(ctx.verifiedTradeFilterState.accounts), []);
  assert.equal(ctx.filteredVerifiedOrders().length, 0);
  change(root, group(elements, 'verified-account-filters').find(input => input.value === 'a1'), true);
  assert.deepEqual(Array.from(ctx.verifiedTradeFilterState.accounts), ['a1']);
  assert.equal(ctx.verifiedOrders.length, 1);
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), ['o1']);
});

test('combined asset and side handlers filter, and unknown classes remain selectable', () => {
  const { ctx, elements } = setup([
    fill(), fill({ ID:'call', Symbol:'XOM261016C00160000' }),
    fill({ ID:'crypto', Symbol:'BTC/USD', AssetClass:'crypto' }),
    fill({ ID:'unknown-side', Side:'short' }),
    fill({ ID:'unknown-right', Symbol:'ODD', AssetClass:'option' }),
  ]);
  ctx.renderVerifiedTradeFeed();
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()).sort(), ['call','crypto','o1','unknown-right','unknown-side'].sort());
  const root = elements.get('verified-trade-filters');
  change(root, group(elements, 'verified-asset-filters').find(input => input.value === 'stock'), false);
  change(root, group(elements, 'verified-side-filters').find(input => input.value === 'unknown'), false);
  change(root, group(elements, 'verified-right-filters').find(input => input.value === 'unknown'), false);
  change(root, group(elements, 'verified-asset-filters').find(input => input.value === 'unclassified'), false);
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), ['call']);
  change(root, group(elements, 'verified-right-filters').find(input => input.value === 'call'), false);
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()), []);
  change(root, group(elements, 'verified-asset-filters').find(input => input.value === 'stock'), true);
  assert.ok(idsOf(ctx.filteredVerifiedOrders()).includes('o1'), 'enabled stocks remain visible when Calls are unchecked');
});

test('date preset, manual Custom selection, inclusive boundaries, validation, and invalid dates use actual handlers', () => {
  const first = fill({ ID:'first', FilledAt:new Date(2026,0,1,0,0).toISOString() });
  const second = fill({ ID:'second', FilledAt:new Date(2026,0,2,23,59).toISOString() });
  const unknown = fill({ ID:'unknown', FilledAt:'not-a-date', filledAt:null, SubmittedAt:'2026-01-02' });
  const { ctx, elements } = setup([first, second, unknown]);
  ctx.renderVerifiedTradeFeed();
  const root=elements.get('verified-trade-filters'), preset=elements.get('verified-date-preset');
  preset.value='7'; root.dispatch('change',preset);
  const today=new Date(), expectedStart=new Date(today.getFullYear(),today.getMonth(),today.getDate()-6);
  assert.equal(elements.get('verified-date-from').value, `${expectedStart.getFullYear()}-${String(expectedStart.getMonth()+1).padStart(2,'0')}-${String(expectedStart.getDate()).padStart(2,'0')}`);
  assert.equal(elements.get('verified-date-to').value, `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`);
  preset.value='custom'; root.dispatch('change',preset);
  const from=elements.get('verified-date-from'); from.value='2026-01-01'; root.dispatch('change',from);
  const to=elements.get('verified-date-to'); to.value='2026-01-02'; root.dispatch('change',to);
  assert.equal(preset.value,'custom');
  assert.deepEqual(idsOf(ctx.filteredVerifiedOrders()).sort(),['first','second']);
  from.value='2026-01-03'; root.dispatch('change',from);
  assert.match(elements.get('verified-date-error').textContent,/on or before/);
  from.value=''; to.value=''; preset.value='all'; root.dispatch('change',preset);
  ctx.renderVerifiedTradeFeed();
  const unknownCard=elements.get('trades-feed').children.find(card=>card.children.some(child=>child.textContent==='Fill date unknown'));
  assert.ok(unknownCard, 'invalid broker fill timestamp is labeled unknown');
  assert.ok(ctx.filteredVerifiedOrders().some(order=>order.ID==='unknown'), 'invalid fill date remains in All dates');
});

test('account-scoped P/L is rendered correctly for duplicate order IDs', () => {
  const orders=[fill({ID:'same',accountId:'a1',accountName:'Alpha'}),fill({ID:'same',accountId:'a2',accountName:'Beta'})];
  const trades=[{orderId:'same',accountId:'a1',pnl:12.5},{orderId:'same',accountId:'a2',pnl:-3}];
  const { ctx, elements }=setup(orders,{trades});
  ctx.renderVerifiedTradeFeed();
  const details=elements.get('trades-feed').children.map(card=>card.children.find(child=>child.className==='trade-details').textContent);
  assert.ok(details.some(value=>value.includes('Alpha') && value.includes('$12.50')));
  assert.ok(details.some(value=>value.includes('Beta') && value.includes('$-3.00')));
});

test('failed ledger refresh clears old matching counts and hides Load more', async () => {
  const { ctx, elements }=setup(Array.from({length:75},(_,i)=>fill({ID:`x${i}`})));
  ctx.renderVerifiedTradeFeed();
  assert.equal(elements.get('verified-trade-more').hidden,false);
  ctx.fetch=async()=>({ok:false,status:503});
  await ctx.loadVerifiedTrades();
  assert.equal(elements.get('verified-trade-count').textContent,'0 matching / 0 displayed');
  assert.equal(elements.get('verified-trade-more').hidden,true);
});
