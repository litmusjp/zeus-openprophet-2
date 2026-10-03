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
