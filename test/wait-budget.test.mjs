import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../mcp-server.js', import.meta.url), 'utf8');
const caseStart = source.indexOf("case 'wait': {");
const caseEnd = source.indexOf("case 'get_datetime': {", caseStart);
assert.ok(caseStart >= 0 && caseEnd > caseStart);
const body = source.slice(caseStart, caseEnd)
  .replace("case 'wait': {", '')
  .trim()
  .replace(/}\s*$/, '');

function invokeWait(args, timer = () => { throw new Error('Unexpected timer'); }) {
  return vm.runInNewContext(`(async (args) => {${body}})`, { setTimeout: timer })(args);
}

test('wait rejects a 240-second request without scheduling a timer', async () => {
  let timers = 0;
  const result = await invokeWait({ seconds: 240 }, () => { timers += 1; });
  assert.equal(timers, 0);
  assert.match(result.content[0].text, /not performed/i);
  assert.match(result.content[0].text, /from 1 to 30/i);
  assert.match(result.content[0].text, /next heartbeat/i);
});

test('wait rejects invalid values immediately without scheduling a timer', async () => {
  for (const seconds of [0, 1.5, 31, Infinity, NaN]) {
    let timers = 0;
    const result = await invokeWait({ seconds }, () => { timers += 1; });
    assert.equal(timers, 0, `timer scheduled for ${seconds}`);
    assert.match(result.content[0].text, /not performed/i);
    assert.match(result.content[0].text, /integer from 1 to 30/i);
  }
});

test('wait performs a supported short duration', async () => {
  const scheduled = [];
  const result = await invokeWait({ seconds: 2, reason: 'brief check' }, (callback, ms) => {
    scheduled.push(ms);
    callback();
  });
  assert.deepEqual(scheduled, [2000]);
  assert.match(result.content[0].text, /Waited .* seconds - brief check/);
});

test('wait schema advertises the same finite integer budget', () => {
  const schema = source.slice(source.indexOf("name: 'wait'"), source.indexOf("name: 'get_datetime'"));
  assert.match(schema, /Maximum 30 seconds/);
  assert.match(schema, /type: 'integer'/);
  assert.match(schema, /minimum: 1/);
  assert.match(schema, /maximum: 30/);
});
