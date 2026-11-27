import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const flow = page.slice(page.indexOf('function _slotFmt'), page.indexOf('// Drift warnings from prompt-preview'));
const editor = page.slice(page.indexOf('// ── Strategy editor: Slot settings (profile)'), page.indexOf('function slotProfileEditorHtml'))
  + page.slice(page.indexOf('let _slotProfileRemoved'), page.indexOf('async function assignAgentToSandbox'));

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
