import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentHarness, formatOpenCodeError } from '../agent/harness.js';
import { ChatStore } from '../agent/chat-store.js';

function fakeProcess(lines, exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}
`);
    proc.emit('exit', exitCode, null);
    proc.emit('close', exitCode, null);
  });
  return proc;
}

test('pins primary and all auxiliary agent model overrides to selected free model', async () => {
  let captured;
  const harness = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'unapproved/paid', small_model: 'unapproved/paid', permission: { '*': 'ask' }, mcp: { isolated: { enabled: false } }, agent: { title: { model: 'unapproved/paid', hidden: true }, explore: { model: 'unapproved/paid', description: 'keep' } } }) }, spawnFn: (_cmd, _args, options) => { captured = options.env; return fakeProcess([{type:'text',part:{text:'OK'}}]); } });
  await harness._runClaude('readonly test', 'opencode/big-pickle');
  const c = JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
  assert.equal(c.model, 'opencode/big-pickle'); assert.equal(c.small_model, 'opencode/big-pickle');
  for (const name of ['title','summary','compaction','explore']) assert.equal(c.agent[name].model, 'opencode/big-pickle');
  assert.equal(c.agent.title.hidden, true); assert.equal(c.agent.explore.description, 'keep');
  assert.deepEqual(c.permission, {'*':'ask'}); assert.deepEqual(c.mcp, {isolated:{enabled:false}});
});
test('free auxiliary pins exist without an inherited overlay', async () => {
  let captured; const harness = new AgentHarness({ opencodeEnv: {OPENCODE_CONFIG_CONTENT:''}, spawnFn: (_c,_a,o) => {captured=o.env;return fakeProcess([{type:'text',part:{text:'OK'}}]);} });
  await harness._runClaude('readonly test','opencode/big-pickle'); const c=JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
  assert.equal(c.small_model,'opencode/big-pickle'); assert.equal(c.agent.title.model,'opencode/big-pickle');
});
test('selected provider and model get finite request budgets while preserving scoped config', async () => {
  let captured;
  const inherited = { provider: { opencode: { options: { apiKey: 'keep-secret', headers: { 'X-Test': 'keep' }, timeout: false }, models: { 'big-pickle': { name: 'Keep identity', options: { headerTimeout: 12000, chunkTimeout: 90000, temperature: 0.2 } } }, baseURL: 'https://example.invalid' }, other: { options: { timeout: 999999 } } } };
  const harness = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inherited) }, spawnFn: (_c, _a, o) => { captured = o.env; return fakeProcess([{type:'text',part:{text:'OK'}}]); } });
  await harness._runClaude('prompt', 'opencode/big-pickle');
  const c = JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
  assert.deepEqual(c.provider.other, inherited.provider.other);
  assert.equal(c.provider.opencode.options.timeout, 120000);
  assert.equal(c.provider.opencode.options.headerTimeout, 60000);
  assert.equal(c.provider.opencode.options.chunkTimeout, 60000);
  assert.equal(c.provider.opencode.options.apiKey, 'keep-secret');
  assert.deepEqual(c.provider.opencode.options.headers, { 'X-Test': 'keep' });
  assert.equal(c.provider.opencode.baseURL, 'https://example.invalid');
  assert.equal(c.provider.opencode.models['big-pickle'].name, 'Keep identity');
  assert.equal(c.provider.opencode.models['big-pickle'].options.headerTimeout, 12000);
  assert.equal(c.provider.opencode.models['big-pickle'].options.chunkTimeout, 60000);
  assert.equal(c.provider.opencode.models['big-pickle'].options.timeout, 120000);
  assert.equal(c.provider.opencode.models['big-pickle'].options.temperature, 0.2);
});
test('selected provider without options receives caps and malformed provider config blocks spawn', async () => {
  let captured; const h = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: { models: {} } } }) }, spawnFn: (_c, _a, o) => { captured = o.env; return fakeProcess([{type:'text',part:{text:'OK'}}]); } });
  await h._runClaude('prompt', 'opencode/model');
  assert.deepEqual(JSON.parse(captured.OPENCODE_CONFIG_CONTENT).provider.opencode.options, { timeout: 120000, headerTimeout: 60000, chunkTimeout: 60000 });
  let spawned = false; const bad = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: { options: 'bad' } } }) }, spawnFn: () => { spawned = true; return fakeProcess([]); } });
  await assert.rejects(bad._runClaude('prompt', 'opencode/model'), /Invalid OpenCode configuration/);
  assert.equal(spawned, false);
});
for (const malformedProvider of [null, false, 0, '']) test(`malformed selected provider ${JSON.stringify(malformedProvider)} blocks spawn`, async () => {
  let spawned = false;
  const h = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: malformedProvider } }) }, spawnFn: () => { spawned = true; return fakeProcess([]); } });
  await assert.rejects(h._runClaude('prompt', 'opencode/model'), /Invalid OpenCode configuration/);
  assert.equal(spawned, false);
});
test('selected provider defaults budgets without overlay and preserves slash model id options', async () => {
  for (const inherited of [{}, { provider: { other: { options: { timeout: 7 } } } }]) {
    let captured;
    const h = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(inherited) }, spawnFn: (_c, _a, o) => { captured = o.env; return fakeProcess([]); } });
    await h._runClaude('prompt', 'opencode/org/model/with/slashes');
    const c = JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(c.provider.opencode.options, { timeout: 120000, headerTimeout: 60000, chunkTimeout: 60000 });
    assert.deepEqual(c.provider.other, inherited.provider?.other);
    assert.equal(c.model, 'opencode/org/model/with/slashes');
  }
  let captured;
  const slashConfig = { provider: { opencode: { models: { 'org/model/with/slashes': { options: { temperature: 0.4, headerTimeout: 12000 } } } } } };
  const h = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify(slashConfig) }, spawnFn: (_c, _a, o) => { captured = o.env; return fakeProcess([]); } });
  await h._runClaude('prompt', 'opencode/org/model/with/slashes');
  const options = JSON.parse(captured.OPENCODE_CONFIG_CONTENT).provider.opencode.models['org/model/with/slashes'].options;
  assert.equal(options.temperature, 0.4); assert.equal(options.headerTimeout, 12000); assert.equal(options.timeout, 120000); assert.equal(options.chunkTimeout, 60000);
});
for (const badTimeout of ['120', { value: 120 }]) test('invalid selected provider timeout blocks spawn', async () => {
  let spawned = false;
  const h = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { opencode: { options: { timeout: badTimeout } } } }) }, spawnFn: () => { spawned = true; return fakeProcess([]); } });
  await assert.rejects(h._runClaude('prompt', 'opencode/model'), /Invalid OpenCode configuration/);
  assert.equal(spawned, false);
});
for (const bad of ['SECRET-do-not-echo', 'null', '[]', '{"agent":{"title":4}}']) test('invalid inherited model config prevents provider spawn '+bad.length, async () => {
  let spawned=false;const h=new AgentHarness({opencodeEnv:{OPENCODE_CONFIG_CONTENT:bad},spawnFn:()=>{spawned=true;return fakeProcess([])}});
  await assert.rejects(h._runClaude('readonly test','opencode/big-pickle'), e=>/Invalid OpenCode configuration/.test(e.message)&&!e.message.includes('SECRET-do-not-echo'));
  assert.equal(spawned,false);
});

test('OpenCode error events become bounded actionable errors without token content', async () => {
  const formatted = formatOpenCodeError({
    type: 'error',
    error: { name: 'APICallError', statusCode: 403, code: 'secret-token-value', message: 'free tier denied; token=do-not-log' },
  });
  assert.match(formatted, /APICallError/);
  assert.match(formatted, /HTTP 403/);
  assert.doesNotMatch(formatted, /do-not-log|secret-token-value/);
  assert.ok(formatted.length <= 1200);
});

test('runOpenCode propagates a JSON error event even when the child exits zero', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([
    { type: 'error', error: { name: 'APICallError', statusCode: 403, message: 'free tier unavailable' } },
  ]) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.0-flash-fin-free');
  assert.match(result.error, /APICallError: HTTP 403/);
});

test('runOpenCode drains trailing text, tool completion, and terminal error between child exit and close', async () => {
  let proc;
  const harness = new AgentHarness({ spawnFn: () => {
    proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = () => {};
    return proc;
  } });
  const running = harness._runClaude('heartbeat', 'opencode/model');
  while (!proc) await new Promise(resolve => setImmediate(resolve));
  proc.emit('exit', 0, null);
  proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'trailing output' } })}
`);
  proc.stdout.emit('data', `${JSON.stringify({ type: 'tool_use', part: { tool: 'prophet_get_options_position', state: { input: { symbol: 'AAPL261106C00200000' }, output: { qty: 1 } } } })}
`);
  proc.stdout.emit('data', `${JSON.stringify({ type: 'error', error: { message: 'terminal provider error' } })}
`);
  proc.emit('close', 0, null);
  const result = await running;
  assert.equal(result.text, 'trailing output');
  assert.equal(result.toolCalls, 1);
  assert.equal(result.toolEvents.length, 1);
  assert.match(result.error, /terminal provider error/);
});

test('exit without close is a bounded stdio drain failure retaining evidence and finalizing once', async () => {
  const procs = [];
  const harness = new AgentHarness({ spawnFn: () => {
    const proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = () => {};
    procs.push(proc);
    return proc;
  } });
  const first = harness._runClaude('first', 'opencode/model');
  while (procs.length < 1) await new Promise(resolve => setImmediate(resolve));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 5000 ? 5 : ms, ...args);
  try {
    procs[0].emit('exit', 0, null);
    procs[0].stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'captured before drain cap' } })}
`);
    procs[0].stdout.emit('data', `${JSON.stringify({ type: 'tool_use', part: { tool: 'prophet_get_options_position', state: { input: { symbol: 'AAPL261106C00200000' }, output: { qty: 1 } } } })}
`);
    const second = harness._runClaude('second', 'opencode/model');
    while (procs.length < 2) await new Promise(resolve => setImmediate(resolve));
    const secondBeatTimeout = harness._beatTimeout;
    const result = await first;
    assert.equal(result.errorStatus, 'stdio_drain_incomplete');
    assert.equal(result.text, 'captured before drain cap');
    assert.equal(result.toolCalls, 1);
    assert.equal(result.toolEvents.length, 1);
    assert.equal(harness._proc, procs[1]);
    assert.ok(secondBeatTimeout);
    procs[0].emit('close', 0, null);
    assert.equal(harness._proc, procs[1]);
    assert.equal(harness._beatTimeout, secondBeatTimeout);
    procs[1].emit('exit', 0, null); procs[1].emit('close', 0, null);
    assert.equal((await second).error, undefined);
    assert.equal(harness._beatTimeout, null);
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('old child exit cannot clear newer child stop escalation timer', async () => {
  const procs = [];
  const harness = new AgentHarness({ spawnFn: () => {
    const proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    procs.push(proc); return proc;
  } });
  const first = harness._runClaude('first', 'opencode/model');
  while (procs.length < 1) await new Promise(resolve => setImmediate(resolve));
  const second = harness._runClaude('second', 'opencode/model');
  while (procs.length < 2) await new Promise(resolve => setImmediate(resolve));
  const stopping = harness.stop();
  const newerTimer = procs[1]._opStopKillTimer;
  assert.ok(newerTimer);
  procs[0].emit('exit', 0, null); procs[0].emit('close', 0, null);
  await first;
  assert.equal(harness._killEscalationTimer, newerTimer);
  assert.equal(procs[1]._opStopKillTimer, newerTimer);
  procs[1].emit('exit', 0, null); procs[1].emit('close', 0, null);
  await second; await stopping;
  assert.equal(harness._killEscalationTimer, null);
});

test('structured stderr throttling split across chunks is sanitized and waits for child exit', async () => {
  let proc;
  let args;
  const harness = new AgentHarness({ spawnFn: (_cmd, passedArgs) => {
    args = passedArgs;
    proc = new EventEmitter();
    proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = (signal) => { proc.killed = true; proc.sent = signal; };
    return proc;
  } });
  const running = harness._runClaude('heartbeat', 'opencode/model');
  while (!proc) await new Promise(resolve => setImmediate(resolve));
  const secret = 'header-private-xyz';
  const record = JSON.stringify({ level: 'error', error: { name: 'APICallError', statusCode: 429, message: 'rate limited', responseHeaders: { authorization: `Bearer ${secret}` }, responseBody: secret } });
  proc.stderr.emit('data', record.slice(0, 34));
  proc.stderr.emit('data', record.slice(34));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(proc.sent, 'SIGTERM');
  let settled = false; running.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  assert.ok(args.includes('--print-logs'));
  assert.ok(args.includes('--log-level'));
  proc.emit('exit', null, 'SIGTERM');
  proc.emit('close', null, 'SIGTERM');
  const result = await running;
  assert.match(result.error, /HTTP 429/);
  assert.doesNotMatch(result.error, /header-private-xyz/);
});

test('ordinary stderr text is not promoted to a provider failure', async () => {
  const harness = new AgentHarness({ spawnFn: () => {
    const proc = fakeProcess([{ type: 'text', part: { text: 'healthy' } }]);
    queueMicrotask(() => proc.stderr.emit('data', 'rate limit maybe but ordinary diagnostic'));
    return proc;
  } });
  const result = await harness._runClaude('heartbeat', 'opencode/model');
  assert.equal(result.text, 'healthy');
  assert.equal(result.error, undefined);
});

test('native OpenCode key-value stream error is recognized without exposing the raw record', async () => {
  let proc;
  const harness = new AgentHarness({ spawnFn: () => {
    proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = () => { proc.killed = true; };
    return proc;
  } });
  const running = harness._runClaude('heartbeat', 'opencode/model');
  while (!proc) await new Promise(resolve => setImmediate(resolve));
  const line = 'timestamp=2026-10-05T23:34:46.656Z level=ERROR run=969eddf1 message="stream error" providerID=opencode modelID=ling-3.1-flash-free session.id=ses_ef1948d97ffeHsKvPIhYeSD3qJ small=false agent=build mode=primary error.error="AI_APICallError: Rate limit exceeded. Please try again later."';
  proc.stderr.emit('data', line.slice(0, 130));
  proc.stderr.emit('data', line.slice(130));
  assert.equal(proc.killed, true);
  proc.emit('exit', null, 'SIGTERM');
  proc.emit('close', null, 'SIGTERM');
  const result = await running;
  assert.match(result.error, /AI_APICallError: Rate limit exceeded/);
  assert.doesNotMatch(result.error, /969eddf1|ses_ef|providerID|modelID/);
});

test('hung child receives SIGKILL after SIGTERM even when killed flag is already true', async () => {
  let proc;
  const harness = new AgentHarness({ spawnFn: () => {
    proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.signals = [];
    proc.kill = signal => { proc.killed = true; proc.signals.push(signal); };
    return proc;
  } });
  const running = harness._runClaude('heartbeat', 'opencode/model');
  while (!proc) await new Promise(resolve => setImmediate(resolve));
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms === 5000 ? 0 : ms, ...args);
  try {
    proc.stderr.emit('data', JSON.stringify({ type: 'error', error: { name: 'APIError', statusCode: 429, message: 'limited' } }));
    await new Promise(resolve => originalSetTimeout(resolve, 10));
  } finally { globalThis.setTimeout = originalSetTimeout; }
  assert.deepEqual(proc.signals, ['SIGTERM', 'SIGKILL']);
  proc.emit('exit', null, 'SIGKILL');
  proc.emit('close', null, 'SIGKILL');
  const result = await running;
  assert.match(result.error, /HTTP 429/);
});

test('nested runtime wire shape preserves data.message/status but no diagnostics secrets', () => {
  const formatted = formatOpenCodeError({ type: 'error', error: {
    name: 'APICallError', data: {
      message: 'Not Found: Cannot find any route matching [POST] https://opencode.ai/zen/v1/chat/completions?api_key=secret-token-value',
      statusCode: 404, responseHeaders: { authorization: 'Bearer secret-token-value' }, responseBody: 'secret-token-value',
    },
  } });
  assert.match(formatted, /APICallError: HTTP 404: Not Found/);
  assert.doesNotMatch(formatted, /secret-token-value/i);
});

test('error after partial text remains failed', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([
    { type: 'text', part: { text: 'partial answer' } },
    { type: 'error', error: { name: 'APICallError', data: { message: 'failed', statusCode: 500 } } },
  ], 0) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.1-flash-free');
  assert.match(result.error, /APICallError: HTTP 500/);
  assert.equal(result.text, 'partial answer');
});

test('null-code exit with no text is not success', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([], null) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.1-flash-free');
  assert.match(result.error, /exited with code null signal null/);
});

test('tool audit retains critical outcomes with bounded truncation metadata and safe fields', () => {
  const harness = new AgentHarness();
  const captured = [];
  const ctx = { addToolCall() {}, recordToolEvent: e => captured.push(e), addText() {}, setSession() {}, addCost() {}, addTokens() {} };
  const assessment = `{"summary":"${'x'.repeat(1300)}","decision":"PASS","checks":["exact contract"],"score":88}`;
  harness._handleOpenCodeEvent({ type: 'tool_use', callID: 'call-a', part: { id: 'part-a', tool: 'prophet_assess_options_trade', state: { input: { proposal_id: 'prop-1', authorization: 'Bearer abc' }, output: assessment, status: 'completed' } } }, ctx);
  const event = captured[0];
  assert.equal(event.callId, 'call-a');
  assert.ok(event.completedAt);
  assert.equal(event.status, 'completed');
  assert.match(event.result, /"decision":"PASS"/);
  assert.match(event.result, /"score":88/);
  assert.doesNotMatch(JSON.stringify(event), /Bearer abc/);
  assert.equal(event.args.proposal_id, 'prop-1');

  harness._handleOpenCodeEvent({ type: 'tool_use', part: { tool: 'prophet_place_options_order', state: { input: {}, output: 'order accepted id=ord-2 filled_qty=0' } } }, ctx);
  assert.match(captured[1].result, /ord-2.*filled_qty=0/);

  harness._handleOpenCodeEvent({ type: 'tool_use', part: { tool: 'prophet_get_account', state: { input: {}, output: 'z'.repeat(140000) } } }, ctx);
  assert.equal(captured[2].result.length, 128 * 1024);
  assert.equal(captured[2].resultTruncated, true);
  assert.equal(captured[2].resultLength, 140000);

  harness._handleOpenCodeEvent({ type: 'tool_use', part: { tool: 'prophet_webfetch', state: { input: {}, output: 'r'.repeat(2000) } } }, ctx);
  assert.equal(captured[3].result.length, 1200);
  assert.equal(captured[3].resultTruncated, true);

  harness._handleOpenCodeEvent({ type: 'tool_use', callID: 'call-error', part: { tool: 'prophet_get_orders', state: { input: {}, error: 'broker unavailable password=secret' } } }, ctx);
  assert.equal(captured[4].status, 'error');
  assert.match(captured[4].error, /broker unavailable/);
  assert.doesNotMatch(captured[4].error, /secret/);
});

test('tool audit recursively redacts structured credentials and bounds errors without changing safe outcomes', async () => {
  const harness = new AgentHarness();
  const captured = [];
  const ctx = { addToolCall() {}, recordToolEvent: e => captured.push(e), addText() {}, setSession() {}, addCost() {}, addTokens() {} };
  const output = JSON.stringify({ decision: 'PASS', score: 87, checks: ['exact contract'], nested: { api_key: 'sensitive', secret_key: 'sensitive-2', client_secret: 'sensitive-3', result: 'https://svc.example/path?api_key=url-secret&credential=url-credential' }, order_id: 'order-exact', status: 'filled', filled_qty: 1, filled_avg_price: 2.5 });
  harness._handleOpenCodeEvent({ type: 'tool_use', part: { tool: 'prophet_assess_options_trade', state: { input: {}, output, status: 'completed' } } }, ctx);
  const parsed = JSON.parse(captured[0].result);
  assert.equal(parsed.decision, 'PASS'); assert.equal(parsed.score, 87); assert.deepEqual(parsed.checks, ['exact contract']);
  assert.equal(parsed.nested.api_key, '[REDACTED]'); assert.equal(parsed.nested.secret_key, '[REDACTED]'); assert.equal(parsed.nested.client_secret, '[REDACTED]');
  assert.doesNotMatch(captured[0].result, /sensitive|url-secret|url-credential/);
  assert.equal(parsed.order_id, 'order-exact'); assert.equal(parsed.status, 'filled'); assert.equal(parsed.filled_qty, 1); assert.equal(parsed.filled_avg_price, 2.5);

  harness._handleOpenCodeEvent({ type: 'tool_use', part: { tool: 'prophet_get_orders', state: { input: {}, error: { message: `Bearer bearer-secret https://svc.example/?client_secret=url-secret ${'x'.repeat(1800)}`, details: { credential: 'structured-secret' } } } } }, ctx);
  assert.doesNotMatch(captured[1].error, /bearer-secret|url-secret|structured-secret/);
  assert.ok(captured[1].error.length <= 1200);
});

test('ChatStore round trip preserves long assessment and order audit outcomes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'long-tool-audit-'));
  try {
    const store = new ChatStore(dir);
    await store.startSession('a', 'long-session');
    const assessment = { decision: 'PASS', checks: ['x'.repeat(1500), 'trailing-check'], score: 91 };
    const order = { order_id: 'order-long', status: 'partially_filled', filled_qty: 2, filled_avg_price: 3.25, details: 'y'.repeat(1500) };
    await store.addMessage('a', 'long-session', { role: 'assistant', kind: 'tool_call', tool: 'prophet_assess_options_trade', result: JSON.stringify(assessment) });
    await store.addMessage('a', 'long-session', { role: 'assistant', kind: 'tool_call', tool: 'prophet_place_options_order', result: JSON.stringify(order) });
    const messages = await new ChatStore(dir).getSessionMessages('a', 'long-session');
    const savedAssessment = JSON.parse(messages[0].result), savedOrder = JSON.parse(messages[1].result);
    assert.ok(messages[0].result.length > 1200); assert.equal(savedAssessment.checks[1], 'trailing-check'); assert.equal(savedAssessment.score, 91);
    assert.ok(messages[1].result.length > 1200); assert.equal(savedOrder.order_id, 'order-long'); assert.equal(savedOrder.status, 'partially_filled'); assert.equal(savedOrder.filled_qty, 2); assert.equal(savedOrder.filled_avg_price, 3.25);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('deadline after partial text remains a timeout failure and retains output', async () => {
  let proc;
  const harness = new AgentHarness({ spawnFn: () => {
    proc = new EventEmitter(); proc.stdin = { on() {}, write() {}, end() {} };
    proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter(); proc.killed = false;
    proc.kill = signal => { proc.killed = true; proc.signal = signal; queueMicrotask(() => { proc.emit('exit', null, signal); proc.emit('close', null, signal); }); };
    queueMicrotask(() => proc.stdout.emit('data', `${JSON.stringify({ type: 'text', sessionID: 'timeout-session', part: { text: 'partial answer' } })}
`));
    return proc;
  } });
  const originalSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => originalSetTimeout(fn, ms >= 300000 ? 0 : ms, ...args);
  try {
    const result = await harness._runClaude('heartbeat', 'opencode/model');
    assert.match(result.error, /timed out/);
    assert.equal(result.errorStatus, 'timeout');
    assert.equal(result.text, 'partial answer');
  } finally { globalThis.setTimeout = originalSetTimeout; }
});

test('failed message beat audits partial reply and completed tools with failure status', async () => {
  const writes = [];
  const chatStore = {
    async getRecentContext() { return []; },
    async startSession(account, session, metadata) { writes.push({ type: 'session', account, session, metadata }); },
    async addMessage(account, session, message) { writes.push({ type: 'message', account, session, message }); },
  };
  const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', chatStore, getCurrentPhaseFn: () => 'closed', spawnFn: () => fakeProcess([
    { type: 'tool_use', sessionID: 'message-session', part: { tool: 'prophet_get_account', state: { input: {}, output: 'ok' } } },
    { type: 'text', sessionID: 'message-session', part: { text: 'partial reply' } },
    { type: 'error', error: { name: 'APIError', data: { statusCode: 503, message: 'unavailable' } } },
  ]) });
  harness.state.running = true;
  harness.state.activeAccountId = 'a';
  harness.state.activeModel = 'opencode/model';
  await harness._adHocBeat('question');
  assert.equal(writes.find(w => w.message?.kind === 'message_partial')?.message.content, 'partial reply');
  assert.equal(writes.find(w => w.message?.kind === 'tool_call')?.message.tool, 'get_account');
  assert.equal(writes.find(w => w.message?.kind === 'message_failure')?.message.status, 503);
  assert.equal(writes.some(w => w.message?.kind === 'message' && w.message.role === 'assistant'), false);
});

test('failed heartbeat persists one sanitized audit and completed tools, then shows recovery', async () => {
  const writes = [];
  const chatStore = {
    async getRecentContext() { return []; },
    async startSession(account, session, metadata) { writes.push({ type: 'session', account, session, metadata }); },
    async addMessage(account, session, message) { writes.push({ type: 'message', account, session, message }); },
  };
  const secret = 'provider-private-value';
  const runs = [
    [
      { type: 'tool_use', sessionID: 'new-session', part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } },
      { type: 'tool_use', sessionID: 'new-session', part: { tool: 'prophet_get_account', state: { input: {}, output: 'ok' } } },
      { type: 'tool_use', sessionID: 'new-session', part: { tool: 'prophet_get_positions', state: { input: {}, output: 'ok' } } },
      { type: 'tool_use', sessionID: 'new-session', part: { tool: 'prophet_get_orders', state: { input: {}, output: 'ok' } } },
      { type: 'error', error: { name: 'APIError', data: { statusCode: 429, message: 'Endpoint is unavailable.', retryable: true, responseHeaders: { authorization: `Bearer ${secret}` }, responseBody: secret } } },
    ],
    [{ type: 'text', sessionID: 'new-session', part: { text: 'healthy' } }],
  ];
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', chatStore,
    spawnFn: () => fakeProcess(runs.shift()), getCurrentPhaseFn: () => 'closed',
  });
  harness.state.activeAccountId = 'a';
  harness.state.activeModel = 'opencode/ling-3.1-flash-free';
  const priorConsoleError = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = priorConsoleError; }
  const failure = writes.filter(w => w.message?.kind === 'heartbeat_failure');
  assert.equal(failure.length, 1);
  assert.equal(writes.filter(w => w.message?.eventType === 'tool_call').length, 4);
  assert.equal(writes.filter(w => w.message?.kind === 'heartbeat').length, 0);
  assert.equal(failure[0].message.status, 429);
  assert.equal(failure[0].message.provider, 'opencode');
  assert.equal(failure[0].message.accountId, 'a');
  assert.equal(failure[0].session, 'new-session');
  assert.equal(harness.state.stats.errors, 1);
  assert.equal(harness.state.lastHeartbeatFailure.recoveredAt, null);
  assert.doesNotMatch(JSON.stringify(writes), /provider-private-value/);
  await harness._beat();
  assert.equal(harness.state.stats.errors, 1);
  assert.ok(harness.state.lastHeartbeatFailure.recoveredAt);
  assert.equal(harness.state.lastHeartbeatFailure.recoveredByBeat, 2);
  assert.equal(writes.filter(w => w.message?.kind === 'heartbeat_failure').length, 1);
});

test('failure on first session gets a durable audit session without becoming continuation', async () => {
  const writes = [];
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async getRecentContext() { return []; },
      async startSession(account, session) { writes.push({ account, session }); },
      async addMessage(account, session, message) { writes.push({ account, session, message }); },
    },
    spawnFn: () => fakeProcess([{ type: 'error', error: { name: 'APIError', data: { statusCode: 429, message: 'Unavailable', responseBody: 'private-body' } } }]),
  });
  harness.state.activeAccountId = 'a';
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  assert.match(writes[0].session, /^heartbeat-failure-/);
  assert.equal(writes[1].message.kind, 'heartbeat_failure');
  assert.equal(harness._sessionId, null);
  assert.doesNotMatch(JSON.stringify(writes), /private-body/);
});

test('epoch or account change during failed beat does not audit into another account', async () => {
  const writes = [];
  const harness = new AgentHarness({
    sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: { async startSession(...args) { writes.push(args); }, async addMessage(...args) { writes.push(args); } },
  });
  harness.state.activeAccountId = 'a';
  harness._runClaude = async () => {
    harness._sessionEpoch++;
    harness.state.activeAccountId = 'b';
    return { error: 'APIError: HTTP 429', errorStatus: 429, sessionId: 'old-session', toolEvents: [{ eventType: 'tool_call' }] };
  };
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  assert.equal(writes.length, 0);
  assert.equal(harness.state.lastHeartbeatFailure, null);
});

test('chat write failure rejects promptly and later queued write still runs', async () => {
  const store = new ChatStore();
  await assert.rejects(store._enqueue('a', async () => { throw new Error('disk full'); }), /disk full/);
  assert.equal(await store._enqueue('a', async () => 'written'), 'written');
});

test('thrown heartbeat failure is audited once with sanitized detail and releases beat lock', async () => {
  const writes = [];
  const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async startSession(...args) { writes.push(['session', ...args]); },
      async addMessage(...args) { writes.push(['message', ...args]); },
    },
  });
  harness.state.activeAccountId = 'a';
  harness._runClaude = async () => { throw new Error('spawn failed token=throw-secret'); };
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  const failures = writes.filter(w => w[3]?.kind === 'heartbeat_failure');
  assert.equal(failures.length, 1);
  assert.match(failures[0][2], /^heartbeat-failure-/);
  assert.match(failures[0][3].message, /spawn failed/);
  assert.doesNotMatch(JSON.stringify(writes), /throw-secret/);
  assert.equal(harness.state.stats.errors, 1);
  assert.equal(harness._beating, false);
});

test('spawn rejection is audited without replay on the next beat', async () => {
  const writes = [];
  let run = 0;
  const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async getRecentContext() { return []; },
      async startSession(...args) { writes.push(['session', ...args]); },
      async addMessage(...args) { writes.push(['message', ...args]); },
    },
    spawnFn: () => {
      if (++run === 1) throw new Error('executable missing password=spawn-secret');
      return fakeProcess([{ type: 'text', sessionID: 'recovered-session', part: { text: 'ok' } }]);
    },
  });
  harness.state.activeAccountId = 'a';
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); await harness._beat(); } finally { console.error = previous; }
  assert.equal(writes.filter(w => w[3]?.kind === 'heartbeat_failure').length, 1);
  assert.equal(writes.filter(w => w[3]?.kind === 'heartbeat_recovery').length, 1);
  assert.doesNotMatch(JSON.stringify(writes), /spawn-secret/);
});

test('ChatStore reopens failed partial tools and one recovery without replay or secrets', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heartbeat-audit-'));
  try {
    const store = new ChatStore(dir);
    const secret = 'durable-private-value';
    const runs = [
      [
        { type: 'tool_use', sessionID: 'failed-session', part: { tool: 'prophet_get_orders', state: { input: {}, output: 'done' } } },
        { type: 'error', error: { name: 'APIError', data: { statusCode: 429, message: `Unavailable token=${secret}`, responseBody: secret } } },
      ],
      [{ type: 'text', sessionID: 'failed-session', part: { text: 'healthy' } }],
      [{ type: 'text', sessionID: 'failed-session', part: { text: 'still healthy' } }],
    ];
    const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', chatStore: store,
      spawnFn: () => fakeProcess(runs.shift()), getCurrentPhaseFn: () => 'closed' });
    harness.state.activeAccountId = 'a';
    harness.state.activeModel = 'opencode/ling-3.1-flash-free';
    const previous = console.error;
    console.error = () => {};
    try {
      await harness._beat();
      await harness._beat();
      harness._sessionId = null;
      await harness._beat();
    } finally { console.error = previous; }
    const reopened = new ChatStore(dir);
    const sessions = await reopened.listSessions('a');
    assert.equal(sessions.length, 1);
    const messages = await reopened.getSessionMessages('a', 'failed-session');
    assert.deepEqual(messages.map(m => m.kind), ['tool_call', 'heartbeat_failure', 'heartbeat', 'heartbeat_recovery', 'heartbeat']);
    assert.equal(messages[1].beat, 1);
    assert.equal(messages[3].failureSessionId, 'failed-session');
    assert.equal(messages[3].failureBeat, 1);
    assert.equal(messages[3].beat, 2);
    assert.equal(sessions[0].messageCount, 5);
    assert.doesNotMatch(JSON.stringify({ sessions, messages }), /durable-private-value/);
    assert.equal(harness._sessionId, 'failed-session');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('resumed heartbeat and direct message persist under the captured session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'resumed-session-'));
  try {
    const runs = ['first', 'second', 'message'].map((text, index) => [
      { type: 'tool_use', ...(index === 1 ? {} : { sessionID: 'same-session' }), part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } },
      { type: 'text', ...(index === 1 ? {} : { sessionID: 'same-session' }), part: { text } },
    ]);
    const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', chatStore: new ChatStore(dir),
      spawnFn: () => fakeProcess(runs.shift()), getCurrentPhaseFn: () => 'closed' });
    harness.state.activeAccountId = 'a';
    harness.state.running = true;
    await harness._beat();
    await harness._beat();
    await harness._adHocBeat('hello');
    const reopened = new ChatStore(dir);
    const messages = await reopened.getSessionMessages('a', 'same-session');
    assert.deepEqual(messages.map(m => m.kind), ['heartbeat', 'tool_call', 'heartbeat', 'tool_call', 'message', 'message', 'tool_call']);
    assert.deepEqual(messages.filter(m => m.role === 'assistant' && m.kind !== 'tool_call').map(m => m.toolCalls), [1, 1, 1]);
    assert.equal((await reopened.listSessions('a'))[0].messageCount, 7);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('completion after a session reset does not restore or persist the old session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reset-session-'));
  try {
    let harness;
    harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', chatStore: new ChatStore(dir),
      getCurrentPhaseFn: () => 'closed', spawnFn: () => {
        const proc = fakeProcess([{ type: 'text', sessionID: 'old-session', part: { text: 'late reply' } }]);
        proc.stdout.on('data', () => { harness._sessionId = null; harness._sessionEpoch++; });
        return proc;
      } });
    harness.state.activeAccountId = 'a';
    harness._sessionId = 'old-session';
    await harness._beat();
    assert.equal(harness._sessionId, null);
    assert.deepEqual(await new ChatStore(dir).listSessions('a'), []);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('tool totals count streamed events once across success, failure, interrupt, and direct message', async () => {
  const runs = [
    { lines: [{ type: 'tool_use', sessionID: 's', part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } },
      { type: 'text', sessionID: 's', part: { text: 'ok' } }] },
    { lines: [{ type: 'tool_use', sessionID: 's', part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } },
      { type: 'error', error: { message: 'failed' } }] },
    { lines: [{ type: 'tool_use', sessionID: 's', part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } }], interrupt: true },
    { lines: [{ type: 'tool_use', sessionID: 's', part: { tool: 'prophet_get_datetime', state: { input: {}, output: 'ok' } } },
      { type: 'text', sessionID: 's', part: { text: 'reply' } }] },
  ];
  let harness;
  harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    spawnFn: () => {
      const run = runs.shift();
      const proc = fakeProcess(run.lines);
      if (run.interrupt) proc.stdout.on('data', () => { harness._interrupted = true; });
      return proc;
    },
  });
  harness.state.activeAccountId = 'a';
  harness.state.running = true;
  const previous = console.error;
  console.error = () => {};
  try {
    await harness._beat();
    assert.equal(harness.state.stats.toolCalls, 1);
    await harness._beat();
    assert.equal(harness.state.stats.toolCalls, 2);
    await harness._beat();
    assert.equal(harness.state.stats.toolCalls, 3);
    await harness._adHocBeat('hello');
    assert.equal(harness.state.stats.toolCalls, 4);
  } finally { console.error = previous; }
});

test('ChatStore reopens fallback audit when failure has no provider session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heartbeat-fallback-'));
  try {
    const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', chatStore: new ChatStore(dir),
      getCurrentPhaseFn: () => 'closed',
      spawnFn: () => fakeProcess([{ type: 'error', error: { name: 'APIError', data: {
        statusCode: 503, message: 'Unavailable token=fallback-secret', responseBody: 'fallback-secret',
      } } }]),
    });
    harness.state.activeAccountId = 'a';
    const previous = console.error;
    console.error = () => {};
    try { await harness._beat(); } finally { console.error = previous; }
    const reopened = new ChatStore(dir);
    const sessions = await reopened.listSessions('a');
    assert.equal(sessions.length, 1);
    assert.match(sessions[0].id, /^heartbeat-failure-/);
    assert.equal(harness._sessionId, null);
    const messages = await reopened.getSessionMessages('a', sessions[0].id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].kind, 'heartbeat_failure');
    assert.equal(messages[0].status, 503);
    assert.doesNotMatch(JSON.stringify({ sessions, messages }), /fallback-secret/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('audit persistence error retains original heartbeat failure and permits a later beat', async () => {
  let writes = 0;
  const logs = [];
  const harness = new AgentHarness({ sandboxId: 'sbx_a', accountId: 'a', getCurrentPhaseFn: () => 'closed',
    chatStore: {
      async startSession() { if (++writes === 1) throw new Error('disk full'); },
      async addMessage() {},
    },
  });
  harness.state.activeAccountId = 'a';
  harness.state.on('agent_log', event => logs.push(event.message));
  harness._runClaude = async () => { throw new Error('original spawn failure'); };
  const previous = console.error;
  console.error = () => {};
  try { await harness._beat(); } finally { console.error = previous; }
  assert.equal(harness._beating, false);
  assert.equal(harness.state.stats.errors, 1);
  assert.match(harness.state.lastHeartbeatFailure.message, /original spawn failure/);
  assert.ok(logs.some(m => /original spawn failure/.test(m)));
  harness._runClaude = async () => ({ text: 'ok', sessionId: 'next-session', sessionEpoch: harness._sessionEpoch });
  await harness._beat();
  assert.equal(harness.state.beatCount, 2);
});
