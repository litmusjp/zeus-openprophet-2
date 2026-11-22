// Agent consistency release: one place that decides which options text and permissions an agent gets, so that any of the eight
// agents works on any slot. Nothing here places an order. A switch sets the slot permission to the new agent's own option fit (it can
// widen or narrow it, by design); every patch is validated with the ordinary permission validator before it is saved.

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
  if (Array.isArray(saved)) return [...new Set(saved.filter(name => ALL_OPTION_STRUCTURES.includes(name)))];
  if (Object.prototype.hasOwnProperty.call(DEFAULT_OPTION_FIT, strategyId)) return [...DEFAULT_OPTION_FIT[strategyId]];
  return null;
}

/**
 * Validates a strategy's `optionStructures` before it is saved: undefined (leave alone), null (clear: the built-in default
 * applies) or a list of unique known names (an empty list means the strategy never opens options). Throws on anything else.
 */
export function validateOptionFitInput(value) {
  if (value === undefined || value === null) return value;
  if (!Array.isArray(value)) throw new Error('optionStructures must be a list of option shapes, or null');
  if (value.some(name => typeof name !== 'string' || !ALL_OPTION_STRUCTURES.includes(name))) {
    throw new Error(`optionStructures may only contain: ${ALL_OPTION_STRUCTURES.join(', ')}`);
  }
  if (new Set(value).size !== value.length) throw new Error('optionStructures must not repeat a name');
  return [...value];
}

/** True when the agent may be shown and run the options workflow: the slot allows options and its strategy fits some option shape. */
export function isOptionsAgent({ allowOptions, strategy, strategyId } = {}) {
  if (allowOptions === false) return false;
  const fit = strategyOptionFit(strategy, strategyId);
  return fit === null ? true : fit.length > 0;
}

/** A warning text when the slot permission differs from what the agent's strategy fits (the fit is only applied on a switch), else null. */
export function fitDriftWarning(fit, current = {}, agentName = 'The agent') {
  if (fit === null || fit === undefined) return null;
  return permissionPatchForFit(fit, current)
    ? `${agentName}'s strategy fits ${fit.length ? fit.join(', ') : 'no options (shares only)'}, but this slot's permission differs; re-assign the agent to apply the fit, or leave the slot permission as it is on purpose`
    : null;
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
  const have = current.allowedStructures;
  const haveValid = Array.isArray(have) && have.length > 0 && new Set(have).size === have.length && have.every(name => ALL_OPTION_STRUCTURES.includes(name));
  const sameList = haveValid && have.length === fit.length && fit.every(name => have.includes(name));
  if (current.allowOptions === true && sameList) return null;
  return { allowOptions: true, allowedStructures: [...fit] };
}
