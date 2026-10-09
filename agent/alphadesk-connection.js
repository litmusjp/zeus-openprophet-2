const policyPath = '/api/v2/option-trade-assessments/policy';

function validPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return false;
  const score = policy.minimum_passing_score;
  if ((typeof score !== 'number' && typeof score !== 'string')
      || (typeof score === 'string' && score.trim() === '')) return false;
  const numericScore = Number(score);
  return policy.scope === 'TRADE_ASSESSMENT'
    && typeof policy.policy_version === 'string' && policy.policy_version.trim() !== ''
    && policy.paper_only === true && policy.execution_allowed === false
    && policy.human_approval_required === true
    && Array.isArray(policy.supported_strategies) && policy.supported_strategies.length > 0
    && policy.supported_strategies.every(strategy => typeof strategy === 'string' && strategy.trim() !== '')
    && Number.isFinite(numericScore) && numericScore >= 0 && numericScore <= 100;
}

export async function testAlphaDeskAssessmentCapability(url, apiKey, request = fetch) {
  if (!apiKey) return { ok: false, status: 'authentication', message: 'No saved AlphaDesk API key' };
  try {
    const response = await request(url + policyPath, {
      method: 'GET', headers: { 'X-AlphaDesk-API-Key': apiKey },
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, status: 'authentication', message: 'AlphaDesk rejected the saved API key' };
    if (response.status === 404 || response.status === 405) return { ok: false, status: 'schema', message: 'AlphaDesk policy endpoint is unavailable' };
    if (response.status >= 300 && response.status < 400) return { ok: false, status: 'connection', message: 'AlphaDesk redirected the policy request' };
    if (response.status >= 500) return { ok: false, status: 'service', message: 'AlphaDesk policy service is unavailable' };
    if (response.status < 200 || response.status >= 300) return { ok: false, status: 'schema', message: 'AlphaDesk could not provide a valid assessment policy' };
    let policy;
    try { policy = await response.json(); } catch {
      return { ok: false, status: 'schema', message: 'AlphaDesk returned invalid policy JSON' };
    }
    if (!validPolicy(policy)) return { ok: false, status: 'schema', message: 'AlphaDesk returned malformed assessment policy metadata' };
    return {
      ok: true,
      status: 'connected',
      message: 'Authenticated assessment policy is available; market evidence/readiness, trade decisions and broker execution were NOT tested.',
    };
  } catch {
    return { ok: false, status: 'connection', message: 'AlphaDesk connection failed or timed out' };
  }
}
