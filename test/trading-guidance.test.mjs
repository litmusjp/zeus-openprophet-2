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
    contractDeltaMin: 0.40, contractDeltaMax: 0.70, expiryMinDays: 21, expiryMaxDays: 60, minEntryPct: 5,
    extendedPct: 4, marketSymbol: 'SPY', marketTolerancePct: 0.5, marketSlopeMinPct: -0.15,
    nearSupportPct: 2.5, avgSlopeMinPct: -0.30, extraSymbolsPerScan: 25,
    catalystRangeMinutes: 30, catalystMaxGapPct: 12,
  });
  assert.ok(!('dailyAlphaDeskCheck' in DEFAULT_TRADING_GUIDANCE), 'the daily AlphaDesk check setting is retired');
});

test('strict validation rejects bad saves; stored bad values fall back to defaults', () => {
  assert.throws(() => normalizeTradingGuidance({ contractDeltaMin: 0.8, contractDeltaMax: 0.5 }, { strict: true }), /lower than/);
  assert.throws(() => normalizeTradingGuidance({ expiryMinDays: 90, expiryMaxDays: 30 }, { strict: true }), /must not exceed/);
  assert.throws(() => normalizeTradingGuidance({ minEntryPct: 'lots' }, { strict: true }), /minEntryPct/);
  assert.throws(() => normalizeTradingGuidance({ expiryMinDays: 10.5 }, { strict: true }), /whole number/);
  assert.throws(() => normalizeTradingGuidance({ marketSymbol: 'not a symbol' }, { strict: true }), /ticker/);
  assert.throws(() => normalizeTradingGuidance({ marketTolerancePct: 9 }, { strict: true }), /marketTolerancePct/);
  assert.throws(() => normalizeTradingGuidance({ marketSlopeMinPct: -9 }, { strict: true }), /marketSlopeMinPct/);
  assert.equal(normalizeTradingGuidance({ marketTolerancePct: 0 }, { strict: true }).marketTolerancePct, 0, 'zero tolerance is a valid strict setting');
  assert.equal(normalizeTradingGuidance({ minEntryPct: 999 }).minEntryPct, 5);
  assert.equal(normalizeTradingGuidance({ marketTolerancePct: 99 }).marketTolerancePct, 0.5, 'a bad stored value falls back to the default');
  assert.ok(!('dailyAlphaDeskCheck' in normalizeTradingGuidance({ dailyAlphaDeskCheck: true })), 'a stored retired key is ignored');
  assert.equal(normalizeTradingGuidance({ extendedPct: '4.5', marketSymbol: 'qqq' }, { strict: true }).marketSymbol, 'QQQ');
});

test('rendered guidance states the values, keeps AlphaDesk mandatory, and respects switches', () => {
  const text = renderTradingGuidance();
  assert.match(text, /delta about 0.4 to 0.7, expiring 21 to 60 calendar days/);
  assert.match(text, /more than 4% above the broken level/);
  assert.match(text, /SPY meets any one of: \(a\) its last completed close is no more than 0.5% below its 20-day average; \(b\) its latest price now .* is above that 20-day average; \(c\) the 5-session change of that average is -0.15% or higher/);
  assert.match(text, /"Sector supportive" \(single stocks only\) means the same test applied to the stock's sector ETF.*SMH semiconductors/);
  assert.match(text, /within 2.5% \(either side\) of the lowest low of the prior 20 sessions/);
  assert.match(text, /5-session change of the 20-day average is -0.3% or higher/);
  assert.match(text, /Use the ready-made fields from get_daily_features instead of calculating by hand/);
  assert.match(text, /Complete every listed symbol first.*INCOMPLETE_RESEARCH.*up to 25 more symbols.*If you checked no extras, say why/);
  assert.match(text, /record the remaining checks as "not evaluated", never as passed/);
  assert.match(text, /mark a rejected candidate REJECT or NO_SETUP, never PASS/);
  assert.match(text, /prophet_analyze_stocks includes a bar that is still forming/);
  assert.match(text, /choose only a confirmed date; dates it lists as unchecked are unknown, not absent/);
  // the daily AlphaDesk research check is gone entirely; AlphaDesk is only the guarded order call's PASS
  assert.doesNotMatch(text, /Daily AlphaDesk check/);
  assert.doesNotMatch(text, /prophet_assess_options_trade/);
  const custom = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, extendedPct: 5, marketTolerancePct: 1, marketSlopeMinPct: -0.4, extraSymbolsPerScan: 0 });
  assert.match(custom, /more than 5% above/);
  assert.match(custom, /no more than 1% below its 20-day average/);
  assert.match(custom, /5-session change of that average is -0.4% or higher/);
  assert.match(custom, /check only the symbols in your SCAN UNIVERSE/);
});

test('saved guidance persists per sandbox and reaches the system prompt', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-guidance-'));
  const previous = process.env.OPENPROPHET_DATA_DIR;
  process.env.OPENPROPHET_DATA_DIR = dir;
  t.after(async () => { process.env.OPENPROPHET_DATA_DIR = previous; if (previous === undefined) delete process.env.OPENPROPHET_DATA_DIR; resetTradingGuidanceStoreForTests(); await fs.rm(dir, { recursive: true, force: true }); });
  resetTradingGuidanceStoreForTests();
  await loadTradingGuidance();
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 4);
  await setTradingGuidanceForSandbox('sbx_a', { extendedPct: 5, minEntryPct: 6 });
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 5);
  assert.equal(getTradingGuidanceForSandbox('sbx_b').extendedPct, 4, 'other sandboxes are unaffected');
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { bogus: 1 }), /Unknown trading guidance field/);
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { extendedPct: 500 }), /extendedPct/);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 5, 'a rejected save changes nothing');
  // a save from a browser tab opened before the release still carries the retired key: accepted and dropped
  const tolerated = await setTradingGuidanceForSandbox('sbx_a', { extendedPct: 5, dailyAlphaDeskCheck: true });
  assert.ok(!('dailyAlphaDeskCheck' in tolerated), 'the retired key is dropped, not saved');
  assert.ok(!('dailyAlphaDeskCheck' in JSON.parse(await fs.readFile(path.join(dir, 'trading-guidance.json'), 'utf8')).sandboxes.sbx_a));
  resetTradingGuidanceStoreForTests();
  await loadTradingGuidance();
  assert.equal(getTradingGuidanceForSandbox('sbx_a').minEntryPct, 6, 'reloads from disk');

  const prompt = await buildSystemPrompt(
    { id: 'momentum', sandboxId: 'sbx_a', name: 'Surge', systemPromptTemplate: 'custom', strategyId: 's', customSystemPrompt: 'Surge identity.' },
    { getStrategyById: () => ({ customRules: 'Rules.' }), tradingGuidance: getTradingGuidanceForSandbox('sbx_a') });
  assert.match(prompt, /more than 5% above the broken level/);
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
  await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { extendedPct: 6 }), /ENOTDIR|EEXIST|not a directory/i);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, DEFAULT_TRADING_GUIDANCE.extendedPct);
  await fs.unlink(dir);
  await fs.mkdir(dir);
  const saved = await setTradingGuidanceForSandbox('sbx_a', { extendedPct: 6 });
  assert.equal(saved.extendedPct, 6);
  assert.equal(getTradingGuidanceForSandbox('sbx_a').extendedPct, 6);
  assert.equal(JSON.parse(await fs.readFile(path.join(dir, 'trading-guidance.json'), 'utf8')).sandboxes.sbx_a.extendedPct, 6);
});

test('the Settings page exposes the guidance fields and calls the API', async () => {
  const html = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');
  for (const id of ['tg-delta-min', 'tg-delta-max', 'tg-expiry-min', 'tg-expiry-max', 'tg-min-entry', 'tg-extended', 'tg-market-symbol', 'tg-market-tolerance', 'tg-market-slope', 'tg-near-support', 'tg-slope', 'tg-extra-symbols', 'tg-catalyst-range', 'tg-catalyst-gap']) {
    assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  }
  assert.ok(!html.includes('tg-daily-check') && !html.includes('dailyAlphaDeskCheck'), 'the retired daily AlphaDesk check control is gone');
  assert.match(html, /\/api\/trading-guidance/);
});
