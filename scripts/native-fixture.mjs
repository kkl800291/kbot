// Local-only protocol fixture. No real model service or user credential is used.
import http from 'node:http';
const server = http.createServer(async (req, res) => {
  if (req.url === '/v1/models' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'fixture' }, { id: 'responses' }, { id: 'tools' }] })); return;
  }
  if (!['/v1/chat/completions', '/v1/responses'].includes(req.url)) { res.writeHead(404).end(); return; }
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  if (req.url === '/v1/responses') {
    if (!body.tools?.some(t => t.type === 'web_search') || !Array.isArray(body.input) || body.store !== false) { res.writeHead(400).end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = event => res.write(`data: ${JSON.stringify(event)}\n\n`);
    emit({ type: 'response.web_search_call.searching', output_index: 0 });
    emit({ type: 'response.web_search_call.completed', output_index: 0 });
    emit({ type: 'response.output_text.delta', output_index: 1, delta: '联网协议验证正常。' });
    emit({ type: 'response.output_text.annotation.added', output_index: 1, annotation: { type: 'url_citation', url: 'https://example.com/native-search', title: '本机协议验证来源', start_index: 0, end_index: 8 } });
    if (body.model === 'response-tools') {
      emit({ type: 'response.output_item.added', output_index: 2, item: { type: 'function_call', name: 'create_reminder' } });
      const args = JSON.stringify({ content: 'Responses 协议验证', when: '2026-12-10 15:00:00', repeat: '仅一次' });
      emit({ type: 'response.function_call_arguments.delta', output_index: 2, delta: args.slice(0, 15) });
      emit({ type: 'response.function_call_arguments.delta', output_index: 2, delta: args.slice(15) });
    }
    emit({ type: 'response.completed', response: { status: 'completed', output: [] } });
    res.end(); return;
  }
  if (body.model === 'unauthorized') { res.writeHead(401).end('{}'); return; }
  if (body.model === 'json-only') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] })); return; }
  if (body.model === 'companion-context' && (!body.messages?.some(m => m.role === 'assistant' && m.content === '今天的待办可以慢慢清空，我的陪伴电量倒是挺足的。') || body.messages.at(-1)?.content !== '没有代办' || body.enable_search)) {
    res.writeHead(400).end('{}'); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const frame = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
  if (body.model === 'tools') {
    const args = JSON.stringify({ content: '协议验证', when: '2026-12-10 15:00:00', repeat: '仅一次' });
    res.write(frame({ tool_calls: [{ index: 0, function: { name: 'create_reminder', arguments: args.slice(0, 14) } }] }));
    res.write(frame({ tool_calls: [{ index: 0, function: { arguments: args.slice(14) } }] }));
  } else if (body.model === 'companion-context') {
    res.write(frame({ content: '那今天就先轻松一点，我陪你聊点别的。' }));
  } else if (body.model === 'slow') {
    for (let i = 0; i < 100; i++) {
      if (res.destroyed) return;
      res.write(frame({ content: '等' })); await new Promise(r => setTimeout(r, 100));
    }
  } else {
    const bytes = Buffer.from(frame({ content: '你好，流式连接正常。' }));
    // Split both a UTF-8 character and an SSE frame across transport chunks.
    for (let i = 0; i < bytes.length; i += 7) { res.write(bytes.subarray(i, i + 7)); await new Promise(r => setTimeout(r, 2)); }
  }
  res.end('data: [DONE]\n\n');
});
server.listen(19420, '127.0.0.1', () => console.log('Native fixture ready on 127.0.0.1:19420'));
