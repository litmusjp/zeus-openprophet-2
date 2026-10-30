import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MANAGER_ALLOWED_MCP_TOOLS,
  assertManagerToolAllowed,
  buildManagerOpenCodeConfig,
  filterManagerTools,
  managerOpenCodeArgs,
  managerOpenCodePermissionEnv,
} from '../manager-safety-policy.js';

test('Manager MCP listing is a deny-by-default view and leaves other roles unchanged', () => {
  const advertised = [
    { name: 'get_quote' }, { name: 'get_agent_config' }, { name: 'place_buy_order' },
    { name: 'assess_options_trade' }, { name: 'withdraw_planned_intent' },
    { name: 'log_decision' }, { name: 'future_unknown_action' },
    { name: 'update_heartbeat_phase' },
  ];
  assert.deepEqual(filterManagerTools('manager', advertised).map(({ name }) => name), ['get_quote', 'get_agent_config']);
  assert.equal(filterManagerTools('agent', advertised), advertised);
  assert.equal(filterManagerTools('operator', advertised), advertised);
  assert.ok([...MANAGER_ALLOWED_MCP_TOOLS].every((name) => !name.startsWith('place_')));
});

test('direct Manager calls reject trading, fabricated records, assessments, and unknown names', () => {
  for (const name of [
    'place_buy_order', 'place_sell_order', 'place_managed_position', 'place_options_order',
    'cancel_order', 'close_managed_position', 'withdraw_planned_intent', 'assess_options_trade',
    'assess_options_strategy', 'log_decision', 'log_activity', 'store_trade_setup', 'future_unknown_action',
    'update_heartbeat_phase',
  ]) assert.throws(() => assertManagerToolAllowed('manager', name), /unavailable to the Manager/);
  for (const name of ['get_quote', 'get_agent_config', 'get_positions', 'get_session_context']) {
    assert.doesNotThrow(() => assertManagerToolAllowed('manager', name));
  }
  assert.doesNotThrow(() => assertManagerToolAllowed('agent', 'place_buy_order'));
  assert.doesNotThrow(() => assertManagerToolAllowed('operator', 'place_buy_order'));
});

test('MCP handlers use trusted environment role and gate before permission/backend work', async () => {
  const source = await readFile(process.env.MCP_SERVER_SOURCE_FILE || new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.match(source, /const OPENPROPHET_ROLE\s*=.*process\.env\.OPENPROPHET_ROLE/);
  const listing = source.indexOf('filterToolsForCurrentAuthority(filterManagerTools(OPENPROPHET_ROLE');
  const handler = source.indexOf('server.setRequestHandler(CallToolRequestSchema');
  const guard = source.indexOf('assertManagerToolAllowed(OPENPROPHET_ROLE, name);', handler);
  const permissions = source.indexOf('await enforcePermissions(name, args);', handler);
  assert.ok(listing > 0 && handler > 0 && guard > handler && permissions > guard);
});

test('Manager OpenCode profile replaces hostile inherited settings and preserves model/provider config', () => {
  const source = {
    model: 'openai/example-model', small_model: 'openai/example-model',
    provider: { openai: { models: { 'example-model': { name: 'kept' } } } },
    agent: { manager: { permission: { bash: 'allow' }, tools: { read: true } }, build: { mode: 'primary' } },
  };
  const result = buildManagerOpenCodeConfig(source);
  assert.equal(result.model, source.model);
  assert.deepEqual(result.provider, source.provider);
  assert.deepEqual(result.agent.build, source.agent.build);
  assert.equal(result.agent.manager.mode, 'primary');
  assert.equal(result.agent.manager.permission['*'], 'deny');
  assert.equal(result.agent.manager.permission.bash, 'deny');
  assert.equal(result.agent.manager.permission.read, 'deny');
  assert.equal(result.agent.manager.permission['prophet_*'], 'allow');
  assert.deepEqual(JSON.parse(managerOpenCodePermissionEnv()), result.agent.manager.permission);
});

test('Manager profile selection applies to native/non-native and resumed run arguments', () => {
  assert.deepEqual(managerOpenCodeArgs('openai/model-a', undefined), [
    'run', '--format', 'json', '--model', 'openai/model-a', '--agent', 'manager',
  ]);
  assert.deepEqual(managerOpenCodeArgs('anthropic/model-b', 'session-123'), [
    'run', '--format', 'json', '--model', 'anthropic/model-b', '--agent', 'manager', '--session', 'session-123',
  ]);
});
