import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { ChatStore } from '../agent/chat-store.js';
import { AgentHarness } from '../agent/harness.js';
import { resolveOrderActorWithJournal, resolveOrderActor } from '../agent/history-attribution.js';
import { OrderAttributionJournal, attributionFromToolEvent, backfillOrderAttribution } from '../agent/order-attribution-journal.js';

const actor = (agentId, agentName) => ({ agentId, agentName });
const HER = actor('herald', 'Herald'), GUA = actor('guardian', 'Guardian');
const tmp = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-attr-journal-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const call = (tool, ids, a, extra = {}) => ({ kind: 'tool_call', tool, status: 'completed', args: { client_order_id: ids.cid }, result: JSON.stringify({ order_id: ids.oid }), ...(a ? { actorSnapshot: a } : {}), ...extra });

test('evidence rules: typed snapshot only; errored, truncated, non-completed, manager and read-only calls record nothing', () => {
  assert.deepEqual(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER)), { actor: HER, orderIds: ['b1', 'c1'] });
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, null)), null, 'no typed actor, no record');
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { error: 'x' })), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { resultTruncated: true })), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { status: 'error' })), null);
  assert.equal(attributionFromToolEvent(call('get_orders', { oid: 'b1', cid: 'c1' }, HER)), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { result: JSON.stringify({ error: 'rejected' }) })), null, 'refusal result is out of scope');
});

test('journal: durable append, no secrets, idempotent, survives reopen, duplicate suppressed', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  const base = { accountId: 'a1', sandboxId: 'sbx', brokerAccountId: 'BRK', paper: true, actor: HER, orderIds: ['b1', 'c1'], at: '2026-11-18T01:00:00.000Z' };
  assert.deepEqual(await j.record(base), { ok: true });
  assert.deepEqual(await j.record(base), { ok: true, duplicate: true });
  await j.record({ ...base, actor: HER, orderIds: ['b1', 'c1'], source: 'live' });
  const text = await fs.readFile(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl'), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  const entry = JSON.parse(text);
  assert.deepEqual(Object.keys(entry).sort(), ['accountId', 'agentId', 'agentName', 'at', 'brokerAccountId', 'orderIds', 'paper', 'sandboxId', 'source', 'v']);
  const { map, report } = await new OrderAttributionJournal(dir).loadMap('a1');
  assert.equal(report.entries, 1);
  assert.deepEqual(resolveOrderActorWithJournal(map, new Map(), 'a1', { ID: 'b1' }), HER);
  assert.deepEqual(resolveOrderActorWithJournal(map, new Map(), 'a1', { ClientOrderID: 'c1' }), HER);
  assert.equal(resolveOrderActorWithJournal(map, new Map(), 'other', { ID: 'b1' }), null, 'account-bound');
});

test('journal: conflicting actors stay unresolved and the legacy map cannot hide the conflict; legacy is only a fallback', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await j.record({ accountId: 'a1', actor: HER, orderIds: ['b1'] });
  await j.record({ accountId: 'a1', actor: GUA, orderIds: ['b1'] });
  const { map } = await j.loadMap('a1');
  const legacy = new Map([[`a1\0b1`, new Map([['herald\0Herald', HER]])], [`a1\0b2`, new Map([['guardian\0Guardian', GUA]])]]);
  assert.equal(resolveOrderActorWithJournal(map, legacy, 'a1', { ID: 'b1' }), null, 'journal conflict stays unknown even though legacy has one actor');
  assert.deepEqual(resolveOrderActorWithJournal(map, legacy, 'a1', { ID: 'b2' }), GUA, 'no journal evidence falls back to session evidence');
  assert.equal(resolveOrderActor(legacy, 'a1', { ID: 'b1' }).agentId, 'herald');
});

test('journal: torn tail is terminated not rewritten, malformed lines are counted and skipped, later entries still read', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await j.record({ accountId: 'a1', actor: HER, orderIds: ['b1'] });
  const file = path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl');
  await fs.appendFile(file, '{"v":1,"accountId":"a1","orderIds":["b9"],"agentId":"x"'); // crash mid-line
  const torn = await new OrderAttributionJournal(dir).loadMap('a1');
  assert.equal(torn.report.incompleteTail, true);
  assert.equal(torn.report.entries, 1);
  const j2 = new OrderAttributionJournal(dir);
  await j2.record({ accountId: 'a1', actor: GUA, orderIds: ['b2'] });
  const after = await j2.loadMap('a1');
  assert.equal(after.report.malformed, 1, 'the torn fragment is one malformed line');
  assert.equal(after.report.entries, 2);
  assert.deepEqual(resolveOrderActorWithJournal(after.map, new Map(), 'a1', { ID: 'b2' }), GUA);
  assert.deepEqual(resolveOrderActorWithJournal(after.map, new Map(), 'a1', { ID: 'b1' }), HER);
});

test('journal: concurrent records for one account are serialised into complete lines', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await Promise.all(Array.from({ length: 40 }, (_, i) => j.record({ accountId: 'a1', actor: HER, orderIds: [`b${i}`, `c${i}`] })));
  const { report } = await j.loadMap('a1');
  assert.deepEqual([report.entries, report.malformed], [40, 0]);
});

test('journal: invalid account id, unreadable journal and write failure are contained', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await assert.rejects(() => j.record({ accountId: '../x', actor: HER, orderIds: ['b1'] }), /invalid account/);
  assert.equal(j.status().failures, 1);
  // a directory where the journal file should be: append fails, loadMap throws (server falls back), status counts
  await fs.mkdir(path.join(dir, 'sandboxes', 'a2', 'order-attribution.jsonl'), { recursive: true });
  await assert.rejects(() => j.record({ accountId: 'a2', actor: HER, orderIds: ['b1'] }));
  assert.equal(j.status().failures, 2);
  assert.ok(j.status().lastFailureCode);
  await assert.rejects(() => j.loadMap('a2'));
});

test('harness captures the turn-start actor from the full result, never blocks the order, and warns on write failure', async t => {
  const dir = await tmp(t);
  const spawnWith = result => () => {
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false; proc.kill = () => {};
    queueMicrotask(() => {
      proc.stdout.emit('data', JSON.stringify({ type: 'tool_use', sessionID: 'sess', part: { tool: 'prophet_place_options_order', state: { input: { client_order_id: 'client-1' }, output: result, status: 'completed' } } }) + '\n');
      proc.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 'sess', part: { text: 'done' } }) + '\n');
      proc.emit('exit', 0, null); proc.emit('close', 0, null);
    });
    return proc;
  };
  const make = (journal, spawnFn) => {
    const h = new AgentHarness({ chatStore: new ChatStore(dir), orderAttributionJournal: journal, sandboxId: 'sbx-a', accountId: 'a1', spawnFn, getAccount: () => ({ brokerAccountId: 'BRK', paper: true }) });
    h.state.running = true; h.state.activeAccountId = 'a1'; h.state.activeAgentId = 'herald'; h.state.activeModel = 'opencode/test'; h._agentConfig = { id: 'herald', name: 'Herald' };
    return h;
  };
  // 1) actor captured at turn start even though the assignment changes before the result is processed
  const journal = new OrderAttributionJournal(dir);
  const h1 = make(journal, spawnWith('{"order_id":"broker-1"}'));
  const beat = h1._adHocBeat('go');
  h1.state.activeAgentId = 'pendulum'; h1._agentConfig = { id: 'pendulum', name: 'Pendulum' };
  await beat;
  await new Promise(r => setTimeout(r, 50));
  const { map } = await journal.loadMap('a1');
  assert.deepEqual(resolveOrderActorWithJournal(map, new Map(), 'a1', { ID: 'broker-1', ClientOrderID: 'client-1' }), HER);
  const raw = await fs.readFile(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl'), 'utf8');
  assert.deepEqual([JSON.parse(raw).brokerAccountId, JSON.parse(raw).paper, JSON.parse(raw).source], ['BRK', true, 'live']);
  // 2) a result larger than the capture limit is still recorded (captured before truncation of the chat record)
  const h2 = make(journal, spawnWith(JSON.stringify({ order_id: 'broker-big', pad: 'x'.repeat(30000) })));
  await h2._adHocBeat('go'); await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(resolveOrderActorWithJournal((await journal.loadMap('a1')).map, new Map(), 'a1', { ID: 'broker-big' }), HER);
  // 3) journal failure: the beat still completes, the tool result is still persisted, a visible warning is logged without raw error text
  const failing = { record: () => Promise.reject(Object.assign(new Error('SECRET-DISK-PATH /var/x'), { code: 'EIO' })), status: () => ({}) };
  const h3 = make(failing, spawnWith('{"order_id":"broker-3"}'));
  const logs = []; h3.state.on('agent_log', e => logs.push(e));
  await h3._adHocBeat('go'); await new Promise(r => setTimeout(r, 50));
  assert.ok(logs.some(e => e.level === 'warning' && /Order attribution record failed \(EIO\)/.test(e.message)));
  assert.ok(!logs.some(e => /SECRET-DISK-PATH/.test(e.message)));
  assert.equal((await new ChatStore(dir).getSessionMessages('a1', 'sess')).filter(m => m.kind === 'tool_call').length >= 1, true);
  // 4) a throwing journal never escapes into order handling
  const throwing = { record: () => { throw new Error('boom'); }, status: () => ({}) };
  await assert.doesNotReject(() => make(throwing, spawnWith('{"order_id":"broker-4"}'))._adHocBeat('go'));
  // 5) no journal configured: unchanged behaviour
  await assert.doesNotReject(() => make(null, spawnWith('{"order_id":"broker-5"}'))._adHocBeat('go'));
});

test('backfill: dry run writes nothing; apply imports typed-actor evidence from orphan files only once; manager, metadata-only, errored and refusals are not imported', async t => {
  const dir = await tmp(t);
  const chat = path.join(dir, 'sandboxes', 'a1', 'chat-history'); await fs.mkdir(chat, { recursive: true });
  const w = (id, rows) => fs.writeFile(path.join(chat, `session-${id}.jsonl`), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  await w('s1', [call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { timestamp: '2026-11-10T00:00:00Z' }), call('get_orders', { oid: 'x', cid: 'x' }, HER), '{broken']);
  await w('s2', [call('place_options_order', { oid: 'b2', cid: 'c2' }, GUA), call('place_options_order', { oid: 'b3', cid: 'c3' }, null),
    call('place_options_order', { oid: 'b4', cid: 'c4' }, HER, { error: 'x' }), call('place_options_order', { oid: 'b5', cid: 'c5' }, HER, { result: '{"error":"refused"}' }),
    call('place_options_order', { oid: 'b6', cid: 'c6' }, { agentId: 'manager', agentName: 'Manager', metadata: { mode: 'manager' } })]);
  const before = await fs.readdir(chat);
  const j = new OrderAttributionJournal(dir);
  const dry = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: false });
  assert.equal(dry.applied, false); assert.equal(dry.malformed, 1);
  await assert.rejects(() => fs.stat(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl')), /ENOENT/);
  const ap = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: true, identity: { sandboxId: 'sbx', brokerAccountId: 'BRK', paper: true } });
  assert.equal(ap.appended, 2);
  const { map } = await j.loadMap('a1');
  assert.deepEqual(resolveOrderActorWithJournal(map, new Map(), 'a1', { ID: 'b1' }), HER);
  assert.deepEqual(resolveOrderActorWithJournal(map, new Map(), 'a1', { ID: 'b2' }), GUA);
  for (const id of ['b3', 'b4', 'b5', 'b6']) assert.equal(resolveOrderActorWithJournal(map, new Map(), 'a1', { ID: id }), null, `${id} must stay unknown`);
  const again = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: new OrderAttributionJournal(dir), apply: true });
  assert.equal(again.appended, 0); assert.equal(again.alreadyRecorded, 2);
  assert.deepEqual(await fs.readdir(chat), before, 'chat-history was not modified (no cache or index written)');
});

test('financial invariance: attributing orders through the journal changes only actor fields on the ledger (D-A5)', async () => {
  const { buildTradeLedger } = await import('../agent/trade-ledger.js');
  const o = (id, side, time, price) => ({ ID: id, ClientOrderID: `client-${id}`, Symbol: 'XYZ', Side: side, Status: 'filled', FilledQty: 1, FilledAvgPrice: price, FilledAt: time });
  const meta = { accountId: 'a1', accountName: 'L1', brokerAccountId: 'BRK', paperLive: 'paper', identityVerified: true, sandboxId: 'sbx' };
  const frozen = [o('b1', 'buy', '2026-11-10T15:00:00Z', 10), o('b2', 'sell', '2026-11-11T15:00:00Z', 12)];
  const unattributed = frozen.map(x => ({ ...x, actorSnapshot: null, agentId: null, agentName: 'Unknown historical agent' }));
  const map = new Map([[`a1\0b1`, new Map([['herald\0Herald', HER]])], [`a1\0b2`, new Map([['guardian\0Guardian', GUA]])]]);
  const attributed = frozen.map(x => { const a = resolveOrderActorWithJournal(map, new Map(), 'a1', x); return { ...x, actorSnapshot: a, agentId: a?.agentId || null, agentName: a?.agentName || 'Unknown historical agent' }; });
  const strip = trades => JSON.parse(JSON.stringify(buildTradeLedger(trades, meta)), (k, v) => (/agent|actor/i.test(k) ? undefined : v));
  assert.deepEqual(strip(attributed), strip(unattributed));
  assert.notDeepEqual(JSON.stringify(buildTradeLedger(attributed, meta)), JSON.stringify(buildTradeLedger(unattributed, meta)), 'actor fields do change');
});
