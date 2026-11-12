// Operator-only route: ask one sandbox's trading backend to resolve one uncertain order that failed Alpaca's
// two-decimal limit price validation. Every evidence check (identity, status, no broker ID, zero fill, the stored
// 422 / 42210000 evidence, and a broker not-found lookup) is made by the trading backend; this route only carries the
// operator capability to it. It never submits, cancels or replays an order.

export function registerPrecisionResolutionRoute(app, { operatorAuth, sameOrigin, getSandbox, getClient, isReady, operatorToken }) {
  app.post('/api/sandboxes/:id/orders/resolve-precision-rejection', operatorAuth, sameOrigin, async (req, res) => {
    try {
      const sandboxId = String(req.params.id || '');
      if (!getSandbox(sandboxId)) return res.status(404).json({ error: 'Sandbox not found' });
      const clientOrderId = typeof req.body?.client_order_id === 'string' ? req.body.client_order_id.trim() : '';
      if (!clientOrderId || clientOrderId.length > 128) return res.status(400).json({ error: 'client_order_id is required' });
      const client = getClient(sandboxId);
      const token = String(operatorToken() || '');
      if (!client || !isReady(sandboxId) || !token) return res.status(503).json({ error: 'The sandbox trading backend is not running' });
      const response = await client.post('/api/v1/orders/resolve-precision-rejection', { client_order_id: clientOrderId }, {
        headers: { 'X-OpenProphet-Operator-Token': token },
        validateStatus: () => true,
        timeout: 20000,
      });
      return res.status(response.status).json(response.data);
    } catch {
      return res.status(502).json({ error: 'Resolution request failed' });
    }
  });
}
