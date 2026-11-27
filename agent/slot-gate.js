// Per-slot transition gate (switch-profile plan 3.3). In-process only, dependency-free so the harness can import it.
//
//  - A hold is taken at route entry, BEFORE the busy check and the exposure read, and kept through validation, both writes,
//    compensation and the runtime refresh. Only one hold per slot exists at a time: a second one is refused (the route answers 409).
//  - Holds of kind 'switch' and 'reapply' also defer beats on that slot. Holds of kind 'write' (ordinary same-slot writers) only exclude
//    other writers: a short settings save never stops a beat.
//  - 'notReady' = the settings committed but the runtime did not restart/refresh: beats stay refused until a later restart succeeds or
//    the operator stops the slot.
//  - 'blocked' = a failed compensation or recovery: beats AND starts are refused until it is resolved (a restart re-runs recovery).
//
// Lock order for the whole feature (nothing may take them in another order):
//    slot gate -> spread-cap controller queue (guidance PUT only) -> guidance store queue -> saveConfig.
import { randomUUID } from 'node:crypto';

export const TRANSITION_BUSY_MESSAGE = 'slot settings transition in progress';
const BEAT_BLOCKING_KINDS = new Set(['switch', 'reapply']);

export function createSlotGate() {
  const held = new Map();
  const notReady = new Map();
  const blocked = new Map();
  return {
    /** Takes the hold for a slot, or returns null when the slot already has one (or is blocked). */
    acquire(sandboxId, kind) {
      const id = String(sandboxId || '');
      if (!id || held.has(id) || blocked.has(id)) return null;
      const entry = { opId: randomUUID(), kind, startedAt: new Date().toISOString() };
      held.set(id, entry);
      return {
        ...entry,
        release() { if (held.get(id) === entry) held.delete(id); },
      };
    },
    held(sandboxId) { return held.get(String(sandboxId || '')) || null; },
    markNotReady(sandboxId, reason) { notReady.set(String(sandboxId), { reason: String(reason || 'settings saved; the agent has not restarted') }); },
    clearNotReady(sandboxId) { return notReady.delete(String(sandboxId)); },
    notReady(sandboxId) { return notReady.get(String(sandboxId)) || null; },
    block(sandboxId, reason) { blocked.set(String(sandboxId), { reason: String(reason || 'slot settings need recovery') }); },
    unblock(sandboxId) { return blocked.delete(String(sandboxId)); },
    blocked(sandboxId) { return blocked.get(String(sandboxId)) || null; },
    /** Why a beat on this slot must not start now, or null. `hard` also refuses a start. */
    beatBlock(sandboxId) {
      const id = String(sandboxId || '');
      if (!id) return null;
      const block = blocked.get(id);
      if (block) return { reason: `slot settings transition blocked: ${block.reason}`, hard: true };
      const hold = held.get(id);
      if (hold && BEAT_BLOCKING_KINDS.has(hold.kind)) return { reason: TRANSITION_BUSY_MESSAGE, hard: false };
      const pending = notReady.get(id);
      if (pending) return { reason: `settings saved but the agent has not restarted: ${pending.reason}`, hard: false };
      return null;
    },
    reset() { held.clear(); notReady.clear(); blocked.clear(); },
  };
}

export const slotGate = createSlotGate();
