import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

test('inert mode gates eager and on-demand sandbox runtime creation', async () => {
  const source = await readFile(path.join(repoRoot, 'agent', 'server.js'), 'utf8');
  assert.match(
    source,
    /function getOrCreateSandboxRuntime\(sandboxId\)\s*\{\s*if \(!EXECUTION_START_ENABLED \|\| !sandboxId \|\| isActiveSandbox\(sandboxId\)\) return null;/,
  );
  assert.match(
    source,
    /for \(const sandbox of getSandboxes\(\)\) \{\s*if \(EXECUTION_START_ENABLED && !isActiveSandbox\(sandbox\.id\)\)/,
  );
  assert.match(source, /if \(EXECUTION_START_ENABLED && activeAccount\) \{\s*await startGoBackend/);
});

test('inert mode resolves before broker settings and constructs no broker HTTP client', async () => {
  const source = await readFile(path.join(repoRoot, 'agent', 'server.js'), 'utf8');
  const mode = source.indexOf("const EXECUTION_MODE = process.env.OPENPROPHET_EXECUTION_MODE || 'paper';");
  const credentials = source.indexOf('TRADING_BOT_TOKEN');
  const brokerClient = source.indexOf('axios.create({');
  assert.ok(mode >= 0 && mode < credentials, 'execution mode must precede credential handling');
  assert.ok(mode < brokerClient, 'execution mode must precede broker HTTP construction');
  assert.match(source, /function unavailableBrokerClient\(\)/);
  assert.match(source, /const goAxios = EXECUTION_START_ENABLED \? axios\.create\(/);
});

test('inert server construction exits without binding a dashboard port', { skip: !existsSync(path.join(repoRoot, 'node_modules', 'express')) }, async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openprophet-agent-inert-'));
  const port = 49123;
  try {
    const child = spawnSync(process.execPath, [path.join(repoRoot, 'agent', 'server.js')], {
      cwd: repoRoot,
      input: '',
      timeout: 5000,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENPROPHET_EXECUTION_MODE: 'inert',
        OPENPROPHET_CONFIG_PATH: path.join(tempDir, 'agent-config.json'),
        AGENT_PORT: String(port),
      },
    });
    assert.equal(child.error, undefined, `inert server construction failed: ${child.stderr}`);
    assert.equal(child.status, 0, `inert server should exit without a listener: ${child.stderr}`);
    assert.match(child.stdout, /Dashboard unavailable: execution mode is inert/);
    assert.equal((await readdir(tempDir)).length, 0, 'inert agent startup must not create data files');

    const probe = createServer();
    await new Promise((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve);
    });
    await new Promise((resolve) => probe.close(resolve));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('inert MCP construction has no provider, directory, or broker-client side effects', async () => {
  const source = await readFile(path.join(repoRoot, 'mcp-server.js'), 'utf8');
  const mode = source.indexOf("const EXECUTION_MODE = process.env.OPENPROPHET_EXECUTION_MODE || 'paper';");
  assert.ok(mode >= 0, 'MCP must resolve explicit execution mode');
  assert.equal(source.includes("import { GoogleGenerativeAI } from '@google/generative-ai';"), false);
  assert.ok(source.indexOf('await import(\'@google/generative-ai\')') > mode, 'provider import must be optional and mode-gated');
  assert.ok(source.indexOf('new GoogleGenerativeAI') > mode, 'provider construction must be mode-gated');
  assert.ok(source.indexOf('fs.mkdir') > mode, 'directory creation must be mode-gated');
  assert.match(source, /function unavailableProvider|const unavailableProvider/);
  assert.match(source, /function unavailableBrokerClient|const unavailableBrokerClient/);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'openprophet-mcp-inert-'));
  try {
    const child = spawnSync(process.execPath, [path.join(repoRoot, 'mcp-server.js')], {
      cwd: tempDir,
      input: '',
      timeout: 3000,
      encoding: 'utf8',
      env: {
        ...process.env,
        OPENPROPHET_EXECUTION_MODE: 'inert',
        GEMINI_API_KEY: 'test-provider-key-that-must-not-be-read',
        TRADING_BOT_TOKEN: 'test-broker-token-that-must-not-be-read',
        AGENT_AUTH_TOKEN: 'test-agent-token-that-must-not-be-read',
      },
    });
    assert.equal(child.error, undefined, `inert MCP child construction failed: ${child.stderr}`);
    assert.equal(child.status, 0, `inert MCP should exit cleanly: ${child.stderr}`);
    assert.match(child.stderr, /OpenProphet MCP unavailable: execution mode is inert/);
    assert.equal((await readdir(tempDir)).length, 0, 'inert MCP startup must not create data directories');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('paper is the default execution mode and starts the existing execution path', async () => {
  const files = ['agent/server.js', 'agent/config-store.js', 'agent/orchestrator.js', 'mcp-server.js'];
  for (const file of files) {
    const source = await readFile(path.join(repoRoot, file), 'utf8');
    assert.match(source, /OPENPROPHET_EXECUTION_MODE \|\| 'paper'/, `${file} must default to paper`);
  }
  const server = await readFile(path.join(repoRoot, 'agent', 'server.js'), 'utf8');
  const mcp = await readFile(path.join(repoRoot, 'mcp-server.js'), 'utf8');
  assert.match(server, /EXECUTION_MODE === 'paper' \|\| EXECUTION_MODE === 'enabled'/);
  assert.match(mcp, /EXECUTION_MODE === 'paper' \|\| EXECUTION_MODE === 'enabled'/);
  const goConfig = await readFile(path.join(repoRoot, 'config', 'config.go'), 'utf8');
  assert.match(goConfig, /getEnvOrDefault\("OPENPROPHET_EXECUTION_MODE", "paper"\)/);
});
