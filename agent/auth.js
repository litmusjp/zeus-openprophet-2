// Request-origin helpers kept separate so authentication policy is testable without starting Express.
export function isTrustedLocalRequest(req) {
  const remoteIp = req?.ip || req?.connection?.remoteAddress || '';
  return remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
}

const BASIC_AUTH_CONTEXT = Symbol('openprophet.basic-authenticated');

// Only the server's Basic Auth middleware may set this request-local context.
// It is deliberately not derived from headers, query parameters, or source IP.
export function markBasicAuthContext(req) {
  Object.defineProperty(req, BASIC_AUTH_CONTEXT, { value: true });
}

// The agent API may use a dedicated token when configured. Otherwise, the
// server-owned broker token is also the authenticated credential for its API.
// Resolve this at server construction time, after startup has minted any
// ephemeral token, rather than capturing process.env during module import.
export function resolveApiAuthToken({ executionEnabled, agentToken = '', serverToken = '' }) {
  return executionEnabled ? (agentToken || serverToken || '') : '';
}

export function createAuthMiddleware({ token }) {
  return function authMiddleware(req, res, next) {
    // Health is the sole unauthenticated readiness exception. When mounted at
    // /api, Express exposes this path as /health to the middleware.
    if (req.path === '/health') return next();
    if (!token) {
      return res.status(503).json({ error: 'API authentication is unavailable.' });
    }

    const header = req.headers.authorization;
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (provided === token || req[BASIC_AUTH_CONTEXT] === true) return next();
    return res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <token> header.' });
  };
}
