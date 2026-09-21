import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('portfolio positions proxy uses the general broker positions endpoint', async () => {
  const server = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
  const route = server.match(/app\.get\('\/api\/portfolio\/positions'[\s\S]*?\n\}\);/u)?.[0];
  assert.ok(route, 'portfolio positions proxy route should exist');
  assert.match(route, /getGoClientForSandbox\(req\.query\.sandboxId\)/);
  assert.match(route, /client\.get\('\/api\/v1\/positions'\)/);
  assert.match(route, /res\.json\(data\)/);
  assert.doesNotMatch(route, /\/api\/v1\/options\/positions/);
});
