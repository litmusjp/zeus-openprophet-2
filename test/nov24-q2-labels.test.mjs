import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, classifyFailures } from '../agent/chat-store.js';

// Nov 24 Q2 (Hermes plan review): get_market_snapshot (the yfinance reader, not the exact broker quote or order path) is an optional
// research tool whose outage is a visible warning. Every essential failure still fails the beat, also when a snapshot failure sits next to it.

const feedError = JSON.stringify({ error: 'Trading bot request failed: {"endpoint":"/feeds/yfinance","tool":"feeds"}' });
const staleQuote = JSON.stringify({ category: 'quote_stale_or_invalid', endpoint: 'options_quote', error: 'the exact contract quote is stale or invalid', symbol: 'CRM261218P00190000' });
const snapshot = (tool = 'get_market_snapshot') => ({ kind: 'tool_call', tool, args: { symbols: ['SPY'] }, result: '', status: 'error', error: feedError });
const staleHeldQuote = { kind: 'tool_call', tool: 'get_options_quote', args: { symbol: 'CRM261218P00190000' }, status: 'completed', result: staleQuote };
const failedOrder = { kind: 'tool_call', tool: 'place_options_order', result: { content: [{ text: JSON.stringify({ isError: true, error: { message: 'uncertain' } }) }] } };

test('a failed get_market_snapshot alone is a visible warning, not an essential failure (also through the prophet_ alias)', () => {
  for (const tool of ['get_market_snapshot', 'prophet_get_market_snapshot']) {
    const result = classifyFailures([snapshot(tool)]);
    assert.equal(result.essential.length, 0, tool);
    assert.deepEqual(result.warnings, ['get_market_snapshot'], tool);
  }
});

test('mixed beats: a failed snapshot never hides a stale held-contract quote, a failed order, an account or a data failure', () => {
  assert.equal(classifyFailures([snapshot(), staleHeldQuote]).essential.length, 1);
  assert.equal(classifyFailures([snapshot(), staleHeldQuote]).essential[0].tool, 'get_options_quote');
  assert.equal(classifyFailures([snapshot(), failedOrder]).essential.length, 1);
  assert.equal(classifyFailures([snapshot(), { kind: 'tool_call', tool: 'get_account', result: '', status: 'error', error: '{"error":"broker unavailable"}' }]).essential.length, 1);
  assert.equal(classifyFailures([snapshot(), { kind: 'tool_call', tool: 'get_daily_features', result: '', status: 'error', error: '{"error":"bars unavailable"}' }]).essential.length, 1);
  assert.equal(classifyFailures([snapshot(), { kind: 'heartbeat_failure', content: 'crashed' }]).essential.length, 1);
  // the stale held-contract quote alone stays an essential failure by itself (a due exit needs a quote)
  assert.equal(classifyFailures([staleHeldQuote]).essential.length, 1);
});

test('stored beats: snapshot-only is Recorded with a warning and no Error label; mixed beats stay Failed with the Error label', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-q2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-q', 'session-q', { agentName: 'Prophet' });
  const file = path.join(root, 'sandboxes', 'acct-q', 'chat-history', 'session-session-q.jsonl');
  const records = [];
  const add = (activityId, props) => records.push({ timestamp: new Date(Date.UTC(2026, 10, 23, 14, 0, records.length)).toISOString(), activityId, origin: 'Heartbeat', ...props });
  add('snap-only', { kind: 'heartbeat', content: 'Market-open heartbeat completed' });
  add('snap-only', { kind: 'tool_call', tool: 'get_account', result: '{"Equity":97768.26}', status: 'completed' });
  add('snap-only', snapshot());
  add('snap-stale', snapshot());
  add('snap-stale', { ...staleHeldQuote });
  add('snap-order', snapshot());
  add('snap-order', failedOrder);
  await fs.appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const listed = new Map((await store.listActivities('acct-q', { limit: 50 })).activities.map(a => [a.activityId, a]));
  assert.match(listed.get('snap-only').outcome, /^Recorded \(warning: get_market_snapshot unavailable\)$/);
  assert.deepEqual(listed.get('snap-only').warnings, ['get_market_snapshot']);
  assert.equal(listed.get('snap-only').labels.includes('Error'), false);
  assert.equal(listed.get('snap-stale').outcome, 'Failed');
  assert.equal(listed.get('snap-stale').labels.includes('Error'), true);
  assert.equal(listed.get('snap-order').outcome, 'Failed');
  assert.equal(listed.get('snap-order').labels.includes('Error'), true);
  // the detail view agrees with the list view
  assert.equal((await store.getActivity('acct-q', 'snap-only')).outcome, listed.get('snap-only').outcome);
  assert.equal((await store.getActivity('acct-q', 'snap-stale')).outcome, 'Failed');
});
