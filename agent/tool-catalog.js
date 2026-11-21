// Single source of truth for the curated tool menu injected into agent prompts.
// The MCP server exposes more tools than the agent needs to see; this is the intentional,
// curated subset. Keeping it here (instead of hand-copied into two prompt strings in
// harness.js) prevents the two copies from drifting apart or from the real tool set.
export const TOOL_CATALOG = {
  'Trading': ['get_account', 'get_positions', 'get_orders', 'place_buy_order', 'place_sell_order', 'place_managed_position', 'get_managed_positions', 'close_managed_position', 'cancel_order', 'withdraw_planned_intent'],
  'Options': ['get_options_assessment_policy', 'assess_options_trade', 'place_options_order', 'get_options_positions', 'get_options_position', 'get_option_expirations', 'get_options_chain', 'get_option_groups'],
  'Market Data': ['get_quote', 'get_latest_bar', 'get_historical_bars', 'get_daily_features', 'get_earnings_dates', 'get_market_snapshot', 'analyze_stocks'],
  'News': ['get_alpaca_news', 'get_news', 'search_news', 'get_market_news', 'get_quick_market_intelligence', 'get_cleaned_news', 'get_marketwatch_topstories', 'get_marketwatch_realtime'],
  'Intelligence': ['aggregate_and_summarize_news', 'list_news_summaries', 'get_news_summary'],
  'Agent Config': ['list_sandboxes', 'get_agent_config', 'set_heartbeat', 'update_permissions'],
  'Heartbeat': ['get_heartbeat_profiles', 'apply_heartbeat_profile', 'get_heartbeat_phases', 'update_heartbeat_phase'],
  'Logging': ['log_decision', 'log_activity', 'get_activity_log', 'get_session_context'],
  'Trade History': ['find_similar_setups', 'store_trade_setup', 'get_trade_stats'],
  'Utility': ['get_datetime', 'wait'],
};

// Herald gets a derived prompt subset; tool registration and permissions stay unchanged.
const HERALD_OMIT_CATEGORIES = new Set(['Agent Config', 'Heartbeat', 'Intelligence']);
const HERALD_OMIT_TOOLS = new Set([
  'place_buy_order', 'place_sell_order', 'place_managed_position', 'get_managed_positions', 'close_managed_position',
  'analyze_stocks', 'get_quick_market_intelligence', 'get_cleaned_news',
]);
export const HERALD_TOOL_CATALOG = Object.fromEntries(
  Object.entries(TOOL_CATALOG)
    .filter(([category]) => !HERALD_OMIT_CATEGORIES.has(category))
    .map(([category, tools]) => [category, tools.filter(tool => !HERALD_OMIT_TOOLS.has(tool))]),
);
// Herald alone also gets the read-only range and confirmation arithmetic helper (Guardian and Prophet menus are unchanged).
HERALD_TOOL_CATALOG['Market Data'].splice(HERALD_TOOL_CATALOG['Market Data'].indexOf('get_historical_bars') + 1, 0, 'get_range_confirmation');
// Herald alone also gets the read-only exact-contract quote for a contract it holds (a due exit when the chain does not return it).
HERALD_TOOL_CATALOG['Options'].splice(HERALD_TOOL_CATALOG['Options'].indexOf('get_options_chain') + 1, 0, 'get_options_quote');

// Render a catalog as the `**Category**: tool, tool` block used in prompts.
export function renderToolMenu(options = {}) {
  const catalog = options.scope === 'herald' ? HERALD_TOOL_CATALOG : TOOL_CATALOG;
  const hidden = new Set(['update_permissions']);
  if (options.heartbeatIntervalsForced) {
    for (const tool of ['set_heartbeat', 'apply_heartbeat_profile', 'update_heartbeat_phase']) hidden.add(tool);
  }
  return Object.entries(catalog)
    .map(([category, tools]) => [category, tools.filter(tool => !hidden.has(tool))])
    .filter(([, tools]) => tools.length)
    .map(([category, tools]) => `**${category}**: ${tools.join(', ')}`)
    .join('\n');
}

export function renderPrefixedToolMenu(options = {}) {
  const catalog = options.scope === 'herald' ? HERALD_TOOL_CATALOG : TOOL_CATALOG;
  const hidden = new Set(['update_permissions']);
  if (options.heartbeatIntervalsForced) {
    for (const tool of ['set_heartbeat', 'apply_heartbeat_profile', 'update_heartbeat_phase']) hidden.add(tool);
  }
  return Object.entries(catalog)
    .map(([category, tools]) => [category, tools.filter(tool => !hidden.has(tool))])
    .filter(([, tools]) => tools.length)
    .map(([category, tools]) => `**${category}**: ${tools.map(tool => `prophet_${tool}`).join(', ')}`)
    .join('\n');
}
