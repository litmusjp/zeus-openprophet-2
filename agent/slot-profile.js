// Strategy slot profile (switch-profile plan 3.1, 3.2): the Trading Guidance subset and heartbeat intervals a slot takes when an agent
// whose effective strategy carries a profile is switched in. Pure functions: nothing here reads or writes any store.
import crypto from 'node:crypto';
import { normalizeTradingGuidance, validateGuidanceField } from './trading-guidance.js';

export const PROFILE_KEYS = Object.freeze(['tradingGuidance', 'heartbeat']);
export const PROFILE_GUIDANCE_KEYS = Object.freeze([
  'contractDeltaMin', 'contractDeltaMax', 'expiryMinDays', 'expiryMaxDays', 'minEntryPct', 'extendedPct', 'marketSymbol',
  'marketTolerancePct', 'marketSlopeMinPct', 'nearSupportPct', 'avgSlopeMinPct', 'extraSymbolsPerScan', 'catalystRangeMinutes', 'catalystMaxGapPct',
]);
export const PROFILE_HEARTBEAT_KEYS = Object.freeze(['market_open', 'midday', 'market_close']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function badProfile(message) { return Object.assign(new Error(message), { status: 400 }); }

export function validHeartbeatInterval(value) { return Number.isSafeInteger(value) && value >= 30 && value <= 14400; }

/**
 * Validates a strategy's `slotProfile` BEFORE any normalisation and returns its canonical form: only supplied keys, coerced values, a fixed
 * key order, empty containers removed. Returns null for "no profile" (null, or a profile with no keys left). Throws (status 400) on an
 * unknown or forbidden key, a container that is not a plain object (null, array, string...), or an out-of-range value. No default is ever inserted.
 * `undefined` is the caller's "leave as is" and is not accepted here.
 */
export function canonicalizeSlotProfile(input) {
  if (input === null) return null;
  if (!isPlainObject(input)) throw badProfile('slotProfile must be an object, or null to remove it');
  for (const key of Object.keys(input)) {
    if (!PROFILE_KEYS.includes(key)) throw badProfile(`slotProfile may only contain tradingGuidance and heartbeat (not ${key})`);
  }
  const out = {};
  if (has(input, 'tradingGuidance')) {
    const raw = input.tradingGuidance;
    if (!isPlainObject(raw)) throw badProfile('slotProfile.tradingGuidance must be an object');
    for (const key of Object.keys(raw)) {
      if (!PROFILE_GUIDANCE_KEYS.includes(key)) throw badProfile(`slotProfile.tradingGuidance may not contain ${key}`);
    }
    const guidance = {};
    for (const key of PROFILE_GUIDANCE_KEYS) {
      if (!has(raw, key)) continue;
      if (key === 'marketSymbol' && typeof raw[key] !== 'string') throw badProfile('marketSymbol must be a ticker symbol such as SPY');
      try { guidance[key] = validateGuidanceField(key, raw[key]); } catch (error) { throw badProfile(`slotProfile.tradingGuidance: ${error.message}`); }
    }
    if (has(guidance, 'contractDeltaMin') && has(guidance, 'contractDeltaMax') && !(guidance.contractDeltaMin < guidance.contractDeltaMax)) {
      throw badProfile('slotProfile.tradingGuidance: contractDeltaMin must be lower than contractDeltaMax');
    }
    if (has(guidance, 'expiryMinDays') && has(guidance, 'expiryMaxDays') && guidance.expiryMinDays > guidance.expiryMaxDays) {
      throw badProfile('slotProfile.tradingGuidance: expiryMinDays must not exceed expiryMaxDays');
    }
    if (Object.keys(guidance).length) out.tradingGuidance = guidance;
  }
  if (has(input, 'heartbeat')) {
    const raw = input.heartbeat;
    if (!isPlainObject(raw)) throw badProfile('slotProfile.heartbeat must be an object');
    for (const key of Object.keys(raw)) {
      if (!PROFILE_HEARTBEAT_KEYS.includes(key)) throw badProfile(`slotProfile.heartbeat may not contain ${key}`);
    }
    const heartbeat = {};
    for (const key of PROFILE_HEARTBEAT_KEYS) {
      if (!has(raw, key)) continue;
      if (!validHeartbeatInterval(raw[key])) throw badProfile(`slotProfile.heartbeat.${key} must be a whole number of seconds from 30 to 14400`);
      heartbeat[key] = raw[key];
    }
    if (Object.keys(heartbeat).length) out.heartbeat = heartbeat;
  }
  return Object.keys(out).length ? out : null;
}

/** The stored profile of a strategy in canonical form, or null. A stored value that no longer validates counts as no profile. */
export function profileOfStrategy(strategy) {
  if (!strategy || strategy.slotProfile === undefined || strategy.slotProfile === null) return null;
  try { return canonicalizeSlotProfile(strategy.slotProfile); } catch { return null; }
}

export const heartbeatView = heartbeat => ({
  market_open: heartbeat?.market_open,
  midday: heartbeat?.midday,
  market_close: heartbeat?.market_close,
  mode: heartbeat?.mode ?? null,
  forceHeartbeatIntervals: heartbeat?.forceHeartbeatIntervals === true,
});

/**
 * What applying `profile` to a slot would change. `slotGuidance` is the slot's full current guidance, `slotHeartbeat` its heartbeat object.
 * Returns { errors, guidance: {merged, changes}|null, heartbeat: {patch, before, after}|null }. Nothing is saved.
 *  - guidance: the merged object is validated again against the slot's CURRENT values (a partial bound that conflicts is refused).
 *  - heartbeat: only when the profile has one; omitted intervals keep the slot value, the final three are validated, and the derived
 *    mode market_aware plus the interval lock are added.
 */
export function planProfileApplication(profile, { slotGuidance, slotHeartbeat }) {
  const result = { errors: [], guidance: null, heartbeat: null };
  if (!profile) return result;
  if (profile.tradingGuidance) {
    try {
      const merged = normalizeTradingGuidance({ ...slotGuidance, ...profile.tradingGuidance }, { strict: true, base: slotGuidance });
      const changes = Object.keys(profile.tradingGuidance)
        .filter(key => merged[key] !== slotGuidance[key])
        .map(key => ({ key, before: slotGuidance[key], after: merged[key] }));
      result.guidance = { merged, changes };
    } catch (error) {
      result.errors.push(`The profile conflicts with this slot's current Trading Guidance: ${error.message}`);
    }
  }
  if (profile.heartbeat) {
    const patch = { ...profile.heartbeat, mode: 'market_aware', forceHeartbeatIntervals: true };
    const before = heartbeatView(slotHeartbeat);
    const after = { ...before, ...patch };
    const bad = PROFILE_HEARTBEAT_KEYS.find(key => !validHeartbeatInterval(after[key]));
    if (bad) result.errors.push(`The profile leaves heartbeat ${bad} invalid for this slot (whole seconds from 30 to 14400)`);
    else result.heartbeat = { patch, before, after, changed: JSON.stringify(before) !== JSON.stringify(after) };
  }
  return result;
}

const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;

/** SHA-256 of the canonical state a review covers (plan 3.6). Recomputed inside the gate; a mismatch refuses the write. */
export function reviewTokenFor(state) {
  return crypto.createHash('sha256').update(JSON.stringify(stable({
    kind: state.kind, sandboxId: state.sandboxId, currentAgentId: state.currentAgentId, targetAgentId: state.targetAgentId,
    effectiveStrategyId: state.effectiveStrategyId ?? null, profile: state.profile ?? null,
    slotGuidance: state.slotGuidance, slotHeartbeat: state.slotHeartbeat, slotPermissions: state.slotPermissions,
    // The permission change a confirmation would apply (the resolved patch) and the target strategy's option fit it comes from.
    permissionPatch: state.permissionPatch ?? null, optionFit: state.optionFit ?? null,
  }))).digest('hex');
}

/** Differences between a strategy's profile and a slot's current settings, for the prompt-preview drift warning. */
export function profileDriftItems(profile, { slotGuidance, slotHeartbeat }) {
  if (!profile) return [];
  const items = [];
  for (const [key, value] of Object.entries(profile.tradingGuidance || {})) {
    if (slotGuidance[key] !== value) items.push({ area: 'tradingGuidance', key, slot: slotGuidance[key], profile: value });
  }
  if (profile.heartbeat) {
    const view = heartbeatView(slotHeartbeat);
    for (const key of PROFILE_HEARTBEAT_KEYS) {
      if (key in profile.heartbeat && view[key] !== profile.heartbeat[key]) items.push({ area: 'heartbeat', key, slot: view[key], profile: profile.heartbeat[key] });
    }
    if (view.mode !== 'market_aware') items.push({ area: 'heartbeat', key: 'mode', slot: view.mode, profile: 'market_aware' });
    if (view.forceHeartbeatIntervals !== true) items.push({ area: 'heartbeat', key: 'forceHeartbeatIntervals', slot: view.forceHeartbeatIntervals, profile: true });
  }
  return items;
}

export function profileDriftWarning(items, agentName = 'The agent') {
  if (!items.length) return null;
  const list = items.map(item => `${item.key} is ${item.slot} (strategy ${item.profile})`).join(', ');
  return `${agentName}'s strategy settings differ from this slot: ${list}. Re-apply the strategy settings to bring the slot in line, or leave it as it is on purpose`;
}
