// Read-only, bounded, cached size totals of the data folder (H4, Nov 25 hardening).
//
// What it returns: aggregate LOGICAL bytes and file counts in a fixed set of buckets. What it never does: return a path or a file name, read
// a file's contents, follow a symlink or junction, delete, move or write anything, call a provider or the broker, or throw. Platform volume
// capacity, free space and snapshot coverage are NOT knowable from here and are not reported.
import fs from 'node:fs/promises';
import path from 'node:path';

// Top-level folder names that map to a named bucket. Anything else folds into 'other' (the name is never reported).
const BUCKETS = new Map([
  ['sandboxes', 'sandboxes'],
  ['iv-history', 'iv_history'],
  ['chatgpt-xdg-data', 'chatgpt_data'],
]);
export const BUCKET_NAMES = ['sandboxes', 'iv_history', 'chatgpt_data', 'top_level_files', 'other'];

const emptyBuckets = () => Object.fromEntries(BUCKET_NAMES.map(name => [name, { bytes: 0, files: 0 }]));

/** One bounded scan. Returns { buckets, partial } or null when the root cannot be read at all (unavailable is null, never 0). */
export async function scanDataRoot(root, { maxEntries = 200000, maxDepth = 10, maxMs = 4000, now = Date.now, fsx = fs } = {}) {
  const deadline = now() + maxMs;
  const buckets = emptyBuckets();
  let entries = 0;
  let partial = false;
  let top;
  try { top = await fsx.readdir(root, { withFileTypes: true }); } catch { return null; }

  async function walk(dir, bucket, depth) {
    if (partial) return;
    if (depth > maxDepth) { partial = true; return; }
    let children;
    try { children = await fsx.readdir(dir, { withFileTypes: true }); } catch { partial = true; return; }
    for (const child of children) {
      if (entries >= maxEntries || now() > deadline) { partial = true; return; }
      entries += 1;
      if (child.isSymbolicLink()) continue;                         // links and junctions are never followed or counted
      const full = path.join(dir, child.name);
      if (child.isDirectory()) { await walk(full, bucket, depth + 1); if (partial) return; continue; }
      if (!child.isFile()) continue;
      try {
        const stat = await fsx.lstat(full);
        if (!stat.isFile()) continue;
        buckets[bucket].bytes += stat.size;
        buckets[bucket].files += 1;
      } catch { partial = true; }
    }
  }

  for (const child of top) {
    if (entries >= maxEntries || now() > deadline) { partial = true; break; }
    entries += 1;
    if (child.isSymbolicLink()) continue;
    const full = path.join(root, child.name);
    if (child.isDirectory()) await walk(full, BUCKETS.get(child.name) || 'other', 1);
    else if (child.isFile()) {
      try {
        const stat = await fsx.lstat(full);
        if (stat.isFile()) { buckets.top_level_files.bytes += stat.size; buckets.top_level_files.files += 1; }
      } catch { partial = true; }
    }
    if (partial && (entries >= maxEntries || now() > deadline)) break;
  }
  return { buckets, partial };
}

/**
 * A cached view of scanDataRoot. The first call waits for one bounded scan; later calls return the cached snapshot at once and start at most ONE
 * background refresh when it is older than ttlMs. A failed scan never throws and never reads as 0.
 */
export function createDataUsage({ root, ttlMs = 10 * 60 * 1000, now = Date.now, scan = scanDataRoot, scanOptions = {} } = {}) {
  let snapshot = null;      // { at, result }
  let inflight = null;

  const refresh = () => {
    if (inflight) return inflight;
    inflight = (async () => {
      let result = null;
      try { result = await scan(root, { now, ...scanOptions }); } catch { result = null; }
      snapshot = { at: now(), result };
      return snapshot;
    })().finally(() => { inflight = null; });
    return inflight;
  };

  const shape = (snap, stale) => {
    if (!snap || !snap.result) return { status: 'unavailable', scannedAt: snap ? new Date(snap.at).toISOString() : null, stale, partial: false, buckets: null };
    return { status: snap.result.partial ? 'partial' : 'ok', scannedAt: new Date(snap.at).toISOString(), stale, partial: snap.result.partial, buckets: snap.result.buckets };
  };

  return {
    async get() {
      if (!snapshot) return shape(await refresh(), false);
      const stale = now() - snapshot.at > ttlMs;
      if (stale) refresh();                                             // background; the cached answer is returned immediately
      return shape(snapshot, stale);
    },
  };
}
