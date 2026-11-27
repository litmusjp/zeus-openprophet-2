import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Switch-profile plan 3.4 / acceptance cases 3, 4 and 9: failed writes, compensation, crash recovery and "unchanged settings".
// A crash is simulated by a hook that throws CrashSimulation (no cleanup runs); the "fresh process" is a reload of both stores from disk
// followed by recoverPendingTransitions, which is what server.js does before any slot can start.

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-slot-recovery-'));
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
const { faults, CrashSimulation, recoverPendingTransitions, readPendingRecords, pendingPath } = await import('../agent/slot-transition.js');
const { runGuardedSwitch } = await import('../agent/switch-guard.js');
const { AgentHarness } = await import('../agent/harness.js');

const A = 'sbx_a';
const B = 'sbx_b';
const MR_PROFILE = { tradingGuidance: { contractDeltaMin: 0.5, contractDeltaMax: 0.65, expiryMinDays: 90, expiryMaxDays: 150, extraSymbolsPerScan: 0 }, heartbeat: { market_open: 600, midday: 1800, market_close: 600 } };
const SLOT_GUIDANCE = { contractDeltaMin: 0.5, contractDeltaMax: 0.7, expiryMinDays: 21, expiryMaxDays: 45, extraSymbolsPerScan: 25, maxOptionSpreadPct: 8 };
const FLAT = { positions: [], orders: [], ordersComplete: true, groups: { groups: [] } };
const clone = value => JSON.parse(JSON.stringify(value));
const read = async file => fs.readFile(file, 'utf8').catch(() => null);
const guidanceFile = () => path.join(dataDir, 'trading-guidance.json');
const diskConfig = async () => JSON.parse(await fs.readFile(configPath, 'utf8'));
const diskGuidance = async () => JSON.parse(await fs.readFile(guidanceFile(), 'utf8')).sandboxes;

async function reset() {
  for (const key of Object.keys(faults)) delete faults[key];
  slotGate.reset();
  await fs.rm(cfgDir, { recursive: true, force: true });
  await fs.rm(dataDir, { recursive: true, force: true });
  await fs.mkdir(cfgDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 2,
    accounts: [{ id: 'acc1', name: 'L1', paper: true }, { id: 'acc2', name: 'L2', paper: true }],
    activeAccountId: 'acc1', activeSandboxId: A,
    sandboxes: { [A]: { id: A, name: 'L1', accountId: 'acc1', agent: { activeAgentId: 'default' } }, [B]: { id: B, name: 'L2', accountId: 'acc2', agent: { activeAgentId: 'default' } } },
  }, null, 2));
  await store.loadConfig();
  guidance.resetTradingGuidanceStoreForTests();
  await guidance.setTradingGuidanceForSandbox(A, SLOT_GUIDANCE);
  await guidance.setTradingGuidanceForSandbox(B, { ...SLOT_GUIDANCE, contractDeltaMin: 0.45 });
  await store.updateStrategy('etf-mean-reversion', { slotProfile: MR_PROFILE });
  store.consumeAgentSwitch(A); store.consumeAgentSwitch(B);
}

async function routeSwitch(sid, agentId, { runtime = [] } = {}) {
  const ticket = review.acquireSlotOrRefuse(sid, 'switch');
  try {
    const rev = review.buildSlotReview({ kind: 'switch', sandboxId: sid, activeAgentId: agentId });
    const transition = review.createTransition({ kind: 'switch', sandboxId: sid, activeAgentId: agentId, reviewToken: rev.preview.reviewToken, opId: ticket.opId });
    transition.verify();
    const sandbox = await runGuardedSwitch({ sandboxId: sid, activeAgentId: agentId, overrides: {}, previewPatch: store.previewSwitchPermissionPatch, readExposure: async () => FLAT, save: () => store.updateSandboxAgentSelection(sid, { activeAgentId: agentId }, transition) });
    const failure = await review.finishCommittedRuntime(sid, runtime);
    return { sandbox, transition, failure };
  } finally { ticket.release(); }
}

/** Everything a slot's "pair" consists of, from memory. */
const memory = sid => clone({ agent: store.getSandbox(sid).agent.activeAgentId, permissions: store.getSandbox(sid).permissions, heartbeat: store.getSandbox(sid).heartbeat, guidance: guidance.getTradingGuidanceForSandbox(sid), marker: store.getSandbox(sid).lastTransitionOpId ?? null });

/** A fresh process: both stores come back from disk, the gate is empty, recovery runs. */
async function restart() {
  slotGate.reset();
  for (const key of Object.keys(faults)) delete faults[key];
  await store.loadConfig();
  await guidance.loadTradingGuidance();
  return recoverPendingTransitions({ getSandbox: store.getSandbox, listSandboxIds: () => store.getSandboxes().map(s => s.id), log: () => {} });
}

async function crashAt(point, sid = A, agentId = 'mean-reversion') {
  faults[point] = () => { throw new CrashSimulation(point); };
  await assert.rejects(routeSwitch(sid, agentId), error => error instanceof CrashSimulation);
  delete faults[point];
}

/** A genuinely fresh Node process over the same config/data folders: loads both stores, runs recovery, reports what it found. */
const childScript = fileURLToPath(new URL('./fixtures/slot-recovery-child.mjs', import.meta.url));
function freshProcess() {
  return new Promise((resolve, reject) => execFile(process.execPath, [childScript], { env: { ...process.env, OPENPROPHET_CONFIG_PATH: configPath, OPENPROPHET_DATA_DIR: dataDir, OPENPROPHET_EXECUTION_MODE: 'inert' }, timeout: 60000 }, (error, stdout, stderr) => {
    const line = String(stdout).split('\n').find(entry => entry.startsWith('RESULT '));
    if (!line) return reject(new Error(`child produced no result (${error?.message || 'no error'}): ${stderr || stdout}`));
    resolve(JSON.parse(line.slice('RESULT '.length)));
  }));
}

const why = result => JSON.stringify(Object.fromEntries(Object.entries(result.slots).map(([id, slot]) => [id, slot.blocked])));

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  for (const key of ['OPENPROPHET_CONFIG_PATH', 'OPENPROPHET_DATA_DIR', 'OPENPROPHET_EXECUTION_MODE']) delete process.env[key];
});

// ── failures (case 3) ───────────────────────────────────────────────────────────────────────────────────────────────
test('failure before the guidance publish: nothing published, record deleted, 500 with the reason, old pair everywhere', async () => {
  await reset();
  const before = memory(A);
  const guidanceBytes = await read(guidanceFile());
  const configBytes = await read(configPath);
  faults.afterPendingWrite = () => { throw new Error('record write failed'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => error.status === 500 && error.body.committed === false && error.body.guidanceRestored === undefined && /nothing was changed/.test(error.body.error));
  assert.deepEqual(memory(A), before);
  assert.equal(await read(guidanceFile()), guidanceBytes);
  assert.equal(await read(configPath), configBytes);
  assert.equal(await read(pendingPath()), null);
  assert.equal(store.consumeAgentSwitch(A), null);
  assert.equal(slotGate.held(A), null);
});

test('config save fails after the guidance publish: memory, aliases, receipt, guidance and disk are the OLD pair; a later ordinary save does not publish it', async () => {
  await reset();
  const before = memory(A);
  const aliasBefore = clone([store.getConfig().activeAgentId, store.getConfig().heartbeat, store.getConfig().permissions]);
  const diskBefore = await diskConfig();
  faults.saveConfig = async () => { throw new Error('disk full'); };
  let seenDuringSave = null;
  faults.duringCompensation = () => { seenDuringSave = guidance.getTradingGuidanceForSandbox(A).expiryMinDays; };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => {
    assert.equal(error.status, 500);
    assert.equal(error.body.ok, false); assert.equal(error.body.committed, false); assert.equal(error.body.guidanceRestored, true);
    assert.match(error.body.error, /Trading Guidance was restored/); assert.ok(error.body.before && error.body.after);
    assert.equal(error.body.after.agent.activeAgentId, 'mean-reversion'); assert.equal(error.body.before.agent.activeAgentId, 'default');
    return true;
  });
  assert.equal(seenDuringSave, 90, 'the new guidance really was published before the save failed');
  assert.deepEqual(memory(A), before);
  assert.deepEqual(clone([store.getConfig().activeAgentId, store.getConfig().heartbeat, store.getConfig().permissions]), aliasBefore);
  assert.equal(store.consumeAgentSwitch(A), null, 'no receipt');
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 21);
  assert.equal((await diskGuidance())[A].expiryMinDays, 21);
  assert.equal(await read(pendingPath()), null);
  assert.equal(slotGate.blocked(A), null);
  delete faults.saveConfig;
  await store.saveConfig(); // a later ordinary save
  const diskAfter = await diskConfig();
  assert.equal(diskAfter.sandboxes[A].agent.activeAgentId, 'default');
  assert.equal(diskAfter.sandboxes[A].lastTransitionOpId, diskBefore.sandboxes[A].lastTransitionOpId);
  await store.loadConfig();
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'default');
});

test('compensation fails: slot blocked with a reason, record kept, 500 guidanceRestored false with before/after; beats and starts refused', async () => {
  await reset();
  faults.saveConfig = async () => { throw new Error('disk full'); };
  faults.duringCompensation = () => { throw new Error('guidance disk gone'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => {
    assert.equal(error.status, 500);
    assert.equal(error.body.ok, false); assert.equal(error.body.committed, false); assert.equal(error.body.guidanceRestored, false);
    assert.ok(error.body.before && error.body.after); assert.match(error.body.error, /blocked/);
    return true;
  });
  assert.match(slotGate.blocked(A).reason, /could not be undone/);
  assert.equal(Object.keys(await readPendingRecords()).join(), A, 'the record stays so a restart can resolve it');
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'default', 'memory is restored even when the guidance undo failed');
  assert.equal(slotGate.beatBlock(A).hard, true);
  await assert.rejects(new AgentHarness({ sandboxId: A }).start(), /Start refused/);
  const h = new AgentHarness({ sandboxId: A }); h.state.running = true; await h._beat(); assert.equal(h._beating, false);
  assert.throws(() => review.acquireSlotOrRefuse(A, 'write'), error => error.status === 409);
  assert.equal(slotGate.blocked(B), null, 'other slots are unaffected');
  // a restart resolves it (config never committed, guidance entry carries the op id -> restored)
  const outcome = await restart();
  assert.deepEqual(outcome, { resolved: [A], blocked: [] });
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 21);
  assert.equal(slotGate.blocked(A), null);
  assert.equal(await read(pendingPath()), null);
});

// ── restart recovery (case 4) ───────────────────────────────────────────────────────────────────────────────────────
test('restart after the guidance publish and before the config commit: the OLD pair', async () => {
  await reset();
  const before = memory(A);
  const bGuidance = (await diskGuidance())[B];
  await crashAt('afterGuidancePublish');
  assert.equal((await diskGuidance())[A].expiryMinDays, 90, 'the crash left new guidance on disk');
  assert.equal((await diskConfig()).sandboxes[A].agent.activeAgentId, 'default');
  assert.deepEqual(Object.keys(await readPendingRecords()), [A]);
  const outcome = await restart();
  assert.deepEqual(outcome, { resolved: [A], blocked: [] });
  assert.deepEqual(memory(A), before);
  assert.deepEqual((await diskGuidance())[B], bGuidance, 'recovery touches only that slot');
  assert.equal(await read(pendingPath()), null);
  assert.equal(slotGate.beatBlock(A), null);
});

test('restart: a slot that had no saved guidance entry goes back to none (defaults), not to an injected copy', async () => {
  await reset();
  await guidance.replaceGuidanceEntryForSandbox(A, null);
  await crashAt('afterGuidancePublish');
  await restart();
  assert.equal(sbxEntry(await diskGuidance(), A), undefined);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, guidance.DEFAULT_TRADING_GUIDANCE.expiryMinDays);
});
const sbxEntry = (entries, id) => entries[id];

test('restart after the config commit and before the record is cleared: the NEW pair, and the guidance is republished if it is missing', async () => {
  await reset();
  await crashAt('afterConfigCommit');
  assert.equal(await read(pendingPath()) !== null, true);
  let outcome = await restart();
  assert.deepEqual(outcome, { resolved: [A], blocked: [] });
  assert.equal(store.getSandbox(A).agent.activeAgentId, 'mean-reversion');
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  assert.equal(store.getSandbox(A).heartbeat.mode, 'market_aware');
  assert.equal(await read(pendingPath()), null);
  // same crash, but the guidance entry is gone: committed config wins and the `after` guidance is published again
  await reset();
  await crashAt('afterConfigCommit');
  await guidance.replaceGuidanceEntryForSandbox(A, null); // genuinely absent
  outcome = await restart();
  assert.deepEqual(outcome, { resolved: [A], blocked: [] });
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90);
  assert.equal((await diskGuidance())[A].transitionOpId, store.getSandbox(A).lastTransitionOpId);
});

test('restart never overwrites a later operator edit: an entry without the op id is left alone', async () => {
  await reset();
  await crashAt('afterGuidancePublish');
  await guidance.setTradingGuidanceForSandbox(A, { extendedPct: 6 }); // an operator save replaces the whole entry and drops the op id
  await restart();
  assert.equal(guidance.getTradingGuidanceForSandbox(A).extendedPct, 6);
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 90, 'recovery did not roll the operator\'s entry back');
  assert.equal(await read(pendingPath()), null);
});

test('unrecoverable: the slot is blocked (reason, health, start refused) and the record stays; a later restart that can write resolves it', async () => {
  await reset();
  await crashAt('afterGuidancePublish');
  await fs.mkdir(`${guidanceFile()}.tmp`); // the guidance file can no longer be written
  const outcome = await restart();
  assert.deepEqual(outcome, { resolved: [], blocked: [A] });
  assert.match(slotGate.blocked(A).reason, /recovery of an interrupted settings change failed/);
  assert.deepEqual(Object.keys(await readPendingRecords()), [A]);
  await assert.rejects(new AgentHarness({ sandboxId: A }).start(), /Start refused/);
  assert.equal(slotGate.blocked(B), null);
  await fs.rm(`${guidanceFile()}.tmp`, { recursive: true });
  const again = await restart();
  assert.deepEqual(again, { resolved: [A], blocked: [] });
  assert.equal(guidance.getTradingGuidanceForSandbox(A).expiryMinDays, 21);
});

test('an unreadable pending record file blocks every slot', async () => {
  await reset();
  await fs.writeFile(pendingPath(), '{ not json');
  const outcome = await restart();
  assert.ok(outcome.blocked.includes(A) && outcome.blocked.includes(B), 'every configured slot');
  assert.match(slotGate.blocked(A).reason, /could not be read/);
});

test('a record for a slot that no longer exists is simply cleared', async () => {
  await reset();
  await crashAt('afterGuidancePublish');
  const records = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
  records.records.sbx_gone = { ...records.records[A], sandboxId: 'sbx_gone' };
  await fs.writeFile(pendingPath(), JSON.stringify(records));
  const outcome = await restart();
  assert.deepEqual(outcome.resolved.sort(), [A, 'sbx_gone']);
});

// ── case 9: unchanged settings ──────────────────────────────────────────────────────────────────────────────────────
test('excluded guidance keys, Risk fields, the spread cap and AD policy are identical after a switch, a compensation and a restart', async () => {
  await reset();
  const excluded = state => ({
    guidance: Object.fromEntries(Object.entries(state.guidance).filter(([key]) => !Object.keys(MR_PROFILE.tradingGuidance).includes(key))),
    permissions: state.permissions, plugins: store.getSandbox(A).plugins,
  });
  const base = excluded(memory(A));
  assert.equal(base.guidance.maxOptionSpreadPct, 8);
  const permsExceptFit = permissions => Object.fromEntries(Object.entries(permissions).filter(([key]) => !['allowOptions', 'allowedStructures'].includes(key)));
  // a failed switch with compensation
  faults.saveConfig = async () => { throw new Error('disk'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'));
  assert.deepEqual(excluded(memory(A)), base);
  delete faults.saveConfig;
  // a successful switch
  await routeSwitch(A, 'mean-reversion');
  const switched = memory(A);
  assert.deepEqual(excluded(switched).guidance, base.guidance);
  assert.deepEqual(permsExceptFit(switched.permissions), permsExceptFit(base.permissions));
  assert.deepEqual(store.getSandbox(A).plugins, base.plugins);
  // and after a restart
  await restart();
  assert.deepEqual(excluded(memory(A)).guidance, base.guidance);
  assert.deepEqual(permsExceptFit(memory(A).permissions), permsExceptFit(base.permissions));
  assert.equal(guidance.getTradingGuidanceForSandbox(A).maxOptionSpreadPct, 8);
});

// ── B01: a later operator save is never replaced by the old after-snapshot ──────────────────────────────────────────
test('B01: after a committed pending record, a normal later save (extendedPct 6, maxOptionSpreadPct 7) survives recovery in a fresh process; other slots unchanged', async () => {
  await reset();
  await crashAt('afterConfigCommit'); // committed: config carries the op id, the pending record is left behind
  const record = (await readPendingRecords())[A];
  assert.equal(record.after.guidanceEntry.extendedPct, 4, 'the old after-snapshot holds the default extendedPct');
  assert.equal(record.after.guidanceEntry.maxOptionSpreadPct, 8, 'and the old cap');
  await guidance.setTradingGuidanceForSandbox(A, { extendedPct: 6, maxOptionSpreadPct: 7 }); // the ordinary operator save: drops the op id
  assert.equal(guidance.getSavedGuidanceEntry(A).transitionOpId, undefined);
  const bBefore = (await diskGuidance())[B];
  const bConfigBefore = clone((await diskConfig()).sandboxes[B]);
  const result = await freshProcess();
  assert.deepEqual(result.outcome, { resolved: [A], blocked: [] }, why(result));
  assert.equal(result.slots[A].guidance.extendedPct, 6);
  assert.equal(result.slots[A].guidance.maxOptionSpreadPct, 7);
  assert.equal(result.slots[A].guidance.expiryMinDays, 90, 'the committed profile value is still there (the later save started from it)');
  const disk = await diskGuidance();
  assert.equal(disk[A].extendedPct, 6); assert.equal(disk[A].maxOptionSpreadPct, 7);
  assert.deepEqual(disk[B], bBefore, 'the other slot is untouched');
  assert.deepEqual((await diskConfig()).sandboxes[B], bConfigBefore);
  assert.equal(result.slots[A].agent, 'mean-reversion');
  assert.equal(await read(pendingPath()), null, 'resolved: the record is cleared');
});

test('B01 controls: a committed record whose entry still carries the op id is kept and cleared; an uncommitted record restores the old pair', async () => {
  await reset();
  await crashAt('afterConfigCommit');
  let result = await freshProcess();
  assert.deepEqual(result.outcome, { resolved: [A], blocked: [] }, why(result));
  assert.equal(result.slots[A].guidance.expiryMinDays, 90);
  assert.equal(result.slots[A].savedEntry.transitionOpId, (await diskConfig()).sandboxes[A].lastTransitionOpId);
  assert.equal(result.slots[A].guidance.maxOptionSpreadPct, 8);
  await reset();
  await crashAt('afterGuidancePublish');
  result = await freshProcess();
  assert.deepEqual(result.outcome, { resolved: [A], blocked: [] }, why(result));
  assert.equal(result.slots[A].guidance.expiryMinDays, 21, 'old pair');
  assert.equal(result.slots[A].guidance.extraSymbolsPerScan, 25);
  assert.equal(result.slots[A].agent, 'default');
});

test('B01: an entry that is neither this operation\'s nor provably a later save blocks the slot and keeps the record and the entry', async () => {
  const cases = {
    'no marker, older than the staged entry': entry => { const { transitionOpId, ...rest } = entry; return { ...rest, updatedAt: '2000-01-01T00:00:00.000Z' }; },
    'no marker and no timestamp': entry => { const { transitionOpId, updatedAt, ...rest } = entry; return rest; },
    'another operation\'s marker': entry => ({ ...entry, transitionOpId: 'some-other-operation' }),
  };
  for (const [label, edit] of Object.entries(cases)) {
    await reset();
    await crashAt('afterConfigCommit');
    const staged = guidance.getSavedGuidanceEntry(A);
    await guidance.replaceGuidanceEntryForSandbox(A, edit(staged));
    const entryBytes = JSON.stringify(guidance.getSavedGuidanceEntry(A));
    const recordBytes = await read(pendingPath());
    const result = await freshProcess();
    assert.deepEqual(result.outcome, { resolved: [], blocked: [A] }, label);
    assert.match(result.slots[A].blocked, /recovery of an interrupted settings change failed/, label);
    assert.equal(JSON.stringify(result.slots[A].savedEntry), entryBytes, `${label}: the entry was not replaced`);
    assert.equal(await read(pendingPath()), recordBytes, `${label}: evidence kept`);
    assert.equal(result.slots[A].startRefused, true, label); assert.equal(result.slots[A].beatRefused, true, label);
    assert.equal(result.slots[B].blocked, null);
  }
});

// ── B05: malformed pending data is validated before it is interpreted or deleted ────────────────────────────────────
test('B05: parseable but malformed pending data is never called resolved or cleared; evidence bytes survive; starts and beats are refused', async () => {
  const withRecord = change => async () => {
    const file = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
    return JSON.stringify({ ...file, records: { [A]: change(file.records[A]) } });
  };
  const withFile = change => async () => JSON.stringify(change(JSON.parse(await fs.readFile(pendingPath(), 'utf8'))));
  const cases = {
    'records is an array': { text: withFile(file => ({ ...file, records: [] })), blocks: [A, B] },
    'records is a string': { text: withFile(file => ({ ...file, records: 'x' })), blocks: [A, B] },
    'unsupported version': { text: withFile(file => ({ ...file, version: 2 })), blocks: [A, B] },
    'empty slot record': { text: withRecord(() => ({})), blocks: [A] },
    'missing operation id': { text: withRecord(({ opId, ...rest }) => rest), blocks: [A] },
    'empty operation id': { text: withRecord(record => ({ ...record, opId: '' })), blocks: [A] },
    'sandbox id differs from the key': { text: withRecord(record => ({ ...record, sandboxId: B })), blocks: [A, B] },
    'unsupported kind': { text: withRecord(record => ({ ...record, kind: 'delete' })), blocks: [A] },
    'before snapshot is not an object': { text: withRecord(record => ({ ...record, before: 'x' })), blocks: [A] },
    'after snapshot lacks permissions': { text: withRecord(record => ({ ...record, after: { ...record.after, permissions: undefined } })), blocks: [A] },
    'guidanceTouched is missing': { text: withRecord(record => ({ ...record, after: { ...record.after, guidanceTouched: undefined } })), blocks: [A] },
    'after guidance entry is a string': { text: withRecord(record => ({ ...record, after: { ...record.after, guidanceEntry: 'x' } })), blocks: [A] },
    'after guidance entry belongs to another operation': { text: withRecord(record => ({ ...record, after: { ...record.after, guidanceEntry: { ...record.after.guidanceEntry, transitionOpId: 'other' } } })), blocks: [A] },
  };
  for (const [label, { text, blocks }] of Object.entries(cases)) {
    await reset();
    await crashAt('afterGuidancePublish'); // a real interrupted transition
    const bytes = await text();
    await fs.writeFile(pendingPath(), bytes);
    const guidanceBytes = await read(guidanceFile());
    const configBytes = await read(configPath);
    const result = await freshProcess();
    assert.deepEqual(result.outcome.resolved, [], label);
    for (const id of blocks) {
      assert.ok(result.outcome.blocked.includes(id), `${label}: ${id} blocked`);
      assert.ok(result.slots[id].blocked, `${label}: ${id} has a block reason`);
      assert.equal(result.slots[id].startRefused, true, `${label}: start refused on ${id}`);
      assert.equal(result.slots[id].beatRefused, true, `${label}: beat refused on ${id}`);
    }
    assert.equal(await read(pendingPath()), bytes, `${label}: the evidence file is byte-identical`);
    assert.equal(await read(guidanceFile()), guidanceBytes, `${label}: no guidance was rewritten`);
    assert.equal(await read(configPath), configBytes, `${label}: config untouched`);
    if (!blocks.includes(B)) assert.equal(result.slots[B].blocked, null, `${label}: another slot is not blocked`);
  }
});

test('B05 controls: a valid orphan-slot record is still cleared and a valid record next to a malformed one still resolves; the malformed one keeps its evidence', async () => {
  await reset();
  await crashAt('afterGuidancePublish');
  const file = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
  file.records.sbx_gone = { ...file.records[A], sandboxId: 'sbx_gone' };
  await fs.writeFile(pendingPath(), JSON.stringify(file));
  let result = await freshProcess();
  assert.deepEqual(result.outcome.resolved.sort(), [A, 'sbx_gone']);
  assert.equal(await read(pendingPath()), null);
  assert.equal(result.slots[A].guidance.expiryMinDays, 21);
  await reset();
  await crashAt('afterGuidancePublish');
  const mixed = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
  mixed.records.sbx_gone = {};
  await fs.writeFile(pendingPath(), JSON.stringify(mixed));
  result = await freshProcess();
  assert.deepEqual(result.outcome.resolved, [A]);
  assert.deepEqual(result.outcome.blocked, ['sbx_gone']);
  const left = JSON.parse(await fs.readFile(pendingPath(), 'utf8'));
  assert.deepEqual(Object.keys(left.records), ['sbx_gone'], 'only the malformed record remains');
  assert.deepEqual(left.records.sbx_gone, {});
  assert.equal(result.slots[A].guidance.expiryMinDays, 21);
});

// ── N01: a compensation whose final save failed is never reported as a restore ──────────────────────────────────────
test('N01: the switch config save reaches disk and then errors, and the compensating save fails: record kept, slot blocked, blocked body, never "restored"; a fresh process finds a retained record + block', async () => {
  await reset();
  faults.afterConfigSave = () => { throw new Error('error after the rename'); }; // the staged config IS on disk when this fires
  faults.compensationSave = () => { throw new Error('compensating save failed'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => {
    assert.equal(error.status, 500);
    assert.equal(error.body.ok, false); assert.equal(error.body.committed, false); assert.equal(error.body.guidanceRestored, false);
    assert.doesNotMatch(error.body.error, /was restored and nothing was changed/);
    assert.match(error.body.error, /blocked/); assert.match(error.body.error, /compensating save failed/);
    assert.ok(error.body.before && error.body.after);
    return true;
  });
  assert.match(slotGate.blocked(A).reason, /could not be undone[\s\S]*compensating save failed/, 'operator-visible reason');
  assert.equal(slotGate.beatBlock(A).hard, true);
  assert.equal(Object.keys(await readPendingRecords()).join(), A, 'the record stays');
  assert.equal(slotGate.blocked(B), null);
  const onDisk = (await diskConfig()).sandboxes[A];
  assert.equal(onDisk.agent.activeAgentId, 'mean-reversion', 'the staged config really did reach the disk (the ambiguous case)');
  // a fresh process over the same disk state: either a confirmed coherent pair or a retained record plus a block, never a clean "resolved" over a mixed pair
  const result = await freshProcess();
  const retained = Object.keys(JSON.parse(await fs.readFile(pendingPath(), 'utf8')).records);
  const guidanceNow = result.slots[A].guidance;
  const coherentNew = result.slots[A].agent === 'mean-reversion' && guidanceNow.expiryMinDays === 90;
  const coherentOld = result.slots[A].agent === 'default' && guidanceNow.expiryMinDays === 21;
  if (retained.length === 0) assert.ok(coherentNew || coherentOld, `a cleared record needs a coherent pair: ${JSON.stringify(result.slots[A])}`);
  else { assert.deepEqual(retained, [A]); assert.ok(result.slots[A].blocked, 'retained record means the slot is blocked'); assert.equal(result.slots[A].beatRefused, true); assert.equal(result.slots[A].startRefused, true); }
  assert.equal(result.outcome.resolved.includes(A) && !coherentNew && !coherentOld, false, 'never resolved over a mixed pair');
});

test('N01: the compensating save fails after a plain failed save (nothing published): record kept, slot blocked, blocked body', async () => {
  await reset();
  faults.saveConfig = async () => { throw new Error('disk full'); };
  faults.compensationSave = () => { throw new Error('still full'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => error.body.guidanceRestored === false && error.body.committed === false && /still full/.test(error.body.error));
  assert.ok(slotGate.blocked(A));
  assert.equal(Object.keys(await readPendingRecords()).join(), A);
  const result = await freshProcess();
  assert.deepEqual(result.outcome, { resolved: [A], blocked: [] }, 'the disk still holds the old config, so a restart rolls the guidance back to the old pair');
  assert.equal(result.slots[A].agent, 'default');
  assert.equal(result.slots[A].guidance.expiryMinDays, 21);
});

test('N01 control: publish-then-error followed by a HEALTHY compensating save restores and confirms the old pair (restored body, record cleared, no block); a fresh process agrees', async () => {
  await reset();
  const before = memory(A);
  faults.afterConfigSave = () => { throw new Error('error after the rename'); };
  await assert.rejects(routeSwitch(A, 'mean-reversion'), error => error.body.guidanceRestored === true && error.body.committed === false && /Trading Guidance was restored/.test(error.body.error));
  assert.equal(slotGate.blocked(A), null);
  assert.equal(await read(pendingPath()), null);
  assert.deepEqual(memory(A), before);
  assert.equal((await diskConfig()).sandboxes[A].agent.activeAgentId, 'default', 'the compensating save scrubbed the staged config from disk');
  const result = await freshProcess();
  assert.deepEqual(result.outcome, { resolved: [], blocked: [] });
  assert.equal(result.slots[A].agent, 'default');
  assert.equal(result.slots[A].guidance.expiryMinDays, 21);
});
