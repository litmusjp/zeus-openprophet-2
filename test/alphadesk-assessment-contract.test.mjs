import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');

test('OpenProphet exposes AlphaDesk as read-only assessment, not an order route', () => {
  assert.match(source, /name: 'assess_options_strategy'/);
  assert.match(source, /callTradingBot\('\/options\/assessment', 'POST'/);
  assert.match(source, /name: 'place_options_order'/);
  assert.doesNotMatch(
    source,
    /assess_options_strategy[\s\S]{0,400}place_options_order/,
    'assessment tool must not invoke the order tool',
  );
});

test('assessment tool returns structured local 400 validation', async () => {
  const start = source.indexOf('async function callTradingBot(');
  const end = source.indexOf('// Automatic memory', start);
  const validation = { status: 'invalid_request', category: 'local_validation', fields: { symbol: 'OCC symbol required' } };
  const context = {
    Date, JSON, Promise, setTimeout,
    _lastPortCheck: Date.now(), _tradingBotUrl: 'http://localhost',
    TRADING_BOT_TOKEN: '', TRADING_BOT_OPERATOR_TOKEN: '',
    OPENPROPHET_SANDBOX_ID: 'sandbox', OPENPROPHET_ACCOUNT_ID: 'account', OPENPROPHET_PROCESS_NONCE: 'nonce',
    axios: async () => { throw { response: { status: 400, data: validation } }; },
  };
  vm.runInNewContext(`${source.slice(start, end)}\nthis.callTradingBot = callTradingBot;`, context);
  assert.deepEqual(await context.callTradingBot('/options/assessment', 'POST', {}, { returnValidation: true }), validation);
});

test('trade assessment has a six-second read-only budget while ordinary and mutation calls stay bounded', async () => {
  async function invoke(endpoint, method, axios) {
    let now = 1000;
    const clock = { now: () => now, advance: ms => { now += ms; } };
    const context = {
      Date: { now: clock.now }, JSON, Promise, setTimeout: resolve => resolve(),
      _lastPortCheck: now, _tradingBotUrl: 'http://localhost',
      TRADING_BOT_TOKEN: '', TRADING_BOT_OPERATOR_TOKEN: '',
      OPENPROPHET_SANDBOX_ID: 'sandbox', OPENPROPHET_ACCOUNT_ID: 'account', OPENPROPHET_PROCESS_NONCE: 'nonce',
      axios: config => axios(config, clock),
    };
    vm.runInNewContext(`${source.slice(source.indexOf('async function callTradingBot('), source.indexOf('// Automatic memory'))}\nthis.callTradingBot = callTradingBot;`, context);
    return context.callTradingBot(endpoint, method, {});
  }

  const assessmentConfigs = [];
  const result = await invoke('/options/trade-assessment', 'POST', async (config, clock) => {
    assessmentConfigs.push(config);
    clock.advance(3501);
    return { data: { status: 'PASS' } };
  });
  assert.deepEqual(result, { status: 'PASS' });
  assert.equal(assessmentConfigs.length, 1);
  assert.equal(assessmentConfigs[0].timeout, 6000);

  const ordinaryConfigs = [];
  await invoke('/account', 'GET', async config => { ordinaryConfigs.push(config); return { data: {} }; });
  assert.equal(ordinaryConfigs[0].timeout, 3000);

  let mutationCalls = 0;
  await assert.rejects(() => invoke('/orders/buy', 'POST', async config => {
    mutationCalls += 1;
    assert.equal(config.timeout, 3000);
    throw new Error('fixture failure');
  }), /Trading bot request failed/);
  assert.equal(mutationCalls, 1);
});
