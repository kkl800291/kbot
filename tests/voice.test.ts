import { describe, expect, it } from 'vitest';
import {
  cleanSpeechText,
  DICTATION_NOTE,
  MIMO_VOICEDESIGN_MODEL,
  MIMO_VOICE_DESIGNS,
  dictationStatus,
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
