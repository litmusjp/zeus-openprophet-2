import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const page = fs.readFileSync(new URL('../agent/public/index.html', import.meta.url), 'utf8');

function productionFunction(name) {
  const match = page.match(new RegExp(`function ${name}\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, `production ${name}() exists`);
  return match[0];
}

test('one heartbeat timer updates each sandbox sidebar from its own active schedule', () => {
  const nodes = new Map([
    ['header-next', { textContent: '--' }],
    ['a-next', { textContent: '--' }],
    ['b-next', { textContent: '--' }],
    ['hb-fill', { style: {} }],
  ]);
  const statNodes = [
    { dataset: { stat: 'sandbox-a-hb-next' } },
    { dataset: { stat: 'sandbox-b-hb-next' } },
  ];
  let now = 1_000;
  let tick;
  let intervalCount = 0;
  const activeIntervals = new Set();
  const NativeDate = Date;
  class ClockDate extends NativeDate {
    static now() { return now; }
  }
  const context = {
    Date: ClockDate,
    document: {
      getElementById: id => nodes.get(id) || null,
      querySelectorAll: selector => selector === '[data-stat$="-hb-next"]' ? statNodes : [],
      querySelector: selector => {
        const stat = selector.match(/data-stat="([^"]+)"/)?.[1];
        return stat === 'sandbox-a-hb-next' ? nodes.get('a-next')
          : stat === 'sandbox-b-hb-next' ? nodes.get('b-next') : null;
      },
    },
    setInterval: (fn, ms) => { assert.equal(ms, 1000); intervalCount++; tick = fn; activeIntervals.add(intervalCount); return intervalCount; },
    clearInterval: id => activeIntervals.delete(id),
    _set: (id, value) => { const node = nodes.get(id === 'hb-next' ? 'header-next' : id); if (node) node.textContent = value; },
    _setData: (key, value) => {
      const id = key === 'sandbox-a-hb-next' ? 'a-next' : key === 'sandbox-b-hb-next' ? 'b-next' : null;
      if (id) nodes.get(id).textContent = value;
    },
    progressInterval: 0,
    nextBeatTime: null,
    heartbeatSeconds: 0,
    selectedSandboxId: 'sandbox-a',
    getEffectiveSandboxId: () => context.selectedSandboxId,
    sandboxRuntime: {
      'sandbox-a': { running: true, paused: false },
      'sandbox-b': { running: true, paused: false },
    },
    sandboxSchedule: {},
  };
  vm.createContext(context);
  vm.runInContext(`
    sandboxSchedule['sandbox-a'] = { nextBeatTime: new Date(61_000), seconds: 60 };
    sandboxSchedule['sandbox-b'] = { nextBeatTime: new Date(121_000), seconds: 60 };
    nextBeatTime = sandboxSchedule['sandbox-a'].nextBeatTime;
    heartbeatSeconds = 60;
    ${productionFunction('sandboxHeartbeatCountdown')}
    ${productionFunction('updateSandboxHeartbeatCountdowns')}
    ${productionFunction('startProgress')}
    startProgress();
  `, context);

  assert.equal(intervalCount, 1, 'the existing progress timer is reused');
  assert.equal(activeIntervals.size, 1);
  tick();
  assert.equal(nodes.get('header-next').textContent, '60s');
  assert.equal(nodes.get('a-next').textContent, '60s');
  assert.equal(nodes.get('b-next').textContent, '120s');

  context.selectedSandboxId = 'sandbox-b';
  vm.runInContext("nextBeatTime = sandboxSchedule['sandbox-b'].nextBeatTime; startProgress();", context);
  assert.equal(intervalCount, 2, 'restarting progress replaces the one active timer');
  assert.equal(activeIntervals.size, 1, 'only one progress timer remains active');
  now += 1_000;
  tick();
  assert.equal(nodes.get('header-next').textContent, '119s');
  assert.equal(nodes.get('a-next').textContent, '59s');
  assert.equal(nodes.get('b-next').textContent, '119s');

  context.sandboxRuntime['sandbox-b'].paused = true;
  now += 1_000;
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'paused schedules are cleared');
  assert.equal(nodes.get('header-next').textContent, '--');

  context.sandboxRuntime['sandbox-b'].paused = false;
  vm.runInContext("sandboxSchedule['sandbox-b'].nextBeatTime = new Date(NaN);", context);
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'invalid dates are cleared');

  vm.runInContext("sandboxSchedule['sandbox-b'].nextBeatTime = null;", context);
  tick();
  assert.equal(nodes.get('b-next').textContent, '--', 'missing schedules are cleared');

  context.sandboxRuntime['sandbox-a'].running = false;
  tick();
  assert.equal(nodes.get('a-next').textContent, '--', 'stopped sandboxes are cleared');
});
