import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Hermes C3 QA fixes (Nov 22): a switch or an override can never leave a slot with a missing or unknown strategy, a strategy fit
// can never put an invalid permission list on a slot, a spread held on a slot without a vertical keeps a coherent close recipe, and
// a switch to an agent without options is refused while the slot still holds option exposure. Real config store, inert fixtures.

const FX = new URL('./fixtures/agent-consistency/', import.meta.url);
const json = async name => JSON.parse(await fs.readFile(new URL(name, FX), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const base = { agents: await json('agents.json'), strategies: await json('strategies.json'), slots: await json('slots.json'), perms: await json('perms.json') };
const { planConsistencyEdits } = await import('../agent/consistency-targets.js');
const plan = planConsistencyEdits(clone(base));
const after = clone(base);
for (const [id, edit] of Object.entries(plan.agentPrompts)) Object.assign(after.agents.find(a => a.id === id), edit);
for (const [id, edit] of Object.entries(plan.strategyEdits)) Object.assign(after.strategies.find(s => s.id === id), edit);
for (const [slot, keys] of Object.entries(plan.slotClears)) for (const key of keys) after.slots[slot].agent.overrides[key] = null;
for (const [slot, patch] of Object.entries(plan.permissions)) Object.assign(after.perms[slot], patch);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-c3-hardening-'));
const configPath = path.join(tempDir, 'agent-config.json');
process.env.OPENPROPHET_CONFIG_PATH = configPath;
process.env.OPENPROPHET_EXECUTION_MODE = 'inert';
const L1 = 'sbx_723be98b', L2 = 'sbx_956ff9e4', L3 = 'sbx_0d35471e';
const SLOTS = [L1, L2, L3];
const store = await import('../agent/config-store.js?c3-hardening');
const { buildSystemPrompt, AgentHarness } = await import('../agent/harness.js');
const { openGroupCloseReminder } = await import('../agent/spread-guidance.js');
const { permissionPatchForFit, strategyOptionFit, fitDriftWarning, validateOptionFitInput } = await import('../agent/agent-consistency.js');
const { optionExposureReason, isFlatTerminalGroup } = await import('../agent/switch-guard.js');

async function reset(mutate = () => {}) {
  const state = clone(after);
  mutate(state);
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    accounts: SLOTS.map((sid, i) => ({ id: `acc${i + 1}`, name: `L${i + 1}`, paper: true })),
    activeAccountId: 'acc1', activeSandboxId: L1,
    agents: state.agents, strategies: state.strategies,
    sandboxes: Object.fromEntries(SLOTS.map((sid, i) => [sid, { id: sid, name: `L${i + 1}`, accountId: `acc${i + 1}`, agent: state.slots[sid].agent, permissions: state.perms[sid] }])),
  }, null, 2));
  await store.loadConfig();
  store.consumeAgentSwitch(L1); store.consumeAgentSwitch(L2); store.consumeAgentSwitch(L3);
}
const agentOf = id => after.agents.find(a => a.id === id);
const snapshot = sid => clone({ active: store.getSandbox(sid).agent.activeAgentId, overrides: store.getSandbox(sid).agent.overrides, perms: store.getPermissionsForSandbox(sid), model: store.getSandbox(sid).agent.model });
const onDisk = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  delete process.env.OPENPROPHET_CONFIG_PATH;
  delete process.env.OPENPROPHET_EXECUTION_MODE;
});

// ── C3-01: one validated strategy choice ──────────────────────────────────────────────────────────────────────────────
for (const [label, value] of [['null', null], ['empty', ''], ['blank', '   ']]) {
  test(`a switch with strategyId ${label} uses the new agent's own strategy and its fit, saved and reloaded`, async () => {
    await reset();
    await store.updateSandboxAgentSelection(L1, { activeAgentId: 'long-vol', overrides: { strategyId: value } });
    const resolved = store.getResolvedAgentForSandbox(L1);
    assert.equal(resolved.strategyId, 'long-premium-volatility');
    assert.equal(store.getSandbox(L1).agent.overrides.strategyId, undefined, 'no strategyId is stored');
    assert.deepEqual(store.getPermissionsForSandbox(L1).allowedStructures, ['long_call', 'long_put']);
    const saved = await onDisk();
    assert.equal(Object.hasOwn(saved.sandboxes[L1].agent.overrides, 'strategyId'), false);
    await store.loadConfig();
    assert.equal(store.getResolvedAgentForSandbox(L1).strategyId, 'long-premium-volatility');
  });
}

test('a switch with an unknown strategy is refused and nothing changes (agent, overrides, permissions, file)', async () => {
  await reset();
  const before = snapshot(L1);
  const fileBefore = await fs.readFile(configPath, 'utf8');
  for (const bad of ['does-not-exist', 42, {}, ['x']]) {
    await assert.rejects(store.updateSandboxAgentSelection(L1, { activeAgentId: 'long-vol', overrides: { strategyId: bad } }), /strategy/i);
  }
  assert.deepEqual(snapshot(L1), before);
  assert.equal(await fs.readFile(configPath, 'utf8'), fileBefore);
  assert.equal(store.consumeAgentSwitch(L1), null, 'no switch was recorded');
});

test('a valid explicit strategy in the same request is kept and its fit decides the permission', async () => {
  await reset();
  await store.updateSandboxAgentSelection(L1, { activeAgentId: 'long-vol', overrides: { strategyId: 'etf-mean-reversion', heartbeatOverrides: { market_open: 111 } } });
  const resolved = store.getResolvedAgentForSandbox(L1);
  assert.equal(resolved.strategyId, 'etf-mean-reversion');
  assert.equal(resolved.heartbeatOverrides.market_open, 111);
  assert.deepEqual(store.getPermissionsForSandbox(L1).allowedStructures, ['long_call', 'bull_call_debit']);
});

test('the overrides route: null clears the slot strategy and heartbeat map, an unknown strategy is refused, a valid one is kept', async () => {
  await reset();
  await store.updateSandboxAgentOverrides(L2, { strategyId: 'catalyst-news', heartbeatOverrides: { market_open: 5 } });
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'catalyst-news');
  const before = snapshot(L2);
  await assert.rejects(store.updateSandboxAgentOverrides(L2, { strategyId: 'nope' }), /Unknown strategy/);
  assert.deepEqual(snapshot(L2), before);
  await store.updateSandboxAgentOverrides(L2, { strategyId: null, heartbeatOverrides: null });
  const resolved = store.getResolvedAgentForSandbox(L2);
  assert.equal(resolved.strategyId, 'etf-mean-reversion');
  assert.deepEqual(resolved.heartbeatOverrides, agentOf('mean-reversion').heartbeatOverrides);
  assert.equal(store.getSandbox(L2).agent.overrides.strategyId, undefined);
});

test('a saved null or unknown slot strategyId (old state) is ignored by the resolver', async () => {
  await reset(state => { state.slots[L2].agent.overrides.strategyId = null; });
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'etf-mean-reversion');
  await reset(state => { state.slots[L2].agent.overrides.strategyId = 'gone'; });
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'etf-mean-reversion');
});

test('an agent definition refuses an unknown strategy; blank means none as before; a new strategy drops the slot copy of the old one', async () => {
  await reset();
  await assert.rejects(store.updateAgent('mean-reversion', { strategyId: 'nope' }), /Unknown strategy/);
  await assert.rejects(store.addAgent({ name: 'X', strategyId: 'nope' }), /Unknown strategy/);
  assert.equal((await store.addAgent({ name: 'Blank', strategyId: '  ' })).strategyId, null);
  assert.equal(store.getSandbox(L2).agent.overrides.strategyId, 'etf-mean-reversion');
  await store.updateAgent('mean-reversion', { strategyId: 'equity-momentum' });
  assert.equal(store.getSandbox(L2).agent.overrides.strategyId, undefined);
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'equity-momentum');
});

// ── C3-03: validated fits and permission patches ──────────────────────────────────────────────────────────────────────
test('a strategy refuses an invalid option fit; null clears it; an empty list (shares) is allowed', async () => {
  await reset();
  for (const bad of [['long_call', 'long_call'], ['iron_condor'], 'long_call', [1], [null]]) {
    await assert.rejects(store.updateStrategy('equity-momentum', { optionStructures: bad }), /optionStructures/);
  }
  assert.deepEqual(store.getStrategyById('equity-momentum').optionStructures, ['long_call', 'bull_call_debit'], 'unchanged after refusals');
  await store.updateStrategy('equity-momentum', { optionStructures: [] });
  assert.deepEqual(strategyOptionFit(store.getStrategyById('equity-momentum')), []);
  await store.updateStrategy('equity-momentum', { optionStructures: null });
  assert.deepEqual(strategyOptionFit(store.getStrategyById('equity-momentum')), ['long_call', 'bull_call_debit'], 'null falls back to the built-in default');
  assert.deepEqual((await store.addStrategy({ name: 'S', optionStructures: ['long_put'] })).optionStructures, ['long_put']);
  await assert.rejects(store.addStrategy({ name: 'T', optionStructures: ['long_put', 'long_put'] }), /repeat/);
  assert.equal(validateOptionFitInput(undefined), undefined);
});

test('a duplicate fit already in the saved config is de-duplicated, never copied onto the slot, and passes the permission validator', async () => {
  await reset(state => { state.strategies.find(s => s.id === 'equity-momentum').optionStructures = ['long_call', 'long_call']; });
  assert.deepEqual(strategyOptionFit(store.getStrategyById('equity-momentum')), ['long_call']);
  await store.updateSandboxAgentSelection(L1, { activeAgentId: 'momentum' });
  const list = store.getPermissionsForSandbox(L1).allowedStructures;
  assert.deepEqual(list, ['long_call']);
  await store.updatePermissionsForSandbox(L1, { allowedStructures: list });
});

test('a corrupt stored permission list (a repeated name) is replaced by the new agent valid fit on a switch', async () => {
  await reset(state => { state.perms[L1].allowedStructures = ['long_call', 'long_call']; });
  await store.updateSandboxAgentSelection(L1, { activeAgentId: 'long-vol' });
  const list = store.getPermissionsForSandbox(L1).allowedStructures;
  assert.deepEqual(list, ['long_call', 'long_put']);
  await store.updatePermissionsForSandbox(L1, { allowedStructures: list }); // the ordinary validator accepts what the switch saved
});

test('permissionPatchForFit compares real sets: a repeated name is never "the same list"; an empty fit keeps the stored list', () => {
  assert.deepEqual(permissionPatchForFit(['long_call'], { allowOptions: true, allowedStructures: ['long_call', 'long_put'] }), { allowOptions: true, allowedStructures: ['long_call'] });
  assert.deepEqual(permissionPatchForFit(['long_call', 'long_put'], { allowOptions: true, allowedStructures: ['long_call', 'long_call'] }), { allowOptions: true, allowedStructures: ['long_call', 'long_put'] });
  assert.equal(permissionPatchForFit(['long_call', 'long_put'], { allowOptions: true, allowedStructures: ['long_put', 'long_call'] }), null);
  assert.deepEqual(permissionPatchForFit([], { allowOptions: true, allowedStructures: ['long_call', 'bull_call_debit'] }), { allowOptions: false });
  assert.equal(permissionPatchForFit([], { allowOptions: false }), null);
  assert.equal(permissionPatchForFit(null, { allowOptions: true }), null);
});

test('a deliberate empty shares fit still turns options off and keeps the stored list', async () => {
  await reset();
  const stored = store.getPermissionsForSandbox(L1).allowedStructures;
  await store.updateSandboxAgentSelection(L1, { activeAgentId: 'macro-rotation' });
  assert.equal(store.getPermissionsForSandbox(L1).allowOptions, false);
  assert.deepEqual(store.getPermissionsForSandbox(L1).allowedStructures, stored);
});

test('the drift warning names a slot permission that differs from the strategy fit, and is silent when they match', () => {
  assert.match(fitDriftWarning(['long_call', 'bull_call_debit'], { allowOptions: true, allowedStructures: ['long_call', 'long_put'] }, 'Surge'), /Surge's strategy fits long_call, bull_call_debit/);
  assert.equal(fitDriftWarning(['long_call'], { allowOptions: true, allowedStructures: ['long_call'] }), null);
  assert.equal(fitDriftWarning(null, { allowOptions: true }), null);
  assert.match(fitDriftWarning([], { allowOptions: true, allowedStructures: ['long_call'] }, 'Compass'), /no options \(shares only\)/);
});

// ── C3-02: a close-only slot keeps a coherent close recipe ───────────────────────────────────────────────────────────
const agentConfig = { id: 'long-vol', name: 'Vega', systemPromptTemplate: 'custom', strategyId: 'long-premium-volatility', customSystemPrompt: 'You are Vega.' };
const getStrategyById = () => ({ customRules: '- Rules.', optionStructures: ['long_call', 'long_put'] });

test('a slot without a vertical: the system prompt allows closing a held group, never opening one, and carries no "not exposed" claim', async () => {
  const prompt = await buildSystemPrompt(agentConfig, { getStrategyById, allowedStructures: ['long_call', 'long_put'], allowOptions: true });
  assert.doesNotMatch(prompt, /Agent execution is single-leg only/);
  assert.doesNotMatch(prompt, /Its agent schema is single-leg only/);
  assert.doesNotMatch(prompt, /not exposed by this tool/);
  assert.match(prompt, /You open single-leg orders only and may not open a spread/);
  assert.match(prompt, /close an existing two-leg group as one order, when a heartbeat note tells you an intact one is open/);
  assert.doesNotMatch(prompt, /Debit vertical mechanics/);
  const off = await buildSystemPrompt(agentConfig, { getStrategyById, allowedStructures: ['long_call'], allowOptions: false });
  assert.match(off, /Agent execution is single-leg only/);
});

test('the heartbeat close note plus the system prompt give one usable close-only recipe', async () => {
  const group = { group_id: 'g1', underlying: 'AAPL', structure: 'bull_call_debit', status: 'open', open_units: 3 };
  const reminder = openGroupCloseReminder([group]);
  for (const part of [/exactly two; each has symbol, side, position_intent and the positive quote price/, /order_type limit/, /one client_order_id/, /top level \(sell \/ sell_to_close\)|repeat the first leg at the top level/, /net credit per unit/, /open units minus units already in a pending close/, /Never leg out with separate orders/, /you may not open another spread/, /3 open units/]) {
    assert.match(reminder, part);
  }
  const prompt = await buildSystemPrompt(agentConfig, { getStrategyById, allowedStructures: ['long_call', 'long_put'], allowOptions: true });
  assert.doesNotMatch(prompt, /atomic multi-leg support is not exposed/);
  assert.doesNotMatch(prompt, /single-leg only/);
});

test('only settled exposure gets the close text; pending, zero-unit, closed and void records do not', async () => {
  const mk = overrides => ({ group_id: 'g', underlying: 'MSFT', structure: 'bull_call_debit', status: 'open', open_units: 1, ...overrides });
  const brokenText = openGroupCloseReminder([mk({ status: 'broken' })]);
  assert.match(brokenText, /BROKEN SPREAD GROUP/);
  assert.doesNotMatch(brokenText, /CLOSING \(only\)|Close order shape/, 'a broken group is never told to close atomically');
  for (const group of [mk({ status: 'pending_entry', open_units: 0 }), mk({ open_units: 0 }), mk({ status: 'closed' }), mk({ status: 'void' }), mk({ open_units: undefined })]) {
    const text = openGroupCloseReminder([group]);
    assert.match(text, /TWO-LEG GROUP NOT SETTLED/);
    assert.doesNotMatch(text, /CLOSING \(only\)/);
  }
  const mixed = openGroupCloseReminder([mk(), mk({ group_id: 'h', status: 'pending_entry', open_units: 0 })]);
  assert.match(mixed, /OPEN SPREAD GROUP: this sandbox holds 1 open two-leg group/);
  assert.match(mixed, /not yet settled/);
  assert.equal(openGroupCloseReminder([]), '');
  const h = new AgentHarness({ sandboxId: 'sbx_x', getOptionGroups: async () => ({ groups: [mk({ status: 'void' }), mk({ status: 'closed' })] }) });
  assert.equal(await h._openGroupReminder({ allowOptions: true, allowedStructures: ['long_call'] }), '', 'terminal records never reach the note');
  const h2 = new AgentHarness({ sandboxId: 'sbx_x', getOptionGroups: async () => ({ groups: [mk({ status: 'pending_entry', open_units: 0 })] }) });
  assert.match(await h2._openGroupReminder({ allowOptions: true, allowedStructures: ['long_call'] }), /NOT SETTLED/);
});

// ── N1: no stranded options on a switch to an agent without options ──────────────────────────────────────────────────
test('optionExposureReason: held positions, open option orders, live groups and unreadable state all refuse; a flat slot passes', () => {
  const flat = { positions: [], orders: [], ordersComplete: true, groups: { groups: [] } };
  assert.equal(optionExposureReason(flat), null);
  assert.equal(optionExposureReason({ ...flat, positions: { positions: [] } }), null);
  assert.match(optionExposureReason({ ...flat, positions: [{ symbol: 'AMZN261204C00265000' }] }), /1 option position/);
  assert.match(optionExposureReason({ ...flat, orders: [{ symbol: 'AMZN261204C00265000', status: 'new' }] }), /1 open option order/);
  assert.match(optionExposureReason({ ...flat, orders: [{ symbol: 'AMZN', asset_class: 'us_option', status: 'accepted' }] }), /open option order/);
  assert.equal(optionExposureReason({ ...flat, orders: [{ symbol: 'AMZN261204C00265000', status: 'filled' }, { symbol: 'SPY', status: 'new' }] }), null);
  assert.match(optionExposureReason({ ...flat, groups: { groups: [{ status: 'open' }] } }), /spread group/);
  assert.equal(optionExposureReason({ ...flat, groups: { groups: [{ status: 'closed' }, { status: 'void' }] } }), null);
  assert.match(optionExposureReason({ ...flat, ordersComplete: false }), /could not be fully read/);
  assert.match(optionExposureReason({ ...flat, positions: undefined }), /could not be read/);
  assert.match(optionExposureReason({ ...flat, groups: undefined }), /could not be read/);
  assert.match(optionExposureReason({}), /could not be read/);
});

test('previewSwitchPermissionPatch is read-only and says when a switch would turn options off', async () => {
  await reset();
  const before = snapshot(L1);
  assert.deepEqual(store.previewSwitchPermissionPatch(L1, 'macro-rotation'), { allowOptions: false });
  assert.deepEqual(store.previewSwitchPermissionPatch(L1, 'trend-follower'), { allowOptions: false });
  assert.equal(store.previewSwitchPermissionPatch(L1, 'catalyst'), null, 'the same agent changes nothing');
  assert.equal(store.previewSwitchPermissionPatch(L1, 'default'), null);
  assert.deepEqual(store.previewSwitchPermissionPatch(L1, 'mean-reversion'), { allowOptions: true, allowedStructures: ['long_call', 'bull_call_debit'] });
  assert.deepEqual(store.previewSwitchPermissionPatch(L1, 'macro-rotation', { strategyId: 'default' }), null, 'an explicit options strategy keeps options on');
  assert.throws(() => store.previewSwitchPermissionPatch(L1, 'macro-rotation', { strategyId: 'nope' }), /Unknown strategy/);
  assert.deepEqual(snapshot(L1), before);
});

// ── Round 2 (Hermes FQ-01..04) ───────────────────────────────────────────────────────────────────────────────────────
const goOrder = (overrides = {}) => ({ ID: 'o1', ClientOrderID: 'c1', Symbol: 'AAPL261218C00200000', Qty: 1, Side: 'buy', Type: 'limit', Status: 'accepted', AssetClass: 'us_option', PositionIntent: 'buy_to_open', ...overrides });
const flatSlot = { positions: [], orders: [], ordersComplete: true, groups: { groups: [] } };

test('the guard reads the order fields exactly as Go serialises them (Symbol / AssetClass / Status, no JSON tags)', async () => {
  const goSource = await fs.readFile(new URL('../interfaces/trading.go', import.meta.url), 'utf8');
  const start = goSource.indexOf('type Order struct');
  const orderStruct = goSource.slice(start, goSource.indexOf('\n}', start));
  for (const field of ['Symbol', 'AssetClass', 'Status']) {
    const line = orderStruct.split(/\r?\n/).find(text => new RegExp(`^\\s+${field}\\s+string`).test(text));
    assert.ok(line, `Go Order still has ${field}`);
    assert.doesNotMatch(line, /`json:/, `Go Order.${field} has no JSON tag, so it is serialised as ${field}`);
  }
  assert.match(optionExposureReason({ ...flatSlot, orders: [goOrder()] }), /1 open option order/);
  assert.match(optionExposureReason({ ...flatSlot, orders: [goOrder({ Status: 'partially_filled' })] }), /open option order/);
  assert.match(optionExposureReason({ ...flatSlot, orders: [goOrder({ AssetClass: '', Symbol: 'AAPL261218C00200000' })] }), /open option order/, 'the OCC symbol alone is enough');
  assert.equal(optionExposureReason({ ...flatSlot, orders: [goOrder({ Status: 'filled' }), goOrder({ Status: 'canceled' }), goOrder({ Status: 'expired' }), goOrder({ Status: 'rejected' })] }), null);
  assert.equal(optionExposureReason({ ...flatSlot, orders: [goOrder({ Symbol: 'SPY', AssetClass: 'us_equity', Status: 'new' })] }), null, 'a working stock order is not option exposure');
  assert.match(optionExposureReason({ ...flatSlot, orders: [{ symbol: 'AAPL261218C00200000', asset_class: 'us_option', status: 'accepted' }] }), /open option order/, 'the lowercase shape still works');
});

test('runGuardedSwitch: a Go-shaped working option order refuses with 409 and nothing is saved; a flat slot saves once', async () => {
  const { runGuardedSwitch } = await import('../agent/switch-guard.js');
  const off = () => ({ allowOptions: false });
  const run = (extra, save) => runGuardedSwitch({ sandboxId: L1, activeAgentId: 'macro-rotation', overrides: {}, previewPatch: off, save, ...extra });
  let saved = 0;
  const save = async () => { saved++; return 'saved'; };
  await assert.rejects(run({ readExposure: async () => ({ ...flatSlot, orders: [goOrder()] }) }, save), error => error.status === 409 && /Switch refused/.test(error.message) && /open option order/.test(error.message));
  await assert.rejects(run({ readExposure: async () => ({ ...flatSlot, positions: [{ Symbol: 'AAPL261218C00200000', Qty: 1 }] }) }, save), error => error.status === 409);
  await assert.rejects(run({ readExposure: async () => ({ ...flatSlot, ordersComplete: false }) }, save), error => error.status === 409);
  await assert.rejects(run({ readExposure: async () => { throw new Error('backend down'); } }, save), error => error.status === 409 && /could not be read/.test(error.message));
  assert.equal(saved, 0, 'no refusal reached save');
  assert.equal(await run({ readExposure: async () => flatSlot }, save), 'saved');
  assert.equal(saved, 1);
  let reads = 0;
  assert.equal(await runGuardedSwitch({ sandboxId: L1, activeAgentId: 'mean-reversion', overrides: {}, previewPatch: () => ({ allowOptions: true, allowedStructures: ['long_call'] }), readExposure: async () => { reads++; return {}; }, save }), 'saved');
  assert.equal(reads, 0, 'a switch that keeps options on never reads the slot');
});

test('with the real store: a switch to Compass is refused (409, nothing saved) while a Go-shaped working option order exists', async () => {
  await reset();
  const { runGuardedSwitch } = await import('../agent/switch-guard.js');
  const before = snapshot(L1);
  const guarded = readExposure => runGuardedSwitch({ sandboxId: L1, activeAgentId: 'macro-rotation', overrides: {}, previewPatch: store.previewSwitchPermissionPatch, readExposure, save: () => store.updateSandboxAgentSelection(L1, { activeAgentId: 'macro-rotation' }) });
  await assert.rejects(guarded(async () => ({ ...flatSlot, orders: [goOrder()] })), error => error.status === 409);
  assert.deepEqual(snapshot(L1), before);
  await guarded(async () => flatSlot);
  assert.equal(store.getSandbox(L1).agent.activeAgentId, 'macro-rotation');
  assert.equal(store.getPermissionsForSandbox(L1).allowOptions, false);
});

test('both agent-switch routes go through runGuardedSwitch (the guard is the only way to save a switch)', async () => {
  const source = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  const sandboxRoute = source.slice(source.indexOf("app.put('/api/sandboxes/:id/agent',"), source.indexOf("app.put('/api/sandboxes/:id/agent/overrides'"));
  const activateRoute = source.slice(source.indexOf("app.post('/api/agents/:id/activate'"), source.indexOf('// Strategies'));
  for (const route of [sandboxRoute, activateRoute]) {
    assert.match(route, /runGuardedSwitch\(/);
    assert.match(route, /res\.status\(err\.status \|\| 400\)/);
  }
  assert.match(sandboxRoute, /save: \(\) => updateSandboxAgentSelection\(/);
  assert.match(activateRoute, /save: \(\) => setActiveAgent\(/);
  assert.equal(sandboxRoute.split('updateSandboxAgentSelection(').length - 1, 1, 'no unguarded save in the sandbox route');
  assert.equal(activateRoute.split('setActiveAgent(').length - 1, 1, 'no unguarded save in the activate route');
  assert.doesNotMatch(source, /assertSwitchKeepsOptionsManageable/);
});

test('FQ-02: a definition change clears only a slot copy of the OLD strategy; an intentional different slot strategy stays', async () => {
  await reset(state => {
    state.slots[L1].agent.activeAgentId = 'mean-reversion';
    state.slots[L1].agent.overrides = { ...state.slots[L1].agent.overrides, agentId: 'mean-reversion', strategyId: 'etf-mean-reversion', heartbeatOverrides: {} };
    state.slots[L2].agent.overrides = { ...state.slots[L2].agent.overrides, agentId: 'mean-reversion', strategyId: 'capital-preservation' };
  });
  assert.equal(store.getResolvedAgentForSandbox(L1).strategyId, 'etf-mean-reversion');
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'capital-preservation');
  await store.updateAgent('mean-reversion', { strategyId: 'default' });
  assert.equal(store.getResolvedAgentForSandbox(L1).strategyId, 'default', 'the copy of the old definition strategy is dropped, the new definition applies');
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'capital-preservation', 'the intentional override survives');
  await store.loadConfig();
  assert.equal(store.getResolvedAgentForSandbox(L1).strategyId, 'default');
  assert.equal(store.getResolvedAgentForSandbox(L2).strategyId, 'capital-preservation');
});

test('FQ-03: a broken group gets single-leg survivor guidance and never the atomic close envelope; intact and mixed lists are told apart', () => {
  const mk = overrides => ({ group_id: 'g', underlying: 'MSFT', structure: 'bull_call_debit', status: 'open', open_units: 2, entry_units: 2, entry_filled_units: 2, closed_units: 0, close_order_pending: false, ...overrides });
  const broken = openGroupCloseReminder([mk({ status: 'broken' })]);
  assert.match(broken, /BROKEN SPREAD GROUP \(MSFT bull_call_debit, 2 open units\)/);
  assert.match(broken, /the backend refuses a two-leg close of it/);
  assert.match(broken, /single legs under your own Strategy Rules/);
  assert.match(broken, /single-leg order and the matching close intent/);
  assert.match(broken, /never trade assigned stock yourself/);
  assert.match(broken, /No new spread is opened while a group is broken/);
  assert.doesNotMatch(broken, /CLOSING \(only\)|Close order shape|net credit per unit|OPEN SPREAD GROUP/);
  const intact = openGroupCloseReminder([mk()]);
  assert.match(intact, /OPEN SPREAD GROUP: this sandbox holds 1 open two-leg group \(MSFT bull_call_debit, 2 open units\)/);
  assert.match(intact, /Close order shape/);
  assert.doesNotMatch(intact, /BROKEN SPREAD GROUP/);
  const mixed = openGroupCloseReminder([mk(), mk({ group_id: 'b', underlying: 'AAPL', status: 'broken' }), mk({ group_id: 'p', status: 'pending_entry', open_units: 0, entry_filled_units: 0 })]);
  assert.equal(mixed.split('OPEN SPREAD GROUP: this sandbox holds 1 open two-leg group').length - 1, 1);
  assert.equal(mixed.split('BROKEN SPREAD GROUP (AAPL bull_call_debit').length - 1, 1);
  assert.match(mixed, /not yet settled/);
  assert.ok(mixed.indexOf('OPEN SPREAD GROUP') < mixed.indexOf('BROKEN SPREAD GROUP'), 'intact first');
});

test('FQ-04: a proven flat history row is not exposure (guard, note); pending, partial, unknown and broken rows still are', () => {
  const row = overrides => ({ group_id: 'g', status: 'open', entry_units: 2, entry_filled_units: 2, closed_units: 2, open_units: 0, close_order_pending: false, ...overrides });
  assert.equal(isFlatTerminalGroup(row()), true);
  assert.equal(optionExposureReason({ ...flatSlot, groups: { groups: [row()] } }), null);
  assert.equal(openGroupCloseReminder([row()]), '', 'a flat row produces no note at all');
  for (const bad of [{ close_order_pending: true }, { entry_filled_units: 1, closed_units: 1 }, { entry_filled_units: 0, closed_units: 0 }, { open_units: 1, closed_units: 1 }, { status: 'pending_entry' }, { status: 'broken' }, { entry_units: undefined }, { closed_units: undefined }, { close_order_pending: undefined }, { open_units: 'x' }]) {
    assert.equal(isFlatTerminalGroup(row(bad)), false, JSON.stringify(bad));
    assert.match(optionExposureReason({ ...flatSlot, groups: { groups: [row(bad)] } }), /spread group/, JSON.stringify(bad));
  }
  assert.match(optionExposureReason({ ...flatSlot, groups: { groups: [row(), row({ group_id: 'h', close_order_pending: true })] } }), /1 two-leg spread group/);
});
