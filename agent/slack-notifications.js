const ET = 'America/New_York';

function etParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function zonedTimeToUtc(year, month, day, hour, minute) {
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = etParts(new Date(candidate));
    const represented = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    candidate += desired - represented;
  }
  return new Date(candidate);
}

export function nextDailySummaryAt(now = new Date()) {
  const local = etParts(new Date(now));
  let day = new Date(Date.UTC(+local.year, +local.month - 1, +local.day));
  let next = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 16, 30);
  if (next <= new Date(now)) {
    day.setUTCDate(day.getUTCDate() + 1);
    next = zonedTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), 16, 30);
  }
  return next;
}

export function easternDate(date = new Date()) {
  const parsed = new Date(date);
  if (!Number.isFinite(parsed.getTime())) return null;
  const local = etParts(parsed);
  return `${local.year}-${local.month}-${local.day}`;
}

export function shouldNotifyTradeLifecycle(watermarks, event) {
  if (!(watermarks instanceof Map)) return true;
  const identity = [event?.accountId, event?.orderId].map(value => String(value || '')).join(':');
  if (!identity || identity === ':') return true;
  const snapshot = [event?.lifecycle || event?.status || 'unknown', event?.filledQty ?? ''].join(':');
  if (watermarks.get(identity) === snapshot) return false;
  watermarks.set(identity, snapshot);
  if (watermarks.size > 4000) watermarks.delete(watermarks.keys().next().value);
  return true;
}

const display = value => value === undefined || value === null || value === '' ? 'Unavailable' : String(value);
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const money = value => `$${Number(value).toFixed(2)}`;

export function createSlackDailyCollector({ getSandbox, getAccount, getClient, reconcile, buildLedger, now = () => new Date() }) {
  return async function collectSlackDailySummary(sandboxId, at = now()) {
    const sandbox = getSandbox(sandboxId);
    const accountConfig = sandbox?.accountId ? getAccount(sandbox.accountId) : null;
    const date = easternDate(at);
    let account = null;
    let positions = null;
    let reconciliation = { orders: [], complete: false };
    const client = getClient(sandboxId);
    if (client) {
      const results = await Promise.allSettled([
        client.get('/api/v1/account', { timeout: 5000 }),
        client.get('/api/v1/positions', { timeout: 5000 }),
      ]);
      if (results[0].status === 'fulfilled') account = results[0].value.data;
      if (results[1].status === 'fulfilled') {
        const value = results[1].value.data;
        positions = Array.isArray(value) ? value : Array.isArray(value?.positions) ? value.positions : null;
      }
    }
    if (sandbox && accountConfig) reconciliation = await reconcile(sandbox, accountConfig);
    const orders = (reconciliation.orders || []).map(order => ({
      ...order,
      inSummaryWindow: order.broker_identity_verified === true && Number(order.FilledQty) > 0
        && Boolean(order.FilledAt) && easternDate(order.FilledAt) === date,
    }));
    const fillDatesComplete = (reconciliation.orders || []).every(order => {
      const raw = order.FilledQty;
      const filled = raw === undefined || raw === null || raw === '' ? 0 : Number(raw);
      return Number.isFinite(filled) && filled >= 0 && (filled <= 0
        || (order.broker_identity_verified === true && Boolean(order.FilledAt) && Boolean(easternDate(order.FilledAt))));
    });
    const trades = reconciliation.complete ? buildLedger(orders).map(trade => ({
      ...trade, inSummaryWindow: Boolean(trade.exitTime && easternDate(trade.exitTime) === date),
    })) : null;
    const accountWindowMatches = easternDate(now()) === date;
    const complete = reconciliation.complete === true && fillDatesComplete;
    const summary = formatDailySummary({
      date, accountName: accountConfig?.name, complete,
      account: accountWindowMatches ? account : null,
      positions: accountWindowMatches ? positions : null,
      orders, trades,
    });
    return { date, accountName: accountConfig?.name || 'Unavailable', complete, orders, trades, summary };
  };
}

export async function runDailySummaryTick({ sandboxId, at, enabled, collect, deliver, onSuccess, onError, reschedule }) {
  try {
    if (enabled(sandboxId)) {
      const report = await collect(sandboxId, at);
      if (await deliver(report.summary, sandboxId)) onSuccess?.();
    }
  } catch (error) {
    try { onError?.(error); } catch { /* error reporting cannot block the next schedule */ }
  } finally {
    try { reschedule(); } catch (error) { try { onError?.(error); } catch { /* keep scheduler callback contained */ } }
  }
}

export function formatTradeSlackNotification(trade = {}) {
  const a = trade.assessment || {};
  const lines = [
    `*Order ${display(trade.lifecycle || trade.status)}*`,
    `Account: ${display(trade.account)} | Agent: ${display(trade.agent)}`,
    `Requested: ${display(trade.side).toUpperCase()} ${display(trade.requestedQty)} × ${display(trade.symbol)}`,
    `Broker status: ${display(trade.status)}`,
    `Broker-confirmed fill: ${trade.brokerIdentityVerified === true && validNumber(trade.confirmedQty) && Number(trade.confirmedQty) > 0 ? `${display(trade.confirmedQty)}${validNumber(trade.averageFillPrice) ? ` @ ${money(Number(trade.averageFillPrice))}` : ''}` : trade.brokerIdentityVerified === true && validNumber(trade.confirmedQty) && Number(trade.confirmedQty) === 0 ? 'No fill reported' : 'Unavailable'}`,
    `Order ID: ${display(trade.brokerOrderId)} | Time: ${display(trade.timestamp)}`,
    `At-entry assessment: ${display(a.decision)} | Signal score: ${finite(a.signalScore, 0, 100) ? `${a.signalScore}/100` : 'Unavailable'}`,
    `Catalyst confidence: ${finite(a.catalystConfidence, 0, 1) ? `${(a.catalystConfidence * 100).toFixed(0)}%` : 'Unavailable'} | Directional momentum contribution: ${a.scoreProfile === 'catalyst_momentum_v1' && finite(a.directionalMomentum, 0, 0.2) ? `${a.directionalMomentum} of 0.20 weighted fraction` : 'Unavailable'}`,
    `Score profile: ${display(a.scoreProfile)} | Source: ${display(a.scoreSource ?? a.scoreType)} | At-entry observed: ${display(a.observedAt)}`,
  ];
  return lines.join('\n');
}

function validNumber(value) { return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)); }

function validAccountDaily(account) {
  const equityRaw = account?.Equity ?? account?.equity;
  const lastRaw = account?.LastEquity ?? account?.last_equity;
  const equity = Number(equityRaw);
  const last = Number(lastRaw);
  const valid = account?.DailyPnLValid ?? account?.daily_pnl_valid;
  return valid === true && validNumber(equityRaw) && equity > 0 && validNumber(lastRaw) && last > 0
    ? { equity, change: equity - last, percent: ((equity - last) / last) * 100 }
    : null;
}

export function formatDailySummary({ date, accountName, complete, account, positions, orders, trades } = {}) {
  const daily = validAccountDaily(account);
  const lines = [`*Daily Summary — ${display(date)} ET (00:00–23:59)*`, `Account: ${display(accountName)} (account-wide)`];
  lines.push(daily
    ? `Daily account-wide change: ${daily.change >= 0 ? '+' : '-'}${money(Math.abs(daily.change))} (${daily.percent >= 0 ? '+' : ''}${daily.percent.toFixed(2)}%) | Equity: ${money(daily.equity)} | Cash: ${validNumber(account?.Cash ?? account?.cash) ? money(Number(account.Cash ?? account.cash)) : 'Unavailable'}`
    : 'Daily account change: Unavailable');
  lines.push(`Positions: ${Array.isArray(positions) ? (positions.length ? positions.map(p => {
    const unrealized = p.unrealized_pl ?? p.UnrealizedPL;
    const quantity = p.quantity ?? p.qty ?? p.Qty;
    return `${display(p.symbol || p.Symbol)} ${validNumber(quantity) ? String(quantity) : 'Unavailable'} (unrealized P/L ${validNumber(unrealized) ? money(Number(unrealized)) : 'Unavailable'})`;
  }).join('; ') : 'None reported') : 'Incomplete'}`);
  if (complete === true && Array.isArray(orders) && Array.isArray(trades)) {
    const todayOrders = [...new Map(orders.filter(order => order?.broker_identity_verified === true && order?.inSummaryWindow === true && validNumber(order?.FilledQty) && Number(order.FilledQty) > 0 && order?.FilledAt).map(order => [String(order.ID || order.ClientOrderID || ''), order]).filter(([id]) => id)).values()];
    const todayTrades = trades.filter(trade => trade?.inSummaryWindow === true);
    const realized = todayTrades.every(trade => validNumber(trade.pnl))
      ? money(todayTrades.reduce((sum, trade) => sum + Number(trade.pnl), 0)) : 'Unavailable';
    lines.push(`Order activity: ${todayOrders.length} broker-confirmed orders with fills`);
    lines.push(`Matched realized P/L before fees: ${realized}`);
  } else {
    lines.push('Order activity: Incomplete');
    lines.push('Matched realized P/L before fees: Incomplete');
  }
  return lines.join('\n');
}

export function sanitizeSlackFailure(error) {
  let message = String(error?.message || error || 'delivery failed');
  message = message.replace(/https?:\/\/\S+/gi, '[endpoint]')
    .replace(/hooks\.slack\.com\S*/gi, '[endpoint]')
    .replace(/\b[A-Z0-9]{8,}\b/gi, '[redacted]')
    .replace(/[\r\n\t]+/g, ' ');
  return message.slice(0, 160);
}
