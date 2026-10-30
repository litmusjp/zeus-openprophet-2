import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { renderToolMenu, renderPrefixedToolMenu } from '../agent/tool-catalog.js';
import { buildSystemPrompt } from '../agent/harness.js';

const settingsHtml = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

test('curated tool catalog and rendered menu include AlphaDesk assessment', () => {
  assert.match(renderToolMenu(), /\*\*Options\*\*: get_options_assessment_policy, assess_options_trade,/);
});

test('trading prompt menu hides operator-only permission and forced cadence controls but retains research', () => {
  const menu = renderPrefixedToolMenu({ heartbeatIntervalsForced: true });
  assert.doesNotMatch(menu, /prophet_update_permissions|prophet_set_heartbeat|prophet_apply_heartbeat_profile|prophet_update_heartbeat_phase/);
  assert.match(menu, /prophet_analyze_stocks/);
  assert.match(menu, /prophet_get_quote/);
  assert.match(menu, /prophet_get_options_chain/);
  assert.match(renderToolMenu(), /set_heartbeat/);
  assert.doesNotMatch(renderToolMenu(), /update_permissions/);
});

test('curated tool catalog exposes the read-only assessment policy lookup', () => {
  assert.match(renderToolMenu(), /get_options_assessment_policy/);
});

test('generated system prompt documents the AlphaDesk assessment workflow', async () => {
  const prompt = await buildSystemPrompt({
    name: 'Test Agent',
    description: 'Test',
    systemPromptTemplate: 'custom',
    customSystemPrompt: 'You are a test agent.',
  });

  assert.match(prompt, /prophet_assess_options_trade/);
  assert.match(prompt, /prophet_get_options_assessment_policy/);
  assert.match(prompt, /max_investment_per_candidate/);
  assert.match(prompt, /maximum affordable premium as max_investment_per_candidate divided by \(quantity \* standard contract multiplier\)/);
  assert.match(prompt, /quantity within maximum_contracts_per_candidate/);
  assert.match(prompt, /POLICY_ONLY response/);
  assert.match(prompt, /either OP2 confirmation or the freshly read managed review lock ON or unknown blocks new options entries/i);
  assert.match(prompt, /for the exact proposal/);
  assert.match(prompt, /Decision is PASS, FAIL or UNAVAILABLE/);
  assert.match(prompt, /signal scores are nullable provider-owned evidence/);
  assert.match(prompt, /Assessment PASS is trade-quality evidence only, never account permission or broker authorization/);
  assert.match(prompt, /independently reassesses the exact proposal at the final broker boundary/);
  assert.match(prompt, /For an eligible proposal, prefer one guarded `prophet_place_options_order` call; the backend independently obtains and enforces a fresh genuine PASS/);
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
  assert.match(prompt, /when its gate is enabled/);
  assert.match(prompt, /final broker boundary.*account, paper, identity, permission, market, risk and reconciliation checks/);
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
