import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../agent/harness.js';
import { applyDebitVerticalText, debitVerticalsAllowed, SPREAD_TEXT_REPLACEMENTS } from '../agent/spread-guidance.js';
import { spreadLegsRequest } from '../spread-legs.js';
import { renderAlphaDeskPolicyFacts } from '../agent/trading-guidance.js';

// Phase C2: the shared "how" for two-leg debit verticals is added to an agent's prompt only when its sandbox permission lists
// one. Every other prompt stays byte-identical.

const OLD_WORKFLOW = [
  '### MARKET-OPEN ALPHADESK WORKFLOW',
  'Select one exact eligible single-leg proposal at quantity 1. Read current managed policy; submit this exact OCC contract, side=\'buy\', quantity 1, and proposed positive limit premium once through prophet_place_options_order.',
  '### END_MARKET_OPEN_ALPHADESK_WORKFLOW',
].join('\n');

const NEW_WORKFLOW = [
  '### MARKET-OPEN ALPHADESK WORKFLOW',
  'Select an exact eligible proposal within available account capacity and existing controls: one single-leg order, or, where your Strategy Rules and permissions allow it, one two-leg debit vertical. Submit this exact OCC contract (for a vertical, the exact legs), side=\'buy\' for a single long option, the exact proposed quantity (spread units) and the proposed positive limit (the net debit for a vertical) once through prophet_place_options_order.',
  '### END_MARKET_OPEN_ALPHADESK_WORKFLOW',
].join('\n');

const agents = {
  herald: (workflow = OLD_WORKFLOW) => ({ id: 'catalyst', sandboxId: 'sbx_723be98b', name: 'Herald', systemPromptTemplate: 'custom', strategyId: 'catalyst-news', customSystemPrompt: `You are Herald.\n\n${workflow}` }),
  pendulum: (workflow = OLD_WORKFLOW) => ({ id: 'mean-reversion', sandboxId: 'sbx_956ff9e4', name: 'Pendulum', systemPromptTemplate: 'custom', strategyId: 'etf-mean-reversion', customSystemPrompt: `You are Pendulum.\n\n${workflow}` }),
  prophet: () => ({ id: 'default', sandboxId: 'sbx_0d35471e', name: 'Prophet', systemPromptTemplate: 'default', strategyId: 'default' }),
};
const getStrategyById = () => ({ customRules: '- Strategy rules for the test.' });
const build = (agent, allowedStructures) => buildSystemPrompt(agent, { getStrategyById, allowedStructures });

const CONTRADICTIONS = [
  /Agent execution is single-leg only/,
  /Its agent schema is single-leg only/,
  /backend atomic multi-leg support is not exposed by this tool/,
  /eligible unchanged single-leg proposal/,
];

test('without a debit-vertical permission every prompt is byte-identical to before', async () => {
  for (const make of Object.values(agents)) {
    const base = await build(make(), undefined);
    assert.equal(await build(make(), ['long_call', 'long_put']), base);
    assert.equal(await build(make(), []), base);
    assert.equal(applyDebitVerticalText(base, ['long_call', 'long_put']), base);
    assert.match(base, /Agent execution is single-leg only/);
    assert.doesNotMatch(base, /Debit vertical mechanics/);
  }
});

test('with a debit vertical allowed, the three running agents get the mechanics and lose the contradictions', async () => {
  for (const [name, make] of Object.entries(agents)) {
    const prompt = await build(make(), ['long_call', 'long_put', 'bull_call_debit']);
    for (const pattern of CONTRADICTIONS) assert.doesNotMatch(prompt, pattern, `${name} still carries ${pattern}`);
    assert.match(prompt, /Debit vertical mechanics \(your permissions allow: bull call debit\)/, name);
    assert.doesNotMatch(prompt, /bear put debit\)/, `${name} must not be told about an unlisted structure`);
    for (const required of [
      /only when your Strategy Rules say you may/,
      /using `legs` \(exactly two/,
      /repeat the first leg in the top-level symbol, side and position_intent/,
      /quantity counts spread units, and the 1-10 cap counts units \(10 units are 20 leg contracts\)/,
      /a retry without `legs` is refused/,
      /the widest leg counts/,
      /measured on the spread's maximum loss \(net debit x units x 100\)/,
      /closing half the units in one two-leg order, rounded down/,
      /reprice on the net bid of both legs read in the same beat/,
      /planned_for_next_session retry uses identical legs/,
      /Close a spread before its expiry session when the short leg is in the money/,
      /prophet_get_option_groups/,
      /you never trade assigned stock yourself/,
    ]) assert.match(prompt, required, `${name} is missing ${required}`);
    assert.ok(prompt.includes("(for a two-leg vertical, each leg's)"), `${name} execution contract`);
    // The single-leg instructions survive unchanged.
    assert.match(prompt, /Open long options with `buy_to_open`; close with `sell_to_close` on the same OCC symbol/);
  }
});

test('both debit structures are named only when both are allowed', async () => {
  const both = await build(agents.herald(), ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit']);
  assert.match(both, /your permissions allow: bull call debit and bear put debit/);
  const bear = await build(agents.herald(), ['bear_put_debit']);
  assert.match(bear, /your permissions allow: bear put debit\)/);
  assert.deepEqual(debitVerticalsAllowed(['long_call', 'bear_put_debit', 'nonsense']), ['bear_put_debit']);
  assert.deepEqual(debitVerticalsAllowed('bull_call_debit'), []);
});

test('every replacement matches the live wording of at least one running agent prompt (no silent drift)', async () => {
  const prompts = await Promise.all(Object.values(agents).map(make => build(make(), undefined)));
  for (const [from] of SPREAD_TEXT_REPLACEMENTS) {
    assert.ok(prompts.some(prompt => prompt.includes(from)), `the prompt text no longer contains: ${from.slice(0, 80)}`);
  }
});

test('the spread text is inserted once, right after the order-tool line', async () => {
  const prompt = await build(agents.prophet(), ['bull_call_debit']);
  assert.equal(prompt.split('- Debit vertical mechanics (your permissions allow').length - 1, 1);
  const toolLine = prompt.indexOf('- Use `prophet_place_options_order` for one OCC option symbol or, with `legs`');
  assert.ok(toolLine >= 0 && prompt.indexOf('- Debit vertical mechanics (your permissions allow') > toolLine);
});

test('saved workflow wording: the legacy size sentences are still normalised and the new two-leg wording is preserved', async () => {
  const legacy = await build(agents.pendulum(OLD_WORKFLOW), undefined);
  assert.match(legacy, /Select an exact eligible single-leg proposal within available account capacity and existing controls\./);
  assert.match(legacy, /the exact proposed quantity, and proposed positive limit premium once/);
  const updated = await build(agents.pendulum(NEW_WORKFLOW), ['bull_call_debit']);
  assert.match(updated, /one single-leg order, or, where your Strategy Rules and permissions allow it, one two-leg debit vertical/);
  assert.match(updated, /the exact proposed quantity \(spread units\)/);
  assert.doesNotMatch(updated, /single-leg proposal/);
});

test('the per-beat policy-facts line names the widest leg only when a vertical is allowed', () => {
  const facts = { op2_option_spread_cap_pct: 10 };
  const single = renderAlphaDeskPolicyFacts(facts);
  assert.match(single, /quote of the exact contract, is above 10%/);
  assert.equal(renderAlphaDeskPolicyFacts(facts, { twoLeg: false }), single);
  assert.match(renderAlphaDeskPolicyFacts(facts, { twoLeg: true }), /quote of the exact contract \(for a two-leg order, of its widest leg\), is above 10%/);
});

test('place_options_order: schema and spread input contract', () => {
  const long = { symbol: 'AAPL261218C00200000', side: 'buy', position_intent: 'buy_to_open', ratio_qty: 1, price: 4 };
  const short = { symbol: 'AAPL261218C00210000', side: 'sell', position_intent: 'sell_to_open', ratio_qty: 1, price: 1 };
  const ok = spreadLegsRequest({ legs: [long, short], symbol: long.symbol, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 3 });
  assert.equal(ok.error, undefined);
  assert.equal(ok.priceKind, 'debit');
  assert.equal(ok.legs.length, 2);
  // The parent fields must repeat legs[0]; anything else is refused before a backend call.
  assert.match(spreadLegsRequest({ legs: [long, short], symbol: short.symbol, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 3 }).error, /must repeat the first leg/);
  assert.match(spreadLegsRequest({ legs: [long], symbol: long.symbol, side: 'buy', position_intent: 'buy_to_open', order_type: 'limit', limit_price: 3 }).error, /exactly two legs/);
});
