import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Agent consistency release: any of the eight agents works on any of the three slots, with its own identity, start list, strategy,
// option fit and permission, and the one shared AlphaDesk workflow. Fixtures are the live config of Nov 22 (before the release)
// and the previews that ran live then ("golden"); the release's config edits are planned by planConsistencyEdits and applied here.

const FX = new URL('./fixtures/agent-consistency/', import.meta.url);
const read = async name => (await fs.readFile(new URL(name, FX), 'utf8')).replace(/\r\n/g, '\n');
const json = async name => JSON.parse(await read(name));
const clone = value => JSON.parse(JSON.stringify(value));

const fx = {
  agents: await json('agents.json'),
  strategies: await json('strategies.json'),
  slots: await json('slots.json'),
  perms: await json('perms.json'),
};
const goldenL1 = await read('golden-L1.txt');
const goldenL2 = await read('golden-L2.txt');
const prophetNov21 = (await read('prophet-nov21-prompt.txt')).split('\n');
const guardianNov21 = (await read('guardian-nov21-prompt.txt')).split('\n');

const { planConsistencyEdits, PROPHET_IDENTITY, PROPHET_UNIVERSE_BLOCK, PROPHET_B2_RULES, PROPHET_RULES, GUARDIAN_UNIVERSE_BLOCK, STRATEGY_FITS } = await import('../agent/consistency-targets.js');
const { ALPHADESK_WORKFLOW_BLOCK } = await import('../agent/alphadesk-workflow.js');
const { buildSystemPrompt, AgentHarness } = await import('../agent/harness.js');
const { DEFAULT_TRADING_GUIDANCE, renderTradingGuidance, strategyFamilyOf } = await import('../agent/trading-guidance.js');
const { renderPrefixedToolMenu } = await import('../agent/tool-catalog.js');
const { hasStartListBlock, isOptionsAgent, permissionPatchForFit, strategyOptionFit, DEFAULT_OPTION_FIT } = await import('../agent/agent-consistency.js');
const { openGroupCloseReminder } = await import('../agent/spread-guidance.js');

// ── the release's config edits, applied to the fixtures ─────────────────────────────────────────────────────────────
const plan = planConsistencyEdits(clone(fx));
function applyPlan(base, edits) {
  const out = clone(base);
  for (const [id, edit] of Object.entries(edits.agentPrompts)) Object.assign(out.agents.find(a => a.id === id), edit);
  for (const [id, edit] of Object.entries(edits.strategyEdits)) Object.assign(out.strategies.find(s => s.id === id), edit);
  for (const [slot, keys] of Object.entries(edits.slotClears)) for (const key of keys) out.slots[slot].agent.overrides[key] = null;
  for (const [slot, patch] of Object.entries(edits.permissions)) Object.assign(out.perms[slot], patch);
  return out;
}
const after = applyPlan(fx, plan);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-agent-consistency-'));
const configPath = path.join(tempDir, 'agent-config.json');
process.env.OPENPROPHET_CONFIG_PATH = configPath;
process.env.OPENPROPHET_EXECUTION_MODE = 'inert';
const SLOT_IDS = ['sbx_723be98b', 'sbx_956ff9e4', 'sbx_0d35471e'];
await fs.writeFile(configPath, JSON.stringify({
  schemaVersion: 2,
  accounts: SLOT_IDS.map((sid, i) => ({ id: `acc${i + 1}`, name: `L${i + 1}`, paper: true })),
  activeAccountId: 'acc1',
  activeSandboxId: SLOT_IDS[0],
  agents: after.agents,
  strategies: after.strategies,
  sandboxes: Object.fromEntries(SLOT_IDS.map((sid, i) => [sid, { id: sid, name: `L${i + 1}`, accountId: `acc${i + 1}`, agent: after.slots[sid].agent, permissions: after.perms[sid] }])),
}, null, 2));
const store = await import('../agent/config-store.js?agent-consistency');
const nodeFsSync = await import('node:fs');
await store.loadConfig();

// Cleaned up when the process exits: a runner-driven after hook can fire while later tests are still saving the config (it made the atomic save flaky).
process.once('exit', () => {
  nodeFsSync.rmSync(tempDir, { recursive: true, force: true });
  delete process.env.OPENPROPHET_CONFIG_PATH;
  delete process.env.OPENPROPHET_EXECUTION_MODE;
});

const guidanceFor = sid => (sid === 'sbx_723be98b' ? { ...DEFAULT_TRADING_GUIDANCE, catalystRangeMinutes: 15, catalystTargetRangeMultiple: 3 } : { ...DEFAULT_TRADING_GUIDANCE });
const promptFor = sid => buildSystemPrompt(store.getResolvedAgentForSandbox(sid), {
  getStrategyById: store.getStrategyById,
  heartbeatIntervalsForced: true,
  tradingGuidance: guidanceFor(sid),
  allowedStructures: store.getPermissionsForSandbox(sid)?.allowedStructures,
  allowOptions: store.getPermissionsForSandbox(sid)?.allowOptions,
});
const menuOf = prompt => prompt.slice(prompt.indexOf('## Available Tools'), prompt.indexOf('OpenCode registers'));

// ── the planned texts are the ones that ran before ──────────────────────────────────────────────────────────────────
test('Prophet is restored from its Nov 21 text and Guardian from its Nov 21 start list, byte for byte', () => {
  assert.equal(PROPHET_IDENTITY, prophetNov21[0]);
  assert.equal(PROPHET_UNIVERSE_BLOCK, prophetNov21.slice(13, 19).join('\n'));
  assert.equal(PROPHET_B2_RULES, prophetNov21.slice(23, 30).join('\n'));
  assert.equal(GUARDIAN_UNIVERSE_BLOCK, guardianNov21.slice(4, 11).join('\n'));
  assert.ok(PROPHET_RULES.startsWith(PROPHET_B2_RULES));
  assert.doesNotMatch(PROPHET_RULES, /Scalps stay single-leg/, 'B2 opens no scalps, so the swing sentence does not mention them');
  assert.match(PROPHET_B2_RULES, /Trade swings only \(a paper-trading trial\): open no new same-session scalps\./);
});

test('the plan: what changes and what does not', () => {
  assert.deepEqual(Object.keys(plan.agentPrompts).sort(), ['catalyst', 'conservative', 'default', 'long-vol', 'macro-rotation', 'mean-reversion', 'trend-follower']);
  assert.equal(plan.agentPrompts.default.systemPromptTemplate, 'custom', 'the template must be custom or the text never renders');
  for (const id of ['catalyst', 'mean-reversion']) assert.doesNotMatch(plan.agentPrompts[id].customSystemPrompt, /MARKET-OPEN ALPHADESK WORKFLOW/, `${id} keeps no saved workflow copy`);
  assert.match(plan.agentPrompts.catalyst.customSystemPrompt, /### CATALYST UNIVERSE/);
  assert.equal(plan.strategyEdits['catalyst-news'].customRules, fx.slots.sbx_723be98b.agent.overrides.customStrategyRules);
  assert.match(plan.strategyEdits['catalyst-news'].customRules, /paper-trading trial, not a proven improvement\): open a call only when the last completed daily close is above its 20-day average/);
  assert.deepEqual(plan.slotClears.sbx_723be98b, ['customSystemPrompt', 'customStrategyRules', 'systemPromptTemplate', 'description']);
  assert.deepEqual(plan.permissions, { sbx_956ff9e4: { allowedStructures: ['long_call', 'bull_call_debit'] } });
  assert.match(fx.strategies.find(s => s.id === 'etf-mean-reversion').customRules, /â€“/);
  assert.doesNotMatch(plan.strategyEdits['etf-mean-reversion'].customRules, /â€/);
  assert.match(plan.strategyEdits['etf-mean-reversion'].customRules, /intended hold is 1-10 trading sessions/);
  // Surge already has its list and nothing else to change: only its fit is added.
  assert.equal(plan.agentPrompts.momentum, undefined);
  assert.deepEqual(plan.strategyEdits['equity-momentum'], { optionStructures: ['long_call', 'bull_call_debit'] });
  // Idempotent: planning again over the result changes no text.
  const second = planConsistencyEdits(clone(after));
  assert.deepEqual(Object.keys(second.agentPrompts).sort(), ['catalyst', 'default', 'mean-reversion']);
  for (const id of ['catalyst', 'mean-reversion']) assert.equal(second.agentPrompts[id].customSystemPrompt, plan.agentPrompts[id].customSystemPrompt);
  assert.deepEqual(second.permissions, {});
});

// Nov 24: B1 (all agents) and B2 (catalyst family only) are the only intended changes against the Nov 22 live previews.
const B1_ADDED = " For entry screening, a strategy condition evaluated on usable data that fails is NO_SETUP; skipped, unfinished or unverified research remains INCOMPLETE_RESEARCH under your existing rules. Use DATA_BLOCK when unavailable required usable data prevents an otherwise required action; in particular, a due exit with no fresh exact-contract quote remains DATA_BLOCK under the exit rule, and is still due.";
const B2_ADDED = " Direction budget (new openings only, never a reason to sell): before any new opening, price the direction you would add. Bullish means a long call or bull-call debit; bearish means a long put or bear-put debit; never net the two directions. Add (a) held cost: remaining quantity x the broker average entry premium x 100 for each single option, an intact vertical counted once as remaining spread units x its recorded filled net debit x 100, inherited lots included; (b) reserved cost: the unfilled opening quantity of every working, planned or submission-uncertain opening order x its limit x 100 (net debit for a vertical), each order counted once and released only after its terminal cancel or withdrawal is reconciled; (c) the candidate: its unfilled opening quantity x its bounded positive limit x 100 (net debit for a vertical); a partly filled candidate has its filled units in (a) and only the unfilled part here, and the whole candidate is never added twice. If (a)+(b)+(c) in that direction exceeds 15% of current account equity, skip the entry and record REJECT with the single number that failed. Use fresh equity, positions, spread groups and orders from this beat; if any exposure or price bound cannot be read or reconciled, skip the entry instead of assuming zero. In the entry decision log equity, direction, held cost, reserved cost, candidate cost and the resulting percent. Existing sizing, max-position limits and every exit are unchanged.";
const DECISIVE = 'a scan that skipped candidates is INCOMPLETE_RESEARCH, not NO_SETUP.';
const CATALYST_END = '(for example the gap percent, the range break or the volume versus the range baseline) in the decision log.';
const withB1 = text => { assert.equal(text.split(DECISIVE).length - 1, 1); return text.replace(DECISIVE, DECISIVE + B1_ADDED); };
const stripB1 = text => { assert.equal(text.split(B1_ADDED).length - 1, 1); return text.replace(B1_ADDED, ''); };
const withB2 = text => { assert.equal(text.split(CATALYST_END).length - 1, 1); return text.replace(CATALYST_END, CATALYST_END + B2_ADDED); };
// Nov 25: baseline (05cfd92) and allowed delta; defined before the first test because tests start while the module is still evaluating
const NOV25 = JSON.parse(await fs.readFile(new URL('../nov25/delta.json', FX), 'utf8'));
const BASE25 = JSON.parse(await fs.readFile(new URL('../nov25/baseline-05cfd92.json', FX), 'utf8'));
// Nov 26: the allowed delta on top of the Nov 25 chain (fixtures/nov26/delta.json). Current render = BASE25 + NOV25 delta + NOV26 delta.
const NOV26 = JSON.parse(await fs.readFile(new URL('../nov26/delta.json', FX), 'utf8'));
const count25 = (text, part) => text.split(part).length - 1;
const forward25 = (text, entries) => { for (const e of entries) { assert.equal(count25(text, e.old), 1, e.old.slice(0, 70)); text = text.replace(e.old, () => e.new); } return text; };
const expected25 = base => {
  let text = forward25(base, NOV25.shared);
  if (base.includes('Catalyst discovery:')) return forward25(text, NOV25.catalyst);
  for (const e of NOV25.catalyst) assert.equal(count25(base, e.old), 0, 'a non-catalyst prompt never carries the catalyst owners');
  return text;
};
const expected26 = base => {
  let text = forward25(expected25(base), NOV26.shared);
  if (base.includes('Catalyst discovery:')) return forward25(text, NOV26.catalyst);
  for (const e of NOV26.catalyst) assert.equal(count25(text, e.new), 0, 'a non-catalyst prompt never carries the Nov 26 catalyst clauses');
  return text;
};
const revert26 = text => {
  for (const e of NOV26.shared) { assert.equal(count25(text, e.new), 1, e.new.slice(0, 70)); text = text.replace(e.new, () => e.old); }
  const catalyst = count25(text, NOV26.catalyst[0].new) === 1;
  for (const e of NOV26.catalyst) {
    if (catalyst) { assert.equal(count25(text, e.new), 1, e.new.slice(0, 70)); text = text.replace(e.new, () => e.old); }
    else assert.equal(count25(text, e.new), 0);
  }
  return text;
};
// revert25 takes a CURRENT render all the way back to the 05cfd92 baseline (Nov 26 delta first, then the Nov 25 delta)
const revert25 = text => revertNov25(revert26(text));
const revertNov25 = text => {
  for (const e of NOV25.shared) { assert.equal(count25(text, e.new), 1, e.new.slice(0, 70)); text = text.replace(e.new, () => e.old); }
  const catalyst = count25(text, NOV25.catalyst[0].new) === 1;
  for (const e of NOV25.catalyst) {
    if (catalyst) { assert.equal(count25(text, e.new), 1, e.new.slice(0, 70)); text = text.replace(e.new, () => e.old); }
    else assert.equal(count25(text, e.new), 0);
  }
  return text;
};

// ── Herald and Pendulum keep today's prompts byte for byte (attribution for Monday's first spreads) ───────────────
test('Herald on L1 renders byte-identical to the live preview, apart from the new option-groups menu entry', async () => {
  const expected = withB2(withB1(goldenL1.replace(/^(\*\*Options\*\*: .*)$/m, '$1, prophet_get_option_groups')));
  assert.notEqual(expected, goldenL1);
  const actualNow = await promptFor('sbx_723be98b');
  assert.equal(actualNow, expected26(BASE25['live:sbx_723be98b']), 'baseline 05cfd92 plus only the approved Nov 25 and Nov 26 deltas');
  const actual = revert25(actualNow);
  assert.equal(actual, expected);
});

test('Pendulum on L2 renders byte-identical to the live preview, apart from the menu entry and the one shared retry paragraph', async () => {
  const l1Paragraph = goldenL1.slice(goldenL1.indexOf('Only a genuine PASS for the unchanged proposal can proceed, and you never make a second submission of the same intent.'), goldenL1.indexOf('Never trade merely to obtain a PASS.') + 'Never trade merely to obtain a PASS.'.length);
  const old = 'Only its genuine PASS for the unchanged proposal can proceed; do not make a second submission.';
  assert.ok(l1Paragraph.length > 400 && goldenL2.includes(old));
  // The third allowed difference: the corrupted dash in the ETF rules is fixed (config edit C6).
  const expected = goldenL2.replace(old, l1Paragraph).replace(/^(\*\*Options\*\*: .*)$/m, '$1, prophet_get_option_groups').split('â€“').join('-');
  const actualNow = await promptFor('sbx_956ff9e4');
  assert.equal(actualNow, expected26(BASE25['live:sbx_956ff9e4']), 'baseline 05cfd92 plus only the shared Nov 25 and Nov 26 clauses');
  const actual = stripB1(revert25(actualNow));
  assert.equal(actual, expected);
});

test('Prophet on L3 gets its restored identity, list and B2 rules, and the shared workflow between identity and list', async () => {
  const prompt = await promptFor('sbx_0d35471e');
  assert.equal(prompt, expected26(BASE25['live:sbx_0d35471e']), 'baseline 05cfd92 plus only the shared Nov 25 and Nov 26 clauses');
  assert.ok(prompt.startsWith(PROPHET_IDENTITY));
  assert.ok(prompt.includes(PROPHET_UNIVERSE_BLOCK));
  for (const line of PROPHET_B2_RULES.split('\n')) assert.ok(prompt.includes(line), line.slice(0, 60));
  assert.equal(prompt.split('### MARKET-OPEN ALPHADESK WORKFLOW').length - 1, 1);
  assert.ok(prompt.indexOf(PROPHET_IDENTITY) < prompt.indexOf('### MARKET-OPEN ALPHADESK WORKFLOW'));
  assert.ok(prompt.indexOf('### MARKET-OPEN ALPHADESK WORKFLOW') < prompt.indexOf('### SCAN UNIVERSE'));
  assert.match(prompt, /Debit vertical mechanics \(your permissions allow: bull call debit and bear put debit\)/);
  assert.match(prompt, /Scan coverage: your SCAN UNIVERSE is a start list, not a limit/);
});

// ── 8 agents x 3 slots ──────────────────────────────────────────────────────────────────────────────────────────────
const AGENT_IDS = after.agents.map(a => a.id);
const FAMILY_CHECKS = {
  default: p => assert.match(p, /Label each position a scalp or a swing at entry/),
  conservative: p => { assert.match(p, /"Near support" means/); assert.doesNotMatch(p, /"Extended" means/); assert.doesNotMatch(p, /\(Used by breakout strategies/); },
  momentum: p => assert.match(p, /"Extended" means/),
  'mean-reversion': p => { assert.match(p, /"Near support" means/); assert.match(p, /"Market supportive" means/); },
  'macro-rotation': p => assert.match(p, /Your strategy trades shares only and is not activated/),
  'trend-follower': p => assert.match(p, /Your strategy trades shares only and is not activated/),
  catalyst: p => assert.match(p, /Catalyst discovery:/),
  'long-vol': p => assert.match(p, /Thesis: your Strategy Rules decide every entry and exit/),
};

async function switchTo(slot, agentId, overrides) {
  await store.updateSandboxAgentSelection(slot, overrides ? { activeAgentId: agentId, overrides } : { activeAgentId: agentId });
}

for (const slot of SLOT_IDS) {
  for (const agentId of AGENT_IDS) {
    test(`switch matrix: ${agentId} on ${store.getSandbox(slot).name}`, async () => {
      // Leave the slot dirty the way a previous agent did (the Nov 21 bug): another agent's strategy and cadence on its overrides.
      const other = agentId === 'conservative' ? 'default' : 'conservative';
      await switchTo(slot, other);
      await store.updateSandboxAgentOverrides(slot, { strategyId: 'capital-preservation', heartbeatOverrides: { midday: 999 } });
      await switchTo(slot, agentId);

      const agent = after.agents.find(a => a.id === agentId);
      const resolved = store.getResolvedAgentForSandbox(slot);
      assert.equal(resolved.id, agentId);
      assert.equal(resolved.strategyId, agent.strategyId, 'runs its own strategy, not the previous agent\'s');
      assert.deepEqual(resolved.heartbeatOverrides, agent.heartbeatOverrides, 'runs its own cadence');
      assert.equal(resolved.customStrategyRules, null);

      const fit = STRATEGY_FITS[agent.strategyId];
      const perms = store.getPermissionsForSandbox(slot);
      if (fit.length) {
        assert.equal(perms.allowOptions, true);
        assert.deepEqual([...perms.allowedStructures].sort(), [...fit].sort(), 'the slot permission follows the agent');
      } else {
        assert.equal(perms.allowOptions, false, 'a share-only strategy never gets options');
      }

      const prompt = await promptFor(slot);
      const identityLine = agent.customSystemPrompt.split('\n')[0];
      assert.ok(prompt.startsWith(identityLine), `own identity first: ${identityLine.slice(0, 50)}`);
      const startLine = agent.customSystemPrompt.split('\n').find(line => line.startsWith('Start '));
      assert.ok(startLine, `${agentId} has a start list`);
      assert.ok(prompt.includes(startLine), 'its own start list');
      const strategy = after.strategies.find(s => s.id === agent.strategyId);
      assert.ok(prompt.includes(strategy.customRules.trim().split('\n')[0]), 'its own strategy rules');
      FAMILY_CHECKS[agentId](prompt);

      assert.equal(prompt.split('### MARKET-OPEN ALPHADESK WORKFLOW').length - 1, fit.length ? 1 : 0, 'the shared workflow once for options agents, none otherwise');
      assert.doesNotMatch(prompt, /TEMPORARY_ALPHA_MVP_OVERRIDE|quantity one|quantity 1\b/);
      const verticals = fit.filter(name => name.endsWith('_debit'));
      if (verticals.length) {
        const names = verticals.map(name => name.replace('_', ' ').replace('_', ' ')).join(' and ');
        assert.match(prompt, new RegExp(`Debit vertical mechanics \\(your permissions allow: ${names}\\)`));
        assert.doesNotMatch(prompt, /Agent execution is single-leg only/);
      } else {
        assert.doesNotMatch(prompt, /Debit vertical mechanics/);
      }
      const menu = menuOf(prompt);
      assert.ok(menu.includes('prophet_get_option_groups'), 'every menu lists the group status tool');
      assert.equal(menu.includes('prophet_get_options_quote'), agentId === 'catalyst' && fit.length > 0, 'the focused menu follows Herald only');
      if (agentId !== 'macro-rotation' && agentId !== 'trend-follower') assert.match(prompt, /(Scan|Catalyst) coverage: /);
    });
  }
}

test('switch matrix: a switch records its permission change once, and a no-op switch records nothing', async () => {
  const slot = 'sbx_956ff9e4';
  await switchTo(slot, 'default');
  store.consumeAgentSwitch(slot);
  await switchTo(slot, 'macro-rotation');
  const change = store.consumeAgentSwitch(slot);
  assert.deepEqual(change.permissionPatch, { allowOptions: false });
  assert.equal(store.consumeAgentSwitch(slot), null);
  await switchTo(slot, 'macro-rotation');
  assert.equal(store.consumeAgentSwitch(slot), null, 'switching to the agent already there changes nothing');
  await switchTo(slot, 'default');
  assert.deepEqual(store.consumeAgentSwitch(slot).permissionPatch, { allowOptions: true, allowedStructures: [...STRATEGY_FITS.default] });
});

test('an explicit strategy or cadence passed with the switch is kept for the new agent, never null', async () => {
  const slot = 'sbx_0d35471e';
  await switchTo(slot, 'conservative');
  await switchTo(slot, 'momentum', { strategyId: 'equity-momentum', heartbeatOverrides: { midday: 321 } });
  const resolved = store.getResolvedAgentForSandbox(slot);
  assert.equal(resolved.strategyId, 'equity-momentum');
  assert.equal(resolved.heartbeatOverrides.midday, 321);
  await switchTo(slot, 'default');
  assert.equal(store.getResolvedAgentForSandbox(slot).strategyId, 'default', 'no strategy key is left behind');
  assert.ok(store.getResolvedAgentForSandbox(slot).strategyId, 'never null');
});

// ── building blocks ─────────────────────────────────────────────────────────────────────────────────────────────────
test('option fit: saved field wins, defaults cover the eight built-ins, unknown strategies stay options-capable', () => {
  assert.deepEqual(strategyOptionFit({ id: 'x', optionStructures: ['long_call', 'nonsense'] }), ['long_call']);
  assert.deepEqual(strategyOptionFit({ id: 'etf-mean-reversion' }), ['long_call', 'bull_call_debit']);
  assert.deepEqual(strategyOptionFit({ id: 'macro-rotation' }), []);
  assert.equal(strategyOptionFit({ id: 'custom-one' }), null);
  assert.equal(isOptionsAgent({ strategy: { id: 'custom-one' } }), true);
  assert.equal(isOptionsAgent({ strategy: { id: 'macro-rotation' } }), false);
  assert.equal(isOptionsAgent({ allowOptions: false, strategy: { id: 'default' } }), false);
  assert.equal(isOptionsAgent({}), true);
  assert.deepEqual(Object.keys(DEFAULT_OPTION_FIT).sort(), after.strategies.map(s => s.id).sort());
});

test('permission patch: follows the fit, keeps a valid list when options go off, and does nothing when already equal', () => {
  assert.equal(permissionPatchForFit(null, {}), null);
  assert.deepEqual(permissionPatchForFit([], { allowOptions: true, allowedStructures: ['long_call'] }), { allowOptions: false });
  assert.equal(permissionPatchForFit([], { allowOptions: false }), null);
  assert.deepEqual(permissionPatchForFit(['long_call'], { allowOptions: false, allowedStructures: ['long_call'] }), { allowOptions: true, allowedStructures: ['long_call'] });
  assert.equal(permissionPatchForFit(['long_call', 'bull_call_debit'], { allowOptions: true, allowedStructures: ['bull_call_debit', 'long_call'] }), null);
});

test('start list detection and the coverage lines', () => {
  assert.equal(hasStartListBlock('x\n### SCAN UNIVERSE (start list)\ny'), true);
  assert.equal(hasStartListBlock('x\n### CATALYST UNIVERSE (start list)\ny'), true);
  assert.equal(hasStartListBlock('mentions SCAN UNIVERSE in a sentence'), false);
  const withList = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'default', hasStartList: true });
  const noList = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'default', hasStartList: false });
  const unspecified = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'default' });
  assert.match(withList, /Scan coverage: your SCAN UNIVERSE is a start list/);
  assert.doesNotMatch(noList, /Scan coverage|start list/);
  assert.equal(unspecified, withList, 'callers that do not say keep the old text');
  for (const strategyId of ['catalyst-news', 'long-premium-volatility', 'capital-preservation']) {
    assert.doesNotMatch(renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId, hasStartList: false }), /Scan coverage|Catalyst coverage/, strategyId);
  }
  for (const strategyId of ['long-premium-volatility', 'capital-preservation']) {
    assert.doesNotMatch(renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId, hasStartList: false }), /your start list/, strategyId);
  }
});

test('strategy families: Guardian has its own support family and the share strategies get no options guidance', () => {
  assert.equal(strategyFamilyOf('capital-preservation'), 'support');
  const guardian = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId: 'capital-preservation' });
  assert.match(guardian, /buy calls with delta about/);
  assert.match(guardian, /"Near support" means/);
  assert.doesNotMatch(guardian, /Used by breakout|"Extended" means|"Sector supportive"|buy a put/);
  for (const strategyId of ['macro-rotation', 'long-horizon-trend']) {
    const shares = renderTradingGuidance({ ...DEFAULT_TRADING_GUIDANCE }, { strategyId });
    assert.match(shares, /trades shares only and is not activated: do not open options positions/);
    assert.doesNotMatch(shares, /Contract choice|Option cost discipline/);
  }
});

test('the group status tool is in every menu', () => {
  assert.match(renderPrefixedToolMenu(), /prophet_get_option_groups/);
  assert.match(renderPrefixedToolMenu({ scope: 'herald' }), /prophet_get_options_quote, prophet_get_option_groups/);
});

test('the shared workflow block is single-leg text that the spread pairs turn into the two-leg wording', async () => {
  assert.match(ALPHADESK_WORKFLOW_BLOCK, /^### MARKET-OPEN ALPHADESK WORKFLOW\n/);
  assert.match(ALPHADESK_WORKFLOW_BLOCK, /\n### END_MARKET_OPEN_ALPHADESK_WORKFLOW$/);
  const liveL1Block = fx.slots.sbx_723be98b.agent.overrides.customSystemPrompt.match(/### MARKET-OPEN ALPHADESK WORKFLOW[\s\S]*### END_MARKET_OPEN_ALPHADESK_WORKFLOW/)[0];
  const { WORKFLOW_SPREAD_PAIRS } = await import('../agent/alphadesk-workflow.js');
  let spread = ALPHADESK_WORKFLOW_BLOCK;
  for (const [single, two] of WORKFLOW_SPREAD_PAIRS) spread = spread.split(single).join(two);
  assert.equal(spread, liveL1Block, 'with a vertical allowed the block is exactly the text Herald ran on Nov 22');
});

// ── an open spread must stay closable whatever the permission says ──────────────────────────────────────────────────
test('an open group gets the closing recipe when the slot does not list a vertical; no group, a listed vertical or options off get nothing', async () => {
  const group = { group_id: 'g1', underlying: 'AAPL', structure: 'bull_call_debit', status: 'open', open_units: 2 };
  const make = (perms, getOptionGroups) => {
    const h = new AgentHarness({ sandboxId: 'sbx_x', getOptionGroups });
    return h._openGroupReminder(perms);
  };
  const noVertical = { allowOptions: true, allowedStructures: ['long_call', 'long_put'] };
  const reminder = await make(noVertical, async () => ({ groups: [group, { ...group, group_id: 'g2', status: 'closed' }] }));
  assert.match(reminder, /OPEN SPREAD GROUP: this sandbox holds 1 open two-leg group \(AAPL bull_call_debit, 2 open units\)/);
  assert.match(reminder, /CLOSING \(only\): reverse both legs/);
  assert.match(reminder, /you may not open another spread/);
  assert.match(reminder, /prophet_get_option_groups/);
  assert.equal(reminder, openGroupCloseReminder([group]));
  assert.equal(await make(noVertical, async () => ({ groups: [{ ...group, status: 'closed' }] })), '');
  assert.equal(await make(noVertical, async () => ({ groups: [] })), '');
  assert.equal(await make({ allowOptions: true, allowedStructures: ['long_call', 'bull_call_debit'] }, async () => { throw new Error('must not be read'); }), '', 'the full recipe is already in the prompt');
  assert.equal(await make({ allowOptions: false, allowedStructures: ['long_call'] }, async () => { throw new Error('must not be read'); }), '');
  assert.equal(await make(noVertical, null), '', 'a harness without a group reader adds nothing');
  assert.match(await make(noVertical, async () => { throw new Error('backend unavailable'); }), /SPREAD GROUPS UNREADABLE this beat: before you manage or close any multi-leg position, call `prophet_get_option_groups`/);
});

test('every Nov 21 line of Prophet\'s start list and rules is still in the rendered prompt', async () => {
  const prompt = await promptFor('sbx_0d35471e');
  for (const line of [...prophetNov21.slice(13, 19), ...prophetNov21.slice(23, 30)]) assert.ok(prompt.includes(line), line.slice(0, 70));
});


// ── Nov 25 text release (C1 discovery owner, C1b reuse, C2 B2 logging, C2b B1 clause, C4 trail wording) ──────────────────────────
// Evidence boundary: these are TEXT changes. The tests below prove the exact rendered clauses, the preserved owners, the family scope and
// the 8-agent render; the arithmetic fixtures document the expected numbers. None of them proves that a live model follows the text.
// Baseline = the prompts that ran live at 05cfd92 (B1 and Herald's B2 included), rendered by this same harness in a clean checkout.
// The allowed delta (fixtures/nov25/delta.json) is the only difference permitted between that baseline and the current render.
test('Nov 25: all 8 agents render as the 05cfd92 baseline plus only the approved delta (C2b everywhere, the catalyst owners on catalyst-family only)', async () => {
  const live = {};
  const perAgent = {};
  for (const agentId of AGENT_IDS) { await switchTo('sbx_723be98b', agentId); perAgent[agentId] = await promptFor('sbx_723be98b'); }
  for (const agentId of AGENT_IDS) assert.equal(perAgent[agentId], expected26(BASE25[`L1:${agentId}`]), agentId);
  // Family follows the strategy, not the slot: only the catalyst agent renders the catalyst owners, on any slot.
  const withOwners = AGENT_IDS.filter(id => perAgent[id].includes(NOV25.catalyst[0].new));
  assert.deepEqual(withOwners, ['catalyst']);
  await switchTo('sbx_956ff9e4', 'catalyst');
  assert.ok((await promptFor('sbx_956ff9e4')).includes(NOV25.catalyst[0].new), 'catalyst behaviour on a different slot');
  await switchTo('sbx_723be98b', 'catalyst');
  await switchTo('sbx_956ff9e4', 'mean-reversion');
  // The shared B1 clause is present exactly once in every prompt, together with the sentences it extends.
  for (const text of Object.values(perAgent)) {
    assert.equal(count25(text, NOV25.shared[0].new), 1);
    assert.equal(count25(text, 'Be decisive.'), 1);
    assert.match(text, /a due exit with no fresh exact-contract quote remains DATA_BLOCK under the exit rule, and is still due\./);
    assert.match(text, /If required order, position or quote evidence is unavailable, the DATA_BLOCK rule above applies and a due exit stays due\./);
  }
});

test('Nov 25: the discovery owner keeps its non-scheduling clauses and the neighbouring catalyst rules, and states the bounded contract', async () => {
  const baseline = BASE25['L1:catalyst'];
  const current = await (async () => { await switchTo('sbx_723be98b', 'catalyst'); return promptFor('sbx_723be98b'); })();
  // Everything outside the five catalyst replacements and the shared clause is byte-identical to the baseline.
  assert.equal(revert25(current), baseline);
  for (const part of [
    'Verify that the item is a real published company event from a reliable source and note its publication time',
    'anchor the event at the earliest publication time you have for it',
    'later coverage, updated_at or fetched_at never restarts the catalyst clock',
    'Alpaca is the news provider AlphaDesk reads',
    'prophet_get_earnings_dates only warns you off positions ahead of a scheduled release; it is never entry evidence',
    '- Same news event: articles about the same company and the same subject within 36 hours are one event.',
    '- Close-time exit: an exit is due by the close only when the reaction has failed to develop',
    '- Missing or incomplete data (no completed bars yet, unknown publication time, unverified source) is INCOMPLETE_RESEARCH, never confirmation.',
    '- Exhausted gap: skip a setup when the gap from the previous close is more than',
    'Re-entering an event: after you have been stopped out of an event',
  ]) assert.ok(current.includes(part), part.slice(0, 70));
  // The bounded best-effort contract, in words (document of the approved text, not of model behaviour).
  for (const part of [
    'Discovery is bounded best-effort: it never proves complete coverage and it never delays a due exit or the management of a position you hold.',
    'a lookback (hours, at most 72) that reaches back to the previous regular-session close',
    'results are ordered by updated_at, so an old created_at on one article never ends the scan',
    'One work allowance of 5 pages per heartbeat is shared by every news call of that heartbeat (watch-list batches, market-wide discovery and catch-up).',
    'a symbol you did not read is never NO_SETUP',
    'a known article id does not prove that older items were reviewed',
    'an unfinished earlier scan stays an explicit backlog',
    'instead of a one-hour window',
    'a changed updated_at never makes it new',
    'this call counts against the shared page allowance of the heartbeat',
  ]) assert.ok(current.includes(part), part.slice(0, 70));
  assert.doesNotMatch(current, /the last 36 hours; follow has_more/);
});

test('Nov 25: rejection reuse is limited to unchanged completed-daily trend verdicts; dynamic checks and other events stay reviewable', async () => {
  await switchTo('sbx_723be98b', 'catalyst');
  const text = await promptFor('sbx_723be98b');
  const line = text.split('\n').find(l => l.startsWith('- Reusing a rejection:'));
  assert.ok(line);
  assert.match(line, /only when it rests on a completed-daily-bar trend verdict whose inputs are unchanged \(same session date, symbol, direction and event, same data as-of date, same failed values\)/);
  for (const never of ['a missing confirmation', 'a price or side-of-open check', 'a quote', 'a gap measured from the current price', 'unknown or missing data', 'a scheduled-earnings rejection once the result is published or corrected'])
    assert.ok(line.includes(never), never);
  assert.match(line, /A rejection of one direction or event never suppresses another direction or event, and re-entry after an exit still follows its own rule\./);
  assert.equal(count25(text, '- Reusing a rejection:'), 1);
});

test('Nov 25: C4 clarifies the range-based trail (call below, put above, strict), keeps historical and custom exits, and leaves the target and J2 text alone', async () => {
  await switchTo('sbx_723be98b', 'catalyst');
  const text = await promptFor('sbx_723be98b');
  const target = text.split('\n').find(l => l.startsWith('- Target (an exit-rule choice for paper trading'));
  assert.ok(target);
  assert.match(target, /the remaining call exits on a completed 5-minute close below its original recorded broken level and the remaining put exits on a completed 5-minute close above it \(equality does not count\)/);
  assert.match(target, /use the original event and position plan, not a later event or session range/);
  assert.match(target, /does not replace an explicit different exit rule or historical override in your Strategy Rules or recorded plan/);
  // The target allocation, once-only and spent-target rules and the J2 close-time rule are untouched.
  for (const part of ['This target exit happens once per position', 'When the cumulative filled quantity already equals the allocation, the target is spent', 'After the first target exit, a later touch of the target never closes the remainder'])
    assert.ok(target.includes(part), part);
  assert.equal(revert25(text), BASE25['L1:catalyst']);
  // A debit-vertical slot keeps the spread mechanics next to the same directional underlying predicate.
  assert.match(text, /Debit vertical mechanics \(your permissions allow: bull call debit and bear put debit\)/);
});

test('Nov 25: B2 logging text keeps the accounting contract and adds the opening-only log prerequisite', async () => {
  await switchTo('sbx_723be98b', 'catalyst');
  const text = await promptFor('sbx_723be98b');
  for (const part of [
    'never net the two directions',
    'each order counted once and released only after its terminal cancel or withdrawal is reconciled',
    'a partly filled candidate has its filled units in (a) and only the unfilled part here, and the whole candidate is never added twice',
    'an intact vertical counted once as remaining spread units x its recorded filled net debit x 100',
    'if any exposure or price bound cannot be read or reconciled, skip the entry instead of assuming zero',
    'For every opening attempt, including a replacement and one later cancelled unfilled, write the decision log before place_options_order',
    'If that log cannot be written, do not open; this never delays a reducing order, a cancel or a read.',
    'Existing sizing, max-position limits and every exit are unchanged.',
  ]) assert.ok(text.includes(part), part.slice(0, 70));
  assert.equal(count25(text, 'Direction budget (new openings only'), 1);
});

test('Nov 25: delta text is timeless (no tickers, dates, prices, counts or moment references)', () => {
  const all = [...NOV25.catalyst, ...NOV25.shared].map(e => e.new).join('\n');
  assert.doesNotMatch(all, /\b(WMT|META|UNH|DIS|AMD|CRM|ABBV|NVDA|BA|HPE|ANF|SPY|COST)\b/);
  assert.doesNotMatch(all, /\b20\d\d\b|yesterday|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Nov\b|\$\d/);
});

// Documentation fixtures of the expected B2 arithmetic. These are LABELLED EXAMPLES of what a correct budget line contains (NOT model tests, NOT a broker
// guard): they show the expected numbers for the Nov 24 openings and the contract's edge cases, using explicit positions with a direction.
// Cost rules (from the rendered text): single option = remaining qty x average entry premium x 100; an intact vertical = remaining spread units x its
// recorded filled net debit x 100 (counted ONCE, never as a group plus its two legs); reserved = unfilled opening qty x limit x 100 per working order,
// counted once and kept until its terminal cancel/withdrawal is reconciled; candidate = its unfilled qty x its final bounded limit x 100.
const BULLISH = new Set(['long_call', 'bull_call_debit']), BEARISH = new Set(['long_put', 'bear_put_debit']);
function b2Documented({ equity, direction, positions = [], orders = [], candidate }) {
  const sameDirection = list => list.filter(x => (direction === 'bullish' ? BULLISH : BEARISH).has(x.structure));
  const held = sameDirection(positions).reduce((n, p) => n + (p.units ?? p.qty) * (p.netDebit ?? p.avgEntry) * 100, 0);
  const reserved = sameDirection(orders).filter(o => !o.terminalReconciled).reduce((n, o) => n + o.unfilledQty * o.limit * 100, 0);
  const cand = candidate.unfilledQty * candidate.limit * 100;
  const total = held + reserved + cand;
  return { held, reserved, candidate: cand, total, pct: (total / equity) * 100 };
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} vs ${expected}`);

test('Nov 25 (documentation fixture, not a model test): the three Nov 24 openings, from explicit same-direction holdings', () => {
  // WMT 6-call order: the held bullish book was the WMT calls (5 x 3.90) AND the DIS calls (10 x 5.70); the logged line omitted DIS.
  const wmt = b2Documented({ equity: 92899.23, direction: 'bullish',
    positions: [{ structure: 'long_call', qty: 5, avgEntry: 3.9 }, { structure: 'long_call', qty: 10, avgEntry: 5.7 }],
    candidate: { unfilledQty: 6, limit: 8.19 } });
  assert.equal(wmt.total, 12564); near(wmt.pct, 13.5243317);
  // META put: CRM and UNH were already closed, so the bearish book was empty.
  const meta = b2Documented({ equity: 93574.58, direction: 'bearish', positions: [], candidate: { unfilledQty: 2, limit: 36.28 } });
  assert.equal(Math.round(meta.total), 7256); near(meta.pct, 7.7542427);
  // DIS call: the final submitted bound was 5.72 (not the 5.71 midpoint of the log).
  const dis = b2Documented({ equity: 92899.48, direction: 'bullish', positions: [{ structure: 'long_call', qty: 5, avgEntry: 3.9 }], candidate: { unfilledQty: 10, limit: 5.72 } });
  assert.equal(dis.total, 7670); near(dis.pct, 8.2562357);
  assert.equal(b2Documented({ equity: 92899.48, direction: 'bullish', positions: [{ structure: 'long_call', qty: 5, avgEntry: 3.9 }], candidate: { unfilledQty: 10, limit: 5.71 } }).total, 7660, 'the old limit gives the old (wrong) number');
});

test('Nov 25 (documentation fixture): directions are never netted, an intact vertical counts once, a changed quantity changes the candidate, a partially filled replacement keeps its reservation until terminal reconciliation', () => {
  const equity = 90000;
  const bullishCandidate = { unfilledQty: 1, limit: 10 };                                  // 1000
  // never netted: bullish 5000 held + bearish 7000 held + a bullish candidate of 1000 => bullish total 6000, not 5000 + 1000 - 7000
  const book = [{ structure: 'long_call', qty: 5, avgEntry: 10 }, { structure: 'long_put', qty: 7, avgEntry: 10 }];
  assert.equal(b2Documented({ equity, direction: 'bullish', positions: book, candidate: bullishCandidate }).total, 6000);
  assert.equal(b2Documented({ equity, direction: 'bearish', positions: book, candidate: { unfilledQty: 1, limit: 10 } }).total, 7000 + 1000);
  // an intact vertical: 2 spread units at 3.00 net debit contribute 600 ONCE (not the group plus its two gross legs)
  const vertical = [{ structure: 'bull_call_debit', units: 2, netDebit: 3.0 }];
  assert.equal(b2Documented({ equity, direction: 'bullish', positions: vertical, candidate: { unfilledQty: 0, limit: 0 } }).held, 600);
  // the same limit with a changed unfilled quantity changes the candidate cost (a changed bound invalidates the old calculation)
  assert.equal(b2Documented({ equity, direction: 'bullish', candidate: { unfilledQty: 4, limit: 2.5 } }).candidate, 1000);
  assert.equal(b2Documented({ equity, direction: 'bullish', candidate: { unfilledQty: 5, limit: 2.5 } }).candidate, 1250);
  // a partially filled candidate: filled units are held, only the unfilled part is the candidate or reservation (the whole is never counted twice)
  const partial = b2Documented({ equity, direction: 'bullish', positions: [{ structure: 'long_call', qty: 4, avgEntry: 3 }], candidate: { unfilledQty: 6, limit: 3 } });
  assert.equal(partial.total, 3000);
  // a replacement: the old working order stays reserved until its terminal cancel is reconciled, then only the replacement counts
  const working = [{ structure: 'long_call', unfilledQty: 3, limit: 2, terminalReconciled: false }];
  assert.equal(b2Documented({ equity, direction: 'bullish', orders: working, candidate: { unfilledQty: 3, limit: 2 } }).total, 1200, 'old order still reserved');
  assert.equal(b2Documented({ equity, direction: 'bullish', orders: [{ ...working[0], terminalReconciled: true }], candidate: { unfilledQty: 3, limit: 2 } }).total, 600, 'released after the terminal cancel is reconciled');
});

test('Nov 25 H6: C4 and the exit owners keep their protected words; a deliberately different custom exit survives unchanged next to the C4 qualifier', async () => {
  await switchTo('sbx_723be98b', 'catalyst');
  const base = await promptFor('sbx_723be98b');
  const baseline = BASE25['L1:catalyst'];
  for (const part of [
    'is met when any eligible completed bar since its reference point satisfies it. Check every eligible bar since that point, never only the first bar or only the latest bar, and a later bar on the other side never undoes a trigger that an earlier eligible bar already met.',
    'the bars that count for a stop completed after your entry fill',
    'the bars that count for a confirmation start at or after the end of the range window',
    'When price reaches it, close half of the broker-confirmed contracts rounded down to whole contracts, and trail the remainder by exiting on a completed 5-minute close back through the broken level.',
    '(equality does not count)',
    'This clarification does not replace an explicit different exit rule or historical override in your Strategy Rules or recorded plan.',
  ]) { assert.equal(count25(base, part), 1, part.slice(0, 60)); }
  const closeLine = text => text.split('\n').find(l => l.startsWith('- Close-time exit:'));
  assert.equal(closeLine(base), closeLine(baseline), 'the J2 close-time exit line is identical to the live 05cfd92 prompt');
  // a custom exit written in the slot's Strategy Rules is rendered exactly once and unchanged
  const CUSTOM = 'CUSTOM-EXIT-RULE-FIXTURE: for this slot a put trail exits on a completed 15-minute close above the 10-day average instead.';
  await store.updateSandboxAgentOverrides('sbx_723be98b', { customStrategyRules: CUSTOM });
  const custom = await promptFor('sbx_723be98b');
  assert.equal(count25(custom, CUSTOM), 1, 'the custom exit is kept verbatim');
  assert.ok(custom.includes('does not replace an explicit different exit rule or historical override'), 'C4 states it does not override it');
  await store.updateSandboxAgentOverrides('sbx_723be98b', { customStrategyRules: null });
  assert.equal(await promptFor('sbx_723be98b'), base, 'clearing the override restores the same prompt');
});

test('Nov 25 H6: each C2b exception is present once in every agent prompt (shared, not catalyst-only)', async () => {
  const exceptions = [
    'Broker acknowledgement without confirmed execution is a submitted, unconfirmed order to reconcile',
    'pending status alone, or an entry assessment score that does not apply to a reducing order, is not DATA_BLOCK',
    'Never infer a fill, and never retry or duplicate an uncertain order.',
    'If required order, position or quote evidence is unavailable, the DATA_BLOCK rule above applies and a due exit stays due.',
  ];
  for (const agentId of AGENT_IDS) {
    await switchTo('sbx_723be98b', agentId);
    const prompt = await promptFor('sbx_723be98b');
    for (const part of exceptions) assert.equal(count25(prompt, part), 1, agentId + ': ' + part.slice(0, 50));
  }
  await switchTo('sbx_723be98b', 'catalyst');
});

test('Nov 25 H6: manifest provenance (exactly 1 shared and 5 catalyst entries, distinct non-empty anchors found once in the baseline; the approved files are pinned as a tripwire)', async () => {
  const crypto = await import('node:crypto');
  assert.equal(NOV25.shared.length, 1);
  assert.equal(NOV25.catalyst.length, 5);
  const entries = [...NOV25.shared, ...NOV25.catalyst];
  for (const e of entries) {
    assert.ok(typeof e.old === 'string' && e.old.length > 20, 'non-empty anchor');
    assert.equal(typeof e.new, 'string', 'the replacement is a string');
    assert.ok(e.new.length > 0 && e.new !== e.old, 'the replacement is non-empty and differs from its anchor');
    assert.ok(['agent/harness.js', 'agent/trading-guidance.js'].includes(e.file), 'only the two approved source files: ' + e.file);
  }
  assert.equal(new Set(entries.map(e => e.old)).size, entries.length, 'anchors are distinct');
  assert.equal(Object.keys(BASE25).length, 11);
  for (const key of ['live:sbx_723be98b', 'live:sbx_956ff9e4', 'live:sbx_0d35471e', ...AGENT_IDS.map(id => 'L1:' + id)]) assert.ok(typeof BASE25[key] === 'string' && BASE25[key].length > 10000, key);
  assert.equal(count25(BASE25['L1:catalyst'], NOV25.shared[0].old), 1);
  for (const e of NOV25.catalyst) assert.equal(count25(BASE25['L1:catalyst'], e.old), 1, e.old.slice(0, 50));
  // Tripwire, not authority: these are the sha256 of the files reviewed and approved at 11a8555. A reviewed change to the baseline or the manifest
  // must update them in the same commit AND be reviewed independently of this test.
  const nodeFs = await import('node:fs');
  const sha = file => crypto.createHash('sha256').update(Buffer.from(nodeFs.readFileSync(new URL(file, FX), 'latin1').replace(/\r\n/g, '\n'), 'latin1')).digest('hex');   // line-ending insensitive: a Windows checkout may turn LF into CRLF
  assert.equal(sha('../nov25/baseline-05cfd92.json'), '2f31b92fcd9484a3be4f082e1d3e422e0589e923fa5286118ac8aaa33c96d9f3');
  assert.equal(sha('../nov25/delta.json'), '739434cb9dfa5262572a80a056f7b004e717de79545c81c891779c9f7af3e7c7');
  assert.equal(sha('../nov26/delta.json'), '7e3a8b8c786cc332bd9cf8ae480270fdc392794c4599687c8466b9ec6c3f15b6');
});

// ── Nov 26 text delta (W1 exit evidence, W3 carry-forward, W5 event_published_at, W6 target touch) ────────────────────
// Evidence boundary: these prove the exact rendered clauses and their family scope. They do NOT prove that a live model follows them.
test('Nov 26: all 8 prompts carry the shared carry-forward sentence once; only the catalyst family carries the exit-evidence, target-touch, anchor and reuse clauses; the chain reverts exactly to the 05cfd92 baseline', async () => {
  const perAgent = {};
  for (const agentId of AGENT_IDS) { await switchTo('sbx_723be98b', agentId); perAgent[agentId] = await promptFor('sbx_723be98b'); }
  for (const agentId of AGENT_IDS) {
    const text = perAgent[agentId];
    assert.equal(count25(text, NOV26.shared[0].new), 1, agentId);
    assert.equal(text, expected26(BASE25[`L1:${agentId}`]), agentId);
    assert.equal(revert25(text), BASE25[`L1:${agentId}`], agentId);
  }
  assert.deepEqual(AGENT_IDS.filter(id => perAgent[id].includes('- Exit evidence:')), ['catalyst']);
  assert.deepEqual(AGENT_IDS.filter(id => perAgent[id].includes('event_published_at')), ['catalyst']);
  await switchTo('sbx_723be98b', 'catalyst');
  await switchTo('sbx_956ff9e4', 'mean-reversion');
});

test('Nov 26: the clauses say what was approved (advisory only, no expiry, daily_trend reuse only, exact publication time, call high / put low)', async () => {
  await switchTo('sbx_723be98b', 'catalyst');
  const text = await promptFor('sbx_723be98b');
  for (const part of [
    'It is an advisory arithmetic check of your own numbers: it never changes or blocks the order, so a due exit is still placed.',
    'rule_basis "underlying_completed_5min_bar"',
    'trigger_bar_close (stop, trail, invalidation) or trigger_bar_high for a call target or trigger_bar_low for a put target',
    "A call's underlying target is touched when a completed 5-minute bar's high reaches or exceeds the level, and a put's when a bar's low reaches or falls below it.",
    'This target exit happens once per position',
    'use the exact publication time, seconds kept, for news published during the session, and the session open for news published before it',
    'Use a REJECTED daily_trend note from the carry-forward block only under this rule (same symbol, direction, event, data-as-of date and failed values), never for any other gate or check.',
  ]) assert.ok(text.includes(part), part.slice(0, 70));
  const shared = NOV26.shared[0].new.slice(NOV26.shared[0].old.length);
  assert.match(shared, /it is not market or broker data, so verify with live tools before acting/);
  assert.match(shared, /Finish its PENDING names before repeating research/);
  assert.doesNotMatch(shared + NOV26.catalyst.map(e => e.new).join(' '), /expire|expiry|deadline|minutes? old|stale after/i, 'no candidate expiry anywhere');
  // the Nov 25 reuse rule stays the owner of rejection reuse
  assert.match(text, /- Reusing a rejection: within one session you may reuse an earlier rejection only when it rests on a completed-daily-bar trend verdict whose inputs are unchanged/);
});

test('Nov 26: the delta manifest names only the two approved source files, has distinct anchors, and every catalyst anchor exists once in the Nov 25 catalyst render', () => {
  const entries = [...NOV26.shared, ...NOV26.catalyst];
  for (const e of entries) assert.ok(['agent/harness.js', 'agent/trading-guidance.js'].includes(e.file), e.file);
  assert.equal(new Set(entries.map(e => e.old)).size, entries.length);
  const base = expected25(BASE25['L1:catalyst']);
  for (const e of entries) assert.equal(count25(base, e.old), 1, e.old.slice(0, 60));
  for (const e of NOV26.shared) assert.equal(count25(expected25(BASE25['L1:default']), e.old), 1);
});
