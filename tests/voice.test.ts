import { describe, expect, it } from 'vitest';
import {
  briefSpeechText,
  cleanSpeechText,
  DICTATION_NOTE,
  installVoice,
  MIMO_VOICEDESIGN_MODEL,
  MIMO_VOICE_DESIGNS,
  dictationStatus,
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
    expect(status.message).toContain('不会把声音发给模型');
  });
});
