import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const page = await fs.readFile(new URL('../agent/public/index.html', import.meta.url), 'utf8');

function pageFunction(name) {
  const match = page.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `expected ${name} in the settings page`);
  const context = {};
  vm.runInNewContext(`this.value = ${match[0]}`, context);
  return context.value;
}

test('heartbeat settings render phase ranges from the authoritative phase payload', () => {
  const formatRange = pageFunction('formatHeartbeatPhaseRange');
  assert.equal(formatRange({ start: 240, end: 570 }), '4:00 AM–9:30 AM ET');
  assert.equal(formatRange({ start: null, end: null, label: 'Markets Closed' }), '8:00 PM–4:00 AM ET');
  assert.match(page, /fetch\('\/api\/heartbeat\/phases'\)/);
  assert.match(page, /phaseData\.phases \|\| data\.heartbeatPhases \|\| \{\}/);
  assert.match(page, /formatHeartbeatPhaseRange\(\(sandboxScoped\.heartbeatPhases \|\| \{\}\)\[p\]\)/);
});

test('heartbeat seconds format as hours without NaN and expose a live output hook', () => {
  const formatHours = pageFunction('formatHeartbeatHours');
  assert.equal(formatHours('900'), '0.25 hours');
  assert.equal(formatHours('3600'), '1 hour');
  assert.equal(formatHours(''), '');
  assert.equal(formatHours('not-a-number'), '');
  assert.doesNotMatch(formatHours('not-a-number'), /NaN/);
  assert.match(page, /id="hb-hours-pre_market"/);
  assert.match(page, /oninput="updateHeartbeatHours\(\)" onchange="saveHeartbeat\(\)"/);
  assert.match(page, /updateHeartbeatHours\(\);/);
});

test('heartbeat clocks use timezone formatting and refresh every second', () => {
  const formatClock = pageFunction('formatHeartbeatClock');
  const now = new Date('2026-01-15T15:00:00.000Z');
  assert.match(formatClock(now, 'America/New_York', 'short'), /EST$/);
  const summerNow = new Date('2026-07-15T15:00:00.000Z');
  assert.match(formatClock(summerNow, 'America/New_York', 'short'), /EDT$/);
  assert.match(formatClock(now, 'Asia/Tokyo', 'short'), /GMT\+9$/);
  assert.match(page, /id="heartbeat-eastern-clock"/);
  assert.match(page, /U\.S\. Eastern/);
  assert.match(page, /Japan Standard \(JST\)/);
  assert.match(page, /setInterval\(updateHeartbeatClocks, 1000\)/);
  assert.match(page, /updateClock\(\); updateHeartbeatClocks\(\);/);
});
