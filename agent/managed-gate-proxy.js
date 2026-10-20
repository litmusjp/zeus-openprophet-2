import { createHash } from 'crypto';

export const MANAGED_ALPHADESK_ORIGIN = 'https://api-production-4689.up.railway.app';
export const SHARED_MANAGED_SANDBOXES = Object.freeze({
  sbx_723be98b: 'L1',
  sbx_956ff9e4: 'L2',
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function safeMetadata(env) {
  const workspaceId = env.ALPHADESK_CONTROL_WORKSPACE_ID || '';
  const assessmentKeyId = env.ALPHADESK_CONTROL_ASSESSMENT_KEY_ID || '';
  const assessmentKeySha256 = env.ALPHADESK_CONTROL_ASSESSMENT_KEY_SHA256 || '';
  const configured = Boolean(
    env.ALPHADESK_CONTROL_KEY && UUID.test(workspaceId) && UUID.test(assessmentKeyId)
    && SHA256.test(assessmentKeySha256),
  );
  return { configured, workspaceId, assessmentKeyId, assessmentKeySha256 };
}

function scopeOf(document, expected) {
  const gate = document?.approval_gate;
  const scope = gate?.scope;
  if (document?.contract_version !== 'managed-assessment-v1'
    || !gate || typeof gate.required !== 'boolean'
    || !Number.isSafeInteger(gate.revision) || gate.revision < 1
    || !scope || scope.workspace_id !== expected.workspaceId
    || scope.assessment_key_id !== expected.assessmentKeyId) {
    throw new Error('managed policy readback is invalid or outside the configured scope');
  }
  return { required: gate.required, revision: gate.revision, scope: { workspace_id: scope.workspace_id, assessment_key_id: scope.assessment_key_id } };
}

async function upstreamFetch(fetchImpl, { method = 'GET', assessmentKey, controlKey, body, endpoint = 'managed-review-gate', timeoutMs = 8000, maxBytes = 65536 } = {}) {
  const headers = { 'X-AlphaDesk-API-Key': assessmentKey, Accept: 'application/json' };
  if (controlKey) headers['X-AlphaDesk-Control-Key'] = controlKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const controller = new AbortController();
  let timeout;
  const deadline = new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('managed policy deadline exceeded')); }, timeoutMs); });
  try {
    return await Promise.race([(async () => {
    const response = await fetchImpl(`${MANAGED_ALPHADESK_ORIGIN}/api/v2/option-trade-assessments/${endpoint}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
      signal: controller.signal,
    });
    if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('upstream redirect rejected');
    const declared = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error('managed policy response exceeded limit');
    const reader = response.body?.getReader?.();
    if (!reader) {
      const text = await response.text();
      if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('managed policy response exceeded limit');
      return { response, text };
    }
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('managed policy response exceeded limit'); }
      chunks.push(Buffer.from(value));
    }
    return { response, text: Buffer.concat(chunks, size).toString('utf8') };
    })(), deadline]);
  } finally { clearTimeout(timeout); }
}

async function readGate(result, expected) {
  return scopeOf(JSON.parse(result.text), expected);
}

function exactRootBinding(value) {
  try {
    const url = new URL(value);
    return url.origin === MANAGED_ALPHADESK_ORIGIN && url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password;
  } catch { return false; }
}

export function createManagedGateProxy({ getSandbox, getPluginForSandbox, env = process.env, fetchImpl = fetch, timeoutMs = 8000, maxBodyBytes = 65536 }) {
  async function resolveBinding(sandboxId) {
    if (!Object.hasOwn(SHARED_MANAGED_SANDBOXES, sandboxId)) throw Object.assign(new Error('Managed policy is unavailable for this sandbox'), { status: 404 });
    const expected = safeMetadata(env);
    if (!expected.configured) throw Object.assign(new Error('Managed policy authority is not configured'), { status: 503 });
    const sandbox = getSandbox(sandboxId);
    const plugin = getPluginForSandbox(sandboxId, 'alphadesk');
    if (!sandbox || !plugin || plugin.enabled !== true || plugin.requireManagedApprovalGate !== true
      || !plugin.url || !plugin.apiKey) throw Object.assign(new Error('Sandbox managed connection is unavailable'), { status: 503 });
    const actualHash = createHash('sha256').update(plugin.apiKey, 'utf8').digest('hex');
    if (!exactRootBinding(plugin.url) || actualHash !== expected.assessmentKeySha256) {
      throw Object.assign(new Error('Sandbox managed connection does not match the pinned authority'), { status: 409 });
    }
    for (const id of Object.keys(SHARED_MANAGED_SANDBOXES)) {
      const peerSandbox = getSandbox(id);
      const peer = getPluginForSandbox(id, 'alphadesk');
      if (!peerSandbox || !peer || peer.enabled !== true || peer.requireManagedApprovalGate !== true
        || !peer.apiKey || createHash('sha256').update(peer.apiKey, 'utf8').digest('hex') !== expected.assessmentKeySha256) {
        throw Object.assign(new Error('Shared managed connection scope is incomplete'), { status: 409 });
      }
      if (!exactRootBinding(peer.url)) throw Object.assign(new Error('Shared managed connection scope is incomplete'), { status: 409 });
    }
    return { ...expected, assessmentKey: plugin.apiKey, label: 'Shared AlphaDesk connection: L1 + L2' };
  }

  async function read(sandboxId) {
    const binding = await resolveBinding(sandboxId);
    const result = await upstreamFetch(fetchImpl, { assessmentKey: binding.assessmentKey, timeoutMs, maxBytes: maxBodyBytes });
    const response = result.response;
    if (response.status !== 200) throw Object.assign(new Error('Managed policy authority could not be read'), { status: 502 });
    let gate;
    try { gate = await readGate(result, binding); }
    catch { throw Object.assign(new Error('Managed policy readback is unknown'), { status: 502 }); }
    return {
      status: 'effective', required: gate.required, revision: gate.revision,
      scope: gate.scope, sharedConnection: binding.label,
      op2RequireConfirmation: getSandbox(sandboxId).permissions?.requireConfirmation === true,
      fetchedAt: new Date().toISOString(),
    };
  }

  async function handle(req, res) {
    res.set('Cache-Control', 'no-store, max-age=0');
    res.set('Pragma', 'no-cache');
    const sandboxId = req.method === 'GET' ? req.query.sandboxId : req.body?.sandboxId;
    try {
      if (typeof sandboxId !== 'string' || !sandboxId) throw Object.assign(new Error('Select a managed sandbox'), { status: 400 });
      if (req.method === 'GET') return res.json(await read(sandboxId));
      const payload = req.body;
      if (!payload || Object.keys(payload).sort().join(',') !== 'expectedRevision,required,sandboxId'
        || typeof payload.required !== 'boolean' || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
        throw Object.assign(new Error('A strict required boolean and positive expected revision are required'), { status: 422 });
      }
      const binding = await resolveBinding(sandboxId);
      const before = await read(sandboxId);
      if (before.revision !== payload.expectedRevision) throw Object.assign(new Error('Managed policy changed; reload current state'), { status: 409 });
      const writeResult = await upstreamFetch(fetchImpl, {
        method: 'PUT', assessmentKey: binding.assessmentKey, controlKey: env.ALPHADESK_CONTROL_KEY,
        body: { required: payload.required, expected_revision: payload.expectedRevision }, timeoutMs, maxBytes: maxBodyBytes,
      });
      if (writeResult.response.status === 409) throw Object.assign(new Error('Managed policy changed; reload current state'), { status: 409 });
      if (writeResult.response.status !== 200) throw Object.assign(new Error('Managed policy write was not confirmed'), { status: 502 });
      // Never trust a write response alone: perform an independent authoritative read.
      const result = await read(sandboxId);
      const expectedRevision = before.required === payload.required
        ? payload.expectedRevision : payload.expectedRevision + 1;
      if (result.required !== payload.required || result.revision !== expectedRevision) {
        throw Object.assign(new Error('Managed policy readback did not match the requested state; current state is unknown'), { status: 502 });
      }
      return res.json(result);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const safeError = status === 400 || status === 404 || status === 409 || status === 422 || status === 503
        ? error?.message : 'Managed policy state is unknown';
      return res.status(status).json({ error: safeError || 'Managed policy state is unknown', status: status === 409 ? 'stale' : status >= 500 ? 'unknown' : 'failed' });
    }
  }

  return { handle, read, resolveBinding };
}

function qualityDocument(document, expected) {
  const decimal = (value, max) => {
    if (typeof value !== 'number' && !(typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value))) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
  };
  const valid = (value) => value && typeof value === 'object'
    && decimal(value.minimum_signal_score, 100) !== null
    && decimal(value.minimum_catalyst_confidence, 1) !== null
    && typeof value.require_price_action_confirmation === 'boolean';
  if (document?.contract_version !== 'managed-assessment-v1'
    || document?.scope?.workspace_id !== expected.workspaceId
    || document?.scope?.assessment_key_id !== expected.assessmentKeyId
    || !Number.isSafeInteger(document.revision) || document.revision < 1
    || !valid(document.defaults) || !valid(document.effective)) throw new Error('managed quality readback is invalid or outside the configured scope');
  const normalized = value => ({ minimum_signal_score: decimal(value.minimum_signal_score, 100),
    minimum_catalyst_confidence: decimal(value.minimum_catalyst_confidence, 1),
    require_price_action_confirmation: value.require_price_action_confirmation });
  return { defaults: normalized(document.defaults), effective: normalized(document.effective), revision: document.revision,
    scope: { workspace_id: document.scope.workspace_id, assessment_key_id: document.scope.assessment_key_id } };
}

export function createManagedQualityProxy({ getSandbox, getPluginForSandbox, env = process.env, fetchImpl = fetch, timeoutMs = 8000, maxBodyBytes = 65536 }) {
  const bindingProxy = createManagedGateProxy({ getSandbox, getPluginForSandbox, env, fetchImpl, timeoutMs, maxBodyBytes });
  async function read(sandboxId) {
    const binding = await bindingProxy.resolveBinding(sandboxId);
    const result = await upstreamFetch(fetchImpl, { assessmentKey: binding.assessmentKey, endpoint: 'managed-quality-settings', timeoutMs, maxBytes: maxBodyBytes });
    if (result.response.status !== 200) {
      const status = [403, 404, 409, 422, 503].includes(result.response.status) ? result.response.status : 502;
      throw Object.assign(new Error(status === 503 ? 'Managed quality policy is not provisioned' : 'Managed quality authority could not be read'), { status });
    }
    let quality;
    try { quality = qualityDocument(JSON.parse(result.text), binding); }
    catch { throw Object.assign(new Error('Managed quality readback is unknown'), { status: 502 }); }
    return { status: 'effective', ...quality, sharedConnection: binding.label, fetchedAt: new Date().toISOString() };
  }
  async function handle(req, res) {
    res.set('Cache-Control', 'no-store, max-age=0'); res.set('Pragma', 'no-cache');
    const sandboxId = req.method === 'GET' ? req.query.sandboxId : req.body?.sandboxId;
    try {
      if (typeof sandboxId !== 'string' || !sandboxId) throw Object.assign(new Error('Select a managed sandbox'), { status: 400 });
      if (req.method === 'GET') return res.json(await read(sandboxId));
      const payload = req.body;
      if (!payload || Object.keys(payload).sort().join(',') !== 'expectedRevision,minimumCatalystConfidence,minimumSignalScore,requirePriceActionConfirmation,sandboxId'
        || typeof payload.minimumSignalScore !== 'number' || !Number.isFinite(payload.minimumSignalScore) || payload.minimumSignalScore < 0 || payload.minimumSignalScore > 100
        || typeof payload.minimumCatalystConfidence !== 'number' || !Number.isFinite(payload.minimumCatalystConfidence) || payload.minimumCatalystConfidence < 0 || payload.minimumCatalystConfidence > 1
        || typeof payload.requirePriceActionConfirmation !== 'boolean'
        || !Number.isSafeInteger(payload.expectedRevision) || payload.expectedRevision < 1) {
        throw Object.assign(new Error('Complete finite quality settings and a strict confirmation boolean are required'), { status: 422 });
      }
      const binding = await bindingProxy.resolveBinding(sandboxId); const before = await read(sandboxId);
      if (before.revision !== payload.expectedRevision) throw Object.assign(new Error('Managed quality policy changed; reload current state'), { status: 409 });
      const expectedEffective = { minimum_signal_score: payload.minimumSignalScore, minimum_catalyst_confidence: payload.minimumCatalystConfidence, require_price_action_confirmation: payload.requirePriceActionConfirmation };
      const result = await upstreamFetch(fetchImpl, { method: 'PUT', assessmentKey: binding.assessmentKey, controlKey: env.ALPHADESK_CONTROL_KEY, endpoint: 'managed-quality-settings', timeoutMs, maxBytes: maxBodyBytes,
        body: { ...expectedEffective, expected_revision: before.revision } });
      if (result.response.status === 409) throw Object.assign(new Error('Managed quality policy changed; reload current state'), { status: 409 });
      if (result.response.status !== 200) {
        const status = [403, 409, 422, 503].includes(result.response.status) ? result.response.status : 502;
        throw Object.assign(new Error(status === 409 ? 'Managed quality policy changed; reload current state' : 'Managed quality write was not confirmed'), { status });
      }
      const saved = qualityDocument(JSON.parse(result.text), binding); const readback = await read(sandboxId);
      const changed = before.effective.minimum_signal_score !== expectedEffective.minimum_signal_score
        || before.effective.minimum_catalyst_confidence !== expectedEffective.minimum_catalyst_confidence
        || before.effective.require_price_action_confirmation !== expectedEffective.require_price_action_confirmation;
      const validRevision = changed ? saved.revision === before.revision + 1
        : saved.revision === before.revision || saved.revision === before.revision + 1;
      if (JSON.stringify(saved.effective) !== JSON.stringify(expectedEffective) || !validRevision
        || JSON.stringify(readback.effective) !== JSON.stringify(expectedEffective) || readback.revision !== saved.revision) {
        throw Object.assign(new Error('Managed quality readback did not match the requested state; current state is unknown'), { status: 502 });
      }
      return res.json(readback);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 502;
      const safeError = status === 400 || status === 404 || status === 409 || status === 422 || status === 503 ? error?.message : 'Managed quality state is unknown';
      return res.status(status).json({ error: safeError || 'Managed quality state is unknown', status: status === 409 ? 'stale' : status >= 500 ? 'unknown' : 'failed' });
    }
  }
  return { handle, read };
}

export function registerManagedGateProxy(app, { proxy, operatorOnly }) {
  app.get('/api/plugins/alphadesk/managed-review-gate', operatorOnly, proxy.handle);
  app.put('/api/plugins/alphadesk/managed-review-gate', operatorOnly, proxy.handle);
}
export function registerManagedQualityProxy(app, { proxy, operatorOnly }) {
  app.get('/api/plugins/alphadesk/managed-quality-settings', operatorOnly, proxy.handle);
  app.put('/api/plugins/alphadesk/managed-quality-settings', operatorOnly, proxy.handle);
}
