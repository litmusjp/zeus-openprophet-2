import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { buildSystemPrompt } from '../agent/harness.js';

const catalog = fs.readFileSync(new URL('../agent/tool-catalog.js', import.meta.url), 'utf8');
const harness = fs.readFileSync(new URL('../agent/harness.js', import.meta.url), 'utf8');
const mcp = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');

test('prompt catalog exposes prefixed MCP names, native web tools, and snapshot', async () => {
  assert.match(catalog, /get_market_snapshot/);
  const prompt = await buildSystemPrompt({ name: 'Audit', systemPromptTemplate: 'custom', customSystemPrompt: 'test' });
  assert.match(prompt, /prophet_get_market_snapshot/);
  assert.match(prompt, /Native OpenCode tools .*websearch.*webfetch/i);
});

test('prompt uses relevant current-state facts and documents retry expiry and market states', async () => {
  assert.doesNotMatch(harness, /Call a tool for every fact/);
  const prompt = await buildSystemPrompt({ name: 'Audit', systemPromptTemplate: 'custom', customSystemPrompt: 'test' }, { heartbeatIntervalsForced: true });
  assert.match(prompt, /current-state.*relevant facts/i);
  assert.match(prompt, /expiry|expires/i);
  assert.match(prompt, /market_closed.*wait/);
  assert.match(prompt, /provider_unavailable.*fail closed/);
  assert.match(prompt, /operator-controlled|forbidden/i);
  assert.match(prompt, /withdraw_planned_intent.*stable.*client_order_id.*never calls the broker/i);
});

test('automatic trade memory requires broker-confirmed positive fill evidence', () => {
  assert.match(mcp, /execution_confirmed/);
  assert.match(mcp, /filled_qty/);
  assert.match(mcp, /planned_for_next_session/);
  assert.match(mcp, /submit_failed/);
  assert.match(mcp, /explicit store_trade_setup/i);
  assert.match(mcp, /withdraw_planned_intent/);
  assert.match(mcp, /submission_uncertain/);
});
