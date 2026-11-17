import { describe, expect, it } from 'vitest';
import {
  cloudHttpToWs,
  cloudLlmActive,
  cloudRealtimeBaseUrl,
  cloudVoiceActive,
  cloudVoiceBaseUrl,
  DEFAULT_CLOUD_URL,
  installCloud,
  isQuotaErrorMessage,
  resolveCloudEndpoint,
} from '../src/services/cloud';
import { resolveVoiceConnection, speechPlan } from '../src/services/voice';

describe('managed cloud service & BYOK switching', () => {
  it('defaults to schathub.xyz/kbot/api and computes gateway endpoints cleanly', () => {
    expect(DEFAULT_CLOUD_URL).toBe('https://schathub.xyz/kbot/api');
    expect(resolveCloudEndpoint({ cloud: { endpoint: '' } })).toBe('https://schathub.xyz/kbot/api');
    const S = { cloud: { endpoint: 'https://api.kbot.test/', llmMode: 'managed', voiceMode: 'managed', hasSession: true } };
    expect(cloudHttpToWs('https://api.kbot.test')).toBe('wss://api.kbot.test');
    expect(cloudHttpToWs('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787');
    expect(cloudLlmActive(S)).toBe(true);
    expect(cloudVoiceActive(S)).toBe(true);
    expect(cloudVoiceBaseUrl(S)).toBe('https://api.kbot.test/v1/dashscope/api/v1');
    expect(cloudRealtimeBaseUrl(S)).toBe('wss://api.kbot.test/v1/dashscope/api-ws/v1/realtime');
    expect(isQuotaErrorMessage('千问语音服务暂不可用（HTTP 402）')).toBe(true);
    expect(isQuotaErrorMessage('平台体验额度或点数已用完')).toBe(true);
    expect(isQuotaErrorMessage('网络超时')).toBe(false);
  });

  it('routes TTS between managed gateway and user BYOK key cleanly', () => {
    const baseState: any = {
      persona: 'cute',
      cloud: { endpoint: 'https://api.kbot.test', llmMode: 'managed', voiceMode: 'managed', hasSession: true },
      voice: { enabled: true, model: 'qwen3-tts-flash', ttsVoice: 'Cherry', style: '', realtimeHasKey: false, hasKey: false },
    };

    const managedConn = resolveVoiceConnection(baseState);
    expect(managedConn).toEqual({
      managed: true,
      ttsBase: 'https://api.kbot.test/v1/dashscope/api/v1',
      realtimeBase: 'wss://api.kbot.test/v1/dashscope/api-ws/v1/realtime',
      ready: true,
    });
    const managedPlan = speechPlan(baseState, '你好呀');
    expect(managedPlan.tts?.managed).toBe(true);
    expect(managedPlan.tts?.base).toBe('https://api.kbot.test/v1/dashscope/api/v1');

    // Switching voice to BYOK stops managed routing and respects user key only.
    const byokState = {
      ...baseState,
      cloud: { ...baseState.cloud, voiceMode: 'byok' },
      voice: { ...baseState.voice, realtimeHasKey: true },
    };
    const byokPlan = speechPlan(byokState, '你好呀');
    expect(byokPlan.tts?.managed).toBeUndefined();
    expect(byokPlan.tts?.base).toBe('https://dashscope.aliyuncs.com/api/v1');
  });

  it('bootstraps trial, syncs DSH cloud provider, redeems codes, and updates exhaustion state', async () => {
    const calls: Array<{ name: string; args?: any }> = [];
    const handlers = new Map<string, Set<(p?: any) => void>>();
    const A: any = {
      S: { cloud: { endpoint: 'https://api.kbot.test', llmMode: 'managed', voiceMode: 'managed', hasSession: false }, voice: {} },
      dshState: { connected: true, provider: '' },
      save: () => {},
      on: (ev: string, fn: (p?: any) => void) => {
        if (!handlers.has(ev)) handlers.set(ev, new Set());
        handlers.get(ev)!.add(fn);
      },
      emit: (ev: string, p?: any) => {
        for (const fn of handlers.get(ev) || []) fn(p);
      },
    };
    const run: any = async (name: string, args?: any) => {
      calls.push({ name, args });
      if (name === 'cloud_bootstrap') return { hasSession: true, signedIn: false, account: null, credits: 20, trialTotal: 20, trialGranted: true };
      if (name === 'cloud_redeem') return { hasSession: true, signedIn: false, account: null, credits: 70, trialTotal: 20 };
      if (name === 'cloud_status') return { hasSession: true, signedIn: false, account: null, credits: 0, trialTotal: 20 };
      return { ok: true };
    };

    installCloud(A, run);
    const boot = await A.cloud.bootstrap(false);
    expect(boot.credits).toBe(20);
    expect(boot.status).toBe('ready');
    expect(calls.some((c) => c.name === 'dsh_configure_cloud' && c.args.enabled === true)).toBe(true);

    const redeemed = await A.cloud.redeem('KBOT-1111-2222-3333');
    expect(redeemed.credits).toBe(70);

    await A.cloud.setLlmMode('byok');
    expect(calls.some((c) => c.name === 'dsh_configure_cloud' && c.args.enabled === false)).toBe(true);

    A.emit('cloud:quota-hit');
    await Promise.resolve();
    expect(A.cloudState.status).toBe('exhausted');
  });
});
