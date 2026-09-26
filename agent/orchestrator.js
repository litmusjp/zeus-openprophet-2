import { EventEmitter } from 'events';
import http from 'http';
import path from 'path';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import { spawn, execSync } from 'child_process';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { replaceBinaryWithRollback } from './binary-replacement.js';
import { enqueueProphetBotBinaryOperation } from './binary-operation-lock.js';

import { AgentHarness } from './harness.js';
import { alpacaTradingUrl, portForAgent, tradingPolicyEnvironment } from './defaults.js';
import {
  getSandbox,
  getSandboxes,
  getAccountById,
  getAgentById,
  getResolvedAgentForSandbox,
  getStrategyById,
  getHeartbeatForSandboxPhase,
  getPermissionsForSandbox,
  ensureBrokerAccountBinding,
} from './config-store.js';
import { shouldShowGoLogLine, createGoLogLineBuffer } from './go-log-filter.js';
import { resolveApiAuthToken } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.join(__dirname, '..');
const HARNESS_EVENTS = [
  'status', 'agent_log', 'agent_text', 'beat_start', 'beat_end',
  'tool_call', 'tool_result', 'heartbeat_change', 'schedule', 'trade',
];

function portOffsetForSandbox(sandboxId) {
  let hash = 0;
  for (const char of String(sandboxId || 'default')) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1000;
  }
  return hash;
}

export { shouldShowGoLogLine, createGoLogLineBuffer };

export function isStructuredReadiness503(error) {
  const response = error?.response;
  const health = response?.data;
  return response?.status === 503 && health && typeof health === 'object'
    && typeof health.ready === 'boolean'
    && typeof health.reconciliation_complete === 'boolean';
}

function setRuntimeProcessNonce(runtime) {
  const header = 'X-OpenProphet-Process-Nonce';
  const processNonce = runtime.processNonce;
  runtime.identityHeaders = {
    ...runtime.identityHeaders,
    [header]: processNonce,
  };
  const headers = runtime.goAxios?.defaults?.headers;
  if (headers) {
    headers[header] = processNonce;
    headers.common = {
      ...(headers.common || {}),
      [header]: processNonce,
    };
  }
  const opencodeEnv = runtime.harness?.opencodeEnv;
  if (opencodeEnv) {
    opencodeEnv.OPENPROPHET_PROCESS_NONCE = processNonce;
    opencodeEnv.TRADING_BOT_PROCESS_NONCE = processNonce;
  }
}

// The tenant is derived from the server-owned account binding. An inherited
// tenant is only acceptable when it agrees; callers cannot redirect a runtime
// to another tenant through environment input.
export function buildGoBackendEnv(baseEnv, { account, sandboxId, processNonce, port, databasePath, activityLogDir, permissions, alphaDesk }) {
  const tenantID = String(account?.id || '').trim();
  if (!tenantID) throw new Error('server-owned tenant identity is missing');
  const inheritedTenant = String(baseEnv?.OPENPROPHET_TENANT_ID || '').trim();
  if (inheritedTenant && inheritedTenant !== tenantID) {
    throw new Error(`server-owned tenant identity conflicts with inherited tenant for sandbox ${sandboxId}`);
  }
  return {
    ...baseEnv,
    ALPACA_API_KEY: account.publicKey,
    ALPACA_SECRET_KEY: account.secretKey,
    ALPACA_BASE_URL: alpacaTradingUrl(account.paper, account.baseUrl),
    ALPACA_PAPER: account.paper ? 'true' : 'false',
    ALPACA_ACCOUNT_ID: account.brokerAccountId,
    OPENPROPHET_TENANT_ID: tenantID,
    PORT: String(port),
    SERVER_HOST: '127.0.0.1',
    TRADING_BOT_TOKEN: baseEnv?.TRADING_BOT_TOKEN || '',
    TRADING_BOT_OPERATOR_TOKEN: baseEnv?.TRADING_BOT_OPERATOR_TOKEN || '',
    DATABASE_PATH: databasePath,
    ACTIVITY_LOG_DIR: activityLogDir,
    OPENPROPHET_SANDBOX_ID: sandboxId,
    OPENPROPHET_ACCOUNT_ID: account.id,
    OPENPROPHET_PROCESS_NONCE: processNonce,
    ...tradingPolicyEnvironment(permissions),
    ALPHADESK_ENABLED: alphaDesk?.enabled ? 'true' : 'false',
    ALPHADESK_URL: alphaDesk?.url || '',
    ALPHADESK_API_KEY: alphaDesk?.apiKey || '',
  };
}

export class AgentOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();
    this.projectRoot = options.projectRoot || PROJECT_ROOT;
    this.agentUrl = options.agentUrl || process.env.AGENT_URL || 'http://localhost:3737';
    this.tradingBotBasePort = Number(options.tradingBotBasePort || process.env.TRADING_BOT_PORT || 4534);
    this.chatStore = options.chatStore || null;
    this.runtimes = new Map();
    this.portOwners = new Map();
    this._binaryReady = false;
    this._startTails = new Map();
  }

  getSandboxPort(sandboxId) {
    const existing = this.runtimes.get(sandboxId);
    if (existing) return existing.port;
    const preferred = portForAgent(sandboxId, this.tradingBotBasePort);
    let port = preferred;
    while (this.portOwners.has(port) && this.portOwners.get(port) !== sandboxId) {
      port += 1;
    }
    this.portOwners.set(port, sandboxId);
    return port;
  }

  getSandboxDbPath(sandboxId) {
    return path.join(this.projectRoot, 'data', 'sandboxes', sandboxId, 'prophet_trader.db');
  }

  getSandboxRuntime(sandboxId) {
    return this.runtimes.get(sandboxId) || null;
  }

  listRuntimes() {
    return Array.from(this.runtimes.values()).map(runtime => ({
      sandboxId: runtime.sandboxId,
      port: runtime.port,
      goReady: runtime.goReady,
      goPid: runtime.goProc?.pid || null,
      state: runtime.harness.state.toJSON(),
    }));
  }

  ensureRuntime(sandboxId) {
    let runtime = this.runtimes.get(sandboxId);
    if (runtime) return runtime;

    const sandbox = getSandbox(sandboxId);
    if (!sandbox) throw new Error(`Sandbox not found: ${sandboxId}`);

    const port = this.getSandboxPort(sandboxId);
    const tradingBotUrl = `http://127.0.0.1:${port}`;
    const goHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 10, keepAliveMsecs: 30000 });
    const tradingBotToken = process.env.TRADING_BOT_TOKEN || '';
    const agentAuthToken = resolveApiAuthToken({ executionEnabled: true, agentToken: process.env.AGENT_AUTH_TOKEN || '', serverToken: tradingBotToken });
    const processNonce = randomUUID();
    const identityHeaders = {
      Authorization: `Bearer ${tradingBotToken}`,
      'X-OpenProphet-Sandbox-ID': sandboxId,
      'X-OpenProphet-Account-ID': sandbox.accountId,
      'X-OpenProphet-Process-Nonce': processNonce,
    };
    const goAxios = axios.create({
      baseURL: tradingBotUrl,
      httpAgent: goHttpAgent,
      timeout: 5000,
      headers: identityHeaders,
    });

    const harness = new AgentHarness({
      sandboxId,
      accountId: sandbox.accountId,
      getSandbox,
      getAccount: getAccountById,
      getAgent: getAgentById,
      getResolvedAgent: getResolvedAgentForSandbox,
      getStrategyById,
      getHeartbeatForPhase: getHeartbeatForSandboxPhase,
      getPermissions: getPermissionsForSandbox,
      chatStore: this.chatStore,
      opencodeEnv: {
        TRADING_BOT_URL: tradingBotUrl,
        TRADING_BOT_TOKEN: tradingBotToken,
        AGENT_AUTH_TOKEN: agentAuthToken,
        SERVER_HOST: '127.0.0.1',
        AGENT_URL: this.agentUrl,
        OPENPROPHET_SANDBOX_ID: sandboxId,
        OPENPROPHET_ACCOUNT_ID: sandbox.accountId,
        OPENPROPHET_PROCESS_NONCE: processNonce,
        TRADING_BOT_SANDBOX_ID: sandboxId,
        TRADING_BOT_ACCOUNT_ID: sandbox.accountId,
        TRADING_BOT_PROCESS_NONCE: processNonce,
        ...tradingPolicyEnvironment(getPermissionsForSandbox(sandboxId)),
        DATABASE_PATH: this.getSandboxDbPath(sandboxId),
      },
    });

    runtime = {
      sandboxId,
      sandbox,
      port,
      tradingBotUrl,
      processNonce,
      identityHeaders,
      goAxios,
      goReady: false,
      goProc: null,
      harness,
      portCollisionAttempts: 0,
    };

    for (const event of HARNESS_EVENTS) {
      harness.state.on(event, data => {
        this.emit(event, { sandboxId, ...data });
      });
    }

    this.runtimes.set(sandboxId, runtime);
    return runtime;
  }

  async ensureAllRuntimes() {
    for (const sandbox of getSandboxes()) {
      this.ensureRuntime(sandbox.id);
    }
  }

  async _ensureBinary(force = false) {
    return enqueueProphetBotBinaryOperation(() => this._ensureBinaryUnlocked(force));
  }

  async _ensureBinaryUnlocked(force = false) {
    const binaryPath = path.join(this.projectRoot, 'prophet_bot');
    if (!force && this._binaryReady) return;
    if (!force) {
      try {
        const stat = await fs.stat(binaryPath);
        if (stat.isFile()) {
          this._binaryReady = true;
          return binaryPath;
        }
      } catch { /* build the missing binary below */ }
    }
    this._binaryReady = false;
    if (force) {
      try {
        execSync('go version', { cwd: this.projectRoot, stdio: 'pipe' });
      } catch {
        throw new Error('Go is unavailable; refusing to rebuild the trading binary');
      }
    }

    try {
      replaceBinaryWithRollback(binaryPath, temporaryPath => execSync(`go build -o "${temporaryPath}" ./cmd/bot`, {
        cwd: this.projectRoot,
        timeout: 120000,
        stdio: 'pipe',
      }));
    } catch (error) {
      this._binaryReady = false;
      throw error;
    }
    this._binaryReady = true;
    return binaryPath;
  }

  async startGoBackend(sandboxId, _isRetry = false, _restartHarness = undefined) {
    const previous = this._startTails.get(sandboxId) || Promise.resolve();
    const run = previous.then(() => this._startGoBackend(sandboxId, _isRetry, _restartHarness));
    this._startTails.set(sandboxId, run.catch(() => {}));
    return run;
  }

  async _startGoBackend(sandboxId, _isRetry = false, _restartHarness = undefined) {
    const executionMode = process.env.OPENPROPHET_EXECUTION_MODE || 'paper';
    if (executionMode !== 'paper' && executionMode !== 'enabled') {
      throw new Error('execution mode is inert; backend startup is disabled');
    }
    const runtime = this.ensureRuntime(sandboxId);
    const restartHarness = _restartHarness ?? runtime.harness.state.running;
    // Fence the OpenCode child before rotating its server-owned process nonce.
    if (runtime.harness.state.running) await runtime.harness.stop();
    runtime.processNonce = randomUUID();
    setRuntimeProcessNonce(runtime);
    const account = getAccountById(runtime.sandbox.accountId);
    if (!account) throw new Error(`Account not found for sandbox ${sandboxId}`);
    await this.stopGoBackend(sandboxId);
    const boundAccount = await ensureBrokerAccountBinding(account.id);

    await this._ensureBinary();
    await fs.mkdir(path.dirname(this.getSandboxDbPath(sandboxId)), { recursive: true });

    const env = buildGoBackendEnv(process.env, {
      account: boundAccount,
      sandboxId,
      processNonce: runtime.processNonce,
      port: runtime.port,
      databasePath: this.getSandboxDbPath(sandboxId),
      activityLogDir: path.join(this.projectRoot, 'data', 'sandboxes', sandboxId, 'activity_logs'),
      permissions: getPermissionsForSandbox(sandboxId),
      alphaDesk: getSandbox(sandboxId)?.plugins?.alphadesk,
    });

    const binaryPath = path.join(this.projectRoot, 'prophet_bot');
    runtime.goProc = spawn(binaryPath, [], {
      cwd: this.projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runtime.goReady = false;

    const captureGoOutput = (stream, level) => {
      const buffer = createGoLogLineBuffer(message => {
        if (!shouldShowGoLogLine(message)) return;
        this.emit('agent_log', {
          sandboxId,
          level,
          message: `[go:${runtime.port}] ${message}`,
        });
      });
      stream.on('data', chunk => buffer.push(chunk));
      stream.on('end', () => buffer.flush());
    };

    captureGoOutput(runtime.goProc.stdout, 'info');
    captureGoOutput(runtime.goProc.stderr, 'warning');

    runtime.goProc.on('exit', (code, signal) => {
      runtime.goReady = false;
      runtime.goProc = null;
      this.emit('agent_log', {
        sandboxId,
        level: code === 0 || signal === 'SIGTERM' ? 'info' : 'error',
        message: `Trading backend exited (code: ${code}, signal: ${signal})`,
      });
    });

    let sawStructuredReadiness503 = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 500));
      try {
        const response = await runtime.goAxios.get('/health', { timeout: 2000 });
        const health = response.data || {};
        if (health.sandbox_id && health.sandbox_id !== sandboxId) {
          if (runtime.portCollisionAttempts >= 5) {
            throw new Error(`port collision persisted for sandbox ${sandboxId}`);
          }
          runtime.portCollisionAttempts += 1;
          this.portOwners.delete(runtime.port);
          runtime.port = runtime.port + 1;
          while (this.portOwners.has(runtime.port)) runtime.port += 1;
          this.portOwners.set(runtime.port, sandboxId);
          runtime.tradingBotUrl = `http://127.0.0.1:${runtime.port}`;
          runtime.goAxios = axios.create({ baseURL: runtime.tradingBotUrl, httpAgent: new http.Agent({ keepAlive: true, maxSockets: 10 }), timeout: 5000, headers: runtime.identityHeaders });
          setRuntimeProcessNonce(runtime);
          await this.stopGoBackend(sandboxId);
          return this._startGoBackend(sandboxId, _isRetry, restartHarness);
        }
        if (!health.ready || health.sandbox_id !== sandboxId || health.account_id !== boundAccount.id || health.broker_account_id !== boundAccount.brokerAccountId || health.paper !== boundAccount.paper || health.reconciliation_complete !== true || health.process_nonce !== runtime.processNonce) {
          throw new Error('trading backend identity/readiness mismatch');
        }
        runtime.goReady = true;
        this.emit('agent_log', {
          sandboxId,
          level: 'success',
          message: `Trading backend ready on port ${runtime.port} for ${boundAccount.name}`,
        });
        if (restartHarness && !runtime.harness.state.running) await runtime.harness.start();
        return runtime;
      } catch (error) {
        if (isStructuredReadiness503(error)) sawStructuredReadiness503 = true;
        // keep waiting
      }
    }

    if (sawStructuredReadiness503) {
      throw new Error(`Trading backend is alive but not ready for sandbox ${sandboxId}`);
    }

    // Didn't come up — the binary may be stale/wrong-arch for this host. Rebuild once and retry.
    if (!_isRetry) {
      this.emit('agent_log', { sandboxId, level: 'warning', message: `Trading backend did not become ready — rebuilding binary for this platform and retrying...` });
      await this._ensureBinary(true);
      return this._startGoBackend(sandboxId, true, restartHarness);
    }

    throw new Error(`Trading backend failed to start for sandbox ${sandboxId}`);
  }

  async stopGoBackend(sandboxId) {
    const runtime = this.getSandboxRuntime(sandboxId);
    if (!runtime?.goProc) return;

    const pid = runtime.goProc.pid;
    runtime.goProc.kill('SIGTERM');
    await new Promise(resolve => setTimeout(resolve, 1500));
    try {
      process.kill(pid, 0);
      runtime.goProc.kill('SIGKILL');
    } catch {
      // process already gone
    }
    runtime.goProc = null;
    runtime.goReady = false;
  }

  async startSandbox(sandboxId) {
    const runtime = this.ensureRuntime(sandboxId);
    if (!runtime.goReady) {
      await this.startGoBackend(sandboxId);
    }
    await runtime.harness.start();
    return runtime;
  }

  async stopSandbox(sandboxId) {
    const runtime = this.getSandboxRuntime(sandboxId);
    if (!runtime) return;
    await runtime.harness.stop();
    await this.stopGoBackend(sandboxId);
  }

  pauseSandbox(sandboxId) {
    const runtime = this.ensureRuntime(sandboxId);
    runtime.harness.pause();
  }

  resumeSandbox(sandboxId) {
    const runtime = this.ensureRuntime(sandboxId);
    runtime.harness.resume();
  }

  async sendMessage(sandboxId, message) {
    const runtime = this.ensureRuntime(sandboxId);
    return runtime.harness.sendMessage(message);
  }

  getState(sandboxId) {
    const runtime = this.ensureRuntime(sandboxId);
    return runtime.harness.state.toJSON();
  }

  async shutdown() {
    const sandboxIds = Array.from(this.runtimes.keys());
    for (const sandboxId of sandboxIds) {
      await this.stopSandbox(sandboxId);
    }
  }
}

export default AgentOrchestrator;
