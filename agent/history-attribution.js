const SUBMITTING_TOOLS = new Set([
  'place_buy_order', 'place_sell_order', 'place_options_order',
  'place_managed_position', 'close_managed_position',
]);
const ORDER_ID_FIELDS = [
  'order_id', 'orderId', 'OrderID', 'OrderId', 'broker_order_id', 'brokerOrderId', 'BrokerOrderID',
  'ID', 'id', 'ClientOrderID', 'client_order_id', 'clientOrderId',
];
const RESULT_ORDER_ID_FIELDS = new Set(ORDER_ID_FIELDS.filter(key => !['ID', 'id'].includes(key)));

function actorOf(message, session) {
  const snapshot = message?.actorSnapshot;
  const explicit = snapshot && (Object.hasOwn(snapshot, 'agentId') || Object.hasOwn(snapshot, 'agentName'));
  const value = explicit ? snapshot : session?.metadata;
  if (value?.metadata?.mode === 'manager' || session?.metadata?.mode === 'manager') return null;
  if (typeof value?.agentId !== 'string' || !value.agentId || typeof value?.agentName !== 'string' || !value.agentName) return null;
  return { agentId: value.agentId, agentName: value.agentName };
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length > 128 * 1024) return null;
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
  catch { return null; }
}

function findIds(value, output = new Set(), depth = 0, inOrderObject = false) {
  if (typeof value === 'string') {
    if (depth > 4) return output;
    const parsed = parseObject(value);
    return parsed ? findIds(parsed, output, depth + 1, inOrderObject) : output;
  }
  if (!value || typeof value !== 'object' || depth > 4) return output;
  for (const [key, item] of Object.entries(value)) {
    const orderObject = inOrderObject || /^(order|brokerOrder|broker_order)$/i.test(key);
    if ((RESULT_ORDER_ID_FIELDS.has(key) || orderObject && ['ID', 'id'].includes(key)) && typeof item === 'string' && item.trim() && item.length <= 256) output.add(item.trim());
    else if (key === 'text' && value.type === 'text' && typeof item === 'string') {
      const structured = parseObject(item);
      if (structured) findIds(structured, output, depth + 1, inOrderObject);
    }
    else if (item && typeof item === 'object') findIds(item, output, depth + 1, orderObject);
  }
  return output;
}

function executionEvidence(record) {
  const tool = String(record?.tool || record?.name || '').replace(/^prophet_/, '');
  if (!SUBMITTING_TOOLS.has(tool) || record?.resultTruncated || record?.error) return [];
  if (record?.status && !['completed', 'success'].includes(String(record.status).toLowerCase())) return [];
  const result = parseObject(record?.result);
  if (!result || result.isError === true || result.error) return [];
  const returnedIds = findIds(result);
  if (!returnedIds.size) return [];
  const args = record?.args && typeof record.args === 'object' && !Array.isArray(record.args) ? record.args : {};
  const clientId = ['client_order_id', 'clientOrderId', 'client_reference', 'clientReference']
    .map(key => args[key]).find(value => typeof value === 'string' && value.trim() && value.length <= 256);
  if (clientId) returnedIds.add(clientId.trim());
  return [...returnedIds];
}

export function buildOrderActorMap(accountId, sessions = []) {
  const map = new Map();
  const add = (id, actor) => {
    const key = `${accountId}\0${id}`;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(`${actor.agentId}\0${actor.agentName}`, actor);
  };
  for (const session of sessions) {
    if (session?.accountId && session.accountId !== accountId) continue;
    for (const message of session?.messages || []) {
      if (message?.kind !== 'tool_call' && message?.eventType !== 'tool_call') continue;
      const actor = actorOf(message, session);
      if (!actor) continue;
      for (const id of executionEvidence(message)) add(id, actor);
    }
  }
  return map;
}

export function resolveOrderActor(map, accountId, order) {
  const ids = new Set(ORDER_ID_FIELDS.map(key => order?.[key]).filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()));
  const actors = new Map();
  for (const id of ids) for (const [key, actor] of map.get(`${accountId}\0${id}`) || []) actors.set(key, actor);
  return actors.size === 1 ? [...actors.values()][0] : null;
}

export async function loadOrderActorMap(chatStore, accountId, { sessionLimit = 100, messagesPerSession = 500 } = {}) {
  const sessions = await chatStore.listOrderActorEvidence(accountId, { sessionLimit, recordLimit: messagesPerSession });
  return buildOrderActorMap(accountId, sessions);
}
