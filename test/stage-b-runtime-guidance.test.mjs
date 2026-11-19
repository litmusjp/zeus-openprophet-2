import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import { AgentHarness, TRADING_AGENT_READ_DENIES } from '../agent/harness.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';
import { renderPrefixedToolMenu, HERALD_TOOL_CATALOG, TOOL_CATALOG } from '../agent/tool-catalog.js';

function fakeProcess() {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  queueMicrotask(() => {
    proc.stdout.emit('data', `${JSON.stringify({ type: 'text', part: { text: 'OK' } })}\n`);
    proc.emit('exit', 0, null);
    proc.emit('close', 0, null);
  });
  return proc;
}
async function configFor(inherited) {
  let captured;
  const harness = new AgentHarness({ opencodeEnv: { OPENCODE_CONFIG_CONTENT: inherited === undefined ? '' : JSON.stringify(inherited) }, spawnFn: (_c, _a, options) => { captured = options.env; return fakeProcess(); } });
  await harness._runClaude('prompt', 'opencode/big-pickle');
  return JSON.parse(captured.OPENCODE_CONFIG_CONTENT);
}

// B0: reproduced on the OpenCode runtime with a local mock provider (see the build report): a refused permission ask ends the run before the
// model sees the refusal; with the switch the run continues with the refusal returned to the model. The switch grants nothing.
test('B0: the generated OpenCode config lets a refused call return an error to the model, and grants no permission', async () => {
  const config = await configFor(undefined);
  assert.equal(config.experimental.continue_loop_on_deny, true);
  const primary = config.agent[config.default_agent || 'build'];
  assert.equal(primary.permission.todowrite, 'deny');
  assert.equal(primary.permission.task, 'deny');
  for (const [pattern, action] of Object.entries(TRADING_AGENT_READ_DENIES)) assert.equal(primary.permission.read[pattern], action, pattern);
  assert.ok(!JSON.stringify(config).includes('"external_directory"'), 'no external-directory rule is added or loosened');
});

test('B0: an inherited experimental block is preserved and the global permission block is untouched', async () => {
  const config = await configFor({ experimental: { keep_me: 1 }, permission: { '*': 'ask' } });
  assert.deepEqual(config.experimental, { keep_me: 1, continue_loop_on_deny: true });
  assert.deepEqual(config.permission, { '*': 'ask' });
  const odd = await configFor({ experimental: ['x'] });
  assert.deepEqual(odd.experimental, { continue_loop_on_deny: true });
});

// B2: the range and confirmation helper is registered, offered to Herald only and described in Herald's rules once.
test('B2: the helper is registered as a read-only tool and appears only in the Herald menu', () => {
  const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.match(source, /name: 'get_range_confirmation'/);
  assert.match(source, /case 'get_range_confirmation':/);
  assert.match(renderPrefixedToolMenu({ scope: 'herald' }), /prophet_get_range_confirmation/);
  assert.doesNotMatch(renderPrefixedToolMenu(), /get_range_confirmation/);
  assert.ok(HERALD_TOOL_CATALOG['Market Data'].includes('get_range_confirmation'));
  assert.ok(!TOOL_CATALOG['Market Data'].includes('get_range_confirmation'));
  const handler = source.slice(source.indexOf("case 'get_range_confirmation':"), source.indexOf("case 'get_news':"));
  assert.doesNotMatch(handler, /method|'POST'|place_|cancel_/, 'the handler only reads bars');
});

test('B2: the Herald rules name the helper once; the other families render exactly as before', () => {
  const render = id => renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
  const herald = render('catalyst-news');
  assert.equal(herald.split('prophet_get_range_confirmation').length - 1, 1);
  assert.match(herald, /It states facts only, so entries, stops and exits stay your decisions/);
  assert.match(herald, /do not estimate one/);
  for (const id of ['equity-momentum', 'etf-mean-reversion', 'long-premium-volatility', 'default', 'capital-preservation']) {
    assert.doesNotMatch(render(id), /get_range_confirmation/, id);
  }
  const added = herald.split('\n').find(line => line.startsWith('- Range and confirmation arithmetic:'));
  assert.ok(added && !/\d{4}-\d{2}-\d{2}|\b[A-Z]{2,5}\b(?<!UTC)/.test(added.replace(/prophet_get_range_confirmation|UTC|OP2/g, '')), 'prompt hygiene: no dates or tickers in the added line');
});
