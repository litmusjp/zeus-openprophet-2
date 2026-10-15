import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');

test('standalone tool forwards only proposal to one assessment route and preserves feedback', async () => {
  const begin = source.indexOf("case 'assess_options_trade': {");
  const end = source.indexOf("case 'assess_options_strategy': {", begin);
  assert.ok(begin >= 0 && end > begin);
  const body = source.slice(begin, end).replace("case 'assess_options_trade': {", '').trim().replace(/}\s*$/, '');
  const calls = [];
  const reply = {decision:'FAIL',signal_score:40,execution_allowed:false,
    checks:[{code:'minimum_signal_score',passed:false}],remediation:['Choose a stronger genuine signal']};
  const invoke = vm.runInNewContext(`(async (args) => {${body}})`, {
    callTradingBot: async (...args) => { calls.push(args); return reply; },
  });
  const result = await invoke({legs:[{symbol:'AAPL261106C00200000',side:'buy'}],
    quantity:1,limit_price:2,signal_score:100,market_scanner_features:{invented:true}});
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/options/trade-assessment');
  assert.equal(calls[0][1],'POST');
  assert.deepEqual(Object.keys(calls[0][2]).sort(),['legs','limit_price','quantity']);
  assert.deepEqual(JSON.parse(result.content[0].text),reply);
});

test('standalone tool declares read-only scope and no caller evidence requirements', () => {
  const schema=source.slice(source.indexOf("name: 'assess_options_trade'"),source.indexOf("name: 'assess_options_strategy'"));
  assert.match(schema,/readOnlyHint: true/);
  assert.match(schema,/PASS is not broker\/account authorization/);
  assert.doesNotMatch(schema,/market_scanner_features|external_account_id|max_loss/);
});

test('standalone assessment and order tools share one stable proposal identity', () => {
  const assessment = source.slice(source.indexOf("name: 'assess_options_trade'"), source.indexOf("name: 'assess_options_strategy'"));
  const order = source.slice(source.indexOf("name: 'place_options_order'"), source.indexOf("name: 'withdraw_planned_intent'"));
  assert.match(assessment, /client_reference/);
  assert.match(assessment, /same stable client_order_id/i);
  assert.match(order, /client_order_id.*client_reference/i);
  const prompt = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');
  assert.match(prompt, /generate one stable client_order_id before assessment/i);
  assert.match(prompt, /use that exact value as client_reference/i);
  assert.match(prompt, /submit the unchanged contract, quantity, and limit/i);
});

test('MCP order response forwards safe assessment diagnostics unchanged', () => {
  const start = source.indexOf('function orderResponse(data, args)');
  const end = source.indexOf('\n}', start) + 2;
  assert.ok(start >= 0 && end > start);
  const respond = vm.runInNewContext(`(() => { ${source.slice(start, end)}; return orderResponse; })()`);
  const diagnostic = { status: 'risk_blocked', assessment_decision: 'PASS', assessment_category: 'execution_blocked', assessment_stage: 'market_session', assessment_reason: 'Market session is closed' };
  assert.deepEqual(JSON.parse(respond(diagnostic, { thesis: 'fixture thesis' }).content[0].text), diagnostic);
});

test('MCP place_options_order preserves typed HTTP outcome diagnostics', async () => {
  const begin = source.indexOf("case 'place_options_order': {");
  const end = source.indexOf("case 'withdraw_planned_intent': {", begin);
  const body = source.slice(begin, end).replace("case 'place_options_order': {", '').trim().replace(/}\s*$/, '');
  const calls = [];
  const invoke = vm.runInNewContext(`(async (args) => {${body}})`, {
    callTradingBot: async (...args) => { calls.push(args); return { status: 'risk_blocked', assessment_decision: 'PASS', assessment_category: 'execution_blocked', assessment_stage: 'market_session' }; },
    isOpeningIntent: () => true, autoStoreSetup: () => {}, orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
  });
  const output = await invoke({ client_order_id: 'stable-id', symbol: 'AAPL261106C00200000', underlying: 'AAPL', quantity: 1, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 2, thesis: 'fixture' });
  assert.equal(calls[0][0], '/options/order');
  assert.equal(calls[0][2].client_order_id, 'stable-id');
  assert.equal(JSON.parse(output.content[0].text).assessment_category, 'execution_blocked');
});

test('policy lookup is listed as idempotent read-only and serializes only backend metadata', async () => {
  const schema = source.slice(source.indexOf("name: 'get_options_assessment_policy'"), source.indexOf("name: 'assess_options_trade'"));
  assert.match(schema, /readOnlyHint: true/);
  assert.match(schema, /idempotentHint: true/);
  assert.match(schema, /never PASS or execution authority/);
  const begin = source.indexOf("case 'get_options_assessment_policy': {");
  const end = source.indexOf("case 'assess_options_trade': {", begin);
  assert.ok(begin >= 0 && end > begin);
  const body = source.slice(begin, end).replace("case 'get_options_assessment_policy': {", '').trim().replace(/}\s*$/, '');
  const calls = [];
  const policy = { kind: 'assessment_policy_metadata', decision: 'POLICY_ONLY', assessment_performed: false, max_investment_per_candidate: '750', execution_allowed: false };
  const invoke = vm.runInNewContext(`(async () => {${body}})`, {
    callTradingBot: async (...args) => { calls.push(args); return policy; },
  });
  const result = await invoke();
  assert.deepEqual(calls, [['/options/assessment-policy']]);
  assert.deepEqual(JSON.parse(result.content[0].text), policy);
});
