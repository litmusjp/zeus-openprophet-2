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
  assert.match(prompt, /before opening or increasing options exposure/i);
  assert.match(prompt, /exact proposed trade/);
  assert.match(prompt, /PASS\/FAIL\/unavailable result and signal score/);
  assert.match(prompt, /assessment-only and is not broker authorization/);
  assert.match(prompt, /independently reassesses immediately before broker submission/);
  assert.match(prompt, /Client-supplied or replayed assessments do not authorize execution/);
  assert.match(prompt, /AlphaDesk PASS alone never authorizes an order/);
});

test('generated system prompt clarifies zero maxOrderValue semantics', async () => {
  const prompt = await buildSystemPrompt({
    name: 'Test Agent',
    description: 'Test',
    systemPromptTemplate: 'custom',
    customSystemPrompt: 'You are a test agent.',
  });

  assert.match(prompt, /maxOrderValue=0 means there is no single-order dollar cap; it does not disable trading and is not an order blocker/);
  assert.match(prompt, /A positive maxOrderValue is the only time the dollar cap applies/);
  assert.match(prompt, /All other configured risk limits and permission flags still apply/);
});

test('generated system prompt contains the approved evidence and privacy clarifications', async () => {
  const prompt = await buildSystemPrompt({
    name: 'Test Agent',
    description: 'Test',
    systemPromptTemplate: 'custom',
    customSystemPrompt: 'You are a test agent.',
  });

  assert.match(prompt, /heartbeat interval comes from heartbeat context|heartbeat context.*guardrails/i);
  assert.match(prompt, /sandbox AlphaDesk plugin\/config.*enabled/);
  assert.match(prompt, /broker boundary independently refreshes evidence and fails closed/);
  assert.match(prompt, /stale MarketWatch.*informational only.*never current market evidence/i);
  assert.match(prompt, /daily loss.*broker account.*not from a dedicated status tool/i);
  assert.match(prompt, /find_similar_setups.*advisory.*materially relevant matches/i);
});

test('manager prompt warns about sensitive session context data', () => {
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const start = server.indexOf('get_session_context:');
  const end = server.indexOf('create_agent:', start);
  const block = server.slice(start, end);
  assert.match(block, /prior messages, tool args, and results may be returned/i);
  assert.match(block, /never put credentials|unnecessary sensitive data/i);
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
