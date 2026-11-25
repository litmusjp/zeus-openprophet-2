// Moves the Alpaca account keys and the AlphaDesk API keys out of agent-config.json into the private
// secrets file. In memory nothing changes: the loaded config still holds the real keys (in the same key
// order as before, so API output and the protected config hash do not move), so every reader keeps working.
// Only what is written to agent-config.json differs: a marker stands where the key was.
import fs from 'node:fs';
import path from 'node:path';
import * as secrets from './secrets-store.js';
import { safeCode } from './durable-file.js';

let active = false;               // true once keys are written as markers
const unresolved = new Set();     // markers whose key could not be found; kept as markers so they are never lost
const note = (code) => console.error('[secrets] ' + code);

export function isActive() { return active; }
export function resetForTests() { active = false; unresolved.clear(); }

// Staged loading: a candidate that is rejected must leave no trace in the module-level bookkeeping.
export function bookkeepingSnapshot() { return new Set(unresolved); }
export function bookkeepingRestore(snapshot) { unresolved.clear(); for (const item of snapshot) unresolved.add(item); }
export function unresolvedCount() { return unresolved.size; }

const hasValue = (v) => typeof v === 'string' && v.length > 0;

/** Rebuilds an object key by key so replaced entries keep their position. */
function rebuild(obj, fn) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) fn(out, key, value);
  return out;
}

/** Calls fn(scope, slot, replace) for the global AlphaDesk plugin settings and each sandbox's copy. */
export function forEachAlphaDeskSlot(config, fn) {
  const global = config?.plugins?.alphadesk;
  if (global && typeof global === 'object') fn('alphadesk:global', global, next => { config.plugins.alphadesk = next; });
  for (const [id, sandbox] of Object.entries(config?.sandboxes || {})) {
    const slot = sandbox?.plugins?.alphadesk;
    if (slot && typeof slot === 'object') fn('alphadesk:' + id, slot, next => { sandbox.plugins.alphadesk = next; });
  }
}

export function emptyPlan() { return { plaintext: [] }; }

/**
 * Candidate-local check of the key references a RAW config holds (a marker means "the key lives in the private store"). Pure: it never
 * changes the bookkeeping, the private store or the candidate. Legacy plaintext keys carry their own values and need no store.
 * { ok, reason: 'private_store_unavailable' | 'keys_missing', markers, missing }
 */
export function referenceStatus(raw) {
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  let markers = 0;
  for (const account of accounts) if (account && account.secretRef) markers += 1;
  forEachAlphaDeskSlot(raw || {}, (scope, slot) => { if (slot && slot.apiKeyRef) markers += 1; });
  if (!markers) return { ok: true, markers: 0, missing: 0 };
  if (!secrets.isSplitEnabled() || secrets.isCorrupt()) return { ok: false, reason: 'private_store_unavailable', markers, missing: markers };
  let missing = 0;
  for (const account of accounts) {
    if (!account || !account.secretRef) continue;
    const keys = secrets.getAccountKeys(account.id);
    if (!(keys && hasValue(keys.publicKey) && hasValue(keys.secretKey))) missing += 1;
  }
  forEachAlphaDeskSlot(raw || {}, (scope, slot) => { if (slot && slot.apiKeyRef && !hasValue(secrets.getAlphaDeskKey(scope))) missing += 1; });
  return missing ? { ok: false, reason: 'keys_missing', markers, missing } : { ok: true, markers, missing: 0 };
}

/**
 * Works on the parsed config file before it is normalised: remembers the plaintext keys that still need
 * moving, and replaces markers with the real keys from the private file (so inheritance between the global
 * AlphaDesk settings and each sandbox keeps working exactly as before).
 */
export function prepareRaw(raw) {
  const plan = emptyPlan();
  const accounts = Array.isArray(raw?.accounts) ? raw.accounts : [];
  accounts.forEach((account, index) => {
    if (account.secretRef) {
      const keys = secrets.getAccountKeys(account.id);
      if (keys && hasValue(keys.publicKey) && hasValue(keys.secretKey)) {
        accounts[index] = rebuild(account, (out, key, value) => {
          if (key === 'secretRef') { out.publicKey = keys.publicKey; out.secretKey = keys.secretKey; } else out[key] = value;
        });
      } else {
        unresolved.add('account:' + account.id);
        note('account_keys_missing');
        accounts[index] = rebuild(account, (out, key, value) => { if (key !== 'secretRef') out[key] = value; });
      }
    } else if (hasValue(account.publicKey) && hasValue(account.secretKey)) {
      plan.plaintext.push({ kind: 'account', id: account.id, publicKey: account.publicKey, secretKey: account.secretKey });
    }
  });
  forEachAlphaDeskSlot(raw, (scope, slot, replace) => {
    if (slot.apiKeyRef) {
      const value = secrets.getAlphaDeskKey(scope);
      if (hasValue(value)) replace(rebuild(slot, (out, key, v) => { if (key === 'apiKeyRef') out.apiKey = value; else out[key] = v; }));
      else {
        unresolved.add(scope);
        note('alphadesk_key_missing');
        replace(rebuild(slot, (out, key, v) => { if (key !== 'apiKeyRef') out[key] = v; }));
      }
    } else if (hasValue(slot.apiKey)) {
      plan.plaintext.push({ kind: 'alphadesk', scope, apiKey: slot.apiKey });
    }
  });
  return plan;
}

function backupConfigFile(configPath, accountIds) {
  if (!fs.existsSync(configPath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(path.dirname(configPath), 'agent-config.pre-secrets-' + stamp + '.json');
  const bytes = fs.readFileSync(configPath);
  const fd = fs.openSync(backup, 'wx', 0o600);              // exclusive and restrictive from the first open (never copy-then-chmod)
  try { fs.writeSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const copy = JSON.parse(fs.readFileSync(backup, 'utf8'));
  const ids = (copy.accounts || []).map(a => a.id).sort().join(',');
  if (ids !== [...accountIds].sort().join(',')) throw new Error('backup_mismatch');
  return backup;
}

/**
 * Moves the plaintext keys found by prepareRaw into the private file, then proves the file holds the same
 * values before the config is ever rewritten. Any failure keeps the old layout (active stays false).
 */
export function adopt(plan, { configPath, accountIds = [] } = {}) {
  active = false;
  if (secrets.isCorrupt()) { note('store_unreadable_old_layout_kept'); return { active: false, migrated: 0, error: 'store_unreadable' }; }
  if (!plan.plaintext.length) { active = true; return { active: true, migrated: 0 }; }
  let backup = null;
  // What the private store held before this migration, so a failure restores it instead of deleting it.
  const previous = plan.plaintext.map(item => item.kind === 'account'
    ? { item, old: (() => { const k = secrets.getAccountKeys(item.id); return k ? { ...k } : null; })() }
    : { item, old: secrets.getAlphaDeskKey(item.scope) || '' });
  try {
    backup = backupConfigFile(configPath, accountIds);
    for (const item of plan.plaintext) {
      if (item.kind === 'account') secrets.setAccountKeys(item.id, { publicKey: item.publicKey, secretKey: item.secretKey });
      else secrets.setAlphaDeskKey(item.scope, item.apiKey);
    }
    secrets.recordChange('keys-moved', 'migrated ' + plan.plaintext.length + ' item(s) to the private file', 'startup');
    secrets.saveSecrets();
    const fresh = secrets.readFromDiskFresh();
    for (const item of plan.plaintext) {
      if (item.kind === 'account') {
        const got = fresh.accounts?.[item.id];
        if (!got || secrets.digestOf(got.publicKey, got.secretKey) !== secrets.digestOf(item.publicKey, item.secretKey)) throw new Error('verify_account');
      } else if (secrets.digestOf(fresh.alphadesk?.[item.scope]) !== secrets.digestOf(item.apiKey)) throw new Error('verify_alphadesk');
    }
  } catch (error) {
    note('migration_failed_old_layout_kept:' + safeCode(error, 'migration'));
    try {
      for (const { item, old } of previous) {
        if (item.kind === 'account') { if (old) secrets.setAccountKeys(item.id, old); else secrets.deleteAccountKeys(item.id); }
        else secrets.setAlphaDeskKey(item.scope, old);
      }
      secrets.saveSecrets();
    } catch { /* leave the entries as they are; they are unused while markers are not written */ }
    return { active: false, migrated: 0, error: safeCode(error, 'migration') };
  }
  active = true;
  return { active: true, migrated: plan.plaintext.length, backup: backup ? path.basename(backup) : null };
}

/** Copy any new or changed keys from the in-memory config into the private file. Returns true if it wrote. */
export function syncFromConfig(config) {
  let changed = false;
  for (const account of config.accounts || []) {
    if (hasValue(account.publicKey) && hasValue(account.secretKey)) {
      const existing = secrets.getAccountKeys(account.id);
      if (!existing || existing.publicKey !== account.publicKey || existing.secretKey !== account.secretKey) {
        secrets.setAccountKeys(account.id, { publicKey: account.publicKey, secretKey: account.secretKey });
        changed = true;
      }
      unresolved.delete('account:' + account.id);
    }
  }
  forEachAlphaDeskSlot(config, (scope, slot) => {
    const existing = secrets.getAlphaDeskKey(scope);
    if (hasValue(slot.apiKey)) {
      if (existing !== slot.apiKey) { secrets.setAlphaDeskKey(scope, slot.apiKey); changed = true; }
      unresolved.delete(scope);
    } else if (existing && !unresolved.has(scope)) {
      secrets.setAlphaDeskKey(scope, '');
      changed = true;
    }
  });
  if (changed) secrets.saveSecrets();
  return changed;
}

/** The copy of the config that is written to disk: each key replaced, in place, by a marker. */
export function toDiskConfig(config) {
  const clone = JSON.parse(JSON.stringify(config));
  if (Array.isArray(clone.accounts)) {
    clone.accounts = clone.accounts.map(account => {
      const hasKeys = hasValue(account.publicKey) && hasValue(account.secretKey);
      if (!hasKeys && !unresolved.has('account:' + account.id)) return account;
      const marker = 'account:' + account.id;
      let placed = false;
      const out = rebuild(account, (o, key, value) => {
        if (key === 'publicKey' || key === 'secretKey') { if (!placed) { o.secretRef = marker; placed = true; } } else o[key] = value;
      });
      if (!placed) out.secretRef = marker;
      return out;
    });
  }
  forEachAlphaDeskSlot(clone, (scope, slot, replace) => {
    if (!hasValue(slot.apiKey) && !unresolved.has(scope)) return;
    let placed = false;
    const out = rebuild(slot, (o, key, value) => {
      if (key === 'apiKey') { o.apiKeyRef = scope; placed = true; } else o[key] = value;
    });
    if (!placed) out.apiKeyRef = scope;
    replace(out);
  });
  return clone;
}

/** Forget the stored keys of a removed account and its sandbox. */
export function forgetAccount(id) {
  secrets.deleteAccountKeys(id);
  secrets.setAlphaDeskKey('alphadesk:sbx_' + id, '');
  unresolved.delete('account:' + id);
  unresolved.delete('alphadesk:sbx_' + id);
  secrets.saveSecrets();
}
