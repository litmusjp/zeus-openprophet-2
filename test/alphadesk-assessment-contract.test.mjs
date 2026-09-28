import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');

test('OpenProphet exposes AlphaDesk as read-only assessment, not an order route', () => {
  assert.match(source, /name: 'assess_options_strategy'/);
  assert.match(source, /callTradingBot\('\/options\/assessment', 'POST'/);
  assert.match(source, /name: 'place_options_order'/);
  assert.doesNotMatch(
    source,
    /assess_options_strategy[\s\S]{0,400}place_options_order/,
    'assessment tool must not invoke the order tool',
  );
});
