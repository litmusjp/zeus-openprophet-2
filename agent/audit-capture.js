// Compact, decision-relevant audit form for historical-bar results, which the
// generic 1200-character capture limit would otherwise clip. Audit retention
// only: the model always receives the full tool result.
const MAX_BARS = 40;

/**
 * Compact per-symbol table for get_daily_features so every symbol's decisive numbers survive in the
 * history instead of being clipped at the generic capture limit. Audit only.
 */
export function compactDailyFeatures(resultText) {
  let parsed;
  try { parsed = JSON.parse(resultText); } catch { return null; }
  const features = Array.isArray(parsed?.features) ? parsed.features : null;
  if (!features) return null;
  const rows = features.map(f => [
    f.symbol, f.last_complete_date ?? null,
    f.last ? [f.last.open, f.last.high, f.last.low, f.last.close, f.last.volume] : null,
    f.prior_session ? [f.prior_session.low, f.prior_session.close] : null,
    f.sma20 ?? null, f.sma20_slope_5_sessions_pct ?? null, f.last_close_vs_sma20_pct ?? null,
    f.high_prior_10_sessions ?? null, f.low_prior_10_sessions ?? null,
    f.high_prior_20_sessions ?? null, f.low_prior_20_sessions ?? null,
    f.avg_volume_prior_20_sessions ?? null, f.last_volume_to_avg_ratio ?? null,
    f.error ?? null,
    // appended after the original columns so earlier indexes stay stable; per-symbol feed lets a
    // review verify sip vs iex for every symbol, and the computed distances/flags let it check the
    // agent's reading of each rule.
    f.feed ?? null,
    f.low_vs_low_prior_20_sessions_pct ?? null,
    f.close_vs_high_prior_10_sessions_pct ?? null, f.close_vs_high_prior_20_sessions_pct ?? null,
    f.undercut_prior_session_low ?? null, f.close_above_open ?? null,
    // appended last (never shifts an earlier index): the 200-session average and the last close's distance from it
    f.sma200 ?? null, f.last_close_vs_sma200_pct ?? null,
  ]);
  return JSON.stringify({
    compact: 'daily_features', as_of: parsed.as_of, feed: parsed.feed, count: parsed.count ?? features.length,
    columns: ['symbol', 'last_date', 'last_ohlcv', 'prior_low_close', 'sma20', 'sma20_slope5_pct', 'close_vs_sma20_pct',
      'high10_prior', 'low10_prior', 'high20_prior', 'low20_prior', 'avg_vol20_prior', 'last_vol_ratio', 'error',
      'feed', 'low_vs_low20_prior_pct', 'close_vs_high10_prior_pct', 'close_vs_high20_prior_pct',
      'undercut_prior_low', 'close_above_open', 'sma200', 'close_vs_sma200_pct'],
    rows,
  });
}

export function compactHistoricalBars(resultText) {
  let parsed;
  try { parsed = JSON.parse(resultText); } catch { return null; }
  const bars = Array.isArray(parsed?.bars) ? parsed.bars : null;
  if (!bars) return null;
  const rows = bars.slice(-MAX_BARS).map(b => [
    b.Timestamp ?? b.timestamp, b.Open ?? b.open, b.High ?? b.high, b.Low ?? b.low,
    b.Close ?? b.close, b.Volume ?? b.volume, b.complete,
  ]);
  return JSON.stringify({
    compact: 'historical_bars',
    symbol: parsed.symbol, timeframe: parsed.timeframe, feed: parsed.feed,
    count: parsed.count ?? bars.length, returned_rows: rows.length,
    columns: ['t', 'o', 'h', 'l', 'c', 'v', 'complete'], rows,
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Bounded audit forms (F5). Audit retention only: the model-facing tool output and the execution inputs are never touched; these
// functions only build the copy that is persisted in the audit event. Every form is valid JSON built from whole rows and whole
// (character-cropped) strings, never a substring of serialized JSON. The cap is the UTF-8 byte length of the final serialized audit
// record (args and metadata included), so a capped record is `partial: true` and states what was omitted.
// ---------------------------------------------------------------------------------------------------------------------------------
export const AUDIT_RECORD_CAP_BYTES = 32 * 1024;
// Room kept for fields the history store adds around the event after capture (activity id, origin, timestamps).
export const AUDIT_ENVELOPE_RESERVE_BYTES = 1024;
const ARGS_BUDGET_BYTES = 6 * 1024;
const HEADLINE_CHARS = 200;
export const BOUNDED_AUDIT_TOOLS = Object.freeze(['get_market_snapshot', 'get_options_chain', 'get_alpaca_news', 'get_range_confirmation', 'get_datetime']);

const utf8Bytes = text => Buffer.byteLength(text, 'utf8');
const present = value => value !== undefined && value !== null;
const firstPresent = (obj, ...names) => { for (const name of names) if (present(obj?.[name])) return obj[name]; return null; };

/** Crop a string to at most `max` characters (whole code points, never half a surrogate pair); an ellipsis marks the crop. */
export function cropText(value, max) {
  if (typeof value !== 'string') return value;
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** Bounded copy of an arbitrary JSON value for the audit args: long strings and long arrays are cropped, depth is limited. */
export function cropAuditValue(value, depth = 0) {
  if (typeof value === 'string') return cropText(value, 300);
  if (Array.isArray(value)) {
    if (depth >= 5) return `[array of ${value.length}]`;
    const kept = value.slice(0, 25).map(item => cropAuditValue(item, depth + 1));
    if (value.length > 25) kept.push(`…+${value.length - 25} more`);
    return kept;
  }
  if (value && typeof value === 'object') {
    if (depth >= 5) return '[object]';
    const entries = Object.entries(value);
    const out = Object.fromEntries(entries.slice(0, 40).map(([key, item]) => [cropText(key, 80), cropAuditValue(item, depth + 1)]));
    if (entries.length > 40) out._omitted_keys = entries.length - 40;
    return out;
  }
  return value;
}

/** Args for an audit record: unchanged when small, cropped when large, replaced by a size note when still too large. */
export function boundAuditArgs(args, budget = ARGS_BUDGET_BYTES) {
  let text;
  try { text = JSON.stringify(args); } catch { text = undefined; }
  if (text === undefined || utf8Bytes(text) <= budget) return { args, partial: false };
  const cropped = cropAuditValue(args);
  const croppedText = JSON.stringify(cropped);
  if (utf8Bytes(croppedText) <= budget) return { args: cropped, partial: true, originalBytes: utf8Bytes(text) };
  return { args: { _omitted: true, original_bytes: utf8Bytes(text) }, partial: true, originalBytes: utf8Bytes(text) };
}

function failureOf(parsed) {
  const status = typeof parsed?.status === 'string' ? parsed.status : null;
  const hasError = present(parsed?.error) || present(parsed?.category);
  if (!hasError && (status === null || status === 'available' || status === 'ok' || status === 'empty')) return null;
  const out = {};
  for (const key of ['status', 'category', 'endpoint', 'upstream_status', 'attempts', 'next_open', 'code']) if (present(parsed?.[key])) out[key] = typeof parsed[key] === 'string' ? cropText(parsed[key], 200) : parsed[key];
  if (present(parsed?.error)) out.error = cropText(typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error), 400);
  if (present(parsed?.message)) out.message = cropText(String(parsed.message), 400);
  return out;
}

function queryOf(args, keys) {
  const out = {};
  if (args && typeof args === 'object') for (const key of keys) if (args[key] !== undefined) out[key] = cropAuditValue(args[key], 3);
  return out;
}

const dayOf = value => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : value ?? null);

function chainDraft(parsed, args) {
  const contracts = Array.isArray(parsed.contracts) ? parsed.contracts : [];
  const MISSING_CHECK = ['bid', 'ask', 'bid_size', 'ask_size', 'quote_time', 'feed', 'quality', 'delta', 'iv'];
  const rows = contracts.map(c => {
    const row = [
      firstPresent(c, 'Symbol', 'symbol'), firstPresent(c, 'ContractType', 'contract_type', 'type'), firstPresent(c, 'StrikePrice', 'strike_price', 'strike'),
      dayOf(firstPresent(c, 'ExpirationDate', 'expiration_date', 'expiration')), firstPresent(c, 'Bid', 'bid'), firstPresent(c, 'Ask', 'ask'),
      firstPresent(c, 'BidSize', 'bid_size'), firstPresent(c, 'AskSize', 'ask_size'), firstPresent(c, 'QuoteTimestamp', 'quote_timestamp'),
      firstPresent(c, 'MarketDataFeed', 'market_data_feed'), firstPresent(c, 'MarketDataQuality', 'market_data_quality'),
      firstPresent(c, 'Delta', 'delta'), firstPresent(c, 'ImpliedVolatility', 'implied_volatility'),
    ];
    const missing = MISSING_CHECK.filter((name, i) => row[4 + i] === null);
    return [...row, missing];
  });
  const feeds = [...new Set(rows.map(r => r[9]).filter(present))].slice(0, 5);
  return {
    head: {
      compact: 'options_chain', provider: firstPresent(parsed, 'provider', 'source'), feed: feeds.length === 1 ? feeds[0] : (feeds.length ? feeds : firstPresent(parsed, 'market_data_feed', 'feed')),
      as_of: firstPresent(parsed, 'as_of', 'observed_at', 'fetched_at', 'timestamp'),
      status: parsed.status ?? null, symbol: parsed.symbol ?? null, expiration: parsed.expiration ?? null,
      query: queryOf(args, ['symbol', 'expiration', 'delta_min', 'delta_max', 'min_bid', 'max_cost', 'type']),
      total: parsed.total ?? null, filtered: parsed.filtered ?? contracts.length,
      ...(present(parsed.message) ? { message: cropText(String(parsed.message), 300) } : {}),
      ...(failureOf(parsed) ? { failure: failureOf(parsed) } : {}),
      columns: ['occ', 'type', 'strike', 'expiry', 'bid', 'ask', 'bid_size', 'ask_size', 'quote_time', 'feed', 'quality', 'delta', 'iv', 'missing'],
    },
    rowsKey: 'rows', rows, keep: 'head',
  };
}

function newsDraft(parsed, args) {
  const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
  const rows = articles.map(a => [
    firstPresent(a, 'id', 'ID'), Array.isArray(a?.symbols) ? a.symbols.slice(0, 12).map(s => cropText(String(s), 24)) : null,
    firstPresent(a, 'created_at'), firstPresent(a, 'updated_at'), cropText(firstPresent(a, 'headline') ?? '', HEADLINE_CHARS),
  ]);
  return {
    head: {
      compact: 'alpaca_news', provider: parsed.provider ?? null, feed: null, status: parsed.status ?? null,
      as_of: firstPresent(parsed, 'fetched_at', 'as_of'), window_start: parsed.window_start ?? null, window_end: parsed.window_end ?? null,
      symbols: Array.isArray(parsed.symbols) ? parsed.symbols.slice(0, 30).map(s => cropText(String(s), 24)) : null,
      query: queryOf(args, ['symbols', 'hours', 'limit', 'page_token']),
      limit: parsed.limit ?? null, count: parsed.count ?? articles.length, has_more: parsed.has_more ?? null,
      next_page_token: typeof parsed.next_page_token === 'string' ? cropText(parsed.next_page_token, 200) : null,
      duplicates_removed: parsed.duplicates_removed ?? null,
      ...(failureOf(parsed) ? { failure: failureOf(parsed) } : {}),
      columns: ['id', 'symbols', 'created_at', 'updated_at', `headline_${HEADLINE_CHARS}`],
    },
    rowsKey: 'rows', rows, keep: 'head',
  };
}

function snapshotDraft(parsed) {
  const groups = ['indexes', 'rates', 'commodities', 'crypto', 'volatility'];
  const quotes = [];
  const rows = [];
  let calendarStatus = null;
  for (const group of groups) {
    for (const q of (Array.isArray(parsed[group]) ? parsed[group] : []).slice(0, 40)) {
      quotes.push([group, q.symbol ?? null, q.price ?? null, q.prev_close ?? null, q.prev_close_date ?? null, q.prev_close_available ?? null,
        q.prev_close_source ?? null, q.change_available ?? null, q.change_pct ?? null, q.calendar_status ?? null]);
      if (present(q.calendar_status)) calendarStatus = q.calendar_status;
      if (Array.isArray(q.history)) for (const h of q.history) rows.push([q.symbol ?? null, h?.date ?? null, h?.close ?? null, h?.complete ?? null]);
    }
  }
  // non-VIX history first, so a crop from the front drops it before any ^VIX row
  rows.sort((a, b) => (a[0] === '^VIX') - (b[0] === '^VIX'));
  return {
    head: {
      compact: 'market_snapshot', provider: parsed.source ?? null, feed: null, as_of: parsed.timestamp ?? null,
      vix_calendar_status: calendarStatus,
      unavailable: Array.isArray(parsed.unavailable) ? parsed.unavailable.slice(0, 50).map(s => cropText(String(s), 40)) : [],
      ...(failureOf(parsed) ? { failure: failureOf(parsed) } : {}),
      quote_columns: ['group', 'symbol', 'price', 'prev_close', 'prev_close_date', 'prev_close_available', 'prev_close_source', 'change_available', 'change_pct', 'calendar_status'],
      quotes,
      columns: ['symbol', 'date', 'close', 'complete'],
    },
    rowsKey: 'history_rows', rows, keep: 'tail',
  };
}

function rangeDraft(parsed, args) {
  const confirmations = Array.isArray(parsed.confirmations) ? parsed.confirmations : [];
  const rows = confirmations.map(r => [r.start ?? null, r.close ?? null, r.volume ?? null, r.baseline_volume ?? null, r.baseline_bars ?? null,
    r.direction ?? null, r.volume_above_baseline ?? null, r.confirming ?? null, r.data_issue ?? null]);
  const win = parsed.window && typeof parsed.window === 'object' ? parsed.window : null;
  const list = value => (Array.isArray(value) ? { count: value.length, first: value.slice(0, 12) } : null);
  const failure = (parsed.status && parsed.status !== 'ok') || present(parsed.error) ? failureOf({ ...parsed, status: parsed.status ?? 'error' }) : null;
  return {
    head: {
      compact: 'range_confirmation', provider: null, feed: parsed.feed ?? null, as_of: firstPresent(parsed, 'latest_complete_bar') ? parsed.latest_complete_bar.end ?? null : null,
      status: parsed.status ?? null, symbol: parsed.symbol ?? null, timeframe: parsed.timeframe ?? null,
      query: { ...queryOf(args, ['symbol', 'window_start', 'window_minutes', 'event_published_at']), anchor_requested: parsed.anchor_requested ?? null, anchor_used: parsed.anchor_used ?? null,
        window_end_exclusive: parsed.window_end_exclusive ?? null },
      supplied_bars: parsed.supplied_bars ?? null, range: parsed.range ? { high: parsed.range.high, low: parsed.range.low, midpoint: parsed.range.midpoint, height: parsed.range.height } : null,
      window: win ? { expected_bars: win.expected_bars ?? null, usable_bars: win.usable_bars ?? null, missing_starts: list(win.missing_starts), incomplete_starts: list(win.incomplete_starts), unusable_starts: list(win.unusable_starts) } : null,
      first_confirming: parsed.first_confirming ?? null, latest_complete_bar: parsed.latest_complete_bar ?? null,
      notes: Array.isArray(parsed.notes) ? parsed.notes.slice(0, 5).map(n => cropText(String(n), 300)) : [],
      ...(failure ? { failure } : {}),
      ...(parsed.anchor_check ? { anchor_check: cropAuditValue(parsed.anchor_check, 3) } : {}),
      columns: ['start', 'close', 'volume', 'baseline_volume', 'baseline_bars', 'direction', 'above_baseline', 'confirming', 'data_issue'],
    },
    rowsKey: 'confirmation_rows', rows, keep: 'tail',
  };
}

function datetimeDraft(parsed) {
  const pick = {};
  for (const key of ['iso_utc', 'iso_date', 'time_24h', 'day_of_week', 'timezone', 'market_status', 'markets_open_today', 'market_status_source', 'session_time_et',
    'session_open_et', 'session_close_et', 'session_open_utc', 'session_close_utc', 'minutes_since_open', 'minutes_to_close']) if (parsed[key] !== undefined) pick[key] = parsed[key];
  return {
    head: {
      compact: 'datetime', provider: parsed.market_status_source ?? null, feed: null, as_of: parsed.iso_utc ?? null, ...pick,
      long_gap: cropAuditValue(parsed.long_gap ?? null, 3),
      broker_clock: cropAuditValue(parsed.broker_clock ?? null, 3),
      ...(present(parsed.session_fields_error) ? { session_fields_error: cropText(String(parsed.session_fields_error), 300) } : {}),
      ...(present(parsed.broker_clock_error) ? { broker_clock_error: cropText(String(parsed.broker_clock_error), 300) } : {}),
    },
    rowsKey: 'rows', rows: [], keep: 'head',
  };
}

const DRAFTS = { get_options_chain: chainDraft, get_alpaca_news: newsDraft, get_market_snapshot: snapshotDraft, get_range_confirmation: rangeDraft, get_datetime: datetimeDraft };

/**
 * Parsed, bounded draft of an audit form for one of BOUNDED_AUDIT_TOOLS, or null when the text is not a JSON object (the caller then
 * keeps the existing 1200-character clip). The draft carries the whole row list; renderAuditDraft crops whole rows to fit a byte cap.
 */
export function compactAuditDraft(toolName, resultText, args) {
  const build = DRAFTS[toolName];
  if (!build || typeof resultText !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(resultText); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  try { return build(parsed, args); } catch { return null; }
}

function renderDraft(draft, count, rowsTotal, extraPartial) {
  const kept = draft.keep === 'tail' ? draft.rows.slice(draft.rows.length - count) : draft.rows.slice(0, count);
  const omitted = rowsTotal - count;
  const out = { ...draft.head };
  out[draft.rowsKey] = kept;
  out.returned_rows = count;
  out.total_rows = rowsTotal;
  out.omitted_rows = omitted;
  out.truncated = omitted > 0;
  out.partial = omitted > 0 || extraPartial === true;
  if (omitted > 0) out.omitted_note = draft.keep === 'tail' ? 'oldest rows omitted to stay within the audit size cap' : 'later rows omitted to stay within the audit size cap';
  return out;
}

/**
 * Persisted audit event for a bounded tool: {...event, args, result} whose UTF-8 serialized size is at most
 * cap - AUDIT_ENVELOPE_RESERVE_BYTES, so the record stays within `cap` after the store adds its own fields. Crops whole rows (never
 * characters of serialized JSON); crops args first when they are large. `result` is a JSON string. The input event and draft are not mutated.
 */
export function fitAuditEvent(event, draft, cap = AUDIT_RECORD_CAP_BYTES) {
  const limit = cap - AUDIT_ENVELOPE_RESERVE_BYTES;
  const boundedArgs = boundAuditArgs(event.args);
  const base = { ...event, args: boundedArgs.args, ...(boundedArgs.partial ? { argsPartial: true, argsOriginalBytes: boundedArgs.originalBytes } : {}) };
  const total = draft.rows.length;
  const sizeAt = count => {
    const rendered = renderDraft(draft, count, total, boundedArgs.partial);
    const record = { ...base, result: JSON.stringify(rendered) };
    return { record, size: utf8Bytes(JSON.stringify(record)), rendered };
  };
  let best = sizeAt(0);
  if (best.size <= limit) {
    let lo = 0, hi = total;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (sizeAt(mid).size <= limit) lo = mid; else hi = mid - 1;
    }
    best = sizeAt(lo);
  } else {
    // even zero rows do not fit (a very large header or other metadata): keep only identity and the failure state
    const minimal = { compact: draft.head.compact, provider: draft.head.provider ?? null, feed: draft.head.feed ?? null, as_of: draft.head.as_of ?? null,
      status: draft.head.status ?? null, ...(draft.head.failure ? { failure: draft.head.failure } : {}), returned_rows: 0, total_rows: total,
      omitted_rows: total, truncated: true, partial: true, omitted_note: 'audit record cap reached; header detail omitted' };
    let record = { ...base, result: JSON.stringify(minimal) };
    if (utf8Bytes(JSON.stringify(record)) > limit) record = { ...base, args: { _omitted: true }, argsPartial: true, result: JSON.stringify(minimal) };
    best = { record, rendered: minimal };
  }
  const out = best.record;
  if (best.rendered.partial) { out.resultTruncated = true; }
  return out;
}
