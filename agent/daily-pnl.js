// Normalize the broker's account-scoped daily P&L. Missing or invalid broker
// fields are deliberately not converted to zero: callers must fail closed.
export function accountDailyPnl(account) {
  const equity = Number(account?.Equity ?? account?.equity);
  const lastEquity = Number(account?.LastEquity ?? account?.last_equity);
  const validFlag = account?.DailyPnLValid ?? account?.daily_pnl_valid;
  if (validFlag !== true || !Number.isFinite(equity) || equity <= 0 || !Number.isFinite(lastEquity) || lastEquity <= 0) return null;
  const pnl = equity - lastEquity;
  return { equity, lastEquity, pnl, percent: (pnl / lastEquity) * 100 };
}
