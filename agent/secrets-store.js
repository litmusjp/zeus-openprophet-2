// Private store for credentials the operator manages in the app (instead of Railway variables).
// One owner-only JSON file next to the agent config. It never leaves the process: routes expose only a
// source label and the last four characters, and no stored value is ever returned, logged or prompted.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const PROVIDERS = Object.freeze({
  gemini: { env: 'GEMINI_API_KEY', label: 'Gemini' },
  opencode: { env: 'OPENCODE_API_KEY', label: 'OpenCode' },
  anthropic: { env: 'ANTHROPIC_API_KEY', label: 'Anthropic' },
});
const CHANGE_LOG_LIMIT = 50;
const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });

function emptyStore() {
  return { version: 1, providers: {}, dashboardLogin: null, accounts: {}, alphadesk: {}, changeLog: [] };
}

let state = { filePath: null, split: false, store: emptyStore(), bootEnv: null, corrupt: false };

function defaultPath() {
  const configPath = process.env.OPENPROPHET_CONFIG_PATH;
  return process.env.OPENPROPHET_SECRETS_PATH
    || path.join(configPath ? path.dirname(configPath) : path.join(__dirname, '..', 'data'), 'secrets.json');
}

/** Initialise (or re-initialise, for tests) the store. `split` turns on moving account and AlphaDesk keys out of the config file. */
export function initSecrets({ filePath = defaultPath(), split = false } = {}) {
  state = { filePath, split: Boolean(split), store: emptyStore(), bootEnv: state.bootEnv, corrupt: false };
  if (!state.bootEnv) {
    state.bootEnv = {};
    for (const spec of Object.values(PROVIDERS)) state.bootEnv[spec.env] = process.env[spec.env];
  }
  loadFromDisk();
  return state.filePath;
}

export function isSplitEnabled() { return state.split; }
export function secretsPath() { return state.filePath; }
export function isCorrupt() { return state.corrupt; }

function loadFromDisk() {
  state.store = emptyStore();
  if (!state.filePath) return;
  let raw;
  try { raw = fs.readFileSync(state.filePath, 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return;
    console.error('[secrets] could not read the private store (error code ' + (error.code || 'unknown') + ')');
    state.corrupt = true;
    return;
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state.store = { ...emptyStore(), ...parsed, providers: parsed.providers || {}, accounts: parsed.accounts || {}, alphadesk: parsed.alphadesk || {}, changeLog: Array.isArray(parsed.changeLog) ? parsed.changeLog : [] };
    }
  } catch {
    console.error('[secrets] the private store is not valid JSON; it was left untouched');
    state.store = emptyStore();
    state.corrupt = true;
  }
}

/** Re-read from disk, ignoring memory. Used to verify a migration actually reached the file. */
export function readFromDiskFresh() {
  const raw = fs.readFileSync(state.filePath, 'utf8');
  return { ...emptyStore(), ...JSON.parse(raw) };
}

export function saveSecrets() {
  if (!state.filePath) throw new Error('secrets store is not initialised');
  if (state.corrupt) throw new Error('secrets store file is unreadable; refusing to overwrite it');
  const dir = path.dirname(state.filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify(state.store, null, 2);
  const tmp = state.filePath + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { if (fs.existsSync(state.filePath)) fs.copyFileSync(state.filePath, state.filePath + '.bak'); } catch { /* best effort */ }
  fs.renameSync(tmp, state.filePath);
  try { fs.chmodSync(state.filePath, 0o600); if (fs.existsSync(state.filePath + '.bak')) fs.chmodSync(state.filePath + '.bak', 0o600); } catch { /* not supported on this filesystem */ }
}

function logChange(item, action, actor) {
  state.store.changeLog.unshift({ item, action, at: new Date().toISOString(), from: String(actor || 'operator').slice(0, 64) });
  state.store.changeLog.length = Math.min(state.store.changeLog.length, CHANGE_LOG_LIMIT);
}

export function changeLog(limit = 10) { return state.store.changeLog.slice(0, limit); }

// ── provider API keys ───────────────────────────────────────────
const VALUE_RE = /^[^\s\x00-\x1f\x7f]{8,512}$/;
export function validateProviderValue(value) {
  if (typeof value !== 'string' || !VALUE_RE.test(value)) throw new Error('The key must be 8 to 512 characters with no spaces or control characters');
  return value;
}
function assertProvider(name) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDERS, name)) throw new Error('Unknown provider');
  return PROVIDERS[name];
}

/** Put the effective key for each provider into the environment: saved value, else the Railway value captured at boot. */
export function applyProviderEnv() {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const saved = state.store.providers[name]?.value;
    if (saved) process.env[spec.env] = saved;
    else if (state.bootEnv?.[spec.env] !== undefined) process.env[spec.env] = state.bootEnv[spec.env];
    else delete process.env[spec.env];
  }
}

export function setProvider(name, value, actor) {
  assertProvider(name);
  validateProviderValue(value);
  state.store.providers[name] = { value, savedAt: new Date().toISOString() };
  logChange('provider:' + name, 'saved', actor);
  saveSecrets();
  applyProviderEnv();
}

export function removeProvider(name, actor) {
  assertProvider(name);
  delete state.store.providers[name];
  logChange('provider:' + name, 'removed', actor);
  saveSecrets();
  applyProviderEnv();
}

function last4(value) { return typeof value === 'string' && value.length >= 12 ? value.slice(-4) : value ? '****' : null; }

export function providerStatus() {
  const out = {};
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const saved = state.store.providers[name];
    const railway = state.bootEnv?.[spec.env];
    out[name] = saved?.value
      ? { source: 'saved', last4: last4(saved.value), savedAt: saved.savedAt, label: spec.label }
      : railway ? { source: 'railway', last4: last4(railway), savedAt: null, label: spec.label }
        : { source: 'unset', last4: null, savedAt: null, label: spec.label };
  }
  return out;
}

export function providerValueForCheck(name) {
  assertProvider(name);
  return process.env[PROVIDERS[name].env] || '';
}

// ── dashboard login ─────────────────────────────────────────────
function scryptHash(password, salt) {
  return crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
}
export function validateLoginInput({ username, newPassword, confirmPassword }) {
  if (typeof username !== 'string' || username.length < 3 || username.length > 64 || username.includes(':') || /[\x00-\x1f\x7f]/.test(username)) {
    throw new Error('Username must be 3 to 64 characters with no colon');
  }
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 256 || /[\x00-\x1f\x7f]/.test(newPassword)) {
    throw new Error('Password must be at least 12 characters');
  }
  if (newPassword !== confirmPassword) throw new Error('The two passwords do not match');
}
export function setDashboardLogin({ username, newPassword }, actor) {
  const salt = crypto.randomBytes(16).toString('hex');
  state.store.dashboardLogin = { username, salt, hash: scryptHash(newPassword, salt), params: { ...SCRYPT }, savedAt: new Date().toISOString() };
  logChange('dashboard-login', 'saved', actor);
  saveSecrets();
}
export function removeDashboardLogin(actor) {
  state.store.dashboardLogin = null;
  logChange('dashboard-login', 'removed', actor);
  saveSecrets();
}
export function getDashboardLogin() { return state.store.dashboardLogin; }
export function verifySavedPassword(username, password) {
  const saved = state.store.dashboardLogin;
  if (!saved) return false;
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const userOk = crypto.timingSafeEqual(digest(username), digest(saved.username));
  const hash = Buffer.from(scryptHash(String(password), saved.salt), 'hex');
  const expected = Buffer.from(saved.hash, 'hex');
  return userOk && hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

// ── account and AlphaDesk keys (moved out of the config file) ───
export function getAccountKeys(id) { return state.store.accounts[id] || null; }
export function setAccountKeys(id, { publicKey, secretKey }) { state.store.accounts[id] = { publicKey, secretKey }; }
export function deleteAccountKeys(id) { delete state.store.accounts[id]; }
export function getAlphaDeskKey(scope) { return state.store.alphadesk[scope] || ''; }
export function setAlphaDeskKey(scope, apiKey) { if (apiKey) state.store.alphadesk[scope] = apiKey; else delete state.store.alphadesk[scope]; }
export function recordChange(item, action, actor) { logChange(item, action, actor); }
export function snapshotForTests() { return JSON.parse(JSON.stringify(state.store)); }

/** Digest of a secret pair, so a migration can be verified without comparing or printing the values. */
export function digestOf(...parts) { return crypto.createHash('sha256').update(parts.map(p => String(p ?? '')).join('\u0000')).digest('hex'); }
