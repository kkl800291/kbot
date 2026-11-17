import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGatewayServer } from '../server/gateway.mjs';
import { CreditLedger } from '../server/ledger.mjs';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop()!;
    await fn().catch(() => {});
  }
});

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as { port: number };
  return `http://127.0.0.1:${addr.port}`;
}

describe('KBOT Managed Quota & Proxy Gateway', () => {
  it('enforces one-time device trial, proxies LLM & Qwen TTS without leaking keys, enforces 402, and supports redeem/login', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kbot-gw-test-'));
    cleanups.push(() => fs.rm(tmpDir, { recursive: true, force: true }));

    const upstreamSeen: Array<{ path: string; auth: string }> = [];
    const mockUpstream = http.createServer(async (req, res) => {
      const url = req.url || '/';
      const auth = String(req.headers['x-api-key'] || req.headers.authorization || '');
      upstreamSeen.push({ path: url, auth });
      const body = url.includes('multimodal-generation')
        ? JSON.stringify({ output: { audio: { data: 'UklGRg==' } } })
        : JSON.stringify({ id: 'msg_1', type: 'message', content: [{ type: 'text', text: 'hello' }] });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
    const upstreamBase = await listen(mockUpstream);
    cleanups.push(() => new Promise((r) => mockUpstream.close(() => r())));

    const ledger = new CreditLedger({
      dataPath: path.join(tmpDir, 'ledger.json'),
      trialCredits: 2,
      signingSecret: 'test-signing-secret-0123456789abcdef',
    });
    const { server } = createGatewayServer({
      ledger,
      deepseekApiKey: 'sk-server-deepseek-secret',
      deepseekBaseUrl: `${upstreamBase}/anthropic`,
      dashscopeApiKey: 'sk-server-dashscope-secret',
      dashscopeHttpBase: upstreamBase,
      adminToken: 'admin-secret-token',
    });
    const gw = await listen(server);
    cleanups.push(() => new Promise((r) => server.close(() => r())));

    // 1. Device bootstrap grants trial once.
    const boot1 = await fetch(`${gw}/v1/kbot/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'kbot-device-abc-12345' }),
    }).then((r) => r.json());
    expect(boot1.trialGranted).toBe(true);
    expect(boot1.credits).toBe(2);
    expect(boot1.token).toMatch(/^kbot1\./);

    const boot2 = await fetch(`${gw}/v1/kbot/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'kbot-device-abc-12345' }),
    }).then((r) => r.json());
    expect(boot2.trialGranted).toBe(false);
    expect(boot2.credits).toBe(2);

    // 2. LLM proxy uses server DeepSeek key and deducts 1 credit.
    const llmRes = await fetch(`${gw}/v1/llm/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': boot1.token },
      body: JSON.stringify({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(llmRes.status).toBe(200);
    expect(upstreamSeen[0]).toEqual({ path: '/anthropic/v1/messages', auth: 'sk-server-deepseek-secret' });

    // 3. Qwen TTS proxy uses server DashScope key and deducts 1 credit.
    const ttsRes = await fetch(`${gw}/v1/dashscope/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${boot1.token}` },
      body: JSON.stringify({ model: 'qwen3-tts-flash', input: { text: '你好' } }),
    });
    expect(ttsRes.status).toBe(200);
    expect(upstreamSeen[1]).toEqual({
      path: '/api/v1/services/aigc/multimodal-generation/generation',
      auth: 'Bearer sk-server-dashscope-secret',
    });

    // 4. Credits exhausted -> 402 on both LLM and TTS.
    const llm402 = await fetch(`${gw}/v1/llm/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': boot1.token },
      body: '{}',
    });
    expect(llm402.status).toBe(402);

    const tts402 = await fetch(`${gw}/v1/dashscope/api/v1/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${boot1.token}` },
      body: '{}',
    });
    expect(tts402.status).toBe(402);

    // 5. Login + admin code mint + redeem restores credits.
    const loginRes = await fetch(`${gw}/v1/kbot/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'user@example.com', deviceId: 'kbot-device-abc-12345' }),
    }).then((r) => r.json());
    expect(loginRes.signedIn).toBe(true);
    expect(loginRes.credits).toBe(0);

    const codesRes = await fetch(`${gw}/v1/kbot/admin/codes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-secret-token' },
      body: JSON.stringify({ credits: 5, count: 1 }),
    }).then((r) => r.json());
    const topupCode = codesRes.codes[0].code;

    const redeemed = await fetch(`${gw}/v1/kbot/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${loginRes.token}` },
      body: JSON.stringify({ code: topupCode }),
    }).then((r) => r.json());
    expect(redeemed.credits).toBe(5);

    const llmAfter = await fetch(`${gw}/v1/llm/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': loginRes.token },
      body: '{}',
    });
    expect(llmAfter.status).toBe(200);
  });
});
