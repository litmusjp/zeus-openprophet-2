// Compact, decision-relevant audit form for historical-bar results, which the
// generic 1200-character capture limit would otherwise clip. Audit retention
// only: the model always receives the full tool result.
const MAX_BARS = 40;

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
