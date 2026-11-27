import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const flow = page.slice(page.indexOf('function _slotFmt'), page.indexOf('// Drift warnings from prompt-preview'));
const editor = page.slice(page.indexOf('// ── Strategy editor: Slot settings (profile)'), page.indexOf('function slotProfileEditorHtml'))
  + page.slice(page.indexOf('let _slotProfileRemoved'), page.indexOf('async function assignAgentToSandbox'));

const drift = page.slice(page.indexOf('const NO_PROFILE_NOTICE'), page.indexOf('// Banner for any slot the server has blocked'));

const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

function flowContext({ responses, confirms }) {
  const calls = { previews: [], sends: [], modals: [], results: [] };
  const queue = [...responses];
  const ctx = {
    esc, console, URLSearchParams, config: { agents: [] },
    fetch: async url => { calls.previews.push(url); return { ok: true, status: 200, json: async () => ({ kind: 'switch', reviewToken: 't0', changes: {}, errors: [], warnings: [] }) }; },
  };
  vm.createContext(ctx);
  new vm.Script(flow).runInContext(ctx);
  ctx.showSlotTransitionModal = async (preview, notice) => { calls.modals.push({ preview, notice }); return confirms.shift() ?? false; };
  ctx.showSlotResultModal = async (title, message) => { calls.results.push({ title, message }); };
  ctx.send = async token => { calls.sends.push(token); const next = queue.shift(); return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body }; };
  return { ctx, calls };
}
const run = (ctx) => ctx.runSlotTransition({ sandboxId: 'sbx_a', kind: 'switch', activeAgentId: 'x', send: ctx.send });

test('page scripts still parse and every switch call goes through the shared helper', () => {
  for (const match of page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)) if (match[1].trim()) new vm.Script(match[1]);
  assert.equal((page.match(/switchSlotAgent\(/g) || []).length >= 4, true);
  assert.doesNotMatch(page, /body: JSON\.stringify\(\{ activeAgentId: (agentId|id|savedId) \}\)/);
  assert.match(page, /switch-preview\?/);
  assert.match(page, /agent\/apply-profile/);
  assert.match(page, /Apply strategy settings to this slot/);
  assert.match(page, /transitionBlocked/);
  assert.match(page, /Slot settings/);
});

test('success sends the preview token once', async () => {
  const { ctx, calls } = flowContext({ responses: [{ status: 200, body: { ok: true, committed: true, ready: true } }], confirms: [true] });
  const res = await run(ctx);
  assert.equal(res.status, 'ok');
  assert.deepEqual(calls.sends, ['t0']);
  assert.match(calls.previews[0], /kind=switch/);
});

test('cancel sends nothing', async () => {
  const { ctx, calls } = flowContext({ responses: [], confirms: [false] });
  assert.equal((await run(ctx)).status, 'cancelled');
  assert.equal(calls.sends.length, 0);
});

test('stale 409 re-shows the fresh preview and waits for a new confirmation', async () => {
  const fresh = { kind: 'switch', reviewToken: 't1', changes: {}, errors: [], warnings: [] };
  const { ctx, calls } = flowContext({ responses: [{ status: 409, body: { error: 'stale', preview: fresh } }], confirms: [true, false] });
  const res = await run(ctx);
  assert.equal(res.status, 'cancelled');
  assert.equal(calls.sends.length, 1);
  assert.equal(calls.modals.length, 2);
  assert.equal(calls.modals[1].preview.reviewToken, 't1');
  assert.match(calls.modals[1].notice, /stale/);
});

test('busy, committed-not-ready, blocked and plain errors are distinct and never retried', async () => {
  const cases = [
    [{ status: 409, body: { error: 'slot settings transition in progress' } }, 'busy', /busy/i],
    [{ status: 500, body: { ok: false, committed: true, ready: false, error: 'boom' } }, 'not-ready', /Settings saved; the agent has not restarted/],
    [{ status: 500, body: { ok: false, committed: false, guidanceRestored: false, error: 'x' } }, 'blocked', /recovery needed/],
    [{ status: 400, body: { error: 'bad' } }, 'rejected', /nothing saved/i],
  ];
  for (const [response, status, title] of cases) {
    const { ctx, calls } = flowContext({ responses: [response], confirms: [true] });
    assert.equal((await run(ctx)).status, status);
    assert.equal(calls.sends.length, 1);
    assert.match(calls.results[0].title, title);
  }
});

test('confirm is disabled when the preview has errors; no-profile text and server strings are escaped', () => {
  const ctx = { esc, config: { agents: [] }, document: { body: { appendChild(el) { ctx.node = el; } }, getElementById: () => null, createElement: () => ({ querySelector: () => ({}), remove() {}, set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; }, style: {} }) } };
  vm.createContext(ctx);
  new vm.Script(flow).runInContext(ctx);
  ctx.showSlotTransitionModal({ kind: 'switch', sandboxId: 's', hasProfile: false, reviewToken: 't', errors: ['<img src=x>'], warnings: [], changes: { tradingGuidance: [{ key: 'k', before: 1, after: 2 }] } });
  const html = ctx.node.innerHTML;
  assert.match(html, /id="slot-tx-confirm" disabled/);
  assert.match(html, /not guaranteed ready/);
  assert.match(html, /k: 1 &rarr; 2/);
  assert.doesNotMatch(html, /<img/);
});

test('strategy editor: blank omits, 0 kept, remove sends null, untouched empty sends nothing', () => {
  const values = {};
  const ctx = { document: { getElementById: id => (id in values ? { value: values[id] } : null) } };
  vm.createContext(ctx);
  new vm.Script(editor).runInContext(ctx);
  Object.assign(values, { 'f-sp-extraSymbolsPerScan': '0', 'f-sp-contractDeltaMin': '0.6', 'f-sp-marketSymbol': 'spy', 'f-sp-hb-midday': '1800', 'f-sp-expiryMinDays': '  ' });
  const filled = ctx.collectSlotProfile(false);
  assert.deepEqual(JSON.parse(JSON.stringify(filled.value)), { tradingGuidance: { contractDeltaMin: 0.6, marketSymbol: 'SPY', extraSymbolsPerScan: 0 }, heartbeat: { midday: 1800 } });
  for (const k of Object.keys(values)) values[k] = '';
  assert.equal(ctx.collectSlotProfile(false).include, false);
  assert.deepEqual(JSON.parse(JSON.stringify(ctx.collectSlotProfile(true))), { include: true, value: null });
  values['f-sp-contractDeltaMax'] = 'abc';
  assert.ok(ctx.collectSlotProfile(false).error);
});

// N03(b)/N02: the Apply button follows the structured profileDrift only; the no-profile notice follows profileStatus.
function renderDrift(preview, sid = 'sbx_a') {
  const box = { innerHTML: '' };
  const ctx = { esc, document: { querySelectorAll: selector => (selector === '.slot-drift-box' ? [box] : []) } };
  vm.createContext(ctx);
  new vm.Script(flow).runInContext(ctx);
  new vm.Script(drift).runInContext(ctx);
  ctx.renderSlotDrift(preview, sid);
  return box.innerHTML;
}
const APPLY = /applyStrategySettingsToSlot\(\)/;
const NOTICE = 'Barometer\'s strategy has no slot settings profile: this slot keeps its current settings.';

test('drift box: Apply appears only for a non-null profileDrift, never from warning text', () => {
  const drifted = renderDrift({ warnings: ['Barometer\'s strategy settings differ from this slot: expiryMinDays is 33 (strategy 90).'], profileStatus: { effectiveStrategyId: 's', hasProfile: true }, profileDrift: { differs: true, items: [{ key: 'expiryMinDays' }] } });
  assert.match(drifted, APPLY);
  assert.match(drifted, /strategy settings differ/);
  // the same wording without structured drift: no button (the old text match would have offered one)
  assert.doesNotMatch(renderDrift({ warnings: ['Barometer\'s strategy settings differ from this slot: x'], profileStatus: { hasProfile: true }, profileDrift: null }), APPLY);
  assert.doesNotMatch(renderDrift({ warnings: ['slot settings profile text'], profileDrift: null }), APPLY);
  assert.doesNotMatch(renderDrift({ warnings: ['x'], profileDrift: { differs: true, items: [] } }, ''), APPLY, 'no slot -> no button');
});

test('drift box: an unprofiled strategy shows the no-profile notice (once) and no Apply button; escaped', () => {
  const withServerText = renderDrift({ warnings: [NOTICE], profileStatus: { effectiveStrategyId: 'macro-rotation', hasProfile: false }, profileDrift: null });
  assert.match(withServerText, /no slot settings profile/);
  assert.equal((withServerText.match(/no slot settings profile/g) || []).length, 1);
  assert.doesNotMatch(withServerText, APPLY);
  // the structured status alone is enough: the UI supplies the notice when the warnings do not carry it
  const statusOnly = renderDrift({ warnings: [], profileStatus: { effectiveStrategyId: 'macro-rotation', hasProfile: false }, profileDrift: null });
  assert.equal((statusOnly.match(/no slot settings profile/g) || []).length, 1);
  assert.doesNotMatch(statusOnly, APPLY);
  assert.doesNotMatch(renderDrift({ warnings: ['<img src=x>'], profileStatus: { hasProfile: false }, profileDrift: null }), /<img/);
  // profiled and in line: nothing to show
  assert.equal(renderDrift({ warnings: [], profileStatus: { hasProfile: true }, profileDrift: null }), '');
});

test('prompt preview caller hands the whole response to renderSlotDrift (no warning-text argument)', () => {
  assert.match(page, /renderSlotDrift\(d, sid\)/);
  assert.doesNotMatch(page, /renderSlotDrift\(d\.warnings/);
  assert.doesNotMatch(page, /\/profile\|slot settings\|strategy settings\/i\.test/);
});
