import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../agent/harness.js';

// Nov 24 plan v2 (Hermes plan review R1 + R2): B1 clarifies DATA_BLOCK / NO_SETUP / INCOMPLETE_RESEARCH for all agents without touching
// the due-exit rule; B2 adds a text-only (PAPER trial) direction budget for the catalyst family only. Rendered-text tests.

const STRATEGIES = ['default', 'catalyst-news', 'etf-mean-reversion', 'equity-momentum', 'long-premium-volatility', 'capital-preservation', 'macro-rotation', 'long-horizon-trend'];
const getStrategyById = id => ({ id, customRules: '- Strategy rules for the test.' });
const render = strategyId => buildSystemPrompt({ id: `agent-${strategyId}`, sandboxId: 'sbx_test', name: 'T', systemPromptTemplate: 'default', strategyId }, { getStrategyById: () => getStrategyById(strategyId), allowedStructures: ['long_call', 'long_put', 'bull_call_debit', 'bear_put_debit'] });

const B1 = [
  'For entry screening, a strategy condition evaluated on usable data that fails is NO_SETUP',
  'skipped, unfinished or unverified research remains INCOMPLETE_RESEARCH under your existing rules',
  'Use DATA_BLOCK when unavailable required usable data prevents an otherwise required action',
  'a due exit with no fresh exact-contract quote remains DATA_BLOCK under the exit rule, and is still due',
];

test('B1: every agent gets the bounded DATA_BLOCK / NO_SETUP wording exactly once, next to the unchanged shared line', async () => {
  for (const id of STRATEGIES) {
    const prompt = await render(id);
    for (const part of B1) assert.equal(prompt.split(part).length - 1, 1, `${id}: ${part.slice(0, 50)}`);
    assert.ok(prompt.includes('a scan that skipped candidates is INCOMPLETE_RESEARCH, not NO_SETUP. For entry screening'), id);
  }
});

test('B1 does not turn a due exit into "nothing qualifies" and invents no timed forced sell', async () => {
  const prompt = await render('catalyst-news');
  assert.doesNotMatch(prompt, /forced sell|force a sale|sell at the close regardless/i);
  assert.match(prompt, /is still due/);
  // The existing close-time exit rule text stays in the catalyst prompt.
  assert.match(prompt, /Close-time exit: an exit is due by the close only when/);
});

test('B2: only the catalyst family gets the direction budget', async () => {
  for (const id of STRATEGIES) {
    const prompt = await render(id);
    const has = prompt.includes('Direction budget (new openings only, never a reason to sell)');
    assert.equal(has, id === 'catalyst-news', id);
  }
});

test('B2: the rendered rule states the accounting contract (held, reserved, candidate, partial fills, unknown state)', async () => {
  const prompt = await render('catalyst-news');
  const rule = prompt.slice(prompt.indexOf('Direction budget (new openings only'));
  const must = [
    'Bullish means a long call or bull-call debit; bearish means a long put or bear-put debit; never net the two directions',
    'remaining quantity x the broker average entry premium x 100 for each single option',
    'an intact vertical counted once as remaining spread units x its recorded filled net debit x 100',
    'inherited lots included',
    'the unfilled opening quantity of every working, planned or submission-uncertain opening order x its limit x 100 (net debit for a vertical)',
    'each order counted once and released only after its terminal cancel or withdrawal is reconciled',
    'its unfilled opening quantity x its bounded positive limit x 100 (net debit for a vertical)',
    'a partly filled candidate has its filled units in (a) and only the unfilled part here, and the whole candidate is never added twice',
    'exceeds 15% of current account equity, skip the entry and record REJECT with the single number that failed',
    'fresh equity, positions, spread groups and orders from this beat',
    'if any exposure or price bound cannot be read or reconciled, skip the entry instead of assuming zero',
    'equity, direction, held cost, reserved cost, candidate cost and the resulting percent',
    'Existing sizing, max-position limits and every exit are unchanged',
  ];
  for (const part of must) assert.ok(rule.includes(part), part.slice(0, 70));
  // New openings only: it never asks for a sale.
  assert.doesNotMatch(rule, /\b(close|sell|reduce|liquidate)\b.*\bbecause\b.*\b15%/i);
});

test('B2 and the live sizing and AlphaDesk text stay in place (nothing replaced)', async () => {
  const prompt = await render('catalyst-news');
  assert.match(prompt, /Size each new entry at no less than 5% of current account equity/);
  assert.match(prompt, /AlphaDesk-guarded openings are limited to 10 contracts per order/);
  assert.ok(prompt.indexOf('For every candidate that you rejected') < prompt.indexOf('Direction budget (new openings only'));
});
