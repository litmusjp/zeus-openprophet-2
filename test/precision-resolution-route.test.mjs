import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { registerPrecisionResolutionRoute } from '../agent/precision-resolution-route.js';

async function start({ sandboxes = ['sbx_a'], client, ready = true, token = 'operator-secret', operatorOk = true, sameOriginOk = true } = {}) {
  const app = express();
  app.use(express.json());
  registerPrecisionResolutionRoute(app, {
    operatorAuth: (req, res, next) => (operatorOk ? next() : res.status(403).json({ error: 'operator authorization is required' })),
    sameOrigin: (req, res, next) => (sameOriginOk ? next() : res.status(403).json({ error: 'same-origin request required' })),
    getSandbox: id => (sandboxes.includes(id) ? { id } : null),
    getClient: () => client,
    isReady: () => ready,
    operatorToken: () => token,
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (sandbox, body) => fetch(`${base}/api/sandboxes/${sandbox}/orders/resolve-precision-rejection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { post, close: () => new Promise(resolve => server.close(resolve)) };
}

test('the route forwards the exact client_order_id and the operator token, and returns the backend answer unchanged', async t => {
  const calls = [];
  const client = { post: async (...args) => { calls.push(args); return { status: 200, data: { status: 'rejected', client_order_id: 'ge-1' } }; } };
  const app = await start({ client });
  t.after(app.close);
  const res = await app.post('sbx_a', { client_order_id: '  ge-1  ' });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'rejected', client_order_id: 'ge-1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/v1/orders/resolve-precision-rejection');
  assert.deepEqual(calls[0][1], { client_order_id: 'ge-1' });
  assert.equal(calls[0][2].headers['X-OpenProphet-Operator-Token'], 'operator-secret');
});

test('a refusal from the backend keeps its status and body', async t => {
  const client = { post: async () => ({ status: 409, data: { status: 'refused', error: 'precision rejection resolution refused: a filled quantity is recorded' } }) };
  const app = await start({ client });
  t.after(app.close);
  const res = await app.post('sbx_a', { client_order_id: 'x' });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).status, 'refused');
});

test('unknown sandbox, bad input, a stopped backend or a missing token never reach the backend', async t => {
  let calls = 0;
  const client = { post: async () => { calls += 1; return { status: 200, data: {} }; } };
  const a = await start({ client });
  t.after(a.close);
  assert.equal((await a.post('sbx_missing', { client_order_id: 'x' })).status, 404);
  assert.equal((await a.post('sbx_a', {})).status, 400);
  assert.equal((await a.post('sbx_a', { client_order_id: '   ' })).status, 400);
  assert.equal((await a.post('sbx_a', { client_order_id: 'x'.repeat(129) })).status, 400);
  const stopped = await start({ client, ready: false });
  t.after(stopped.close);
  assert.equal((await stopped.post('sbx_a', { client_order_id: 'x' })).status, 503);
  const noToken = await start({ client, token: '' });
  t.after(noToken.close);
  assert.equal((await noToken.post('sbx_a', { client_order_id: 'x' })).status, 503);
  assert.equal(calls, 0);
});

test('operator login and same-origin checks run first', async t => {
  let calls = 0;
  const client = { post: async () => { calls += 1; return { status: 200, data: {} }; } };
  const noOperator = await start({ client, operatorOk: false });
  t.after(noOperator.close);
  assert.equal((await noOperator.post('sbx_a', { client_order_id: 'x' })).status, 403);
  const crossSite = await start({ client, sameOriginOk: false });
  t.after(crossSite.close);
  assert.equal((await crossSite.post('sbx_a', { client_order_id: 'x' })).status, 403);
  assert.equal(calls, 0);
});

test('a backend failure becomes a plain 502 without details', async t => {
  const client = { post: async () => { throw new Error('connect ECONNREFUSED with secret detail'); } };
  const app = await start({ client });
  t.after(app.close);
  const res = await app.post('sbx_a', { client_order_id: 'x' });
  assert.equal(res.status, 502);
  assert.equal(JSON.stringify(await res.json()).includes('secret'), false);
});
