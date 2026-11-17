import { describe, expect, it } from 'vitest';
import {
  briefSpeechText,
  buildRealtimeInstructions,
  cleanSpeechText,
  DEFAULT_JARVIS_SAMPLE_URL,
  DICTATION_NOTE,
  extractDshBridgeDirective,
  installVoice,
  mergeCustomRealtimeVoices,
  MIMO_VOICEDESIGN_MODEL,
  MIMO_VOICE_DESIGNS,
  normalizeRealtimeSettings,
  normalizeSpokenBrand,
  QWEN_REALTIME_MODELS,
  QWEN_REALTIME_VOICES,
  REALTIME_MODES,
  realtimeVoiceOptions,
  removeCustomRealtimeVoice,
  applyDictationTranscript,
  dictationStatus,
  resolveSummonVoiceBackend,
  speechPlan,
  speechRequest,
  speak,
  stopSpeech,
  type CommandFn,
} from '../src/services/voice';

describe('voice service (Xiaomi MiMo TTS)', () => {
  it('provides an original British AI butler voice-design preset', () => {
    expect(MIMO_VOICEDESIGN_MODEL).toBe('mimo-v2.5-tts-voicedesign');
    expect(MIMO_VOICE_DESIGNS[0][1]).toContain('AI 管家');
    expect(MIMO_VOICE_DESIGNS[0][2]).toContain('British male AI butler');
    expect(MIMO_VOICE_DESIGNS[0][2]).not.toContain('Paul Bettany');
  });
  it('passes bubble text and MiMo config as structured IPC args without shell strings', async () => {
    const bubble = '他说"$HOME" && rm\n第二行';
    const mimo = {
      enabled: true,
      base: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      voice: '冰糖',
      style: '元气灵动',
    };
    const request = speechRequest(bubble, { mimo, emotion: 'happy' });
    expect(request.args.text).toBe(bubble);
    expect(request.args.mimo?.voice).toBe('冰糖');
    expect(request.args.emotion).toBe('happy');
    expect(JSON.stringify(request)).not.toContain('sh -c');
    expect(request.command).toBe('voice_speak');

    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const run: CommandFn = async (name, args) => {
      calls.push({ name, args });
      return { provider: 'mimo' } as any;
    };
    const spoken = await speak(bubble, { mimo, emotion: 'happy' }, run);
    expect(spoken.request.args.text).toBe(bubble);
    expect(spoken.outcome.provider).toBe('mimo');
    await stopSpeech(run);
    expect(calls[0]).toEqual({
      name: 'voice_speak',
      args: { text: bubble, mimo, emotion: 'happy' },
    });
    expect(calls[1].name).toBe('voice_stop');
  });

  it('strips inline expression tags and code fences for clean TTS reading', () => {
    const text = '[happy] 你好呀！这里是 `KBOT`，看这段代码：\n```ts\nconsole.log(1);\n```\n[wink] 搞定啦！';
    const cleaned = cleanSpeechText(text);
    expect(cleaned).not.toContain('[happy]');
    expect(cleaned).not.toContain('[wink]');
    expect(cleaned).not.toContain('console.log');
    expect(cleaned).toContain('你好呀！');
    expect(cleaned).toContain('搞定啦！');
    expect(cleanSpeechText('KBOT 已上线，K-B-O-T 等待指令。')).toBe('Kbot 已上线，Kbot 等待指令。');
  });

  it('auto-read keeps only whole leading sentences within about 200 characters', () => {
    const text = '第一句话说完了。'.repeat(40);
    const brief = briefSpeechText(text);
    expect(brief.length).toBeLessThanOrEqual(200);
    expect(brief.length).toBeGreaterThan(150);
    expect(brief.endsWith('。')).toBe(true);
    expect(text.startsWith(brief)).toBe(true);
    expect(briefSpeechText('好的，先生。')).toBe('好的，先生。');
    expect(briefSpeechText('字'.repeat(300))).toHaveLength(200);
  });

  it('does not mix cute expression moods into a custom voice style such as the AI butler', () => {
    const S = {
      persona: 'cute',
      voice: { enabled: true, hasKey: true, model: MIMO_VOICEDESIGN_MODEL, style: MIMO_VOICE_DESIGNS[0][2] },
    };
    const butler = speechPlan(S, '[happy] 好的，先生。', { emotion: 'happy' });
    expect(butler.text).toBe('好的，先生。');
    expect(butler.mimo?.style).toBe(MIMO_VOICE_DESIGNS[0][2]);
    expect(butler.emotion).toBeNull();

    const persona = speechPlan({ ...S, voice: { ...S.voice, style: '' } }, '好的。', { emotion: 'happy' });
    expect(persona.emotion).toBe('happy');
    expect(speechPlan({ ...S, voice: { ...S.voice, hasKey: false } }, '好的。').mimo).toBeNull();
  });

  it('automatic reading sends the brief text and reports failures instead of swallowing them', async () => {
    const calls: Array<{ name: string; args?: Record<string, any> }> = [];
    const toasts: string[] = [];
    const A: any = {
      S: { persona: 'cute', voice: { enabled: true, hasKey: true, style: '' } },
      isDnd: () => false,
      toast: (msg: string) => toasts.push(msg),
    };
    const run: CommandFn = async (name, args) => {
      calls.push({ name, args });
      throw 'MiMo 语音合成超时（30 秒）';
    };
    installVoice(A, run, true);
    await A.voice.speakAuto('第一句话说完了。'.repeat(40), { emotion: 'happy' });
    expect(calls[0].name).toBe('voice_speak');
    expect(calls[0].args?.text.length).toBeLessThanOrEqual(200);
    expect(toasts[0]).toContain('MiMo 语音合成超时');
  });

  it('stays "speaking" until the last overlapping utterance ends, and can be stopped midway', async () => {
    const events: boolean[] = [], names: string[] = [], done: Array<() => void> = [];
    const A: any = {
      S: { persona: 'cute', voice: { enabled: true, hasKey: true, style: '' } },
      isDnd: () => false,
      emit: (name: string, on: boolean) => { if (name === 'voice') events.push(on); },
    };
    const run: CommandFn = (name) => {
      names.push(name);
      if (name === 'voice_stop') return Promise.resolve(undefined as any);
      return new Promise(resolve => done.push(() => resolve({ outcome: 'played' } as any)));
    };
    installVoice(A, run, true);
    expect(A.voice.speaking).toBe(false);
    const first = A.voice.speakText('第一句。', { force: true });
    const second = A.voice.speakText('第二句。', { force: true });
    expect(A.voice.speaking).toBe(true);
    // 第一句被顶掉后返回，第二句还在读
    done[0](); await first;
    expect(A.voice.speaking).toBe(true);
    await A.voice.stop();
    expect(names).toContain('voice_stop');
    done[1](); await second;
    expect(A.voice.speaking).toBe(false);
    expect(events).toEqual([true, false]);
  });

  it('turns line breaks into pauses and drops list markers before reading', () => {
    expect(cleanSpeechText('今日安排\n- 十点评审\n- 两点对齐设计\n\n记得带伞。')).toBe('今日安排。十点评审。两点对齐设计。记得带伞。');
    expect(cleanSpeechText('1. 先备份\n2) 再升级')).toBe('先备份。再升级');
    expect(cleanSpeechText('好的，\n先生。')).toBe('好的， 先生。');
  });

  it('reports dictation permission without sending audio', async () => {
    const run: CommandFn = async name => {
      expect(name).toBe('voice_permission_status');
      return { implemented: false, microphone: 'denied', speechRecognition: 'not_determined', message: DICTATION_NOTE } as any;
    };
    const status = await dictationStatus(run);
    expect(status.implemented).toBe(false);
    expect(status.microphone).toBe('denied');
    expect(status.message).toContain('不会发给对话模型');
    expect(status.message).toContain('不会自动发送');
  });

  it('writes dictation into the caret and never appends a send action', () => {
    expect(applyDictationTranscript('明天', '。', '提醒我开会')).toBe('明天提醒我开会。');
    expect(applyDictationTranscript('See you', '', 'tomorrow')).toBe('See you tomorrow');
    expect(applyDictationTranscript('已有内容', '', '   ')).toBe('已有内容');
  });

  it('resolves summon voice backend and parses DSH bridge directives', () => {
    expect(QWEN_REALTIME_MODELS.map(m => m[0])).toContain('qwen3.5-omni-flash-realtime');
    expect(QWEN_REALTIME_VOICES.map(v => v[0])).toContain('Tina');
    expect(REALTIME_MODES.map(m => m[0])).toEqual(['auto', 'qwen-realtime', 'dsh-native']);

    const legacy = { realtimeModel: 'qwen-omni-turbo-realtime', realtimeVoice: 'Cherry' };
    expect(normalizeRealtimeSettings(legacy)).toBe(true);
    expect(legacy).toEqual({ realtimeModel: 'qwen3.5-omni-flash-realtime', realtimeVoice: 'Tina' });
    expect(normalizeRealtimeSettings(legacy)).toBe(false);

    const zane35 = { realtimeModel: 'qwen3.5-omni-flash-realtime', realtimeVoice: 'Zane' };
    expect(normalizeRealtimeSettings(zane35)).toBe(true);
    expect(zane35.realtimeVoice).toBe('Tina');

    const zane38 = { realtimeModel: 'qwen3.8-omni-flash-realtime', realtimeVoice: 'Zane' };
    expect(normalizeRealtimeSettings(zane38)).toBe(false);

    const customVoice = {
      realtimeModel: 'qwen3.5-omni-flash-realtime',
      realtimeVoice: 'qwen-omni-vc-jarvis-001',
      customVoices: [{ voice: 'qwen-omni-vc-jarvis-001', name: '贾维斯（英伦男声）', targetModel: 'qwen3.5-omni-flash-realtime' }],
    };
    expect(normalizeRealtimeSettings(customVoice)).toBe(false);
    expect(realtimeVoiceOptions(customVoice)[0]).toEqual(['qwen-omni-vc-jarvis-001', '贾维斯（英伦男声）（复刻音色）']);
    expect(mergeCustomRealtimeVoices(customVoice.customVoices, [
      { voice: 'qwen-omni-vc-jarvis-001', targetModel: 'qwen3.5-omni-flash-realtime', createdAt: '2026-11-16' },
      { voice: 'qwen-omni-vc-other-abcdef', targetModel: 'qwen3.8-omni-flash-realtime' },
    ]).map(v => v.name)).toEqual(['贾维斯（英伦男声）', '复刻音色 · abcdef']);
    const dupOptions = realtimeVoiceOptions({
      realtimeModel: 'qwen3.5-omni-flash-realtime',
      realtimeVoice: 'v-aaaa',
      customVoices: [
        { voice: 'v-aaaa', name: '贾维斯', targetModel: 'qwen3.5-omni-flash-realtime' },
        { voice: 'v-bbbb', name: '贾维斯', targetModel: 'qwen3.5-omni-flash-realtime' },
      ],
    });
    expect(dupOptions.slice(0, 2)).toEqual([
      ['v-aaaa', '贾维斯 · aaaa（复刻音色）'],
      ['v-bbbb', '贾维斯 · bbbb（复刻音色）'],
    ]);
    expect(removeCustomRealtimeVoice(customVoice.customVoices, 'qwen-omni-vc-jarvis-001')).toEqual([]);
    customVoice.realtimeModel = 'qwen3.8-omni-flash-realtime';
    expect(normalizeRealtimeSettings(customVoice)).toBe(true);
    expect(customVoice.realtimeVoice).toBe('Tina');
    expect(DEFAULT_JARVIS_SAMPLE_URL).toContain('FuturePresentLabs/tts-jarvis');

    expect(resolveSummonVoiceBackend({ voice: { summonVoice: false, realtimeHasKey: true } })).toBe('off');
    expect(resolveSummonVoiceBackend({ voice: { summonVoice: true, realtimeMode: 'auto', realtimeHasKey: false } })).toBe('dsh-native');
    expect(resolveSummonVoiceBackend({ voice: { summonVoice: true, realtimeMode: 'auto', realtimeHasKey: true } })).toBe('qwen-realtime');
    expect(resolveSummonVoiceBackend({ voice: { summonVoice: true, realtimeMode: 'qwen-realtime', realtimeHasKey: false } })).toBe('qwen-realtime');
    expect(resolveSummonVoiceBackend({ voice: { summonVoice: true, realtimeMode: 'dsh-native', realtimeHasKey: true } })).toBe('dsh-native');

    expect(extractDshBridgeDirective('好的，我这就记下来。\n[[dsh: 在 MEMORY.md 记录用户喜欢黑咖啡]]')).toEqual({
      cleanText: '好的，我这就记下来。',
      dshTask: '在 MEMORY.md 记录用户喜欢黑咖啡',
    });
    expect(extractDshBridgeDirective('普通回答文本')).toEqual({
      cleanText: '普通回答文本',
      dshTask: null,
    });

    expect(normalizeSpokenBrand('KBOT 帮你整理好 ~/KBOT 里的 K-B-O-T 笔记')).toBe(
      'Kbot 帮你整理好 ~/KBOT 里的 Kbot 笔记',
    );

    const inst = buildRealtimeInstructions({ nickname: '先生', personaHint: '沉稳', desktopSummary: '晴 22°C' });
    expect(inst).toContain('先生');
    expect(inst).toContain('ask_dsh');
    expect(inst).toContain('kay-bot');
    expect(inst).toContain('严禁在打招呼或闲聊时主动报天气');
    expect(inst).not.toContain('你是 KBOT');
  });

  it('manages realtime voice events, audio levels, muting and tool outputs', async () => {
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const emitted: Array<{ name: string; payload: unknown }> = [];
    let listener: ((event: { payload: any }) => void) | null = null;
    const A: any = {
      S: { voice: { realtimeBase: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', realtimeModel: 'qwen-omni-turbo-realtime', realtimeVoice: 'Cherry' } },
      emit: (name: string, payload: unknown) => emitted.push({ name, payload }),
    };
    const run: CommandFn = async (name, args) => {
      calls.push({ name, args });
      if (name === 'voice_realtime_start') return 7 as any;
      return undefined as any;
    };
    const listenFn = async (event: string, cb: (e: { payload: any }) => void) => {
      expect(event).toBe('voice-realtime');
      listener = cb;
      return () => { listener = null; };
    };
    installVoice(A, run, true, listenFn as any);

    const deltas: string[] = [];
    const levels: number[] = [];
    const tools: Array<{ callId: string; name: string; arguments: string }> = [];
    let ended = false;

    await A.voice.startRealtime({
      instructions: 'test instructions',
      onLevel: (lvl: number) => levels.push(lvl),
      onAssistantDelta: (d: string) => deltas.push(d),
      onToolCall: (tc: { callId: string; name: string; arguments: string }) => tools.push(tc),
      onEnd: () => { ended = true; },
    });
    expect(A.voice.realtimeActive).toBe(true);
    expect(calls.find(c => c.name === 'voice_realtime_start')).toEqual({
      name: 'voice_realtime_start',
      args: {
        config: {
          base: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          model: 'qwen3.5-omni-flash-realtime',
          voice: 'Tina',
          instructions: 'test instructions',
        },
      },
    });

    // Stale event from a previous session id is ignored.
    listener!({ payload: { sid: 6, phase: 'ended' } });
    expect(ended).toBe(false);
    expect(A.voice.realtimeActive).toBe(true);

    listener!({ payload: { sid: 7, phase: 'level', level: 0.72 } });
    listener!({ payload: { sid: 7, phase: 'speaking' } });
    expect(A.voice.realtimeSpeaking).toBe(true);
    listener!({ payload: { sid: 7, phase: 'assistant_delta', delta: '收到' } });
    listener!({ payload: { sid: 7, phase: 'tool_call', callId: 'call_1', name: 'ask_dsh', arguments: '{"task":"查日记"}' } });
    expect(levels).toEqual([0.72]);
    expect(deltas).toEqual(['收到']);
    expect(tools).toEqual([{ callId: 'call_1', name: 'ask_dsh', arguments: '{"task":"查日记"}' }]);

    await A.voice.setRealtimeMuted(true);
    expect(A.voice.realtimeMuted).toBe(true);
    await A.voice.setRealtimeBridging(true);
    expect(A.voice.realtimeBridging).toBe(true);
    expect(calls.some(c => c.name === 'voice_realtime_set_bridging' && c.args?.bridging === true)).toBe(true);
    await A.voice.sendRealtimeText('你好');
    await A.voice.sendRealtimeToolOutput('call_1', '完成');
    expect(A.voice.realtimeBridging).toBe(false);
    await A.voice.stop();
    expect(calls.some(c => c.name === 'voice_realtime_interrupt')).toBe(true);
    expect(A.voice.realtimeSpeaking).toBe(false);
    expect(emitted.some(e => e.name === 'realtime:stopped')).toBe(true);

    listener!({ payload: { sid: 7, phase: 'ended' } });
    expect(ended).toBe(true);
    expect(A.voice.realtimeActive).toBe(false);
  });
});
