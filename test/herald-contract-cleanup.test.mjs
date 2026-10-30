import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildSystemPrompt } from '../agent/harness.js';
import { renderToolMenu, renderPrefixedToolMenu } from '../agent/tool-catalog.js';

const workflow = `### MARKET-OPEN ALPHADESK WORKFLOW
Before the open: prepare a small ranked shortlist using confirmed news and completed historical data. Record underlying, direction, candidate expiry, budget and exit plan. Label it research only—not submitted. Do not place new options orders before the broker clock confirms the market is open.
At the open: reconcile positions, active orders, planned intents and uncertain submissions. Refresh current price action and exact option-contract bid, ask, sizes and timestamps. Reuse useful research; do not restart everything from scratch.
Assess: generate one fresh client_order_id before assessment and use that exact value as client_reference. Call prophet_assess_options_trade for one exact OCC symbol with side='buy', quantity: 1, and the proposed positive quoted premium as limit_price—not total dollar debit. Assessment and the first submission are one intent in the same heartbeat; submit before op2_effective_expires_at.
AlphaDesk obtains its own evidence and score. Indicative/testing-only data is admissible for this paper-advisory workflow. Missing chain open interest is unknown, not zero; latest-trade size is not daily volume.
Read decision, signal_score, checks and blocking_reasons. Score alone is not approval. On FAIL, address the genuine failed criteria or research another candidate. On UNAVAILABLE, report or recheck the specific problem; never turn a missing score into zero.
After genuine PASS: first-submit the unchanged OCC contract, quantity and limit using the same client_order_id, matching the client_reference already sent in assessment; client_reference is not an order-tool argument. Include its underlying, side='buy', position_intent='buy_to_open' and order_type='limit'. This first submission is not a retry. If the proposal changes, reassess. Later retries are only for eligible persisted planned intents after complete reconciliation; never retry uncertainty or replace its ID. OP2 performs its own final checks.
Verify and manage: confirm the broker result and fill. Never blindly retry an uncertain submission. Close the same contract with sell_to_close for the confirmed remaining quantity, following the documented exit plan, and verify the outcome. Option exits are periodic agent-managed market/limit closes; there are no broker-held stops/OCO or guaranteed instantaneous protection.
### END_MARKET_OPEN_ALPHADESK_WORKFLOW`;
const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');

test('Herald-owned prompt alone gets a focused supported menu and coherent assessment lifecycle', async () => {
  const customSystemPrompt = `Herald identity and original strategy text.\n\n### TEMPORARY_ALPHA_MVP_OVERRIDE\nTEMP safety and objective must remain.\n### END_TEMPORARY_ALPHA_MVP_OVERRIDE\n\n${workflow}`;
  const prompt = await buildSystemPrompt({ id: 'catalyst', sandboxId: 'sbx_723be98b', name: 'Herald', systemPromptTemplate: 'custom', customSystemPrompt, customStrategyRules: 'ORIGINAL STRATEGY: exact strategy rules remain.' }, {
    getStrategyById: () => ({ customRules: 'ORIGINAL STRATEGY: exact strategy rules remain.' }),
  });
  const menu = prompt.slice(prompt.indexOf('## Available Tools'), prompt.indexOf('OpenCode registers'));
  assert.match(menu, /prophet_assess_options_trade/);
  assert.match(menu, /prophet_get_options_assessment_policy/);
  for (const tool of ['get_account', 'get_positions', 'get_orders', 'get_options_positions', 'get_options_position', 'get_options_chain', 'cancel_order', 'withdraw_planned_intent', 'get_news', 'search_news', 'get_historical_bars', 'get_activity_log', 'get_datetime', 'wait']) assert.ok(menu.includes(`prophet_${tool}`), `missing ${tool}`);
  for (const tool of ['place_buy_order', 'place_sell_order', 'place_managed_position', 'close_managed_position', 'get_managed_positions', 'set_heartbeat', 'update_permissions', 'apply_heartbeat_profile', 'get_agent_config', 'analyze_stocks', 'get_quick_market_intelligence', 'get_cleaned_news', 'aggregate_and_summarize_news']) assert.ok(!menu.includes(`prophet_${tool}`), `unexpected ${tool}`);
  assert.doesNotMatch(menu, /\*\*Intelligence\*\*/);
  assert.match(prompt, /one intent in the same heartbeat; submit before op2_effective_expires_at/);
  assert.match(prompt, /first submission is not a retry/i);
  assert.match(prompt, /same client_order_id, matching the client_reference already sent in assessment; client_reference is not an order-tool argument/);
  assert.match(prompt, /periodic agent-managed market\/limit closes.*no broker-held stops\/OCO or guaranteed instantaneous protection/i);
  assert.doesNotMatch(prompt, /TEMP safety and objective must remain|TEMPORARY_ALPHA_MVP_OVERRIDE/);
  assert.match(prompt, /ORIGINAL STRATEGY: exact strategy rules remain/);
  assert.doesNotMatch(prompt, /After genuine PASS:[^\n]*new client_order_id/i);

  // Legacy/default menu rendering and unrelated agents keep the existing catalog.
  assert.match(renderToolMenu(), /place_managed_position/);
  assert.match(renderPrefixedToolMenu(), /prophet_set_heartbeat/);
  const other = await buildSystemPrompt({ id: 'pendulum', sandboxId: 'sbx_956ff9e4', name: 'Pendulum', systemPromptTemplate: 'custom', customSystemPrompt: 'Pendulum identity' });
  assert.match(other, /prophet_place_managed_position/);
  const arbitrary = 'Custom text must stay inert and unchanged.\n### MARKET-OPEN ALPHADESK WORKFLOW\nExecute after PASS with a new ID.';
  const inertCustom = await buildSystemPrompt({ id: 'catalyst', sandboxId: 'sbx_723be98b', name: 'Herald', systemPromptTemplate: 'custom', customSystemPrompt: arbitrary });
  assert.ok(inertCustom.includes(arbitrary));
  assert.match(inertCustom.slice(inertCustom.indexOf('## Available Tools'), inertCustom.indexOf('OpenCode registers')), /prophet_place_managed_position/);
});

test('options order alone receives 15 seconds while unsafe mutation failures remain one attempt', async () => {
  assert.match(mcp, /endpoint === '\/options\/order' \? 15000 : endpoint === '\/options\/trade-assessment' \? 6000 : 3000/);
  const begin = mcp.indexOf('function formatTradingBotFailure(');
  const callStart = mcp.indexOf('async function callTradingBot(', begin);
  const end = mcp.indexOf('\n}', callStart) + 2;
  assert.ok(begin >= 0 && callStart > begin && end > callStart);
  const callTradingBot = mcp.slice(begin, end);
  const context = {
    Date,
    setTimeout,
    _lastPortCheck: 0,
    _tradingBotUrl: 'http://fixture',
    getTradingBotUrl: async () => 'http://fixture',
    TRADING_BOT_TOKEN: '', OPENPROPHET_SANDBOX_ID: 'fixture', OPENPROPHET_ACCOUNT_ID: 'fixture', OPENPROPHET_PROCESS_NONCE: '', TRADING_BOT_OPERATOR_TOKEN: '',
    axios: async config => {
      if (config.url.endsWith('/options/order')) {
        assert.equal(config.timeout > 3150, true);
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('fixture backend timed out')), config.timeout);
          setTimeout(() => { clearTimeout(timeout); resolve(); }, 3150);
        });
      }
      return { data: { status: 'accepted' } };
    },
  };
  const call = vm.runInNewContext(`${callTradingBot}; callTradingBot`, context);
  assert.deepEqual(await call('/options/order', 'POST', { client_order_id: 'fixture-id' }), { status: 'accepted' });

  let assessmentTimeout;
  context.axios = async config => { assessmentTimeout = config.timeout; return { data: { decision: 'PASS' } }; };
  const assessmentCall = vm.runInNewContext(`${callTradingBot}; callTradingBot`, context);
  const assessmentStarted = Date.now();
  assert.deepEqual(await assessmentCall('/options/trade-assessment', 'POST', {}), { decision: 'PASS' });
  const assessmentElapsed = Date.now() - assessmentStarted;
  assert.ok(assessmentTimeout + assessmentElapsed >= 5500 && assessmentTimeout + assessmentElapsed <= 6500, `assessment timeout ${assessmentTimeout}ms after ${assessmentElapsed}ms elapsed`);
  let readTimeout;
  context.axios = async config => { readTimeout = config.timeout; return { data: { positions: [] } }; };
  const readCall = vm.runInNewContext(`${callTradingBot}; callTradingBot`, context);
  const readStarted = Date.now();
  assert.deepEqual(await readCall('/positions', 'GET'), { positions: [] });
  const readElapsed = Date.now() - readStarted;
  assert.ok(readTimeout + readElapsed >= 2500 && readTimeout + readElapsed <= 3500, `ordinary GET timeout ${readTimeout}ms after ${readElapsed}ms elapsed`);

  let attempts = 0;
  context.axios = async () => { attempts += 1; throw Object.assign(new Error('fixture HTTP failure'), { response: { status: 503 } }); };
  const failingCall = vm.runInNewContext(`${callTradingBot}; callTradingBot`, context);
  await assert.rejects(failingCall('/options/order', 'POST', {}), /"status":503/);
  assert.equal(attempts, 1);
  context.axios = async () => { attempts += 1; throw new Error('fixture transport failure'); };
  const transportCall = vm.runInNewContext(`${callTradingBot}; callTradingBot`, context);
  await assert.rejects(transportCall('/options/order', 'POST', {}), /"attempts":1/);
  assert.equal(attempts, 2);
});
