// A deliberately invalid assessment checks the existing endpoint without
// sending market evidence or requesting execution. Its rejection alone cannot
// establish authentication or market-data readiness.
export async function testAlphaDeskAssessmentCapability(url, apiKey, request = fetch) {
  if (!apiKey) return { ok: false, status: 'authentication', message: 'No saved AlphaDesk API key' };
  try {
    const response = await request(url + '/api/v1/desk/strategy-assessments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-AlphaDesk-API-Key': apiKey },
      body: '{}', redirect: 'manual', signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) return { ok: false, status: 'authentication', message: 'AlphaDesk rejected the saved API key' };
    if (response.status === 422) return { ok: false, status: 'evidence_unavailable', message: 'Assessment schema responded; authentication and market evidence were not verified' };
    if (response.status === 400) return { ok: false, status: 'schema', message: 'AlphaDesk rejected the probe; assessment schema was not verified' };
    if (response.status === 404 || response.status === 405) return { ok: false, status: 'schema', message: 'AlphaDesk assessment endpoint is unavailable' };
    if (response.status >= 300 && response.status < 400) return { ok: false, status: 'connection', message: 'AlphaDesk redirected the assessment probe' };
    if (response.status >= 500) return { ok: false, status: 'evidence_unavailable', message: 'AlphaDesk assessment service is unavailable' };
    return { ok: false, status: 'schema', message: 'AlphaDesk did not reject the invalid assessment probe as expected' };
  } catch {
    return { ok: false, status: 'connection', message: 'AlphaDesk connection failed or timed out' };
  }
}
