export function heartbeatPhaseMutationDenied(code, message) {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

export async function authorizeAndUpdateHeartbeatPhase({ role, operatorToken, getHeartbeatIntervalsForced, update }) {
  if (role !== 'operator') {
    return heartbeatPhaseMutationDenied('operator_authorization_required', 'heartbeat phase updates require the operator role');
  }
  if (!operatorToken) {
    return heartbeatPhaseMutationDenied('operator_authorization_unavailable', 'operator authorization is unavailable');
  }

  if (await getHeartbeatIntervalsForced()) {
    return heartbeatPhaseMutationDenied('heartbeat_intervals_forced', 'heartbeat phase updates are locked by the operator');
  }

  await update();
  return { ok: true };
}
