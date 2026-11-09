import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { AgentHarness, buildSystemPrompt, isContextOverflow } from '../agent/harness.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

const guidance = (strategyId, over = {}) => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, ...over }, { strategyId });

test('context overflow qualifies for a fresh-session retry only before any tool call', () => {
  const msg = 'ContextOverflowError: your input exceeds the context window of this model';
  assert.equal(isContextOverflow({ error: msg, toolCalls: 0, toolEvents: [] }), true);
  assert.equal(isContextOverflow({ error: 'maximum context length is 400000 tokens', toolCalls: 0 }), true);
  assert.equal(isContextOverflow({ error: msg, toolCalls: 3, toolEvents: [] }), false);
  assert.equal(isContextOverflow({ error: msg, toolCalls: 0, toolEvents: [{ tool: 'get_account' }] }), false);
  assert.equal(isContextOverflow({ error: 'webfetch returned 403', toolCalls: 0, toolEvents: [] }), false);
  assert.equal(isContextOverflow({ toolCalls: 0 }), false);
  assert.equal(isContextOverflow(null), false);
});

test('a beat that overflows the context window is retried once in a fresh session', async () => {
  const { EventEmitter } = await import('node:events');
  function fakeProcess(lines, exitCode = 0, stderr = '') {
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter(); proc.stdin.write = () => true; proc.stdin.end = () => {};
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
    proc.killed = false; proc.kill = () => { proc.killed = true; };
    queueMicrotask(() => {
      for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
      if (stderr) proc.stderr.emit('data', stderr);
      proc.emit('exit', exitCode, null); proc.emit('close', exitCode, null);
    });
    return proc;
  }
  const runs = [
    [[{ type: 'error', error: { name: 'ContextOverflowError', data: { message: 'your input exceeds the context window of this model' } } }], 1,
      'ContextOverflowError: your input exceeds the context window of this model'],
    [[{ type: 'text', sessionID: 'fresh', part: { text: 'recovered answer' } }], 0],
  ];
  const writes = [];
  let spawns = 0;
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async getRecentContext() { return []; },
      async startSession() {},
      async addMessage(account, session, message) { writes.push(message); },
    },
    spawnFn: () => { spawns++; return fakeProcess(...runs.shift()); },
  });
  harness._beatRetryDelayMs = 0;
  harness.state.running = true;
  harness.state.activeAccountId = 'a';
  harness.state.activeModel = 'opencode/model';
  await harness._beat();
  assert.equal(spawns, 2, 'one retry');
  assert.equal(writes.filter(w => w?.kind === 'heartbeat').length, 1);
  assert.equal(writes.filter(w => w?.kind === 'heartbeat_failure').length, 0);
});

test('the fresh session mode setting reaches the resolved agent', async () => {
  const dir = await fs.mkdtemp(path.join(process.cwd(), '.tmp-r10-session-mode-'));
  const pathName = path.join(dir, 'agent-config.json');
  const oldPath = process.env.OPENPROPHET_CONFIG_PATH;
  const oldMode = process.env.OPENPROPHET_EXECUTION_MODE;
  process.env.OPENPROPHET_CONFIG_PATH = pathName;
  process.env.OPENPROPHET_EXECUTION_MODE = 'disabled';
  const sandbox = (id, overrides) => ({ id, accountId: 'account_fixture', name: id, agent: { activeAgentId: 'default', overrides } });
  const boxes = {
    sbx_fresh: sandbox('sbx_fresh', { sessionMode: 'fresh' }),
    sbx_none: sandbox('sbx_none', {}),
    sbx_other_agent: sandbox('sbx_other_agent', { agentId: 'someone-else', sessionMode: 'fresh', name: 'Other' }),
  };
  await fs.writeFile(pathName, JSON.stringify({ activeSandboxId: 'sbx_fresh', sandboxes: boxes, accounts: [] }));
  try {
    const store = await import(`../agent/config-store.js?r10-session-mode=${Date.now()}`);
    await store.loadConfig();
    assert.equal(store.getResolvedAgentForSandbox('sbx_fresh').sessionMode, 'fresh');
    assert.equal(store.getResolvedAgentForSandbox('sbx_none').sessionMode, 'continuous');
    assert.equal(store.getResolvedAgentForSandbox('sbx_other_agent').sessionMode, 'fresh');
    await store.updateSandboxAgentOverrides('sbx_none', { sessionMode: 'fresh' });
    assert.equal(store.getResolvedAgentForSandbox('sbx_none').sessionMode, 'fresh');
  } finally {
    if (oldPath === undefined) delete process.env.OPENPROPHET_CONFIG_PATH; else process.env.OPENPROPHET_CONFIG_PATH = oldPath;
    if (oldMode === undefined) delete process.env.OPENPROPHET_EXECUTION_MODE; else process.env.OPENPROPHET_EXECUTION_MODE = oldMode;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('catalyst guidance drops the blockers found on Nov 9 and adds the new definitions', () => {
  const text = guidance('catalyst-news');
  assert.doesNotMatch(text, /verify the original event time/);
  assert.doesNotMatch(text, /plausible remaining move/);
  assert.doesNotMatch(text, /already crossed the target/);
  assert.doesNotMatch(text, /average volume of the range's completed bars/);
  assert.match(text, /average volume of the 6 completed 5-minute bars immediately before it/);
  assert.match(text, /earliest created_at among the articles about the same event/);
  assert.match(text, /gap from the previous close is more than 12%\./);
  assert.match(text, /take the half at the first permitted evaluation/);
});

test('the no-own-veto sentence is in the cost discipline line of every strategy family', () => {
  for (const id of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion']) {
    assert.match(guidance(id), /Do not add your own cost, edge or spread-versus-target veto/, id);
  }
});

test('Prophet and Vega scan on every beat, daily-bar strategies keep the early-end rule, catalyst is unchanged', async () => {
  const build = strategyId => buildSystemPrompt({ id: 'a', name: 'A', strategyId, customStrategyRules: 'rules' }, {});
  for (const id of ['default', 'long-premium-volatility']) {
    const p = await build(id);
    assert.match(p, /work through your strategy universe in batches/, id);
    assert.match(p, /incomplete research is never a reason to stop scanning/, id);
    assert.doesNotMatch(p, /reconcile, record the outcome and end the beat/, id);
  }
  for (const id of ['etf-mean-reversion', 'equity-momentum']) {
    const p = await build(id);
    assert.match(p, /reconcile, record the outcome and end the beat/, id);
    assert.doesNotMatch(p, /work through your strategy universe in batches/, id);
  }
  const c = await build('catalyst-news');
  assert.match(c, /Catalyst setups are intraday/);
  assert.doesNotMatch(c, /work through your strategy universe in batches/);
});

test('a rate-limited GET is retried with a wait, but orders and other writes are never retried on 429', async () => {
  const vm = await import('node:vm');
  const source = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  const slice = source.slice(source.indexOf('function formatTradingBotFailure('), source.indexOf('// Automatic memory'));
  async function invoke(endpoint, method, axios) {
    let now = 1000;
    const waits = [];
    const context = {
      Date: { now: () => now }, JSON, Promise, setTimeout: (resolve, ms) => { waits.push(ms); now += ms; resolve(); },
      _lastPortCheck: now, _tradingBotUrl: 'http://localhost',
      TRADING_BOT_TOKEN: '', TRADING_BOT_OPERATOR_TOKEN: '',
      OPENPROPHET_SANDBOX_ID: 'sandbox', OPENPROPHET_ACCOUNT_ID: 'account', OPENPROPHET_PROCESS_NONCE: 'nonce',
      axios,
    };
    vm.runInNewContext(`${slice}\nthis.callTradingBot = callTradingBot;`, context);
    const result = await context.callTradingBot(endpoint, method, {}).then(value => ({ value }), error => ({ error }));
    return { ...result, waits };
  }
  let calls = 0;
  const ok = await invoke('/news/alpaca?limit=20', 'GET', async config => {
    calls += 1;
    if (calls === 1) throw { response: { status: 429, data: { category: 'rate_limited' } } };
    assert.equal(config.timeout > 3000, true, 'GET budget is wider than before');
    return { data: { ok: true } };
  });
  assert.deepEqual(ok.value, { ok: true });
  assert.equal(calls, 2);
  assert.deepEqual(ok.waits, [1000]);

  let orderCalls = 0;
  const order = await invoke('/options/order', 'POST', async () => { orderCalls += 1; throw { response: { status: 429, data: {} } }; });
  assert.ok(order.error);
  assert.equal(orderCalls, 1, 'an order is never retried');

  let assessCalls = 0;
  const assess = await invoke('/options/trade-assessment', 'POST', async () => { assessCalls += 1; throw { response: { status: 429, data: {} } }; });
  assert.ok(assess.error);
  assert.equal(assessCalls, 1, 'assessments keep their existing no-429-retry behaviour');
});
