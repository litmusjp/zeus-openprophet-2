import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentHarness } from '../agent/harness.js';

test('direct-message beats render the prefixed tool menu without launching OpenCode', async () => {
  const harness = new AgentHarness({ getCurrentPhaseFn: () => 'closed' });
  let prompt;

  harness.state.running = true;
  harness.state.activeModel = 'test-model';
  harness._runClaude = async (directMessagePrompt) => {
    prompt = directMessagePrompt;
    return { text: 'stubbed response' };
  };

  await assert.doesNotReject(harness._adHocBeat('What tools are available?'));
  assert.match(prompt, /prophet_get_account/);
  assert.match(prompt, /prophet_place_buy_order/);
});
