// Read-only, bounded, cached size totals of the data folder (H4, Nov 25 hardening).
//
// What it returns: aggregate LOGICAL bytes and file counts in a fixed set of buckets. What it never does: return a path or a file name, read
// a file's contents, follow a symlink or junction, delete, move or write anything, call a provider or the broker, or throw. Platform volume
// capacity, free space and snapshot coverage are NOT knowable from here and are not reported.
//
// Bounds: directories are enumerated INCREMENTALLY (opendir), so the entry cap limits what is read and retained, not just what is processed; the scan
// has its own time, entry and depth limits; and the FIRST response never waits longer than `firstResponseMs` even when a filesystem call stalls
// (the answer is then `pending`, never a fake zero). One scan is owned at a time: a stalled scan is not replaced by another until it actually ends.
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
  const stop = () => {
    if (entries >= maxEntries || now() > deadline) { partial = true; return true; }
    return partial;
  };

  async function walk(dir, bucket, depth, topLevel) {
    if (stop()) return true;
    if (depth > maxDepth) { partial = true; return true; }
    let handle;
    try { handle = await fsx.opendir(dir); } catch { if (topLevel) return null; partial = true; return true; }
    try {
      for await (const child of handle) {                           // one directory entry at a time: the cap bounds what is READ
        if (stop()) break;
        entries += 1;
        if (child.isSymbolicLink()) continue;                       // links and junctions are never followed or counted
        const full = path.join(dir, child.name);
        if (child.isDirectory()) {
          if (topLevel) await walk(full, BUCKETS.get(child.name) || 'other', depth + 1, false);
          else await walk(full, bucket, depth + 1, false);
          if (partial) break;
        } else if (child.isFile()) {
          try {
            const stat = await fsx.lstat(full);
            if (stat.isFile()) {
              const into = topLevel ? 'top_level_files' : bucket;
              buckets[into].bytes += stat.size;
              buckets[into].files += 1;
            }
          } catch { partial = true; }
        }
      }
    } catch { partial = true; }
    finally { try { await handle.close(); } catch { /* already closed by the iterator */ } }
    return true;
  }

  const ok = await walk(root, null, 0, true);
  if (ok === null) return null;
  return { buckets, partial };
}

/**
 * A cached view of scanDataRoot. The first call waits at most `firstResponseMs` for the single in-flight scan and otherwise answers `pending`;
 * later calls return the cached snapshot at once and start at most ONE background refresh when it is older than ttlMs. A failed or stalled scan
 * never throws, never reads as 0 and is never replaced by a second concurrent scan.
 */
export function createDataUsage({ root, ttlMs = 10 * 60 * 1000, firstResponseMs = 2000, now = Date.now, scan = scanDataRoot, scanOptions = {} } = {}) {
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
  const pending = { status: 'pending', scannedAt: null, stale: false, partial: false, buckets: null };

  return {
    async get() {
      if (snapshot) {
        const stale = now() - snapshot.at > ttlMs;
        if (stale) refresh();                                         // background; the cached answer is returned immediately
        return shape(snapshot, stale);
      }
      const task = refresh();
      let timer;
      const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(null), firstResponseMs); });
      const outcome = await Promise.race([task, timeout]);
      clearTimeout(timer);
      return outcome ? shape(outcome, false) : pending;
    },
  };
}
