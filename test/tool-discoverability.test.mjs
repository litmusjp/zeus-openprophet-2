import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderToolMenu } from '../agent/tool-catalog.js';
import { buildSystemPrompt } from '../agent/harness.js';

const settingsHtml = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

test('curated tool catalog and rendered menu include AlphaDesk assessment', () => {
  assert.match(renderToolMenu(), /\*\*Options\*\*: assess_options_strategy,/);
});

test('generated system prompt documents the AlphaDesk assessment workflow', async () => {
  const prompt = await buildSystemPrompt({
    name: 'Test Agent',
    description: 'Test',
    systemPromptTemplate: 'custom',
    customSystemPrompt: 'You are a test agent.',
  });

  assert.match(prompt, /prophet_assess_options_strategy/);
  assert.match(prompt, /before opening or increasing options exposure/);
  assert.match(prompt, /exact proposed trade/);
  assert.match(prompt, /PASS\/FAIL\/unavailable result and signal score/);
  assert.match(prompt, /assessment-only and is not broker authorization/);
  assert.match(prompt, /independently reassesses immediately before broker submission/);
  assert.match(prompt, /Client-supplied or replayed assessments do not authorize execution/);
  assert.match(prompt, /AlphaDesk PASS alone never authorizes an order/);
});

test('Settings tool reference includes the assessment-only AlphaDesk description', () => {
  const optionsStart = settingsHtml.indexOf('  Options: {');
  const optionsEnd = settingsHtml.indexOf("  'Market Data': {", optionsStart);
  const optionsBlock = settingsHtml.slice(optionsStart, optionsEnd);

  assert.match(optionsBlock, /assess_options_strategy/);
  assert.match(optionsBlock, /deterministic AlphaDesk PASS\/FAIL\/unavailable/);
  assert.match(optionsBlock, /signal score/);
  assert.match(optionsBlock, /Assessment-only; not broker authorization/);
});
