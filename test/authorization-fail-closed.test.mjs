import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthMiddleware } from '../agent/auth.js';
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
