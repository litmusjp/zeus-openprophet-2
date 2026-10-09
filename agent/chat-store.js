// Chat History Store - Persists conversations per account/session
// JSONL format for efficient append-only writes
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
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
        existing.metadata = { ...existing.metadata, ...metadata };
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
        const failure = hasStructuredFailure(record);
        if (failure) group.labels.add('Error');
      }
    }
    let result = [...groups.values()].map(g => {
      const labels = [...g.labels];
      const last = [...g.records].reverse().find(r => r.content);
      const toolRecords = g.records.filter(r => r.kind === 'tool_call' || r.eventType === 'tool_call');
      const recovery = g.records.some(r => r.kind === 'heartbeat_recovery');
      const failure = g.records.some(hasStructuredFailure);
      const status = [...toolRecords].reverse().map(recordedToolStatus).find(Boolean);
      const outcome = recovery ? 'Recovered' : status ? `Recorded: ${status}` : failure ? 'Failed' : 'Recorded';
      return { activityId: g.activityId, accountId, sessionId: g.sessionId, timestamp: g.timestamp, origin: g.origin, labels, title: last?.content?.slice(0, 140) || `${g.origin} activity`, outcome, agentName: g.session.metadata?.agentName || g.session.metadata?.agentId || '--', sandboxName: g.session.metadata?.sandboxName || '--', recordCount: g.records.length, toolCount: toolRecords.length, _session: g.session, _records: g.records };
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
        if (hasStructuredFailure(record)) labels.add('Error');
      }
      const toolRecords = activityRecords.filter(record => record.kind === 'tool_call' || record.eventType === 'tool_call');
      const recovery = activityRecords.some(record => record.kind === 'heartbeat_recovery');
      const failed = activityRecords.some(hasStructuredFailure);
      const status = [...toolRecords].reverse().map(recordedToolStatus).find(Boolean);
      const last = [...activityRecords].reverse().find(record => record.content);
      const summary = { activityId, accountId, sessionId: session.id, origin: activityRecords.find(record => record.origin)?.origin || 'User', timestamp: activityRecords[0].timestamp, labels: [...labels], title: last?.content?.slice(0, 140) || 'Activity', outcome: recovery ? 'Recovered' : status ? `Recorded: ${status}` : failed ? 'Failed' : 'Recorded', agentName: session.metadata?.agentName || session.metadata?.agentId || '--', sandboxName: session.metadata?.sandboxName || '--', recordCount: activityRecords.length, toolCount: toolRecords.length };
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
      const messages = await this.getSessionMessages(accountId, session.id, { limit: messagesPerSession });
      const useful = messages.filter(m => m && (m.content || m.eventType || m.kind === 'tool_call'));
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
