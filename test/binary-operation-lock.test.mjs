import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { enqueueProphetBotBinaryOperation } from '../agent/binary-operation-lock.js';

test('shared binary operation enqueues execute one at a time', async () => {
  let active = 0;
  let maximum = 0;
  const enter = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
  };

  await Promise.all([
    enqueueProphetBotBinaryOperation(enter),
    enqueueProphetBotBinaryOperation(enter),
    enqueueProphetBotBinaryOperation(enter),
  ]);

  assert.equal(maximum, 1);
});

test('both backend managers use the shared binary operation lock', () => {
  const orchestrator = fs.readFileSync(new URL('../agent/orchestrator.js', import.meta.url), 'utf8');
  const server = fs.readFileSync(new URL('../agent/server.js', import.meta.url), 'utf8');
  const importPattern = /import \{ enqueueProphetBotBinaryOperation \} from ['"]\.\/binary-operation-lock\.js['"]/;

  assert.match(orchestrator, importPattern);
  assert.match(server, importPattern);
  assert.match(orchestrator, /return enqueueProphetBotBinaryOperation\(\(\) => this\._ensureBinaryUnlocked\(force\)\)/);
  assert.match(server, /return enqueueProphetBotBinaryOperation\(\(\) => ensureGoBinary\(force\)\)/);
  assert.doesNotMatch(orchestrator, /_binaryEnsureTail/);
  assert.doesNotMatch(server, /binaryBuildTail/);
});
