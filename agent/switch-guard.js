// A slot may only switch to an agent whose strategy never opens options when the slot holds no option exposure: with options off the
// trading backend refuses every option order, closes included, so a held option or spread would sit until it expires. Pure helper;
// the route reads the slot's positions, orders and spread groups and passes them in. Anything unreadable counts as "held".

const OCC_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const TERMINAL_ORDER = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'replaced', 'void']);

function listOf(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  return null;
}

/** Returns a reason string when option exposure may be held (or could not be read), else null. */
export function optionExposureReason({ positions, orders, ordersComplete, groups } = {}) {
  const held = listOf(positions, 'positions');
  if (held === null) return 'option positions could not be read';
  if (held.length) return `it holds ${held.length} option position${held.length === 1 ? '' : 's'}`;
  const orderList = listOf(orders, 'orders');
  if (orderList === null || ordersComplete !== true) return 'open orders could not be fully read';
  const openOption = orderList.filter(order => order
    && (order.asset_class === 'us_option' || OCC_SYMBOL.test(String(order.symbol || '')))
    && !TERMINAL_ORDER.has(String(order.status || '').toLowerCase()));
  if (openOption.length) return `it has ${openOption.length} open option order${openOption.length === 1 ? '' : 's'}`;
  const groupList = listOf(groups, 'groups');
  if (groupList === null) return 'spread groups could not be read';
  const live = groupList.filter(group => group && ['pending_entry', 'open', 'broken'].includes(group.status));
  if (live.length) return `it holds ${live.length} two-leg spread group${live.length === 1 ? '' : 's'}`;
  return null;
}

export const SWITCH_REFUSAL_PREFIX = 'Switch refused: the new agent never opens options, so this slot must hold none (its trading backend would refuse every option order, closes included). Close them with the current agent first; ';
