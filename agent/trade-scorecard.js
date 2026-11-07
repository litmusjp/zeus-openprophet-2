// Minimal read-only scorecard built from the broker-confirmed realized trades the ledger already returns.
// It adds no new write path: every number comes from filled orders and the entry assessment that was
// stored with the order. Spread, stop and target levels are not stored with orders, so they are left out
// here (they are in the agent's decision log) rather than guessed.

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function holdMinutes(entryTime, exitTime) {
  const a = Date.parse(entryTime || '');
  const b = Date.parse(exitTime || '');
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? Math.round((b - a) / 60000) : null;
}

export function scorecardRow(trade) {
  const assessment = trade?.entryAssessment || null;
  return {
    id: trade?.id ?? null,
    agentId: trade?.entryAgentId ?? trade?.agentId ?? null,
    agentName: trade?.entryAgentName ?? trade?.agentName ?? null,
    sandboxId: trade?.sandboxId ?? null,
    symbol: trade?.symbol ?? null,
    assetType: trade?.assetType ?? null,
    quantity: finite(trade?.quantity),
    entryTime: trade?.entryTime ?? null,
    exitTime: trade?.exitTime ?? null,
    holdMinutes: holdMinutes(trade?.entryTime, trade?.exitTime),
    entryPrice: finite(trade?.entryPrice),
    exitPrice: finite(trade?.exitPrice),
    pnl: finite(trade?.pnl),
    pnlPercent: finite(trade?.pnlPercent),
    assessmentDecision: assessment?.decision ?? 'unavailable',
    assessmentScore: assessment && assessment.signalScore !== null && assessment.signalScore !== undefined ? assessment.signalScore : 'unavailable',
  };
}

/** Summarise realized trades: one row per closed lot plus totals per day and per agent. */
export function buildScorecard(trades = []) {
  const rows = (Array.isArray(trades) ? trades : []).map(scorecardRow);
  const bucket = () => ({ trades: 0, wins: 0, losses: 0, totalPnl: 0 });
  const add = (target, row) => {
    target.trades += 1;
    if (row.pnl !== null) {
      target.totalPnl = Number((target.totalPnl + row.pnl).toFixed(2));
      if (row.pnl > 0) target.wins += 1; else if (row.pnl < 0) target.losses += 1;
    }
  };
  const byDay = {};
  const byAgent = {};
  const total = bucket();
  for (const row of rows) {
    add(total, row);
    const day = String(row.exitTime || '').slice(0, 10) || 'unknown';
    add(byDay[day] ||= bucket(), row);
    add(byAgent[row.agentId || 'unknown'] ||= bucket(), row);
  }
  return {
    note: 'Read-only summary of broker-confirmed realized trades. Assessment score is AlphaDesk signal quality, not a profit forecast; spread, stop and target are in the agent decision log.',
    total, byDay, byAgent, rows,
  };
}
