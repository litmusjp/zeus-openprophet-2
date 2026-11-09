// One dashboard login check for the whole service. Two logins can be valid at the same time:
//   - the Railway BASIC_AUTH_USER / BASIC_AUTH_PASS pair (backup and release scripts; never delayed), and
//   - the login saved in the app (scrypt hash; verified once, then remembered briefly in memory).
import crypto from 'node:crypto';

const CACHE_MS = 10 * 60 * 1000;
const FREE_FAILURES = 3;       // typos are free; delay starts after this many in a row
const MAX_DELAY_MS = 15000;

const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
function safeEqual(a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); }

export function parseBasicHeader(header) {
  if (typeof header !== 'string' || !header.startsWith('Basic ')) return null;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString(); } catch { return null; }
  const separator = decoded.indexOf(':');
  if (separator < 0) return { user: '', pass: '' };
  return { user: decoded.slice(0, separator), pass: decoded.slice(separator + 1) };
}

/**
 * @param railway   { user, pass } from the Railway variables (may be empty)
 * @param saved     () => { username } | null, the saved login record
 * @param verifySaved (username, password) => boolean (the slow hash check)
 */
export function createLoginVerifier({ railway = {}, saved = () => null, verifySaved = () => false, now = () => Date.now() } = {}) {
  const sessionKey = crypto.randomBytes(32);
  const cache = new Map();      // hmac(header) -> expiry
  const failures = new Map();   // username -> { count, until }
  const hmac = (header) => crypto.createHmac('sha256', sessionKey).update(header).digest('hex');
  const railwayConfigured = Boolean(railway.user && railway.pass);

  function verify(header) {
    const creds = parseBasicHeader(header);
    if (!creds) return { ok: false, source: null };
    // 1) Railway login: constant time, never cached, never delayed.
    if (railwayConfigured) {
      const userOk = safeEqual(creds.user, railway.user);
      const passOk = safeEqual(creds.pass, railway.pass);
      if (userOk && passOk) return { ok: true, source: 'railway' };
    }
    // 2) Saved login.
    const record = saved();
    if (!record || !safeEqual(creds.user, record.username)) return { ok: false, source: null };
    const t = now();
    const key = hmac(header);
    const cachedUntil = cache.get(key);
    if (cachedUntil && cachedUntil > t) return { ok: true, source: 'saved' };
    if (cachedUntil) cache.delete(key);
    const fail = failures.get(record.username);
    if (fail && fail.until > t) return { ok: false, source: null, retryAfterSeconds: Math.ceil((fail.until - t) / 1000) };
    if (verifySaved(creds.user, creds.pass)) {
      failures.delete(record.username);
      cache.set(key, t + CACHE_MS);
      return { ok: true, source: 'saved' };
    }
    const count = (fail?.count || 0) + 1;
    const delay = count > FREE_FAILURES ? Math.min(MAX_DELAY_MS, 1000 * 2 ** (count - FREE_FAILURES - 1)) : 0;
    failures.set(record.username, { count, until: delay ? t + delay : 0 });
    return { ok: false, source: null };
  }

  /** Forget remembered approvals and delays; call whenever the saved login changes. */
  function invalidate() { cache.clear(); failures.clear(); }
  function isConfigured() { return railwayConfigured || Boolean(saved()); }
  return { verify, invalidate, isConfigured, railwayConfigured };
}
