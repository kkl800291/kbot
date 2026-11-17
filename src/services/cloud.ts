import { command, native } from './runtime';

export type ProviderMode = 'managed' | 'byok';

export interface CloudSettings {
  endpoint: string;
  llmMode: ProviderMode;
  voiceMode: ProviderMode;
  hasSession?: boolean;
}

export interface CloudState {
  endpoint: string;
  status: 'unconfigured' | 'idle' | 'connecting' | 'ready' | 'exhausted' | 'error';
  hasSession: boolean;
  signedIn: boolean;
  account: string | null;
  credits: number;
  trialTotal: number;
  trialGranted: boolean;
  busy: boolean;
  error: string | null;
}

const envMeta = (import.meta as unknown as { env?: Record<string, string | undefined> }).env || {};
export const DEFAULT_CLOUD_URL = String(
  envMeta.VITE_KBOT_CLOUD_URL ?? 'https://schathub.xyz/kbot/api',
).trim().replace(/\/+$/, '');

export function resolveCloudEndpoint(S: any): string {
  const configured = String(S?.cloud?.endpoint ?? '').trim();
  const base = configured || DEFAULT_CLOUD_URL;
  return base.replace(/\/+$/, '');
}

export function cloudHttpToWs(httpUrl: string): string {
  if (httpUrl.startsWith('https://')) return `wss://${httpUrl.slice('https://'.length)}`;
  if (httpUrl.startsWith('http://')) return `ws://${httpUrl.slice('http://'.length)}`;
  return httpUrl;
}

export function cloudLlmActive(S: any): boolean {
  const mode = S?.cloud?.llmMode ?? 'managed';
  return Boolean(resolveCloudEndpoint(S) && mode === 'managed');
}

export function cloudVoiceActive(S: any): boolean {
  const mode = S?.cloud?.voiceMode ?? 'managed';
  return Boolean(resolveCloudEndpoint(S) && mode === 'managed');
}

export function cloudVoiceBaseUrl(S: any): string {
  const ep = resolveCloudEndpoint(S);
  return ep ? `${ep}/v1/dashscope/api/v1` : '';
}

export function cloudRealtimeBaseUrl(S: any): string {
  const ep = resolveCloudEndpoint(S);
  return ep ? `${cloudHttpToWs(ep)}/v1/dashscope/api-ws/v1/realtime` : '';
}

export function isQuotaErrorMessage(raw: unknown): boolean {
  const text = String(raw || '');
  return /402|quota_exhausted|额度已用完|额度或点数|点数已用完|额度不足|充值点数/i.test(text);
}

export function cloudSummary(state?: Partial<CloudState>): string {
  if (!state || state.status === 'unconfigured' || !state.endpoint) {
    return '未设置云托管网关；你可以填写自有 API Key，或在高级设置中填入托管网关地址。';
  }
  if (state.status === 'connecting') return '正在连接云托管体验额度…';
  if (state.error) return state.error;
  const credits = Number(state.credits || 0);
  if (state.status === 'exhausted' || (state.hasSession && credits <= 0)) {
    return state.signedIn
      ? `账号 ${state.account} 剩余 0 点，请兑换充值点数或切换为自带 API Key。`
      : '体验额度已用完，请登录并充值点数，或切换为自带 API Key。';
  }
  if (state.hasSession) {
    return state.signedIn
      ? `已登录 ${state.account} · 当前可用 ${credits} 点（对话与千问语音通用）`
      : `已开启免登录体验模式 · 当前剩余 ${credits} 点（无需配置 API Key）`;
  }
  return '可一键免费领取体验点数，直接开始对话与千问语音。';
}

export function installCloud(A: any, run: typeof command = command, isNative: boolean = run !== command || native) {
  const endpointOf = () => resolveCloudEndpoint(A.S);
  const state: CloudState = {
    endpoint: endpointOf(),
    status: endpointOf() ? 'idle' : 'unconfigured',
    hasSession: Boolean(A.S?.cloud?.hasSession),
    signedIn: false,
    account: null,
    credits: 0,
    trialTotal: 20,
    trialGranted: false,
    busy: false,
    error: null,
  };
  A.cloudState = state;

  const publish = () => {
    state.endpoint = endpointOf();
    if (!state.endpoint) state.status = 'unconfigured';
    if (!A.S.cloud || typeof A.S.cloud !== 'object') {
      A.S.cloud = { endpoint: '', llmMode: 'managed', voiceMode: 'managed', hasSession: false };
    }
    A.S.cloud.hasSession = Boolean(state.hasSession && state.endpoint);
    A.emit?.('cloud:state', { ...state });
  };

  function applyPayload(payload: any) {
    state.hasSession = Boolean(payload?.hasSession ?? true);
    state.signedIn = Boolean(payload?.signedIn);
    state.account = payload?.account ? String(payload.account) : null;
    state.credits = Number(payload?.credits || 0);
    state.trialTotal = Number(payload?.trialTotal || 20);
    state.trialGranted = Boolean(payload?.trialGranted);
    state.error = null;
    state.status = !endpointOf()
      ? 'unconfigured'
      : state.credits <= 0
        ? 'exhausted'
        : 'ready';
    publish();
  }

  async function syncDsh(autoSelect = false) {
    const ep = endpointOf();
    const enabled = Boolean(ep && (A.S?.cloud?.llmMode ?? 'managed') === 'managed' && state.hasSession);
    if (!isNative || !A.dshState?.connected) return;
    try {
      await run('dsh_configure_cloud', { endpoint: ep, enabled });
      if (autoSelect && A.agent?.listModels && A.agent?.selectModel) {
        const catalog = await A.agent.listModels();
        const currentProv = catalog.current?.provider || A.dshState?.provider || '';
        if (enabled && state.credits > 0) {
          const cloudProv = catalog.providers?.find((p: any) => p.id === 'kbot-cloud');
          if (cloudProv?.models?.length && currentProv !== 'kbot-cloud') {
            const preferred = cloudProv.models.find((m: any) => m.id === 'deepseek-flash') || cloudProv.models[0];
            await A.agent.selectModel('kbot-cloud', preferred.id);
          }
        } else if (!enabled && currentProv === 'kbot-cloud') {
          const fallbackProv = catalog.providers?.find((p: any) => p.id === 'deepseek-account' && p.models?.length)
            || catalog.providers?.find((p: any) => p.id === 'deepseek-official' && p.models?.length);
          const fallbackModel = fallbackProv?.models?.find((m: any) => m.id === 'deepseek-flash') || fallbackProv?.models?.[0];
          if (fallbackProv && fallbackModel) {
            await A.agent.selectModel(fallbackProv.id, fallbackModel.id);
          }
        }
      }
    } catch {
      // Keep DSH connection resilient even if cloud endpoint is momentarily offline.
    }
  }

  let bootstrapJob: Promise<CloudState> | null = null;

  const api = {
    endpoint: endpointOf,
    llmManaged: () => Boolean(endpointOf() && (A.S?.cloud?.llmMode ?? 'managed') === 'managed' && state.hasSession),
    voiceManaged: () => Boolean(endpointOf() && (A.S?.cloud?.voiceMode ?? 'managed') === 'managed' && state.hasSession),
    syncDsh,
    async bootstrap(silent = false): Promise<CloudState> {
      const ep = endpointOf();
      if (!ep) {
        state.status = 'unconfigured';
        state.hasSession = false;
        publish();
        return state;
      }
      if (!isNative) return state;
      if (bootstrapJob) return bootstrapJob;
      bootstrapJob = (async () => {
        state.busy = true;
        if (!state.hasSession) state.status = 'connecting';
        state.error = null;
        publish();
        try {
          const res = await run('cloud_bootstrap', { endpoint: ep });
          applyPayload(res);
          await syncDsh(true);
        } catch (err) {
          state.error = err instanceof Error ? err.message : String(err);
          state.status = 'error';
          publish();
          if (!silent) throw err;
        } finally {
          state.busy = false;
          bootstrapJob = null;
          publish();
        }
        return state;
      })();
      return bootstrapJob;
    },
    async refresh(): Promise<CloudState> {
      const ep = endpointOf();
      if (!ep || !isNative) {
        publish();
        return state;
      }
      if (!state.hasSession) return api.bootstrap(true);
      state.busy = true;
      state.error = null;
      publish();
      try {
        const res = await run('cloud_status', { endpoint: ep });
        applyPayload(res);
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        state.status = 'error';
        publish();
      } finally {
        state.busy = false;
        publish();
      }
      return state;
    },
    async login(account: string, password = ''): Promise<CloudState> {
      const ep = endpointOf();
      if (!ep) throw new Error('尚未配置 KBOT 云托管网关地址');
      state.busy = true;
      state.error = null;
      publish();
      try {
        const res = await run('cloud_login', { endpoint: ep, account, password });
        applyPayload(res);
        await syncDsh(true);
        A.save?.();
        return state;
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        publish();
        throw err;
      } finally {
        state.busy = false;
        publish();
      }
    },
    async redeem(code: string): Promise<CloudState> {
      const ep = endpointOf();
      if (!ep) throw new Error('尚未配置 KBOT 云托管网关地址');
      state.busy = true;
      state.error = null;
      publish();
      try {
        const res = await run('cloud_redeem', { endpoint: ep, code });
        applyPayload(res);
        await syncDsh(true);
        return state;
      } catch (err) {
        state.error = err instanceof Error ? err.message : String(err);
        publish();
        throw err;
      } finally {
        state.busy = false;
        publish();
      }
    },
    async setLlmMode(mode: ProviderMode) {
      if (!A.S.cloud || typeof A.S.cloud !== 'object') A.S.cloud = { endpoint: '', llmMode: mode, voiceMode: 'managed' };
      A.S.cloud.llmMode = mode;
      A.save?.();
      if (mode === 'managed' && endpointOf() && !state.hasSession) {
        await api.bootstrap(true);
      } else {
        await syncDsh(true);
      }
      publish();
    },
    async setVoiceMode(mode: ProviderMode) {
      if (!A.S.cloud || typeof A.S.cloud !== 'object') A.S.cloud = { endpoint: '', llmMode: 'managed', voiceMode: mode };
      A.S.cloud.voiceMode = mode;
      A.save?.();
      if (mode === 'managed' && endpointOf() && !state.hasSession) {
        await api.bootstrap(true);
      }
      A.emit?.('set:voice', A.S.voice);
      publish();
    },
    async signOut() {
      if (isNative) await run('cloud_sign_out').catch(() => {});
      state.hasSession = false;
      state.signedIn = false;
      state.account = null;
      state.credits = 0;
      state.error = null;
      state.status = endpointOf() ? 'idle' : 'unconfigured';
      await syncDsh(false);
      publish();
    },
  };

  A.cloud = api;

  A.on?.('dsh:state', (st: any) => {
    if (st?.connected && api.llmManaged()) {
      void syncDsh(true);
    }
  });
  A.on?.('generating', (on: boolean) => {
    if (!on && api.llmManaged()) void api.refresh();
  });
  A.on?.('voice', (on: boolean) => {
    if (!on && api.voiceManaged()) void api.refresh();
  });
  A.on?.('realtime', (on: boolean) => {
    if (!on && api.voiceManaged()) void api.refresh();
  });
  A.on?.('cloud:quota-hit', () => {
    state.status = 'exhausted';
    state.credits = 0;
    publish();
    void api.refresh();
  });

  publish();
  return api;
}
