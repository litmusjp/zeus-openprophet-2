import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affectedSandboxesForAgentModelChange, hasBusyAffectedSandbox, chatgptStatus, nativeOpenCodeEnv, nativeAuthPath, chatgptXdgDataHome, createChatGPTAuthFlow, disconnectChatGPT, createChatGPTModelCheck, recordChatGPTModelCheck, isChatGPTModelVerified } from '../agent/chatgpt-oauth.js';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn as spawnChild } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function waitForTerminal(flow, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = await flow.status(id);
    if (state.status !== 'pending') return state;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error('synthetic native flow did not terminate');
}

test('disconnected status ignores API keys and native XDG resolution matches OpenCode global path', async () => {
  const root = '/tmp/nonexistent-op2-chatgpt-auth';
  const status = await chatgptStatus({ dataDir: root, env: { OPENAI_API_KEY: 'fixture' } });
  assert.equal(status.status, 'not_connected');
  assert.equal(status.apiKeyMode, false);
  const env = nativeOpenCodeEnv({ dataDir: '/persistent/op2' });
  assert.equal(env.XDG_DATA_HOME, path.join('/persistent/op2', 'chatgpt-xdg-data'));
  assert.equal(nativeAuthPath('/persistent/op2', env), path.join(env.XDG_DATA_HOME, 'opencode', 'auth.json'));
  assert.equal(Object.hasOwn(env, 'OPENCODE_DATA_DIR'), false);
});

test('agent model changes target only assigned sandboxes and block only an affected busy turn', () => {
  const sandboxes = [
    { id: 'one-a', agent: { activeAgentId: 'one' } },
    { id: 'two', agent: { activeAgentId: 'two' } },
    { id: 'one-b', agent: { activeAgentId: 'one' } },
  ];
  const affected = affectedSandboxesForAgentModelChange(sandboxes, 'one');
  assert.deepEqual(affected.map(sandbox => sandbox.id), ['one-a', 'one-b']);
  const harnesses = new Map([['one-b', { _proc: { pid: 7 } }]]);
  assert.equal(hasBusyAffectedSandbox(affected, id => harnesses.get(id)), true);
  assert.equal(hasBusyAffectedSandbox(affected.slice(0, 1), id => harnesses.get(id)), false);
  assert.equal(hasBusyAffectedSandbox(affected, () => harnesses.get('two')), false);
});

test('headless login parses split ANSI output, reads native auth on exit, and clears terminal instructions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-login-fixture-'));
  const streams = () => Object.assign(new EventEmitter(), { write() {}, end() {} });
  let child;
  try {
    const flow = createChatGPTAuthFlow({ dataDir: root, spawn: (_bin, args, opts) => {
      assert.deepEqual(args.slice(0, 5), ['auth', 'login', '--provider', 'openai', '--method']);
      assert.equal(opts.shell, false); child = new EventEmitter(); child.stdout = streams(); child.stderr = streams(); child.kill = () => {}; child.env = opts.env; return child;
    } });
    const { id } = flow.start();
    child.stdout.emit('data', '\x1b[32mhttps://auth.openai.com/codex/');
    child.stderr.emit('data', 'device\x1b[0m\nEnter co'); child.stdout.emit('data', 'de: ABCD-1234\n');
    const pending = await flow.status(id);
    assert.equal(pending.url, 'https://auth.openai.com/codex/device'); assert.equal(pending.code, 'ABCD-1234');
    const authFile = nativeAuthPath(root, child.env);
    await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(authFile, JSON.stringify({ openai: { type: 'oauth', refresh: 'fixture-refresh', access: 'fixture-access', accountId: 'fixture-account', expires: Date.now() + 60000 } }), { mode: 0o600 });
    child.emit('exit', 0);
    const terminal = await flow.status(id);
    assert.equal(terminal.status, 'connected'); assert.equal(terminal.url, null); assert.equal(terminal.code, null);
    const reopened = await chatgptStatus({ dataDir: root });
    assert.equal(reopened.status, 'connected_unverified');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(authFile)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(path.dirname(authFile))).mode & 0o777, 0o700);
    }
    assert.equal(JSON.stringify(reopened).includes('fixture-refresh'), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('real child chunks parse ANSI instructions and cancellation clears code and URL', async () => {
  const flow = createChatGPTAuthFlow({ dataDir: '/tmp/op2-fixture', spawn: (_bin, _args, options) => spawnChild(process.execPath, ['-e', "process.stdout.write('\\x1b[');setTimeout(()=>process.stderr.write('32mhttps://auth.openai.com/codex/device\\nEnter code: WXYZ-4321\\x1b[0m'),5);setTimeout(()=>{},500)"], options) });
  const { id } = flow.start(); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await flow.status(id)).code, 'WXYZ-4321');
  flow.cancel(id); const state = await flow.status(id); assert.equal(state.code, null); assert.equal(state.url, null);
});

test('duplicate start reuses the same pending flow without another spawn', () => {
  let spawns = 0;
  const flow = createChatGPTAuthFlow({ spawn: () => { spawns++; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; return child; } });
  const first = flow.start(); const second = flow.start();
  assert.equal(second.id, first.id); assert.equal(spawns, 1);
  flow.cancel(first.id);
});

test('TERM-ignoring owned helper is killed and flow slot is released after cancellation and expiry', async () => {
  const make = timeoutMs => {
    let spawns = 0; const signals = []; const flow = createChatGPTAuthFlow({ timeoutMs, spawn: () => { spawns++; const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = signal => { signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => child.emit('exit', null)); return true; }; return child; } });
    return { flow, spawns: () => spawns, signals };
  };
  for (const terminal of ['cancel', 'expire']) {
    const { flow, spawns, signals } = make(20); const first = flow.start();
    if (terminal === 'cancel') flow.cancel(first.id); else await new Promise(resolve => setTimeout(resolve, 30));
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(signals.slice(0, 2), ['SIGTERM', 'SIGKILL']);
    const state = await flow.status(first.id); assert.equal(state.code, null); assert.equal(state.url, null);
    const second = flow.start(); assert.notEqual(second.id, first.id); assert.equal(spawns(), 2); flow.cancel(second.id);
  }
});

function descendantFixtureScripts(marker) {
  const childScript = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); fs.writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},1000);`;
  const parentScript = `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'ignore'}); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  return { childScript, parentScript };
}

test('Linux descendant fixture scripts parse on every platform', () => {
  const { childScript, parentScript } = descendantFixtureScripts(path.join(os.tmpdir(), 'op2-descendant-fixture-marker'));
  new vm.Script(childScript);
  new vm.Script(parentScript);
});

test('Linux cancellation kills only the helper process group and its descendant', { skip: process.platform !== 'linux' }, async () => {
  const marker = path.join(os.tmpdir(), `op2-child-${process.pid}-${Date.now()}`);
  const { parentScript } = descendantFixtureScripts(marker);
  const flow = createChatGPTAuthFlow({ spawn: (_bin, _args, options) => spawnChild(process.execPath, ['-e', parentScript], options) });
  let id;
  try {
    ({ id } = flow.start());
    for (let i = 0; i < 100; i++) { try { await fs.access(marker); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); } }
    await fs.access(marker);
    const descendantPid = Number(await fs.readFile(marker, 'utf8'));
    flow.cancel(id);
    await new Promise(resolve => setTimeout(resolve, 500));
    let state = null;
    try { const stat = await fs.readFile(`/proc/${descendantPid}/stat`, 'utf8'); state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert.ok(state === null || state === 'Z', `descendant should be terminated or a non-running zombie; state=${state}`);
  } finally {
    if (id) flow.cancel(id);
    await fs.rm(marker, { force: true });
  }
});

test('expiry drops temporary code and fixed URL', async () => {
  const streams = () => Object.assign(new EventEmitter(), { write() {}, end() {} }); let child;
  const flow = createChatGPTAuthFlow({ timeoutMs: 10, spawn: () => { child = new EventEmitter(); child.stdout = streams(); child.stderr = streams(); child.kill = () => {}; return child; } });
  const { id } = flow.start(); child.stdout.emit('data', 'https://auth.openai.com/codex/device Enter code: TEMP-1234');
  await new Promise(resolve => setTimeout(resolve, 20)); const state = await flow.status(id);
  assert.equal(state.status, 'expired'); assert.equal(state.code, null); assert.equal(state.url, null);
});

test('disconnect preserves unrelated providers and refuses in-use connection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-oauth-'));
  try {
    const file = nativeAuthPath(root, nativeOpenCodeEnv({ dataDir: root })); await fs.mkdir(path.dirname(file), { recursive: true });
    const auth = { openai: { type: 'oauth', refresh: 'fixture-refresh', access: 'fixture-access', accountId: 'fixture-account' }, google: { type: 'api', key: 'fixture-google' } };
    await fs.writeFile(file, JSON.stringify(auth), { mode: 0o600 });
    await assert.rejects(disconnectChatGPT({ dataDir: root, inUse: true }), /active agent/);
    await disconnectChatGPT({ dataDir: root });
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { google: auth.google });
    assert.equal((await chatgptStatus({ dataDir: root })).status, 'not_connected');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('verification survives same-account refresh rotation but explicit reconnect changes generation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-native-auth-'));
  try {
    const authFile = nativeAuthPath(root, nativeOpenCodeEnv({ dataDir: root })); await fs.mkdir(path.dirname(authFile), { recursive: true });
    const write = value => fs.writeFile(authFile, JSON.stringify({ openai: { type: 'oauth', accountId: 'stable-account', ...value } }), { mode: 0o600 });
    await write({ refresh: 'synthetic-refresh-1', access: 'synthetic-access-1', expires: 100 });
    // Establish the stable connection generation with a synthetic successful native login.
    const syntheticFlow = createChatGPTAuthFlow({ dataDir: root, spawn: (_bin, _args, options) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; queueMicrotask(async () => { await fs.writeFile(nativeAuthPath(root, options.env), JSON.stringify({ openai: { type: 'oauth', accountId: 'stable-account', refresh: 'synthetic-refresh-1' } })); child.emit('exit', 0); }); return child; } });
    const started = syntheticFlow.start(); assert.equal((await waitForTerminal(syntheticFlow, started.id)).status, 'connected');
    const initial = await chatgptStatus({ dataDir: root }); assert.equal(initial.status, 'connected_unverified');
    await recordChatGPTModelCheck({ dataDir: root, model: 'openai/fixture', connectionId: initial.connectionId });
    await write({ refresh: 'synthetic-refresh-rotated', access: 'synthetic-access-rotated', expires: 9999999999999 });
    const rotated = await chatgptStatus({ dataDir: root });
    assert.equal(rotated.connectionId, initial.connectionId);
    assert.equal(await isChatGPTModelVerified({ dataDir: root, model: 'openai/fixture', connectionId: rotated.connectionId }), true);
    const reconnect = createChatGPTAuthFlow({ dataDir: root, spawn: (_bin, _args, options) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; queueMicrotask(async () => { await fs.writeFile(nativeAuthPath(root, options.env), JSON.stringify({ openai: { type: 'oauth', accountId: 'stable-account', refresh: 'synthetic-refresh-new' } })); child.emit('exit', 0); }); return child; } });
    const again = reconnect.start(); await waitForTerminal(reconnect, again.id);
    const reconnected = await chatgptStatus({ dataDir: root });
    assert.notEqual(reconnected.connectionId, rotated.connectionId);
    assert.equal(await isChatGPTModelVerified({ dataDir: root, model: 'openai/fixture', connectionId: reconnected.connectionId }), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('model check isolates native tools and validates the completed local MCP nonce event', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-model-check-'));
  try {
    const authFile = nativeAuthPath(root, nativeOpenCodeEnv({ dataDir: root })); await fs.mkdir(path.dirname(authFile), { recursive: true });
    await fs.writeFile(authFile, JSON.stringify({ openai: { type: 'oauth', refresh: 'synthetic-refresh', accountId: 'synthetic-account' } }));
    const establish = createChatGPTAuthFlow({ dataDir: root, spawn: (_bin, _args, options) => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {}; queueMicrotask(async () => { await fs.writeFile(nativeAuthPath(root, options.env), JSON.stringify({ openai: { type: 'oauth', refresh: 'synthetic-refresh', accountId: 'synthetic-account' } })); child.emit('exit', 0); }); return child; } });
    const established = establish.start(); await waitForTerminal(establish, established.id);
    const fakeSpawn = events => (_bin, args, options) => {
      assert.deepEqual(args, ['run', '--format', 'json', '--model', 'openai/fixture-model', '--agent', 'op2-chatgpt-probe']);
      assert.equal(options.env.OPENAI_API_KEY, ''); assert.equal(options.env.XDG_DATA_HOME, path.join(root, 'chatgpt-xdg-data'));
      assert.equal(Object.hasOwn(options.env, 'OPENCODE_DATA_DIR'), false); assert.notEqual(options.cwd, path.dirname(path.dirname(authFile)));
      const cfg = JSON.parse(options.env.OPENCODE_CONFIG_CONTENT);
      assert.equal(cfg.agent['op2-chatgpt-probe'].model, 'openai/fixture-model');
      assert.deepEqual(cfg.agent['op2-chatgpt-probe'].tools, { '*': false, op2probe_confirm_nonce: true });
      assert.deepEqual(cfg.permission, { '*': 'deny', op2probe_confirm_nonce: 'allow' });
      for (const helper of ['title', 'summary', 'compaction']) { assert.equal(cfg.agent[helper].model, 'openai/fixture-model'); assert.deepEqual(cfg.agent[helper].tools, { '*': false }); }
      assert.deepEqual(Object.keys(cfg.mcp), ['op2probe']); assert.deepEqual(cfg.mcp.op2probe.command.slice(0, 1), [process.execPath]);
      const nonce = cfg.mcp.op2probe.environment.OP2_PROBE_NONCE;
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() { queueMicrotask(() => { for (const event of events(nonce)) child.stdout.emit('data', JSON.stringify(event) + '\n'); child.emit('exit', 0); }); } }; child.kill = () => {}; return child;
    };
    const check = createChatGPTModelCheck({ dataDir: root, spawn: fakeSpawn(nonce => [
      { type: 'tool_use', part: { tool: 'op2probe_confirm_nonce', state: { status: 'completed', input: { nonce }, output: `confirmed ${nonce}` } } },
      { type: 'text', part: { text: nonce } },
    ]) });
    assert.deepEqual(await check('openai/fixture-model'), { ok: true, model: 'openai/fixture-model', status: 'verified' });
    const unsafe = createChatGPTModelCheck({ dataDir: root, spawn: fakeSpawn(() => [{ type: 'tool_use', part: { tool: 'bash', state: { status: 'completed' } } }]) });
    await assert.rejects(unsafe('openai/fixture-model'), /invalid or unsupported/);
    let terminated = false;
    const timeoutCheck = createChatGPTModelCheck({ dataDir: root, timeoutMs: 5, spawn: () => { const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = { end() {} }; child.kill = () => { terminated = true; queueMicrotask(() => child.emit('exit', null)); }; return child; } });
    await assert.rejects(timeoutCheck('openai/fixture-model'), /timed out/); assert.equal(terminated, true);
    const disconnected = createChatGPTModelCheck({ dataDir: path.join(root, 'empty'), spawn: () => { throw new Error('must not spawn'); } });
    await assert.rejects(disconnected('openai/fixture-model'), /not connected/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('local probe MCP serves only its nonce tool and rejects other operations', async () => {
  const nonce = 'synthetic-probe-nonce';
  const modulePath = fileURLToPath(new URL('../agent/chatgpt-probe.js', import.meta.url));
  const child = spawnChild(process.execPath, [modulePath], { env: { ...process.env, OP2_PROBE_NONCE: nonce }, stdio: ['pipe', 'pipe', 'ignore'] });
  const output = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(text) : reject(new Error('probe exited unsuccessfully')));
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'confirm_nonce', arguments: { nonce } } },
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'read', arguments: {} } },
    ].map(value => JSON.stringify(value)).join('\n') + '\n');
  });
  const messages = output.trim().split(/\r?\n/).map(line => JSON.parse(line));
  assert.deepEqual(messages[1].result.tools.map(tool => tool.name), ['confirm_nonce']);
  assert.equal(messages[2].result.content[0].text, nonce);
  assert.equal(messages[3].error.code, -32601);
});

test('editor verification hook sends only the selected candidate', async () => {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const source = html.match(/async function verifyBuilderChatGPTModel\(\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(source);
  const elements = { 'f-ag-model': { value: 'openai/fixture-model' }, 'chatgpt-model-check-result': { textContent: '', style: {}, dataset: {} }, 'chatgpt-model-check-btn': { disabled: false } }; let request;
  const fn = vm.runInNewContext(`${source}; verifyBuilderChatGPTModel`, { document: { getElementById: id => elements[id] }, fetch: async (url, options) => { request = { url, options }; return { ok: true, json: async () => ({ ok: true }) }; } });
  await fn(); assert.equal(request.url, '/api/providers/chatgpt/check'); assert.deepEqual(JSON.parse(request.options.body), { model: 'openai/fixture-model' }); assert.match(elements['chatgpt-model-check-result'].textContent, /Verified/);
});

test('editor verification cannot bless a changed selection and blocks duplicate clicks', async () => {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const source = html.match(/async function verifyBuilderChatGPTModel\(\) \{[\s\S]*?\n\}/)?.[0]; assert.ok(source);
  const elements = { 'f-ag-model': { value: 'openai/first' }, 'chatgpt-model-check-result': { textContent: '', style: {}, dataset: {} }, 'chatgpt-model-check-btn': { disabled: false } };
  let finish; let calls = 0;
  const fn = vm.runInNewContext(`${source}; verifyBuilderChatGPTModel`, { document: { getElementById: id => elements[id] }, fetch: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  const pending = fn(); await Promise.resolve(); assert.equal(elements['chatgpt-model-check-btn'].disabled, true);
  await fn(); assert.equal(calls, 1);
  elements['f-ag-model'].value = 'openai/second'; finish({ ok: true, json: async () => ({ ok: true }) }); await pending;
  assert.notEqual(elements['chatgpt-model-check-result'].dataset.verifiedModel, 'openai/first');
  assert.equal(elements['chatgpt-model-check-btn'].disabled, false);
});

test('OAuth poll terminal success refreshes catalog and stale flow response is ignored', async () => {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  const source = ['function clearChatGPTFlowCode', 'function stopChatGPTFlow', 'async function pollChatGPTFlow'].map(start => {
    const at = html.indexOf(start); assert.ok(at >= 0); const brace = html.indexOf('{', at); let depth = 0;
    for (let i = brace; i < html.length; i++) { if (html[i] === '{') depth++; if (html[i] === '}' && --depth === 0) return html.slice(at, i + 1); }
    assert.fail('unterminated callback');
  }).join('\n');
  const code = { textContent: '' }, status = { textContent: '' }, panel = { style: {} }; let resolvePoll; const requests = [];
  const context = { window: { chatgptFlowId: 'old' }, Date, clearInterval() {}, setInterval() {}, document: { getElementById: id => ({ 'chatgpt-flow-code': code, 'chatgpt-flow-status': status, 'chatgpt-flow-panel': panel })[id] || null }, fetch: url => { requests.push(url); if (url.includes('/connect/')) return new Promise(resolve => { resolvePoll = resolve; }); return Promise.resolve({ ok: true }); }, loadChatGPTStatus: async () => {} };
  vm.runInNewContext(`${source}; let chatgptFlowTimer=null, chatgptFlowExpiresAt=Date.now()+10000; window.chatgptFlowId='old'; pollChatGPTFlow`, context);
  const poll = vm.runInNewContext('pollChatGPTFlow()', context); await Promise.resolve(); context.window.chatgptFlowId = 'new'; resolvePoll({ ok: true, json: async () => ({ status: 'connected', code: 'SECRET' }) }); await poll;
  assert.equal(code.textContent, ''); assert.equal(context.window.chatgptFlowId, 'new'); assert.equal(requests.some(url => url === '/api/models?refresh=1'), false);
  context.window.chatgptFlowId = 'old'; const success = vm.runInNewContext('pollChatGPTFlow()', context); await Promise.resolve(); resolvePoll({ ok: true, json: async () => ({ status: 'connected', code: 'SECRET' }) }); await success;
  assert.ok(requests.includes('/api/models?refresh=1')); assert.equal(code.textContent, '');
});
