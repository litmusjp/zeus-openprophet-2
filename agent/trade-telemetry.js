const field = (value, ...names) => names.map(name => value?.[name]).find(item => item !== undefined && item !== null);
const orderId = value => field(value, 'orderId', 'order_id', 'OrderID', 'ID', 'id');
const clientOrderId = value => field(value, 'clientOrderId', 'client_order_id', 'ClientOrderID', 'clientOrderID');
const number = value => value === undefined || value === null || value === '' ? NaN : Number(value);
const epsilon = 1e-9;

function tradeKey(trade) {
  return [trade?.accountId, trade?.sandboxId, trade?.agentId, trade?.orderId].join('\u0000');
}

export function mergeTradeUpdate(trades, trade, countedExecutions = new Set()) {
  const index = trade?.orderId ? trades.findIndex(existing => tradeKey(existing) === tradeKey(trade)) : -1;
  const canCount = item => Boolean(item?.orderId && item.accountId && item.sandboxId && item.agentId);
  const nextTrades = [...trades];
  let updated = trade;
  if (index >= 0) {
    const previous = trades[index];
    if (previous.executionConfirmed === true && trade.executionConfirmed !== true) updated = previous;
    else if (previous.executionConfirmed === true && trade.executionConfirmed === true) {
      const oldQty = number(previous.quantity);
      const nextQty = number(trade.quantity);
      const oldTime = Date.parse(previous.filledAt || '');
      const nextTime = Date.parse(trade.filledAt || '');
      if ((previous.fullFill === true && trade.fullFill !== true)
        || (Number.isFinite(oldQty) && Number.isFinite(nextQty) && nextQty + epsilon < oldQty)
        || (Number.isFinite(oldTime) && Number.isFinite(nextTime) && nextTime < oldTime)) updated = previous;
      else updated = { ...previous, ...trade };
    } else updated = { ...previous, ...trade };
    nextTrades[index] = updated;
  } else nextTrades.unshift(trade);

  let newlyConfirmed = 0;
  if (updated?.executionConfirmed === true && canCount(updated)) {
    const key = tradeKey(updated);
    if (!countedExecutions.has(key)) {
      countedExecutions.add(key);
      newlyConfirmed = 1;
    }
  }
  return { trades: nextTrades.slice(0, 50), trade: updated, newlyConfirmed };
}

function exactPositiveQuantity(value) {
  const qty = number(value);
  return Number.isFinite(qty) && qty > 0 ? qty : NaN;
}

export function reconcilePendingTrades({ trades, orders, ordersComplete, accountId, sandboxId, agentId }) {
  if (ordersComplete !== true || !Array.isArray(orders) || !accountId || !sandboxId || !agentId) return [];
  const updates = [];
  for (const trade of trades || []) {
    if (trade.lifecycle !== 'submitted' && trade.executionConfirmed !== true) continue;
    if (trade.accountId !== accountId || trade.sandboxId !== sandboxId || trade.agentId !== agentId
      || !trade.orderId || !trade.symbol || !trade.side) continue;
    const matches = orders.filter(order => orderId(order) === trade.orderId);
    if (matches.length !== 1) continue;
    const order = matches[0];
    const brokerClientId = clientOrderId(order);
    if ((trade.clientOrderId && brokerClientId !== trade.clientOrderId)
      || field(order, 'symbol', 'Symbol') !== trade.symbol
      || String(field(order, 'side', 'Side') || '').toLowerCase() !== String(trade.side).toLowerCase()) continue;

    // Native server snapshots carry these four fields from the persisted broker ledger.
    // Historical replay may add them only from its source-verified account wrapper.
    const rowTenantId = field(order, 'TenantID', 'tenant_id');
    const rowSandboxId = field(order, 'SandboxID', 'sandbox_id');
    const rowPaperLive = String(field(order, 'PaperLive', 'paper_live') || '').toLowerCase();
    const rowBrokerAccountId = field(order, 'BrokerAccountID', 'broker_account_id');
    if (rowTenantId !== accountId || rowSandboxId !== sandboxId || rowPaperLive !== 'paper' || !rowBrokerAccountId) continue;
    if ((trade.tenantId && trade.tenantId !== rowTenantId)
      || (trade.sandboxId && trade.sandboxId !== rowSandboxId)
      || (trade.paperLive && String(trade.paperLive).toLowerCase() !== rowPaperLive)
      || (trade.brokerAccountId && trade.brokerAccountId !== rowBrokerAccountId)) continue;

    const status = String(field(order, 'Status', 'status') || '').toLowerCase();
    const requestedQty = exactPositiveQuantity(trade.requestedQuantity ?? trade.quantity);
    const brokerQty = exactPositiveQuantity(field(order, 'Qty', 'qty'));
    const filledQty = exactPositiveQuantity(field(order, 'FilledQty', 'filled_qty', 'filledQty'));
    const price = exactPositiveQuantity(field(order, 'FilledAvgPrice', 'filled_avg_price', 'filledAvgPrice'));
    const filledAt = field(order, 'FilledAt', 'filled_at', 'filledAt');
    const acceptedStatuses = ['filled', 'partially_filled', 'canceled', 'cancelled', 'rejected', 'expired', 'done_for_day', 'replaced'];
    if (!acceptedStatuses.includes(status) || !Number.isFinite(requestedQty) || !Number.isFinite(brokerQty)
      || Math.abs(requestedQty - brokerQty) > epsilon || !Number.isFinite(filledQty) || filledQty > requestedQty + epsilon
      || !Number.isFinite(price) || typeof filledAt !== 'string' || !Number.isFinite(Date.parse(filledAt))) continue;
    const fullFill = filledQty >= requestedQty - epsilon;
    if (status === 'filled' && !fullFill) continue;
    const currentQty = trade.executionConfirmed === true ? number(trade.quantity) : NaN;
    const oldTime = Date.parse(trade.filledAt || '');
    const newTime = Date.parse(filledAt);
    if ((Number.isFinite(currentQty) && filledQty + epsilon < currentQty)
      || (trade.fullFill === true && !fullFill)
      || (Number.isFinite(oldTime) && newTime < oldTime)) continue;
    updates.push({
      orderId: trade.orderId,
      status,
      lifecycle: fullFill ? 'filled' : `partially_filled_${status}`,
      executionConfirmed: true,
      fullFill,
      quantity: filledQty,
      price,
      filledAt,
    });
  }
  return updates;
}
