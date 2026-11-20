import test from 'node:test';
import assert from 'node:assert/strict';
import { getEarningsDates, EARNINGS_BATCH_SIZE } from '../earnings-batching.js';

// D4: any number of symbols, batches of 30, per-symbol unknown / error / completeness kept.
const names = n => Array.from({ length: n }, (_, i) => `S${String(i + 1).padStart(3, '0')}`);
const reply = (symbols, over = {}) => ({
  source: 'public-calendar', window_start: '2026-11-19', window_end: '2026-12-10', complete: true,
  results: symbols.map(symbol => ({ symbol, status: 'none_found_in_window' })), note: 'Public calendar data.', ...over,
});
const backend = (fail = []) => {
  const calls = [];
  const lookup = async (batch, days) => {
    calls.push({ batch, days });
    if (fail.includes(calls.length)) throw new Error('Trading bot request failed: status 503');
    return reply(batch);
  };
  return { calls, lookup };
};

test('D4 (+): up to 30 symbols is one call, passed through unchanged', async () => {
  for (const n of [1, 25, 30]) {
    const { calls, lookup } = backend();
    const symbols = names(n);
    const out = await getEarningsDates({ symbols, days: 21 }, lookup);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].batch, symbols);
    assert.equal(calls[0].days, 21);
    assert.equal(out.batches, undefined, 'a single call answer is not re-shaped');
    assert.equal(out.results.length, n);
  }
});

test('D4 (+): 31 symbols are split 30 + 1 and merged in the original order', async () => {
  const { calls, lookup } = backend();
  const symbols = names(31);
  const out = await getEarningsDates({ symbols, days: 21 }, lookup);
  assert.deepEqual(calls.map(c => c.batch.length), [30, 1]);
  assert.ok(calls.every(c => c.days === 21));
  assert.equal(out.results.length, 31);
  assert.deepEqual(out.results.map(r => r.symbol), symbols);
  assert.equal(out.complete, true);
  assert.equal(out.batches, 2);
  assert.equal(out.source, 'public-calendar');
  assert.equal(out.window_start, '2026-11-19');
});

test('D4 (+): 61 symbols are split 30 + 30 + 1', async () => {
  const { calls, lookup } = backend();
  const symbols = names(61);
  const out = await getEarningsDates({ symbols }, lookup);
  assert.deepEqual(calls.map(c => c.batch.length), [EARNINGS_BATCH_SIZE, EARNINGS_BATCH_SIZE, 1]);
  assert.deepEqual(out.results.map(r => r.symbol), symbols);
  assert.equal(out.batches, 3);
  assert.equal(calls[0].days, undefined);
});

test('D4 (-): one failed batch marks only its own symbols unknown with an error, never none-found', async () => {
  const { lookup } = backend([2]); // the second batch fails
  const symbols = names(61);
  const out = await getEarningsDates({ symbols }, lookup);
  assert.equal(out.complete, false);
  const bySymbol = new Map(out.results.map(r => [r.symbol, r]));
  for (const symbol of symbols.slice(0, 30)) assert.equal(bySymbol.get(symbol).status, 'none_found_in_window', symbol);
  for (const symbol of symbols.slice(30, 60)) {
    assert.equal(bySymbol.get(symbol).status, 'unknown', symbol);
    assert.match(bySymbol.get(symbol).error, /earnings batch failed/);
  }
  assert.equal(bySymbol.get(symbols[60]).status, 'none_found_in_window');
});

test('D4 (-): an incomplete batch (failed calendar days) keeps the merged answer incomplete and unions the failed dates', async () => {
  const calls = [];
  const lookup = async batch => {
    calls.push(batch);
    return calls.length === 1
      ? reply(batch, { complete: false, failed_dates: ['2026-11-24'], results: batch.map(symbol => ({ symbol, status: 'unknown' })) })
      : reply(batch, { complete: false, failed_dates: ['2026-11-23', '2026-11-24'] });
  };
  const out = await getEarningsDates({ symbols: names(35) }, lookup);
  assert.equal(out.complete, false);
  assert.deepEqual(out.failed_dates, ['2026-11-23', '2026-11-24']);
  assert.equal(out.results.filter(r => r.status === 'unknown').length, 30);
});

test('D4 (-): every batch failing returns unknown for all symbols and never a complete answer', async () => {
  const { lookup } = backend([1, 2]);
  const out = await getEarningsDates({ symbols: names(40) }, lookup);
  assert.equal(out.complete, false);
  assert.equal(out.results.length, 40);
  assert.ok(out.results.every(r => r.status === 'unknown'));
});

test('D4: duplicates and blanks are removed before counting, so 31 names with a duplicate stay one call', async () => {
  const { calls, lookup } = backend();
  const symbols = [...names(30), 'S001', ' ', 's002'];
  const out = await getEarningsDates({ symbols }, lookup);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].batch.length, 30);
  assert.equal(out.results.length, 30);
});
