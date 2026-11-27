// A fresh process for the recovery tests: loads both stores from OPENPROPHET_CONFIG_PATH / OPENPROPHET_DATA_DIR, runs the same recovery
// server.js runs at start, and prints one JSON line (outcome, blocked slots, whether a beat/start is refused, the guidance read back).
// Inert: no network, no backend, no model. Used only by test/slot-transition-recovery.test.mjs.
const store = await import('../../agent/config-store.js');
const guidance = await import('../../agent/trading-guidance.js');
const { recoverPendingTransitions } = await import('../../agent/slot-transition.js');
const { slotGate } = await import('../../agent/slot-gate.js');
const { AgentHarness } = await import('../../agent/harness.js');

await store.loadConfig();
await guidance.loadTradingGuidance();
const outcome = await recoverPendingTransitions({ getSandbox: store.getSandbox, listSandboxIds: () => store.getSandboxes().map(s => s.id), log: () => {} });
const slots = {};
for (const sandbox of store.getSandboxes()) {
  const id = sandbox.id;
  // Only a blocked slot is exercised: a start or a beat on a healthy slot would try to run an agent.
  let startRefused = null;
  let beatRefused = null;
  if (slotGate.beatBlock(id)?.hard) {
    try { await new AgentHarness({ sandboxId: id }).start(); startRefused = false; } catch (error) { startRefused = /Start refused/.test(error.message); }
    const beater = new AgentHarness({ sandboxId: id });
    beater.state.running = true;
    await beater._beat();
    beatRefused = beater.state.beatCount === 0 && beater._beating === false;
  }
  slots[id] = {
    blocked: slotGate.blocked(id)?.reason ?? null,
    beatRefused,
    startRefused,
    guidance: guidance.getTradingGuidanceForSandbox(id),
    savedEntry: guidance.getSavedGuidanceEntry(id),
    agent: store.getSandbox(id).agent.activeAgentId,
  };
}
process.stdout.write(`RESULT ${JSON.stringify({ outcome, slots })}\n`);
process.exit(0);
