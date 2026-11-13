// Session-time helpers built on the broker clock and the broker's own session calendar.
// Pure functions: no network, no system clock. The broker timestamp is the only "now".
const NY_TZ = 'America/New_York';

function nyParts(ms) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: NY_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function pad(n) { return String(n).padStart(2, '0'); }

export function nyDateOf(ms) {
  const p = nyParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function nyClockOf(ms) {
  const p = nyParts(ms);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

// Convert a New York wall-clock date ("YYYY-MM-DD") and time ("HH:MM") to a UTC instant in ms,
// correct on daylight-saving boundaries (no fixed offset).
export function nyWallToInstantMs(dateText, timeText) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(timeText || ''));
  if (!d || !t) return null;
  const [year, month, day, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let guess = wallAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const p = nyParts(guess);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0);
    const diff = wallAsUtc - shown;
    if (diff === 0) return guess;
    guess += diff;
  }
  const p = nyParts(guess);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0) === wallAsUtc ? guess : null;
}

const EMPTY = Object.freeze({ session_time_et: null, session_open_et: null, session_close_et: null, minutes_since_open: null, minutes_to_close: null });

/**
 * Session fields from the broker clock ({timestamp, is_open}) and broker calendar rows
 * ([{date, open, close}], New York wall times). Minutes are whole numbers, rounded down.
 * Anything missing or inconsistent yields nulls; callers must treat null as "unavailable".
 */
export function sessionFields(clock, sessions) {
  if (!clock || typeof clock !== 'object') return { ...EMPTY };
  const nowMs = Date.parse(clock.timestamp ?? clock.Timestamp);
  if (!Number.isFinite(nowMs)) return { ...EMPTY };
  const out = { ...EMPTY, session_time_et: nyClockOf(nowMs) };
  const isOpen = clock.is_open ?? clock.IsOpen;
  const today = nyDateOf(nowMs);
  const row = Array.isArray(sessions) ? sessions.find(s => s && s.date === today) : null;
  if (!row) return out;
  const openMs = nyWallToInstantMs(row.date, row.open);
  const closeMs = nyWallToInstantMs(row.date, row.close);
  if (openMs === null || closeMs === null || closeMs <= openMs) return out;
  out.session_open_et = String(row.open).slice(0, 5).padStart(5, '0');
  out.session_close_et = String(row.close).slice(0, 5).padStart(5, '0');
  if (isOpen === true && nowMs >= openMs && nowMs < closeMs) {
    out.minutes_since_open = Math.floor((nowMs - openMs) / 60000);
    out.minutes_to_close = Math.floor((closeMs - nowMs) / 60000);
  }
  return out;
}

/**
 * Opening-order gate. `minMinutes` comes only from a trusted source (the harness environment),
 * never from tool arguments. No minimum (0, empty, invalid) means no gate. With a minimum, an
 * opening is allowed only when the broker session clock shows at least that many minutes.
 */
export function parseMinOpeningMinutes(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 0;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 120 ? n : 0;
}

export function openingGateDecision(minMinutes, fields) {
  const min = parseMinOpeningMinutes(minMinutes);
  if (min === 0) return { allowed: true };
  const m = fields?.minutes_since_open;
  if (Number.isInteger(m) && m >= min) return { allowed: true, minutes_since_open: m };
  return {
    allowed: false,
    minutes_since_open: Number.isInteger(m) ? m : null,
    message: Number.isInteger(m)
      ? `Openings are allowed from ${min} minutes after the session open; it is minute ${m}. Wait for the opening range to complete.`
      : `Openings need ${min} minutes of regular session; the broker session clock does not show the market open or is unavailable, so this opening is refused. Reducing orders are not affected.`,
  };
}
