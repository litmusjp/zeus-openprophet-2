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
await store.loadConfig();

test.after(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
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

// ── Herald and Pendulum keep today's prompts byte for byte (attribution for Monday's first spreads) ───────────────
test('Herald on L1 renders byte-identical to the live preview, apart from the new option-groups menu entry', async () => {
  const expected = goldenL1.replace(/^(\*\*Options\*\*: .*)$/m, '$1, prophet_get_option_groups');
  assert.notEqual(expected, goldenL1);
  const actual = await promptFor('sbx_723be98b');
  assert.equal(actual, expected);
});

test('Pendulum on L2 renders byte-identical to the live preview, apart from the menu entry and the one shared retry paragraph', async () => {
  const l1Paragraph = goldenL1.slice(goldenL1.indexOf('Only a genuine PASS for the unchanged proposal can proceed, and you never make a second submission of the same intent.'), goldenL1.indexOf('Never trade merely to obtain a PASS.') + 'Never trade merely to obtain a PASS.'.length);
  const old = 'Only its genuine PASS for the unchanged proposal can proceed; do not make a second submission.';
  assert.ok(l1Paragraph.length > 400 && goldenL2.includes(old));
  // The third allowed difference: the corrupted dash in the ETF rules is fixed (config edit C6).
  const expected = goldenL2.replace(old, l1Paragraph).replace(/^(\*\*Options\*\*: .*)$/m, '$1, prophet_get_option_groups').split('â€“').join('-');
  const actual = await promptFor('sbx_956ff9e4');
  assert.equal(actual, expected);
});

test('Prophet on L3 gets its restored identity, list and B2 rules, and the shared workflow between identity and list', async () => {
  const prompt = await promptFor('sbx_0d35471e');
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
  assert.match(reminder, /OPEN SPREAD GROUP: this sandbox holds 1 open two-leg group \(AAPL bull_call_debit\)/);
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
