// Agent consistency release: one place that decides which options text and permissions an agent gets, so that any of the eight
// agents works on any slot. Nothing here places an order or widens a permission beyond what the slot's own permission lists.

export const ALL_OPTION_STRUCTURES = ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit'];

// Fallback fit used only when a strategy carries no `optionStructures` of its own. A saved `optionStructures` always wins, so
// Julian can edit a strategy's fit; an empty list means the strategy never opens options (share strategies).
export const DEFAULT_OPTION_FIT = Object.freeze({
  'default': ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit'],
  'catalyst-news': ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit'],
  'etf-mean-reversion': ['long_call', 'bull_call_debit'],
  'capital-preservation': ['long_call', 'bull_call_debit'],
  'equity-momentum': ['long_call', 'bull_call_debit'],
  'long-premium-volatility': ['long_call', 'long_put'],
  'macro-rotation': [],
  'long-horizon-trend': [],
});

/**
 * The option shapes a strategy fits: its saved `optionStructures` (validated), else the built-in default for its id, else null
 * (unknown: a custom strategy that never declared a fit, which is treated as options-capable and leaves permissions alone).
 */
export function strategyOptionFit(strategy, strategyId = strategy?.id) {
  const saved = strategy?.optionStructures;
  if (Array.isArray(saved)) return saved.filter(name => ALL_OPTION_STRUCTURES.includes(name));
  if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTION_FIT, strategyId)) return [...DEFAULT_OPTION_FIT[strategyId]];
  return null;
}

/** True when the agent may be shown and run the options workflow: the slot allows options and its strategy fits some option shape. */
export function isOptionsAgent({ allowOptions, strategy, strategyId } = {}) {
  if (allowOptions === false) return false;
  const fit = strategyOptionFit(strategy, strategyId);
  return fit === null ? true : fit.length > 0;
}

/** True when a saved prompt carries a start list block (SCAN UNIVERSE or CATALYST UNIVERSE). */
export function hasStartListBlock(prompt) {
  return /^### (SCAN|CATALYST) UNIVERSE\b/m.test(String(prompt || ''));
}

/**
 * What an agent switch must change in the slot's permissions: the slot permission follows the new agent's strategy fit.
 * Returns null when nothing is to be changed (unknown fit), else { allowOptions, allowedStructures? } relative to `current`.
 * An empty fit turns options off and keeps the stored structure list (the validator requires a non-empty list).
 */
export function permissionPatchForFit(fit, current = {}) {
  if (fit === null || fit === undefined) return null;
  if (fit.length === 0) {
    return current.allowOptions === false ? null : { allowOptions: false };
  }
  const sameList = Array.isArray(current.allowedStructures)
    && current.allowedStructures.length === fit.length
    && fit.every(name => current.allowedStructures.includes(name));
  if (current.allowOptions === true && sameList) return null;
  return { allowOptions: true, allowedStructures: [...fit] };
}
