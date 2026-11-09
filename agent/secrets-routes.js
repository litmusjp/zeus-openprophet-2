// Operator-only routes for the credentials managed in the app. No route ever returns a stored value:
// responses carry a source label, the last four characters and timestamps only.
import crypto from 'node:crypto';
import * as secrets from './secrets-store.js';

const RAILWAY_PREFIXES = ['ALPHADESK_CONTROL_', 'TRADING_BOT_'];
const PASSWORD_WINDOW_MS = 60 * 1000;
const PASSWORD_MAX_WRONG = 5;
const PASSWORD_PAUSE_MS = 30 * 1000;

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameText = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

export function railwayManagedNames(env = process.env) {
  return Object.keys(env)
    .filter(key => RAILWAY_PREFIXES.some(prefix => key.startsWith(prefix)) || key === 'BASIC_AUTH_USER' || key === 'BASIC_AUTH_PASS')
    .sort()
    .map(name => ({ name, set: Boolean(env[name]) }));
}

export function registerSecretsRoutes(app, { operatorAuth, sameOrigin, verifier, railway, notify = async () => {}, listModels = () => [], fetchImpl = globalThis.fetch, env = process.env }) {
  const wrong = { count: 0, windowStart: 0, pausedUntil: 0 };
  const actorOf = (req) => String(req.ip || req.socket?.remoteAddress || 'operator');
  const tell = (text) => { Promise.resolve().then(() => notify(text)).catch(() => {}); };

  // The current password may be the Railway one or the saved one. Wrong guesses pause this route only.
  function currentPasswordOk(candidate) {
    const t = Date.now();
    if (wrong.pausedUntil > t) return { ok: false, pausedSeconds: Math.ceil((wrong.pausedUntil - t) / 1000) };
    if (typeof candidate !== 'string' || !candidate) return { ok: false };
    let ok = false;
    if (railway.pass && sameText(candidate, railway.pass)) ok = true;
    const saved = secrets.getDashboardLogin();
    if (!ok && saved && secrets.verifySavedPassword(saved.username, candidate)) ok = true;
    if (ok) { wrong.count = 0; return { ok: true }; }
    if (t - wrong.windowStart > PASSWORD_WINDOW_MS) { wrong.windowStart = t; wrong.count = 0; }
    wrong.count += 1;
    if (wrong.count >= PASSWORD_MAX_WRONG) { wrong.pausedUntil = t + PASSWORD_PAUSE_MS; wrong.count = 0; }
    return { ok: false };
  }

  app.get('/api/secrets/status', operatorAuth, (req, res) => {
    const saved = secrets.getDashboardLogin();
    res.json({
      providers: secrets.providerStatus(),
      dashboardLogin: {
        source: saved ? 'saved' : 'railway',
        username: saved?.username || null,
        savedAt: saved?.savedAt || null,
        railwayLoginAlsoValid: Boolean(railway.user && railway.pass),
      },
      railwayManaged: railwayManagedNames(env),
      changeLog: secrets.changeLog(10),
      storeReadable: !secrets.isCorrupt(),
    });
  });

  app.put('/api/secrets/provider/:name', operatorAuth, sameOrigin, (req, res) => {
    try {
      const name = req.params.name;
      secrets.setProvider(name, req.body?.value, actorOf(req));
      tell(`OpenProphet: ${secrets.PROVIDERS[name].label} API key saved in the app (value not shown).`);
      res.json({ ok: true, status: secrets.providerStatus()[name] });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/secrets/provider/:name', operatorAuth, sameOrigin, (req, res) => {
    try {
      const name = req.params.name;
      secrets.removeProvider(name, actorOf(req));
      tell(`OpenProphet: saved ${secrets.PROVIDERS[name].label} API key removed; the Railway value (if any) is used again.`);
      res.json({ ok: true, status: secrets.providerStatus()[name] });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.post('/api/secrets/provider/:name/check', operatorAuth, sameOrigin, async (req, res) => {
    try {
      const name = req.params.name;
      const key = secrets.providerValueForCheck(name);
      if (!key) return res.json({ ok: true, result: 'unset' });
      if (name === 'gemini') {
        let status;
        try {
          const r = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(10000) });
          status = r.status;
        } catch { return res.json({ ok: true, result: 'unavailable' }); }
        const result = status === 200 ? 'valid' : [400, 401, 403].includes(status) ? 'rejected' : 'unavailable';
        return res.json({ ok: true, result });
      }
      const models = listModels({ force: true }) || [];
      const prefix = name + '/';
      const count = models.filter(m => String(m?.id || '').startsWith(prefix)).length;
      res.json({ ok: true, result: 'listed', models: count, note: 'The model list was refreshed. This does not prove the provider accepts the key.' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.put('/api/secrets/dashboard-login', operatorAuth, sameOrigin, (req, res) => {
    try {
      const body = req.body || {};
      const check = currentPasswordOk(body.currentPassword);
      if (check.pausedSeconds) { res.setHeader('Retry-After', String(check.pausedSeconds)); return res.status(429).json({ error: 'Too many wrong passwords. Try again shortly.' }); }
      if (!check.ok) return res.status(403).json({ error: 'The current password is not correct' });
      secrets.validateLoginInput({ username: body.username, newPassword: body.newPassword, confirmPassword: body.confirmPassword });
      secrets.setDashboardLogin({ username: body.username, newPassword: body.newPassword }, actorOf(req));
      verifier.invalidate();
      tell('OpenProphet: the dashboard login was changed in the app (password not shown).');
      res.json({ ok: true, source: 'saved', username: body.username, note: 'Sign in again with the new login. The Railway login still works as a backup.' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });

  app.delete('/api/secrets/dashboard-login', operatorAuth, sameOrigin, (req, res) => {
    try {
      const check = currentPasswordOk(req.body?.currentPassword);
      if (check.pausedSeconds) { res.setHeader('Retry-After', String(check.pausedSeconds)); return res.status(429).json({ error: 'Too many wrong passwords. Try again shortly.' }); }
      if (!check.ok) return res.status(403).json({ error: 'The current password is not correct' });
      secrets.removeDashboardLogin(actorOf(req));
      verifier.invalidate();
      tell('OpenProphet: the saved dashboard login was removed; only the Railway login is valid now.');
      res.json({ ok: true, source: 'railway' });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
}
