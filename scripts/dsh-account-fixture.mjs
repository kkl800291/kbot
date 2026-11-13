import http from 'node:http';
import { once } from 'node:events';

// Loopback-only OAuth and inference fixture. No real account or provider key
// is used, and its credential can authenticate only this isolated origin.
export async function accountFixture() {
  let initialization;
  let quota = false;
  let inferenceRequests = 0;
  const grant = 'kbot-loopback-test-credential';
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (value, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    const platform = value => json({ code: 0, data: { biz_code: 0, biz_data: value } });
    if (url.pathname.endsWith('/auth_init')) {
      initialization = body;
      platform({ authorize_url: `${origin}/dsh/authorize?attempt=local`, authorize_id: 'local-authorization', expires_in: 120 });
    } else if (url.pathname.endsWith('/auth_exchange')) {
      platform({ token: grant, authorized_url: `${origin}/dsh/authorized` });
    } else if (url.pathname.endsWith('/auth_cancel') || url.pathname.endsWith('/logout')) {
      platform({});
    } else if (url.pathname === '/auth-api/v0/users/current') {
      platform({ id: 'local-account', email: 'test@example.invalid', id_profile: { name: '隔离测试', picture: null } });
    } else if (url.pathname === '/api/v0/users/get_user_summary') {
      platform({ normal_wallets: [{ currency: 'CNY', balance: quota ? '0' : '5' }], bonus_wallets: [] });
    } else if (url.pathname === '/models') {
      if (req.headers['x-dsh-auth-token'] !== grant) return json({ error: 'Unauthorized' }, 401);
      json({ data: [{ id: 'deepseek-flash', object: 'model', context_window: 131072, max_output_tokens: 4096, api_capabilities: { anthropic_messages: {} } }] });
    } else if (url.pathname.endsWith('/messages')) {
      if (req.headers['x-dsh-auth-token'] !== grant) return json({ error: 'Unauthorized' }, 401);
      inferenceRequests++;
      if (quota) return json({ type: 'error', error: { type: 'insufficient_balance', message: 'Local fixture: quota exhausted' } }, 402);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
      event('message_start', { message: { id: `fixture-${inferenceRequests}`, type: 'message', role: 'assistant', content: [], model: 'deepseek-flash', stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '[happy] 本地登录验证通过。' } });
      event('content_block_stop', { index: 0 });
      event('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } });
      event('message_stop', {});
      res.end();
    } else json({ error: 'Unknown fixture route', path: url.pathname }, 404);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    grant,
    get initialization() { return initialization; },
    get inferenceRequests() { return inferenceRequests; },
    exhaustQuota() { quota = true; },
    close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }),
  };
}
