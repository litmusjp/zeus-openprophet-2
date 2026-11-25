import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ChatStore, classifyFailures, failureCauses } from '../agent/chat-store.js';

// Nov 26 W4 (Hermes plan review): a stale held-contract quote stays an essential failure and the beat stays Failed. The outcome only NAMES the cause.
// Held identity comes from a successful positions read of the same activity; the payload must be exactly the structured quote answer; nothing a
// model wrote (a HOLD, a carry object, exit_due) can demote or hide the failure; quote freshness and DATA_BLOCK handling are not touched here.

const HELD = 'DIS270115C00120000';
const quotePayload = (extra = {}) => ({ category: 'quote_stale_or_invalid', endpoint: 'options_quote', error: 'the exact contract quote is stale or invalid, so it is not usable for a price', status: 'unavailable', symbol: HELD, http_status: 503, ...extra });
const call = (tool, args, result, extra = {}) => ({ kind: 'tool_call', eventType: 'tool_call', tool, args, result, status: 'completed', ...extra });
const positions = (symbol = HELD) => call('get_options_positions', {}, JSON.stringify([{ Symbol: symbol, Underlying: 'DIS', Qty: 5, AvgEntryPrice: 5.7 }], null, 2));
const staleQuote = (payload = quotePayload(), symbol = HELD) => call('get_options_quote', { symbol }, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
const decision = (symbol = HELD, extra = {}) => call('log_decision', { action: 'HOLD', symbol, reasoning: 'x', ...extra }, 'Decision logged to f.json');
const activityLog = () => call('log_activity', { type: 'POSITION_CHECK', action: 'x' }, 'Activity logged: x');
const failedOrder = { kind: 'tool_call', tool: 'place_options_order', result: { content: [{ text: JSON.stringify({ isError: true, error: { message: 'uncertain' } }) }] } };

test('cause text is produced only for an exact stale held-contract quote with held identity from the same activity', () => {
  const records = [positions(), staleQuote()];
  const { essential } = classifyFailures(records);
  assert.equal(essential.length, 1, 'the failure stays essential');
  assert.deepEqual(failureCauses(records, essential), [`held-contract quote unavailable: ${HELD}`]);
  // no positions read, a different held symbol, an empty list: no held identity, no cause
  for (const set of [[staleQuote()], [positions('WMT261218C00125000'), staleQuote()], [call('get_options_positions', {}, '[]'), staleQuote()]]) {
    assert.deepEqual(failureCauses(set, classifyFailures(set).essential), []);
  }
  // a failed positions read proves no held identity
  const failedRead = call('get_options_positions', {}, '', { status: 'error', error: '{"error":"broker unavailable"}' });
  const set = [failedRead, staleQuote()];
  assert.deepEqual(failureCauses(set, classifyFailures(set).essential), []);
});

test('the payload must be exactly the structured answer: other keys, categories, statuses, symbols and prose never qualify', () => {
  const variants = [
    quotePayload({ extra: 'x' }), quotePayload({ category: 'auth' }), quotePayload({ status: 'error' }), quotePayload({ http_status: 500 }),
    quotePayload({ endpoint: 'options_chain' }), quotePayload({ symbol: 'WMT261218C00125000' }), 'the quote is stale', '[]',
  ];
  for (const payload of variants) {
    const set = [positions(), staleQuote(payload)];
    assert.deepEqual(failureCauses(set, classifyFailures(set).essential), [], JSON.stringify(payload));
  }
  const withError = [positions(), { ...staleQuote(), error: 'transport failure' }];
  assert.deepEqual(failureCauses(withError, classifyFailures(withError).essential), []);
});

test('any other essential failure in the activity keeps the plain label; the cause never hides it', () => {
  const set = [positions(), staleQuote(), failedOrder];
  const { essential } = classifyFailures(set);
  assert.equal(essential.length, 2);
  assert.deepEqual(failureCauses(set, essential), []);
  const account = [positions(), staleQuote(), { kind: 'tool_call', tool: 'get_account', result: '', status: 'error', error: '{"error":"broker unavailable"}' }];
  assert.deepEqual(failureCauses(account, classifyFailures(account).essential), []);
});

test('the logged suffix appears only when a completed decision for that exact contract and an activity record exist; carry or exit_due notes change nothing', () => {
  const plain = [positions(), staleQuote(), decision(), activityLog()];
  assert.deepEqual(failureCauses(plain, classifyFailures(plain).essential), [`held-contract quote unavailable: ${HELD}; decision and activity logged`]);
  const otherSymbol = [positions(), staleQuote(), decision('WMT261218C00125000'), activityLog()];
  assert.deepEqual(failureCauses(otherSymbol, classifyFailures(otherSymbol).essential), [`held-contract quote unavailable: ${HELD}`]);
  const noActivity = [positions(), staleQuote(), decision()];
  assert.deepEqual(failureCauses(noActivity, classifyFailures(noActivity).essential), [`held-contract quote unavailable: ${HELD}`]);
  // no carry, false carry, true carry and contradictory checks: always still essential, cause text identical, never a warning
  for (const carry of [undefined, { kind: 'position_check', symbol: HELD, exit_due: false }, { kind: 'position_check', symbol: HELD, exit_due: true }]) {
    const set = [positions(), staleQuote(), decision(HELD, carry ? { carry } : {}), activityLog()];
    const result = classifyFailures(set);
    assert.equal(result.essential.length, 1);
    assert.deepEqual(result.warnings, []);
  }
  const contradictory = [positions(), staleQuote(), decision(HELD, { carry: { kind: 'position_check', symbol: HELD, exit_due: false } }), decision(HELD, { carry: { kind: 'position_check', symbol: HELD, exit_due: true } }), activityLog()];
  assert.equal(classifyFailures(contradictory).essential.length, 1);
});

test('a stored positions result that is no longer whole JSON still identifies the held symbol; a held-looking name in prose does not', () => {
  const truncated = call('get_options_positions', {}, `[\n  {\n    "BrokerAccountID": "x",\n    "Symbol": "${HELD}",\n    "Qty": 5,\n    "AvgEntryPrice": 5.7,\n    "MarketVal`);
  const set = [truncated, staleQuote()];
  assert.deepEqual(failureCauses(set, classifyFailures(set).essential), [`held-contract quote unavailable: ${HELD}`]);
  const prose = [call('get_options_positions', {}, `we do hold ${HELD} maybe`), staleQuote()];
  assert.deepEqual(failureCauses(prose, classifyFailures(prose).essential), []);
});

test('stored beats: the outcome names the cause in the list and detail views, keeps the Error label, and unrelated beats are unchanged', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-n26-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new ChatStore(root);
  await store.startSession('acct-n', 'session-n', { agentName: 'Herald' });
  const file = path.join(root, 'sandboxes', 'acct-n', 'chat-history', 'session-session-n.jsonl');
  const records = [];
  const add = (activityId, props) => records.push({ timestamp: new Date(Date.UTC(2026, 10, 25, 18, 0, records.length)).toISOString(), activityId, origin: 'Heartbeat', ...props });
  add('held-quote', { kind: 'heartbeat', content: 'Midday heartbeat' });
  for (const r of [positions(), staleQuote(), decision(), activityLog()]) add('held-quote', r);
  add('held-quote-no-log', { kind: 'heartbeat', content: 'Midday heartbeat' });
  for (const r of [positions(), staleQuote()]) add('held-quote-no-log', r);
  add('quote-and-order', { kind: 'heartbeat', content: 'x' });
  for (const r of [positions(), staleQuote(), failedOrder]) add('quote-and-order', r);
  add('quote-not-held', { kind: 'heartbeat', content: 'x' });
  for (const r of [call('get_options_positions', {}, '[]'), staleQuote()]) add('quote-not-held', r);
  add('clean', { kind: 'heartbeat', content: 'x' });
  for (const r of [positions(), call('get_options_quote', { symbol: HELD }, JSON.stringify({ bid: 7.1, ask: 7.5 })), decision()]) add('clean', r);
  await fs.appendFile(file, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const listed = new Map((await store.listActivities('acct-n', { limit: 50 })).activities.map(a => [a.activityId, a]));
  assert.equal(listed.get('held-quote').outcome, `Failed (held-contract quote unavailable: ${HELD}; decision and activity logged)`);
  assert.equal(listed.get('held-quote-no-log').outcome, `Failed (held-contract quote unavailable: ${HELD})`);
  assert.equal(listed.get('quote-and-order').outcome, 'Failed');
  assert.equal(listed.get('quote-not-held').outcome, 'Failed');
  assert.equal(listed.get('clean').outcome, 'Recorded');
  for (const id of ['held-quote', 'held-quote-no-log', 'quote-and-order', 'quote-not-held']) assert.equal(listed.get(id).labels.includes('Error'), true, id);
  assert.equal(listed.get('clean').labels.includes('Error'), false);
  assert.deepEqual(listed.get('held-quote').warnings, []);
  for (const id of listed.keys()) assert.equal((await store.getActivity('acct-n', id)).outcome, listed.get(id).outcome, id);
});
