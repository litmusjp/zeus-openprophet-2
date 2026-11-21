import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { spreadLegsRequest } from '../spread-legs.js';
import { callMcpTool } from './nov17-support.mjs';

// Phase C, Step 4: the optional two-leg `legs` branch of place_options_order. Single-leg calls must stay exactly as before.

const LOW = 'AAPL261218C00200000';
const HIGH = 'AAPL261218C00210000';
const openArgs = () => ({
  client_order_id: 'grp-tool-1', symbol: LOW, underlying: 'AAPL', quantity: 2, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 3,
  legs: [
    { symbol: LOW, side: 'buy', position_intent: 'buy_to_open', price: 5.5 },
    { symbol: HIGH, side: 'sell', position_intent: 'sell_to_open', price: 2.5 },
  ],
});
const closeArgs = () => ({
  client_order_id: 'grp-tool-1-close', symbol: LOW, underlying: 'AAPL', quantity: 2, side: 'sell', position_intent: 'sell_to_close', order_type: 'limit', limit_price: 4,
  legs: [
    { symbol: LOW, side: 'sell', position_intent: 'sell_to_close', price: 6 },
    { symbol: HIGH, side: 'buy', position_intent: 'buy_to_close', price: 2 },
  ],
});

test('a valid opening spread is a debit and a valid closing spread is a credit, with ratio 1 legs', () => {
  const opened = spreadLegsRequest(openArgs());
  assert.equal(opened.error, undefined);
  assert.equal(opened.priceKind, 'debit');
  assert.equal(opened.opening, true);
  assert.deepEqual(opened.legs.map(leg => leg.ratio_qty), [1, 1]);
  const closed = spreadLegsRequest(closeArgs());
  assert.equal(closed.priceKind, 'credit');
  assert.equal(closed.opening, false);
});

test('anything that can never be a valid vertical is refused before the backend', () => {
  const mutate = (fn, source = openArgs) => { const a = source(); fn(a); return spreadLegsRequest(a).error; };
  const cases = {
    'one leg': mutate(a => { a.legs = [a.legs[0]]; }),
    'three legs': mutate(a => { a.legs = [...a.legs, a.legs[0]]; }),
    'not an array': mutate(a => { a.legs = 'x'; }),
    'ratio two': mutate(a => { a.legs[1].ratio_qty = 2; }),
    'no leg price': mutate(a => { delete a.legs[0].price; }),
    'zero leg price': mutate(a => { a.legs[0].price = 0; }),
    'intent and side disagree': mutate(a => { a.legs[0].position_intent = 'sell_to_open'; }),
    'mixed open and close': mutate(a => { a.legs[1].position_intent = 'buy_to_close'; a.legs[1].side = 'buy'; }),
    'same side on both legs': mutate(a => { a.legs[1].side = 'buy'; a.legs[1].position_intent = 'buy_to_open'; }),
    'parent symbol is not legs[0]': mutate(a => { a.symbol = HIGH; }),
    'parent side is not legs[0]': mutate(a => { a.side = 'sell'; }),
    'market order': mutate(a => { a.order_type = 'market'; }),
    'no net price': mutate(a => { delete a.limit_price; }),
    'negative net price': mutate(a => { a.limit_price = -1; }),
  };
  for (const [name, error] of Object.entries(cases)) assert.equal(typeof error, 'string', `${name} must be refused`);
});

async function captureBackend() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && url.pathname === '/api/permissions') return send(200, { allowPaperTrading: true, allowOptions: true, allowStocks: true, requireConfirmation: false, maxOrderValue: 100000 });
      if (req.method === 'GET' && url.pathname === '/api/option-spread-cap/sync') return send(200, { state: 'not_applicable' });
      if (req.method === 'POST' && url.pathname.endsWith('/options/order')) { bodies.push(JSON.parse(raw)); return send(200, { status: 'accepted', client_order_id: bodies.at(-1).client_order_id, filled_qty: 0, execution_confirmed: false }); }
      return send(404, { error: 'not found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise(resolve => server.close(resolve)) };
}

test('end to end: a spread sends its legs and price kind; a single-leg call sends neither', async () => {
  const backend = await captureBackend();
  try {
    const opened = await callMcpTool(backend.url, 'place_options_order', openArgs());
    assert.equal(opened.isError, false, opened.text);
    const body = backend.bodies[0];
    assert.equal(body.price_kind, 'debit');
    assert.equal(body.qty, 2);
    assert.equal(body.limit_price, 3);
    assert.deepEqual(body.option_legs.map(leg => [leg.symbol, leg.side, leg.position_intent, leg.ratio_qty, leg.price]), [[LOW, 'buy', 'buy_to_open', 1, 5.5], [HIGH, 'sell', 'sell_to_open', 1, 2.5]]);

    const closed = await callMcpTool(backend.url, 'place_options_order', closeArgs());
    assert.equal(closed.isError, false, closed.text);
    assert.equal(backend.bodies[1].price_kind, 'credit');

    const single = await callMcpTool(backend.url, 'place_options_order', { client_order_id: 'single-1', symbol: LOW, underlying: 'AAPL', quantity: 1, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 5.5 });
    assert.equal(single.isError, false, single.text);
    const singleBody = backend.bodies[2];
    assert.equal('option_legs' in singleBody, false, 'a single-leg call must not carry legs');
    assert.equal('price_kind' in singleBody, false, 'a single-leg call must not carry a price kind');
    assert.deepEqual(Object.keys(singleBody).sort(), ['client_order_id', 'limit_price', 'position_intent', 'qty', 'side', 'symbol', 'type', 'underlying']);
  } finally { await backend.close(); }
});

test('end to end: an invalid spread never reaches the backend', async () => {
  const backend = await captureBackend();
  try {
    const args = openArgs();
    args.legs[1].ratio_qty = 2;
    const refused = await callMcpTool(backend.url, 'place_options_order', args);
    assert.equal(refused.isError, true);
    assert.match(refused.text, /ratio_qty must be 1/);
    assert.equal(backend.bodies.length, 0);
  } finally { await backend.close(); }
});

test('the single-leg schema is unchanged: the required list is the same and legs is optional', () => {
  const source = fs.readFileSync(fileURLToPath(new URL('../mcp-server.js', import.meta.url)), 'utf8');
  assert.match(source, /required: \['client_order_id', 'symbol', 'underlying', 'quantity', 'side', 'position_intent', 'order_type'\],\r?\n\s+\},\r?\n\s+\},\r?\n\s+\{\r?\n\s+name: 'withdraw_planned_intent'/);
  assert.match(source, /Never simulate a spread with sequential single-leg orders\./);
  assert.doesNotMatch(source, /Agent tool does not expose atomic multi-leg execution/);
});
