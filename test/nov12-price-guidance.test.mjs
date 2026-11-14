import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { normalizeOptionLimitPrice } from '../option-price.js';
import { sessionFields, openingGateDecision, parseMinOpeningMinutes } from '../session-clock.js';
import { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance } from '../agent/trading-guidance.js';

const source = await fsp.readFile(new URL('../mcp-server.js', import.meta.url), 'utf8');

// ── R1: one exact, decimal-safe cent normalizer ─────────────────────────────────────────────────
test('buys round down and sells round up to the cent, exactly', () => {
  assert.equal(normalizeOptionLimitPrice(9.365, 'buy'), 9.36);
  assert.equal(normalizeOptionLimitPrice(9.365, 'sell'), 9.37);
  assert.equal(normalizeOptionLimitPrice(9.3699, 'buy'), 9.36);
  assert.equal(normalizeOptionLimitPrice(9.3699, 'sell'), 9.37);
  assert.equal(normalizeOptionLimitPrice(9.255, 'buy'), 9.25);
  assert.equal(normalizeOptionLimitPrice('37.785', 'buy'), 37.78);
  assert.equal(normalizeOptionLimitPrice(0.0099, 'sell'), 0.01);
  assert.equal(normalizeOptionLimitPrice(1234.56789, 'buy'), 1234.56);
});

test('whole-cent prices are returned unchanged for both sides, including float noise', () => {
  for (const price of [10.35, 3.03, 26.94, 0.01, 66.06, 100, 41.63, 0.29, 1.1, 9.36, 4.18]) {
    assert.equal(normalizeOptionLimitPrice(price, 'buy'), price, `buy ${price}`);
    assert.equal(normalizeOptionLimitPrice(price, 'sell'), price, `sell ${price}`);
  }
  assert.equal(normalizeOptionLimitPrice(9.364999999999999, 'buy'), 9.36, 'binary noise just below a cent boundary is read as the cent');
  assert.equal(normalizeOptionLimitPrice(0.1 + 0.2, 'sell'), 0.3);
  assert.equal(normalizeOptionLimitPrice('10.35', 'sell'), 10.35);
});

test('invalid prices and sides are errors; a buy below one cent is an error', () => {
  for (const bad of [0, -1, NaN, Infinity, '', '  ', 'abc', null, undefined, true]) {
    assert.throws(() => normalizeOptionLimitPrice(bad, 'buy'), /positive number/, String(bad));
  }
  assert.throws(() => normalizeOptionLimitPrice(0.0099, 'buy'), /below one cent/);
  assert.throws(() => normalizeOptionLimitPrice(0.001, 'buy'), /below one cent/);
  assert.throws(() => normalizeOptionLimitPrice(5, 'hold'), /side must be/);
  assert.throws(() => normalizeOptionLimitPrice(5, undefined), /side must be/);
});

// ── R1: all three options tools send the normalized price, and the tool args agree ─────────────
function caseBody(start, endMarker) {
  const begin = source.indexOf(start);
  const end = source.indexOf(endMarker, begin);
  assert.ok(begin >= 0 && end > begin, start);
  return source.slice(begin, end).replace(start, '').trim().replace(/}\s*$/, '');
}
function runner(body, calls, extra = {}) {
  return vm.runInNewContext(`(async (args) => {${body}})`, {
    JSON, Number, normalizeOptionLimitPrice, sessionFields, openingGateDecision, parseMinOpeningMinutes, process: { env: {} },
    callTradingBot: async (...a) => { calls.push(a); return { status: 'accepted' }; },
    capSyncAllowsOpening: async () => true, // the cap guard has its own tests (nov15-cap-unresolved)
    isOpeningIntent: () => true, autoStoreSetup: () => {}, orderResponse: data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] }),
    ...extra,
  });
}
const orderBase = { symbol: 'GE261120C00337500', underlying: 'GE', quantity: 6, order_type: 'limit', position_intent: 'buy_to_open', client_order_id: 'x', thesis: 't' };

test('place_options_order sends the normalized price and writes it back to the args', async () => {
  const calls = [];
  const stored = [];
  const invoke = runner(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), calls, { autoStoreSetup: a => stored.push(a) });
  const buy = { ...orderBase, side: 'buy', limit_price: 9.365 };
  await invoke(buy);
  assert.equal(calls[0][2].limit_price, 9.36);
  assert.equal(buy.limit_price, 9.36, 'args carry the price actually used');
  await invoke({ ...orderBase, side: 'sell', position_intent: 'sell_to_close', limit_price: 9.365 });
  assert.equal(calls[1][2].limit_price, 9.37);
  await invoke({ ...orderBase, side: 'buy', limit_price: 10.35 });
  assert.equal(calls[2][2].limit_price, 10.35);
  assert.equal(stored[0].limit_price, 9.36, 'the stored setup sees the normalized price');
});

test('place_options_order refuses an invalid price locally without calling the backend', async () => {
  const calls = [];
  const invoke = runner(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), calls);
  for (const price of [0, -2, 'abc']) {
    const out = await invoke({ ...orderBase, side: 'buy', limit_price: price });
    assert.equal(out.isError, true);
    const body = JSON.parse(out.content[0].text);
    assert.equal(body.category, 'local_validation');
    assert.equal(body.execution_confirmed, false);
  }
  assert.equal((await invoke({ ...orderBase, side: 'buy', limit_price: 0.0099 })).isError, true);
  assert.equal(calls.length, 0);
  // a market order has no limit price and is not touched
  await invoke({ ...orderBase, side: 'buy', order_type: 'market' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].limit_price, undefined);
});

test('assess_options_strategy and assess_options_trade normalize the same way', async () => {
  const calls = [];
  const strategy = runner(caseBody("case 'assess_options_strategy': {", "case 'get_options_positions': {"), calls);
  const a = { ...orderBase, side: 'buy', time_in_force: 'day', limit_price: 9.365 };
  await strategy(a);
  assert.equal(calls[0][0], '/options/assessment');
  assert.equal(calls[0][2].limit_price, 9.36);
  assert.equal(a.limit_price, 9.36);
  const sell = { ...orderBase, side: 'sell', position_intent: 'sell_to_close', time_in_force: 'day', limit_price: 9.365 };
  await strategy(sell);
  assert.equal(calls[1][2].limit_price, 9.37);

  const trade = runner(caseBody("case 'assess_options_trade': {", "case 'assess_options_strategy': {"), calls);
  const t = { legs: [{ symbol: 'AAPL261106C00200000', side: 'buy' }], quantity: 1, limit_price: 2.505 };
  await trade(t);
  assert.equal(calls[2][0], '/options/trade-assessment');
  assert.equal(calls[2][2].limit_price, 2.5, 'net-debit structures are buys');
  assert.equal((await trade({ ...t, limit_price: -1 })).isError, true);
  assert.equal(calls.length, 3);
});

test('the assessed price and the submitted price are identical for the same proposal', async () => {
  const calls = [];
  const strategy = runner(caseBody("case 'assess_options_strategy': {", "case 'get_options_positions': {"), calls);
  const order = runner(caseBody("case 'place_options_order': {", "case 'withdraw_planned_intent': {"), calls);
  const proposal = { ...orderBase, side: 'buy', time_in_force: 'day', limit_price: 9.3699 };
  await strategy({ ...proposal });
  await order({ ...proposal });
  assert.equal(calls[0][2].limit_price, calls[1][2].limit_price);
  assert.equal(calls[1][2].limit_price, 9.36);
});

// ── R2: guidance lines render for every strategy family ────────────────────────────────────────
test('the cents, requote, stale-order and uncertain-intent lines reach every family', () => {
  for (const id of ['catalyst-news', 'long-premium-volatility', 'default', 'equity-momentum', 'etf-mean-reversion', 'capital-preservation']) {
    const text = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: id });
    assert.match(text, /Limit prices are whole cents: the order and assessment tools round a buy down and a sell up to the cent, and the receipt shows the price used/, id);
    assert.match(text, /submit at once \(aim for under 90 seconds\); OP2 rejects quote evidence older than 2 minutes and that check still decides\. Write your logs after the order call/, id);
    assert.match(text, /Review an unfilled opening order at the second heartbeat after submission/, id);
    assert.match(text, /Copy order IDs exactly from the latest get_orders result; never retype them\. Before any replacement, confirm the cancel is terminal and read its cumulative filled quantity; a replacement covers only the verified remaining quantity, never more\./, id);
    assert.match(text, /do not submit a duplicate exit; record the block with prophet_log_decision and continue at the next heartbeat\. The second-heartbeat review above applies to opening orders only\./, id);
    assert.doesNotMatch(text, /zero fill before any replacement/, id);
    assert.match(text, /Session time: reason about time of day only from session_time_et, minutes_since_open and minutes_to_close in get_datetime/, id);
    assert.match(text, /An unresolved submission_uncertain intent never stops research: keep scanning and record candidates as WATCHLIST, but open nothing new until it is resolved/, id);
    assert.match(text, /Never change price, quantity or direction merely to obtain a PASS/, id);
  }
});
