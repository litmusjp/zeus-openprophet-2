const RFC3339_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

export function diagnoseHistoricalBarsRange({ startDate, now = new Date().toISOString() }) {
  if (typeof startDate !== 'string' || !RFC3339_WITH_OFFSET.test(startDate)) return null;
  const startMs = Date.parse(startDate);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(startMs) || !Number.isFinite(nowMs) || startMs <= nowMs) return null;
  const canonicalUtc = new Date(startMs).toISOString().replace(/\.000Z$/, 'Z');
  const currentUtc = new Date(nowMs).toISOString().replace(/\.000Z$/, 'Z');
  return `start_date ${startDate} is in the future (UTC equivalent ${canonicalUtc}; current UTC ${currentUtc}). Changing notation does not change the future instant. Use the intended UTC instant from get_datetime.iso_utc; date-only bounds retain America/New_York trading-date semantics.`;
}

export function futureHistoricalBarsError(startDate, now = new Date().toISOString()) {
  const diagnostic = diagnoseHistoricalBarsRange({ startDate, now });
  return diagnostic ? { content: [{ type: 'text', text: diagnostic }], isError: true } : null;
}
