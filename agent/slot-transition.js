// Slot transition write and recovery (switch-profile plan 3.4). Keeps the two existing stores (agent-config.json and
// trading-guidance.json) and adds one small pending record per slot so a crash between the two writes resolves to a coherent old or new pair.
//
//   1. stage        the caller builds the next sandbox object, the next guidance entry and the receipt as NEW values (nothing exposed)
//   2. pending      data/slot-transition-pending.json gets { opId, sandboxId, kind, createdAt, before, after } (atomic, fsync)
//   3. guidance     the slot's guidance entry is published with transitionOpId = opId
//   4. config       the staged sandbox is applied with lastTransitionOpId = opId and saved; that marker on the saved sandbox IS the commit
//   5. clear        the pending record is removed, then the receipt is recorded
//
// Recovery (at load, before any slot starts): config carries the opId -> committed: make sure the `after` guidance is there, clear.
// Otherwise -> not committed: put the `before` guidance back if the entry still carries the opId, clear. Only that slot's fields are touched.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishAtomic } from './durable-file.js';
import { getSavedGuidanceEntry, replaceGuidanceEntryForSandbox } from './trading-guidance.js';
import { slotGate } from './slot-gate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = () => process.env.OPENPROPHET_DATA_DIR || path.join(__dirname, '..', 'data');
export const pendingPath = () => path.join(dataDir(), 'slot-transition-pending.json');

/** An error that carries the HTTP status and the JSON body its route should answer with. */
export class SlotTransitionError extends Error {
  constructor(status, body) {
    super(body?.error || 'slot transition failed');
    this.status = status;
    this.body = body;
  }
}

/** A hook that throws this simulates the process dying at that point: no cleanup, no compensation (tests only). */
export class CrashSimulation extends Error {}
export const faults = {};
async function fault(name) { if (typeof faults[name] === 'function') await faults[name](); }

// ── pending record file ─────────────────────────────────────────────
let pendingQueue = Promise.resolve();
const queued = task => { const run = pendingQueue.catch(() => {}).then(task); pendingQueue = run; return run; };

async function readPendingFile() {
  let text;
  try { text = await fs.readFile(pendingPath(), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, records: {} };
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || !parsed.records || typeof parsed.records !== 'object') throw new Error('pending record file has an unexpected shape');
  return { version: 1, records: parsed.records };
}

async function writePendingFile(file) {
  if (!Object.keys(file.records).length) { await fs.rm(pendingPath(), { force: true }); return; }
  await fs.mkdir(dataDir(), { recursive: true });
  await publishAtomic(pendingPath(), JSON.stringify(file, null, 2));
}

export const readPendingRecords = () => queued(async () => (await readPendingFile()).records);
const writePending = record => queued(async () => {
  const file = await readPendingFile();
  file.records[record.sandboxId] = record;
  await writePendingFile(file);
});
const clearPending = (sandboxId, opId) => queued(async () => {
  const file = await readPendingFile();
  if (file.records[sandboxId] && (opId === undefined || file.records[sandboxId].opId === opId)) delete file.records[sandboxId];
  await writePendingFile(file);
});

// ── the write ───────────────────────────────────────────────────────
/**
 * Runs steps 2-5. `t`:
 *   sandboxId, opId, kind
 *   summary        { before, after }  non-secret view of the slot's agent, permissions, heartbeat and guidance (stored and returned)
 *   guidance       null | { before: entry|null, after: entry }   (after already carries transitionOpId)
 *   applyConfig()  mutates the in-memory config with the staged sandbox (sync)       revertConfig()  puts back exactly that sandbox entry and the aliases
 *   save()         persists the config (saveConfig)
 * Resolves when committed. Rejects with SlotTransitionError (status/body ready for the route) or CrashSimulation.
 */
export async function executeTransition(t) {
  const { sandboxId, opId } = t;
  const record = { opId, sandboxId, kind: t.kind, createdAt: new Date().toISOString(), before: { ...t.summary.before, guidanceEntry: t.guidance?.before ?? null, guidanceTouched: Boolean(t.guidance) }, after: { ...t.summary.after, guidanceEntry: t.guidance?.after ?? null, guidanceTouched: Boolean(t.guidance) } };
  try {
    await writePending(record);
    await fault('afterPendingWrite');
  } catch (error) {
    if (error instanceof CrashSimulation) throw error;
    await clearPending(sandboxId, opId).catch(() => {});
    throw new SlotTransitionError(500, { ok: false, committed: false, error: `The slot settings could not be recorded, so nothing was changed (${error.message})` });
  }
  if (t.guidance) {
    try {
      await replaceGuidanceEntryForSandbox(sandboxId, t.guidance.after);
      await fault('afterGuidancePublish');
    } catch (error) {
      if (error instanceof CrashSimulation) throw error;
      // Nothing was published when the publish itself failed: the saved entry is the old one. The record is harmless either way.
      await clearPending(sandboxId, opId).catch(() => {});
      throw new SlotTransitionError(500, { ok: false, committed: false, guidanceRestored: true, error: `The Trading Guidance could not be saved, so nothing was changed (${error.message})` });
    }
  }
  try {
    t.applyConfig();
    await (typeof faults.saveConfig === 'function' ? faults.saveConfig() : t.save());
  } catch (error) {
    if (error instanceof CrashSimulation) throw error;
    await compensate(t, record, error);
  }
  await fault('afterConfigCommit');
  try { await clearPending(sandboxId, opId); } catch (error) {
    // Committed and consistent in memory; a left-over record is resolved as "committed" at the next start.
    console.error(`[slot-transition] pending record not cleared for ${sandboxId}: ${error.message}`);
  }
}

async function compensate(t, record, cause) {
  const { sandboxId, opId } = t;
  let restored = true;
  let reason = '';
  try { t.revertConfig(); } catch (error) { restored = false; reason = error.message; }
  if (t.guidance) {
    try { await fault('duringCompensation'); await replaceGuidanceEntryForSandbox(sandboxId, t.guidance.before, { requireOpId: opId }); } catch (error) { restored = false; reason = error.message; }
  }
  if (restored) {
    // Best effort: scrub any copy of the rejected state another slot's save may have written to disk meanwhile.
    try { await t.save(); } catch { /* the disk keeps whatever it held before; recovery rules still resolve it */ }
    await clearPending(sandboxId, opId).catch(() => {});
    throw new SlotTransitionError(500, { ok: false, committed: false, guidanceRestored: true, before: t.summary.before, after: t.summary.after, error: `The slot settings could not be saved (${cause.message}); the Trading Guidance was restored and nothing was changed` });
  }
  slotGate.block(sandboxId, `a failed settings change could not be undone (${reason || cause.message}); resolve it and restart`);
  throw new SlotTransitionError(500, { ok: false, committed: false, guidanceRestored: false, before: t.summary.before, after: t.summary.after, error: `The slot settings could not be saved (${cause.message}) and the undo failed (${reason}); this slot is blocked until it is recovered` });
}

// ── recovery ────────────────────────────────────────────────────────
/**
 * Resolves every pending record. Call it after the config and the guidance store are loaded and before any slot starts.
 * `getSandbox(id)` reads the loaded config; `listSandboxIds()` is only used when the record file itself is unreadable (every slot is then blocked).
 */
export async function recoverPendingTransitions({ getSandbox, listSandboxIds = () => [], gate = slotGate, log = message => console.log(message) } = {}) {
  const outcome = { resolved: [], blocked: [] };
  let records;
  try { records = await readPendingRecords(); } catch (error) {
    for (const id of listSandboxIds()) { gate.block(id, 'the pending settings record could not be read'); outcome.blocked.push(id); }
    log(`[slot-transition] pending record unreadable (${error.message}); every slot is blocked until it is resolved`);
    return outcome;
  }
  for (const [sandboxId, record] of Object.entries(records)) {
    try {
      const sandbox = getSandbox(sandboxId);
      const entry = getSavedGuidanceEntry(sandboxId);
      if (sandbox) {
        const committed = sandbox.lastTransitionOpId === record.opId;
        if (record.after?.guidanceTouched) {
          if (committed) {
            if (entry?.transitionOpId !== record.opId) await replaceGuidanceEntryForSandbox(sandboxId, record.after.guidanceEntry);
          } else if (entry?.transitionOpId === record.opId) {
            await replaceGuidanceEntryForSandbox(sandboxId, record.before.guidanceEntry, { requireOpId: record.opId });
          }
        }
        log(`[slot-transition] ${sandboxId}: ${committed ? 'committed change completed' : 'uncommitted change rolled back'} (${record.opId})`);
      }
      await clearPending(sandboxId, record.opId);
      outcome.resolved.push(sandboxId);
    } catch (error) {
      gate.block(sandboxId, `recovery of an interrupted settings change failed (${error.message})`);
      outcome.blocked.push(sandboxId);
      log(`[slot-transition] ${sandboxId}: recovery failed (${error.message}); slot blocked`);
    }
  }
  return outcome;
}
