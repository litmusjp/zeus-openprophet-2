import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildSystemPrompt } from '../agent/harness.js';

const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('both scoped strategy-agent prompts retain option guardrails across override variants', async () => {
  for (const [sandboxId, id] of [['sbx_723be98b', 'catalyst'], ['sbx_956ff9e4', 'mean-reversion']]) {
    for (const override of [true, false]) {
      const marked = override
        ? `### TEMPORARY_ALPHA_MVP_OVERRIDE\nobjective\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n### MARKET-OPEN ALPHADESK WORKFLOW\nworkflow\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW`
        : 'ordinary owned prompt';
      const prompt = await buildSystemPrompt({ id, sandboxId, name: id, systemPromptTemplate: 'custom', customSystemPrompt: marked });
      assert.match(prompt, /prophet_log_decision/);
      assert.match(prompt, /numerical invalidation\/reference/i);
      assert.match(prompt, /price basis.*underlying or option premium/i);
      assert.match(prompt, /time exit or explicitly state none/i);
      assert.match(prompt, /underlying-based invalidation does not cap option-premium drawdown/i);
      assert.match(prompt, /no broker-held continuous options stop/i);
      if (override) {
        assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE/);
        assert.match(prompt, /### MARKET-OPEN ALPHADESK WORKFLOW/);
      }
      assert.equal(prompt.includes('### TEMPORARY_ALPHA_MVP_OVERRIDE'), false);
    }
  }
});

test('scoped Pendulum and Surge prompts seek strategy-qualified entries within current controls', async () => {
  for (const [sandboxId, id] of [['sbx_723be98b', 'mean-reversion'], ['sbx_956ff9e4', 'momentum']]) {
    const prompt = await buildSystemPrompt({
      id, sandboxId, name: id, systemPromptTemplate: 'custom',
      customSystemPrompt: `Identity\n### MARKET-OPEN ALPHADESK WORKFLOW\nworkflow\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW`,
    });
    assert.match(prompt, /On each normal entry-eligible regular-session heartbeat, seek qualifying opportunities within this agent's assigned strategy and settings-owned capacity/s);
    assert.match(prompt, /including while holding positions and after exits/i);
  }
});

test('shared instructions leave exits with assigned strategy and make assessment and memory research optional', async () => {
  const prompt = await buildSystemPrompt({
    id: 'mean-reversion', sandboxId: 'sbx_956ff9e4', name: 'Pendulum', systemPromptTemplate: 'custom', strategyId: 'saved-rules',
    customSystemPrompt: 'Saved Pendulum identity.',
  }, { getStrategyById: () => ({ customRules: 'UNCHANGED STRATEGY: completed breakout bars; strategy exits.' }) });
  assert.match(prompt, /UNCHANGED STRATEGY: completed breakout bars; strategy exits/);
  assert.match(prompt, /Completed qualifying prior bars remain usable/);
  assert.match(prompt, /steps.*limits model steps, not individual tool calls.*heartbeat wall-clock timeout is a separate limit/i);
  assert.match(prompt, /Do not assume or add a strategy bar timeframe/);
  assert.match(prompt, /strategy and recorded plan control exit conditions and timing/);
  assert.doesNotMatch(prompt, /confirm daily-close conditions only at daily close/i);
  assert.match(prompt, /Standalone `prophet_assess_options_trade` is optional research, not a prerequisite/);
  assert.match(prompt, /OPTIONAL RECALL/);
  assert.match(prompt, /empty result, unavailable lookup or decision not to look up examples is not an entry gate/);
  assert.match(prompt, /Stock order availability follows the configured permissions; underlying research and options workflows have their own controls/);
  assert.doesNotMatch(prompt, /Every open position needs a pre-defined exit \(stop and target\)|tighten stops|act before the bell/i);
  assert.doesNotMatch(prompt, /before opening any NEW position, call `prophet_find_similar_setups`/i);
  assert.doesNotMatch(prompt, /call `prophet_assess_options_trade` for the exact proposal/);
});

test('forced cadence filtering preserves operator tool visibility', async () => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const child = spawn(process.execPath, ['mcp-server.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, OPENPROPHET_ROLE: 'operator', OPENPROPHET_HEARTBEAT_INTERVALS_FORCED: 'true' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n');
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3000);
    child.stdout.on('data', () => {
      if (stdout.includes('"id":2')) { clearTimeout(timer); resolve(); }
    });
  });
  const closed = once(child, 'close');
  child.kill();
  await closed;
  const listing = stdout.split('\n').filter(Boolean).map(line => JSON.parse(line)).find(message => message.id === 2);
  assert.ok(listing, 'MCP tools/list response received');
  const names = listing.result.tools.map(tool => tool.name);
  for (const name of ['update_permissions', 'set_heartbeat', 'apply_heartbeat_profile', 'update_heartbeat_phase']) assert.ok(names.includes(name), `${name} remains visible to operators`);
  assert.ok(names.includes('analyze_stocks'));
  assert.ok(names.includes('get_options_chain'));
});

test('legacy multi-session markers do not override strategy, settings, or provider controls', async () => {
  const marker = '### ALPHA_MVP_MODE: MULTI_SESSION';
  const build = (sandboxId, id, body = marker, workflow = true) => buildSystemPrompt({
    id, sandboxId, name: id, systemPromptTemplate: 'custom',
    customSystemPrompt: `Identity\n### TEMPORARY_ALPHA_MVP_OVERRIDE\n${body}\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n${workflow ? '### MARKET-OPEN ALPHADESK WORKFLOW\nworkflow\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW' : ''}`,
    strategyId: id,
  }, { getStrategyById: () => ({ customRules: 'Herald intraday/fewdays; Pendulum 1–10 trading days. Preserve conditional time exits, hard risk and expiry.' }) });

  for (const [sandboxId, id] of [['sbx_723be98b', 'catalyst'], ['sbx_956ff9e4', 'mean-reversion']]) {
    const prompt = await build(sandboxId, id);
    assert.doesNotMatch(prompt, /MULTI_SESSION|two completed broker-confirmed entry-and-exit cycles|quantity one/i);
    assert.match(prompt, /Strategy Rules/);
    assert.match(prompt, /settings-owned capacity/i);
    assert.match(prompt, /prophet_place_options_order/);
    assert.match(prompt, /genuine AlphaDesk PASS/);
    assert.match(prompt, /backend independently obtains and enforces a fresh genuine PASS before broker submission/i);
    assert.match(prompt, /Herald intraday\/fewdays; Pendulum 1–10 trading days/);
  }

  const legacy = await build('sbx_723be98b', 'catalyst', 'legacy objective');
  assert.doesNotMatch(legacy, /during each U\.S\. regular session/i);
  const wrongOwner = await build('sbx_other', 'catalyst');
  assert.match(wrongOwner, /ALPHA_MVP_MODE: MULTI_SESSION/, 'unowned custom prompt text is left intact');
  assert.doesNotMatch(wrongOwner, /two completed broker-confirmed entry-and-exit cycles.*across sessions/i);
  const incomplete = await build('sbx_723be98b', 'catalyst', marker, false);
  assert.doesNotMatch(incomplete, /two completed broker-confirmed entry-and-exit cycles.*across sessions/i);
  const malformedMarker = await build('sbx_723be98b', 'catalyst', `${marker}\n### ALPHA_MVP_MODE: MULTI_SESSION_EXTRA`);
  assert.doesNotMatch(malformedMarker, /two completed broker-confirmed entry-and-exit cycles.*across sessions/i);
});

test('options position absence and post-exit reconciliation preserve exact closure semantics', async () => {
  const prompt = await buildSystemPrompt({ name: 'Test', systemPromptTemplate: 'custom', customSystemPrompt: 'test' });
  assert.match(prompt, /single-position.*404.*no open position (?:was )?found/i);
  assert.match(prompt, /After an exit, reconcile order fills and options positions/i);
  assert.match(prompt, /zero remaining contracts/i);
  assert.match(mcp, /404.*no open position (?:was )?found/i);
  assert.match(mcp, /not confirmation of a successful closure/i);
});

test('failed options requests prepend bounded faithful Go assessment diagnostics and retain original detail', async () => {
  const start = mcp.indexOf('function formatTradingBotFailure');
  const end = mcp.indexOf('async function callTradingBot', start);
  assert.ok(start >= 0 && end > start, 'formatter is defined immediately before callTradingBot');
  const context = { JSON, String };
  vm.runInNewContext(`${mcp.slice(start, end)}\nthis.formatTradingBotFailure = formatTradingBotFailure;`, context);
  const checks = Array.from({ length: 150 }, (_, index) => ({ code: `leading_check_${index}`, passed: true }));
  checks.push({ code: 'minimum_signal_score', passed: false, actual: 12, threshold: 25 });
  const response = { status: 'risk_blocked', message: `detail ${'x'.repeat(5000)}`,
    assessment_decision: 'FAIL', assessment_id: 'assessment-real-1', failed_check_codes: ['minimum_signal_score'],
    assessment_checks: checks, assessment_blocking_reasons: ['minimum_signal_score below threshold'] };
  const formatted = context.formatTradingBotFailure('/options/order', 409, response);
  assert.match(formatted.message.slice(0, 2000), /assessment_decision.*FAIL/s);
  assert.match(formatted.message.slice(0, 2000), /minimum_signal_score/);
  assert.ok(formatted.message.indexOf('\nTrading bot request failed:') < 1450, 'diagnostic prefix stays bounded');
  assert.match(formatted.message, /x{5000}/);
  assert.equal(formatted.diagnostics.http_status, 409);
  assert.equal(formatted.diagnostics.category, 'upstream_http');
  const unknown = context.formatTradingBotFailure('/options/order', 502, { error: 'opaque' });
  assert.match(unknown.message, /opaque/);
  assert.doesNotMatch(unknown.message.slice(0, 400), /assessment_decision/);
  for (const malformed of [null, 'not-json', []]) {
    const failed = context.formatTradingBotFailure('/options/order', 502, malformed);
    assert.match(failed.message, /Trading bot request failed/);
    assert.equal(failed.diagnostics.status || failed.diagnostics.http_status, 502);
  }
  const notFound = context.formatTradingBotFailure('/options/position/AAPL', 404, { error: 'not found' });
  assert.match(notFound.message.slice(0, 300), /no open position found/i);
  assert.match(notFound.message, /not found/);
  for (const [endpoint, status] of [['/options/positions', 404], ['/options/position/AAPL', 401], ['/account', 404]]) {
    const failed = context.formatTradingBotFailure(endpoint, status, { error: 'original' });
    assert.doesNotMatch(failed.message, /no open position found/i);
    assert.equal(failed.diagnostics.http_status, status);
  }
});

test('oversized assessment diagnostics stay bounded and preserve failed code through the MCP error wire', async () => {
  const formatterStart = mcp.indexOf('function formatTradingBotFailure');
  const callStart = mcp.indexOf('async function callTradingBot', formatterStart);
  const callEnd = mcp.indexOf('// Automatic memory is only for broker-confirmed fills', callStart);
  assert.ok(formatterStart >= 0 && callStart > formatterStart && callEnd > callStart);
  const longReason = 'reason detail '.repeat(900);
  const response = {
    status: 'risk_blocked',
    message: `original tail ${'z'.repeat(4000)}`,
    assessment_decision: 'FAIL',
    assessment_id: 'assessment-real-2',
    assessment_reason: 'r'.repeat(6000),
    failed_check_codes: ['minimum_signal_score', ...Array.from({ length: 12 }, () => 'c'.repeat(3000))],
    assessment_checks: Array.from({ length: 12 }, (_, index) => ({
      code: index === 0 ? 'minimum_signal_score' : 'd'.repeat(3000), passed: false, reason: longReason,
    })),
  };
  const context = {
    JSON, String, Date, Promise,
    axios: async () => { throw Object.assign(new Error('upstream'), { response: { status: 409, data: response } }); },
    getTradingBotUrl: async () => 'http://127.0.0.1:4534',
    TRADING_BOT_URL: 'http://127.0.0.1:4534',
    TRADING_BOT_TOKEN: '', TRADING_BOT_OPERATOR_TOKEN: '',
    OPENPROPHET_SANDBOX_ID: 'sbx_test', OPENPROPHET_ACCOUNT_ID: 'test', OPENPROPHET_PROCESS_NONCE: '',
    _tradingBotUrl: 'http://127.0.0.1:4534', _lastPortCheck: Date.now(),
    setTimeout,
  };
  const callSource = `${mcp.slice(formatterStart, callEnd)}\nthis.callTradingBot = callTradingBot;`;
  vm.runInNewContext(callSource, context);

  const catchStart = mcp.lastIndexOf('  } catch (error) {');
  const catchEndMatch = /\r?\n  }\r?\n}\);/.exec(mcp.slice(catchStart));
  const catchEnd = catchEndMatch
    ? catchStart + catchEndMatch.index + catchEndMatch[0].match(/^\r?\n  }/)[0].length
    : -1;
  assert.ok(catchStart >= 0 && catchEnd > catchStart, 'extract actual MCP error catch');
  const wireSource = `async function wire() { try { await callTradingBot('/options/order', 'POST'); ${mcp.slice(catchStart, catchEnd)} }\nthis.wire = wire;`;
  vm.runInNewContext(wireSource, context);
  const result = await context.wire();
  assert.equal(result.isError, true);
  const wireText = result.content[0].text;
  const decoded = JSON.parse(wireText);
  const summary = decoded.error.match(/Assessment diagnostic summary: (\{[^\n]+\})\n/);
  assert.ok(summary, 'actual MCP error includes the assessment summary');
  assert.ok(JSON.stringify(summary[1]).length <= 1000, 'summary remains bounded after MCP JSON escaping');
  assert.match(wireText.slice(0, 2000), /minimum_signal_score/);
  assert.match(summary[1], /"assessment_decision":"FAIL"/);
  assert.match(summary[1], /"assessment_id":"assessment-real-2"/);
  assert.match(summary[1], /minimum_signal_score/);
  assert.match(decoded.error, /assessment-real-2/);
  assert.match(decoded.error, /minimum_signal_score/);
  assert.doesNotMatch(summary[1], /c{20}|d{20}/, 'oversized codes are omitted instead of shortened');
  assert.match(decoded.error, /z{4000}/);
  assert.equal(decoded.diagnostics.assessment_reason, response.assessment_reason);
  assert.deepEqual(Array.from(decoded.diagnostics.failed_check_codes), response.failed_check_codes);
  assert.deepEqual(Array.from(decoded.diagnostics.assessment_checks, check => ({ ...check })), response.assessment_checks);

  for (const metadata of [null, 'malformed', [], { qualified: false, status: 'risk_blocked', error: 'opaque' }]) {
    const formatter = {};
    vm.runInNewContext(`${mcp.slice(formatterStart, callStart)}\nthis.format = formatTradingBotFailure;`, formatter);
    const failed = formatter.format('/options/order', 409, metadata);
    assert.doesNotMatch(failed.message.slice(0, 1000), /assessment_decision/);
    assert.doesNotMatch(failed.message.slice(0, 1000), /assessment_id/);
  }
  const oversizedId = 'assessment-id-'.repeat(300);
  const formatter = {};
  vm.runInNewContext(`${mcp.slice(formatterStart, callStart)}\nthis.format = formatTradingBotFailure;`, formatter);
  const omittedId = formatter.format('/options/order', 409, { assessment_id: oversizedId });
  assert.match(omittedId.message, /^Trading bot request failed:/, 'oversized identifier is omitted from the summary');
  assert.equal(omittedId.diagnostics.assessment_id, oversizedId);
});
