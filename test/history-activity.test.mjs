import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, isValidHistoryAccountId } from '../agent/chat-store.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-activity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-a', 'session-a', { agentName: 'Manager' });
  await store.startSession('acct-b', 'session-a', {});
  const file = path.join(root, 'sandboxes', 'acct-a', 'chat-history', 'session-session-a.jsonl');
  const records = [];
  const add = (activityId, props) => records.push({ timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, records.length)).toISOString(), activityId, ...props });
  add('user-trade', { origin: 'User', role: 'user', kind: 'message', content: 'Please inspect order paper-order-77' });
  add('user-trade', { origin: 'User', role: 'assistant', kind: 'tool_call', tool: 'place_buy_order', args: { symbol: 'XYZ', order_id: 'paper-order-77' }, result: '{"status":"rejected"}', status: 'completed' });
  add('user-trade', { origin: 'User', role: 'assistant', kind: 'message_failure', content: 'structured exchange failure', error: 'failed' });
  for (let i = 0; i < 502; i++) add('large', { origin: 'Heartbeat', role: 'assistant', kind: 'tool_call', tool: 'get_positions', result: JSON.stringify({ item: i, marker: i === 501 ? 'rare-order-501' : '', data: 'x'.repeat(40) }) });
  add('assessment', { origin: 'User', role: 'assistant', kind: 'tool_call', tool: 'assess_options_trade', result: '{"status":"FAIL"}' });
  add('assessment', { origin: 'User', role: 'assistant', kind: 'tool_call', tool: 'assess_options_strategy', result: '{"status":"UNAVAILABLE"}' });
  add('assessment', { origin: 'User', role: 'assistant', kind: 'tool_call', tool: 'get_orders', result: '[]' });
  add('prose-only', { origin: 'User', role: 'assistant', kind: 'message', content: 'Filled order XYZ according to discussion, but no order tool was called.' });
  add('mcp-error', { origin: 'Heartbeat', kind: 'tool_call', tool: 'place_sell_order', result: { content: [{ text: JSON.stringify({ isError: true, error: { message: 'uncertain' } }) }] } });
  add('recovering', { origin: 'Heartbeat', kind: 'heartbeat_failure', content: 'failed' });
  add('recovering', { origin: 'Heartbeat', kind: 'heartbeat_recovery', content: 'recovered' });
  await fs.appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const otherFile = path.join(root, 'sandboxes', 'acct-b', 'chat-history', 'session-session-a.jsonl');
  await fs.appendFile(otherFile, JSON.stringify({ timestamp: new Date().toISOString(), activityId: 'user-trade', origin: 'Heartbeat', kind: 'heartbeat', content: 'belongs to b' }) + '\n');
  return store;
}

test('activity summaries omit payloads and search args/results before pagination', async t => {
  const store = await fixture(t);
  const page = await store.listActivities('acct-a', { labels: ['Trade'], query: 'paper-order-77', limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.activities[0].activityId, 'user-trade');
  assert.equal('records' in page.activities[0], false);
  assert.equal(page.activities[0].toolCount, 1);
  assert.equal((await store.listActivities('acct-a', { query: 'rare-order-501', limit: 1 })).activities[0].activityId, 'large');
  const scopedCollision = await store.getActivity('acct-b', 'user-trade');
  assert.equal(scopedCollision.records[0].content, 'belongs to b');
  assert.equal(scopedCollision.accountId, 'acct-b');
  assert.equal((await store.listActivities('acct-a', { labels: ['Trade'], query: 'place_sell_order' })).total, 1);
  assert.equal((await store.listActivities('acct-a', { labels: ['Heartbeat', 'Trade'] })).total, 4, 'multiple selected labels use ANY matching');
});

test('details page beyond 500 retains structured tool evidence and account scoping', async t => {
  const store = await fixture(t);
  const first = await store.getActivity('acct-a', 'large', { limit: 500 });
  const second = await store.getActivity('acct-a', 'large', { offset: 500, limit: 500 });
  assert.equal(first.records.length, 500);
  assert.equal(first.hasMore, true);
  assert.equal(second.records.length, 2);
  assert.equal(second.hasMore, false);
  assert.equal(second.records[0].tool, 'get_positions');
  assert.equal(await store.getActivity('acct-b', 'large'), null);
  assert.deepEqual((await store.listActivities('acct-a', { labels: ['Heartbeat'] })).activities.map(a => a.activityId).sort(), ['large', 'mcp-error', 'recovering']);
});

test('classifies real structured errors and recovery without promoting assessment outcomes or reads', async t => {
  const store = await fixture(t);
  const errors = await store.listActivities('acct-a', { labels: ['Error'] });
  assert.deepEqual(errors.activities.map(a => a.activityId).sort(), ['mcp-error', 'recovering', 'user-trade']);
  assert.equal((await store.listActivities('acct-a', { labels: ['Trade'] })).activities.some(a => a.activityId === 'assessment'), false);
  assert.equal((await store.listActivities('acct-a', { labels: ['Trade'] })).activities.some(a => a.activityId === 'prose-only'), false);
  const recovered = await store.getActivity('acct-a', 'recovering');
  assert.equal(recovered.outcome, 'Recovered');
  const rejected = await store.getActivity('acct-a', 'user-trade');
  assert.match(rejected.outcome, /rejected/);
});

test('an optional news tool error is a warning, not a failed activity; essential failures still fail', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-activity-warn-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-w', 'session-w', { agentName: 'Pendulum' });
  const file = path.join(root, 'sandboxes', 'acct-w', 'chat-history', 'session-session-w.jsonl');
  const records = [];
  const add = (activityId, props) => records.push({ timestamp: new Date(Date.UTC(2026, 10, 4, 14, 0, records.length)).toISOString(), activityId, origin: 'Heartbeat', ...props });
  const newsError = JSON.stringify({ error: 'Trading bot request failed: provider_unavailable' });
  // the Nov 4 pre-market pattern: optional news tools fail, everything else completes
  add('news-only', { kind: 'heartbeat', content: 'Pre-market review complete' });
  add('news-only', { kind: 'tool_call', tool: 'get_account', result: '{"Equity":100578.78}', status: 'completed' });
  add('news-only', { kind: 'tool_call', tool: 'get_cleaned_news', result: '', status: 'error', error: newsError });
  add('news-only', { kind: 'tool_call', tool: 'get_market_news', result: '', status: 'error', error: newsError });
  // an optional failure alongside a broker/data failure is still Failed
  add('mixed', { kind: 'tool_call', tool: 'get_market_news', result: '', status: 'error', error: newsError });
  add('mixed', { kind: 'tool_call', tool: 'get_account', result: '', status: 'error', error: '{"error":"broker unavailable"}' });
  // an order tool error is essential
  add('order-error', { kind: 'tool_call', tool: 'place_options_order', result: { content: [{ text: JSON.stringify({ isError: true, error: { message: 'uncertain' } }) }] } });
  // data features failure is essential
  add('data-error', { kind: 'tool_call', tool: 'get_daily_features', result: '', status: 'error', error: '{"error":"bars unavailable"}' });
  // a heartbeat-level failure is essential even if the only failing tool was optional news
  add('heartbeat-failed', { kind: 'tool_call', tool: 'get_cleaned_news', result: '', status: 'error', error: newsError });
  add('heartbeat-failed', { kind: 'heartbeat_failure', content: 'crashed' });
  await fs.appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');

  const listed = new Map((await store.listActivities('acct-w', { limit: 50 })).activities.map(a => [a.activityId, a]));
  const newsOnly = listed.get('news-only');
  assert.match(newsOnly.outcome, /^Recorded \(warning: get_cleaned_news, get_market_news unavailable\)$/);
  assert.deepEqual(newsOnly.warnings, ['get_cleaned_news', 'get_market_news']);
  assert.equal(newsOnly.labels.includes('Error'), false, 'optional news errors do not add the Error label');
  assert.equal(listed.get('mixed').outcome, 'Failed');
  assert.equal(listed.get('mixed').labels.includes('Error'), true);
  assert.equal(listed.get('order-error').outcome, 'Failed');
  assert.equal(listed.get('data-error').outcome, 'Failed');
  assert.equal(listed.get('heartbeat-failed').outcome, 'Failed');
  assert.equal(listed.get('heartbeat-failed').labels.includes('Error'), true);
  // the detail view agrees with the list view
  const detail = await store.getActivity('acct-w', 'news-only');
  assert.equal(detail.outcome, newsOnly.outcome);
  assert.deepEqual(detail.warnings, newsOnly.warnings);
  assert.equal(detail.labels.includes('Error'), false);
  assert.equal((await store.getActivity('acct-w', 'mixed')).outcome, 'Failed');
  // default History filter (Error) no longer surfaces the news-only beat
  const errors = (await store.listActivities('acct-w', { labels: ['Error'] })).activities.map(a => a.activityId).sort();
  assert.deepEqual(errors, ['data-error', 'heartbeat-failed', 'mixed', 'order-error']);
});

test('history account identifiers reject traversal and separators before lookup', () => {
  for (const value of ['', '../acct', 'acct/child', 'acct\\child', 'C:account', '..']) assert.equal(isValidHistoryAccountId(value), false, value);
  assert.equal(isValidHistoryAccountId('__manager__'), true);
  assert.equal(isValidHistoryAccountId('acct-123_ab'), true);
});
