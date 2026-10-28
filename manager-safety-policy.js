// Manager-only MCP/OpenCode boundary. Keep this policy pure so it can be
// verified without starting the trading backend or OpenCode sessions.
export const MANAGER_ALLOWED_MCP_TOOLS = new Set([
  'get_account', 'get_positions', 'get_orders', 'get_managed_positions', 'get_managed_position',
  'get_quote', 'get_latest_bar', 'get_historical_bars', 'get_news', 'get_news_by_topic',
  'search_news', 'get_market_news', 'aggregate_and_summarize_news', 'list_news_summaries',
  'get_news_summary', 'get_marketwatch_topstories', 'get_marketwatch_realtime',
  'get_marketwatch_bulletins', 'get_marketwatch_marketpulse', 'get_marketwatch_all',
  'get_treasury_data', 'get_global_events', 'get_economic_indicators', 'get_market_snapshot',
  'get_defense_contracts', 'get_global_trade_flows', 'get_quick_market_intelligence',
  'analyze_stocks', 'get_cleaned_news', 'get_activity_log', 'get_options_assessment_policy',
  'get_options_positions', 'get_options_position', 'get_options_chain', 'get_datetime',
  'find_similar_setups', 'get_trade_stats', 'update_agent_prompt', 'update_strategy_rules',
  'get_agent_config', 'set_heartbeat', 'set_session_mode', 'get_heartbeat_profiles',
  'apply_heartbeat_profile', 'get_heartbeat_phases',
  'list_sandboxes', 'get_session_context', 'create_agent', 'create_strategy',
  'assign_agent_to_sandbox',
]);

export function isManagerToolAllowed(role, toolName) {
  return role !== 'manager' || MANAGER_ALLOWED_MCP_TOOLS.has(toolName);
}

export function filterManagerTools(role, tools) {
  return role === 'manager' ? tools.filter(({ name }) => isManagerToolAllowed(role, name)) : tools;
}

export function assertManagerToolAllowed(role, toolName) {
  if (!isManagerToolAllowed(role, toolName)) {
    throw new Error(`Tool "${toolName}" is unavailable to the Manager`);
  }
}

const MANAGER_OPENCODE_DENIED_TOOLS = Object.freeze([
  'bash', 'read', 'write', 'edit', 'apply_patch', 'patch', 'glob', 'grep', 'list',
  'task', 'skill', 'webfetch', 'websearch', 'question', 'todowrite', 'todoread',
  'lsp', 'external_directory', 'doom_loop',
]);

function managerOpenCodePermissions() {
  return Object.fromEntries([
    ...MANAGER_OPENCODE_DENIED_TOOLS.map((tool) => [tool, 'deny']),
    ['*', 'deny'],
    ['prophet_*', 'allow'],
  ]);
}

export function buildManagerOpenCodeConfig(config) {
  const source = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return {
    ...source,
    agent: {
      ...(source.agent && typeof source.agent === 'object' && !Array.isArray(source.agent) ? source.agent : {}),
      manager: {
        mode: 'primary',
        permission: managerOpenCodePermissions(),
      },
    },
  };
}

export function managerOpenCodePermissionEnv() {
  return JSON.stringify(managerOpenCodePermissions());
}

export function managerOpenCodeArgs(model, sessionId) {
  const args = ['run', '--format', 'json', '--model', model, '--agent', 'manager'];
  if (sessionId) args.push('--session', sessionId);
  return args;
}
