import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { AgentHarness, formatOpenCodeError } from '../agent/harness.js';

function fakeProcess(lines, exitCode = 0) {
  const proc = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = () => true;
  proc.stdin.end = () => {};
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.killed = false;
  proc.kill = () => { proc.killed = true; };
  queueMicrotask(() => {
    for (const line of lines) proc.stdout.emit('data', `${JSON.stringify(line)}\n`);
    proc.emit('exit', exitCode, null);
  });
  return proc;
}

test('OpenCode error events become bounded actionable errors without token content', async () => {
  const formatted = formatOpenCodeError({
    type: 'error',
    error: { name: 'APICallError', statusCode: 403, code: 'secret-token-value', message: 'free tier denied; token=do-not-log' },
  });
  assert.match(formatted, /APICallError/);
  assert.match(formatted, /HTTP 403/);
  assert.doesNotMatch(formatted, /do-not-log|secret-token-value/);
  assert.ok(formatted.length <= 1200);
});

test('runOpenCode propagates a JSON error event even when the child exits zero', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([
    { type: 'error', error: { name: 'APICallError', statusCode: 403, message: 'free tier unavailable' } },
  ]) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.0-flash-fin-free');
  assert.match(result.error, /APICallError: HTTP 403/);
});

test('nested runtime wire shape preserves data.message/status but no diagnostics secrets', () => {
  const formatted = formatOpenCodeError({ type: 'error', error: {
    name: 'APICallError', data: {
      message: 'Not Found: Cannot find any route matching [POST] https://opencode.ai/zen/v1/chat/completions?api_key=secret-token-value',
      statusCode: 404, responseHeaders: { authorization: 'Bearer secret-token-value' }, responseBody: 'secret-token-value',
    },
  } });
  assert.match(formatted, /APICallError: HTTP 404: Not Found/);
  assert.doesNotMatch(formatted, /secret-token-value/i);
});

test('error after partial text remains failed', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([
    { type: 'text', part: { text: 'partial answer' } },
    { type: 'error', error: { name: 'APICallError', data: { message: 'failed', statusCode: 500 } } },
  ], 0) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.1-flash-free');
  assert.match(result.error, /APICallError: HTTP 500/);
  assert.equal(result.text, 'partial answer');
});

test('null-code exit with no text is not success', async () => {
  const harness = new AgentHarness({ spawnFn: () => fakeProcess([], null) });
  const result = await harness._runClaude('heartbeat', 'opencode/ling-3.1-flash-free');
  assert.match(result.error, /exited with code null signal null/);
});
