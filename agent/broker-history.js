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

function boundedAssessment(order) {
  if (order?.Purpose !== 'entry' || order?.PaperLive !== 'paper' || !order?.BrokerAccountID || !order?.TenantID || !order?.SandboxID) return null;
  const raw = order.Metadata ?? order.metadata;
  if (typeof raw !== 'string' || raw.length > 65536) return null;
  let doc;
  try { doc = JSON.parse(raw); } catch { return null; }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.assessment_id !== 'string' || !doc.assessment_id || !['PASS','FAIL','UNAVAILABLE'].includes(doc.decision)) return null;
  const score = doc.signal_score;
  if (score !== undefined && (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) return null;
  const evidence = doc.evidence && typeof doc.evidence === 'object' && !Array.isArray(doc.evidence) ? doc.evidence : {};
  const safeText = value => typeof value === 'string' && value.length <= 128 ? value : null;
  return {
    assessmentId: doc.assessment_id.slice(0, 128), decision: doc.decision,
    signalScore: score === undefined ? null : score,
    scoreProfile: safeText(evidence.score_profile), scoreType: safeText(evidence.score_source),
    observedAt: safeText(doc.observed_at), effectiveExpiresAt: safeText(doc.op2_effective_expires_at),
  };
}

// Attach context only when one identity-scoped local entry row uniquely maps
// to one already-verified broker order. A broker collision is never resolved here.
export function entryAssessmentsByBroker(localOrders = [], brokerOrders = [], identity = {}) {
  const exactBrokerMatch = local => {
    const broker = matchBrokerOrder(local, brokerOrders);
    if (!broker) return null;
    const orderIds = [local?.ID, local?.id].map(value => String(value || '').trim()).filter(Boolean);
    const clientOrderIds = [local?.ClientOrderID, local?.client_order_id].map(value => String(value || '').trim()).filter(Boolean);
    if (orderIds.some(value => String(broker.ID || '').trim() !== value)) return null;
    if (clientOrderIds.some(value => String(broker.ClientOrderID || '').trim() !== value)) return null;
    return broker;
  };
  const candidates = new Map();
  for (const local of localOrders) {
    if (local?.Purpose !== 'entry' || local?.BrokerAccountID !== identity.brokerAccountId || local?.PaperLive !== 'paper' || local?.TenantID !== identity.tenantId || local?.SandboxID !== identity.sandboxId) continue;
    const broker = exactBrokerMatch(local);
    if (!broker) continue;
    candidates.set(broker, (candidates.get(broker) || 0) + 1);
  }
  const output = new Map();
  for (const local of localOrders) {
    if (local?.Purpose !== 'entry' || local?.BrokerAccountID !== identity.brokerAccountId || local?.PaperLive !== 'paper' || local?.TenantID !== identity.tenantId || local?.SandboxID !== identity.sandboxId) continue;
    const assessment = boundedAssessment(local);
    const broker = assessment && exactBrokerMatch(local);
    if (assessment && broker && candidates.get(broker) === 1) output.set(broker, assessment);
  }
  return output;
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
