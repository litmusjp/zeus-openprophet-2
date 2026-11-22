// A slot may only switch to an agent whose strategy never opens options when the slot holds no option exposure: with options off the
// trading backend refuses every option order, closes included, so a held option or spread would sit until it expires. The guard reads
// the slot's positions, orders and spread groups as the Go backend serialises them (Go's Order struct has no JSON tags, so its fields
// arrive as Symbol/AssetClass/Status; the group endpoint uses snake_case). Anything unreadable or unknown counts as "held".

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const TERMINAL_ORDER = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'replaced', 'void']);
const LIVE_GROUP_STATUS = ['pending_entry', 'open', 'broken'];

const norm = key => String(key).toLowerCase().replace(/_/g, '');

/** Reads a field whatever its casing (Symbol, symbol, asset_class, AssetClass all match 'asset_class'). */
export function pick(object, name) {
  if (!object || typeof object !== 'object') return undefined;
  const want = norm(name);
  for (const key of Object.keys(object)) if (norm(key) === want) return object[key];
  return undefined;
}

function listOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  return null;
}

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * True only for a group that the ledger proves is flat history: status open, the entry fully filled (it cannot still be filling),
 * every filled unit closed, no open units and no working or uncertain close order. Any missing or non-numeric field means "not
 * flat": an unsettled entry, an uncertain close or a resolver can still matter.
 */
export function isFlatTerminalGroup(group) {
  if (!group || pick(group, 'status') !== 'open') return false;
  const entryUnits = num(pick(group, 'entry_units'));
  const entryFilled = num(pick(group, 'entry_filled_units'));
  const closed = num(pick(group, 'closed_units'));
  const open = num(pick(group, 'open_units'));
  if (entryUnits === null || entryFilled === null || closed === null || open === null) return false;
  return entryUnits > 0 && entryFilled >= entryUnits && closed >= entryFilled && open === 0 && pick(group, 'close_order_pending') === false;
}

/** Returns a reason string when option exposure may be held (or could not be read), else null. */
export function optionExposureReason({ positions, orders, ordersComplete, groups } = {}) {
  const held = listOf(positions, 'positions');
  if (held === null) return 'option positions could not be read';
  if (held.length) return `it holds ${held.length} option position${held.length === 1 ? '' : 's'}`;
  const orderList = listOf(orders, 'orders');
  if (orderList === null || ordersComplete !== true) return 'open orders could not be fully read';
  const openOption = orderList.filter(order => order && typeof order === 'object'
    && (String(pick(order, 'asset_class') || '').toLowerCase() === 'us_option' || OCC_SYMBOL.test(String(pick(order, 'symbol') || '')))
    && !TERMINAL_ORDER.has(String(pick(order, 'status') || '').toLowerCase()));
  if (openOption.length) return `it has ${openOption.length} open option order${openOption.length === 1 ? '' : 's'}`;
  const groupList = listOf(groups, 'groups');
  if (groupList === null) return 'spread groups could not be read';
  const live = groupList.filter(group => group && LIVE_GROUP_STATUS.includes(pick(group, 'status')) && !isFlatTerminalGroup(group));
  if (live.length) return `it holds ${live.length} two-leg spread group${live.length === 1 ? '' : 's'}`;
  return null;
}

export const SWITCH_REFUSAL_PREFIX = 'Switch refused: the new agent never opens options, so this slot must hold none (its trading backend would refuse every option order, closes included). Close them with the current agent first; ';

/**
 * The logic of both agent-switch routes. Computes the permission patch the switch would apply; only when it turns options off does it
 * read the slot's exposure, and a reason (or an unreadable slot) refuses with status 409 BEFORE `save` is called. Otherwise it
 * returns what `save()` returns.
 */
export async function runGuardedSwitch({ sandboxId, activeAgentId, overrides, previewPatch, readExposure, save }) {
  if (sandboxId && activeAgentId) {
    const patch = previewPatch(sandboxId, activeAgentId, overrides);
    if (patch?.allowOptions === false) {
      let reason;
      try { reason = optionExposureReason(await readExposure()); } catch { reason = 'its option exposure could not be read'; }
      if (reason) {
        const error = new Error(`${SWITCH_REFUSAL_PREFIX}${reason}.`);
        error.status = 409;
        throw error;
      }
    }
  }
  return save();
}
