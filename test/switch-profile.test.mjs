import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';

// Switch-profile backend (plan v2): strict partial schema, preview and review token, shared guarded transition, profile-only re-apply,
// path fixes, auth wiring, gate and unchanged-settings guarantees. Real config store and guidance store on a temporary folder.
// Crash recovery and compensation live in slot-transition-recovery.test.mjs.

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-switch-profile-'));
const cfgDir = path.join(tempDir, 'cfg');
const dataDir = path.join(tempDir, 'data');
const configPath = path.join(cfgDir, 'agent-config.json');
process.env.OPENPROPHET_CONFIG_PATH = configPath;
process.env.OPENPROPHET_DATA_DIR = dataDir;
process.env.OPENPROPHET_EXECUTION_MODE = 'inert';

const store = await import('../agent/config-store.js');
const guidance = await import('../agent/trading-guidance.js');
const review = await import('../agent/slot-review.js');
const { slotGate } = await import('../agent/slot-gate.js');
const { faults } = await import('../agent/slot-transition.js');
const { runGuardedSwitch } = await import('../agent/switch-guard.js');
const { canonicalizeSlotProfile, profileDriftItems, profileDriftWarning, profileOfStrategy } = await import('../agent/slot-profile.js');
const { AgentHarness } = await import('../agent/harness.js');
const { redactSecrets } = await import('../agent/redaction.js');

const A = 'sbx_a';
const B = 'sbx_b';
const MR_PROFILE = { tradingGuidance: { contractDeltaMin: 0.5, contractDeltaMax: 0.65, expiryMinDays: 90, expiryMaxDays: 150, extraSymbolsPerScan: 0, marketSymbol: 'SPY' }, heartbeat: { market_open: 600, midday: 1800, market_close: 600 } };
const SLOT_GUIDANCE = { contractDeltaMin: 0.5, contractDeltaMax: 0.7, expiryMinDays: 21, expiryMaxDays: 45, extraSymbolsPerScan: 25, maxOptionSpreadPct: 8 };
const FLAT = { positions: [], orders: [], ordersComplete: true, groups: { groups: [] } };
const clone = value => JSON.parse(JSON.stringify(value));
const read = async file => fs.readFile(file, 'utf8').catch(() => null);
const guidanceFile = () => path.join(dataDir, 'trading-guidance.json');
const pendingFile = () => path.join(dataDir, 'slot-transition-pending.json');

async function reset() {
  for (const key of Object.keys(faults)) delete faults[key];
  slotGate.reset();
  await fs.rm(tempDir + '/cfg', { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    accounts: [{ id: 'acc1', name: 'L1', paper: true }, { id: 'acc2', name: 'L2', paper: true }],
    activeAccountId: 'acc1', activeSandboxId: A,
    sandboxes: {
      [A]: { id: A, name: 'L1', accountId: 'acc1', agent: { activeAgentId: 'default' } },
      [B]: { id: B, name: 'L2', accountId: 'acc2', agent: { activeAgentId: 'default' } },
    },
  }, null, 2));
  await store.loadConfig();
  guidance.resetTradingGuidanceStoreForTests();
  await guidance.setTradingGuidanceForSandbox(A, SLOT_GUIDANCE);
  await guidance.setTradingGuidanceForSandbox(B, { ...SLOT_GUIDANCE, contractDeltaMin: 0.45 });
  await store.updateStrategy('etf-mean-reversion', { slotProfile: MR_PROFILE });
  await store.updateStrategy('catalyst-news', { slotProfile: { tradingGuidance: { catalystRangeMinutes: 20 } } });
  store.consumeAgentSwitch(A); store.consumeAgentSwitch(B);
}

/** What the PUT /api/sandboxes/:id/agent route does, with the same functions, minus express. */
async function routeSwitch(sid, agentId, { strategyId, token, exposure = FLAT, runtime = [], readExposure } = {}) {
  const ticket = review.acquireSlotOrRefuse(sid, 'switch');
  try {
    const rev = review.buildSlotReview({ kind: 'switch', sandboxId: sid, activeAgentId: agentId, strategyId });
    const transition = review.createTransition({ kind: 'switch', sandboxId: sid, activeAgentId: agentId, strategyId, reviewToken: token === undefined ? rev.preview.reviewToken : token, opId: ticket.opId });
    transition.verify();
    const updates = { activeAgentId: agentId, ...(strategyId !== undefined ? { overrides: { strategyId } } : {}) };
    const sandbox = await runGuardedSwitch({ sandboxId: sid, activeAgentId: agentId, overrides: updates.overrides || {}, previewPatch: store.previewSwitchPermissionPatch, readExposure: readExposure || (async () => exposure), save: () => store.updateSandboxAgentSelection(sid, updates, transition) });
    const failure = await review.finishCommittedRuntime(sid, runtime);
    return { sandbox, transition, failure, body: failure ? failure.body : review.successBody(transition) };
  } finally { ticket.release(); }
}
const expectRefusal = async (promise, status) => assert.rejects(promise, error => { assert.equal(error.status, status, error.message); return true; });
const slotSnapshot = sid => clone({ agent: store.getSandbox(sid).agent, permissions: store.getSandbox(sid).permissions, heartbeat: store.getSandbox(sid).heartbeat, guidance: guidance.getTradingGuidanceForSandbox(sid), alias: [store.getConfig().activeAgentId, store.getConfig().heartbeat, store.getConfig().permissions] });

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  for (const key of ['OPENPROPHET_CONFIG_PATH', 'OPENPROPHET_DATA_DIR', 'OPENPROPHET_EXECUTION_MODE']) delete process.env[key];
});

// ── v2 case 6: schema ───────────────────────────────────────────────────────────────────────────────────────────────
test('schema: unknown and forbidden keys are refused (every forbidden class), at the top, guidance and heartbeat levels', async () => {
  await reset();
  const bad = [
    { foo: 1 }, { permissions: { allowOptions: true } }, { risk: {} }, { model: 'x' }, { prompt: 'x' }, { strategyId: 'x' }, { plugins: {} }, { credentials: {} },
    { tradingGuidance: { maxOptionSpreadPct: 5 } }, { tradingGuidance: { dailyAlphaDeskCheck: true } }, { tradingGuidance: { assessmentDteMin: 1 } },
    { tradingGuidance: { longGapSingleLegCapPct: 10 } }, { tradingGuidance: { mode: 'x' } }, { tradingGuidance: { unknownKey: 1 } },
    { heartbeat: { mode: 'market_aware' } }, { heartbeat: { forceHeartbeatIntervals: true } }, { heartbeat: { pre_market: 600 } }, { heartbeat: { after_hours: 600 } },
    { heartbeat: { accountId: 'x' } }, { heartbeat: { apiKey: 'x' } },
  ];
  for (const profile of bad) {
    assert.throws(() => canonicalizeSlotProfile(profile), /slotProfile/, JSON.stringify(profile));
    await assert.rejects(store.updateStrategy('etf-mean-reversion', { slotProfile: profile }), /slotProfile/);
  }
  assert.deepEqual(store.getStrategyById('etf-mean-reversion').slotProfile, MR_PROFILE, 'a refused save changes nothing');
});

test('schema: null, arrays and wrong container shapes are refused; an empty profile is no profile', async () => {
  await reset();
  for (const profile of [[], 'x', 5, true, { tradingGuidance: null }, { tradingGuidance: [] }, { tradingGuidance: 'x' }, { heartbeat: null }, { heartbeat: [] }, { heartbeat: 5 }]) {
    assert.throws(() => canonicalizeSlotProfile(profile), /slotProfile/, JSON.stringify(profile));
  }
  assert.equal(canonicalizeSlotProfile(null), null);
  assert.equal(canonicalizeSlotProfile({}), null);
  assert.equal(canonicalizeSlotProfile({ tradingGuidance: {}, heartbeat: {} }), null);
  assert.deepEqual(canonicalizeSlotProfile({ tradingGuidance: {}, heartbeat: { midday: 900 } }), { heartbeat: { midday: 900 } });
});

test('schema: value ranges, types and bounds (zero is real, equal delta refused, equal expiry accepted, blank refused)', async () => {
  assert.deepEqual(canonicalizeSlotProfile({ tradingGuidance: { extraSymbolsPerScan: 0 } }), { tradingGuidance: { extraSymbolsPerScan: 0 } });
  assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { contractDeltaMin: 0.6, contractDeltaMax: 0.6 } }), /lower than/);
  assert.doesNotThrow(() => canonicalizeSlotProfile({ tradingGuidance: { expiryMinDays: 60, expiryMaxDays: 60 } }));
  assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { expiryMinDays: 90, expiryMaxDays: 60 } }), /must not exceed/);
  for (const value of [2, 0.01, '', null, NaN, true, {}]) assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { contractDeltaMin: value } }), /slotProfile/, String(value));
  assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { expiryMinDays: 20.5 } }), /whole number/);
  assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { marketSymbol: 5 } }), /ticker/);
  assert.throws(() => canonicalizeSlotProfile({ tradingGuidance: { marketSymbol: '' } }), /ticker/);
  for (const value of [29, 14401, 600.5, '600', null]) assert.throws(() => canonicalizeSlotProfile({ heartbeat: { midday: value } }), /30 to 14400/, String(value));
});

test('schema: only supplied keys are stored; round trip and restart inject no defaults; null removes the profile', async () => {
  await reset();
  const partial = { tradingGuidance: { expiryMinDays: 90 } };
  await store.updateStrategy('long-horizon-trend', { slotProfile: { ...partial, tradingGuidance: { expiryMinDays: '90' } } });
  assert.deepEqual(store.getStrategyById('long-horizon-trend').slotProfile, partial, 'numeric text is stored as a number, nothing else is added');
  const saved = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.deepEqual(saved.strategies.find(s => s.id === 'long-horizon-trend').slotProfile, partial);
  await store.loadConfig();
  assert.deepEqual(store.getStrategyById('long-horizon-trend').slotProfile, partial);
  await store.updateStrategy('long-horizon-trend', { slotProfile: null });
  assert.equal('slotProfile' in store.getStrategyById('long-horizon-trend'), false);
  await store.updateStrategy('long-horizon-trend', { slotProfile: { heartbeat: { midday: 900 } } });
  await store.updateStrategy('long-horizon-trend', { slotProfile: {} });
  assert.equal('slotProfile' in store.getStrategyById('long-horizon-trend'), false, 'an empty profile removes it');
  const created = await store.addStrategy({ name: 'custom', slotProfile: { heartbeat: { midday: 900 } } });
  assert.deepEqual(created.slotProfile, { heartbeat: { midday: 900 } });
  await assert.rejects(store.addStrategy({ name: 'bad', slotProfile: { foo: 1 } }), /slotProfile/);
  assert.equal((await store.addStrategy({ name: 'plain' })).slotProfile, undefined);
});

test('GET /api/config view (redactSecrets) returns strategies[].slotProfile as stored', async () => {
  await reset();
  const view = redactSecrets(store.getConfig());
  assert.deepEqual(view.strategies.find(s => s.id === 'etf-mean-reversion').slotProfile, MR_PROFILE);
});

// ── v2 case 6/9 and v1: what a switch applies ───────────────────────────────────────────────────────────────────────
test('a switch applies the profile: guidance subset, heartbeat intervals plus mode and lock; other keys, Risk and cap are untouched', async () => {
  await reset();
  const before = slotSnapshot(A);
  const { body, sandbox } = await routeSwitch(A, 'mean-reversion');
  assert.equal(body.ok, true); assert.equal(body.committed, true); assert.equal(body.ready, true);
  const g = guidance.getTradingGuidanceForSandbox(A);
  for (const [key, value] of Object.entries(MR_PROFILE.tradingGuidance)) assert.equal(g[key], value, key);
  assert.equal(g.extraSymbolsPerScan, 0, 'an explicit zero is a real value');
  for (const key of Object.keys(g)) if (!(key in MR_PROFILE.tradingGuidance)) assert.equal(g[key], before.guidance[key], `${key} untouched`);
  assert.equal(g.maxOptionSpreadPct, 8, 'the spread cap is never written by a switch');
  assert.deepEqual({ ...store.getSandbox(A).heartbeat }, { ...before.heartbeat, market_open: 600, midday: 1800, market_close: 600, mode: 'market_aware', forceHeartbeatIntervals: true });
  assert.deepEqual(store.getConfig().heartbeat, store.getSandbox(A).heartbeat, 'aliases follow');
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'mean-reversion');
  // permissions: only the fit keys change, everything else (Risk) is identical
  const permBefore = before.permissions, permAfter = store.getSandbox(A).permissions;
  for (const key of Object.keys(permBefore)) if (!['allowOptions', 'allowedStructures'].includes(key)) assert.deepEqual(permAfter[key], permBefore[key], key);
  assert.equal(sandbox.lastTransitionOpId.length > 8, true);
  assert.equal(body.applied.tradingGuidance.some(item => item.key === 'expiryMinDays' && item.before === 21 && item.after === 90), true);
  assert.equal(body.applied.heartbeat.after.mode, 'market_aware');
  assert.deepEqual(body.warnings, []);
  const receipt = store.consumeAgentSwitch(A);
  assert.equal(receipt.to, 'mean-reversion'); assert.equal(receipt.before.tradingGuidance.expiryMinDays, 21); assert.equal(receipt.after.tradingGuidance.expiryMinDays, 90);
  // disk: both stores carry the new pair and no pending record is left
  assert.equal(JSON.parse(await fs.readFile(guidanceFile(), 'utf8')).sandboxes[A].expiryMinDays, 90);
  assert.equal(await read(pendingFile()), null);
  assert.equal(guidance.getTradingGuidanceForSandbox(B).contractDeltaMin, 0.45, 'no profile leaks to another slot');
  assert.equal(store.getSandbox(B).agent.activeAgentId, 'default');
});

test('guidance-only profile leaves the heartbeat object, mode and lock untouched', async () => {
  await reset();
  await store.updateHeartbeatForSandbox(A, { midday: 1234 });
  const heartbeatBefore = clone(store.getSandbox(A).heartbeat);
  await routeSwitch(A, 'catalyst');
  assert.equal(guidance.getTradingGuidanceForSandbox(A).catalystRangeMinutes, 20);
  assert.deepEqual(store.getSandbox(A).heartbeat, heartbeatBefore);
  assert.equal('mode' in store.getSandbox(A).heartbeat, false);
});

test('heartbeat-only profile keeps omitted intervals and validates the final three', async () => {
  await reset();
  await store.updateStrategy('catalyst-news', { slotProfile: { heartbeat: { midday: 900 } } });
  await store.updateHeartbeatForSandbox(A, { market_open: 450 });
  await routeSwitch(A, 'catalyst');
  const hb = store.getSandbox(A).heartbeat;
  assert.equal(hb.midday, 900); assert.equal(hb.market_open, 450); assert.equal(hb.mode, 'market_aware'); assert.equal(hb.forceHeartbeatIntervals, true);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).catalystRangeMinutes, 30, 'guidance untouched');
  // an omitted interval that is invalid on the slot is refused
  await reset();
  await store.updateStrategy('catalyst-news', { slotProfile: { heartbeat: { midday: 900 } } });
  await store.updateHeartbeatForSandbox(A, { market_close: 10 });
  const before = slotSnapshot(A);
  await expectRefusal(routeSwitch(A, 'catalyst'), 400);
  assert.deepEqual(slotSnapshot(A), before);
});

test('a partial bound that conflicts with the slot is refused with the reason and nothing is saved', async () => {
  await reset();
  await store.updateStrategy('catalyst-news', { slotProfile: { tradingGuidance: { contractDeltaMin: 0.8 } } });
  const before = slotSnapshot(A);
  const preview = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'catalyst' }).preview;
  assert.match(preview.errors.join(' '), /conflicts with this slot.*contractDeltaMin must be lower than contractDeltaMax/);
  await assert.rejects(routeSwitch(A, 'catalyst'), error => error.status === 400 && /conflicts/.test(error.message));
  assert.deepEqual(slotSnapshot(A), before);
  assert.equal(await read(pendingFile()), null);
});

test('an unprofiled agent keeps the slot settings and the preview and response say it is not guaranteed ready', async () => {
  await reset();
  const preview = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'momentum' }).preview;
  assert.equal(preview.hasProfile, false);
  assert.match(preview.warnings.join(' '), /no slot profile.*not guaranteed ready/);
  const before = slotSnapshot(A);
  const { body } = await routeSwitch(A, 'momentum');
  assert.match(body.warnings.join(' '), /not guaranteed ready/);
  const after = slotSnapshot(A);
  assert.deepEqual(after.guidance, before.guidance); assert.deepEqual(after.heartbeat, before.heartbeat);
  assert.equal(after.agent.activeAgentId, 'momentum');
});

test('a missing strategy gives no fabricated profile: an unknown explicit strategy is refused, a deleted agent strategy warns', async () => {
  await reset();
  const before = slotSnapshot(A);
  const preview = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion', strategyId: 'nope' }).preview;
  assert.match(preview.errors.join(' '), /Unknown strategy: nope/);
  await expectRefusal(routeSwitch(A, 'mean-reversion', { strategyId: 'nope' }), 400);
  assert.deepEqual(slotSnapshot(A), before);
  await store.removeStrategy('catalyst-news');
  const gone = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'catalyst' }).preview;
  assert.equal(gone.hasProfile, false);
  assert.match(gone.warnings.join(' '), /was not found/);
});

test('an explicit different strategy on the switch uses ITS profile', async () => {
  await reset();
  await routeSwitch(A, 'momentum', { strategyId: 'etf-mean-reversion' });
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  assert.equal(store.getResolvedAgentForSandbox(A).strategyId, 'etf-mean-reversion');
});

// ── v2 case 8: preview, token, re-apply ─────────────────────────────────────────────────────────────────────────────
test('preview shape: kind, ids, hasProfile, changes (permissions, guidance list, heartbeat before/after incl. mode and lock), errors, warnings, exposure, token', async () => {
  await reset();
  const preview = await review.previewWithExposure(review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }), A, async () => FLAT);
  assert.deepEqual(Object.keys(preview).sort(), ['changes', 'currentAgentId', 'effectiveStrategyId', 'errors', 'exposure', 'hasProfile', 'kind', 'reviewToken', 'sandboxId', 'targetAgentId', 'warnings']);
  assert.equal(preview.kind, 'switch'); assert.equal(preview.sandboxId, A); assert.equal(preview.currentAgentId, 'default'); assert.equal(preview.targetAgentId, 'mean-reversion');
  assert.equal(preview.effectiveStrategyId, 'etf-mean-reversion'); assert.equal(preview.hasProfile, true);
  assert.deepEqual(Object.keys(preview.changes).sort(), ['heartbeat', 'permissions', 'tradingGuidance']);
  assert.deepEqual(preview.changes.tradingGuidance.find(c => c.key === 'contractDeltaMax'), { key: 'contractDeltaMax', before: 0.7, after: 0.65 });
  assert.equal(preview.changes.tradingGuidance.some(c => c.key === 'contractDeltaMin'), false, 'unchanged keys are not listed');
  assert.deepEqual(preview.changes.heartbeat.after, { market_open: 600, midday: 1800, market_close: 600, mode: 'market_aware', forceHeartbeatIntervals: true });
  assert.equal(preview.changes.heartbeat.before.mode, null); assert.equal(preview.changes.heartbeat.before.forceHeartbeatIntervals, false);
  assert.match(preview.reviewToken, /^[0-9a-f]{64}$/);
  assert.deepEqual(preview.exposure, { required: false, reason: null });
});

test('preview reports exposure from an existing backend only: held option -> error; no backend -> "unavailable"', async () => {
  await reset();
  const held = { positions: [{ symbol: 'SPY260101C00500000' }], orders: [], ordersComplete: true, groups: { groups: [] } };
  const p1 = await review.previewWithExposure(review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'macro-rotation' }), A, async () => held);
  assert.equal(p1.exposure.required, true); assert.match(p1.errors.join(' '), /holds 1 option position/);
  const p2 = await review.previewWithExposure(review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'macro-rotation' }), A, async () => null);
  assert.equal(p2.exposure, 'unavailable');
  const p3 = await review.previewWithExposure(review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'macro-rotation' }), A, async () => { throw new Error('down'); });
  assert.equal(p3.exposure, 'unavailable');
});

test('a stale or missing review token is refused with 409 + a fresh preview and nothing is written (every kind of edit)', async () => {
  const edits = {
    'slot guidance edit': () => guidance.setTradingGuidanceForSandbox(A, { extendedPct: 5 }),
    'heartbeat edit': () => store.updateHeartbeatForSandbox(A, { midday: 777 }),
    'profile edit': () => store.updateStrategy('etf-mean-reversion', { slotProfile: { tradingGuidance: { expiryMinDays: 80 } } }),
    'permission edit': () => store.updatePermissionsForSandbox(A, { requireConfirmation: true }),
    'other switch': () => store.updateSandboxAgentSelection(A, { activeAgentId: 'momentum' }),
    'agent strategy change': () => store.updateAgent('mean-reversion', { strategyId: 'catalyst-news' }),
  };
  for (const [label, edit] of Object.entries(edits)) {
    await reset();
    const token = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }).preview.reviewToken;
    await edit();
    const before = slotSnapshot(A);
    const guidanceBytes = await read(guidanceFile());
    await assert.rejects(routeSwitch(A, 'mean-reversion', { token }), error => {
      assert.equal(error.status, 409, label);
      assert.match(error.body.error, /changed since the preview/);
      assert.notEqual(error.body.preview.reviewToken, token);
      assert.equal(error.body.preview.kind, 'switch');
      return true;
    }, label);
    assert.deepEqual(slotSnapshot(A), before, label);
    assert.equal(await read(guidanceFile()), guidanceBytes, `${label}: guidance file byte-identical`);
    assert.equal(await read(pendingFile()), null);
  }
  await reset();
  await assert.rejects(routeSwitch(A, 'mean-reversion', { token: '' }), error => error.status === 409 && /review token is required/.test(error.body.error) && Boolean(error.body.preview.reviewToken));
});

test('stale token after a slot strategy override edit (re-apply) is refused', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  const token = review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.reviewToken;
  await store.updateSandboxAgentOverrides(A, { strategyId: 'catalyst-news' });
  const ticket = review.acquireSlotOrRefuse(A, 'reapply');
  const transition = review.createTransition({ kind: 'reapply', sandboxId: A, reviewToken: token, opId: ticket.opId });
  assert.throws(() => transition.verify(), error => error.status === 409 && error.body.preview.effectiveStrategyId === 'catalyst-news');
  ticket.release();
});

test('profile-only re-apply: guidance and heartbeat for the current agent, never permissions or agent; token includes the agent', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  await guidance.setTradingGuidanceForSandbox(A, { expiryMinDays: 30, extendedPct: 6 });
  await store.updateHeartbeatForSandbox(A, { midday: 999 });
  await store.updatePermissionsForSandbox(A, { maxOrderValue: 4321 });
  const permBefore = clone(store.getSandbox(A).permissions);
  store.consumeAgentSwitch(A);
  const drift = profileDriftItems(profileOfStrategy(store.getStrategyById('etf-mean-reversion')), { slotGuidance: guidance.getTradingGuidanceForSandbox(A), slotHeartbeat: store.getSandbox(A).heartbeat });
  assert.deepEqual(drift.map(d => d.key).sort(), ['expiryMinDays', 'midday']);
  const preview = review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview;
  assert.equal(preview.changes.permissions, null);
  const ticket = review.acquireSlotOrRefuse(A, 'reapply');
  const transition = review.createTransition({ kind: 'reapply', sandboxId: A, reviewToken: preview.reviewToken, opId: ticket.opId });
  transition.verify();
  await store.applySlotProfileToSandbox(A, transition);
  ticket.release();
  const g = guidance.getTradingGuidanceForSandbox(A);
  assert.equal(g.expiryMinDays, 90); assert.equal(g.extendedPct, 6, 'a key outside the profile keeps the operator edit');
  assert.equal(store.getSandbox(A).heartbeat.midday, 1800);
  assert.deepEqual(store.getSandbox(A).permissions, permBefore);
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'mean-reversion');
  assert.equal(store.consumeAgentSwitch(A), null, 're-apply leaves no switch receipt, so no backend restart');
  // prepared for one agent, refused after the slot moved to another
  const stale = review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.reviewToken;
  await store.updateSandboxAgentSelection(A, { activeAgentId: 'catalyst' });
  const t2 = review.acquireSlotOrRefuse(A, 'reapply');
  assert.throws(() => review.createTransition({ kind: 'reapply', sandboxId: A, reviewToken: stale, opId: t2.opId }).verify(), error => error.status === 409);
  t2.release();
  // no profile -> nothing to apply
  await store.updateSandboxAgentSelection(A, { activeAgentId: 'momentum' });
  assert.match(review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.errors.join(' '), /no slot profile/);
});

test('re-apply refuses to run while the slot is already inside a transition', async () => {
  await reset();
  const held = review.acquireSlotOrRefuse(A, 'switch');
  assert.throws(() => review.acquireSlotOrRefuse(A, 'reapply'), error => error.status === 409 && error.body.error === 'slot settings transition in progress');
  held.release();
  review.acquireSlotOrRefuse(A, 'reapply').release();
});

// ── routes through express (API shape, auth, read-only preview) ─────────────────────────────────────────────────────
async function withApp(deps, fn) {
  const app = express();
  app.use(express.json());
  review.registerSlotProfileRoutes(app, { operatorAuth: (req, res, next) => next(), sameOrigin: (req, res, next) => next(), isBusy: () => false, readExposureExisting: async () => null, refresh: async () => {}, afterChange: () => {}, ...deps });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(base); } finally { await new Promise(resolve => server.close(resolve)); }
}
const json = async response => ({ status: response.status, body: await response.json() });

test('GET switch-preview over HTTP is read-only (files byte-identical, no pending record), reports exposure unavailable with no backend', async () => {
  await reset();
  const filesBefore = [await read(configPath), await read(guidanceFile()), await read(pendingFile())];
  await withApp({}, async base => {
    const { status, body } = await json(await fetch(`${base}/api/sandboxes/${A}/agent/switch-preview?activeAgentId=macro-rotation&kind=switch`));
    assert.equal(status, 200); assert.equal(body.exposure, 'unavailable'); assert.equal(body.targetAgentId, 'macro-rotation');
    const reapply = await json(await fetch(`${base}/api/sandboxes/${A}/agent/switch-preview?kind=reapply`));
    assert.equal(reapply.status, 200); assert.equal(reapply.body.kind, 'reapply');
    assert.equal((await fetch(`${base}/api/sandboxes/nope/agent/switch-preview?activeAgentId=default`)).status, 404);
    assert.equal((await fetch(`${base}/api/sandboxes/${A}/agent/switch-preview?activeAgentId=ghost`)).status, 404);
    assert.equal((await fetch(`${base}/api/sandboxes/${A}/agent/switch-preview?activeAgentId=default&kind=weird`)).status, 400);
  });
  assert.deepEqual([await read(configPath), await read(guidanceFile()), await read(pendingFile())], filesBefore);
});

test('POST apply-profile over HTTP: success shape, stale 409 with preview, busy 409, refresh failure -> committed-not-ready, auth gate', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  await guidance.setTradingGuidanceForSandbox(A, { expiryMinDays: 30 });
  const post = (base, body) => fetch(`${base}/api/sandboxes/${A}/agent/apply-profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(json);
  const tokenNow = () => review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.reviewToken;
  // auth: a non-operator (token-only) caller is refused before anything happens
  await withApp({ operatorAuth: (req, res) => res.status(403).json({ error: 'operator authorization is required' }) }, async base => {
    const denied = await post(base, { reviewToken: tokenNow() });
    assert.equal(denied.status, 403);
    assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 30);
  });
  await withApp({ isBusy: () => true }, async base => {
    const busy = await post(base, { reviewToken: tokenNow() });
    assert.equal(busy.status, 409); assert.match(busy.body.error, /Wait for the active agent turn/);
    assert.equal(slotGate.held(A), null, 'the hold is released');
  });
  await withApp({}, async base => {
    const stale = await post(base, { reviewToken: 'f'.repeat(64) });
    assert.equal(stale.status, 409); assert.equal(stale.body.preview.kind, 'reapply'); assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 30);
    assert.equal((await post(base, {})).status, 409);
    const ok = await post(base, { reviewToken: tokenNow() });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true); assert.equal(ok.body.committed, true); assert.equal(ok.body.ready, true);
    assert.deepEqual(Object.keys(ok.body.applied).sort(), ['heartbeat', 'permissions', 'tradingGuidance']);
    assert.equal(ok.body.applied.permissions, null);
    assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  });
  await guidance.setTradingGuidanceForSandbox(A, { expiryMinDays: 30 });
  await withApp({ refresh: async () => { throw new Error('reload failed'); } }, async base => {
    const failed = await post(base, { reviewToken: tokenNow() });
    assert.equal(failed.status, 500);
    assert.equal(failed.body.ok, false); assert.equal(failed.body.committed, true); assert.equal(failed.body.ready, false); assert.match(failed.body.error, /has not restarted/);
    assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90, 'the settings did commit');
    assert.ok(slotGate.beatBlock(A), 'beats stay refused');
  });
});

// ── paths (v2 case 7) ───────────────────────────────────────────────────────────────────────────────────────────────
test('assigned-agent delete is refused (409) with no silent fallback to default; an unassigned agent can be removed', async () => {
  await reset();
  await routeSwitch(A, 'momentum');
  await assert.rejects(store.removeAgent('momentum'), error => error.status === 409 && /switch the slot first/.test(error.message) && /L1/.test(error.message));
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'momentum');
  assert.ok(store.getAgentById('momentum'));
  const agent = await store.addAgent({ name: 'temp' });
  await store.removeAgent(agent.id);
  assert.equal(store.getAgentById(agent.id), null);
});

test('strategy override set/clear and an agent-definition strategy change keep the slot settings and show drift', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  const settings = () => clone({ g: guidance.getTradingGuidanceForSandbox(A), h: store.getSandbox(A).heartbeat, p: store.getSandbox(A).permissions });
  const before = settings();
  await store.updateSandboxAgentOverrides(A, { strategyId: 'catalyst-news' });
  assert.deepEqual(settings(), before, 'override set');
  let drift = profileDriftItems(profileOfStrategy(store.getStrategyById(store.getResolvedAgentForSandbox(A).strategyId)), { slotGuidance: guidance.getTradingGuidanceForSandbox(A), slotHeartbeat: store.getSandbox(A).heartbeat });
  assert.ok(drift.some(item => item.key === 'catalystRangeMinutes'));
  await store.updateSandboxAgentOverrides(A, { strategyId: null });
  assert.deepEqual(settings(), before, 'override cleared');
  await store.updateAgent('mean-reversion', { strategyId: 'catalyst-news' });
  assert.deepEqual(settings(), before, 'agent definition strategy change');
  drift = profileDriftItems(profileOfStrategy(store.getStrategyById(store.getResolvedAgentForSandbox(A).strategyId)), { slotGuidance: guidance.getTradingGuidanceForSandbox(A), slotHeartbeat: store.getSandbox(A).heartbeat });
  assert.ok(drift.length > 0);
});

test('a same-agent model update is saved as before and applies no profile', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  const before = clone({ g: guidance.getTradingGuidanceForSandbox(A), h: store.getSandbox(A).heartbeat });
  await guidance.setTradingGuidanceForSandbox(A, { expiryMinDays: 33 });
  await store.updateSandboxAgentSelection(A, { activeAgentId: 'mean-reversion', model: 'anthropic/claude-opus-4-1' });
  assert.equal(store.getSandbox(A).agent.model, 'anthropic/claude-opus-4-1');
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 33, 'the operator edit survives');
  assert.deepEqual(store.getSandbox(A).heartbeat, before.h);
  await assert.rejects(store.updateSandboxAgentSelection(A, { activeAgentId: 'mean-reversion' }, { plan() {}, opId: 'x' }), /only for an agent change/);
});

test('legacy activation pins the slot resolved at entry: an account activation during the request does not retarget it', async () => {
  await reset();
  const pinned = A;
  await store.setActiveSandbox(B); // "account activation" while the request is in flight
  const ticket = review.acquireSlotOrRefuse(pinned, 'switch');
  const rev = review.buildSlotReview({ kind: 'switch', sandboxId: pinned, activeAgentId: 'mean-reversion' });
  const transition = review.createTransition({ kind: 'switch', sandboxId: pinned, activeAgentId: 'mean-reversion', reviewToken: rev.preview.reviewToken, opId: ticket.opId });
  await store.setActiveAgent('mean-reversion', { sandboxId: pinned, transition });
  ticket.release();
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'mean-reversion');
  assert.equal(store.getSandbox(B).agent.activeAgentId, 'default');
  assert.equal(guidance.getTradingGuidanceForSandbox(B).contractDeltaMin, 0.45);
  assert.equal(store.getConfig().activeSandboxId, B);
  assert.equal(store.getConfig().activeAgentId, 'default', 'aliases still follow the active slot only');
});

test('route wiring (source): both activation routes use the shared operation and operator auth; builder uses the sandbox PUT', async () => {
  const source = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  const put = source.slice(source.indexOf("app.put('/api/sandboxes/:id/agent',"), source.indexOf("app.put('/api/sandboxes/:id/agent/overrides'"));
  const activate = source.slice(source.indexOf("app.post('/api/agents/:id/activate'"), source.indexOf('// Strategies'));
  for (const route of [put, activate]) {
    assert.match(route, /acquireSlotOrRefuse\(/); assert.match(route, /createTransition\(/); assert.match(route, /transition\.verify\(\)/);
    assert.match(route, /finishCommittedRuntime\(/); assert.match(route, /ticket\?\.release\(\)/);
  }
  assert.match(put, /protectChatGPTModelChange, requireOperatorForAgentChange,/);
  assert.match(activate, /protectChatGPTModelChange, operatorOnly,/);
  assert.match(source, /function requireOperatorForAgentChange[\s\S]*operatorOnly\(req, res, next\)/);
  assert.match(source, /app\.post\('\/api\/strategies', requireOperatorForSlotProfile,/);
  assert.match(source, /app\.put\('\/api\/strategies\/:id', requireOperatorForSlotProfile,/);
  assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(req\.body, 'slotProfile'\)\) return operatorOnly/);
  assert.match(source, /registerSlotProfileRoutes\(app,/);
  assert.match(source, /transitionBlocked: slotGate\.blocked\(sandbox\.id\)/);
  assert.match(source, /await recoverPendingTransitions\(/);
  const reviewSource = await fs.readFile(new URL('../agent/slot-review.js', import.meta.url), 'utf8');
  assert.match(reviewSource, /app\.post\('\/api\/sandboxes\/:id\/agent\/apply-profile', deps\.operatorAuth, deps\.sameOrigin,/);
  for (const writer of ["app.put('/api/sandboxes/:id/agent/overrides', slotWriterGuard", "app.put('/api/sandboxes/:id/strategy-rules', slotWriterGuard", "app.put('/api/heartbeat', slotWriterGuard", "app.put('/api/trading-guidance', operatorAuthMiddleware, slotWriterGuard", "app.put('/api/heartbeat/market-mode', operatorAuthMiddleware, slotWriterGuard", "app.post('/api/heartbeat/apply-profile', slotWriterGuard"]) {
    assert.ok(source.includes(writer), writer);
  }
});

test('prompt-preview contract: the drift warning says "strategy settings" and a structured profileDrift is built', async () => {
  await reset();
  await routeSwitch(A, 'mean-reversion');
  await guidance.setTradingGuidanceForSandbox(A, { expiryMinDays: 33 });
  const items = profileDriftItems(profileOfStrategy(store.getStrategyById('etf-mean-reversion')), { slotGuidance: guidance.getTradingGuidanceForSandbox(A), slotHeartbeat: store.getSandbox(A).heartbeat });
  assert.deepEqual(items, [{ area: 'tradingGuidance', key: 'expiryMinDays', slot: 33, profile: 90 }]);
  assert.match(profileDriftWarning(items, 'Barometer'), /^Barometer's strategy settings differ from this slot: expiryMinDays is 33 \(strategy 90\)/);
  assert.equal(profileDriftWarning([], 'x'), null);
  const source = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  assert.match(source, /profileDrift: driftItems\.length \? \{ differs: true, items: driftItems \} : null/);
});

// ── v2 case 1: gate (deterministic pauses) ──────────────────────────────────────────────────────────────────────────
function latch() { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; }

function assertGated(label) {
  assert.ok(slotGate.beatBlock(A), `${label}: beats on the slot are deferred`);
  for (const kind of ['switch', 'reapply', 'write']) assert.throws(() => review.acquireSlotOrRefuse(A, kind), error => error.status === 409 && error.body.error === 'slot settings transition in progress', `${label}: ${kind}`);
  assert.equal(slotGate.beatBlock(B), null, `${label}: another slot is not gated`);
}

test('gate: at every awaited stage a beat, a second switch, a re-apply and guidance/heartbeat/override saves are refused; no mixed prompt can start', async () => {
  const stages = {
    'exposure read': (gate) => ({ readExposure: async () => { await gate.promise; return FLAT; } }),
    'after pending record': (gate) => { faults.afterPendingWrite = () => gate.promise; return {}; },
    'between guidance and config': (gate) => { faults.afterGuidancePublish = () => gate.promise; return {}; },
    'during restart/refresh': (gate) => ({ runtime: [() => gate.promise] }),
  };
  for (const [label, arm] of Object.entries(stages)) {
    await reset();
    const gate = latch();
    const options = arm(gate);
    const running = routeSwitch(A, label === 'exposure read' ? 'macro-rotation' : 'mean-reversion', options); // only an options-off switch reads exposure
    await new Promise(resolve => setTimeout(resolve, 60));
    assertGated(label);
    // a beat on a harness for this slot does not start (no mixed prompt): scheduled, ad hoc and start paths
    const h = new AgentHarness({ sandboxId: A });
    h.state.running = true;
    const logs = []; h.state.on?.('agent_log', entry => logs.push(entry.message));
    await h._beat();
    assert.equal(h._beating, false, label); assert.equal(h.state.beatCount, 0);
    assert.match(logs.join('\n'), /beat deferred: slot settings transition in progress/);
    await h._adHocBeat('hello');
    assert.equal(h._beating, false);
    await assert.rejects(h.sendMessage('hi'), /slot settings transition in progress/);
    // competing writers: the writer guard answers 409 while the transition holds the gate
    const guard = review.slotWriterGuard(() => A, async () => { statusSent = 'passed'; });
    let statusSent = null;
    await guard({}, { status(code) { statusSent = code; return { json() {} }; }, on() {} }, () => {});
    assert.equal(statusSent, 409, label);
    gate.release();
    const result = await running;
    assert.equal(result.body.ok, true, label);
    assert.equal(slotGate.held(A), null, `${label}: released at the end`);
    assert.equal(slotGate.beatBlock(A), null);
    // once released, a writer is admitted
    const ok = review.acquireSlotOrRefuse(A, 'write'); ok.release();
  }
});

test('gate: a writer in flight makes a switch wait out with 409 (no interleaving), and a hold never aborts a running beat', async () => {
  await reset();
  const writer = review.acquireSlotOrRefuse(A, 'write');
  assert.equal(slotGate.beatBlock(A), null, 'a plain settings save does not stop beats');
  await expectRefusal(routeSwitch(A, 'mean-reversion'), 409);
  writer.release();
  await routeSwitch(A, 'mean-reversion');
});

test('gate: hard blocked slot refuses beats and starts; notReady refuses beats but not a start; stop clears notReady', async () => {
  await reset();
  slotGate.block(A, 'needs recovery');
  const h = new AgentHarness({ sandboxId: A });
  await assert.rejects(h.start(), /Start refused: slot settings transition blocked: needs recovery/);
  assert.throws(() => review.acquireSlotOrRefuse(A, 'write'), error => /blocked/.test(error.body.error));
  slotGate.unblock(A);
  slotGate.markNotReady(A, 'x');
  assert.equal(slotGate.beatBlock(A).hard, false);
  await h.stop();
  assert.equal(slotGate.beatBlock(A), null, 'stopping the slot clears it');
});

test('cross-slot: concurrent guidance writes to two slots both survive (memory and disk)', async () => {
  await reset();
  await Promise.all([
    guidance.setTradingGuidanceForSandbox(A, { extendedPct: 7 }),
    guidance.setTradingGuidanceForSandbox(B, { nearSupportPct: 3.5 }),
    guidance.setTradingGuidanceForSandbox(A, { minEntryPct: 4 }),
  ]);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).extendedPct, 7);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).minEntryPct, 4);
  assert.equal(guidance.getTradingGuidanceForSandbox(B).nearSupportPct, 3.5);
  const disk = JSON.parse(await fs.readFile(guidanceFile(), 'utf8')).sandboxes;
  assert.equal(disk[A].extendedPct, 7); assert.equal(disk[A].minEntryPct, 4); assert.equal(disk[B].nearSupportPct, 3.5);
  // a switch on one slot racing a plain guidance save on the other keeps both
  await reset();
  const [, switched] = await Promise.all([guidance.setTradingGuidanceForSandbox(B, { extendedPct: 9 }), routeSwitch(A, 'mean-reversion')]);
  assert.equal(switched.body.ok, true);
  assert.equal(guidance.getTradingGuidanceForSandbox(B).extendedPct, 9);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  const disk2 = JSON.parse(await fs.readFile(guidanceFile(), 'utf8')).sandboxes;
  assert.equal(disk2[B].extendedPct, 9); assert.equal(disk2[A].expiryMinDays, 90);
});

test('exposure refusal still saves nothing and leaves no record', async () => {
  await reset();
  const before = slotSnapshot(A);
  const guidanceBytes = await read(guidanceFile());
  await expectRefusal(routeSwitch(A, 'macro-rotation', { exposure: { positions: [{ symbol: 'X' }], orders: [], ordersComplete: true, groups: { groups: [] } } }), 409);
  assert.deepEqual(slotSnapshot(A), before);
  assert.equal(await read(guidanceFile()), guidanceBytes);
  assert.equal(await read(pendingFile()), null);
  assert.equal(slotGate.held(A), null);
});

test('committed then runtime failure: committed-not-ready, gate kept, no automatic retry, stop clears it', async () => {
  await reset();
  let calls = 0;
  const { body, failure } = await routeSwitch(A, 'mean-reversion', { runtime: [async () => { calls += 1; throw new Error('backend would not start'); }] });
  assert.equal(failure.status, 500);
  assert.equal(body.ok, false); assert.equal(body.committed, true); assert.equal(body.ready, false); assert.match(body.error, /backend would not start/);
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'mean-reversion');
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  assert.equal(calls, 1);
  assert.equal(slotGate.held(A), null, 'the hold is released but beats stay refused');
  assert.match(slotGate.beatBlock(A).reason, /has not restarted/);
  await new AgentHarness({ sandboxId: A }).stop();
  assert.equal(slotGate.beatBlock(A), null);
});

// ── v1 cases 1, 6, 7, 11: rendered numbers, diff equals applied, drift clears, lifecycle ───────────────────────────────
test('lifecycle on one slot: each step renders its own numbers, the preview equals what is applied, and drift clears after a re-apply', async () => {
  await reset();
  const { renderTradingGuidance } = guidance;
  const prompt = () => renderTradingGuidance(guidance.getTradingGuidanceForSandbox(A), { strategyId: store.getResolvedAgentForSandbox(A).strategyId });
  assert.match(prompt(), /delta magnitude of about 0\.5 to 0\.7/);
  // Prophet(default) -> a profiled strategy
  const preview = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }).preview;
  const { body } = await routeSwitch(A, 'mean-reversion');
  assert.deepEqual(body.applied.tradingGuidance, preview.changes.tradingGuidance);
  assert.deepEqual(body.applied.heartbeat, preview.changes.heartbeat);
  assert.deepEqual(body.applied.permissions, preview.changes.permissions);
  assert.match(prompt(), /delta about 0\.5 to 0\.65, expiring 90 to 150 calendar days/);
  // -> guidance-only profile (catalyst), numbers of the earlier profile stay where the new one is silent
  await routeSwitch(A, 'catalyst');
  assert.match(renderTradingGuidance(guidance.getTradingGuidanceForSandbox(A), { strategyId: 'catalyst-news' }), /first 20 minutes/);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  // -> unprofiled (conservative): nothing changes, warning says so
  const { body: plain } = await routeSwitch(A, 'conservative');
  assert.match(plain.warnings.join(' '), /not guaranteed ready/);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  // -> back to the profiled strategy after a manual edit: drift shows, re-apply clears it
  await routeSwitch(A, 'mean-reversion');
  await guidance.setTradingGuidanceForSandbox(A, { expiryMaxDays: 120 });
  const items = () => profileDriftItems(profileOfStrategy(store.getStrategyById('etf-mean-reversion')), { slotGuidance: guidance.getTradingGuidanceForSandbox(A), slotHeartbeat: store.getSandbox(A).heartbeat });
  assert.deepEqual(items().map(item => item.key), ['expiryMaxDays']);
  const ticket = review.acquireSlotOrRefuse(A, 'reapply');
  const transition = review.createTransition({ kind: 'reapply', sandboxId: A, reviewToken: review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.reviewToken, opId: ticket.opId });
  transition.verify();
  await store.applySlotProfileToSandbox(A, transition);
  ticket.release();
  assert.deepEqual(items(), []);
});

// ── B02: the writer's hold lives as long as the handler's own promise, not as long as the response ─────────────────
async function withServer(setup, fn) {
  const app = express();
  app.use(express.json());
  setup(app);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { return await fn({ port: server.address().port }); } finally { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
}
const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
function clientRequest(port, method, route, body) {
  const request = http.request({ host: '127.0.0.1', port, method, path: route, headers: { 'content-type': 'application/json' } });
  const response = new Promise((resolve, reject) => {
    request.on('response', res => { let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null })); });
    request.on('error', reject);
  });
  response.catch(() => {});
  request.end(body === undefined ? undefined : JSON.stringify(body));
  return { request, response };
}

for (const scenario of [
  { name: 'client disconnects while the save is paused, then the handler completes', disconnect: true, reject: false },
  { name: 'client disconnects while the save is paused, then the handler rejects', disconnect: true, reject: true },
  { name: 'healthy normal completion (client stays connected)', disconnect: false, reject: false },
  { name: 'handler rejects with the client still connected', disconnect: false, reject: true },
]) {
  test(`B02: guarded writer keeps its hold until its own work settles: ${scenario.name}`, async () => {
    await reset();
    const pause = latch(), started = latch(), finished = latch(), closed = latch();
    const handler = async (req, res) => {
      res.on('close', () => closed.release());
      started.release();
      try {
        await pause.promise; // the awaited backend/publication step
        await guidance.setTradingGuidanceForSandbox(A, { extendedPct: 6 });
        if (scenario.reject) throw new Error('backend refresh failed');
        res.json({ ok: true });
      } finally { finished.release(); }
    };
    await withServer(app => {
      app.put('/w', review.slotWriterGuard(() => A, handler));
      review.registerSlotProfileRoutes(app, { operatorAuth: (req, res, next) => next(), sameOrigin: (req, res, next) => next(), isBusy: () => false, readExposureExisting: async () => null, refresh: async () => {}, afterChange: () => {} });
    }, async ({ port }) => {
      const client = clientRequest(port, 'PUT', '/w', {});
      await started.promise;
      assert.ok(slotGate.held(A), 'the writer holds the slot');
      if (scenario.disconnect) { client.request.destroy(); await closed.promise; await settle(); }
      // while the work is still pending (client gone or not): switch, re-apply and another writer are all refused
      assert.ok(slotGate.held(A), 'the hold survives the response closing');
      await expectRefusal(routeSwitch(A, 'mean-reversion'), 409);
      const reapply = await fetch(`http://127.0.0.1:${port}/api/sandboxes/${A}/agent/apply-profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reviewToken: review.buildSlotReview({ kind: 'reapply', sandboxId: A }).preview.reviewToken }) });
      assert.equal(reapply.status, 409);
      assert.throws(() => review.acquireSlotOrRefuse(A, 'write'), error => error.status === 409);
      assert.equal(guidance.getTradingGuidanceForSandbox(A).extendedPct, 4, 'the paused save has not happened yet');
      pause.release();
      await finished.promise;
      await settle();
      assert.equal(slotGate.held(A), null, 'no leaked hold once the handler settled');
      assert.equal(guidance.getTradingGuidanceForSandbox(A).extendedPct, 6, 'its save survives');
      assert.equal(JSON.parse(await fs.readFile(guidanceFile(), 'utf8')).sandboxes[A].extendedPct, 6);
      if (!scenario.disconnect) {
        const answered = await client.response;
        assert.equal(answered.status, scenario.reject ? 500 : 200);
        if (scenario.reject) assert.match(answered.body.error, /backend refresh failed/);
      }
      const after = await routeSwitch(A, 'mean-reversion'); // a subsequent switch is admitted
      assert.equal(after.body.ok, true);
      assert.equal(guidance.getTradingGuidanceForSandbox(A).extendedPct, 6, 'the switch applied on top of the saved edit');
    });
  });
}

test('B02: a writer that resolves no slot takes no hold; a throwing slot resolver answers 400', async () => {
  await reset();
  let ran = false;
  await withServer(app => {
    app.put('/none', review.slotWriterGuard(() => null, async (req, res, id) => { ran = id === null; res.json({ ok: true }); }));
    app.put('/bad', review.slotWriterGuard(() => { throw new Error('bad request'); }, async () => {}));
  }, async ({ port }) => {
    assert.equal((await clientRequest(port, 'PUT', '/none', {}).response).status, 200);
    assert.equal(ran, true);
    assert.equal((await clientRequest(port, 'PUT', '/bad', {}).response).status, 400);
  });
  assert.equal(slotGate.held(A), null);
});

// ── B03: legacy permission and model writers are pinned to one slot and gated ───────────────────────────────────────
function legacyWriters(calls, hooks = {}) {
  return app => {
    review.registerPermissionsRoute(app, {
      operatorAuth: (req, res, next) => next(),
      activeSandboxId: () => store.getActiveSandbox()?.id,
      updatePermissionsForSandbox: async (id, perms) => { calls.save.push(id); await hooks.beforeSave?.(); return store.updatePermissionsForSandbox(id, perms); },
      updatePermissions: async perms => { calls.save.push('ACTIVE-SETTER'); await hooks.beforeSave?.(); return store.updatePermissions(perms); },
      getSandbox: store.getSandbox,
      restartBackend: async id => { calls.restart.push(id); await hooks.restart?.(); },
      restartActiveBackend: async () => { calls.restart.push('ACTIVE'); },
      broadcast: () => { calls.broadcast += 1; },
    });
    review.registerModelActivateRoute(app, {
      activeSandboxId: () => store.getActiveSandbox()?.id,
      setModel: async (model, id) => { calls.save.push(id); await hooks.beforeSave?.(); return store.setActiveModel(model, id); },
      refresh: async id => { calls.refresh.push(id); await hooks.refresh?.(); },
      broadcast: () => { calls.broadcast += 1; },
    });
  };
}
const newCalls = () => ({ save: [], restart: [], refresh: [], broadcast: 0 });

test('B03: while a switch is paused, permissions PUT (with and without an id) and the legacy non-OpenAI model request are 409 with no save, restart or refresh', async () => {
  await reset();
  const calls = newCalls();
  const pause = latch();
  faults.afterPendingWrite = () => pause.promise;
  const running = routeSwitch(A, 'mean-reversion');
  await settle(60);
  assert.ok(slotGate.held(A));
  const permissionsBefore = clone(store.getSandbox(A).permissions);
  const agentBefore = clone(store.getSandbox(A).agent);
  const configBytes = await read(configPath);
  await withServer(legacyWriters(calls), async ({ port }) => {
    for (const [label, route, method, body] of [
      ['permissions with id', '/api/permissions', 'PUT', { sandboxId: A, requireConfirmation: true }],
      ['permissions without id (active slot)', '/api/permissions', 'PUT', { requireConfirmation: true }],
      ['legacy model request', '/api/models/activate', 'POST', { model: 'anthropic/claude-opus-4-1' }],
    ]) {
      const answered = await clientRequest(port, method, route, body).response;
      assert.equal(answered.status, 409, label);
      assert.match(answered.body.error, /slot settings transition in progress/, label);
    }
  });
  assert.deepEqual(calls, newCalls(), 'no save, restart, refresh or broadcast ran');
  assert.deepEqual(store.getSandbox(A).permissions, permissionsBefore);
  assert.deepEqual(clone(store.getSandbox(A).agent), agentBefore);
  assert.equal(await read(configPath), configBytes, 'config on disk untouched');
  pause.release();
  assert.equal((await running).body.ok, true);
  assert.equal(slotGate.held(A), null);
});

test('B03 controls: healthy sequential permissions and model requests save to the slot and restart/refresh it; an openai model is refused without a save', async () => {
  await reset();
  const bPermissionsBefore = clone(store.getSandbox(B).permissions);
  const calls = newCalls();
  await withServer(legacyWriters(calls), async ({ port }) => {
    assert.equal((await clientRequest(port, 'PUT', '/api/permissions', { sandboxId: A, requireConfirmation: true }).response).status, 200);
    assert.equal(store.getSandbox(A).permissions.requireConfirmation, true);
    assert.equal((await clientRequest(port, 'PUT', '/api/permissions', { requireConfirmation: false }).response).status, 200);
    assert.equal(store.getSandbox(A).permissions.requireConfirmation, false);
    assert.equal((await clientRequest(port, 'POST', '/api/models/activate', { model: 'anthropic/claude-opus-4-1' }).response).status, 200);
    assert.equal(store.getSandbox(A).agent.model, 'anthropic/claude-opus-4-1');
    assert.equal(store.getConfig().activeModel, 'anthropic/claude-opus-4-1');
    const openai = await clientRequest(port, 'POST', '/api/models/activate', { model: 'openai/gpt-x' }).response;
    assert.equal(openai.status, 409);
    assert.equal(slotGate.held(A), null);
  });
  assert.deepEqual(calls.save, [A, A, A]);
  assert.deepEqual(calls.restart, [A, A]);
  assert.deepEqual(calls.refresh, [A]);
  assert.equal(calls.broadcast, 3);
  assert.equal(store.getSandbox(B).permissions.requireConfirmation, bPermissionsBefore.requireConfirmation, 'the other slot is unchanged');
});

test('B03: a no-id permissions PUT and a legacy model request stay pinned to the slot active at entry when the active account changes while they wait', async () => {
  await reset();
  const bBefore = clone({ permissions: store.getSandbox(B).permissions, agent: store.getSandbox(B).agent, activeModel: null });
  // permissions: the save itself is delayed
  let calls = newCalls();
  let entered = latch(), pause = latch();
  await withServer(legacyWriters(calls, { beforeSave: async () => { entered.release(); await pause.promise; } }), async ({ port }) => {
    const request = clientRequest(port, 'PUT', '/api/permissions', { requireConfirmation: true });
    await entered.promise;
    await store.setActiveSandbox(B); // "account activation" during the delayed request
    pause.release();
    assert.equal((await request.response).status, 200);
  });
  assert.deepEqual(calls.save, [A], 'the setter received the pinned slot, never an active-slot setter');
  assert.deepEqual(calls.restart, [A]);
  assert.equal(store.getSandbox(A).permissions.requireConfirmation, true);
  assert.equal(store.getSandbox(B).permissions.requireConfirmation, bBefore.permissions.requireConfirmation, 'the other slot is unchanged');
  // model: the refresh is delayed after the save
  await reset();
  const activeModelBefore = store.getConfig().activeModel;
  calls = newCalls(); entered = latch(); pause = latch();
  await withServer(legacyWriters(calls, { refresh: async () => { entered.release(); await pause.promise; } }), async ({ port }) => {
    const request = clientRequest(port, 'POST', '/api/models/activate', { model: 'anthropic/claude-opus-4-1' });
    await entered.promise;
    await store.setActiveSandbox(B);
    pause.release();
    assert.equal((await request.response).status, 200);
  });
  assert.deepEqual(calls.save, [A]);
  assert.deepEqual(calls.refresh, [A], 'the refresh targets the original slot');
  assert.equal(store.getSandbox(A).agent.model, 'anthropic/claude-opus-4-1');
  assert.deepEqual(clone(store.getSandbox(B).agent), bBefore.agent, 'the other slot is unchanged');
  assert.notEqual(store.getConfig().activeModel, 'anthropic/claude-opus-4-1', 'the active-slot alias still follows the (new) active slot');
  assert.equal(store.getConfig().activeSandboxId, B);
  assert.ok(activeModelBefore === undefined || typeof activeModelBefore === 'string');
});

test('B03 wiring (source): server.js registers both legacy writers through the shared pinned routes with the operator auth it had', async () => {
  const source = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  assert.match(source, /registerPermissionsRoute\(app, \{\s+operatorAuth: operatorAuthMiddleware,\s+activeSandboxId: \(\) => getActiveSandbox\(\)\?\.id,/);
  assert.match(source, /registerModelActivateRoute\(app, \{\s+activeSandboxId: \(\) => getActiveSandbox\(\)\?\.id,\s+setModel: \(model, sandboxId\) => setActiveModel\(model, sandboxId\),/);
  assert.doesNotMatch(source, /app\.(put|post)\('\/api\/(permissions|models\/activate)'/);
});

// ── B04: the review token binds the permission outcome that confirmation would apply ────────────────────────────────
test('B04: changing only the target strategy\'s option fit makes the old token stale (409 + fresh preview, nothing written): broadening, narrowing, options-off', async () => {
  const cases = [
    { label: 'broadening', before: ['long_call'], after: ['long_call', 'long_put'], expectAfter: perms => assert.deepEqual(perms.allowedStructures, ['long_call', 'long_put']) },
    { label: 'narrowing', before: ['long_call', 'long_put'], after: ['long_call'], expectAfter: perms => assert.deepEqual(perms.allowedStructures, ['long_call']) },
    { label: 'options-off', before: ['long_call'], after: [], expectAfter: perms => assert.equal(perms.allowOptions, false) },
  ];
  for (const { label, before, after, expectAfter } of cases) {
    await reset();
    await store.updatePermissionsForSandbox(A, { allowedStructures: ['bull_call_debit'] }); // so each fit resolves to a visible permission change
    await store.updateStrategy('etf-mean-reversion', { optionStructures: before });
    const profileBefore = clone(store.getStrategyById('etf-mean-reversion').slotProfile);
    const staleToken = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }).preview.reviewToken;
    await store.updateStrategy('etf-mean-reversion', { optionStructures: after }); // only the fit; same strategy id, profile and slot state
    assert.deepEqual(store.getStrategyById('etf-mean-reversion').slotProfile, profileBefore, `${label}: profile unchanged`);
    const snapshot = slotSnapshot(A);
    const files = [await read(configPath), await read(guidanceFile()), await read(pendingFile())];
    await assert.rejects(routeSwitch(A, 'mean-reversion', { token: staleToken }), error => {
      assert.equal(error.status, 409, label);
      assert.match(error.body.error, /changed since the preview/);
      assert.notEqual(error.body.preview.reviewToken, staleToken, `${label}: the fresh preview carries a different token`);
      expectAfter(error.body.preview.changes.permissions.after);
      return true;
    }, label);
    assert.deepEqual(slotSnapshot(A), snapshot, label);
    assert.deepEqual([await read(configPath), await read(guidanceFile()), await read(pendingFile())], files, `${label}: config, guidance and pending bytes unchanged`);
    assert.equal(slotGate.held(A), null);
    // confirming the fresh preview works
    const fresh = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }).preview.reviewToken;
    assert.equal((await routeSwitch(A, 'mean-reversion', { token: fresh })).body.ok, true, `${label}: the fresh token confirms`);
  }
});

test('B04 controls: an unchanged fit confirms with the original token; a held-exposure options-off switch is still refused and saves nothing', async () => {
  await reset();
  await store.updateStrategy('etf-mean-reversion', { optionStructures: ['long_call'] });
  const token = review.buildSlotReview({ kind: 'switch', sandboxId: A, activeAgentId: 'mean-reversion' }).preview.reviewToken;
  await store.updateStrategy('etf-mean-reversion', { optionStructures: ['long_call'] }); // saved again with the same fit
  assert.equal((await routeSwitch(A, 'mean-reversion', { token })).body.ok, true);
  assert.deepEqual(store.getSandbox(A).permissions.allowedStructures, ['long_call']);
  await reset();
  await store.updateStrategy('etf-mean-reversion', { optionStructures: [] });
  const before = slotSnapshot(A);
  const held = { positions: [{ symbol: 'SPY260101C00500000' }], orders: [], ordersComplete: true, groups: { groups: [] } };
  await expectRefusal(routeSwitch(A, 'mean-reversion', { exposure: held }), 409);
  assert.deepEqual(slotSnapshot(A), before);
  assert.equal(await read(pendingFile()), null);
});

test('B04: a fit that changes during the awaited exposure read is caught again before anything is published', async () => {
  await reset();
  await store.updatePermissionsForSandbox(A, { allowedStructures: ['bull_call_debit'] });
  await store.updateStrategy('etf-mean-reversion', { optionStructures: [] }); // options-off: the guard reads exposure
  const before = slotSnapshot(A);
  const guidanceBytes = await read(guidanceFile());
  await assert.rejects(routeSwitch(A, 'mean-reversion', { readExposure: async () => { await store.updateStrategy('etf-mean-reversion', { optionStructures: ['long_call', 'long_put'] }); return FLAT; } }), error => {
    assert.equal(error.status, 409);
    assert.match(error.body.error, /changed since the preview/);
    assert.deepEqual(error.body.preview.changes.permissions.after.allowedStructures, ['long_call', 'long_put']);
    return true;
  });
  assert.deepEqual(slotSnapshot(A), before);
  assert.equal(await read(guidanceFile()), guidanceBytes);
  assert.equal(await read(pendingFile()), null);
  assert.equal(slotGate.held(A), null);
});
