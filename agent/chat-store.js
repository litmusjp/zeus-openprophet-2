// Chat History Store - Persists conversations per account/session
// JSONL format for efficient append-only writes
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import readline from 'node:readline';
import { fileURLToPath } from 'url';
import { isSubmittingOrderToolCall } from './history-attribution.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
function isAdoptionDecisionCall(row) {
  if (row?.kind !== 'tool_call' && row?.eventType !== 'tool_call') return false;
  if (String(row.tool || '').replace(/^prophet_/, '') !== 'log_decision') return false;
  if (row.status && !['completed', 'success'].includes(String(row.status).toLowerCase())) return false;
  return String(row.args?.action || '').toUpperCase() === 'ADOPT' && typeof row.args?.symbol === 'string' && row.args.symbol.trim() !== '';
}

export function isValidHistoryAccountId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }

function hasStructuredFailure(record) {
  if (String(record.kind || '').includes('failure') || record.isError === true) return true;
  if (record.status && /^(error|failed)$/i.test(String(record.status))) return true;
  const nonempty = value => value != null && value !== false && value !== '' && !(typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);
  if (nonempty(record.error)) return true;
  const inspect = (value, depth = 0) => {
    if (depth > 5 || value == null) return false;
    if (typeof value === 'string') {
      try { return inspect(JSON.parse(value), depth + 1); } catch { return false; }
    }
    if (Array.isArray(value)) return value.some(item => inspect(item, depth + 1));
    if (typeof value !== 'object') return false;
    if (value.isError === true || nonempty(value.error) || ['error', 'failed'].includes(String(value.status || '').toLowerCase())) return true;
    return inspect(value.content, depth + 1) || inspect(value.result, depth + 1) || inspect(value.data, depth + 1) || inspect(value.text, depth + 1);
  };
  return inspect(record.result);
}

// Optional research tools (news and summaries). A provider outage here is shown as a warning on the
// activity; it must not mark the whole activity Failed/Error. Every other failure (broker, orders,
// account, risk, data, chain, assessment, heartbeat) keeps the Failed/Error treatment.
const OPTIONAL_RESEARCH_TOOLS = new Set([
  'get_alpaca_news', 'get_news', 'get_news_by_topic', 'search_news', 'get_market_news', 'get_cleaned_news',
  'get_quick_market_intelligence', 'aggregate_and_summarize_news', 'list_news_summaries', 'get_news_summary',
  'get_marketwatch_topstories', 'get_marketwatch_realtime', 'get_marketwatch_bulletins',
]);
function optionalResearchToolName(record) {
  if (!record || (record.kind !== 'tool_call' && record.eventType !== 'tool_call')) return null;
  const name = String(record.tool || '').replace(/^prophet_/, '');
  return OPTIONAL_RESEARCH_TOOLS.has(name) ? name : null;
}
// A single-position lookup returns 404 once a position is closed. That is only a warning when the same
// activity also reconciled the account: the options-positions list no longer holds the contract and a
// filled order for it is present. Otherwise the 404 stays an essential failure.
const POSITION_NOT_FOUND_WARNING = 'get_options_position not found after confirmed close';
function parseJsonish(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
function isReconciledPositionNotFound(record, records) {
  if (!record || (record.kind !== 'tool_call' && record.eventType !== 'tool_call')) return false;
  if (String(record.tool || '').replace(/^prophet_/, '') !== 'get_options_position') return false;
  const text = String(record.error || '') + ' ' + (typeof record.result === 'string' ? record.result : JSON.stringify(record.result || ''));
  if (!/no open position found|options position not found|"status":\s*404|\b404\b/i.test(text)) return false;
  const symbol = String(record.args?.symbol || record.input?.symbol || '').trim();
  if (!symbol) return false;
  const named = name => records.filter(r => (r.kind === 'tool_call' || r.eventType === 'tool_call') && String(r.tool || '').replace(/^prophet_/, '') === name && !hasStructuredFailure(r));
  const lists = named('get_options_positions');
  const absent = lists.some(r => {
    const rows = parseJsonish(r.result);
    return Array.isArray(rows) && !rows.some(row => String(row?.Symbol || row?.symbol || '') === symbol);
  });
  if (!absent) return false;
  return named('get_orders').some(r => {
    const body = parseJsonish(r.result);
    const orders = Array.isArray(body?.orders) ? body.orders : Array.isArray(body) ? body : [];
    return orders.some(order => String(order?.Symbol || order?.symbol || '') === symbol
      && String(order?.Status || order?.status || '').toLowerCase() === 'filled'
      && Number(order?.FilledQty ?? order?.filled_qty ?? 0) > 0
      // A filled opening is not a close: only a closing fill can confirm that a position is gone. The intent must be unambiguous.
      && isClosingIntent(order));
  });
}
// An acknowledged opening order that has not filled yet has no position, so the single-position lookup answers 404. That is
// only a warning when the activity itself proves it: the one acknowledgement of the contract (order id and client order id,
// still working, filled quantity exactly 0) and a later, successful, complete broker read showing the same order, identified by
// both ids, still working with exactly 0 filled. Missing, unreadable, incomplete or contradictory evidence leaves the 404 an
// essential failure, and a missing or invalid quantity never counts as zero.
const UNFILLED_OPENING_WARNING = 'get_options_position not found while opening order unfilled';
const WORKING_ORDER_STATUSES = new Set(['new', 'accepted', 'pending_new']);
const isToolCallRecord = record => !!record && (record.kind === 'tool_call' || record.eventType === 'tool_call');
const toolNameOf = record => String(record?.tool || '').replace(/^prophet_/, '');
const trimmedText = value => (typeof value === 'string' ? value.trim() : '');
const isExactZero = value => typeof value === 'number' && Number.isFinite(value) && value === 0;
const trimNormal = value => (typeof value === 'string' ? value.trim() : value);
const lowerNormal = value => (typeof value === 'string' ? value.trim().toLowerCase() : value);
// An order row may spell a field two ways (the Go name and the snake_case name). Both present and different is ambiguous: neither
// spelling is trusted and nothing falls through from one to the other. One spelling, or two equal spellings, is fine.
function fieldOf(row, names, normalise = value => value) {
  const values = names.map(name => row?.[name]).filter(value => value !== undefined).map(normalise);
  return { present: values.length > 0, ambiguous: values.some(value => value !== values[0]), value: values[0] };
}
function isClosingIntent(order) {
  const intent = fieldOf(order, ['PositionIntent', 'position_intent'], lowerNormal);
  return !intent.ambiguous && ['sell_to_close', 'buy_to_close'].includes(intent.value);
}
function isPositionNotFoundRecord(record) {
  if (!isToolCallRecord(record) || toolNameOf(record) !== 'get_options_position') return false;
  const text = String(record.error || '') + ' ' + (typeof record.result === 'string' ? record.result : JSON.stringify(record.result || ''));
  return /no open position found|options position not found|"status":\s*404|\b404\b/i.test(text);
}
function ordersFromRead(record) {
  const body = parseJsonish(record.result);
  const orders = Array.isArray(body?.orders) ? body.orders : Array.isArray(body) ? body : null;
  return { body, orders };
}
function isUnfilledOpeningPositionNotFound(record, records) {
  if (!isPositionNotFoundRecord(record)) return false;
  const symbol = trimmedText(record.args?.symbol ?? record.input?.symbol);
  const at = records.indexOf(record);
  if (!symbol || at < 0) return false;
  // Exactly one acknowledgement of this contract before the lookup: a guarded buy_to_open that did not fail.
  const placed = records.slice(0, at).filter(r => isToolCallRecord(r) && toolNameOf(r) === 'place_options_order' && trimmedText(r.args?.symbol) === symbol);
  if (placed.length !== 1) return false;
  const [ack] = placed;
  if (hasStructuredFailure(ack) || String(ack.args?.position_intent || '').toLowerCase() !== 'buy_to_open') return false;
  const ackBody = parseJsonish(ack.result);
  if (!ackBody || typeof ackBody !== 'object' || Array.isArray(ackBody)) return false;
  const orderId = trimmedText(ackBody.order_id);
  const clientId = trimmedText(ackBody.client_order_id);
  if (!orderId || !clientId) return false;
  if (ackBody.symbol !== undefined && trimmedText(ackBody.symbol) !== symbol) return false;
  if (!WORKING_ORDER_STATUSES.has(String(ackBody.status || '').toLowerCase())) return false;
  if (!isExactZero(ackBody.filled_qty)) return false;
  // A row belongs to the order when either spelling of its id matches; it is then consistent only if no field is ambiguous.
  const sameOrder = orders => orders.filter(order => [order?.ID, order?.order_id].some(value => trimmedText(value) === orderId));
  const consistent = order => {
    const id = fieldOf(order, ['ID', 'order_id'], trimNormal);
    const client = fieldOf(order, ['ClientOrderID', 'client_order_id'], trimNormal);
    const sym = fieldOf(order, ['Symbol', 'symbol'], trimNormal);
    const intent = fieldOf(order, ['PositionIntent', 'position_intent'], lowerNormal);
    const filled = fieldOf(order, ['FilledQty', 'filled_qty']);
    const state = fieldOf(order, ['Status', 'status'], lowerNormal);
    return [id, client, sym, intent, filled, state].every(field => !field.ambiguous)
      && id.value === orderId && client.value === clientId && sym.value === symbol
      && (!intent.present || intent.value === 'buy_to_open')
      && filled.present && isExactZero(filled.value)
      && !['filled', 'partially_filled'].includes(state.value);
  };
  let confirmed = false;
  const reads = records.filter(r => isToolCallRecord(r) && toolNameOf(r) === 'get_orders' && !hasStructuredFailure(r));
  for (const read of reads) {
    const { body, orders } = ordersFromRead(read);
    if (!orders) continue;
    const mine = sameOrder(orders);
    // A contradiction anywhere in the activity (another client id, a fill, a bad quantity) rules the warning out.
    if (mine.some(order => !consistent(order))) return false;
    const complete = body && !Array.isArray(body) && body.broker_state === 'available' && body.complete === true;
    const working = mine.length === 1 && WORKING_ORDER_STATUSES.has(fieldOf(mine[0], ['Status', 'status'], lowerNormal).value);
    if (records.indexOf(read) > at && complete && working) confirmed = true;
  }
  if (!confirmed) return false;
  // The contract must not be held, and every successful positions read must be readable.
  for (const read of records.filter(r => isToolCallRecord(r) && toolNameOf(r) === 'get_options_positions' && !hasStructuredFailure(r))) {
    const rows = parseJsonish(read.result);
    if (!Array.isArray(rows)) return false;
    if (rows.some(row => [row?.Symbol, row?.symbol].some(value => trimmedText(value) === symbol))) return false;
  }
  return true;
}
// get_options_chain answers HTTP 503 with category market_closed before the regular session. Only that exact structured answer is a
// warning, and only when NOTHING else in the evidence says otherwise: the answer (the result or the error, or both) may be the payload
// itself or the payload inside the content/result/data wrappers, and every other key, part or string beside it (an authentication or
// transport category, an error, an isError flag, a status, prose, a second payload) makes the whole answer essential. Finding a
// market_closed fragment somewhere inside a failure is never enough.
const MARKET_CLOSED_CHAIN_WARNING = 'get_options_chain unavailable while market closed';
const CHAIN_WRAPPER_KEYS = new Set(['content', 'result', 'data', 'text', 'type', 'isError']);
// The payload itself is exactly what the backend produces for the options chain while the market is closed (controllers/order_controller.go:
// status, category, endpoint, next_open, error) plus the http_status the MCP server adds. A payload that carries any other property (a nested
// data, content or result, an isError flag, a message) or any other value is not a market-closed answer: it is checked as a whole, never
// recognised by its category alone, so nothing nested inside it can escape the checks.
const CHAIN_PAYLOAD_KEYS = new Set(['category', 'endpoint', 'error', 'next_open', 'status', 'http_status']);
const CHAIN_CLOSED_TEXT = 'options chain is unavailable while the regular market is closed';
function isExactMarketClosedPayload(value) {
  return Object.keys(value).every(key => CHAIN_PAYLOAD_KEYS.has(key))
    && value.category === 'market_closed'
    && (value.endpoint === undefined || value.endpoint === 'options_chain')
    && (value.status === undefined || value.status === 'market_closed')
    && (value.http_status === undefined || value.http_status === 503)
    && (value.error === undefined || value.error === CHAIN_CLOSED_TEXT)
    && (value.next_open === undefined || value.next_open === null || typeof value.next_open === 'string');
}
function scanChainAnswer(value, found, depth = 0) {
  if (value == null || value === '') return;
  if (depth > 5) { found.bad = true; return; }
  if (typeof value === 'string') {
    let parsed;
    try { parsed = JSON.parse(value); } catch { found.bad = true; return; } // prose is not structured evidence
    scanChainAnswer(parsed, found, depth + 1);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) scanChainAnswer(item, found, depth + 1); return; }
  if (typeof value !== 'object') { found.bad = true; return; }
  if (value.category === 'market_closed') {
    if (isExactMarketClosedPayload(value)) found.payloads += 1; else found.bad = true;
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (!CHAIN_WRAPPER_KEYS.has(key)) { found.bad = true; continue; }
    if (key === 'isError') { if (child !== false) found.bad = true; continue; }
    if (key === 'type') { if (child !== 'text') found.bad = true; continue; }
    scanChainAnswer(child, found, depth + 1);
  }
}
function isMarketClosedChain(record) {
  if (!isToolCallRecord(record) || toolNameOf(record) !== 'get_options_chain' || record.isError === true) return false;
  let payloads = 0;
  for (const source of [record.result, record.error]) {
    const found = { payloads: 0, bad: false };
    scanChainAnswer(source, found);
    if (found.bad || found.payloads > 1) return false;
    payloads += found.payloads;
  }
  return payloads >= 1;
}
// A guarded opening order that AlphaDesk refused (FAIL or UNAVAILABLE) before anything reached the broker, or that
// OP2 refused locally for its contract limit, is a normal outcome, not a failed heartbeat. Anything else about an
// order (unknown submission state, authentication, broker errors, a fill) keeps the Failed/Error treatment.
const AD_BLOCK_PREFIX = 'AlphaDesk blocked';
function adPreBrokerBlock(record) {
  if (!record || (record.kind !== 'tool_call' && record.eventType !== 'tool_call')) return null;
  if (String(record.tool || '').replace(/^prophet_/, '') !== 'place_options_order') return null;
  const text = (String(record.error || '') + ' ' + (typeof record.result === 'string' ? record.result : JSON.stringify(record.result || ''))).replace(/\\+"/g, '"');
  if (/limited to 1-10 contracts per order/.test(text) && /"execution_confirmed":\s*false/.test(text)) return `${AD_BLOCK_PREFIX} (quantity limit)`;
  const decision = (text.match(/"assessment_decision":\s*"(FAIL|UNAVAILABLE)"/) || [])[1];
  if (!decision) return null;
  if (!/"execution_confirmed":\s*false/.test(text) || !/"filled_qty":\s*0(?![.\d])/.test(text)) return null;
  return `${AD_BLOCK_PREFIX} (${decision})`;
}
/** Split an activity's failing records into essential failures and optional-research warnings. */
function classifyFailures(records) {
  const essential = [];
  const warnings = [];
  for (const record of records) {
    if (!hasStructuredFailure(record)) continue;
    const optional = optionalResearchToolName(record);
    if (optional) warnings.push(optional);
    else if (isReconciledPositionNotFound(record, records)) warnings.push(POSITION_NOT_FOUND_WARNING);
    else if (adPreBrokerBlock(record)) warnings.push(adPreBrokerBlock(record));
    else if (isUnfilledOpeningPositionNotFound(record, records)) warnings.push(UNFILLED_OPENING_WARNING);
    else if (isMarketClosedChain(record)) warnings.push(MARKET_CLOSED_CHAIN_WARNING);
    else essential.push(record);
  }
  return { essential, warnings: [...new Set(warnings)] };
}
const EXACT_WARNINGS = new Set([POSITION_NOT_FOUND_WARNING, UNFILLED_OPENING_WARNING, MARKET_CLOSED_CHAIN_WARNING]);
function activityOutcome({ recovery, status, essential, warnings }) {
  // A warning is appended to a Recorded or Recovered outcome, so it is never hidden by a recorded order status or a recovery.
  // An essential failure that was not recovered is never hidden: a recorded status or a recovery marker does not erase it, and
  // warnings are not shown next to a Failed outcome. Only a heartbeat_failure is recovered by a heartbeat_recovery of the same
  // activity; any other essential failure (a cancel, an account read, an order) stays a failure.
  const adBlocks = warnings.filter(w => w.startsWith(AD_BLOCK_PREFIX));
  const unavailable = warnings.filter(w => !EXACT_WARNINGS.has(w) && !w.startsWith(AD_BLOCK_PREFIX));
  const parts = [];
  if (unavailable.length) parts.push(`${unavailable.join(', ')} unavailable`);
  if (adBlocks.length) parts.push(adBlocks.join('; '));
  if (warnings.includes(POSITION_NOT_FOUND_WARNING)) parts.push(POSITION_NOT_FOUND_WARNING);
  if (warnings.includes(UNFILLED_OPENING_WARNING)) parts.push(UNFILLED_OPENING_WARNING);
  if (warnings.includes(MARKET_CLOSED_CHAIN_WARNING)) parts.push(MARKET_CLOSED_CHAIN_WARNING);
  const warning = parts.length ? ` (warning: ${parts.join('; ')})` : '';
  const residual = recovery ? essential.filter(record => record?.kind !== 'heartbeat_failure') : essential;
  if (residual.length) return status ? `Failed (recorded: ${status})` : 'Failed';
  if (recovery) return `Recovered${warning}`;
  if (status) return `Recorded: ${status}${warning}`;
  return `Recorded${warning}`;
}

function recordedToolStatus(record) {
  const accepted = new Set(['accepted', 'rejected', 'uncertain', 'filled', 'partially_filled', 'canceled', 'cancelled', 'expired', 'pending', 'submitted']);
  let result = record.result;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { break; } }
    if (!result || typeof result !== 'object') break;
    const status = typeof result.status === 'string' ? result.status.toLowerCase() : '';
    if (accepted.has(status)) return status;
    result = result.content || result.result || result.data;
  }
  const direct = String(record.status || '').toLowerCase();
  return accepted.has(direct) ? direct : null;
}

export class ChatStore {
  constructor(dataDir = DATA_DIR) {
    this.dataDir = dataDir;
    this._writeQueues = new Map(); // accountId -> Promise chain
  }

  // ── Paths ────────────────────────────────────────────────────────

  _sandboxDir(accountId) {
    return path.join(this.dataDir, 'sandboxes', accountId);
  }

  _chatDir(accountId) {
    return path.join(this._sandboxDir(accountId), 'chat-history');
  }

  _sessionFile(accountId, sessionId) {
    return path.join(this._chatDir(accountId), `session-${sessionId}.jsonl`);
  }

  _sessionIndexFile(accountId) {
    return path.join(this._chatDir(accountId), 'sessions.json');
  }

  // ── Ensure dirs ──────────────────────────────────────────────────

  async _ensureDirs(accountId) {
    await fs.mkdir(this._chatDir(accountId), { recursive: true });
  }

  // ── Write queue (serialize writes per account) ───────────────────

  _enqueue(accountId, fn) {
    const prev = this._writeQueues.get(accountId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    this._writeQueues.set(accountId, next);
    return next;
  }

  // ── Session Index ────────────────────────────────────────────────

  async _loadSessionIndex(accountId) {
    try {
      const raw = await fs.readFile(this._sessionIndexFile(accountId), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return { sessions: [] };
    }
  }

  async _saveSessionIndex(accountId, index) {
    await this._ensureDirs(accountId);
    await fs.writeFile(this._sessionIndexFile(accountId), JSON.stringify(index, null, 2));
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Start or resume a session. Creates index entry if new.
   * @param {string} accountId
   * @param {string} sessionId - OpenCode session ID
   * @param {object} metadata - { agentName, model, ... }
   */
  async startSession(accountId, sessionId, metadata = {}) {
    return this._enqueue(accountId, async () => {
      await this._ensureDirs(accountId);
      const index = await this._loadSessionIndex(accountId);

      const existing = index.sessions.find(s => s.id === sessionId);
      if (existing) {
        // Resume — update lastActiveAt
        existing.lastActiveAt = new Date().toISOString();
        const storedMetadata = existing.metadata || {};
        existing.metadata = { ...storedMetadata, ...metadata };
        for (const key of ['agentId', 'agentName']) {
          if (Object.hasOwn(storedMetadata, key)) existing.metadata[key] = storedMetadata[key];
          else delete existing.metadata[key];
        }
      } else {
        // New session
        index.sessions.unshift({
          id: sessionId,
          createdAt: new Date().toISOString(),
          lastActiveAt: new Date().toISOString(),
          messageCount: 0,
          metadata,
        });
      }

      // Keep max 100 sessions in index
      if (index.sessions.length > 100) {
        index.sessions = index.sessions.slice(0, 100);
      }

      await this._saveSessionIndex(accountId, index);
    });
  }

  /**
   * Append a message to a session.
   * @param {string} accountId
   * @param {string} sessionId
   * @param {object} message - { role, content, beat?, toolCalls?, cost?, tokens? }
   */
  async addMessage(accountId, sessionId, message) {
    return this._enqueue(accountId, async () => {
      await this._ensureDirs(accountId);

      const entry = {
        timestamp: new Date().toISOString(),
        ...message,
      };

      const filePath = this._sessionFile(accountId, sessionId);
      await fs.appendFile(filePath, JSON.stringify(entry) + '\n');

      // Update session index message count
      const index = await this._loadSessionIndex(accountId);
      const session = index.sessions.find(s => s.id === sessionId);
      if (session) {
        session.messageCount = (session.messageCount || 0) + 1;
        session.lastActiveAt = new Date().toISOString();
        // Store last message preview
        if (message.content) {
          session.lastMessage = message.content.substring(0, 120);
        }
        await this._saveSessionIndex(accountId, index);
      }
    });
  }

  /**
   * List all sessions for an account (newest first).
   * @param {string} accountId
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async listSessions(accountId, limit = 50) {
    const index = await this._loadSessionIndex(accountId);
    return index.sessions.slice(0, limit);
  }

  /**
   * Get all messages for a session.
   * @param {string} accountId
   * @param {string} sessionId
   * @param {object} opts - { offset, limit }
   * @returns {Promise<Array>}
   */
  async getSessionMessages(accountId, sessionId, opts = {}) {
    const { offset = 0, limit = 500 } = opts;
    const filePath = this._sessionFile(accountId, sessionId);

    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const messages = lines.map(line => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);

      return messages.slice(offset, offset + limit);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  _orderEvidenceCacheFile(accountId) {
    return path.join(this._chatDir(accountId), 'order-evidence-cache.json');
  }

  async _scanSessionOrderEvidence(accountId, sessionId) {
    const input = fsSync.createReadStream(this._sessionFile(accountId, sessionId), { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    const messages = [];
    const adoptions = [];
    try {
      for await (const line of lines) {
        if (!line) continue;
        try {
          const row = JSON.parse(line);
          if (isSubmittingOrderToolCall(row)) messages.push(row);
          else if (isAdoptionDecisionCall(row)) adoptions.push(row);
        } catch { /* Ignore malformed/truncated JSONL records. */ }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    } finally {
      lines.close();
      input.destroy();
    }
    return { messages, adoptions };
  }

  /**
   * Order-submission and ADOPT-decision evidence for the last `sinceDays` calendar days.
   * The session index keeps only the newest 100 sessions, but older session files stay on disk, so files the index no
   * longer lists are read too (their actor comes from the per-message actorSnapshot, or from the metadata cached while
   * the index still listed them). A per-session cache means a long window is scanned once; a session is rescanned only
   * when its message count or last activity changed.
   */
  async listRecentOrderEvidence(accountId, { sinceDays = 30 } = {}) {
    const cutoff = Date.now() - sinceDays * 86400000;
    const indexed = await this.listSessions(accountId, Number.MAX_SAFE_INTEGER);
    const known = new Set(indexed.map(session => session.id));
    let cache = { sessions: {} };
    try {
      const parsed = JSON.parse(await fs.readFile(this._orderEvidenceCacheFile(accountId), 'utf8'));
      if (parsed && typeof parsed.sessions === 'object' && parsed.sessions) cache = parsed;
    } catch { /* no cache yet */ }
    const candidates = indexed
      .filter(session => { const created = Date.parse(session.createdAt); return Number.isFinite(created) ? created >= cutoff : true; })
      .map(session => ({ session, signature: `${session.messageCount ?? 0}:${session.lastActiveAt || ''}` }));
    let names = [];
    try { names = await fs.readdir(this._chatDir(accountId)); } catch { /* no chat history yet */ }
    for (const name of names) {
      const match = /^session-(.+)\.jsonl$/.exec(name);
      if (!match || known.has(match[1])) continue;
      let stat;
      try { stat = await fs.stat(path.join(this._chatDir(accountId), name)); } catch { continue; }
      if (stat.mtimeMs < cutoff) continue;
      const cached = cache.sessions[match[1]];
      candidates.push({
        session: { id: match[1], createdAt: cached?.createdAt || stat.birthtime.toISOString(), lastActiveAt: new Date(stat.mtimeMs).toISOString(), metadata: cached?.metadata || {} },
        signature: `file:${stat.size}:${Math.round(stat.mtimeMs)}`,
      });
    }
    const next = {};
    const result = [];
    let changed = Object.keys(cache.sessions).length !== candidates.length;
    for (const { session, signature } of candidates) {
      let entry = cache.sessions[session.id];
      if (!entry || entry.signature !== signature) {
        entry = { signature, createdAt: session.createdAt, metadata: session.metadata || {}, ...(await this._scanSessionOrderEvidence(accountId, session.id)) };
        changed = true;
      }
      next[session.id] = entry;
      result.push({ ...session, accountId, messages: entry.messages, adoptions: entry.adoptions });
    }
    if (changed) {
      try {
        await this._ensureDirs(accountId);
        const target = this._orderEvidenceCacheFile(accountId);
        await fs.writeFile(`${target}.tmp`, JSON.stringify({ sessions: next }));
        await fs.rename(`${target}.tmp`, target);
      } catch { /* the cache is an optimisation only */ }
    }
    return result;
  }

  async listOrderActorEvidence(accountId, { sessionLimit = 100, recordLimit = Infinity } = {}) {
    const sessions = await this.listSessions(accountId, sessionLimit);
    const result = [];
    for (const session of sessions) {
      const filePath = this._sessionFile(accountId, session.id);
      const input = fsSync.createReadStream(filePath, { encoding: 'utf8' });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      const messages = [];
      try {
        for await (const line of lines) {
          if (!line) continue;
          try {
            const row = JSON.parse(line);
            if (isSubmittingOrderToolCall(row)) {
              if (messages.length >= recordLimit) break;
              messages.push(row);
            }
          } catch { /* Ignore malformed/truncated JSONL records. */ }
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      } finally {
        lines.close();
        input.destroy();
      }
      result.push({ ...session, accountId, messages });
    }
    return result;
  }

  /** List completed activity groups derived from append-only session records. */
  async listActivities(accountId, { offset = 0, limit = 50, labels = [], query = '', account = '' } = {}) {
    const index = await this._loadSessionIndex(accountId);
    const groups = new Map();
    for (const session of index.sessions) {
      const records = await this.getSessionMessages(accountId, session.id, { limit: Number.MAX_SAFE_INTEGER });
      for (const record of records) {
        if (!record.activityId || record.accountId && record.accountId !== accountId) continue;
        let group = groups.get(record.activityId);
        if (!group) {
          group = { activityId: record.activityId, accountId, sessionId: session.id, origin: record.origin || (record.kind?.startsWith('heartbeat') || record.kind === 'heartbeat' ? 'Heartbeat' : 'User'), timestamp: record.timestamp, records: [], labels: new Set(), session };
          groups.set(record.activityId, group);
        }
        if (group.sessionId !== session.id) continue;
        group.records.push(record);
        group.timestamp = record.timestamp || group.timestamp;
        const kind = String(record.kind || '');
        if (record.origin === 'Heartbeat' || /^heartbeat/.test(kind)) group.labels.add('Heartbeat');
        else if (record.origin === 'User' || kind === 'message' || kind === 'message_partial' || kind === 'message_failure') group.labels.add('User');
        const tradeTools = new Set(['place_buy_order','place_sell_order','place_options_order','place_managed_position','close_managed_position','cancel_order','withdraw_planned_intent']);
        if (tradeTools.has(record.tool)) group.labels.add('Trade');
        if (hasStructuredFailure(record) && !optionalResearchToolName(record)) group.labels.add('Error');
      }
    }
    let result = [...groups.values()].map(g => {
      const { essential, warnings } = classifyFailures(g.records);
      // The Error label follows the essential failures, so a reconciled post-close 404 is only a warning.
      const labels = [...g.labels].filter(label => label !== 'Error' || essential.length > 0);
      const last = [...g.records].reverse().find(r => r.content);
      const toolRecords = g.records.filter(r => r.kind === 'tool_call' || r.eventType === 'tool_call');
      const recovery = g.records.some(r => r.kind === 'heartbeat_recovery');
      const status = [...toolRecords].reverse().map(recordedToolStatus).find(Boolean);
      const outcome = activityOutcome({ recovery, status, essential, warnings });
      return { activityId: g.activityId, accountId, sessionId: g.sessionId, timestamp: g.timestamp, origin: g.origin, labels, title: last?.content?.slice(0, 140) || `${g.origin} activity`, outcome, warnings, agentName: g.session.metadata?.agentName || g.session.metadata?.agentId || '--', sandboxName: g.session.metadata?.sandboxName || '--', recordCount: g.records.length, toolCount: toolRecords.length, _session: g.session, _records: g.records };
    });
    result = result.filter(a => (!account || a.accountId === account || a.sandboxName === account) && (!labels.length || labels.some(l => a.labels.includes(l))));
    if (query) {
      const lower = query.toLowerCase();
      const matching = [];
      for (const activity of result) {
        const searchable = `${activity.title} ${activity.labels.join(' ')} ${JSON.stringify(activity._records)}`.toLowerCase();
        if (searchable.includes(lower)) matching.push(activity);
      }
      result = matching;
    }
    result.sort((a,b) => String(b.timestamp).localeCompare(String(a.timestamp)) || a.activityId.localeCompare(b.activityId));
    const activities = result.slice(offset, offset + limit).map(({ _records, _session, ...summary }) => summary);
    return { activities, total: result.length };
  }

  async getActivity(accountId, activityId, opts = {}) {
    const offset = Math.max(0, Number(opts.offset) || 0), limit = Math.min(500, Math.max(1, Number(opts.limit) || 100));
    const index = await this._loadSessionIndex(accountId);
    for (const session of index.sessions) {
      const records = await this.getSessionMessages(accountId, session.id, { limit: Number.MAX_SAFE_INTEGER });
      const activityRecords = records.filter(record => record.activityId === activityId && (!record.accountId || record.accountId === accountId));
      if (!activityRecords.length) continue;
      const labels = new Set();
      const trades = new Set(['place_buy_order','place_sell_order','place_options_order','place_managed_position','close_managed_position','cancel_order','withdraw_planned_intent']);
      for (const record of activityRecords) {
        if (record.origin === 'Heartbeat' || String(record.kind || '').startsWith('heartbeat')) labels.add('Heartbeat');
        else if (record.origin === 'User' || ['message','message_partial','message_failure','manager_message'].includes(record.kind)) labels.add('User');
        if (trades.has(record.tool)) labels.add('Trade');
        if (hasStructuredFailure(record) && !optionalResearchToolName(record)) labels.add('Error');
      }
      const toolRecords = activityRecords.filter(record => record.kind === 'tool_call' || record.eventType === 'tool_call');
      const recovery = activityRecords.some(record => record.kind === 'heartbeat_recovery');
      const { essential, warnings } = classifyFailures(activityRecords);
      if (essential.length === 0) labels.delete('Error');
      const status = [...toolRecords].reverse().map(recordedToolStatus).find(Boolean);
      const last = [...activityRecords].reverse().find(record => record.content);
      const summary = { activityId, accountId, sessionId: session.id, origin: activityRecords.find(record => record.origin)?.origin || 'User', timestamp: activityRecords[0].timestamp, labels: [...labels], title: last?.content?.slice(0, 140) || 'Activity', outcome: activityOutcome({ recovery, status, essential, warnings }), warnings, agentName: session.metadata?.agentName || session.metadata?.agentId || '--', sandboxName: session.metadata?.sandboxName || '--', recordCount: activityRecords.length, toolCount: toolRecords.length };
      return { ...summary, totalRecords: activityRecords.length, records: activityRecords.slice(offset, offset + limit), offset, hasMore: offset + limit < activityRecords.length };
    }
    return null;
  }

  /**
   * Get a session's metadata from the index.
   * @param {string} accountId
   * @param {string} sessionId
   * @returns {Promise<object|null>}
   */
  async getSession(accountId, sessionId) {
    const index = await this._loadSessionIndex(accountId);
    return index.sessions.find(s => s.id === sessionId) || null;
  }

  /** Return a compact context window for a restarted agent or manager. */
  async getRecentContext(accountId, opts = {}) {
    const { sessionLimit = 5, messagesPerSession = 8, charLimit = 12000 } = opts;
    const sessions = await this.listSessions(accountId, sessionLimit);
    const context = [];
    let chars = 0;
    for (const session of sessions) {
      // Continuity needs the END of a session (latest summary, WATCHLIST/decision records), not its
      // opening orientation reads. Keep prose and decision/activity records; skip bulk read-tool output.
      const messages = await this.getSessionMessages(accountId, session.id, { limit: Number.MAX_SAFE_INTEGER });
      const continuity = m => m && (m.content || m.eventType
        || (m.kind === 'tool_call' && (m.tool === 'log_decision' || m.tool === 'log_activity')));
      const useful = messages.filter(continuity).slice(-messagesPerSession);
      if (!useful.length) continue;
      const block = {
        sessionId: session.id,
        createdAt: session.createdAt,
        lastActiveAt: session.lastActiveAt,
        metadata: session.metadata || {},
        messages: useful.map(m => ({
          timestamp: m.timestamp,
          role: m.role,
          kind: m.kind,
          eventType: m.eventType,
          content: typeof m.content === 'string' ? m.content.substring(0, 1800) : undefined,
          tool: m.tool,
          args: m.args,
          result: typeof m.result === 'string' ? m.result.substring(0, 800) : undefined,
        })),
      };
      const size = JSON.stringify(block).length;
      if (chars + size > charLimit) break;
      context.push(block);
      chars += size;
    }
    return context;
  }

  /**
   * Delete a session (messages + index entry).
   * @param {string} accountId
   * @param {string} sessionId
   */
  async deleteSession(accountId, sessionId) {
    return this._enqueue(accountId, async () => {
      // Remove file
      try {
        await fs.unlink(this._sessionFile(accountId, sessionId));
      } catch {}

      // Remove from index
      const index = await this._loadSessionIndex(accountId);
      index.sessions = index.sessions.filter(s => s.id !== sessionId);
      await this._saveSessionIndex(accountId, index);
    });
  }

  /**
   * Get all sessions across all accounts (for global search).
   * @param {number} limit
   * @returns {Promise<Array>} - [{ accountId, ...session }]
   */
  async listAllSessions(limit = 100) {
    const sandboxDir = path.join(this.dataDir, 'sandboxes');
    let accountIds = [];
    try {
      accountIds = await fs.readdir(sandboxDir);
    } catch {
      return [];
    }

    const allSessions = [];
    for (const accountId of accountIds) {
      const sessions = await this.listSessions(accountId);
      for (const session of sessions) {
        allSessions.push({ accountId, ...session });
      }
    }

    // Sort by lastActiveAt descending
    allSessions.sort((a, b) => new Date(b.lastActiveAt) - new Date(a.lastActiveAt));
    return allSessions.slice(0, limit);
  }
}

export default ChatStore;
