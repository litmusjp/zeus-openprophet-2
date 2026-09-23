// permissions.js — pure trading-permission policy (no network), shared by the MCP gate and tests.
// enforcePermissions() in mcp-server.js fetches `perms` from the agent server, then delegates
// the actual policy decision here so it can be unit-tested without a running server.

export const ORDER_TOOLS = ['place_buy_order', 'place_sell_order', 'place_options_order', 'place_managed_position', 'close_managed_position', 'cancel_order', 'withdraw_planned_intent'];

export function isOptionSymbol(symbol = '') {
  return /^[A-Z0-9. ]{1,6}\d{6}[CP]\d{8}$/.test(String(symbol).trim().toUpperCase());
}

export function estimateOrderValue(toolName, args = {}) {
  if (toolName === 'close_managed_position') return 0;
  const allocation = Number(args.allocation_dollars || 0);
  if (toolName === 'place_managed_position' && allocation > 0 && !isOptionSymbol(args.symbol)) return allocation;
  const price = Number(args.limit_price ?? args.entry_price ?? 0);
  const quantity = Number(args.quantity ?? args.qty ?? 0);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) {
    throw new Error('A positive finite price and quantity are required to enforce the max order value.');
  }
  const multiplier = (toolName === 'place_options_order' || isOptionSymbol(args.symbol)) ? 100 : 1;
  return price * quantity * multiplier;
}

// Throws an Error describing the violation if the call is not permitted; returns undefined if allowed.
// `now` is injectable so the 0DTE (same-day expiry) rule is deterministic in tests.
export function checkPermissions(toolName, args = {}, perms = {}, now = new Date()) {
  const allowPaperTrading = perms.allowPaperTrading !== false;
  const allowOptions = perms.allowOptions === true;
  const allowStocks = perms.allowStocks === true;
  const allow0DTE = perms.allow0DTE === true;
  const requireConfirmation = perms.requireConfirmation !== false;
  const maxOrderValue = Number.isFinite(Number(perms.maxOrderValue)) ? Number(perms.maxOrderValue) : 0;

  // Blocked tools
  if (perms.blockedTools?.length && perms.blockedTools.includes(toolName)) {
    throw new Error(`Tool "${toolName}" is blocked by permissions. Blocked tools: ${perms.blockedTools.join(', ')}`);
  }

  // Everything below is order-specific
  if (!ORDER_TOOLS.includes(toolName)) return;

  // Paper trading is a distinct, safe capability. Live accounts are rejected at
  // the server-owned Go boundary regardless of permission flags.
  if (!allowPaperTrading && toolName !== 'close_managed_position' && toolName !== 'cancel_order') {
    throw new Error('Paper trading is DISABLED by permissions. Cannot place paper orders.');
  }
  // Generic equity/managed-position routes must never accept OCC option symbols.
  // Options require the explicit route so position intent and option limits apply.
  if (isOptionSymbol(args.symbol) && toolName !== 'place_options_order') {
    throw new Error('OCC option symbols must use place_options_order with an explicit position_intent.');
  }
  // Explicit options orders must carry intent; buy/sell alone is ambiguous.
  if (toolName === 'place_options_order') {
    const validIntents = new Set(['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close']);
    if (!validIntents.has(args.position_intent)) {
      throw new Error('place_options_order requires an explicit position_intent.');
    }
    if ((args.position_intent.startsWith('buy_') && args.side !== 'buy') ||
        (args.position_intent.startsWith('sell_') && args.side !== 'sell')) {
      throw new Error('position_intent must match the order side.');
    }
  }
  // Options check
  if (!allowOptions && (toolName === 'place_options_order' || (args.symbol && args.symbol.length > 10))) {
    throw new Error('Options trading is DISABLED by permissions.');
  }
  // Stock check
  if (!allowStocks && (toolName === 'place_buy_order' || toolName === 'place_sell_order')) {
    throw new Error('Stock trading is DISABLED by permissions.');
  }
  // 0DTE check for options — OCC format: SYMBOL + YYMMDD + C/P + strike
  if (!allow0DTE && toolName === 'place_options_order' && args.symbol) {
    const match = args.symbol.match(/(\d{6})[CP]/);
    if (match) {
      const expStr = match[1]; // YYMMDD
      const expDate = new Date(`20${expStr.slice(0, 2)}-${expStr.slice(2, 4)}-${expStr.slice(4, 6)}`);
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      expDate.setHours(0, 0, 0, 0);
      if (expDate.getTime() === today.getTime()) {
        throw new Error('0DTE options are NOT allowed by permissions.');
      }
    }
  }
  // Require confirmation
  if (requireConfirmation) {
    throw new Error('Order requires operator approval (requireConfirmation is enabled). Stop and report that operator approval is required.');
  }
  // Max order value
  if (maxOrderValue > 0) {
    const checkValue = estimateOrderValue(toolName, args);
    if (checkValue > maxOrderValue) {
      throw new Error(`Order value $${checkValue.toFixed(2)} exceeds max allowed $${maxOrderValue}. Reduce size or change permissions.`);
    }
  }
}
