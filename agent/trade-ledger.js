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

function entryAssessment(order) {
  const value = order?.entry_assessment;
  if (order?.broker_identity_verified !== true || order?.Purpose !== 'entry' || !value || typeof value !== 'object') return null;
  if (typeof value.assessmentId !== 'string' || !value.assessmentId || !['PASS', 'FAIL', 'UNAVAILABLE'].includes(value.decision)) return null;
  const score = value.signalScore;
  if (score !== null && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) return null;
  const safe = item => typeof item === 'string' && item.length <= 128 ? item : null;
  const confidence = value.catalystConfidence;
  return { assessmentId: value.assessmentId.slice(0, 128), decision: value.decision, signalScore: score,
    scoreSource: safe(value.scoreType), scoreProfile: safe(value.scoreProfile), observedAt: safe(value.observedAt), effectiveExpiresAt: safe(value.effectiveExpiresAt),
    ...(typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? { catalystConfidence: confidence } : {}) };
}

// A multi-leg (spread) order is one trade in the ledger: its key is its sorted leg symbols, an opening is a buy at the net
// debit and a closing is a sell at the net credit (both positive magnitudes), so a closed spread realises
// (credit - debit) x units x 100. Orders without legs are never affected. A spread whose legs neither all open nor all close is skipped.
function spreadOrder(order) {
  const legs = order?.option_legs ?? order?.OptionLegs;
  if (!Array.isArray(legs) || legs.length < 2) return null;
  const symbols = legs.map(leg => canonicalSymbol(leg?.symbol ?? leg?.Symbol)).filter(Boolean);
  if (symbols.length !== legs.length) return null;
  const intents = legs.map(leg => String(leg?.position_intent ?? leg?.PositionIntent ?? '').toLowerCase());
  const opening = intents.every(intent => intent.endsWith('_to_open'));
  const closing = intents.every(intent => intent.endsWith('_to_close'));
  if (!opening && !closing) return null;
  return { symbol: `spread:${[...symbols].sort().join('+')}`, side: opening ? 'buy' : 'sell', legs: [...symbols].sort() };
}

export function buildTradeLedger(orders = [], metadata = {}) {
  const recordMetadata = { ...metadata };
  delete recordMetadata.agentId;
  delete recordMetadata.agentName;
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
    const spread = spreadOrder(order);
    const hasLegs = Array.isArray(order?.option_legs ?? order?.OptionLegs) && (order.option_legs ?? order.OptionLegs).length >= 2;
    if (hasLegs && !spread) continue; // mixed or unreadable legs: never attributed as a single-leg trade
    const symbol = spread ? spread.symbol : canonicalSymbol(field(order, 'Symbol', 'symbol'));
    const side = spread ? spread.side : String(field(order, 'Side', 'side') || '').toLowerCase();
    if (!symbol || (side !== 'buy' && side !== 'sell')) continue;
    let remaining = number(field(order, 'FilledQty', 'filledQty'));
    const price = number(field(order, 'FilledAvgPrice', 'filledAvgPrice'));
    const multiplier = spread || isOption(symbol) ? 100 : 1;
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
        ...(spread ? { structure: 'spread', legs: spread.legs } : {}),
        entryAssessment: lot.entryAssessment,
        ...recordMetadata,
        agentId: lot.agentId,
        agentName: lot.agentName || 'Unknown historical agent',
        entryAgentId: lot.agentId,
        entryAgentName: lot.agentName || null,
        exitAgentId: order.actorSnapshot?.agentId || null,
        exitAgentName: order.actorSnapshot?.agentName || null,
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
        entryAssessment: side === 'buy' ? entryAssessment(order) : null,
        agentId: order.actorSnapshot?.agentId || null,
        agentName: order.actorSnapshot?.agentName || null,
      });
    }
    lots.set(symbol, queue);
  }

  return realized.sort((a, b) => Date.parse(b.timestamp || '') - Date.parse(a.timestamp || ''));
}
