// Phase C, Step 4: the agent-side check of a two-leg debit vertical passed to place_options_order through the optional
// `legs` parameter. The backend re-validates everything (structure, permission, group, risk); this only refuses what can
// never be valid, before any backend call, and builds the request fields. Single-leg calls never reach this module.

const VALID_INTENTS = new Set(['buy_to_open', 'buy_to_close', 'sell_to_open', 'sell_to_close']);

export function spreadLegsRequest(args) {
  const legs = args?.legs;
  if (!Array.isArray(legs) || legs.length !== 2) return { error: 'legs must be exactly two legs (a debit vertical); never build a spread from separate single-leg orders' };
  const clean = [];
  for (const [index, leg] of legs.entries()) {
    if (!leg || typeof leg !== 'object') return { error: `leg ${index} must be an object` };
    if (typeof leg.symbol !== 'string' || !leg.symbol.trim()) return { error: `leg ${index} needs an OCC symbol` };
    if (leg.side !== 'buy' && leg.side !== 'sell') return { error: `leg ${index} side must be buy or sell` };
    if (!VALID_INTENTS.has(leg.position_intent)) return { error: `leg ${index} position_intent must be one of ${[...VALID_INTENTS].join(', ')}` };
    if ((leg.position_intent.startsWith('buy_') && leg.side !== 'buy') || (leg.position_intent.startsWith('sell_') && leg.side !== 'sell')) return { error: `leg ${index} position_intent must match its side` };
    const ratio = leg.ratio_qty === undefined ? 1 : leg.ratio_qty;
    if (ratio !== 1) return { error: `leg ${index} ratio_qty must be 1 (only 1:1 verticals are supported)` };
    if (typeof leg.price !== 'number' || !Number.isFinite(leg.price) || leg.price <= 0) return { error: `leg ${index} needs the positive quote price you used for it` };
    clean.push({ symbol: leg.symbol.trim(), side: leg.side, ratio_qty: 1, position_intent: leg.position_intent, price: leg.price });
  }
  const opening = clean.every(leg => leg.position_intent.endsWith('_to_open'));
  const closing = clean.every(leg => leg.position_intent.endsWith('_to_close'));
  if (!opening && !closing) return { error: 'a spread must open both legs or close both legs' };
  if (clean[0].side === clean[1].side) return { error: 'a vertical buys one leg and sells the other' };
  const first = clean[0];
  if (args.symbol !== first.symbol || args.side !== first.side || args.position_intent !== first.position_intent) {
    return { error: 'symbol, side and position_intent must repeat the first leg (legs[0]) so the call is unambiguous' };
  }
  if (args.order_type !== 'limit') return { error: 'a spread is a limit order; set order_type to limit and limit_price to the net debit (opening) or net credit (closing) per unit' };
  if (!(typeof args.limit_price === 'number') || !Number.isFinite(args.limit_price) || args.limit_price <= 0) return { error: 'limit_price must be the positive net debit (opening) or net credit (closing) per unit' };
  return { legs: clean, opening, priceKind: opening ? 'debit' : 'credit' };
}
