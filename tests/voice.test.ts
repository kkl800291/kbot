import { describe, expect, it } from 'vitest';
import { DICTATION_NOTE, dictationStatus, speechRequest, speak, stopSpeech } from '../src/services/voice';
import type { CommandFn } from '../src/services/tools';

describe('system voice', () => {
  it('passes the bubble text through unchanged and not as a shell string', async () => {
    const bubble = '他说"$HOME" && rm\n第二行';
    const request = speechRequest(bubble, { voice: 'Tingting', rate: 180 });
    expect(request.args.text).toBe(bubble);
    expect(JSON.stringify(request)).not.toContain('sh -c');
    expect(request.command).toBe('voice_speak');
    const calls: Array<{ name: string; args?: Record<string, unknown> }> = [];
    const run: CommandFn = async (name, args) => { calls.push({ name, args }); };
    const spoken = await speak(bubble, { voice: 'Tingting', rate: 180 }, run);
    expect(spoken.args.text).toBe(bubble);
    await stopSpeech(run);
    expect(calls[0]).toEqual({ name: 'voice_speak', args: { text: bubble, voice: 'Tingting', rate: 180 } });
    expect(calls[1].name).toBe('voice_stop');
  });

  it('reports dictation permission without sending audio', async () => {
    const run: CommandFn = async name => {
      expect(name).toBe('voice_permission_status');
      return { implemented: false, microphone: 'denied', speechRecognition: 'not_determined', message: DICTATION_NOTE };
    };
    const status = await dictationStatus(run);
    expect(status.implemented).toBe(false);
    expect(status.microphone).toBe('denied');
    expect(status.message).toContain('不会把声音发给模型');
  });
});
