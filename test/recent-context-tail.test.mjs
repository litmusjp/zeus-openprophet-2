import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore } from '../agent/chat-store.js';

test('recent context returns the latest continuity records of a session, not its opening reads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-context-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct', 'day-1', {});
  const file = path.join(root, 'sandboxes', 'acct', 'chat-history', 'session-day-1.jsonl');
  const rows = [];
  const at = () => new Date(Date.UTC(2026, 10, 2, 14, 0, rows.length)).toISOString();
  rows.push({ timestamp: at(), role: 'assistant', kind: 'heartbeat', content: 'MORNING orientation' });
  for (let i = 0; i < 30; i++) rows.push({ timestamp: at(), role: 'assistant', kind: 'tool_call', tool: 'get_orders', result: '[]' });
  rows.push({ timestamp: at(), role: 'assistant', kind: 'tool_call', tool: 'log_decision', args: { action: 'WATCHLIST', symbol: 'XLK', reasoning: 'trigger 176.9' } });
  rows.push({ timestamp: at(), role: 'assistant', kind: 'heartbeat', content: 'AFTER HOURS summary' });
  await fs.appendFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const [session] = await store.getRecentContext('acct', { sessionLimit: 1, messagesPerSession: 2 });
  const text = JSON.stringify(session.messages);
  assert.equal(session.messages.length, 2);
  assert.match(text, /WATCHLIST/);
  assert.match(text, /AFTER HOURS summary/);
  assert.doesNotMatch(text, /MORNING orientation/);
  assert.doesNotMatch(text, /get_orders/);
});
