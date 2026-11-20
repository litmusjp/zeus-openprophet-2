// get_earnings_dates for any number of symbols. The backend accepts at most 30 symbols per call, so a longer list is split into batches of
// 30 and merged here (Guardian sent 31 symbols and got a 400 for the whole request). Per-symbol facts are kept exactly as the backend
// reports them: a symbol in a batch that failed is "unknown" (never "none_found_in_window"), and the merged answer is complete only
// when every batch was complete.
export const EARNINGS_BATCH_SIZE = 30;

/**
 * @param {{symbols?: unknown[], days?: number}} args
 * @param {(symbols: string[], days: number|undefined) => Promise<object>} lookup one backend call for at most 30 symbols
 */
export async function getEarningsDates(args, lookup) {
  const raw = Array.isArray(args?.symbols) ? args.symbols : [];
  const symbols = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item ?? '').trim();
    if (name && !seen.has(name.toUpperCase())) { seen.add(name.toUpperCase()); symbols.push(name); }
  }
  // Up to 30 symbols: one call, exactly as before (the backend validates the list itself and its answer is returned unchanged).
  if (raw.length <= EARNINGS_BATCH_SIZE) return lookup(raw, args?.days);
  if (symbols.length <= EARNINGS_BATCH_SIZE) return lookup(symbols, args?.days);
  const parts = [];
  for (let start = 0; start < symbols.length; start += EARNINGS_BATCH_SIZE) {
    const batch = symbols.slice(start, start + EARNINGS_BATCH_SIZE);
    try { parts.push({ batch, data: await lookup(batch, args?.days) }); }
    catch (error) { parts.push({ batch, error: error?.message || 'error' }); }
  }
  const good = parts.filter(part => part.data && Array.isArray(part.data.results));
  const results = [];
  const failedDates = new Set();
  let complete = true;
  for (const part of parts) {
    if (part.data && Array.isArray(part.data.results)) {
      results.push(...part.data.results);
      if (part.data.complete !== true) complete = false;
      for (const date of Array.isArray(part.data.failed_dates) ? part.data.failed_dates : []) failedDates.add(date);
    } else {
      complete = false;
      for (const symbol of part.batch) results.push({ symbol, status: 'unknown', error: `earnings batch failed: ${part.error || 'unreadable reply'}` });
    }
  }
  const base = good[0]?.data || {};
  const merged = {
    source: base.source ?? null, window_start: base.window_start ?? null, window_end: base.window_end ?? null,
    complete, results, batches: parts.length,
    note: `${base.note || "Public calendar data, not broker-verified. 'unknown' means part of the window could not be read, so no date does not mean no report."} The list was split into ${parts.length} batches of at most ${EARNINGS_BATCH_SIZE} symbols and merged; a symbol marked unknown with an error belongs to a batch that failed.`,
  };
  if (failedDates.size) merged.failed_dates = [...failedDates].sort();
  return merged;
}
