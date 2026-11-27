// Preview, review token and the slot-profile routes (switch-profile plan 3.6). The preview is a pure read: it never saves, pushes a cap,
// creates or starts a backend, or refreshes an execution-capable harness. Execution (switch and re-apply) recomputes the same review
// inside the transition gate and refuses with 409 plus a fresh preview when the token no longer matches.
import { getSandbox, getAgentById, getStrategyById, getResolvedAgentForSandbox, previewSwitchPermissionPatch, effectiveStrategyIdForSwitch, applySlotProfileToSandbox } from './config-store.js';
import { getTradingGuidanceForSandbox } from './trading-guidance.js';
import { optionExposureReason, SWITCH_REFUSAL_PREFIX } from './switch-guard.js';
import { planProfileApplication, profileOfStrategy, reviewTokenFor } from './slot-profile.js';
import { SlotTransitionError } from './slot-transition.js';
import { slotGate, TRANSITION_BUSY_MESSAGE } from './slot-gate.js';
import { redactSecrets } from './redaction.js';

export const BUSY_TURN_MESSAGE = 'Wait for the active agent turn to finish before changing its model or assignment';
const pick = (object, keys) => Object.fromEntries(keys.map(key => [key, object?.[key]]));

/** The unprofiled-agent notice (plan 3.7), shown in the preview and repeated in the response. */
export const unprofiledWarning = name => `${name} has no slot profile: this slot keeps its current Trading Guidance and heartbeat intervals, and the agent is not guaranteed ready until they are checked.`;

/** Builds the review of a switch or re-apply from the CURRENT state (sync, no I/O). Returns { preview, plan, permissionPatch, profile, agentName }. */
export function buildSlotReview({ kind, sandboxId, activeAgentId, strategyId }) {
  if (kind !== 'switch' && kind !== 'reapply') throw new SlotTransitionError(400, { error: 'kind must be switch or reapply' });
  const sandbox = getSandbox(sandboxId);
  if (!sandbox) throw new SlotTransitionError(404, { error: 'Sandbox not found' });
  const currentAgentId = sandbox.agent.activeAgentId;
  const errors = [];
  const warnings = [];
  let targetAgentId = currentAgentId;
  let effectiveStrategyId = null;
  let permissionPatch = null;
  let agentChange = false;
  if (kind === 'reapply') {
    if (activeAgentId && activeAgentId !== currentAgentId) errors.push(`This slot is now assigned to ${currentAgentId}, not ${activeAgentId}; review again`);
    effectiveStrategyId = getResolvedAgentForSandbox(sandboxId)?.strategyId ?? null;
  } else {
    if (!activeAgentId || !getAgentById(activeAgentId)) throw new SlotTransitionError(404, { error: 'Agent not found' });
    targetAgentId = activeAgentId;
    agentChange = activeAgentId !== currentAgentId;
    try {
      effectiveStrategyId = effectiveStrategyIdForSwitch(sandboxId, activeAgentId, strategyId);
      if (agentChange) permissionPatch = previewSwitchPermissionPatch(sandboxId, activeAgentId, { strategyId });
    } catch (error) { errors.push(error.message); }
    if (!agentChange) warnings.push('The agent is not changing: no slot profile is applied.');
  }
  const strategy = effectiveStrategyId ? getStrategyById(effectiveStrategyId) : null;
  if (effectiveStrategyId && !strategy) warnings.push(`Strategy ${effectiveStrategyId} was not found, so no slot profile can apply`);
  const profile = kind === 'switch' && !agentChange ? null : profileOfStrategy(strategy);
  const agentName = getAgentById(targetAgentId)?.name || targetAgentId;
  const slotGuidance = getTradingGuidanceForSandbox(sandboxId);
  const slotHeartbeat = { ...(sandbox.heartbeat || {}) };
  const slotPermissions = { ...(sandbox.permissions || {}) };
  const plan = planProfileApplication(profile, { slotGuidance, slotHeartbeat });
  errors.push(...plan.errors);
  if (!profile) {
    if (kind === 'reapply') errors.push('This slot\'s effective strategy has no slot profile, so there is nothing to apply');
    else if (agentChange) warnings.push(unprofiledWarning(agentName));
  }
  const permissionKeys = permissionPatch ? Object.keys(permissionPatch) : [];
  const preview = {
    kind, sandboxId, currentAgentId, targetAgentId, effectiveStrategyId,
    hasProfile: Boolean(profile),
    changes: {
      permissions: permissionPatch ? { before: pick(slotPermissions, permissionKeys), after: { ...pick(slotPermissions, permissionKeys), ...permissionPatch } } : null,
      tradingGuidance: plan.guidance ? plan.guidance.changes : [],
      heartbeat: plan.heartbeat?.changed ? { before: plan.heartbeat.before, after: plan.heartbeat.after } : null,
    },
    errors, warnings,
    exposure: 'unavailable',
    reviewToken: reviewTokenFor({ kind, sandboxId, currentAgentId, targetAgentId, effectiveStrategyId, profile, slotGuidance, slotHeartbeat, slotPermissions }),
  };
  return { preview, plan, permissionPatch, profile, agentName };
}

/** Adds the exposure read to a review's preview, from an EXISTING backend only (`readExposureExisting` returns null when none can answer). */
export async function previewWithExposure(review, sandboxId, readExposureExisting) {
  const { preview, permissionPatch } = review;
  if (!permissionPatch || permissionPatch.allowOptions !== false) { preview.exposure = { required: false, reason: null }; return preview; }
  try {
    const data = typeof readExposureExisting === 'function' ? await readExposureExisting(sandboxId) : null;
    if (!data) throw new Error('no running backend');
    const reason = optionExposureReason(data);
    preview.exposure = { required: true, reason: reason || null };
    if (reason) preview.errors.push(`${SWITCH_REFUSAL_PREFIX}${reason}.`);
  } catch {
    preview.exposure = 'unavailable';
    preview.warnings.push('Option exposure could not be read now (no running backend answered); it is checked again when you confirm.');
  }
  return preview;
}

/**
 * The transition a route hands to the store. `plan()` runs synchronously inside the store's write, right before anything is staged:
 * it recomputes the review from current state and refuses (409 + fresh preview) on a missing or stale token. `opId` is the gate ticket's.
 */
export function createTransition({ kind, sandboxId, activeAgentId, strategyId, reviewToken, opId }) {
  const transition = {
    opId, kind, lastReview: null,
    verify() {
      const review = buildSlotReview({ kind, sandboxId, activeAgentId, strategyId });
      if (!reviewToken) throw new SlotTransitionError(409, { error: 'A review token is required: open the switch preview first', preview: review.preview });
      if (reviewToken !== review.preview.reviewToken) throw new SlotTransitionError(409, { error: 'The slot or the strategy settings changed since the preview; review the new preview', preview: review.preview });
      if (review.preview.errors.length) throw new SlotTransitionError(400, { ok: false, committed: false, error: review.preview.errors[0], errors: review.preview.errors });
      transition.lastReview = review;
      return review;
    },
    plan() {
      const review = transition.verify();
      return { guidance: review.plan.guidance, heartbeat: review.plan.heartbeat };
    },
    applied() {
      const review = transition.lastReview;
      if (!review) return { permissions: null, tradingGuidance: [], heartbeat: null };
      return { permissions: review.preview.changes.permissions, tradingGuidance: review.preview.changes.tradingGuidance, heartbeat: review.preview.changes.heartbeat };
    },
    warnings() { return transition.lastReview?.preview.warnings || []; },
  };
  return transition;
}

/** Takes the slot's transition gate or throws the 409 every competing writer gets. */
export function acquireSlotOrRefuse(sandboxId, kind) {
  const ticket = slotGate.acquire(sandboxId, kind);
  if (ticket) return ticket;
  const block = slotGate.blocked(sandboxId);
  throw new SlotTransitionError(409, { error: block ? `slot settings transition blocked: ${block.reason}` : TRANSITION_BUSY_MESSAGE });
}

/** For an ordinary same-slot writer route: holds the gate for the whole request (409 while a transition or another writer holds it). */
export function slotWriterGuard(sandboxIdOf) {
  return async (req, res, next) => {
    const sandboxId = sandboxIdOf(req);
    if (!sandboxId) return next();
    let ticket;
    try { ticket = acquireSlotOrRefuse(sandboxId, 'write'); } catch (error) { return res.status(error.status || 409).json(error.body || { error: error.message }); }
    let done = false;
    const release = () => { if (!done) { done = true; ticket.release(); } };
    res.on('finish', release);
    res.on('close', release);
    next();
  };
}

/** After the settings committed: restart/refresh. A failure is reported as committed-but-not-ready and keeps beats refused. Returns null or the error to send. */
export async function finishCommittedRuntime(sandboxId, steps) {
  try {
    for (const step of steps) await step();
    return null;
  } catch (error) {
    slotGate.markNotReady(sandboxId, error.message);
    return new SlotTransitionError(500, { ok: false, committed: true, ready: false, error: `Settings saved; the agent has not restarted (${error.message}). Stop the slot, or start it again, once the cause is fixed` });
  }
}

export function successBody(transition, extra = {}) {
  return { ok: true, committed: true, ready: true, applied: transition.applied(), warnings: transition.warnings(), ...extra };
}

/**
 * GET /api/sandboxes/:id/agent/switch-preview and POST /api/sandboxes/:id/agent/apply-profile.
 * deps: operatorAuth, sameOrigin (middleware), isBusy(sandboxId), readExposureExisting(sandboxId), refresh(sandboxId), afterChange(sandboxId)
 */
export function registerSlotProfileRoutes(app, deps) {
  app.get('/api/sandboxes/:id/agent/switch-preview', async (req, res) => {
    try {
      const kind = req.query.kind === undefined ? 'switch' : String(req.query.kind);
      const strategyId = req.query.strategyId === undefined ? undefined : (String(req.query.strategyId).trim() || null);
      const review = buildSlotReview({ kind, sandboxId: req.params.id, activeAgentId: req.query.activeAgentId ? String(req.query.activeAgentId) : undefined, strategyId });
      res.json(await previewWithExposure(review, req.params.id, deps.readExposureExisting));
    } catch (error) { res.status(error.status || 400).json(error.body || { error: error.message }); }
  });

  app.post('/api/sandboxes/:id/agent/apply-profile', deps.operatorAuth, deps.sameOrigin, async (req, res) => {
    const sandboxId = req.params.id;
    let ticket = null;
    try {
      if (!getSandbox(sandboxId)) return res.status(404).json({ error: 'Sandbox not found' });
      ticket = acquireSlotOrRefuse(sandboxId, 'reapply');
      if (deps.isBusy(sandboxId)) throw new SlotTransitionError(409, { error: BUSY_TURN_MESSAGE });
      const transition = createTransition({ kind: 'reapply', sandboxId, activeAgentId: req.body?.activeAgentId, reviewToken: req.body?.reviewToken, opId: ticket.opId });
      transition.verify();
      const { sandbox } = await applySlotProfileToSandbox(sandboxId, transition);
      const failure = await finishCommittedRuntime(sandboxId, [() => deps.refresh(sandboxId)]);
      if (failure) return res.status(failure.status).json(failure.body);
      if (deps.afterChange) deps.afterChange(sandboxId);
      res.json(successBody(transition, { sandboxId, sandbox: redactSecrets(sandbox) }));
    } catch (error) { res.status(error.status || 400).json(error.body || { error: error.message }); } finally { ticket?.release(); }
  });
}
