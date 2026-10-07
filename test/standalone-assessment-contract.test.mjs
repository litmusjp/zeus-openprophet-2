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
