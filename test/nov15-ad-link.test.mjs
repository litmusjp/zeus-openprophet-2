import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AgentHarness } from '../agent/harness.js';
import { buildGoBackendEnv } from '../agent/orchestrator.js';
import { pushOptionSpreadCap } from '../agent/option-spread-cap.js';
import {
  DEFAULT_TRADING_GUIDANCE, renderAlphaDeskPolicyFacts, renderTradingGuidance, setTradingGuidanceForSandbox,
  getTradingGuidanceForSandbox, resetTradingGuidanceStoreForTests,
} from '../agent/trading-guidance.js';

const serverSource = await fs.readFile(new URL('../agent/server.js', import.meta.url), 'utf8');
const account = { id: 'acct', publicKey: 'pk', secretKey: 'sk', brokerAccountId: 'broker', paper: true };
const goEnv = extra => buildGoBackendEnv({}, { account, sandboxId: 'sbx', processNonce: 'n', port: 4555, databasePath: 'db', activityLogDir: 'logs', permissions: {}, ...extra });

// ── O1: the saved cap reaches the Go backend ─────────────────────────────────────────────────────
test('O1: the backend environment carries the sandbox\'s saved spread cap, and only a real number', () => {
  assert.equal(goEnv({ optionSpreadCapPct: 10 }).OPENPROPHET_MAX_OPTION_SPREAD_PCT, '10');
  assert.equal(goEnv({ optionSpreadCapPct: 8.5 }).OPENPROPHET_MAX_OPTION_SPREAD_PCT, '8.5');
  for (const bad of [undefined, null, 'abc', NaN, Infinity]) {
    assert.equal('OPENPROPHET_MAX_OPTION_SPREAD_PCT' in goEnv({ optionSpreadCapPct: bad }), false, `no value for ${String(bad)}`);
  }
  // An inherited value cannot stand in for the saved one.
  const inherited = buildGoBackendEnv({ OPENPROPHET_MAX_OPTION_SPREAD_PCT: '25' }, { account, sandboxId: 'sbx', processNonce: 'n', port: 1, databasePath: 'db', activityLogDir: 'l', permissions: {}, optionSpreadCapPct: 10 });
  assert.equal(inherited.OPENPROPHET_MAX_OPTION_SPREAD_PCT, '10');
});

test('O1: both backend start paths pass the saved guidance value', async () => {
  const orchestratorSource = await fs.readFile(new URL('../agent/orchestrator.js', import.meta.url), 'utf8');
  assert.match(orchestratorSource, /optionSpreadCapPct: getTradingGuidanceForSandbox\(sandboxId\)\.maxOptionSpreadPct/);
  assert.match(serverSource, /optionSpreadCapPct: getTradingGuidanceForSandbox\(sandboxId\)\.maxOptionSpreadPct/);
});

function fakeClient(reply, record = []) {
  return { put: async (url, body, options) => { record.push({ url, body, options }); if (reply instanceof Error) throw reply; return { data: reply }; } };
}

test('O1: a running backend receives the cap with the server-only credential; the answer must match', async () => {
  const calls = [];
  assert.equal(await pushOptionSpreadCap(fakeClient({ effective_pct: 10, configured: true, invalid: false }, calls), 10, { token: 'cap-token' }), true);
  assert.equal(calls[0].url, '/api/v1/risk/option-spread-cap');
  assert.deepEqual(calls[0].body, { pct: 10 });
  assert.equal(calls[0].options.headers['X-OpenProphet-Cap-Control-Token'], 'cap-token');
  assert.equal('X-OpenProphet-Operator-Token' in calls[0].options.headers, false, 'the operator token is not used for cap changes');
  assert.equal(await pushOptionSpreadCap(null, 10), false, 'no running backend: nothing to push');
  await assert.rejects(() => pushOptionSpreadCap(fakeClient({ effective_pct: 8, configured: true, invalid: false }), 10), /different option spread cap/);
  await assert.rejects(() => pushOptionSpreadCap(fakeClient({ effective_pct: 10, configured: true, invalid: true }), 10), /different option spread cap/);
  await assert.rejects(() => pushOptionSpreadCap(fakeClient(Object.assign(new Error('boom'), { response: { data: { error: 'cap control authorization is required' } } })), 10), /did not accept.*cap control authorization is required/);
});

test('O1: a save whose push fails changes nothing; a save whose write fails is rolled back by the handler', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guidance-'));
  const previousDir = process.env.OPENPROPHET_DATA_DIR;
  process.env.OPENPROPHET_DATA_DIR = dir;
  try {
    resetTradingGuidanceStoreForTests();
    assert.equal(getTradingGuidanceForSandbox('sbx_a').maxOptionSpreadPct, DEFAULT_TRADING_GUIDANCE.maxOptionSpreadPct);
    await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { maxOptionSpreadPct: 10 }, { beforePersist: async () => { throw new Error('backend refused'); } }), /backend refused/);
    assert.equal(getTradingGuidanceForSandbox('sbx_a').maxOptionSpreadPct, DEFAULT_TRADING_GUIDANCE.maxOptionSpreadPct, 'nothing saved after a failed push');
    await assert.rejects(() => fs.access(path.join(dir, 'trading-guidance.json')));
    let seen;
    const saved = await setTradingGuidanceForSandbox('sbx_a', { maxOptionSpreadPct: 9 }, { beforePersist: async next => { seen = next.maxOptionSpreadPct; } });
    assert.equal(seen, 9);
    assert.equal(saved.maxOptionSpreadPct, 9);
    assert.equal(getTradingGuidanceForSandbox('sbx_a').maxOptionSpreadPct, 9);
    // A value the validator rejects never reaches the backend.
    let called = false;
    await assert.rejects(() => setTradingGuidanceForSandbox('sbx_a', { maxOptionSpreadPct: 99 }, { beforePersist: async () => { called = true; } }));
    assert.equal(called, false);
  } finally {
    resetTradingGuidanceStoreForTests();
    if (previousDir === undefined) delete process.env.OPENPROPHET_DATA_DIR; else process.env.OPENPROPHET_DATA_DIR = previousDir;
    await fs.rm(dir, { recursive: true, force: true });
  }
  // The save handler goes through the one controller that pushes, confirms and re-checks (tested below).
  const handler = serverSource.slice(serverSource.indexOf("app.put('/api/trading-guidance'"), serverSource.indexOf('// ── Plugins'));
  assert.match(handler, /await optionSpreadCap\.save\(sandboxId, patch\)/);
  assert.doesNotMatch(handler, /setTradingGuidanceForSandbox\(/);
});

// ── O2 / O4: the agent sees the live thresholds, and only what is known ───────────────────────────
const facts = overrides => ({ score_profile: 'catalyst_momentum_v1', minimum_signal_score: 30, minimum_catalyst_confidence: 0.15, minimum_dte: 1, maximum_dte: 180, require_price_action_confirmation: true, op2_option_spread_cap_pct: 10, ...overrides });

test('O4: policy facts render the live values; a confidence floor above 0.15 adds the news requirement', () => {
  const text = renderAlphaDeskPolicyFacts(facts());
  assert.match(text, /ALPHADESK POLICY FACTS \(read now; information only, never order authority\)/);
  assert.match(text, /signal score at least 30; catalyst confidence at least 0.15; option expiry 1 to 180 calendar days; price must be on the matching side of today's open; OP2 refuses an opening whose spread, on AlphaDesk's own quote of the exact contract, is above 10%/);
  assert.match(text, /shared by every agent that uses this AlphaDesk key/);
  assert.doesNotMatch(text, /tagged to it in the last 36 hours/, 'no news line at 0.15');
  assert.doesNotMatch(text, /verifies the direction you propose/, 'v1 gets no v2 wording');
  const strict = renderAlphaDeskPolicyFacts(facts({ minimum_catalyst_confidence: 0.2 }));
  assert.match(strict, /catalyst confidence at least 0.2 \(every symbol then needs at least one Alpaca headline tagged to it in the last 36 hours; a failure for weak confidence is not retryable until news exists\)/);
});

test('O4: v2 adds the direction and information-only economics lines', () => {
  const text = renderAlphaDeskPolicyFacts(facts({ score_profile: 'catalyst_momentum_v2' }));
  assert.match(text, /verifies the direction you propose against its headline wording and today's open/);
  assert.match(text, /Neutral headlines do not block a put/);
  assert.match(text, /never switch direction or setup to obtain a PASS/);
  assert.match(text, /break-even, spread-cost and time-decay figures are information only: copy them into your thesis, never use them to skip or take a trade/);
});

test('O4: unknown or missing facts state nothing', () => {
  for (const value of [undefined, null, {}, [], 'x', 5]) assert.equal(renderAlphaDeskPolicyFacts(value), '');
  const partial = renderAlphaDeskPolicyFacts({ minimum_signal_score: 30 });
  assert.match(partial, /signal score at least 30\./);
  assert.doesNotMatch(partial, /confidence|expiry|spread/);
  assert.doesNotMatch(renderAlphaDeskPolicyFacts(facts({ op2_option_spread_cap_pct: null })), /OP2 refuses an opening/);
  assert.doesNotMatch(renderAlphaDeskPolicyFacts(facts({ require_price_action_confirmation: false })), /matching side/);
});

const sandbox = { plugins: { alphadesk: { enabled: true, requireManagedApprovalGate: true } } };
const managedPolicy = extra => ({ contract_version: 'managed-assessment-v1', assessment_authority: 'assessment_only', approval_gate: {
  required: false, revision: 12, scope: { workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', assessment_key_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }, ...extra });

async function beat(getManagedReviewPolicy) {
  const harness = new AgentHarness({ sandboxId: 'sbx_fixture', accountId: 'acct', getSandbox: () => sandbox, getPermissions: () => ({ requireConfirmation: false }), getManagedReviewPolicy, getCurrentPhaseFn: () => 'closed' });
  harness.state.activeAccountId = 'acct'; harness.state.activeModel = 'fixture/model';
  let input = '';
  harness._runClaude = async prompt => { input = prompt; return { text: 'idle', sessionEpoch: harness._sessionEpoch }; };
  await harness._beat();
  return input;
}

test('O4: the heartbeat block carries the facts read in that beat, and none when the policy read fails', async () => {
  const withFacts = await beat(async () => managedPolicy({ assessment_policy_facts: facts({ minimum_catalyst_confidence: 0.2 }) }));
  assert.match(withFacts, /AlphaDesk review lock=OFF, revision=12/);
  assert.match(withFacts, /ALPHADESK POLICY FACTS/);
  assert.match(withFacts, /signal score at least 30; catalyst confidence at least 0.2/);
  const without = await beat(async () => managedPolicy({}));
  assert.doesNotMatch(without, /ALPHADESK POLICY FACTS/);
  assert.match(without, /AlphaDesk review lock=OFF/);
  const failed = await beat(async () => { throw new Error('down'); });
  assert.doesNotMatch(failed, /ALPHADESK POLICY FACTS/);
  assert.match(failed, /review lock=UNKNOWN/);
});

// ── prompt text ───────────────────────────────────────────────────────────────────────────────
test('O4: the saved prompt states the cap rule once, carries no symbols or dates, and keeps the existing rules', () => {
  for (const strategyId of ['catalyst-news', 'default', 'etf-mean-reversion', 'equity-momentum', 'capital-preservation', 'long-premium-volatility']) {
    const text = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, maxOptionSpreadPct: 10 }, { strategyId });
    assert.equal((text.match(/it refuses an opening whose spread, measured on AlphaDesk's own quote of that exact contract, is above 10%/g) || []).length, 1, strategyId);
    assert.doesNotMatch(text, /Skip a contract whose spread is above/, 'the old generic agent-quote veto is gone');
    assert.doesNotMatch(text, /the spread setting/, 'no separate spread-setting veto either');
    assert.match(text, /Do not add your own cost, edge or spread-versus-target veto/);
    assert.match(text, /record them too \(information only\)/);
    assert.doesNotMatch(text, /\b20\d\d-\d\d-\d\d\b|\bNov(ember)? \d/);
  }
  const herald = renderTradingGuidance(DEFAULT_TRADING_GUIDANCE, { strategyId: 'catalyst-news' });
  assert.match(herald, /AlphaDesk checks your direction against the headline wording and requires price to be on the matching side of today's open/);
  assert.doesNotMatch(herald, /short list of words/);
  assert.match(herald, /Never switch call and put, or change the setup, to obtain a PASS/);
});

test('O4: the spread line follows the saved setting', () => {
  assert.match(renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE, maxOptionSpreadPct: 7.5 }, { strategyId: 'default' }), /spread cap is applied by OP2 itself.*is above 7\.5%\. That quote can be wider/s);
});
