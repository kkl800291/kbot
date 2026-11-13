import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, 'src-tauri/resources/dsh-runtime');
const temporary = await mkdtemp(join(tmpdir(), 'kbot-dsh-smoke-'));
const workspace = join(temporary, 'workspace');
await mkdir(workspace);
const rust = await readFile(join(root, 'src-tauri/src/dsh.rs'), 'utf8');
const bridge = rust.match(/const KBOT_BRIDGE_MJS: &str = r#"([\s\S]*?)"#;/)?.[1];
if (!bridge) throw new Error('Bridge script not found');
const plugin = join(temporary, 'bridge.mjs');
const discovery = join(temporary, 'discovery.json');
await writeFile(plugin, bridge);
const patch = join(temporary, 'managed-patch.yml');
const fixture = process.argv.includes('--mock-account') ? await (await import('./dsh-account-fixture.mjs')).accountFixture() : null;
const accountPatch = fixture ? `- id: deepseek-account\n  config:\n    platformOrigin: ${fixture.origin}\n    inferenceOrigin: ${fixture.origin}\n    allowLoopbackHttp: true\n- id: llm-deepseek-account\n  config:\n    baseURL: ${fixture.origin}/anthropic\n` : '';
await writeFile(patch, `${accountPatch}- insert:\n    - id: kbot-bridge\n      name: ${JSON.stringify(plugin)}\n      config:\n        port: 0\n        hostKind: managed\n        discoveryFile: ${JSON.stringify(discovery)}\n`);
const env = { ...process.env, DSH_HOME: join(temporary, 'home'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
for (const key of Object.keys(env)) if (/(API_KEY|AUTH_TOKEN|ACCESS_TOKEN)$/.test(key)) delete env[key];
const child = spawn(join(runtime, 'node/bin/node'), [join(runtime, 'app/node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
let stderr = '';
child.stdout.on('data', () => {});
child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-16_000); });
try {
  let connection;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Runtime exited (${child.exitCode}): ${stderr}`);
    connection = await readFile(discovery, 'utf8').then(JSON.parse, () => null);
    if (connection) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!connection) throw new Error(`Runtime did not start: ${stderr}`);
  const base = `http://127.0.0.1:${connection.port}`;
  const post = async (route, body = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kbot-token': connection.token }, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000) });
    const result = await response.json();
    if (!response.ok || result.ok === false) throw new Error(`${route}: ${JSON.stringify(result)}`);
    return result;
  };
  const unauthorized = await fetch(base + '/health');
  if (unauthorized.status !== 401) throw new Error('Bridge accepted an unauthenticated request');
  const account = await post('/account/state');
  if (!account.account.supported || account.account.status !== 'signed-out') throw new Error('Fresh runtime must support account login and start signed out');
  const session = await post('/session/ensure', { workspacePath: workspace });
  const models = await post('/models/list', { sessionId: session.sessionId });
  const report = { isolatedHome: true, bundledNode: true, bridgeAuthenticated: true, accountSupported: true, startsSignedOut: true, sessionCreated: Boolean(session.sessionId), modelGroups: models.groups.length };
  if (fixture) {
    const login = await post('/account/sign-in');
    if (!login.authorizeUrl?.startsWith(fixture.origin + '/dsh/authorize')) throw new Error('Fixture sign-in failed');
    const callback = new URL(fixture.initialization.redirect_uri);
    callback.searchParams.set('code', 'local-test-code');
    callback.searchParams.set('state', fixture.initialization.state);
    const returned = await fetch(callback, { redirect: 'manual' });
    if (returned.status !== 302) throw new Error(`OAuth callback failed (${returned.status})`);
    const details = await post('/account/details');
    if (details.account.status !== 'credential-stored' || details.account.profile?.status !== 'ready' || details.account.balance?.value?.[0]?.balance !== '5') throw new Error('Authorized account did not expose profile and balance');
    if (JSON.stringify(details).includes(fixture.grant)) throw new Error('Account grant escaped the Host');
    const catalog = await post('/models/list', { sessionId: session.sessionId });
    const provider = catalog.groups.find(group => group.id === 'deepseek-account');
    if (!provider?.models.length) throw new Error(`Account model was not discovered: ${JSON.stringify(catalog)}\n${stderr}`);
    await post('/session/select-model', { sessionId: session.sessionId, provider: provider.id, model: provider.models[0].id });
    const eventsAbort = new AbortController();
    const stream = await fetch(base + '/events', { headers: { 'x-kbot-token': connection.token }, signal: eventsAbort.signal });
    const events = [];
    const pump = (async () => {
      let buffer = '';
      for await (const chunk of stream.body) {
        buffer += Buffer.from(chunk).toString();
        const parts = buffer.split('\n\n'); buffer = parts.pop();
        for (const part of parts) if (part.startsWith('data: ')) events.push(JSON.parse(part.slice(6)));
      }
    })().catch(() => {});
    const wait = async predicate => {
      const deadline = Date.now() + 15_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Inference events timed out: ${events.map(event => event.type).join(', ')}`);
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    try {
      await post('/session/prompt', { sessionId: session.sessionId, requestId: 'local-success', text: '验证本地连接' });
      await wait(() => events.some(event => JSON.stringify(event).includes('本地登录验证通过')));
      await wait(() => events.some(event => event.type === 'turn/end'));
      fixture.exhaustQuota();
      await post('/session/prompt', { sessionId: session.sessionId, requestId: 'local-quota', text: '验证额度不足' });
      await wait(() => events.some(event => event.type === 'agent/error' && event.code === 'ACCOUNT_QUOTA'));
    } finally { eventsAbort.abort(); await pump; }
    const zero = await post('/account/details');
    if (zero.account.balance?.value?.[0]?.balance !== '0') throw new Error('Zero balance was not shown');
    const signedOut = await post('/account/sign-out');
    if (signedOut.account.status !== 'signed-out') throw new Error('Sign-out failed');
    const after = await post('/models/list', { sessionId: session.sessionId });
    if (after.groups.some(group => group.id === 'deepseek-account')) throw new Error('Signed-out account model remained routable');
    Object.assign(report, { oauthCallback: true, walletQueried: true, credentialKeptInHost: true, accountModelSelected: true, firstReplyStreamed: true, quotaErrorClassified: true, signOutVerified: true, inferenceRequests: fixture.inferenceRequests });
  }
  if (process.argv.includes('--check-login')) {
    const login = await post('/account/sign-in', { locale: 'zh-CN', timezoneOffsetSeconds: 28800 });
    const url = login.authorizeUrl ? new URL(login.authorizeUrl) : null;
    report.officialAuthorization = url?.origin === 'https://platform.deepseek.com' && url.pathname === '/dsh/authorize';
    report.loginPhase = login.account.attempt?.phase;
    if (login.account.attempt?.id) {
      const cancelled = await post('/account/cancel', { attemptId: login.account.attempt.id });
      if (cancelled.account.attempt?.phase !== 'cancelled') throw new Error('Authorization was not cancelled');
      report.cancelVerified = true;
    }
    if (!report.officialAuthorization) throw new Error(`Official login did not return an authorization URL (${report.loginPhase})`);
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
  if (fixture) await fixture.close();
  await rm(temporary, { recursive: true, force: true });
}
