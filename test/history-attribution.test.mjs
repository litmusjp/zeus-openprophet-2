import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { ChatStore } from '../agent/chat-store.js';
import { AgentHarness } from '../agent/harness.js';
import { buildOrderActorMap, loadOrderActorMap, resolveOrderActor } from '../agent/history-attribution.js';
import { buildTradeLedger } from '../agent/trade-ledger.js';

const actor = (agentId, agentName) => ({ agentId, agentName });
const order = (id, side, time, price, actorSnapshot) => ({
  ID: id, ClientOrderID: `client-${id}`, Symbol: 'XYZ', Side: side,
  Status: 'filled', FilledQty: 1, FilledAvgPrice: price, FilledAt: time,
  ...(actorSnapshot ? { actorSnapshot } : {}),
});

test('resume preserves stored creator actor metadata and keeps future typed message snapshots', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-actor-resume-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ChatStore(dir);
  await store.startSession('acct', 'old-session', { agentId: 'herald', agentName: 'Herald', accountName: 'L1' });
  await store.startSession('acct', 'old-session', { agentId: 'pendulum', agentName: 'Pendulum', accountName: 'L1' });
  await store.addMessage('acct', 'old-session', { kind: 'heartbeat', actorSnapshot: actor('pendulum', 'Pendulum') });
  const reopened = new ChatStore(dir);
  const session = await reopened.getSession('acct', 'old-session');
  assert.equal(session.metadata.agentId, 'herald');
  assert.equal(session.metadata.agentName, 'Herald');
  assert.deepEqual((await reopened.getSessionMessages('acct', 'old-session'))[0].actorSnapshot, actor('pendulum', 'Pendulum'));
});

test('harness snapshots the turn actor onto persisted tool evidence and messages', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-actor-producer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const child = () => {
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false; proc.kill = () => { proc.killed = true; };
    queueMicrotask(() => {
      proc.stdout.emit('data', JSON.stringify({ type: 'tool_use', sessionID: 'new-session', part: {
        tool: 'prophet_place_options_order', state: { input: { client_order_id: 'client-1' }, output: '{"order_id":"broker-1"}', status: 'completed' },
      } }) + '\n');
      proc.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 'new-session', part: { text: 'done' } }) + '\n');
      proc.emit('exit', 0, null); proc.emit('close', 0, null);
    });
    return proc;
  };
  const store = new ChatStore(dir);
  const harness = new AgentHarness({ chatStore: store, sandboxId: 'sbx-a', accountId: 'a1', spawnFn: child });
  harness.state.running = true; harness.state.activeAccountId = 'a1'; harness.state.activeAgentId = 'herald';
  harness.state.activeModel = 'opencode/test'; harness._agentConfig = { id: 'herald', name: 'Herald' };
  const beat = harness._adHocBeat('hello');
  harness.state.activeAgentId = 'pendulum'; harness._agentConfig = { id: 'pendulum', name: 'Pendulum' };
  await beat;
  const session = await new ChatStore(dir).getSession('a1', 'new-session');
  const messages = await new ChatStore(dir).getSessionMessages('a1', 'new-session');
  assert.deepEqual([session.metadata.agentId, session.metadata.agentName], ['herald', 'Herald']);
  assert.ok(messages.length >= 3);
  assert.ok(messages.every(message => message.actorSnapshot?.agentId === 'herald'));
  assert.equal(messages.find(message => message.kind === 'tool_call').result, '{"order_id":"broker-1"}');
  const actorMap = await loadOrderActorMap(new ChatStore(dir), 'a1');
  assert.deepEqual(resolveOrderActor(actorMap, 'a1', { ID: 'broker-1', ClientOrderID: 'client-1' }), actor('herald', 'Herald'));
});

test('missing indexed JSONL is safe in a subprocess and yields no actor evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-missing-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(path.resolve('agent/chat-store.js')).href;
  const source = `const { ChatStore } = await import(${JSON.stringify(moduleUrl)}); const s = new ChatStore(${JSON.stringify(dir)}); await s.startSession('acct','missing',{agentId:'herald',agentName:'Herald'}); const rows = await s.listOrderActorEvidence('acct'); if(rows.length !== 1 || rows[0].messages.length !== 0) process.exitCode=2;`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 5000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
});

test('assignment reset starts the newly assigned actor in a new session and preserves old history', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-assignment-reset-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new ChatStore(dir);
  await store.startSession('a1', 'old-herald-session', { agentId: 'herald', agentName: 'Herald', accountName: 'L1' });
  await store.addMessage('a1', 'old-herald-session', { role: 'assistant', kind: 'message', content: 'kept old text' });
  const child = () => {
    const proc = new EventEmitter(); proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false; proc.kill = () => { proc.killed = true; };
    queueMicrotask(() => { proc.stdout.emit('data', JSON.stringify({ type: 'text', sessionID: 'new-pendulum-session', part: { text: 'new actor response' } }) + '\n'); proc.emit('exit', 0, null); proc.emit('close', 0, null); });
    return proc;
  };
  const harness = new AgentHarness({ chatStore: store, sandboxId: 'sbx-a', accountId: 'a1', spawnFn: child,
    getSandbox: () => ({ id: 'sbx-a', accountId: 'a1', agent: { activeAgentId: 'pendulum', model: 'opencode/test' } }),
    getResolvedAgent: () => ({ id: 'pendulum', name: 'Pendulum', model: 'opencode/test' }), getAccount: () => ({ id: 'a1', name: 'L1' }) });
  harness.state.running = true; harness.state.activeAccountId = 'a1'; harness._sessionId = 'old-herald-session'; harness._sessionEpoch = 1;
  await harness.reloadConfig({ resetSession: true, silent: true });
  assert.equal(harness._sessionId, null); assert.equal(harness._sessionEpoch, 2);
  await harness._adHocBeat('new turn');
  const reopened = new ChatStore(dir);
  const oldSession = await reopened.getSession('a1', 'old-herald-session');
  const newSession = await reopened.getSession('a1', 'new-pendulum-session');
  assert.deepEqual([oldSession.metadata.agentId, oldSession.metadata.agentName], ['herald', 'Herald']);
  assert.equal((await reopened.getSessionMessages('a1', 'old-herald-session'))[0].content, 'kept old text');
  assert.deepEqual([newSession.metadata.agentId, newSession.metadata.agentName], ['pendulum', 'Pendulum']);
  const server = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  assert.match(server, /refreshHarnessConfigForSandbox\(req\.params\.id, \{ resetSession: true \}\)/);
});

test('only exact submitting tool evidence attributes account-scoped broker IDs', () => {
  const session = { id: 's1', accountId: 'a1', metadata: actor('herald', 'Herald') };
  const evidence = [
    { accountId: 'a1', kind: 'tool_call', tool: 'place_options_order', args: { client_order_id: 'client-1' }, result: '{"order_id":"broker-1","status":"accepted"}', status: 'completed' },
    { accountId: 'a1', kind: 'tool_call', tool: 'place_options_order', args: { client_order_id: 'client-2' }, result: '{"order_id":"broker-2","status":"accepted"}', status: 'completed', actorSnapshot: actor('pendulum', 'Pendulum') },
    { accountId: 'a1', kind: 'tool_call', tool: 'get_orders', result: '{"order_id":"read-only"}', status: 'completed' },
    { accountId: 'a1', kind: 'tool_call', tool: 'place_buy_order', result: '{"position":{"id":"non-order"}}', status: 'completed' },
  ];
  const map = buildOrderActorMap('a1', [{ ...session, messages: evidence }]);
  assert.deepEqual(resolveOrderActor(map, 'a1', { ID: 'broker-1', ClientOrderID: 'client-1' }), actor('herald', 'Herald'));
  assert.deepEqual(resolveOrderActor(map, 'a1', { ID: 'broker-2', ClientOrderID: 'client-2' }), actor('pendulum', 'Pendulum'));
  assert.equal(resolveOrderActor(map, 'a2', { ID: 'broker-1', ClientOrderID: 'client-1' }), null);
  assert.equal(resolveOrderActor(map, 'a1', { ID: 'read-only' }), null);
  assert.equal(resolveOrderActor(map, 'a1', { ID: 'non-order' }), null);
});

test('structured MCP text JSON order receipt is accepted while malformed and prose are ignored', () => {
  const map = buildOrderActorMap('a1', [{ accountId: 'a1', metadata: actor('herald', 'Herald'), messages: [
    { kind: 'tool_call', tool: 'prophet_place_options_order', status: 'completed', result: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ order_id: 'mcp-broker-id' }) }] }) },
    { kind: 'tool_call', tool: 'place_buy_order', status: 'completed', result: '{"content":[{"text":"order_id: guessed-from-prose"}]}' },
    { kind: 'tool_call', tool: 'place_sell_order', status: 'completed', result: '{malformed' },
  ] }]);
  assert.deepEqual(resolveOrderActor(map, 'a1', { ID: 'mcp-broker-id' }), actor('herald', 'Herald'));
  assert.equal(resolveOrderActor(map, 'a1', { ID: 'guessed-from-prose' }), null);
});

test('conflicting or truncated execution evidence remains unknown', () => {
  const base = { accountId: 'a1', kind: 'tool_call', tool: 'place_buy_order', args: {}, status: 'completed' };
  const sessions = [
    { accountId: 'a1', metadata: actor('herald', 'Herald'), messages: [{ ...base, result: '{"order_id":"same"}' }] },
    { accountId: 'a1', metadata: actor('pendulum', 'Pendulum'), messages: [{ ...base, result: '{"order_id":"same"}' }] },
    { accountId: 'a1', metadata: actor('surge', 'Surge'), messages: [{ ...base, result: '{"order_id":"truncated"}', resultTruncated: true }] },
  ];
  const map = buildOrderActorMap('a1', sessions);
  assert.equal(resolveOrderActor(map, 'a1', { ID: 'same' }), null);
  assert.equal(resolveOrderActor(map, 'a1', { ID: 'truncated' }), null);
});

test('realized FIFO P&L is unchanged and retains entry and exit actors separately', () => {
  const session = { accountId: 'a1', metadata: actor('herald', 'Herald'), messages: [
    { kind: 'tool_call', tool: 'place_buy_order', args: { client_order_id: 'client-entry' }, result: '{"order_id":"entry"}', status: 'completed' },
    { kind: 'tool_call', tool: 'place_sell_order', actorSnapshot: actor('pendulum', 'Pendulum'), args: { client_order_id: 'client-exit' }, result: '{"order_id":"exit"}', status: 'completed' },
  ] };
  const actorMap = buildOrderActorMap('a1', [session]);
  const orders = [
    order('entry', 'buy', '2026-01-01T10:00:00Z', 2, resolveOrderActor(actorMap, 'a1', { ID: 'entry', ClientOrderID: 'client-entry' })),
    order('exit', 'sell', '2026-01-01T11:00:00Z', 3, resolveOrderActor(actorMap, 'a1', { ID: 'exit', ClientOrderID: 'client-exit' })),
  ];
  const rows = buildTradeLedger(orders, { accountId: 'a1', accountName: 'L1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pnl, 1);
  assert.equal(rows[0].entryOrderId, 'entry');
  assert.deepEqual([rows[0].agentId, rows[0].agentName], ['herald', 'Herald']);
  assert.deepEqual([rows[0].entryAgentId, rows[0].entryAgentName], ['herald', 'Herald']);
  assert.deepEqual([rows[0].exitAgentId, rows[0].exitAgentName], ['pendulum', 'Pendulum']);
});

test('realized trade context names distinct entry and exit actors', async () => {
  const page = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const start = page.indexOf('function realizedActorContext');
  const end = page.indexOf('\n}', start) + 2;
  assert.ok(start >= 0, 'realizedActorContext UI helper exists');
  const ctx = { Set, String };
  vm.createContext(ctx);
  vm.runInContext(page.slice(start, end), ctx);
  assert.equal(ctx.realizedActorContext([{ entryAgentName: 'Herald', exitAgentName: 'Pendulum' }]), 'Entry actor Herald → exit actor Pendulum');
  assert.equal(ctx.realizedActorContext([{ entryAgentName: 'Herald', exitAgentName: 'Herald' }]), '');
});

test('history transcript uses typed record actor before saved session actor and never a current target', async () => {
  const page = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const start = page.indexOf('function historyRecordActor');
  const end = page.indexOf('function renderHistoryTranscript', start);
  const ctx = { esc: value => String(value) };
  vm.createContext(ctx);
  vm.runInContext(page.slice(start, end), ctx);
  const session = { metadata: actor('herald', 'Herald') };
  assert.match(ctx.renderHistoryRecord({ role: 'assistant', content: 'old', actorSnapshot: actor('pendulum', 'Pendulum') }, session), /Pendulum.*assistant/);
  assert.match(ctx.renderHistoryRecord({ role: 'assistant', content: 'legacy' }, session), /Herald.*assistant/);
  assert.match(ctx.renderHistoryRecord({ role: 'assistant', content: 'unknown' }, { metadata: {} }), /Unknown historical agent.*assistant/);
  assert.match(ctx.renderHistoryRecord({ kind: 'tool_call', tool: 'place_options_order', status: 'completed' }, session), /Herald \| place_options_order/);
});
