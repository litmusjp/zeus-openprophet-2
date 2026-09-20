// Request-origin helpers kept separate so authentication policy is testable without starting Express.
export function isTrustedLocalRequest(req) {
  const remoteIp = req?.ip || req?.connection?.remoteAddress || '';
  return remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
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
    if (provided === token) return next();
    return res.status(401).json({ error: 'Unauthorized. Set Authorization: Bearer <token> header.' });
  };
}
