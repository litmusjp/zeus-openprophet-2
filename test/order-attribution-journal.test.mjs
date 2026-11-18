import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { ChatStore } from '../agent/chat-store.js';
import { AgentHarness } from '../agent/harness.js';
import { resolveOrderActorWithJournal, resolveOrderActor } from '../agent/history-attribution.js';
import { buildTradeLedger } from '../agent/trade-ledger.js';
import { buildScorecard } from '../agent/trade-scorecard.js';
import { OrderAttributionJournal, attributionFromToolEvent, backfillOrderAttribution } from '../agent/order-attribution-journal.js';

const actor = (agentId, agentName) => ({ agentId, agentName });
const HER = actor('herald', 'Herald'), GUA = actor('guardian', 'Guardian');
const ID = { brokerAccountId: 'BRK', paper: true, sandboxId: 'sbx' };
const tmp = async t => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-attr-journal-')); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };
const call = (tool, ids, a, extra = {}) => ({ kind: 'tool_call', tool, status: 'completed', args: { client_order_id: ids.cid }, result: JSON.stringify({ order_id: ids.oid }), ...(a ? { actorSnapshot: a } : {}), ...extra });
const rec = (j, extra) => j.record({ accountId: 'a1', ...ID, actor: HER, orderIds: ['b1'], ...extra });
const load = (j, id = ID, acct = 'a1') => j.loadMap(acct, id);
const who = (map, id, acct = 'a1') => resolveOrderActorWithJournal(map, new Map(), acct, id);

test('evidence rules: typed snapshot only; errored, truncated, non-completed, manager and read-only calls record nothing', () => {
  assert.deepEqual(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER)), { actor: HER, orderIds: ['b1', 'c1'] });
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, null)), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { error: 'x' })), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { resultTruncated: true })), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { status: 'error' })), null);
  assert.equal(attributionFromToolEvent(call('get_orders', { oid: 'b1', cid: 'c1' }, HER)), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { result: JSON.stringify({ error: 'rejected' }) })), null);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { result: '{not json' })), null, 'malformed receipts stay out');
});

test('J-B02: valid receipts above the old 128 KiB bound are captured; the resource bound and eligibility rules remain', () => {
  const big = n => JSON.stringify({ order_id: 'b-big', pad: 'x'.repeat(n) });
  assert.ok(big(163000).length > 128 * 1024);
  assert.deepEqual(attributionFromToolEvent(call('place_options_order', { oid: 'x', cid: 'c-big' }, HER, { result: big(163000) })), { actor: HER, orderIds: ['b-big', 'c-big'] });
  const nested = JSON.stringify({ content: [{ type: 'text', text: big(163000) }] });
  assert.deepEqual(attributionFromToolEvent(call('place_options_order', { oid: 'x', cid: 'c-n' }, HER, { result: nested }))?.orderIds, ['b-big', 'c-n']);
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'x', cid: 'c-huge' }, HER, { result: big(5 * 1024 * 1024) })), null, 'bounded: 4 MiB cap');
  assert.equal(attributionFromToolEvent(call('place_options_order', { oid: 'x', cid: 'c-e' }, HER, { result: JSON.stringify({ order_id: 'b', error: 'x', pad: 'y'.repeat(200000) }) })), null);
});

test('journal: durable append, no secrets, idempotent, survives reopen, bound to the verified identity', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  const base = { accountId: 'a1', ...ID, actor: HER, orderIds: ['b1', 'c1'], at: '2026-11-18T01:00:00.000Z' };
  assert.deepEqual(await j.record(base), { ok: true });
  assert.deepEqual(await j.record(base), { ok: true, duplicate: true });
  const text = await fs.readFile(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl'), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['accountId', 'agentId', 'agentName', 'at', 'brokerAccountId', 'orderIds', 'paper', 'sandboxId', 'source', 'v']);
  const { map, report } = await load(new OrderAttributionJournal(dir));
  assert.equal(report.entries, 1);
  assert.deepEqual(who(map, { ID: 'b1' }), HER);
  assert.deepEqual(who(map, { ClientOrderID: 'c1' }), HER);
  assert.equal(who(map, { ID: 'b1' }, 'other'), null, 'account-bound');
});

test('J-B04: authoritative lookup requires the same broker account, PAPER flag and sandbox; unbound or mismatched entries are never used', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await rec(j, { orderIds: ['ok', 'shared-client'] });
  await rec(j, { actor: GUA, orderIds: ['x-broker', 'shared-client2'], brokerAccountId: 'OTHER-BRK' });
  await rec(j, { actor: GUA, orderIds: ['x-live', 'shared-client3'], paper: false });
  await rec(j, { actor: GUA, orderIds: ['x-sbx', 'shared-client4'], sandboxId: 'sbx-other' });
  await rec(j, { actor: GUA, orderIds: ['x-unbound'], brokerAccountId: null, paper: null, sandboxId: null });
  const { map, report } = await load(j);
  assert.deepEqual(who(map, { ID: 'ok' }), HER);
  for (const id of ['x-broker', 'shared-client2', 'x-live', 'shared-client3', 'x-sbx', 'shared-client4', 'x-unbound']) assert.equal(who(map, { ID: id }), null, `${id} must not resolve`);
  assert.deepEqual([report.entries, report.mismatched, report.unbound], [1, 3, 1]);
  // a different verified context sees none of the first context's evidence
  const other = await load(j, { brokerAccountId: 'OTHER-BRK', paper: true, sandboxId: 'sbx' });
  assert.equal(who(other.map, { ID: 'ok' }), null);
  assert.deepEqual(who(other.map, { ID: 'x-broker' }), GUA);
  // no verified context at all: nothing authoritative, reported
  const none = await load(j, { brokerAccountId: 'BRK' });
  assert.equal(none.map.size, 0); assert.equal(none.report.identityUnavailable, true);
});

test('journal: conflicting actors stay unresolved and the legacy map cannot hide the conflict; legacy is only a fallback', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await rec(j); await rec(j, { actor: GUA });
  const { map } = await load(j);
  const legacy = new Map([[`a1\0b1`, new Map([['herald\0Herald', HER]])], [`a1\0b2`, new Map([['guardian\0Guardian', GUA]])]]);
  assert.equal(resolveOrderActorWithJournal(map, legacy, 'a1', { ID: 'b1' }), null);
  assert.deepEqual(resolveOrderActorWithJournal(map, legacy, 'a1', { ID: 'b2' }), GUA);
  assert.equal(resolveOrderActor(legacy, 'a1', { ID: 'b1' }).agentId, 'herald');
});

test('journal: torn tail is terminated not rewritten, malformed lines counted, later entries still read; concurrent records stay whole lines', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await rec(j);
  const file = path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl');
  await fs.appendFile(file, '{"v":1,"accountId":"a1","orderIds":["b9"],"agentId":"x"');
  const torn = await load(new OrderAttributionJournal(dir));
  assert.equal(torn.report.incompleteTail, true); assert.equal(torn.report.entries, 1);
  const j2 = new OrderAttributionJournal(dir);
  await rec(j2, { actor: GUA, orderIds: ['b2'] });
  const after = await load(j2);
  assert.deepEqual([after.report.malformed, after.report.entries], [1, 2]);
  assert.deepEqual(who(after.map, { ID: 'b2' }), GUA);
  await Promise.all(Array.from({ length: 40 }, (_, i) => rec(j2, { orderIds: [`n${i}`, `m${i}`] })));
  const many = await load(j2);
  assert.equal(many.report.entries, 42); assert.equal(many.report.malformed, 1);
});

test('J-B03: dot, dot-dot and path-like account ids are rejected before any filesystem access (journal, load, backfill, CLI)', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  for (const bad of ['.', '..', '../x', 'a/b', 'a\\b', '', '.hidden', 'a..b', null]) {
    assert.throws(() => j.file(bad), /invalid account/, String(bad));
    await assert.rejects(() => j.record({ accountId: bad, ...ID, actor: HER, orderIds: ['b1'] }), /invalid account/);
    await assert.rejects(() => j.loadMap(bad, ID), /invalid account/);
    await assert.rejects(() => backfillOrderAttribution({ dataDir: dir, accountId: bad, journal: j }), /invalid account/);
  }
  assert.deepEqual(await fs.readdir(dir), [], 'no directory or file was created');
  for (const ok of ['litmus1', 'acct_known', 'a-1', 'a.b']) assert.doesNotThrow(() => j.file(ok));
  const cli = spawnSync(process.execPath, ['scripts/backfill-order-attribution.mjs', '--data-dir', dir, '--account', '..'], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.match(cli.stdout, /invalid_account/);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(j.status().failures >= 1, true);
});

test('journal: unreadable journal and write failure are contained', async t => {
  const dir = await tmp(t);
  const j = new OrderAttributionJournal(dir);
  await fs.mkdir(path.join(dir, 'sandboxes', 'a2', 'order-attribution.jsonl'), { recursive: true });
  await assert.rejects(() => j.record({ accountId: 'a2', ...ID, actor: HER, orderIds: ['b1'] }));
  assert.ok(j.status().lastFailureCode);
  await assert.rejects(() => j.loadMap('a2', ID));
});

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

test('harness captures the turn-start actor and identity, including above-128-KiB receipts, never blocks the order, warns on write failure', async t => {
  const dir = await tmp(t);
  const make = (journal, spawnFn) => {
    const h = new AgentHarness({ chatStore: new ChatStore(dir), orderAttributionJournal: journal, sandboxId: 'sbx', accountId: 'a1', spawnFn, getAccount: () => ({ brokerAccountId: 'BRK', paper: true }) });
    h.state.running = true; h.state.activeAccountId = 'a1'; h.state.activeAgentId = 'herald'; h.state.activeModel = 'opencode/test'; h._agentConfig = { id: 'herald', name: 'Herald' };
    return h;
  };
  const journal = new OrderAttributionJournal(dir);
  const h1 = make(journal, spawnWith('{"order_id":"broker-1"}'));
  const beat = h1._adHocBeat('go');
  h1.state.activeAgentId = 'pendulum'; h1._agentConfig = { id: 'pendulum', name: 'Pendulum' };
  await beat; await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(who((await load(journal)).map, { ID: 'broker-1', ClientOrderID: 'client-1' }), HER);
  const raw = await fs.readFile(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl'), 'utf8');
  assert.deepEqual([JSON.parse(raw).brokerAccountId, JSON.parse(raw).paper, JSON.parse(raw).sandboxId, JSON.parse(raw).source], ['BRK', true, 'sbx', 'live']);
  // J-B02 through the real harness path: 163 KB receipt, chat record still truncated, journal keeps compact ids only
  const huge = JSON.stringify({ order_id: 'broker-big', pad: 'x'.repeat(163000) });
  await make(journal, spawnWith(huge))._adHocBeat('go'); await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(who((await load(journal)).map, { ID: 'broker-big' }), HER);
  assert.ok(!(await fs.readFile(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl'), 'utf8')).includes('xxxxxxxx'), 'no raw receipt in the journal');
  const stored = (await new ChatStore(dir).getSessionMessages('a1', 'sess')).filter(m => m.kind === 'tool_call').pop();
  assert.ok(stored.resultTruncated === true && stored.result.length <= 128 * 1024, 'chat truncation unchanged');
  // failing and throwing journals never affect the beat; warning carries a fixed code only
  const failing = { record: () => Promise.reject(Object.assign(new Error('SECRET-DISK-PATH /var/x'), { code: 'EIO' })), status: () => ({}) };
  const h3 = make(failing, spawnWith('{"order_id":"broker-3"}'));
  const logs = []; h3.state.on('agent_log', e => logs.push(e));
  await h3._adHocBeat('go'); await new Promise(r => setTimeout(r, 50));
  assert.ok(logs.some(e => e.level === 'warning' && /Order attribution record failed \(EIO\)/.test(e.message)));
  assert.ok(!logs.some(e => /SECRET-DISK-PATH/.test(e.message)));
  await assert.doesNotReject(() => make({ record: () => { throw new Error('boom'); }, status: () => ({}) }, spawnWith('{"order_id":"broker-4"}'))._adHocBeat('go'));
  await assert.doesNotReject(() => make(null, spawnWith('{"order_id":"broker-5"}'))._adHocBeat('go'));
});

test('J-B01: the shared journal reaches every orchestrated harness; two accounts record only their own evidence', async t => {
  const dir = await tmp(t);
  const configPath = path.join(dir, 'agent-config.json');
  const previous = { config: process.env.OPENPROPHET_CONFIG_PATH, mode: process.env.OPENPROPHET_EXECUTION_MODE };
  process.env.OPENPROPHET_CONFIG_PATH = configPath; process.env.OPENPROPHET_EXECUTION_MODE = 'inert';
  t.after(() => { for (const [k, v] of [['OPENPROPHET_CONFIG_PATH', previous.config], ['OPENPROPHET_EXECUTION_MODE', previous.mode]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  await fs.writeFile(configPath, JSON.stringify({
    accounts: [{ id: 'acct1', name: 'A1', brokerAccountId: 'BRK1', paper: true }, { id: 'acct2', name: 'A2', brokerAccountId: 'BRK2', paper: true }],
    sandboxes: { sbx1: { id: 'sbx1', accountId: 'acct1' }, sbx2: { id: 'sbx2', accountId: 'acct2' } },
  }));
  await (await import('../agent/config-store.js')).loadConfig();
  const { AgentOrchestrator } = await import(`../agent/orchestrator.js?journal-wiring=${Date.now()}`);
  const journal = new OrderAttributionJournal(dir);
  const orchestrator = new AgentOrchestrator({ projectRoot: dir, orderAttributionJournal: journal });
  const r1 = orchestrator.ensureRuntime('sbx1'), r2 = orchestrator.ensureRuntime('sbx2');
  assert.equal(r1.harness.orderAttributionJournal, journal); assert.equal(r2.harness.orderAttributionJournal, journal);
  const ev = (oid, a) => ({ kind: 'tool_call', tool: 'prophet_place_options_order', status: 'completed', args: { client_order_id: `c-${oid}` }, result: JSON.stringify({ order_id: oid }), actorSnapshot: a, completedAt: '2026-11-18T01:00:00Z' });
  r1.harness._captureOrderAttribution(ev('o1', HER), { accountId: 'acct1', sandboxId: 'sbx1', actorSnapshot: HER });
  r2.harness._captureOrderAttribution(ev('o2', GUA), { accountId: 'acct2', sandboxId: 'sbx2', actorSnapshot: GUA });
  await new Promise(r => setTimeout(r, 100));
  const m1 = (await new OrderAttributionJournal(dir).loadMap('acct1', { brokerAccountId: 'BRK1', paper: true, sandboxId: 'sbx1' })).map;
  const m2 = (await new OrderAttributionJournal(dir).loadMap('acct2', { brokerAccountId: 'BRK2', paper: true, sandboxId: 'sbx2' })).map;
  assert.deepEqual(who(m1, { ID: 'o1' }, 'acct1'), HER); assert.equal(who(m1, { ID: 'o2' }, 'acct1'), null);
  assert.deepEqual(who(m2, { ID: 'o2' }, 'acct2'), GUA); assert.equal(who(m2, { ID: 'o1' }, 'acct2'), null);
  // application wiring pins: server hands the one journal to the orchestrator and to its own harness, and binds the lookup identity
  const server = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  assert.match(server, /new AgentOrchestrator\(\{\s*chatStore,\s*orderAttributionJournal,/);
  assert.match(server, /\n\s*chatStore,\s*\n\s*orderAttributionJournal,\s*\n\s*opencodeEnv:/);
  assert.match(server, /loadMap\(account\.id, \{ brokerAccountId: account\.brokerAccountId, paper: account\.paper, sandboxId: sandbox\.id \}\)/);
  assert.match(server, /attributionJournal: \{ \.\.\.orderAttributionJournal\.status\(\), read: journalReads \}/);
});

const writeSessions = async (dir, files, index, cache) => {
  const chat = path.join(dir, 'sandboxes', 'a1', 'chat-history'); await fs.mkdir(chat, { recursive: true });
  for (const [id, rows] of Object.entries(files)) await fs.writeFile(path.join(chat, `session-${id}.jsonl`), rows.map(r => typeof r === 'string' ? r : JSON.stringify(r)).join('\n') + '\n');
  if (index) await fs.writeFile(path.join(chat, 'sessions.json'), JSON.stringify({ sessions: index }));
  if (cache) await fs.writeFile(path.join(chat, 'order-evidence-cache.json'), JSON.stringify({ sessions: cache }));
  return chat;
};
const snapshotDir = async dir => { const out = []; for (const n of (await fs.readdir(dir)).sort()) out.push([n, (await fs.readFile(path.join(dir, n))).toString('base64')]); return JSON.stringify(out); };

test('backfill: read-only dry run; apply needs a verified identity and writes bound entries once; refusals, errors, untyped rows are not imported', async t => {
  const dir = await tmp(t);
  const chat = await writeSessions(dir, {
    s1: [call('place_options_order', { oid: 'b1', cid: 'c1' }, HER, { timestamp: '2026-11-10T00:00:00Z' }), call('get_orders', { oid: 'x', cid: 'x' }, HER), '{broken'],
    s2: [call('place_options_order', { oid: 'b2', cid: 'c2' }, GUA), call('place_options_order', { oid: 'b3', cid: 'c3' }, null),
      call('place_options_order', { oid: 'b4', cid: 'c4' }, HER, { error: 'x' }), call('place_options_order', { oid: 'b5', cid: 'c5' }, HER, { result: '{"error":"refused"}' })],
  }, [{ id: 's1', metadata: { agentId: 'herald', agentName: 'Herald' } }]);
  const before = await snapshotDir(chat);
  const j = new OrderAttributionJournal(dir);
  const dry = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: false });
  assert.deepEqual([dry.applied, dry.malformed, dry.appended, dry.identityBound], [false, 1, 2, false]);
  await assert.rejects(() => fs.stat(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl')), /ENOENT/);
  await assert.rejects(() => backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: true }), /verified identity required/);
  await assert.rejects(() => backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: true, identity: { brokerAccountId: 'BRK', paper: true } }), /verified identity required/);
  const ap = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: true, identity: ID });
  assert.equal(ap.appended, 2);
  const { map } = await load(j);
  assert.deepEqual(who(map, { ID: 'b1' }), HER); assert.deepEqual(who(map, { ID: 'b2' }), GUA);
  for (const id of ['b3', 'b4', 'b5']) assert.equal(who(map, { ID: id }), null);
  assert.equal(who((await load(j, { ...ID, brokerAccountId: 'OTHER' })).map, { ID: 'b1' }), null, 'bound to the supplied identity');
  const again = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: new OrderAttributionJournal(dir), apply: true, identity: ID });
  assert.deepEqual([again.appended, again.alreadyRecorded], [0, 2]);
  assert.equal(await snapshotDir(chat), before, 'chat-history bytes unchanged (no cache, index or session write)');
});

test('J-B05: session-level manager exclusion is preserved from read-only index/cache metadata; genuine agent and orphan sessions still import; no metadata-only inference', async t => {
  const dir = await tmp(t);
  const row = (oid, a = HER) => call('place_options_order', { oid, cid: `c-${oid}` }, a);
  const chat = await writeSessions(dir, {
    mgr_index: [row('m1')], mgr_cache_orphan: [row('m2')], agent_indexed: [row('g1')], agent_orphan: [row('g2')], untyped_agent: [call('place_options_order', { oid: 'u1', cid: 'c-u1' }, null)],
  }, [
    { id: 'mgr_index', metadata: { mode: 'manager', agentId: 'manager', agentName: 'Manager' } },
    { id: 'agent_indexed', metadata: { agentId: 'herald', agentName: 'Herald' } },
    { id: 'untyped_agent', metadata: { agentId: 'herald', agentName: 'Herald' } },
  ], { mgr_cache_orphan: { signature: 's', metadata: { mode: 'manager' }, messages: [], adoptions: [] } });
  const before = await snapshotDir(chat);
  const j = new OrderAttributionJournal(dir);
  const out = await backfillOrderAttribution({ dataDir: dir, accountId: 'a1', journal: j, apply: true, identity: ID });
  assert.equal(out.managerExcluded, 2);
  const { map } = await load(j);
  for (const id of ['m1', 'm2', 'u1']) assert.equal(who(map, { ID: id }), null, `${id} must not be imported`);
  assert.deepEqual(who(map, { ID: 'g1' }), HER); assert.deepEqual(who(map, { ID: 'g2' }), HER);
  assert.equal(await snapshotDir(chat), before, 'index, cache and session bytes unchanged');
});

test('backfill CLI: apply without an identity file fails closed; with a verified identity file it writes bound entries', async t => {
  const dir = await tmp(t);
  await writeSessions(dir, { s1: [call('place_options_order', { oid: 'b1', cid: 'c1' }, HER)] });
  const run = extra => JSON.parse(spawnSync(process.execPath, ['scripts/backfill-order-attribution.mjs', '--data-dir', dir, '--account', 'a1', ...extra], { cwd: path.resolve('.'), encoding: 'utf8' }).stdout);
  assert.equal(run(['--apply']).accounts.a1.error, 'identity_required');
  assert.equal(run([]).accounts.a1.appended, 1);
  await assert.rejects(() => fs.stat(path.join(dir, 'sandboxes', 'a1', 'order-attribution.jsonl')), /ENOENT/);
  const idFile = path.join(dir, 'identity.json'); await fs.writeFile(idFile, JSON.stringify({ a1: ID }));
  assert.equal(run(['--apply', '--identity-file', idFile]).accounts.a1.appended, 1);
  const j = new OrderAttributionJournal(dir);
  assert.deepEqual(who((await load(j)).map, { ID: 'b1' }), HER);
  assert.equal(who((await load(j, { ...ID, sandboxId: 'sbx-x' })).map, { ID: 'b1' }), null);
});

test('financial invariance (D-A5): attributing through the journal changes only agent/actor fields; scorecard totals and per-day buckets conserved, per-agent buckets regroup', () => {
  const o = (id, side, time, price) => ({ ID: id, ClientOrderID: `client-${id}`, Symbol: 'XYZ', Side: side, Status: 'filled', FilledQty: 1, FilledAvgPrice: price, FilledAt: time });
  const meta = { accountId: 'a1', accountName: 'L1', brokerAccountId: 'BRK', paperLive: 'paper', identityVerified: true, sandboxId: 'sbx' };
  const frozen = [o('b1', 'buy', '2026-11-10T15:00:00Z', 10), o('b2', 'sell', '2026-11-11T15:00:00Z', 12), o('b3', 'buy', '2026-11-11T16:00:00Z', 20), o('b4', 'sell', '2026-11-12T15:00:00Z', 18)];
  const unattributed = frozen.map(x => ({ ...x, actorSnapshot: null, agentId: null, agentName: 'Unknown historical agent' }));
  const map = new Map([['b1', HER], ['b2', GUA], ['b3', HER], ['b4', HER]].map(([id, a]) => [`a1\0${id}`, new Map([[`${a.agentId}\0${a.agentName}`, a]])]));
  const attributed = frozen.map(x => { const a = resolveOrderActorWithJournal(map, new Map(), 'a1', x); return { ...x, actorSnapshot: a, agentId: a?.agentId || null, agentName: a?.agentName || 'Unknown historical agent' }; });
  const strip = v => JSON.parse(JSON.stringify(v), (k, val) => (/agent|actor/i.test(k) ? undefined : val));
  const lA = buildTradeLedger(attributed, meta), lU = buildTradeLedger(unattributed, meta);
  assert.deepEqual(strip(lA), strip(lU));
  const sA = buildScorecard(lA), sU = buildScorecard(lU);
  assert.deepEqual(sA.total, sU.total); assert.deepEqual(sA.byDay, sU.byDay);
  assert.deepEqual(strip(sA.rows), strip(sU.rows));
  const sum = by => Object.values(by).reduce((a, b) => ({ trades: a.trades + b.trades, totalPnl: Number((a.totalPnl + b.totalPnl).toFixed(2)) }), { trades: 0, totalPnl: 0 });
  assert.deepEqual(sum(sA.byAgent), { trades: sA.total.trades, totalPnl: sA.total.totalPnl });
  assert.deepEqual(Object.keys(sU.byAgent), ['unknown']);
  assert.ok(Object.keys(sA.byAgent).includes('herald'), 'per-agent buckets regroup once identity is recovered');
});
