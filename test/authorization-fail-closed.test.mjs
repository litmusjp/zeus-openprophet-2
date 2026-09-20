import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMiddleware, markBasicAuthContext, resolveApiAuthToken } from '../agent/auth.js';
import { enforcePermissions } from '../mcp-permission-guard.js';

function responseDouble() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test('agent API auth rejects missing token, including non-health routes', () => {
  const middleware = createAuthMiddleware({ token: '' });
  const res = responseDouble();
  let called = false;
  middleware({ path: '/permissions', headers: {} }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
});

test('agent API auth rejects wrong token', () => {
  const middleware = createAuthMiddleware({ token: 'expected' });
  const res = responseDouble();
  let called = false;
  middleware({ path: '/permissions', headers: { authorization: 'Bearer wrong' } }, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 401);
});

test('agent API auth accepts valid token', () => {
  const middleware = createAuthMiddleware({ token: 'expected' });
  const res = responseDouble();
  let called = false;
  middleware({ path: '/permissions', headers: { authorization: 'Bearer expected' } }, res, () => { called = true; });
  assert.equal(called, true);
});

test('agent API auth accepts a request marked by the server Basic Auth middleware', () => {
  const middleware = createAuthMiddleware({ token: 'expected' });
  const req = { path: '/accounts', headers: {} };
  markBasicAuthContext(req);
  const res = responseDouble();
  let called = false;

  middleware(req, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('public API requests remain rejected without a bearer token or Basic Auth context', () => {
  const middleware = createAuthMiddleware({ token: 'expected' });
  const res = responseDouble();

  middleware({ path: '/accounts', headers: {} }, res, () => assert.fail('public request was accepted'));

  assert.equal(res.statusCode, 401);
});

test('wrong bearer tokens remain rejected even without Basic Auth context', () => {
  const middleware = createAuthMiddleware({ token: 'expected' });
  const res = responseDouble();

  middleware({ path: '/accounts', headers: { authorization: 'Bearer wrong' } }, res, () => assert.fail('wrong token was accepted'));

  assert.equal(res.statusCode, 401);
});

test('paper/default startup authenticates API with the generated server-owned token', () => {
  const token = resolveApiAuthToken({ executionEnabled: true, agentToken: '', serverToken: 'ephemeral-server-token' });
  const middleware = createAuthMiddleware({ token });
  const res = responseDouble();
  let called = false;

  middleware({ path: '/accounts', headers: { authorization: 'Bearer ephemeral-server-token' } }, res, () => { called = true; });

  assert.equal(called, true);
  assert.equal(res.statusCode, null);
});

test('configured agent API token takes precedence over the server-owned token', () => {
  assert.equal(
    resolveApiAuthToken({ executionEnabled: true, agentToken: 'configured-agent-token', serverToken: 'server-token' }),
    'configured-agent-token',
  );
});

test('inert startup does not make the server-owned token an API credential', () => {
  assert.equal(resolveApiAuthToken({ executionEnabled: false, agentToken: '', serverToken: 'server-token' }), '');
});

test('inert API auth remains fail-closed even for a marked request', () => {
  const middleware = createAuthMiddleware({ token: '' });
  const req = { path: '/accounts', headers: {} };
  markBasicAuthContext(req);
  const res = responseDouble();

  middleware(req, res, () => assert.fail('inert request was accepted'));

  assert.equal(res.statusCode, 503);
});

test('agent API auth allows only the documented health exception', () => {
  const middleware = createAuthMiddleware({ token: '' });
  const res = responseDouble();
  let called = false;
  middleware({ path: '/health', headers: {} }, res, () => { called = true; });
  assert.equal(called, true);
});

test('MCP rejects unreachable permission verification for order and non-order tools', async () => {
  const getPermissions = async () => { throw new Error('unreachable'); };
  for (const toolName of ['place_order', 'get_account']) {
    await assert.rejects(
      enforcePermissions({ toolName, args: {}, enabled: true, authToken: 'agent-token', getPermissions }),
      /permission verification unavailable/,
    );
  }
});

test('MCP rejects missing verifier token in enabled mode without making a request', async () => {
  let requested = false;
  await assert.rejects(
    enforcePermissions({
      toolName: 'get_account', args: {}, enabled: true, authToken: '',
      getPermissions: async () => { requested = true; return {}; },
    }),
    /agent auth token is unavailable/,
  );
  assert.equal(requested, false);
});

test('MCP inert mode reports unavailable rather than granting permission', async () => {
  await assert.rejects(
    enforcePermissions({ toolName: 'get_account', args: {}, enabled: false, authToken: '', getPermissions: async () => ({}) }),
    /permission verification unavailable in inert mode/,
  );
});
