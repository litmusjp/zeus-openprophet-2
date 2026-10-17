import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const AUTH_URL = 'https://auth.openai.com/codex/device';
const MAX_OUTPUT = 8192;
const FLOW_TTL_MS = 5 * 60 * 1000;
const PROBE_MODULE = fileURLToPath(new URL('./chatgpt-probe.js', import.meta.url));

export function chatgptXdgDataHome(dataDir = path.resolve('data')) {
  return path.join(dataDir, 'chatgpt-xdg-data');
}

export function nativeAuthPath(dataDir = path.resolve('data'), env = process.env) {
  return path.join(env.XDG_DATA_HOME || chatgptXdgDataHome(dataDir), 'opencode', 'auth.json');
}

function ensurePrivateNativeProfile(dataDir) {
  const dir = path.dirname(nativeAuthPath(dataDir, minimalEnv(dataDir)));
  fsSync.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fsSync.chmodSync(dir, 0o700);
  return dir;
}

export function nativeOpenCodeEnv({ dataDir = path.resolve('data'), env = process.env } = {}) {
  const nativeEnv = { ...stripOperatorSecrets(env), XDG_DATA_HOME: chatgptXdgDataHome(dataDir) };
  for (const key of ['OPENCODE_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID', 'OPENAI_PROJECT']) delete nativeEnv[key];
  return nativeEnv;
}

export function stripOperatorSecrets(env = process.env) {
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('ALPHADESK_CONTROL_') || ['BASIC_AUTH_USER', 'BASIC_AUTH_PASS'].includes(key)) delete childEnv[key];
  }
  return childEnv;
}

export function affectedSandboxesForAgentModelChange(sandboxes, agentId) {
  return sandboxes.filter(sandbox => sandbox.agent?.activeAgentId === agentId);
}

export function hasBusyAffectedSandbox(sandboxes, getHarness) {
  return sandboxes.some(sandbox => {
    const harness = getHarness(sandbox.id);
    return harness && (harness._beating || harness._proc);
  });
}

function minimalEnv(dataDir) {
  const env = {};
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG']) if (process.env[key]) env[key] = process.env[key];
  return nativeOpenCodeEnv({ dataDir, env });
}

async function readAuth(dataDir) {
  try {
    return JSON.parse(await fs.readFile(nativeAuthPath(dataDir, minimalEnv(dataDir)), 'utf8'));
  } catch { return null; }
}

function connectionMetaPath(dataDir) {
  return path.join(chatgptXdgDataHome(dataDir), 'opencode', 'connection.json');
}

async function readConnectionGeneration(dataDir, accountHash) {
  try {
    const meta = JSON.parse(await fs.readFile(connectionMetaPath(dataDir), 'utf8'));
    return meta.accountHash === accountHash && typeof meta.generation === 'string' ? meta.generation : null;
  } catch { return null; }
}

async function setConnectionGeneration(dataDir, accountId, { forceNew = false } = {}) {
  if (typeof accountId !== 'string' || !accountId) throw new Error('Native OAuth account identity is missing');
  const accountHash = createHash('sha256').update(accountId).digest('hex');
  const existing = await readConnectionGeneration(dataDir, accountHash);
  if (existing && !forceNew) return existing;
  const generation = randomUUID();
  const file = connectionMetaPath(dataDir);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(file), 0o700);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify({ accountHash, generation })}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return generation;
}

function providerEntry(auth) {
  const item = auth?.openai;
  return item && typeof item === 'object' && item.type === 'oauth' ? item : null;
}

export async function chatgptStatus({ dataDir = path.resolve('data'), env = process.env, inUse = false } = {}) {
  const entry = providerEntry(await readAuth(dataDir));
  const expiry = Number(entry?.expires || 0);
  const hasRefresh = typeof entry?.refresh === 'string' && entry.refresh.length > 0;
  const accountHash = typeof entry?.accountId === 'string' && entry.accountId
    ? createHash('sha256').update(entry.accountId).digest('hex') : null;
  const generation = accountHash ? await readConnectionGeneration(dataDir, accountHash) : null;
  const identityReady = Boolean(accountHash && generation);
  return {
    provider: 'openai', label: 'ChatGPT (subscription)', status: !entry ? 'not_connected' : (!hasRefresh || !identityReady) ? 'needs_reconnect' : 'connected_unverified',
    connected: Boolean(entry && hasRefresh && identityReady), accessTokenExpired: expiry > 0 && expiry <= Date.now(), apiKeyMode: false,
    modelCheck: 'unverified', inUse: Boolean(inUse),
    connectionId: identityReady ? generation : null,
  };
}

export async function disconnectChatGPT({ dataDir = path.resolve('data'), inUse = false } = {}) {
  if (inUse) throw new Error('ChatGPT is assigned to an active agent; stop that agent before disconnecting');
  const file = nativeAuthPath(dataDir, minimalEnv(dataDir));
  const dir = path.dirname(file);
  const auth = await readAuth(dataDir);
  if (auth && Object.hasOwn(auth, 'openai')) delete auth.openai;
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  await fs.rm(path.join(dir, 'model-checks.json'), { force: true });
  await fs.rm(connectionMetaPath(dataDir), { force: true });
  if (!auth || !Object.keys(auth).length) { await fs.rm(file, { force: true }); return { ok: true }; }
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
  return { ok: true };
}

async function readModelChecks(dataDir) {
  try { const value = JSON.parse(await fs.readFile(path.join(path.dirname(nativeAuthPath(dataDir, minimalEnv(dataDir))), 'model-checks.json'), 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
}

export async function recordChatGPTModelCheck({ dataDir = path.resolve('data'), model, connectionId }) {
  const dir = path.dirname(nativeAuthPath(dataDir, minimalEnv(dataDir)));
  const checks = await readModelChecks(dataDir);
  checks[model] = { connectionId, checkedAt: new Date().toISOString() };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, 'model-checks.json');
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(checks, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}

export async function isChatGPTModelVerified({ dataDir = path.resolve('data'), model, connectionId }) {
  if (!connectionId) return false;
  const check = (await readModelChecks(dataDir))[model];
  return check?.connectionId === connectionId;
}

export async function getVerifiedChatGPTModels({ dataDir = path.resolve('data'), connectionId }) {
  if (!connectionId) return [];
  const checks = await readModelChecks(dataDir);
  return Object.entries(checks).filter(([, check]) => check?.connectionId === connectionId).map(([model]) => model);
}

export function createChatGPTModelCheck({ dataDir = path.resolve('data'), spawn = nodeSpawn, timeoutMs = 30000 } = {}) {
  return async function check(modelId) {
    if (typeof modelId !== 'string' || !/^openai\/[A-Za-z0-9._:-]{1,100}$/.test(modelId)) throw new Error('Select a current OpenAI catalog model');
    const auth = providerEntry(await readAuth(dataDir));
    if (!auth?.refresh || !auth?.accountId || !await readConnectionGeneration(dataDir, createHash('sha256').update(auth.accountId).digest('hex'))) throw new Error('ChatGPT subscription is not connected');
    const selected = modelId.slice('openai/'.length);
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'op2-chatgpt-check-'));
    const nonce = randomBytes(24).toString('hex');
    try {
      const configDir = path.join(cwd, 'xdg-config');
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      const toolName = 'op2probe_confirm_nonce';
      const tools = { '*': false, [toolName]: true };
      const permission = { '*': 'deny', [toolName]: 'allow' };
      const helpers = Object.fromEntries(['title', 'summary', 'compaction'].map(name => [name, { model: modelId, tools: { '*': false }, permission: { '*': 'deny' } }]));
      const config = {
        model: modelId, small_model: modelId,
        mcp: { op2probe: { type: 'local', command: [process.execPath, PROBE_MODULE], enabled: true, environment: { OP2_PROBE_NONCE: nonce } } },
        permission,
        agent: {
          'op2-chatgpt-probe': { mode: 'primary', model: modelId, tools, permission },
          ...helpers,
        },
      };
      await fs.writeFile(path.join(cwd, 'opencode.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      const env = { ...minimalEnv(dataDir), XDG_CONFIG_HOME: configDir, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
      const output = await new Promise((resolve, reject) => {
        let stdout = '', settled = false, timedOut = false, killTimer;
        const child = spawn('opencode', ['run', '--format', 'json', '--model', modelId, '--agent', 'op2-chatgpt-probe'], {
          cwd, env,
          stdio: ['pipe', 'pipe', 'ignore'], shell: false,
        });
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGTERM'); } catch { settle(new Error('Model check timed out')); return; }
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1500);
          killTimer.unref?.();
        }, timeoutMs);
        function settle(err, value) { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(killTimer); err ? reject(err) : resolve(value); }
        child.stdout.on('data', x => { stdout = (stdout + x.toString()).slice(-16384); });
        child.on('error', () => settle(new Error('Model check could not start')));
        child.on('exit', code => settle(!timedOut && code === 0 ? null : new Error(timedOut ? 'Model check timed out' : 'Selected ChatGPT model check failed'), stdout));
        child.stdin.end(`Call the MCP tool ${toolName} with nonce ${nonce}, then reply with exactly that nonce. Do not call any other tool.`);
      });
      let text = '', probeCompleted = false;
      try {
        for (const line of output.trim().split(/\r?\n/)) {
          const event = JSON.parse(line);
          if (event.type === 'text' && typeof event.part?.text === 'string') text += event.part.text;
          if (event.type === 'tool_use') {
            const part = event.part || {};
            if (part.tool !== toolName || part.state?.status !== 'completed' || part.state?.input?.nonce !== nonce || !String(part.state?.output || '').includes(nonce)) throw new Error();
            probeCompleted = true;
          }
          if (event.type === 'error') throw new Error();
        }
      } catch { throw new Error('Selected ChatGPT model check returned an invalid or unsupported result'); }
      if (!probeCompleted || !text.includes(nonce)) throw new Error('Selected ChatGPT model check did not complete the isolated nonce probe');
      return { ok: true, model: `openai/${selected}`, status: 'verified' };
    } finally { await fs.rm(cwd, { recursive: true, force: true }); }
  };
}

export function createChatGPTAuthFlow({ dataDir = path.resolve('data'), spawn = nodeSpawn, timeoutMs = FLOW_TTL_MS } = {}) {
  let flow = null;
  function signalOwned(current, signal) {
    try {
      if (process.platform !== 'win32' && current.child?.pid) process.kill(-current.child.pid, signal);
      else current.child?.kill(signal);
    } catch {}
  }
  function finish(current, status) {
    if (!current || current.status !== 'pending') return;
    current.status = status;
    clearTimeout(current.timer);
    current.buffer = ''; current.rawBuffer = ''; current.code = null; current.url = null;
    if (!current.childActive) { current.complete?.(); return; }
    signalOwned(current, 'SIGTERM');
    current.cleanupTimer = setTimeout(() => {
      signalOwned(current, 'SIGKILL');
      current.cleanupTimer = setTimeout(() => { current.cleanupTimer = null; current.childActive = false; current.complete?.(); }, 100);
      current.cleanupTimer.unref?.();
    }, 200);
    current.cleanupTimer.unref?.();
  }
  return {
    start() {
      if (flow?.status === 'pending' && flow.expiresAt > Date.now()) return { id: flow.id, status: 'pending', expiresAt: flow.expiresAt };
      if (flow?.status === 'pending' && flow.expiresAt <= Date.now()) finish(flow, 'expired');
      if (flow?.childActive || flow?.cleanupTimer) throw new Error('ChatGPT connection cleanup is still in progress');
      const id = randomBytes(24).toString('hex');
      let complete;
      const completion = new Promise(resolve => { complete = resolve; });
      const current = flow = { id, status: 'pending', url: null, code: null, child: null, buffer: '', rawBuffer: '', expiresAt: Date.now() + timeoutMs, completion, complete, exitSeen: false };
      current.timer = setTimeout(() => finish(current, 'expired'), timeoutMs);
      current.timer.unref?.();
      try {
        ensurePrivateNativeProfile(dataDir);
        current.child = spawn('opencode', ['auth', 'login', '--provider', 'openai', '--method', 'ChatGPT Pro/Plus (headless)', '--pure'], {
          env: minimalEnv(dataDir), stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: process.platform !== 'win32',
        });
        current.childActive = Boolean(current.child);
      } catch { finish(current, 'error'); }
      const onData = chunk => {
        if (flow !== current || current.status !== 'pending') return;
        current.rawBuffer = (current.rawBuffer + String(chunk)).slice(-MAX_OUTPUT);
        current.buffer = current.rawBuffer.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
        if (current.buffer.includes('auth.openai.com/codex/device')) current.url = AUTH_URL;
        const code = current.buffer.match(/Enter code:\s*([A-Z0-9-]{4,24})/i);
        if (code) current.code = code[1];
      };
      current.child?.stdout?.on('data', onData);
      current.child?.stderr?.on('data', onData);
      current.child?.on('error', () => { current.childActive = false; finish(current, 'error'); });
      current.child?.on('exit', code => {
        current.childActive = false;
        if (current.status !== 'pending') { if (!current.cleanupTimer) current.complete?.(); return; }
        current.exitSeen = true;
        clearTimeout(current.timer);
        (async () => {
          try {
            const auth = providerEntry(await readAuth(dataDir));
            if (code !== 0 || !auth?.refresh || !auth?.accountId) { current.status = 'error'; return; }
            await fs.chmod(nativeAuthPath(dataDir, minimalEnv(dataDir)), 0o600);
            await setConnectionGeneration(dataDir, auth.accountId, { forceNew: true });
            current.status = 'connected';
          } catch { current.status = 'error'; }
          finally { current.buffer = ''; current.rawBuffer = ''; current.code = null; current.url = null; current.complete(); }
        })();
      });
      return { id, status: 'pending', expiresAt: current.expiresAt };
    },
    async status(id) {
      if (!flow || id !== flow.id) return null;
      if (flow.expiresAt <= Date.now() && flow.status === 'pending') finish(flow, 'expired');
      if (flow.exitSeen) await flow.completion;
      return { status: flow.status, url: flow.status === 'pending' ? flow.url : null, code: flow.status === 'pending' ? flow.code : null, expiresAt: flow.expiresAt };
    },
    cancel(id) {
      if (!flow || id !== flow.id) return false;
      finish(flow, 'cancelled'); flow.buffer = ''; flow.code = null;
      return true;
    },
    isPending() { return flow?.status === 'pending' || Boolean(flow?.childActive); },
  };
}
