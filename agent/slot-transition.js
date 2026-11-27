// Slot transition write and recovery (switch-profile plan 3.4). Keeps the two existing stores (agent-config.json and
// trading-guidance.json) and adds one small pending record per slot so a crash between the two writes resolves to a coherent old or new pair.
//
//   1. stage        the caller builds the next sandbox object, the next guidance entry and the receipt as NEW values (nothing exposed)
//   2. pending      data/slot-transition-pending.json gets { opId, sandboxId, kind, createdAt, before, after } (atomic, fsync)
//   3. guidance     the slot's guidance entry is published with transitionOpId = opId
//   4. config       the staged sandbox is applied with lastTransitionOpId = opId and saved; that marker on the saved sandbox IS the commit
//   5. clear        the pending record is removed, then the receipt is recorded
//
// Recovery (at load, before any slot starts): every record is validated first; a malformed record is kept as evidence and its slot is blocked.
// Config carries the opId -> committed: the entry carrying the opId stays; an entry that is genuinely absent is republished from the `after`
// snapshot; an entry without the opId is kept only when it is provably a LATER normal save (no marker, saved at or after the `after` entry),
// otherwise the slot is blocked and the record kept. Never replay the old snapshot over a later operator save.
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
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hasText = value => typeof value === 'string' && value.length > 0;
const KINDS = new Set(['switch', 'reapply']);

/** Why a pending record cannot be interpreted (null when it is well formed). `key` is the slot id it is stored under. */
export function pendingRecordProblem(key, record) {
  if (!isPlainObject(record)) return 'the record is not an object';
  if (!hasText(record.opId)) return 'the record has no operation id';
  if (!hasText(record.sandboxId) || record.sandboxId !== key) return 'the record names a different slot than the one it is stored under';
  if (!KINDS.has(record.kind)) return 'the record has an unsupported kind';
  if (!hasText(record.createdAt)) return 'the record has no creation time';
  for (const side of ['before', 'after']) {
    const part = record[side];
    if (!isPlainObject(part)) return `the record has no ${side} snapshot`;
    for (const field of ['agent', 'permissions', 'heartbeat', 'tradingGuidance']) {
      if (!isPlainObject(part[field])) return `the ${side} snapshot has no ${field}`;
    }
    if (typeof part.guidanceTouched !== 'boolean') return `the ${side} snapshot does not say whether guidance was touched`;
    if (!('guidanceEntry' in part)) return `the ${side} snapshot has no guidance entry field`;
    if (part.guidanceEntry !== null && !isPlainObject(part.guidanceEntry)) return `the ${side} guidance entry is not an object`;
  }
  if (record.before.guidanceTouched !== record.after.guidanceTouched) return 'the before and after snapshots disagree about guidance';
  if (record.after.guidanceTouched) {
    if (!record.after.guidanceEntry || record.after.guidanceEntry.transitionOpId !== record.opId) return 'the after guidance entry does not belong to this operation';
    if (record.before.guidanceEntry && record.before.guidanceEntry.transitionOpId === record.opId) return 'the before guidance entry belongs to this operation';
  } else if (record.before.guidanceEntry !== null || record.after.guidanceEntry !== null) return 'guidance entries are present although guidance was not touched';
  return null;
}
let pendingQueue = Promise.resolve();
const queued = task => { const run = pendingQueue.catch(() => {}).then(task); pendingQueue = run; return run; };

async function readPendingFile() {
  let text;
  try { text = await fs.readFile(pendingPath(), 'utf8'); } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, records: {} };
    throw error;
  }
  const parsed = JSON.parse(text);
  if (!isPlainObject(parsed) || parsed.version !== 1 || !isPlainObject(parsed.records)) throw new Error('pending record file has an unexpected shape');
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
    await fault('afterConfigSave'); // tests only: the save reached disk, then reported an error (an ambiguous publication)
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
    // The restored pair must be confirmed on disk: this save also scrubs any copy of the rejected state that reached the disk (the staged
    // config may have been published before the error). When it fails the disk may still hold the staged config, so the record stays.
    try { await fault('compensationSave'); await t.save(); } catch (error) { restored = false; reason = `the restored settings could not be confirmed on disk: ${error.message}`; }
  }
  if (restored) {
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
    const problem = pendingRecordProblem(sandboxId, record);
    if (problem) {
      // Evidence is kept as it is. The slot it is stored under is blocked, and so is the slot it names when that differs.
      const reason = `the pending settings record is malformed (${problem}); it is kept for review`;
      const ids = new Set([sandboxId]);
      if (hasText(record?.sandboxId)) ids.add(record.sandboxId);
      for (const id of ids) { gate.block(id, reason); outcome.blocked.push(id); }
      log(`[slot-transition] ${sandboxId}: ${reason}; slot blocked`);
      continue;
    }
    try {
      const sandbox = getSandbox(sandboxId);
      const entry = getSavedGuidanceEntry(sandboxId);
      if (sandbox) {
        const committed = sandbox.lastTransitionOpId === record.opId;
        if (record.after.guidanceTouched) {
          if (committed) {
            if (!entry) await replaceGuidanceEntryForSandbox(sandboxId, record.after.guidanceEntry); // genuinely absent: repair
            else if (entry.transitionOpId !== record.opId && !isLaterSave(entry, record)) {
              throw new Error('the saved Trading Guidance entry belongs to neither this change nor a provably later save');
            }
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

/** A normal operator save replaces the whole entry: it carries no operation marker and is stamped at or after this change's own entry. */
function isLaterSave(entry, record) {
  if (!isPlainObject(entry) || entry.transitionOpId !== undefined) return false;
  const saved = Date.parse(entry.updatedAt);
  const staged = Date.parse(record.after.guidanceEntry.updatedAt);
  return Number.isFinite(saved) && Number.isFinite(staged) && saved >= staged;
}
