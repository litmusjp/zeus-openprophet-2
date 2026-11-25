// GET /api/chats: the session list. A session index that cannot be read or recovered is an explicit 503 (history_index_unavailable),
// never an empty 200 list; the message files are untouched.
import { isHistoryIndexUnavailable } from './chat-store.js';

export function createChatsListHandler({ chatStore, getActiveAccountId }) {
  return async (req, res) => {
    try {
      const accountId = req.query.accountId || getActiveAccountId();
      if (!accountId) return res.json({ sessions: [] });
      const limit = Number(req.query.limit || 50);
      const sessions = await chatStore.listSessions(accountId, limit);
      return res.json({ accountId, sessions });
    } catch (error) {
      if (isHistoryIndexUnavailable(error)) return res.status(503).json({ error: 'history_index_unavailable', reason: error.reason });
      return res.status(500).json({ error: error.message });
    }
  };
}
