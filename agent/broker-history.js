import { ALPACA_PAPER_TRADING_URL } from './defaults.js';

const PAGE_LIMIT = 500;

function first(order, ...keys) {
  for (const key of keys) if (order?.[key] !== undefined && order?.[key] !== null) return order[key];
  return undefined;
}

// Keep all broker sources on the internal ledger shape. Alpaca's direct API is
// snake_case while the local/runtime ledger uses the historical capitalized
// fields. Do not pass either provider representation through to consumers.
export function normalizeBrokerOrder(order) {
  if (!order || typeof order !== 'object') return null;
  return {
    ID: first(order, 'ID', 'id', 'brokerOrderId', 'broker_order_id') || null,
    ClientOrderID: first(order, 'ClientOrderID', 'clientOrderId', 'client_order_id') || null,
    Symbol: first(order, 'Symbol', 'symbol') || null,
    Side: first(order, 'Side', 'side') || null,
    Status: first(order, 'Status', 'status') || null,
    FilledQty: first(order, 'FilledQty', 'filledQty', 'filled_qty'),
    FilledAvgPrice: first(order, 'FilledAvgPrice', 'filledAvgPrice', 'filled_avg_price'),
    FilledAt: first(order, 'FilledAt', 'filledAt', 'filled_at') || null,
    SubmittedAt: first(order, 'SubmittedAt', 'submittedAt', 'submitted_at') || null,
  };
}

export function matchBrokerOrder(localOrder, brokerOrders = []) {
  const candidates = new Set();
  for (const identity of [localOrder?.ID, localOrder?.ClientOrderID, localOrder?.id, localOrder?.client_order_id]) {
    const value = String(identity || '').trim();
    if (!value) continue;
    for (const brokerOrder of brokerOrders) {
      if (String(brokerOrder?.ID || '').trim() === value || String(brokerOrder?.ClientOrderID || '').trim() === value) {
        candidates.add(brokerOrder);
      }
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

// A broker identity is ambiguous if one broker ID or client-order ID points
// at more than one order. Keep the entire identity out of the verified view;
// never let insertion order decide which record wins.
export function excludeBrokerIdentityCollisions(brokerOrders = []) {
  const byBrokerId = new Map();
  const byClientOrderId = new Map();
  const signatures = new Map();
  const add = (index, map, value) => {
    const key = String(value || '').trim();
    if (!key) return;
    const signature = `${brokerOrders[index]?.ID || ''}\u0000${brokerOrders[index]?.ClientOrderID || ''}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(index);
    signatures.set(index, signature);
  };
  brokerOrders.forEach((order, index) => {
    add(index, byBrokerId, order?.ID);
    add(index, byClientOrderId, order?.ClientOrderID);
  });
  const ambiguous = new Set();
  for (const map of [byBrokerId, byClientOrderId]) {
    for (const indexes of map.values()) {
      const identities = new Set([...indexes].map(index => signatures.get(index)));
      if (identities.size > 1) indexes.forEach(index => ambiguous.add(index));
    }
  }
  return {
    orders: brokerOrders.filter((_, index) => !ambiguous.has(index)),
    collisions: ambiguous.size > 0,
    ambiguousKeys: new Set([...ambiguous].flatMap(index => [brokerOrders[index]?.ID, brokerOrders[index]?.ClientOrderID].filter(Boolean).map(String))),
  };
}

function apiError(response, body) {
  const detail = body && typeof body === 'object' ? (body.message || body.code) : body;
  return new Error(`Alpaca history request failed (${response.status})${detail ? `: ${detail}` : ''}`);
}

async function readJson(response) {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw apiError(response, body);
  return body;
}

export async function readPaperAccountOrderHistory(account, { fetchImpl = globalThis.fetch } = {}) {
  if (!account?.paper) throw new Error('verified broker history only supports paper accounts');
  if (!account.publicKey || !account.secretKey || !account.brokerAccountId) {
    throw new Error('paper account credentials and broker account identity are required');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');

  const headers = {
    'APCA-API-KEY-ID': account.publicKey,
    'APCA-API-SECRET-KEY': account.secretKey,
    Accept: 'application/json',
  };
  const request = async (pathname, params) => {
    const url = new URL(`${ALPACA_PAPER_TRADING_URL}${pathname}`);
    for (const [key, value] of Object.entries(params || {})) if (value !== undefined) url.searchParams.set(key, value);
    const response = await fetchImpl(url, { method: 'GET', headers });
    return { body: await readJson(response), headers: response.headers };
  };

  const { body: providerAccount } = await request('/v2/account');
  if (String(providerAccount?.id || '') !== String(account.brokerAccountId)) {
    throw new Error(`broker account identity mismatch: expected ${account.brokerAccountId}, got ${providerAccount?.id || 'missing'}`);
  }

  const orders = [];
  let afterOrderId;
  const seenCursors = new Set();
  while (true) {
    let body;
    try {
      ({ body } = await request('/v2/orders', {
      status: 'all',
      direction: 'asc',
      limit: PAGE_LIMIT,
      after_order_id: afterOrderId,
      }));
    } catch (err) {
      return { orders, complete: false, broker_state: 'incomplete', error: err.message, providerAccountId: providerAccount.id, paper: true };
    }
    const page = Array.isArray(body) ? body : body?.orders;
    if (!Array.isArray(page)) {
      return { orders, complete: false, broker_state: 'incomplete', error: 'Alpaca order history response was not an array', providerAccountId: providerAccount.id, paper: true };
    }
    orders.push(...page.map(normalizeBrokerOrder).filter(Boolean));
    if (page.length < PAGE_LIMIT) return { orders, complete: true, broker_state: 'available', providerAccountId: providerAccount.id, paper: true };
    const nextCursor = normalizeBrokerOrder(page[page.length - 1])?.ID;
    if (!nextCursor || seenCursors.has(nextCursor) || nextCursor === afterOrderId) {
      return { orders, complete: false, broker_state: 'incomplete', error: 'Alpaca order history pagination did not advance', providerAccountId: providerAccount.id, paper: true };
    }
    seenCursors.add(nextCursor);
    afterOrderId = nextCursor;
  }
}
