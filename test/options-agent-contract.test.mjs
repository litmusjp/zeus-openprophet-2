import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('agent order contract states single-leg limit and stable ID retry rule', () => {
  const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
  const prompt = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');
  const option = mcp.slice(mcp.indexOf("name: 'place_options_order'"), mcp.indexOf("name: 'withdraw_planned_intent'"));
  assert.match(option, /single-leg/i);
  assert.match(option, /client_order_id for every NEW intent/i);
  assert.match(option, /uncertain submission must never be blindly retried/i);
  assert.match(prompt, /sequential single-leg orders/i);
  assert.match(prompt, /nullable.*provider-owned/i);
  assert.match(prompt, /In PAPER_ADVISORY_OP2 mode/i);
  assert.match(prompt, /On PASS, attempt.*prophet_place_options_order/s);
  assert.match(prompt, /FAIL or UNAVAILABLE blocks this opening candidate/i);
});
