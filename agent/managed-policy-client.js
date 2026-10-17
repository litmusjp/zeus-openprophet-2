export function createManagedReviewPolicyReader({ getClient, isAvailable }) {
  return async sandboxId => {
    if (!isAvailable(sandboxId)) throw new Error('managed policy backend unavailable');
    const client = getClient(sandboxId);
    if (!client?.get) throw new Error('managed policy backend unavailable');
    const response = await client.get('/api/v1/options/assessment-policy', { timeout: 5000 });
    return response.data;
  };
}
