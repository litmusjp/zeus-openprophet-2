// Operator authorization and same-origin middleware, and the slot-writer guards built on them (switch-profile plan 3.6).
// Extracted from server.js unchanged so the request-level tests run the production middleware.

/** Refuses a cross-site or foreign-origin state-changing request (403). */
export function sameOriginStateChange(req, res, next) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'cross-site') return res.status(403).json({ error: 'same-origin request required' });
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'same-origin request required' }); }
    catch { return res.status(403).json({ error: 'same-origin request required' }); }
  }
  next();
}

/** Operator authorization: the operator token header, or a valid dashboard login (`loginVerifier.verify(authorizationHeader).ok`). */
export function createOperatorAuth({ loginVerifier, operatorToken = () => process.env.OPERATOR_TOKEN || '' }) {
  return function operatorAuthMiddleware(req, res, next) {
    const configuredOperatorToken = operatorToken();
    const providedOperatorToken = req.headers['x-openprophet-operator-token'];
    if (configuredOperatorToken && providedOperatorToken === configuredOperatorToken) return next();
    if (loginVerifier.verify(req.headers.authorization).ok === true) return next();
    return res.status(loginVerifier.isConfigured() || configuredOperatorToken ? 403 : 503).json({ error: 'operator authorization is required' });
  };
}

/**
 * The guards in front of the routes that change a slot's agent or profile.
 *  protectChatGPTModelChange        an openai/ model (body.model, the assigned agent's model, or the activated agent's) needs operator auth + same origin
 *  operatorOnly                     operator auth + same origin for every provider
 *  requireOperatorForAgentChange    operatorOnly when the request changes the slot's agent
 *  requireOperatorForSlotProfile    operatorOnly when the body carries a slotProfile
 */
export function createSlotGuards({ operatorAuth, getAgentById, getSandbox }) {
  const operatorOnly = (req, res, next) => operatorAuth(req, res, () => sameOriginStateChange(req, res, next));
  function protectChatGPTModelChange(req, res, next) {
    const assignedModel = req.body?.activeAgentId ? getAgentById(req.body.activeAgentId)?.model : '';
    const routeAgentModel = req.path.endsWith('/activate') && req.path.includes('/agents/') ? getAgentById(req.params.id)?.model : '';
    if (!String(req.body?.model || assignedModel || routeAgentModel || '').startsWith('openai/')) return next();
    operatorOnly(req, res, next);
  }
  function requireOperatorForAgentChange(req, res, next) {
    const target = req.body?.activeAgentId;
    if (target === undefined || target === getSandbox(req.params.id)?.agent?.activeAgentId) return next();
    operatorOnly(req, res, next);
  }
  function requireOperatorForSlotProfile(req, res, next) {
    if (req.body && typeof req.body === 'object' && Object.prototype.hasOwnProperty.call(req.body, 'slotProfile')) return operatorOnly(req, res, next);
    next();
  }
  return { operatorOnly, protectChatGPTModelChange, requireOperatorForAgentChange, requireOperatorForSlotProfile };
}
