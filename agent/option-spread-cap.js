// OP2's entry spread cap lives in the Go backend: it refuses an opening whose spread, on AlphaDesk's own quote, is above the
// sandbox's saved maxOptionSpreadPct. A running backend receives a changed value through a server-only risk endpoint before the
// setting is saved; a backend that is not running reads the saved value from its environment at start. Because a push can fail
// in an ambiguous way (the backend applied it but the answer was lost) and saves can overlap, every change runs one at a time,
// is confirmed by reading the backend back, and is re-checked before each heartbeat until the backend and the saved value agree.

const PATH = '/api/v1/risk/option-spread-cap';
export const CAP_CONTROL_HEADER = 'X-OpenProphet-Cap-Control-Token';
export const CAP_CONTROL_ENV = 'OPENPROPHET_CAP_CONTROL_TOKEN';

const headers = token => ({ [CAP_CONTROL_HEADER]: token });
// The backend reports the enforced cap with its revision (every change of the enforced value moves it). A backend that does not
// report a whole-number revision cannot be confirmed.
const sameCap = (data, pct) => Number(data?.effective_pct) === Number(pct) && data?.configured === true && !data?.invalid && Number.isSafeInteger(data?.revision);

/**
 * Push the cap to a running backend. Resolves false when there is no running backend (nothing to push); throws when the
 * backend does not accept the value or reports a different one, so the caller can refuse the save as a whole.
 */
export async function pushOptionSpreadCap(client, pct, { token = process.env[CAP_CONTROL_ENV] || '' } = {}) {
  if (!client) return false;
  let response;
  try {
    response = await client.put(PATH, { pct }, { timeout: 4000, headers: headers(token) });
  } catch (error) {
    throw new Error(`The running trading backend did not accept the new option spread cap, so nothing was saved (${error?.response?.data?.error || error?.message || 'unknown error'}).`);
  }
  if (!sameCap(response?.data, pct)) throw new Error('The running trading backend reported a different option spread cap, so nothing was saved.');
  return true;
}

/**
 * Bring a running backend to the saved cap and confirm it by reading it back. States: in_sync, no_backend, unreconciled
 * (could not be confirmed; the next call tries again).
 */
export async function reconcileOptionSpreadCap(client, savedPct, { token = process.env[CAP_CONTROL_ENV] || '', attempts = 2 } = {}) {
  if (!client) return { state: 'no_backend' };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const current = await client.get(PATH, { timeout: 4000 });
      if (sameCap(current?.data, savedPct)) return { state: 'in_sync', revision: current.data.revision };
    } catch { /* fall through to a push, then read back again */ }
    try { await client.put(PATH, { pct: savedPct }, { timeout: 4000, headers: headers(token) }); } catch { /* confirmed by the next read */ }
  }
  try {
    const last = await client.get(PATH, { timeout: 4000 });
    if (sameCap(last?.data, savedPct)) return { state: 'in_sync', revision: last.data.revision };
  } catch { /* unreconciled */ }
  return { state: 'unreconciled' };
}

function createSerialQueue() {
  let tail = Promise.resolve();
  return task => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

/**
 * One owner for every change of the saved cap: saves and heartbeat re-checks run one at a time.
 *  getClient(sandboxId)  -> the running backend's client or null
 *  getSaved(sandboxId)   -> the saved cap in percent
 *  save(sandboxId, patch, { beforePersist }) -> persists the guidance (validates first; throws on a bad value or a failed write)
 */
export function createOptionSpreadCapController({ getClient, getSaved, save, token = () => process.env[CAP_CONTROL_ENV] || '' }) {
  const queue = createSerialQueue();
  const options = () => ({ token: token() });
  return {
    save(sandboxId, patch) {
      return queue(async () => {
        try {
          const guidance = await save(sandboxId, patch, {
            beforePersist: async next => { await pushOptionSpreadCap(getClient(sandboxId), next.maxOptionSpreadPct, options()); },
          });
          // Confirm by reading the backend back; anything that cannot be confirmed is corrected at the next heartbeat.
          const confirmed = await reconcileOptionSpreadCap(getClient(sandboxId), guidance.maxOptionSpreadPct, options());
          return { guidance, capSync: confirmed.state };
        } catch (error) {
          // Ambiguous: the backend may or may not hold the new value. Put it back to what is saved and confirm that.
          const restored = await reconcileOptionSpreadCap(getClient(sandboxId), getSaved(sandboxId), options());
          if (restored.state === 'unreconciled') {
            error.message += ' The running backend could not be confirmed at the saved cap; it is re-checked and corrected before the next heartbeat.';
          }
          throw error;
        }
      });
    },
    // Called before every heartbeat; never throws.
    reconcile(sandboxId) {
      return queue(async () => reconcileOptionSpreadCap(getClient(sandboxId), getSaved(sandboxId), options())).catch(() => ({ state: 'unreconciled' }));
    },
  };
}
