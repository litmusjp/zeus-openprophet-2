// Read-only follow-up for cancelled option exits. Pure functions: the caller supplies broker reads.
// Nothing here blocks or changes a cancel; it only describes what is still held and still working.
const OCC = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const TERMINAL = new Set(['filled', 'canceled', 'cancelled', 'expired', 'rejected', 'done_for_day', 'replaced']);
const CANCELLED = new Set(['canceled', 'cancelled', 'expired']);

const pick = (o, ...keys) => { for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

export function normalizeOrder(o) {
  if (!o || typeof o !== 'object') return null;
  return {
    id: String(pick(o, 'order_id', 'ID', 'id') ?? ''),
    symbol: String(pick(o, 'symbol', 'Symbol') ?? ''),
    side: String(pick(o, 'side', 'Side') ?? '').toLowerCase(),
    intent: String(pick(o, 'position_intent', 'PositionIntent') ?? '').toLowerCase(),
    status: String(pick(o, 'status', 'Status') ?? '').toLowerCase(),
    qty: num(pick(o, 'qty', 'Qty')),
    filled: num(pick(o, 'filled_qty', 'FilledQty')),
  };
}

export const ordersFrom = data => (Array.isArray(data) ? data : Array.isArray(data?.orders) ? data.orders : []).map(normalizeOrder).filter(Boolean);

// True when this order is a sell-to-close on an option contract (OCC symbol).
export function isOptionExitOrder(order) {
  if (!order || !OCC.test(order.symbol)) return false;
  return order.intent ? order.intent.includes('sell_to_close') : order.side === 'sell';
}

/**
 * @param {object} p
 * @param {object} p.order      normalized order read before the cancel
 * @param {Array}  p.ordersAfter normalized orders read after the cancel (status all or open+recent)
 * @param {Array}  p.positions  raw options positions
 */
export function buildPostCancelCheck({ order, ordersAfter, positions }) {
  const same = ordersAfter.find(o => o.id === order.id);
  const status = same ? same.status : null;
  const filled = same ? same.filled : null;
  const cancelConfirmed = status ? CANCELLED.has(status) || (status === 'filled') : false;
  const held = (Array.isArray(positions) ? positions : [])
    .filter(p => String(pick(p, 'symbol', 'Symbol') ?? '') === order.symbol && String(pick(p, 'side', 'Side') ?? 'long').toLowerCase() !== 'short')
    .reduce((sum, p) => sum + num(pick(p, 'qty', 'Qty')), 0);
  const otherExits = ordersAfter
    .filter(o => o.id !== order.id && o.symbol === order.symbol && isOptionExitOrder(o) && !TERMINAL.has(o.status))
    .reduce((sum, o) => sum + Math.max(0, o.qty - o.filled), 0);
  const unreserved = Math.max(0, held - otherExits);
  const out = {
    verified: Boolean(same),
    contract: order.symbol,
    cancelled_order_status: status,
    cancelled_order_filled_qty: filled,
    cancel_confirmed_terminal: cancelConfirmed,
    held_qty_after_cancel: held,
    other_working_exit_qty: otherExits,
    unreserved_held_qty: unreserved,
  };
  if (!same) {
    out.note = 'Unverified: the cancelled order was not found in the broker order list. Reconcile with get_orders and get_options_positions before any replacement; do not submit a duplicate exit.';
  } else if (!cancelConfirmed) {
    out.note = `The cancel is not confirmed terminal (status ${status}). Do not submit a replacement yet; reconcile fills and orders first.`;
  } else if (held > 0 && unreserved > 0) {
    out.note = `Position still open: ${held} contract(s) held and no working exit covers ${unreserved}. If your exit plan still requires closing, follow the replacement rule and replace only the ${unreserved} verified contract(s).`;
  } else if (held > 0) {
    out.note = 'Position still open, but other working exit orders already cover it. No replacement needed.';
  } else {
    out.note = 'No position remains in this contract (it filled or was already closed). No replacement needed; reconcile fills before logging.';
  }
  return out;
}

export function unverifiedPostCancelCheck(contract, error) {
  return {
    verified: false,
    contract,
    note: `Unverified: could not read the broker state after the cancel (${String(error).slice(0, 160)}). Do not submit a duplicate exit; reconcile with get_orders and get_options_positions.`,
  };
}
