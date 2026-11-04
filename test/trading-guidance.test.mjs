import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_TRADING_GUIDANCE, normalizeTradingGuidance, renderTradingGuidance, loadTradingGuidance,
  getTradingGuidanceForSandbox, setTradingGuidanceForSandbox, resetTradingGuidanceStoreForTests,
} from '../agent/trading-guidance.js';
import { buildSystemPrompt } from '../agent/harness.js';

test('defaults are the approved values', () => {
  assert.deepEqual({ ...DEFAULT_TRADING_GUIDANCE }, {
    contractDeltaMin: 0.45, contractDeltaMax: 0.65, expiryMinDays: 30, expiryMaxDays: 60, minEntryPct: 5,
    extendedPct: 3, marketSymbol: 'SPY', nearSupportPct: 1.5, avgSlopeMinPct: -0.15, extraSymbolsPerScan: 25,
    dailyAlphaDeskCheck: true,
  });
});

test('strict validation rejects bad saves; stored bad values fall back to defaults', () => {
  assert.throws(() => normalizeTradingGuidance({ contractDeltaMin: 0.8, contractDeltaMax: 0.5 }, { strict: true }), /lower than/);
  assert.throws(() => normalizeTradingGuidance({ expiryMinDays: 90, expiryMaxDays: 30 }, { strict: true }), /must not exceed/);
  assert.throws(() => normalizeTradingGuidance({ minEntryPct: 'lots' }, { strict: true }), /minEntryPct/);
  assert.throws(() => normalizeTradingGuidance({ expiryMinDays: 10.5 }, { strict: true }), /whole number/);
  assert.throws(() => normalizeTradingGuidance({ marketSymbol: 'not a symbol' }, { strict: true }), /ticker/);
  assert.throws(() => normalizeTradingGuidance({ dailyAlphaDeskCheck: 'yes' }, { strict: true }), /true or false/);
  assert.equal(normalizeTradingGuidance({ minEntryPct: 999 }).minEntryPct, 5);
  assert.equal(normalizeTradingGuidance({ extendedPct: '4.5', marketSymbol: 'qqq' }, { strict: true }).marketSymbol, 'QQQ');
});

test('rendered guidance states the values, keeps AlphaDesk mandatory, and respects switches', () => {
  const text = renderTradingGuidance();
  assert.match(text, /delta about 0.45 to 0.65, expiring 30 to 60 calendar days/);
  assert.match(text, /more than 3% above the broken level/);
  assert.match(text, /SPY closed above its 20-day average, or that average is rising/);
  assert.match(text, /within 1.5% of the lowest low of the prior 20 sessions/);
  assert.match(text, /not an order and not permission.*fresh genuine AlphaDesk PASS inside prophet_place_options_order/);
  assert.match(text, /up to 25 more symbols/);
  const custom = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, extendedPct: 4, dailyAlphaDeskCheck: false, extraSymbolsPerScan: 0 });
  assert.match(custom, /more than 4% above/);
  assert.doesNotMatch(custom, /Daily AlphaDesk check/);
  assert.match(custom, /check only the symbols in your SCAN UNIVERSE/);
});

test('saved guidance persists per sandbox and reaches the system prompt', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-guidance-'));
  const previous = process.env.OPENPROPHET_DATA_DIR;
  process.env.OPENPROPHET_DATA_DIR = dir;
  t.after(async () => { process.env.OPENPROPHET_DATA_DIR = previous; if (previous === undefined) delete process.env.OPENPROPHET_DATA_DIR; resetTradingGuidanceStoreForTests(); await fs.rm(dir, { recursive: true, force: true }); });
  resetTradingGuidanceStoreForTests();
  await loadTradingGuidance();
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 3);
  await setTradingGuidanceForSandbox('sbx_a', { extendedPct: 4, minEntryPct: 6 });
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 4);
  assert.equal(getTradingGuidanceForSandbox('sbx_b').extendedPct, 3, 'other sandboxes are unaffected');
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { bogus: 1 }), /Unknown trading guidance field/);
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { extendedPct: 500 }), /extendedPct/);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 4, 'a rejected save changes nothing');
  resetTradingGuidanceStoreForTests();
  await loadTradingGuidance();
  assert.equal(getTradingGuidanceForSandbox('sbx_a').minEntryPct, 6, 'reloads from disk');

  const prompt = await buildSystemPrompt(
    { id: 'momentum', sandboxId: 'sbx_a', name: 'Surge', systemPromptTemplate: 'custom', strategyId: 's', customSystemPrompt: 'Surge identity.' },
    { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: getTradingGuidanceForSandbox('sbx_a') });
  assert.match(prompt, /more than 4% above the broken level/);
  assert.match(prompt, /no less than 6% of current account equity/);
  assert.ok(prompt.indexOf('## Trading Guidance') > prompt.indexOf('## Strategy Rules'));
});

test('minimum-entry sizing and remaining-capacity prompt use the configured minimum', async () => {
  const prompt = await buildSystemPrompt(
    { id: 'momentum', sandboxId: 'sbx_custom', name: 'Surge', systemPromptTemplate: 'custom', strategyId: 's', customSystemPrompt: 'Surge identity.' },
    { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: { ...DEFAULT_TRADING_GUIDANCE, minEntryPct: 3.5 } });
  assert.match(prompt, /no less than 3\.5% of current account equity/);
  assert.match(prompt, /remaining capacity is below 3\.5%/);
  assert.doesNotMatch(prompt, /remaining capacity is below 5%/);
});

test('a failed durable write does not poison the next guidance save or update memory', async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-guidance-write-'));
  const dir = path.join(parent, 'not-a-directory');
  await fs.writeFile(dir, 'block mkdir');
  const previous = process.env.OPENPROPHET_DATA_DIR;
  process.env.OPENPROPHET_DATA_DIR = dir;
  resetTradingGuidanceStoreForTests();
  t.after(async () => {
    process.env.OPENPROPHET_DATA_DIR = previous;
    if (previous === undefined) delete process.env.OPENPROPHET_DATA_DIR;
    resetTradingGuidanceStoreForTests();
    await fs.rm(parent, { recursive: true, force: true });
  });
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { extendedPct: 4 }), /ENOTDIR|EEXIST|not a directory/i);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, DEFAULT_TRADING_GUIDANCE.extendedPct);
  await fs.unlink(dir);
  await fs.mkdir(dir);
  const saved = await setTradingGuidanceForSandbox('sbx_a', { extendedPct: 4 });
  assert.equal(saved.extendedPct, 4);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 4);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'trading-guidance.json'), 'utf8')).sandboxes.sbx_a.extendedPct, 4);
});

test('the Settings page exposes the guidance fields and calls the API', async () => {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  for (const id of ['tg-delta-min', 'tg-delta-max', 'tg-expiry-min', 'tg-expiry-max', 'tg-min-entry', 'tg-extended', 'tg-market-symbol', 'tg-near-support', 'tg-slope', 'tg-extra-symbols', 'tg-daily-check']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.match(html, /\/api\/trading-guidance/);
});
