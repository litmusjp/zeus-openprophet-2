// Minimal stdio MCP server used only by the isolated ChatGPT model check.
let input = '';
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function handle(message) {
  const base = { jsonrpc: '2.0', id: message.id };
  if (message.method === 'initialize') return send({ ...base, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'op2-probe', version: '1' } } });
  if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return;
  if (message.method === 'ping') return send({ ...base, result: {} });
  if (message.method === 'tools/list') return send({ ...base, result: { tools: [{ name: 'confirm_nonce', description: 'Echo the supplied check nonce.', inputSchema: { type: 'object', properties: { nonce: { type: 'string' } }, required: ['nonce'], additionalProperties: false } }] } });
  if (message.method === 'tools/call' && message.params?.name === 'confirm_nonce' && message.params?.arguments?.nonce === process.env.OP2_PROBE_NONCE) return send({ ...base, result: { content: [{ type: 'text', text: process.env.OP2_PROBE_NONCE }], isError: false } });
  if (message.id !== undefined) send({ ...base, error: { code: -32601, message: 'Unsupported request' } });
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  for (let end; (end = input.indexOf('\n')) >= 0;) {
    const line = input.slice(0, end).trim(); input = input.slice(end + 1);
    if (!line) continue;
    try { handle(JSON.parse(line)); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  }
});
