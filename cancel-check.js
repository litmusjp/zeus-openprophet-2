// Read-only follow-up for cancelled option exits. Pure functions: the caller supplies broker reads.
// Nothing here blocks or changes a cancel; it only describes what is still held and still working.
// Anything missing, incomplete, malformed or contradictory yields verified:false, never zero or "flat".
const OCC = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'replaced']);
const CANCELLED = new Set(['canceled', 'cancelled', 'expired']);

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
// Finite number or null (unknown). Strings that are not numbers, empty values and NaN are unknown, not zero.
const known = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) ? Number(v) : null;

export function normalizeOrder(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  return {
    id: String(pick(o, 'order_id', 'ID', 'id') ?? ''),
    symbol: String(pick(o, 'symbol', 'Symbol') ?? ''),
    side: String(pick(o, 'side', 'Side') ?? '').toLowerCase(),
    intent: String(pick(o, 'position_intent', 'PositionIntent') ?? '').toLowerCase(),
    status: String(pick(o, 'status', 'Status') ?? '').toLowerCase(),
    qty: known(pick(o, 'qty', 'Qty')),
    filled: known(pick(o, 'filled_qty', 'FilledQty')),
  };
}

// For identifying one order in a list (used before the cancel). Accepts an array or the wrapped response.
export const ordersFrom = data => (Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : []).map(normalizeOrder).filter(Boolean);

// True when this order is a sell-to-close on an option contract (OCC symbol).
export function isOptionExitOrder(order) {
  if (!order || !OCC.test(order.symbol)) return false;
  return order.intent ? order.intent.includes('sell_to_close') : order.side === 'sell';
}

export function unverifiedPostCancelCheck(contract, reason) {
  return {
    verified: false,
    contract,
    note: `Unverified: ${String(reason instanceof Error ? reason.message : reason).slice(0, 200)}. Do not submit a duplicate exit; reconcile with get_orders and get_options_positions first.`,
  };
}

/**
 * @param {object} p
 * @param {object} p.order          normalized order read before the cancel
 * @param {object} p.ordersResponse raw /orders?status=all response: {orders, complete, broker_state}
 * @param {Array}  p.positions      raw /options/positions response (an array)
 */
export function buildPostCancelCheck({ order, ordersResponse, positions }) {
  const fail = reason => unverifiedPostCancelCheck(order.symbol, reason);
  if (!ordersResponse || typeof ordersResponse !== 'object' || Array.isArray(ordersResponse) || !Array.isArray(ordersResponse.orders)) {
    return fail('the broker order list had no recognisable wrapped response');
  }
  if (ordersResponse.complete !== true || ordersResponse.broker_state !== 'available') {
    return fail(`the broker order list is incomplete (complete=${ordersResponse.complete}, broker_state=${ordersResponse.broker_state}); other working exits cannot be ruled out`);
  }
  if (!Array.isArray(positions)) return fail('the options positions response was not a list');
  const allOrders = ordersResponse.orders.map(normalizeOrder);
  if (allOrders.some(o => o === null)) return fail('the broker order list contained an unreadable record');
  const same = allOrders.find(o => o.id === order.id);
  if (!same) return fail('the cancelled order was not found in the broker order list');
  if (same.filled === null || same.status === '') return fail('the cancelled order has an unknown status or filled quantity');
  if (same.qty !== null && (same.filled < 0 || same.filled > same.qty)) return fail('the cancelled order reports a contradictory filled quantity');

  let held = 0;
  for (const p of positions) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) return fail('an options position record was unreadable');
    const sym = pick(p, 'symbol', 'Symbol');
    if (typeof sym !== 'string' || sym === '') return fail('an options position record had no symbol');
    if (sym !== order.symbol) continue;
    const qty = known(pick(p, 'qty', 'Qty'));
    if (qty === null || qty < 0) return fail('the position for this contract has an unknown or invalid quantity');
    if (String(pick(p, 'side', 'Side') ?? 'long').toLowerCase() !== 'short') held += qty;
  }

  let otherExits = 0;
  for (const o of allOrders) {
    if (o.id === order.id || o.symbol !== order.symbol || !isOptionExitOrder(o) || TERMINAL.has(o.status)) continue;
    if (o.qty === null || o.filled === null || o.qty < 0 || o.filled < 0 || o.filled > o.qty) {
      return fail('another working exit order on this contract has an unknown or invalid quantity');
    }
    otherExits += o.qty - o.filled;
  }

  const status = same.status;
  const cancelConfirmed = CANCELLED.has(status) || status === 'filled';
  const unreserved = Math.max(0, held - otherExits);
  const out = {
    verified: true,
    contract: order.symbol,
    cancelled_order_status: status,
    cancelled_order_filled_qty: same.filled,
    cancel_confirmed_terminal: cancelConfirmed,
    held_qty_after_cancel: held,
    other_working_exit_qty: otherExits,
    unreserved_held_qty: unreserved,
  };
  if (!cancelConfirmed) {
    out.note = `The cancel is not confirmed terminal (status ${status}). Do not submit a replacement yet; reconcile fills and orders first.`;
  } else if (held > 0 && unreserved > 0) {
    out.note = `Position still open: ${held} contract(s) held and no working exit covers ${unreserved}. If your exit plan still requires closing, follow the replacement rule and replace only the ${unreserved} verified contract(s). This is a snapshot, not a reservation; reconcile again before submitting.`;
  } else if (held > 0) {
    out.note = 'Position still open, but other working exit orders already cover it. No replacement needed.';
  } else {
    out.note = 'No position remains in this contract (it filled or was already closed). No replacement needed; reconcile fills before logging.';
  }
  return out;
}
