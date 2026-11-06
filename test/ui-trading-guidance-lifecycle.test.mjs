import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const inputIds = ['tg-delta-min', 'tg-delta-max', 'tg-expiry-min', 'tg-expiry-max', 'tg-min-entry', 'tg-extended', 'tg-market-symbol', 'tg-market-tolerance', 'tg-market-slope', 'tg-near-support', 'tg-slope', 'tg-extra-symbols', 'tg-catalyst-range', 'tg-catalyst-gap'];
const guidance = { contractDeltaMin: 0.40, contractDeltaMax: 0.70, expiryMinDays: 21, expiryMaxDays: 60, minEntryPct: 5, extendedPct: 4, marketSymbol: 'SPY', marketTolerancePct: 0.5, marketSlopeMinPct: -0.15, nearSupportPct: 2.5, avgSlopeMinPct: -0.30, extraSymbolsPerScan: 25, catalystRangeMinutes: 30, catalystMaxGapPct: 12 };

async function makeUi() {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const start = html.indexOf('let _tgTimer = null;');
  const end = html.indexOf('// ── Slack Plugin Config', start);
  assert.ok(start >= 0 && end > start, 'actual Trading Guidance UI functions are present');
  const elements = new Map(inputIds.map(id => [id, { id, value: '', checked: false, disabled: false, textContent: '' }]));
  elements.set('trading-guidance-card', { style: { display: 'none' } });
  elements.set('tg-status', { textContent: '' });
  elements.set('tg-reset', { disabled: true });
  const fetches = [];
  const timers = new Map();
  let timerId = 0;
  let sandboxId = 'sbx_a';
  const context = {
    document: { getElementById: id => elements.get(id) || null },
    getEffectiveSandboxId: () => sandboxId,
    fetch: (...args) => new Promise((resolve, reject) => fetches.push({ args, resolve, reject })),
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
    showToast() {},
    encodeURIComponent,
    JSON,
    Number,
  };
  vm.runInNewContext(html.slice(start, end), context);
  return {
    elements, fetches, timers, context,
    select(id) { sandboxId = id; },
    async respond(index, data, ok = true) { fetches[index].resolve({ ok, json: async () => data }); await Promise.resolve(); },
    runTimers() { const pending = [...timers.values()]; timers.clear(); pending.forEach(callback => callback()); },
  };
}

const responseFor = value => ({ defaults: guidance, guidance: value });

test('guidance fields and reset are locked while loading and cleared after a failed load', async () => {
  const ui = await makeUi();
  const loading = ui.context.loadTradingGuidanceUI();
  assert.ok(inputIds.every(id => ui.elements.get(id).disabled), 'all controls are locked while GET is pending');
  assert.equal(ui.elements.get('tg-extended').value, '', 'previous sandbox values are cleared immediately');
  await ui.respond(0, responseFor({ ...guidance, extendedPct: 7 }));
  await loading;
  assert.equal(ui.elements.get('tg-extended').disabled, false);
  assert.equal(ui.elements.get('tg-extended').value, 7);

  ui.select('sbx_b');
  const failed = ui.context.ensureTradingGuidanceScope();
  assert.ok(inputIds.every(id => ui.elements.get(id).disabled));
  await ui.respond(1, {}, false);
  await failed;
  assert.ok(inputIds.every(id => ui.elements.get(id).disabled));
  assert.equal(ui.elements.get('tg-extended').value, '');
  assert.match(ui.elements.get('tg-status').textContent, /unavailable/);
  ui.context.saveTradingGuidance();
  ui.context.resetTradingGuidance();
  assert.equal(ui.fetches.filter(item => item.args[1]?.method === 'PUT').length, 0, 'failed or unloaded values cannot be saved or reset');
});

test('late GET response from the prior sandbox cannot replace current values', async () => {
  const ui = await makeUi();
  const first = ui.context.loadTradingGuidanceUI();
  ui.select('sbx_b');
  const second = ui.context.ensureTradingGuidanceScope();
  await ui.respond(1, responseFor({ ...guidance, extendedPct: 8 }));
  await second;
  await ui.respond(0, responseFor({ ...guidance, extendedPct: 2 }));
  await first;
  assert.equal(ui.elements.get('tg-extended').value, 8);
  assert.equal(ui.elements.get('tg-extended').disabled, false);
});

test('pending debounce and reset cannot save a previous sandbox after switching', async () => {
  const ui = await makeUi();
  const loaded = ui.context.loadTradingGuidanceUI();
  await ui.respond(0, responseFor({ ...guidance, extendedPct: 7 }));
  await loaded;
  ui.elements.get('tg-extended').value = 9;
  ui.context.saveTradingGuidance();
  ui.select('sbx_b');
  ui.context.resetTradingGuidance();
  ui.runTimers();
  await Promise.resolve();
  assert.equal(ui.fetches.filter(item => item.args[1]?.method === 'PUT').length, 0, 'old debounce and reset are refused for the newly selected sandbox');
  const newLoad = ui.context.ensureTradingGuidanceScope();
  ui.elements.get('tg-extended').value = 9;
  ui.context.saveTradingGuidance();
  ui.runTimers();
  await Promise.resolve();
  assert.equal(ui.fetches.filter(item => item.args[1]?.method === 'PUT').length, 0, 'current sandbox cannot save before its GET completes');
  await ui.respond(1, responseFor({ ...guidance, extendedPct: 4 }));
  await newLoad;
  assert.equal(ui.elements.get('tg-extended').value, 4);
});
