// Request-origin helpers kept separate so authentication policy is testable without starting Express.
export function isTrustedLocalRequest(req) {
  const remoteIp = req?.ip || req?.connection?.remoteAddress || '';
  return remoteIp === '127.0.0.1' || remoteIp === '::1' || remoteIp === '::ffff:127.0.0.1';
}
