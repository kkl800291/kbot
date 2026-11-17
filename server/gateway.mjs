import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { Readable } from 'node:stream';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { CreditLedger } from './ledger.mjs';

const DEFAULT_COSTS = { chat: 1, tts: 1, realtime: 2, enroll: 2 };

const GATEWAY_ENV_TEMPLATE = `# KBOT 托管网关本地配置（已被 .gitignore 忽略，仅在服务端使用）
DEEPSEEK_API_KEY=""
DASHSCOPE_API_KEY=""
KBOT_GATEWAY_ADMIN_TOKEN=""
KBOT_TRIAL_CREDITS=20
`;

function loadGatewayEnv(filePath, createIfMissing = false) {
  if (!fs.existsSync(filePath)) {
    if (createIfMissing) {
      fs.writeFileSync(filePath, GATEWAY_ENV_TEMPLATE, { mode: 0o600 });
    }
    return;
  }
  for (const raw of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

function stripMountPrefix(pathname, prefix = '/kbot/api') {
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readBodyBuffer(req, maxBytes = 12 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('请求体过大'), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const buf = await readBodyBuffer(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('JSON 格式无效'), { status: 400 });
  }
}

function bearerFromHeaders(headers) {
  const auth = String(headers.authorization || '').trim();
  if (/^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const xApiKey = String(headers['x-api-key'] || '').trim();
  return xApiKey || '';
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length > 0 && ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function createGatewayServer(options = {}) {
  const ledger = options.ledger || new CreditLedger({
    dataPath: options.dataPath || process.env.KBOT_GATEWAY_DATA,
    trialCredits: options.trialCredits ?? (process.env.KBOT_TRIAL_CREDITS ? Number(process.env.KBOT_TRIAL_CREDITS) : undefined),
    signingSecret: options.signingSecret ?? process.env.KBOT_SIGNING_SECRET,
  });

  const deepseekApiKey = (options.deepseekApiKey ?? process.env.DEEPSEEK_API_KEY ?? '').trim();
  const deepseekBaseUrl = (options.deepseekBaseUrl ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '');
  const dashscopeApiKey = (options.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY ?? '').trim();
  const dashscopeHttpBase = (options.dashscopeHttpBase ?? process.env.DASHSCOPE_HTTP_BASE ?? 'https://dashscope.aliyuncs.com').trim().replace(/\/+$/, '');
  const dashscopeWsBase = (options.dashscopeWsBase ?? process.env.DASHSCOPE_WS_BASE ?? 'wss://dashscope.aliyuncs.com').trim().replace(/\/+$/, '');
  const adminToken = (options.adminToken ?? process.env.KBOT_GATEWAY_ADMIN_TOKEN ?? '').trim();
  const costs = { ...DEFAULT_COSTS, ...(options.costs || {}) };

  async function requireSession(req) {
    const token = bearerFromHeaders(req.headers);
    const sub = await ledger.verifyToken(token);
    if (!sub) {
      throw Object.assign(new Error('云端会话无效或已过期，请重新连接'), { status: 401 });
    }
    return sub;
  }

  function requireAdmin(req) {
    if (!adminToken) {
      throw Object.assign(new Error('服务端未设置 KBOT_GATEWAY_ADMIN_TOKEN'), { status: 503 });
    }
    const provided = String(req.headers['x-admin-token'] || '').trim() || bearerFromHeaders(req.headers);
    if (!safeEqual(provided, adminToken)) {
      throw Object.assign(new Error('管理员凭据无效'), { status: 403 });
    }
  }

  function accountSummary(view) {
    return {
      ...view,
      pricing: costs,
      endpoints: {
        llm: '/v1/llm/anthropic',
        tts: '/v1/dashscope/api/v1',
        realtime: '/v1/dashscope/api-ws/v1/realtime',
      },
    };
  }

  const mountPrefix = (options.mountPrefix ?? process.env.KBOT_GATEWAY_PREFIX ?? '/kbot/api').trim().replace(/\/+$/, '');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = stripMountPrefix(url.pathname, mountPrefix);
    const method = (req.method || 'GET').toUpperCase();

    try {
      if (method === 'GET' && pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          service: 'kbot-gateway',
          llmConfigured: Boolean(deepseekApiKey),
          voiceConfigured: Boolean(dashscopeApiKey),
        });
      }

      if (method === 'POST' && pathname === '/v1/kbot/bootstrap') {
        const body = await readJsonBody(req);
        const existing = bearerFromHeaders(req.headers);
        const view = await ledger.bootstrapDevice(body.deviceId, existing || null);
        return sendJson(res, 200, accountSummary(view));
      }

      if (method === 'GET' && pathname === '/v1/kbot/account') {
        const sub = await requireSession(req);
        const view = await ledger.getStatus(sub);
        return sendJson(res, 200, accountSummary(view));
      }

      if (method === 'POST' && pathname === '/v1/kbot/auth/login') {
        const body = await readJsonBody(req);
        const view = await ledger.loginAccount({
          account: body.account,
          password: body.password,
          deviceId: body.deviceId,
        });
        return sendJson(res, 200, accountSummary(view));
      }

      if (method === 'POST' && pathname === '/v1/kbot/redeem') {
        const sub = await requireSession(req);
        const body = await readJsonBody(req);
        const view = await ledger.redeemCode(sub, body.code);
        return sendJson(res, 200, accountSummary(view));
      }

      if (method === 'POST' && pathname === '/v1/kbot/admin/codes') {
        requireAdmin(req);
        const body = await readJsonBody(req);
        const created = await ledger.createCodes(body);
        return sendJson(res, 200, { ok: true, codes: created });
      }

      if (method === 'POST' && pathname === '/v1/kbot/admin/grant') {
        requireAdmin(req);
        const body = await readJsonBody(req);
        const view = await ledger.grantToAccount(body.account, body.credits);
        return sendJson(res, 200, { ok: true, ...accountSummary(view) });
      }

      if (pathname === '/v1/llm/anthropic/models' && method === 'GET') {
        await requireSession(req);
        return sendJson(res, 200, {
          data: [
            { id: 'deepseek-flash', display_name: 'DeepSeek-V4.1-Flash' },
            { id: 'deepseek-chat', display_name: 'DeepSeek-V3.2' },
            { id: 'deepseek-reasoner', display_name: 'DeepSeek-R1' },
          ],
        });
      }

      if (pathname.startsWith('/v1/llm/anthropic/')) {
        const sub = await requireSession(req);
        if (!deepseekApiKey) {
          return sendJson(res, 503, {
            type: 'error',
            error: { type: 'api_error', message: '网关未配置 DEEPSEEK_API_KEY' },
          });
        }
        const suffix = pathname.slice('/v1/llm/anthropic'.length);
        const isBillable = method === 'POST' && (suffix === '/v1/messages' || suffix === '/messages');
        if (isBillable) {
          try {
            await ledger.consumeCredits(sub, costs.chat, 'chat');
          } catch (err) {
            return sendJson(res, err.status || 402, {
              type: 'error',
              error: { type: 'quota_exhausted', message: err.message },
            });
          }
        }
        const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readBodyBuffer(req);
        const targetUrl = `${deepseekBaseUrl}${suffix}${url.search}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          const lower = k.toLowerCase();
          if (['host', 'content-length', 'connection', 'authorization', 'x-api-key'].includes(lower)) continue;
          headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        headers.set('x-api-key', deepseekApiKey);
        let upstream;
        try {
          upstream = await fetch(targetUrl, { method, headers, body: rawBody });
        } catch (err) {
          if (isBillable) await ledger.refundCredits(sub, costs.chat, 'chat');
          return sendJson(res, 502, {
            type: 'error',
            error: { type: 'api_error', message: `连接上游大模型失败: ${err.message}` },
          });
        }
        if (isBillable && !upstream.ok) {
          await ledger.refundCredits(sub, costs.chat, 'chat');
        }
        const outHeaders = {};
        upstream.headers.forEach((v, k) => {
          const lower = k.toLowerCase();
          if (['content-encoding', 'transfer-encoding', 'connection'].includes(lower)) return;
          outHeaders[k] = v;
        });
        res.writeHead(upstream.status, outHeaders);
        if (!upstream.body) return res.end();
        Readable.fromWeb(upstream.body).pipe(res);
        return;
      }

      if (pathname.startsWith('/v1/dashscope/api/v1/')) {
        const sub = await requireSession(req);
        if (!dashscopeApiKey) {
          return sendJson(res, 503, { code: 'GatewayUnconfigured', message: '网关未配置 DASHSCOPE_API_KEY' });
        }
        const rawBody = method === 'GET' || method === 'HEAD' ? undefined : await readBodyBuffer(req);
        let chargeCost = 0;
        let chargeKind = 'tts';
        if (pathname.endsWith('/services/aigc/multimodal-generation/generation')) {
          chargeCost = costs.tts;
          chargeKind = 'tts';
        } else if (pathname.endsWith('/services/audio/tts/customization')) {
          const parsedBody = rawBody?.length ? JSON.parse(rawBody.toString('utf8')) : {};
          const action = parsedBody?.input?.action;
          if (action === 'create') {
            chargeCost = costs.enroll;
            chargeKind = 'enroll';
          }
        }
        if (chargeCost > 0) {
          await ledger.consumeCredits(sub, chargeCost, chargeKind);
        }
        const upstreamPath = pathname.slice('/v1/dashscope'.length);
        const targetUrl = `${dashscopeHttpBase}${upstreamPath}${url.search}`;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) {
          if (v === undefined) continue;
          const lower = k.toLowerCase();
          if (['host', 'content-length', 'connection', 'authorization'].includes(lower)) continue;
          headers.set(k, Array.isArray(v) ? v.join(', ') : v);
        }
        headers.set('authorization', `Bearer ${dashscopeApiKey}`);
        let upstream;
        try {
          upstream = await fetch(targetUrl, { method, headers, body: rawBody });
        } catch (err) {
          if (chargeCost > 0) await ledger.refundCredits(sub, chargeCost, chargeKind);
          return sendJson(res, 502, { code: 'UpstreamError', message: `连接千问服务失败: ${err.message}` });
        }
        if (chargeCost > 0 && !upstream.ok) {
          await ledger.refundCredits(sub, chargeCost, chargeKind);
        }
        const buf = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
          'content-length': buf.length,
        });
        res.end(buf);
        return;
      }

      sendJson(res, 404, { error: `Unknown route: ${pathname}` });
    } catch (err) {
      const status = Number.isInteger(err?.status) ? err.status : 500;
      sendJson(res, status, {
        code: err?.code || 'gateway_error',
        error: { message: err?.message || '网关内部错误' },
        message: err?.message || '网关内部错误',
      });
    }
  });

  server.on('upgrade', async (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = stripMountPrefix(url.pathname, mountPrefix);
    if (!pathname.startsWith('/v1/dashscope/api-ws/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = bearerFromHeaders(req.headers);
    const sub = await ledger.verifyToken(token);
    if (!sub) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!dashscopeApiKey) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    try {
      await ledger.consumeCredits(sub, costs.realtime, 'realtime');
    } catch (err) {
      const statusLine = err?.status === 401 ? '401 Unauthorized' : '402 Payment Required';
      socket.write(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }

    const upstreamBase = new URL(dashscopeWsBase);
    const upstreamPath = `${pathname.slice('/v1/dashscope'.length)}${url.search}`;
    const port = upstreamBase.port ? Number(upstreamBase.port) : (upstreamBase.protocol === 'wss:' ? 443 : 80);
    const useTls = upstreamBase.protocol === 'wss:';
    const hostHeader = upstreamBase.port ? `${upstreamBase.hostname}:${port}` : upstreamBase.hostname;

    const upstreamSocket = useTls
      ? tls.connect({ host: upstreamBase.hostname, port, servername: upstreamBase.hostname })
      : net.connect({ host: upstreamBase.hostname, port });

    let handshakeDone = false;
    const refundIfNeverConnected = async () => {
      if (!handshakeDone) {
        handshakeDone = true;
        await ledger.refundCredits(sub, costs.realtime, 'realtime').catch(() => {});
      }
    };

    upstreamSocket.once('error', () => {
      void refundIfNeverConnected();
      if (!socket.destroyed) socket.destroy();
    });
    socket.once('error', () => {
      if (!upstreamSocket.destroyed) upstreamSocket.destroy();
    });

    upstreamSocket.once('connect', () => {
      const wsKey = req.headers['sec-websocket-key'] || crypto.randomBytes(16).toString('base64');
      const wsVer = req.headers['sec-websocket-version'] || '13';
      const lines = [
        `GET ${upstreamPath} HTTP/1.1`,
        `Host: ${hostHeader}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Version: ${wsVer}`,
        `Authorization: Bearer ${dashscopeApiKey}`,
        '',
        '',
      ];
      upstreamSocket.write(lines.join('\r\n'));
      if (head?.length) upstreamSocket.write(head);
    });

    let headerBuf = Buffer.alloc(0);
    const onUpstreamData = (chunk) => {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const idx = headerBuf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      upstreamSocket.off('data', onUpstreamData);
      const statusHead = headerBuf.subarray(0, idx).toString('utf8');
      if (/\b101\b/.test(statusHead.split('\r\n')[0] || '')) {
        handshakeDone = true;
      } else {
        void refundIfNeverConnected();
      }
      socket.write(headerBuf);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    };
    upstreamSocket.on('data', onUpstreamData);
  });

  return { server, ledger };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  loadGatewayEnv(path.join(rootDir, '.env.gateway.local'), true);
  loadGatewayEnv(path.join(rootDir, '.env.local'));
  const port = Number(process.env.PORT || process.env.KBOT_GATEWAY_PORT || 8787);
  const host = process.env.HOST || '127.0.0.1';
  const { server } = createGatewayServer();
  server.listen(port, host, () => {
    console.log(`KBOT Managed Gateway listening on http://${host}:${port}`);
    console.log(`  DEEPSEEK_API_KEY: ${process.env.DEEPSEEK_API_KEY ? 'configured' : 'missing (chat proxy will return 503)'}`);
    console.log(`  DASHSCOPE_API_KEY: ${process.env.DASHSCOPE_API_KEY ? 'configured' : 'missing (voice proxy will return 503)'}`);
  });
}
