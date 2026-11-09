import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentHarness, buildSystemPrompt, TRADING_AGENT_NATIVE_TOOL_DENIES, TRADING_AGENT_READ_DENIES } from '../agent/harness.js';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
  });
  return proc;
}

async function generatedConfig(inherited = '') {
  let captured;
  const harness = new AgentHarness({
    opencodeEnv: { OPENCODE_CONFIG_CONTENT: inherited },
    spawnFn: (_cmd, _args, options) => { captured = options.env; return fakeProcess(); },
  });
  await harness._runClaude('prompt', 'opencode/big-pickle');
  const config = JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
  return config.agent[config.default_agent || 'build'].permission;
}

test('a trading agent cannot use the native shell, edit or file-search tools', async () => {
  const permission = await generatedConfig();
  for (const tool of ['bash', 'edit', 'write', 'patch', 'multiedit', 'grep', 'glob', 'list', 'todowrite', 'todoread', 'task']) {
    assert.equal(permission[tool], 'deny', tool);
  }
  assert.deepEqual(Object.keys(TRADING_AGENT_NATIVE_TOOL_DENIES).sort(), ['bash', 'edit', 'glob', 'grep', 'list', 'multiedit', 'patch', 'write']);
});

test('web search, web fetch and reading back spilled output stay available; credential and config files are denied', async () => {
  const permission = await generatedConfig();
  assert.equal(permission.websearch, undefined, 'web search is not denied');
  assert.equal(permission.webfetch, undefined, 'web fetch is not denied');
  assert.equal(permission.external_directory, undefined, 'OpenCode keeps its own tool-output allowance');
  assert.ok(permission.read && typeof permission.read === 'object');
  assert.equal(permission.read['*'], undefined, 'no blanket read rule that would re-allow .env files');
  for (const pattern of ['**/agent-config.json', '**/agent-config.pre-secrets-*', '**/secrets.json', '**/secrets.json.*', '**/auth.json', '**/.env', '**/.env.*']) {
    assert.equal(permission.read[pattern], 'deny', pattern);
  }
  for (const pattern of Object.keys(TRADING_AGENT_READ_DENIES)) {
    assert.ok(!/tool-output|opencode\/tool/.test(pattern), 'no deny rule can match the spilled tool-output folder');
  }
});

test('an inherited read rule is kept and the denies are added to it', async () => {
  const inherited = JSON.stringify({ agent: { build: { permission: { read: { '**/notes.md': 'allow' } } } } });
  const permission = await generatedConfig(inherited);
  assert.equal(permission.read['**/notes.md'], 'allow');
  assert.equal(permission.read['**/secrets.json'], 'deny');
  assert.equal(permission.bash, 'deny');
});

const deps = { getStrategyById: () => ({ customRules: 'Rules.' }) };
const agent = (extra = {}) => ({ id: 'x', name: 'X', sandboxId: 'sbx_x', systemPromptTemplate: 'custom', strategyId: 'catalyst-news', customSystemPrompt: 'Identity.', ...extra });

test('the prompt states the new tool limits and never names the private files', async () => {
  for (const strategyId of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum']) {
    const prompt = await buildSystemPrompt(agent({ strategyId }), deps);
    assert.match(prompt, /Use only the prophet_ tools plus web search and fetch\. Native shell, edit and file-search tools are not available to you; read a file only to read back a long tool result you were pointed to/, strategyId);
    assert.match(prompt, /Never try to find or read credentials or configuration files/, strategyId);
    assert.doesNotMatch(prompt, /secrets\.json|agent-config|auth\.json/, strategyId);
  }
});
