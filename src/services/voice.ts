import { command as runtimeCommand } from './runtime';
import type { CommandFn } from './tools';

export interface SpeechRequest {
  command: 'voice_speak';
  args: { text: string; voice: string | null; rate: number | null };
}

export interface DictationPermission {
  implemented: boolean;
  microphone: string;
  speechRecognition: string;
  message: string;
}

export const DICTATION_NOTE = '听写还没有接入。当前只查询麦克风和语音识别权限，不会弹出系统授权框，也不会把声音发给模型。文字输入不受影响。';

/** 文本放在参数字段里，不拼进 shell 命令。 */
export function speechRequest(text: string, options?: { voice?: string; rate?: number }): SpeechRequest {
  if (!text || text.trim().length === 0) throw new Error('没有可以朗读的文本');
  if (text.includes('\0')) throw new Error('朗读文本无效');
  return {
    command: 'voice_speak',
    args: { text, voice: options?.voice ?? null, rate: options?.rate ?? null },
  };
}

export async function speak(text: string, options?: { voice?: string; rate?: number }, run: CommandFn = runtimeCommand): Promise<SpeechRequest> {
  const request = speechRequest(text, options);
  await run(request.command, request.args);
  return request;
}

export async function stopSpeech(run: CommandFn = runtimeCommand): Promise<void> {
  await run('voice_stop');
}

export async function listVoices(run: CommandFn = runtimeCommand): Promise<Array<{ name: string; locale: string; sample: string }>> {
  return run('voice_list');
}

export async function dictationStatus(run: CommandFn = runtimeCommand): Promise<DictationPermission> {
  return run('voice_permission_status');
}
