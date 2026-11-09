import crypto from 'node:crypto';
// Request-origin helpers kept separate so authentication policy is testable without starting Express.
export function isTrustedLocalRequest(req) {
  const remoteIp = req?.ip || req?.connection?.remoteAddress || '';
  return remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
}

const BASIC_AUTH_CONTEXT = Symbol('openprophet.basic-authenticated');

// Only the server's Basic Auth middleware may set this request-local context.
// It is deliberately not derived from headers, query parameters, or source IP.
function markBasicAuthContext(req) {
  Object.defineProperty(req, BASIC_AUTH_CONTEXT, { value: true });
}

// Management routes must rely on proof from the actual Basic middleware. A
// generic API bearer (including a loopback request) is not operator authority.
export function hasBasicAuthContext(req) {
  return req?.[BASIC_AUTH_CONTEXT] === true;
}

export function createBasicOperatorOnlyMiddleware() {
  return function basicOperatorOnly(req, res, next) {
    if (hasBasicAuthContext(req)) return next();
    return res.status(403).json({ error: 'operator authorization is required' });
  };
}

// The agent API may use a dedicated token when configured. Otherwise, the
// server-owned broker token is also the authenticated credential for its API.
// Resolve this at server construction time, after startup has minted any
// ephemeral token, rather than capturing process.env during module import.
export function resolveApiAuthToken({ executionEnabled, agentToken = '', serverToken = '' }) {
  return executionEnabled ? (agentToken || serverToken || '') : '';
}

// The outer dashboard boundary may admit only an exact server-owned bearer
// credential for an API path. The mounted API middleware remains authoritative.
export function isValidApiBearerRequest({ req, token }) {
  const requestPath = req?.path || '';
  const isApiPath = requestPath === '/api' || requestPath.startsWith('/api/');
  const authorization = req?.headers?.authorization;
  return Boolean(token) && isApiPath && authorization === `Bearer ${token}`;
}

export function createBasicAuthMiddleware({ username, password, apiToken, verifier = null }) {
  // With a verifier (the service), the Railway login and a login saved in the app are both checked by one
  // shared function. Without one (older callers and tests), the single username/password pair is used.
  const isConfigured = verifier ? () => verifier.isConfigured() : () => Boolean(username && password);
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const sameText = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));

  return function basicAuthMiddleware(req, res, next) {
    if (isValidApiBearerRequest({ req, token: apiToken })) return next();
    if (!isConfigured()) return res.status(503).send('Basic authentication is not configured.');

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
      res.setHeader('WWW-Authenticate', 'Basic realm="OpenProphet Dashboard"');
      return res.status(401).send('Authentication required.');
    }

    if (verifier) {
      const result = verifier.verify(authHeader);
      if (result.ok) {
        markBasicAuthContext(req);
        return next();
      }
      if (result.retryAfterSeconds) {
        res.setHeader('Retry-After', String(result.retryAfterSeconds));
        return res.status(429).send('Too many attempts. Try again shortly.');
      }
      res.setHeader('WWW-Authenticate', 'Basic realm="OpenProphet Dashboard"');
      return res.status(401).send('Access denied.');
    }

    let credentials;
    try {
      credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
    } catch {
      res.setHeader('WWW-Authenticate', 'Basic realm="OpenProphet Dashboard"');
      return res.status(401).send('Authentication required.');
    }
    const separator = credentials.indexOf(':');
    const user = separator >= 0 ? credentials.slice(0, separator) : '';
    const pass = separator >= 0 ? credentials.slice(separator + 1) : '';

    if (sameText(user, username) && sameText(pass, password)) {
      markBasicAuthContext(req);
      return next();
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="OpenProphet Dashboard"');
    return res.status(401).send('Access denied.');
  };
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
