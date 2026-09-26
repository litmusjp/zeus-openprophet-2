import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { replaceBinaryWithRollback } from '../agent/binary-replacement.js';

test('binary replacement restores the working copy when promotion fails', () => {
  const files = new Map([['prophet_bot', 'known-good']]);
  const operations = [];
  const fsOps = {
    existsSync(name) { return files.has(name); },
    renameSync(from, to) {
      operations.push([from, to]);
      if (to === 'prophet_bot' && from.includes('.tmp-')) throw new Error('destination locked');
      if (!files.has(from)) throw new Error(`missing ${from}`);
      files.set(to, files.get(from));
      files.delete(from);
    },
    rmSync(name) { files.delete(name); },
  };

  assert.throws(() => replaceBinaryWithRollback('prophet_bot', temporaryPath => {
    files.set(temporaryPath, 'new-build');
  }, fsOps), /destination locked/);
  assert.equal(files.get('prophet_bot'), 'known-good');
  assert.equal([...files.keys()].some(name => name.includes('.tmp-')), false);
  assert.equal([...files.keys()].some(name => name.includes('.backup-')), false);
  assert.equal(operations.filter(([from]) => from === 'prophet_bot').length, 1);
  assert.equal(operations.filter(([from]) => from.includes('.backup-')).length, 1);
});

test('binary replacement restores an orphaned backup before building', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-recovery-'));
  try {
    const binaryPath = path.join(dir, 'prophet_bot');
    const backupPath = `${binaryPath}.backup-orphan`;
    await fs.writeFile(backupPath, 'known-good');
    let sawRecoveredPrimary = false;
    replaceBinaryWithRollback(binaryPath, temporaryPath => {
      sawRecoveredPrimary = true;
      assert.equal(fsSync.readFileSync(binaryPath, 'utf8'), 'known-good');
      fsSync.writeFileSync(temporaryPath, 'new-build');
    });
    assert.equal(sawRecoveredPrimary, true);
    assert.equal(await fs.readFile(binaryPath, 'utf8'), 'new-build');
    assert.equal((await fs.readdir(dir)).some(name => name.includes('.backup-')), false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('binary replacement cleans stale backups when the primary exists', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-cleanup-'));
  try {
    const binaryPath = path.join(dir, 'prophet_bot');
    await fs.writeFile(binaryPath, 'known-good');
    await fs.writeFile(`${binaryPath}.backup-stale`, 'older-copy');
    replaceBinaryWithRollback(binaryPath, temporaryPath => fsSync.writeFileSync(temporaryPath, 'new-build'));
    assert.equal(await fs.readFile(binaryPath, 'utf8'), 'new-build');
    assert.deepEqual(await fs.readdir(dir), ['prophet_bot']);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('concurrent starts for one sandbox are serialized', async () => {
  const { AgentOrchestrator } = await import(`../agent/orchestrator.js?start-serialization=${Date.now()}`);
  const orchestrator = new AgentOrchestrator({ projectRoot: os.tmpdir() });
  let active = 0;
  let maximum = 0;
  orchestrator._startGoBackend = async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 20));
    active -= 1;
  };
  await Promise.all([
    orchestrator.startGoBackend('sandbox-serial'),
    orchestrator.startGoBackend('sandbox-serial'),
  ]);
  assert.equal(maximum, 1);
});

test('structured readiness 503 is treated as a live backend response', async () => {
  const { isStructuredReadiness503 } = await import(`../agent/orchestrator.js?readiness-503=${Date.now()}`);
  assert.equal(isStructuredReadiness503({ response: { status: 503, data: { ready: false, reconciliation_complete: false } } }), true);
  assert.equal(isStructuredReadiness503({ response: { status: 503, data: 'backend unavailable' } }), false);
  assert.equal(isStructuredReadiness503(new Error('transport failure')), false);
});

async function withUnavailableGo(callback) {
  const goDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-no-go-'));
  const goPath = path.join(goDir, 'go.cmd');
  await fs.writeFile(goPath, '@echo off\r\nexit /b 1\r\n');
  const previousPath = process.env.Path;
  process.env.Path = `${goDir}${path.delimiter}${previousPath || ''}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.Path;
    else process.env.Path = previousPath;
    await fs.rm(goDir, { recursive: true, force: true });
  }
}

async function withFakeGo(callback, body) {
  const goDir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-fake-go-'));
  const goPath = path.join(goDir, 'go.cmd');
  await fs.writeFile(goPath, `@echo off\r\n${body}\r\n`);
  const previousPath = process.env.Path;
  process.env.Path = `${goDir}${path.delimiter}${previousPath || ''}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.Path;
    else process.env.Path = previousPath;
    await fs.rm(goDir, { recursive: true, force: true });
  }
}

test('normal startup reuses an existing trusted prophet_bot without requiring Go', async () => {
  await withUnavailableGo(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-reuse-'));
    try {
      await fs.writeFile(path.join(dir, 'prophet_bot'), 'prebuilt');
      const { AgentOrchestrator } = await import(`../agent/orchestrator.js?binary-reuse=${Date.now()}`);
      const orchestrator = new AgentOrchestrator({ projectRoot: dir });
      await orchestrator._ensureBinary(false);
      assert.equal(orchestrator._binaryReady, true);
      assert.equal(await fs.readFile(path.join(dir, 'prophet_bot'), 'utf8'), 'prebuilt');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test('normal startup builds a missing prophet_bot and promotes the completed output', async () => {
  await withFakeGo(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-missing-build-'));
    try {
      const { AgentOrchestrator } = await import(`../agent/orchestrator.js?binary-missing-build=${Date.now()}`);
      const orchestrator = new AgentOrchestrator({ projectRoot: dir });
      await orchestrator._ensureBinary(false);
      assert.equal(orchestrator._binaryReady, true);
      assert.equal(await fs.readFile(path.join(dir, 'prophet_bot'), 'utf8'), 'built\r\n');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 'if "%1"=="version" exit /b 0\r\necho built>"%~3"\r\nexit /b 0');
});

test('force rebuild fails closed and preserves an existing binary when Go is unavailable', async () => {
  await withUnavailableGo(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-existing-'));
    try {
      const binaryPath = path.join(dir, 'prophet_bot');
      await fs.writeFile(binaryPath, 'prebuilt');
      const { AgentOrchestrator } = await import(`../agent/orchestrator.js?binary-existing=${Date.now()}`);
      const orchestrator = new AgentOrchestrator({ projectRoot: dir });

      await assert.rejects(
        () => orchestrator._ensureBinary(true),
        /Go is unavailable; refusing to rebuild the trading binary/,
      );

      assert.equal(orchestrator._binaryReady, false);
      assert.equal(await fs.readFile(binaryPath, 'utf8'), 'prebuilt');
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test('forced rebuild preserves the existing binary when the build fails after Go is available', async () => {
  await withFakeGo(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-build-failure-'));
    try {
      const binaryPath = path.join(dir, 'prophet_bot');
      await fs.writeFile(binaryPath, 'known-good');
      const { AgentOrchestrator } = await import(`../agent/orchestrator.js?binary-build-failure=${Date.now()}`);
      const orchestrator = new AgentOrchestrator({ projectRoot: dir });
      await assert.rejects(() => orchestrator._ensureBinary(true));
      assert.equal(orchestrator._binaryReady, false);
      assert.equal(await fs.readFile(binaryPath, 'utf8'), 'known-good');
      const names = await fs.readdir(dir);
      assert.deepEqual(names, ['prophet_bot']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 'if "%1"=="version" exit /b 0\r\nexit /b 1');
});

test('force rebuild fails closed when Go is unavailable and the binary is missing', async () => {
  await withUnavailableGo(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openprophet-binary-missing-'));
    try {
      const { AgentOrchestrator } = await import(`../agent/orchestrator.js?binary-missing=${Date.now()}`);
      const orchestrator = new AgentOrchestrator({ projectRoot: dir });

      await assert.rejects(
        () => orchestrator._ensureBinary(true),
        /Go is unavailable; refusing to rebuild the trading binary/,
      );
      assert.equal(orchestrator._binaryReady, false);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
