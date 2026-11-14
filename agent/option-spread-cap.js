// OP2's entry spread cap lives in the Go backend (it refuses an opening whose spread, on AlphaDesk's own quote, is above the
// sandbox's saved maxOptionSpreadPct). A backend that is running receives a changed value through its operator-only risk
// endpoint before the setting is saved; a backend that is not running reads the saved value from its environment at start.

/**
 * Push the cap to a running backend. Resolves false when there is no running backend (nothing to push); throws when the
 * backend does not accept the value or reports a different one, so the caller can refuse the save as a whole.
 */
export async function pushOptionSpreadCap(client, pct, { operatorToken = process.env.TRADING_BOT_OPERATOR_TOKEN || '' } = {}) {
  if (!client) return false;
  let response;
  try {
    response = await client.put('/api/v1/risk/option-spread-cap', { pct }, { timeout: 4000, headers: { 'X-OpenProphet-Operator-Token': operatorToken } });
  } catch (error) {
    throw new Error(`The running trading backend did not accept the new option spread cap, so nothing was saved (${error?.response?.data?.error || error?.message || 'unknown error'}).`);
  }
  if (Number(response?.data?.effective_pct) !== Number(pct) || response?.data?.invalid) {
    throw new Error('The running trading backend reported a different option spread cap, so nothing was saved.');
  }
  return true;
}
