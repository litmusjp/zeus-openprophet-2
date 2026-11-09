import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.GEMINI_API_KEY = 'railway-gemini-value-0001';
delete process.env.OPENCODE_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const secrets = await import('../agent/secrets-store.js');
const { createLoginVerifier } = await import('../agent/dashboard-login.js');
const { registerSecretsRoutes, railwayManagedNames } = await import('../agent/secrets-routes.js');
const { createBasicAuthMiddleware } = await import('../agent/auth.js');

const RAILWAY = { user: 'rail', pass: 'railway-pass-9999' };
const SECRET_VALUES = ['gemini-secret-value-AAAA', 'anthropic-secret-value-BBBB', 'brand-new-password-CCCC'];

async function startApp({ fetchImpl, models } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'op2-secrets-routes-'));
  secrets.initSecrets({ filePath: path.join(dir, 'secrets.json'), split: false });
  secrets.applyProviderEnv();
  const verifier = createLoginVerifier({
    railway: RAILWAY,
    saved: () => secrets.getDashboardLogin(),
    verifySaved: (u, p) => secrets.verifySavedPassword(u, p),
  });
  const sent = [];
  const app = express();
  app.use(createBasicAuthMiddleware({ username: RAILWAY.user, password: RAILWAY.pass, apiToken: 'unused', verifier }));
  app.use(express.json());
  const operatorAuth = (req, res, next) => (verifier.verify(req.headers.authorization).ok ? next() : res.status(403).json({ error: 'operator authorization is required' }));
  const sameOrigin = (req, res, next) => (String(req.headers['sec-fetch-site'] || '') === 'cross-site' ? res.status(403).json({ error: 'same-origin request required' }) : next());
  registerSecretsRoutes(app, {
    operatorAuth, sameOrigin, verifier, railway: RAILWAY,
    notify: async text => { sent.push(text); },
    listModels: () => models || [{ id: 'anthropic/claude-x' }, { id: 'anthropic/claude-y' }, { id: 'opencode/free-1' }, { id: 'openai/gpt-x' }],
    fetchImpl: fetchImpl || (async () => ({ status: 200 })),
    env: { ALPHADESK_CONTROL_KEY: 'x', TRADING_BOT_TOKEN: '', BASIC_AUTH_USER: 'u', BASIC_AUTH_PASS: 'p', OTHER: 'y' },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = 'Basic ' + Buffer.from(`${RAILWAY.user}:${RAILWAY.pass}`).toString('base64');
  const call = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { authorization: auth, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    for (const secret of SECRET_VALUES) assert.ok(!text.includes(secret), `response to ${method} ${url} leaked a stored value`);
    return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
  };
  return { call, base, sent, close: () => new Promise(resolve => server.close(resolve)), verifier };
}

test('every secrets route needs the operator login; the status route returns no values', async () => {
  const app = await startApp();
  try {
    const anon = await fetch(app.base + '/api/secrets/status');
    assert.equal(anon.status, 401);
    const wrong = await fetch(app.base + '/api/secrets/status', { headers: { authorization: 'Basic ' + Buffer.from('rail:nope').toString('base64') } });
    assert.equal(wrong.status, 401);
    const status = await app.call('GET', '/api/secrets/status');
    assert.equal(status.status, 200);
    assert.equal(status.body.providers.gemini.source, 'railway');
    assert.equal(status.body.providers.gemini.last4, '0001');
    assert.equal(status.body.providers.anthropic.source, 'unset');
    assert.equal(status.body.dashboardLogin.source, 'railway');
    assert.equal(status.body.dashboardLogin.railwayLoginAlsoValid, true);
    assert.deepEqual(status.body.railwayManaged.map(x => x.name), ['ALPHADESK_CONTROL_KEY', 'BASIC_AUTH_PASS', 'BASIC_AUTH_USER', 'TRADING_BOT_TOKEN']);
    assert.equal(status.body.railwayManaged.find(x => x.name === 'TRADING_BOT_TOKEN').set, false);
    assert.ok(!JSON.stringify(status.body).includes('railway-gemini-value-0001'), 'even the Railway key is shown only as last four');
  } finally { await app.close(); }
});

test('saving, checking and removing a provider key, with Slack notices that carry no value', async () => {
  const app = await startApp();
  try {
    const bad = await app.call('PUT', '/api/secrets/provider/gemini', { value: 'short' });
    assert.equal(bad.status, 400);
    const unknown = await app.call('PUT', '/api/secrets/provider/openai', { value: 'abcdefghijkl' });
    assert.equal(unknown.status, 400);
    const cross = await app.call('PUT', '/api/secrets/provider/gemini', { value: SECRET_VALUES[0] }, { 'sec-fetch-site': 'cross-site' });
    assert.equal(cross.status, 403);

    const saved = await app.call('PUT', '/api/secrets/provider/gemini', { value: SECRET_VALUES[0] });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.status.source, 'saved');
    assert.equal(saved.body.status.last4, 'AAAA');
    assert.equal(process.env.GEMINI_API_KEY, SECRET_VALUES[0]);

    const anth = await app.call('PUT', '/api/secrets/provider/anthropic', { value: SECRET_VALUES[1] });
    assert.equal(anth.status, 200);
    assert.equal(process.env.ANTHROPIC_API_KEY, SECRET_VALUES[1]);
    const listed = await app.call('POST', '/api/secrets/provider/anthropic/check');
    assert.deepEqual({ result: listed.body.result, models: listed.body.models }, { result: 'listed', models: 2 });
    const opencode = await app.call('POST', '/api/secrets/provider/opencode/check');
    assert.equal(opencode.body.result, 'unset');

    const removed = await app.call('DELETE', '/api/secrets/provider/gemini');
    assert.equal(removed.body.status.source, 'railway');
    assert.equal(process.env.GEMINI_API_KEY, 'railway-gemini-value-0001');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(app.sent.length >= 3 && app.sent.every(text => text.startsWith('OpenProphet:')));
    assert.ok(app.sent.every(text => !SECRET_VALUES.some(v => text.includes(v))));
    await app.call('DELETE', '/api/secrets/provider/anthropic');
  } finally { await app.close(); }
});

test('the Gemini check reports valid, rejected or unavailable without printing the key', async () => {
  const seen = [];
  for (const [status, expected] of [[200, 'valid'], [403, 'rejected'], [500, 'unavailable']]) {
    const app = await startApp({ fetchImpl: async (url, init) => { seen.push({ url, header: init.headers['x-goog-api-key'] }); return { status }; } });
    try {
      const r = await app.call('POST', '/api/secrets/provider/gemini/check');
      assert.equal(r.body.result, expected);
    } finally { await app.close(); }
  }
  assert.ok(seen.every(s => !s.url.includes('railway-gemini-value') && s.header === 'railway-gemini-value-0001'), 'the key travels in a header, never in the address');
  const down = await startApp({ fetchImpl: async () => { throw new Error('offline'); } });
  try { assert.equal((await down.call('POST', '/api/secrets/provider/gemini/check')).body.result, 'unavailable'); } finally { await down.close(); }
});

test('changing the dashboard login needs the current password and the new one works alongside the Railway one', async () => {
  const app = await startApp();
  try {
    const base = { username: 'newoperator', newPassword: SECRET_VALUES[2], confirmPassword: SECRET_VALUES[2] };
    assert.equal((await app.call('PUT', '/api/secrets/dashboard-login', { ...base })).status, 403, 'no current password');
    assert.equal((await app.call('PUT', '/api/secrets/dashboard-login', { ...base, currentPassword: 'wrong-current' })).status, 403);
    assert.equal((await app.call('PUT', '/api/secrets/dashboard-login', { ...base, currentPassword: RAILWAY.pass, confirmPassword: 'different-confirm-1' })).status, 400);
    assert.equal((await app.call('PUT', '/api/secrets/dashboard-login', { ...base, currentPassword: RAILWAY.pass, newPassword: 'short', confirmPassword: 'short' })).status, 400);

    const ok = await app.call('PUT', '/api/secrets/dashboard-login', { ...base, currentPassword: RAILWAY.pass });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.source, 'saved');

    const newAuth = 'Basic ' + Buffer.from(`newoperator:${SECRET_VALUES[2]}`).toString('base64');
    const viaSaved = await fetch(app.base + '/api/secrets/status', { headers: { authorization: newAuth } });
    assert.equal(viaSaved.status, 200, 'the saved login opens the dashboard and the operator routes');
    const viaRailway = await app.call('GET', '/api/secrets/status');
    assert.equal(viaRailway.status, 200, 'the Railway login still works');
    assert.equal(viaRailway.body.dashboardLogin.source, 'saved');
    assert.equal(viaRailway.body.dashboardLogin.username, 'newoperator');
    assert.equal((await fetch(app.base + '/api/secrets/status', { headers: { authorization: 'Basic ' + Buffer.from('newoperator:not-the-password').toString('base64') } })).status, 401);

    // the current password may also be the saved one
    const again = await app.call('PUT', '/api/secrets/dashboard-login', { username: 'newoperator', newPassword: 'another-long-password-7', confirmPassword: 'another-long-password-7', currentPassword: SECRET_VALUES[2] });
    assert.equal(again.status, 200);
    assert.equal((await fetch(app.base + '/api/secrets/status', { headers: { authorization: newAuth } })).status, 401, 'the replaced password stops working at once');

    const removed = await app.call('DELETE', '/api/secrets/dashboard-login', { currentPassword: RAILWAY.pass });
    assert.equal(removed.body.source, 'railway');
    assert.equal((await fetch(app.base + '/api/secrets/status', { headers: { authorization: 'Basic ' + Buffer.from('newoperator:another-long-password-7').toString('base64') } })).status, 401);
    assert.equal((await app.call('GET', '/api/secrets/status')).status, 200);
    assert.ok(app.sent.some(t => /dashboard login was changed/.test(t)) && app.sent.some(t => /saved dashboard login was removed/.test(t)));
  } finally { await app.close(); }
});

test('repeated wrong current passwords pause the change route', async () => {
  const app = await startApp();
  try {
    const body = { username: 'operator', newPassword: 'a-long-enough-pass-1', confirmPassword: 'a-long-enough-pass-1' };
    for (let i = 0; i < 5; i++) assert.equal((await app.call('PUT', '/api/secrets/dashboard-login', { ...body, currentPassword: 'wrong' + i })).status, 403);
    const paused = await app.call('PUT', '/api/secrets/dashboard-login', { ...body, currentPassword: RAILWAY.pass });
    assert.equal(paused.status, 429);
    assert.ok(Number(paused.headers.get('retry-after')) >= 1);
  } finally { await app.close(); }
});

test('railwayManagedNames lists only the internal variables, as set or not set', () => {
  assert.deepEqual(railwayManagedNames({ ALPHADESK_CONTROL_KEY: 'x', TRADING_BOT_TOKEN: '', TRADING_BOT_URL: 'u', GEMINI_API_KEY: 'g', PATH: '/bin' }),
    [{ name: 'ALPHADESK_CONTROL_KEY', set: true }, { name: 'TRADING_BOT_TOKEN', set: false }, { name: 'TRADING_BOT_URL', set: true }]);
});
