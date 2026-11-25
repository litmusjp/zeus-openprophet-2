import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { callMcpTool } from './nov17-support.mjs';
import { auditExit, exitAuditNote, occDirection, sanitizeExitEvidence, withExitAudit, SUPPORTED_RULE_BASIS } from '../exit-audit.js';

// Nov 26 W1 (Hermes plan review): a warning-only arithmetic check of the numbers an agent cites when it sells to close. It never changes, delays or
// blocks an order, never alters the broker payload or receipt, and adds nothing to a call that carries no exit_evidence.

const CALL = 'WMT261218C00125000';
const PUT = 'NVDA261218P00158000';
const ev = (extra = {}) => ({
  exit_kind: 'trail', rule_basis: SUPPORTED_RULE_BASIS, trigger_level: 125.3,
  trigger_bar_start: '2026-11-25T15:35:00Z', trigger_bar_end: '2026-11-25T15:40:00Z', bar_complete: true, trigger_bar_close: 125.1, feed: 'iex', plan_ref: 'order-1',
  ...extra,
});
const sell = (symbol = CALL) => ({ symbol, position_intent: 'sell_to_close' });

test('the exact WMT contradiction (call, level 126.07, cited close 133.06) is a MISMATCH', () => {
  const audit = auditExit(sell(), ev({ trigger_level: 126.07, trigger_bar_close: 133.06, trigger_bar_start: '2026-11-25T14:30:00Z', trigger_bar_end: '2026-11-25T14:35:00Z' }));
  assert.equal(audit.verdict, 'MISMATCH');
  assert.match(audit.reason, /133\.06/);
  assert.match(exitAuditNote(audit), /^\n\nEXIT_AUDIT: MISMATCH \(advisory note only; it checked only the numbers you cited \(not the market, not your recorded plan, not which bar was eligible\)\)/);
});

test('call and put stop/trail/invalidation use strict inequality; equality never triggers; direction comes from the OCC letter, not the side', () => {
  for (const kind of ['stop', 'trail', 'invalidation']) {
    assert.equal(auditExit(sell(CALL), ev({ exit_kind: kind, trigger_level: 125.3, trigger_bar_close: 125.29 })).verdict, 'CONSISTENT', kind);
    assert.equal(auditExit(sell(CALL), ev({ exit_kind: kind, trigger_level: 125.3, trigger_bar_close: 125.3 })).verdict, 'MISMATCH', `${kind} equality`);
    assert.equal(auditExit(sell(CALL), ev({ exit_kind: kind, trigger_level: 125.3, trigger_bar_close: 125.31 })).verdict, 'MISMATCH', kind);
    assert.equal(auditExit(sell(PUT), ev({ exit_kind: kind, trigger_level: 160, trigger_bar_close: 160.01 })).verdict, 'CONSISTENT', kind);
    assert.equal(auditExit(sell(PUT), ev({ exit_kind: kind, trigger_level: 160, trigger_bar_close: 160 })).verdict, 'MISMATCH', `${kind} equality`);
    assert.equal(auditExit(sell(PUT), ev({ exit_kind: kind, trigger_level: 160, trigger_bar_close: 159.9 })).verdict, 'MISMATCH', kind);
  }
  assert.equal(occDirection(CALL), 'call');
  assert.equal(occDirection(PUT), 'put');
  assert.equal(occDirection('WMT'), null);
  assert.equal(occDirection('DIS270115C00120000'), 'call');
});

test('a target is a touch: call needs the cited bar high, put the cited bar low; equality touches', () => {
  assert.equal(auditExit(sell(CALL), ev({ exit_kind: 'target', trigger_level: 131.3, trigger_bar_high: 131.3, trigger_bar_close: undefined })).verdict, 'CONSISTENT');
  assert.equal(auditExit(sell(CALL), ev({ exit_kind: 'target', trigger_level: 131.3, trigger_bar_high: 131.29 })).verdict, 'MISMATCH');
  assert.equal(auditExit(sell(PUT), ev({ exit_kind: 'target', trigger_level: 150, trigger_bar_low: 149.9 })).verdict, 'CONSISTENT');
  assert.equal(auditExit(sell(PUT), ev({ exit_kind: 'target', trigger_level: 150, trigger_bar_low: 150.1 })).verdict, 'MISMATCH');
  // the high/low that matters must be present (a bar low cannot stand in for a call target)
  assert.equal(auditExit(sell(CALL), ev({ exit_kind: 'target', trigger_level: 131.3, trigger_bar_low: 131.7 })).verdict, 'UNVERIFIABLE');
});

test('an earlier valid cited bar followed by recovery is CONSISTENT; a cited safe-side bar is a MISMATCH even if another trigger may have existed', () => {
  const earlier = ev({ trigger_bar_start: '2026-11-25T14:40:00Z', trigger_bar_end: '2026-11-25T14:45:00Z', trigger_bar_close: 124.9 });
  assert.equal(auditExit(sell(), earlier).verdict, 'CONSISTENT'); // price may have recovered since; the module only judges the cited bar
  assert.equal(auditExit(sell(), ev({ trigger_bar_close: 133.06 })).verdict, 'MISMATCH');
});

test('everything outside the one supported rule is UNVERIFIABLE and says why; nothing is ever demoted to a pass', () => {
  const cases = [
    ev({ exit_kind: 'time' }), ev({ exit_kind: 'news' }), ev({ exit_kind: 'close_time' }), ev({ exit_kind: 'other' }), ev({ exit_kind: 'bogus' }), ev({ exit_kind: undefined }),
    ev({ rule_basis: 'option_premium' }), ev({ rule_basis: undefined }), ev({ trigger_level: undefined }), ev({ trigger_level: -1 }), ev({ trigger_level: NaN }),
    ev({ trigger_bar_close: undefined }), ev({ bar_complete: false }), ev({ bar_complete: undefined }),
    ev({ trigger_bar_start: 'yesterday' }), ev({ trigger_bar_end: '2026-11-25T15:50:00Z' }), ev({ trigger_bar_start: undefined }),
  ];
  for (const c of cases) assert.equal(auditExit(sell(), c).verdict, 'UNVERIFIABLE', JSON.stringify(c));
  for (const c of ['text', 42, true, [], [ev()]]) assert.equal(auditExit(sell(), c).verdict, 'UNVERIFIABLE', JSON.stringify(c));
  assert.equal(auditExit(sell('WMT'), ev()).verdict, 'UNVERIFIABLE'); // not an OCC symbol
  assert.equal(auditExit({ ...sell(), legs: [{}, {}] }, ev()).verdict, 'UNVERIFIABLE'); // multi-leg
  assert.equal(auditExit({ symbol: CALL, position_intent: 'buy_to_open' }, ev()).verdict, 'UNVERIFIABLE');
  assert.equal(auditExit(sell(), ev({ exit_kind: 'time' })).reason.includes('time'), true);
});

test('no exit_evidence means nothing to audit (old-call contract); CONSISTENT adds no note; sanitising drops unknown keys and caps strings', () => {
  assert.equal(auditExit(sell(), undefined), null);
  assert.equal(auditExit(sell(), null), null);
  assert.equal(exitAuditNote(null), '');
  assert.equal(exitAuditNote(auditExit(sell(), ev())), '');
  const clean = sanitizeExitEvidence({ ...ev(), injected: 'x', plan_ref: 'p'.repeat(500), trigger_level: Infinity });
  assert.equal('injected' in clean, false);
  assert.equal(clean.plan_ref.length, 80);
  assert.equal(clean.trigger_level, undefined);
  assert.equal(sanitizeExitEvidence('x'), null);
});

test('withExitAudit: unchanged without evidence; one advisory line otherwise; status, isError and other parts preserved; the record sink is best effort', () => {
  const base = { content: [{ type: 'text', text: '{"status":"accepted"}' }, { type: 'text', text: 'second part' }], isError: false };
  const noEvidence = withExitAudit(base, { ...sell() }, () => { throw new Error('must not be called'); });
  assert.equal(noEvidence, base);
  const consistent = withExitAudit(base, { ...sell(), exit_evidence: ev() }, () => {});
  assert.equal(consistent, base);
  const mismatch = withExitAudit(base, { ...sell(), exit_evidence: ev({ trigger_bar_close: 133.06 }) }, () => {});
  assert.notEqual(mismatch, base);
  assert.equal(mismatch.isError, false);
  assert.equal(mismatch.content.length, 2);
  assert.equal(mismatch.content[1].text, 'second part');
  assert.equal(mismatch.content[0].text.startsWith('{"status":"accepted"}\n\nEXIT_AUDIT: MISMATCH'), true);
  assert.doesNotMatch(mismatch.content[0].text, /was still submitted|order was submitted/i, 'the note never claims what the broker did');
  // the original response object is never mutated
  assert.equal(base.content[0].text, '{"status":"accepted"}');
  // an error response keeps isError and its text prefix
  const refused = withExitAudit({ content: [{ type: 'text', text: '{"error":"refused"}' }], isError: true }, { ...sell(), exit_evidence: ev({ trigger_bar_close: 133.06 }) }, () => {});
  assert.equal(refused.isError, true);
  assert.equal(refused.content[0].text.startsWith('{"error":"refused"}'), true);
});

test('a throwing, rejecting or never-settling sink cannot change or delay the returned response', async () => {
  const base = { content: [{ type: 'text', text: 'receipt' }], isError: false };
  const args = { ...sell(), exit_evidence: ev({ trigger_bar_close: 133.06 }) };
  const sinks = [
    () => { throw new Error('read-only disk'); },
    () => Promise.reject(new Error('EROFS')),
    () => new Promise(() => {}), // never settles
  ];
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const sink of sinks) {
      const started = Date.now();
      const out = withExitAudit(base, args, sink);
      assert.equal(typeof out.then, 'undefined', 'the result is synchronous, never a promise');
      assert.equal(out.content[0].text.startsWith('receipt\n\nEXIT_AUDIT: MISMATCH'), true);
      assert.ok(Date.now() - started < 200);
    }
    await new Promise(resolve => setImmediate(resolve));
  } finally { process.off('unhandledRejection', onUnhandled); }
  assert.deepEqual(unhandled, []);
  // an exception inside the audit itself returns the original response
  const hostile = { get exit_evidence() { throw new Error('boom'); }, symbol: CALL, position_intent: 'sell_to_close' };
  assert.equal(withExitAudit(base, hostile, () => {}), base);
});

// ---- through the real mcp-server.js over stdio against an inert capture backend (no real broker is ever contacted) ----
async function captureBackend(reply = () => ({ status: 200, body: { status: 'accepted', filled_qty: 0, execution_confirmed: false, order_id: 'ord-1' } })) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.method === 'GET' && url.pathname === '/api/permissions') return send(200, { allowPaperTrading: true, allowOptions: true, allowStocks: true, requireConfirmation: false, maxOrderValue: 100000 });
      if (req.method === 'POST' && url.pathname.endsWith('/options/order')) { bodies.push(JSON.parse(raw)); const { status, body } = reply(bodies.at(-1)); return send(status, body); }
      return send(404, { error: 'not found' });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, bodies, close: () => new Promise(resolve => server.close(resolve)) };
}
const orderArgs = (extra = {}) => ({ client_order_id: 'exit-1', symbol: CALL, underlying: 'WMT', quantity: 5, side: 'sell', position_intent: 'sell_to_close', order_type: 'limit', limit_price: 7.91, thesis: 'exit', ...extra });

test('end to end: the broker payload, call count and receipt are identical with, without and with malformed evidence; only the advisory line differs', async () => {
  const backend = await captureBackend();
  try {
    const plain = await callMcpTool(backend.url, 'place_options_order', orderArgs());
    const consistent = await callMcpTool(backend.url, 'place_options_order', orderArgs({ exit_evidence: ev() }));
    const mismatch = await callMcpTool(backend.url, 'place_options_order', orderArgs({ exit_evidence: ev({ trigger_level: 126.07, trigger_bar_close: 133.06 }) }));
    const malformed = [];
    for (const bad of ['garbage', [1, 2], { exit_kind: { nested: true }, trigger_level: 'x', junk: 'y'.repeat(100000) }, 42]) malformed.push(await callMcpTool(backend.url, 'place_options_order', orderArgs({ exit_evidence: bad })));
    assert.equal(plain.isError, false, plain.text);
    assert.equal(backend.bodies.length, 3 + malformed.length, 'exactly one broker call per order call');
    for (const body of backend.bodies) assert.deepEqual(body, backend.bodies[0], 'the broker payload never carries or depends on the audit');
    assert.equal('exit_evidence' in backend.bodies[0], false);
    assert.equal(consistent.text, plain.text, 'a CONSISTENT audit adds nothing');
    assert.equal(mismatch.isError, false);
    assert.equal(mismatch.text.startsWith(plain.text), true, 'the broker receipt is preserved byte for byte');
    assert.match(mismatch.text.slice(plain.text.length), /^\n\nEXIT_AUDIT: MISMATCH/);
    for (const m of malformed) {
      assert.equal(m.isError, false, m.text);
      assert.equal(m.text.startsWith(plain.text), true);
      assert.match(m.text.slice(plain.text.length), /^\n\nEXIT_AUDIT: UNVERIFIABLE/);
    }
  } finally { await backend.close(); }
});

test('end to end: a broker refusal is returned exactly as before, with no audit text, whatever the evidence says', async () => {
  const backend = await captureBackend(() => ({ status: 400, body: { error: 'refused by broker', category: 'broker_refusal' } }));
  try {
    const plain = await callMcpTool(backend.url, 'place_options_order', orderArgs());
    const annotated = await callMcpTool(backend.url, 'place_options_order', orderArgs({ exit_evidence: ev({ trigger_bar_close: 133.06 }) }));
    assert.equal(plain.isError, true);
    assert.equal(annotated.isError, plain.isError);
    assert.equal(annotated.text, plain.text);
    assert.doesNotMatch(annotated.text, /EXIT_AUDIT/);
  } finally { await backend.close(); }
});

test('the published tool schema declares exit_evidence as an optional plain object that no existing call has to send', async () => {
  const source = await fs.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');
  assert.equal(source.split('exit_evidence: {').length - 1, 1);
  const required = /required: \['client_order_id', 'symbol', 'underlying', 'quantity', 'side', 'position_intent', 'order_type'\]/.exec(source);
  assert.ok(required, 'the required list of place_options_order is unchanged');
});
