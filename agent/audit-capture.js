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
  ]);
  return JSON.stringify({
    compact: 'daily_features', as_of: parsed.as_of, feed: parsed.feed, count: parsed.count ?? features.length,
    columns: ['symbol', 'last_date', 'last_ohlcv', 'prior_low_close', 'sma20', 'sma20_slope5_pct', 'close_vs_sma20_pct',
      'high10_prior', 'low10_prior', 'high20_prior', 'low20_prior', 'avg_vol20_prior', 'last_vol_ratio', 'error'],
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
