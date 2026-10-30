const ET = 'America/New_York';

export const MARKET_AWARE_HEARTBEAT = Object.freeze({
  mode: 'market_aware', preOpenSeconds: 900, firstHourSeconds: 600,
  middleSeconds: 1200, lastHourSeconds: 600, postCloseSeconds: 900,
});

function etDate(date, hhmm) {
  // Calendar dates/times are exchange-local. Iteratively resolve the IANA zone
  // so DST boundaries never rely on a fixed UTC offset.
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = hhmm.split(':').map(Number);
  const target = Date.UTC(year, month - 1, day, hour, minute);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET, hourCycle: 'h23', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).formatToParts(new Date(guess));
    const v = Object.fromEntries(parts.map(p => [p.type, Number(p.value)]));
    guess += target - Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute);
  }
  return guess;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  const x = new Date(Date.UTC(y,m-1,d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m-1 && x.getUTCDate() === d;
}
function validTime(value) {
  if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [h,m] = value.split(':').map(Number);
  return h < 24 && m < 60;
}

export function marketSession(calendar, date) {
  const row = calendar?.find(x => x.date === date);
  if (!row || !validDate(date) || !validTime(row.open) || !validTime(row.close)) return null;
  const open = etDate(date, row.open), close = etDate(date, row.close);
  return close > open ? { open, close } : null;
}

export function validateMarketCalendar(calendar) {
  if (!Array.isArray(calendar) || calendar.length === 0) return false;
  let previous = '';
  for (const row of calendar) {
    if (!validDate(row?.date) || row.date <= previous || !validTime(row.open) || !validTime(row.close)) return false;
    if (!marketSession([row], row.date)) return false;
    previous = row.date;
  }
  return true;
}

export function marketSessionPhase(session, nowMs) {
  if (!session) return 'closed';
  if (nowMs < session.open) return 'pre_market';
  if (nowMs < session.open + 60 * 60_000) return 'market_open';
  if (nowMs < session.close - 60 * 60_000) return 'midday';
  if (nowMs < session.close) return 'market_close';
  if (nowMs < session.close + 60 * 60_000) return 'after_hours';
  return 'closed';
}

export function nextMarketReview(calendar, nowMs, clock = null, intervals = {}) {
  const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(nowMs));
  const session = marketSession(calendar, todayET);
  const rows = (calendar || []).map(row => ({ row, session: marketSession(calendar, row.date) })).filter(x => x.session);
  if (!rows.length) return null;
  const todays = rows.find(x => x.row.date === todayET);
  if (todays && nowMs >= todays.session.open && nowMs < todays.session.close
    && !(clock?.is_open === true && Number.isFinite(Date.parse(clock.timestamp)) && Math.abs(nowMs - Date.parse(clock.timestamp)) <= 120_000)) return null;
  if (todays && nowMs >= todays.session.open && nowMs < todays.session.close && clock?.is_open === true && Number.isFinite(Date.parse(clock.timestamp)) && Math.abs(nowMs - Date.parse(clock.timestamp)) <= 120_000) {
    const elapsed = nowMs - todays.session.open, duration = todays.session.close - todays.session.open;
    let interval;
    if (elapsed < 3600000) interval = (intervals.market_open || 600) * 1000;
    else if (elapsed < duration - 3600000) interval = (intervals.midday || 1200) * 1000;
    else interval = (intervals.market_close || 600) * 1000;
    const anchor = elapsed < 3600000 ? todays.session.open : elapsed < duration - 3600000
      ? todays.session.open + 3600000 : todays.session.close - 3600000;
    const boundary = elapsed < 3600000 ? todays.session.open + 3600000 : elapsed < duration - 3600000 ? todays.session.close - 3600000 : todays.session.close;
    const tick = anchor + (Math.floor(Math.max(0, nowMs - anchor) / interval) + 1) * interval;
    const at = Math.min(tick, boundary);
    if (at < todays.session.close) return { at, reason: 'session-review' };
    // A closed broker clock during nominal calendar hours is never evidence of an open market.
    return { at: todays.session.close + 900000, reason: 'post-close-review' };
  }
  for (const { session: s } of rows) {
    const pre = s.open - 900000, post = s.close + 900000;
    if (pre > nowMs) return { at: pre, reason: 'pre-open-review' };
    if (nowMs >= pre && nowMs < s.open) return { at: s.open, reason: 'session-open-review' };
    if (post > nowMs && s.close <= nowMs) return { at: post, reason: 'post-close-review' };
  }
  return null;
}
