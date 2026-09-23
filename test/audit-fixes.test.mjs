import test from 'node:test';
import assert from 'node:assert/strict';
import { readNewsSummaryFile } from '../news_summary.js';
import { isEligibleTradeRecord } from '../vectorDB.js';

test('missing news summaries become structured not-found results', async () => {
  const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
  const result = await readNewsSummaryFile({ readFile: async () => { throw error; } }, '/safe/missing.md', 'missing.md');
  assert.deepEqual(result, { found: false, result: { status: 'not_found', category: 'news_summary', filename: 'missing.md' } });
});

test('non-ENOENT news summary errors remain errors', async () => {
  const error = Object.assign(new Error('denied'), { code: 'EACCES' });
  await assert.rejects(() => readNewsSummaryFile({ readFile: async () => { throw error; } }, '/safe/denied.md', 'denied.md'), /denied/);
});

test('similarity eligibility preserves valid manual and broker opening entries', () => {
  assert.equal(isEligibleTradeRecord({ provenance: 'explicit_store_trade_setup', status: 'manual', action: 'SELL' }), true);
  assert.equal(isEligibleTradeRecord({ provenance: 'broker_confirmed_fill', status: 'filled', action: 'buy' }), true);
  assert.equal(isEligibleTradeRecord({ provenance: 'broker_confirmed_fill', status: 'canceled', action: 'buy' }), true);
  for (const status of ['test', 'validation', 'unconfirmed', 'rejected', 'failed']) {
    assert.equal(isEligibleTradeRecord({ provenance: 'manual', status, action: 'BUY' }), false, status);
  }
  assert.equal(isEligibleTradeRecord({ provenance: 'broker_confirmed_fill', status: 'filled', action: 'sell' }), false);
});
