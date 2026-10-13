import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { safeDecisionFilenameComponent } from '../mcp-decision-filename.js';

test('decision filename components preserve ordinary tickers and cannot escape the decision directory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'op-decision-'));
  const decisions = path.join(root, 'decisive_actions');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(decisions));
  try {
    for (const symbol of ['XLE', 'OXY', 'GDX', 'IREN', '../outside', 'X/../../outside', 'X\\..\\outside']) {
      const filename = `${safeDecisionFilenameComponent('buy')}_${safeDecisionFilenameComponent(symbol)}.json`;
      const target = path.resolve(decisions, filename);
      assert.equal(path.dirname(target), decisions);
      await writeFile(target, JSON.stringify({ symbol }));
      assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), { symbol });
    }
    assert.deepEqual((await readdir(root)).sort(), ['decisive_actions']);
    assert.deepEqual((await readdir(decisions)).length, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
