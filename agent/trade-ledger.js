// Build realized trades from broker-confirmed filled orders.
// Orders are matched FIFO per symbol; unmatched/open lots are not assigned P/L.

function field(order, upper, lower) {
  return order?.[upper] ?? order?.[lower];
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function timeOf(order) {
  return field(order, 'FilledAt', 'filledAt') || field(order, 'SubmittedAt', 'submittedAt') || null;
}

function orderIdentity(order) {
  return String(field(order, 'ClientOrderID', 'clientOrderId')
    || field(order, 'ID', 'id') || '').trim();
}

function isFilled(order) {
  const status = String(field(order, 'Status', 'status') || '').toLowerCase().replace(/-/g, '_');
  if (['new', 'accepted', 'pending_new', 'open', 'pending', 'pending_cancel', 'pending_replace', 'submission_uncertain'].includes(status)) {
    return false;
  }
  if (!['filled', 'partially_filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done_for_day', 'replaced', 'stopped'].includes(status)) {
    return false;
  }
  const quantity = number(field(order, 'FilledQty', 'filledQty'));
  const price = number(field(order, 'FilledAvgPrice', 'filledAvgPrice'));
  return quantity !== null && quantity > 0 && price !== null && price > 0;
}

function canonicalSymbol(symbol) {
  const upper = String(symbol || '').toUpperCase().trim();
  const match = /^([A-Z0-9. ]{1,6})(\d{6})([CP])(\d{8})$/.exec(upper);
  if (!match) return upper;
  return `${match[1].replace(/\s+/g, '')}${match[2]}${match[3]}${match[4]}`;
}

function isOption(symbol) {
  return canonicalSymbol(symbol) !== String(symbol || '').toUpperCase().trim()
    ? true
    : /^[A-Z0-9.]{1,6}\d{6}[CP]\d{8}$/.test(canonicalSymbol(symbol));
}

export function buildTradeLedger(orders = [], metadata = {}) {
  const unique = new Map();
  for (const order of orders.filter(isFilled)) {
    const identity = orderIdentity(order);
    if (!identity) continue;
    const current = unique.get(identity);
    const quantity = number(field(order, 'FilledQty', 'filledQty')) || 0;
    const currentQuantity = current ? number(field(current, 'FilledQty', 'filledQty')) || 0 : -1;
    if (!current || quantity >= currentQuantity) unique.set(identity, order);
  }
  const sorted = [...unique.values()]
    .map(order => ({ order, time: timeOf(order), sortTime: Date.parse(timeOf(order) || '') || 0 }))
    .sort((a, b) => a.sortTime - b.sortTime);
  const lots = new Map();
  const realized = [];

  for (const { order, time } of sorted) {
    const symbol = canonicalSymbol(field(order, 'Symbol', 'symbol'));
    const side = String(field(order, 'Side', 'side') || '').toLowerCase();
    if (!symbol || (side !== 'buy' && side !== 'sell')) continue;
    let remaining = number(field(order, 'FilledQty', 'filledQty'));
    const price = number(field(order, 'FilledAvgPrice', 'filledAvgPrice'));
    const multiplier = isOption(symbol) ? 100 : 1;
    const queue = lots.get(symbol) || [];

    while (remaining > 0 && queue.length && queue[0].side !== side) {
      const lot = queue[0];
      const quantity = Math.min(remaining, lot.quantity);
      const pnl = lot.side === 'buy'
        ? (price - lot.price) * quantity * multiplier
        : (lot.price - price) * quantity * multiplier;
      const entryValue = lot.price * quantity * multiplier;
      realized.push({
        id: `${orderIdentity(order)}:${lot.orderId}`,
        orderId: field(order, 'ID', 'id') || orderIdentity(order) || null,
        entryOrderId: lot.orderId,
        symbol,
        side,
        quantity,
        entryPrice: lot.price,
        exitPrice: price,
        pnl: Number(pnl.toFixed(8)),
        pnlPercent: entryValue ? Number(((pnl / entryValue) * 100).toFixed(4)) : null,
        entryTime: lot.time,
        exitTime: time,
        timestamp: time,
        status: 'realized',
        assetType: multiplier === 100 ? 'option' : 'stock',
        ...metadata,
      });
      remaining -= quantity;
      lot.quantity -= quantity;
      if (lot.quantity <= 1e-10) queue.shift();
    }

    if (remaining > 0) {
      queue.push({
        orderId: field(order, 'ID', 'id') || orderIdentity(order) || null,
        side,
        quantity: remaining,
        price,
        time,
      });
    }
    lots.set(symbol, queue);
  }

  return realized.sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || ''));
}
