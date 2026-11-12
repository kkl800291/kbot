import { command as runtimeCommand, native } from './runtime';

export type CommandFn = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;

export interface MimoVoiceConfig {
  enabled: boolean;
  base: string;
  model: string;
  voice: string;
  style: string;
}

export interface SpeechOptions {
  voice?: string;
  rate?: number;
  mimo?: MimoVoiceConfig | null;
  emotion?: string | null;
  strict?: boolean;
}

export interface SpeechRequest {
  command: 'voice_speak';
  args: {
    text: string;
    voice: string | null;
    rate: number | null;
    mimo: MimoVoiceConfig | null;
    emotion: string | null;
    strict: boolean;
  };
}

export interface SpeakOutcome {
  provider: 'mimo' | 'say';
  fallbackReason?: string | null;
}

export interface DictationPermission {
  implemented: boolean;
  microphone: string;
  speechRecognition: string;
  message: string;
}

export const MIMO_VOICES: Array<[string, string]> = [
  ['冰糖', '冰糖（甜美灵动 · 推荐）'],
  ['茉莉', '茉莉（温柔亲切）'],
  ['苏打', '苏打（清爽元气）'],
  ['白桦', '白桦（沉稳温和）'],
  ['mimo_default', 'MiMo 默认音色'],
  ['Mia', 'Mia（English · Bright）'],
  ['Chloe', 'Chloe（English · Warm）'],
  ['Milo', 'Milo（English · Lively）'],
  ['Dean', 'Dean（English · Calm）'],
];

export const MIMO_VOICEDESIGN_MODEL = 'mimo-v2.5-tts-voicedesign';
export const MIMO_VOICE_DESIGNS: Array<[string, string, string]> = [
  [
    'jarvis-inspired',
    '英式 AI 管家（JARVIS 气质）',
    'A calm, articulate middle-aged British male AI butler. Deep, warm, resonant baritone with exceptionally clear diction, measured pacing, precise pauses, restrained emotion, quiet confidence, and a subtle polished futuristic character. Sound like an original cinematic spacecraft assistant with discreet dry wit. Pronounce the assistant name Kbot as one natural name, "kay-bot", never spell out K-B-O-T. Never imitate a specific actor or an existing film character.',
  ],
];

export const DICTATION_NOTE = '听写还没有接入。当前只查询麦克风和语音识别权限，不会弹出系统授权框，也不会把声音发给模型。文字输入不受影响。';

const PERSONA_STYLES: Record<string, string> = {
  cute: '元气灵动、俏皮亲切的桌面小机器人语气，自然口语化，吐字清晰。',
  gentle: '温柔体贴、平静治愈的陪伴语气，节奏舒缓柔和。',
  lively: '阳光活力、精神饱满的伙伴语气，轻快明朗。',
  quiet: '克制简洁、安静温和的提示语气，干净利落。',
};

/** 清理 Markdown 与表情标签，生成适合语音朗读的纯文本。 */
export function cleanSpeechText(raw: string): string {
  return (raw || '')
    .replace(/```[\s\S]*?```/g, '，代码已显示在对话中，')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([a-z_]+)\]/gi, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/[#>*_~|]/g, '')
    .replace(/K[\s.-]*B[\s.-]*O[\s.-]*T/gi, 'Kbot')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

/** 文本放在参数字段里，不拼进 shell 命令。 */
export function speechRequest(text: string, options?: SpeechOptions): SpeechRequest {
  const cleaned = text?.trim() ? text : '';
  if (!cleaned || cleaned.trim().length === 0) throw new Error('没有可以朗读的文本');
  if (cleaned.includes('\0')) throw new Error('朗读文本无效');
  return {
    command: 'voice_speak',
    args: {
      text: cleaned,
      voice: options?.voice ?? null,
      rate: options?.rate ?? null,
      mimo: options?.mimo ?? null,
      emotion: options?.emotion ?? null,
      strict: !!options?.strict,
    },
  };
}

export async function speak(
  text: string,
  options?: SpeechOptions,
  run: CommandFn = runtimeCommand,
): Promise<{ request: SpeechRequest; outcome: SpeakOutcome }> {
  const request = speechRequest(text, options);
  const outcome = (await run<SpeakOutcome>(request.command, request.args)) || { provider: 'say' };
  return { request, outcome };
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

export function installVoice(A: any) {
  let fallbackNotified = false;
  const buildMimoConfig = (): MimoVoiceConfig | null => {
    const v = A.S.voice || {};
    if (v.provider !== 'mimo' || !v.hasKey) return null;
    const customStyle = (v.style || '').trim();
    return {
      enabled: true,
      base: v.base || 'https://api.xiaomimimo.com/v1',
      model: v.model || 'mimo-v2.5-tts',
      voice: v.mimoVoice || '冰糖',
      style: customStyle || PERSONA_STYLES[A.S.persona] || PERSONA_STYLES.cute,
    };
  };

  A.voice = {
    clean: cleanSpeechText,
    stop: () => (native ? stopSpeech() : Promise.resolve()),
    async speakText(rawText: string, opts: { emotion?: string; strict?: boolean; force?: boolean } = {}) {
      if (!native) return null;
      const v = A.S.voice || {};
      if (!opts.force && !v.enabled) return null;
      if (!opts.force && A.isDnd?.()) return null;
      const cleaned = cleanSpeechText(rawText);
      if (!cleaned) return null;
      const mimo = opts.strict && v.provider === 'mimo'
        ? {
            enabled: true,
            base: v.base || 'https://api.xiaomimimo.com/v1',
            model: v.model || 'mimo-v2.5-tts',
            voice: v.mimoVoice || '冰糖',
            style: (v.style || '').trim() || PERSONA_STYLES[A.S.persona] || PERSONA_STYLES.cute,
          }
        : buildMimoConfig();
      const { outcome } = await speak(cleaned, {
        voice: v.sayVoice || undefined,
        rate: v.rate || 190,
        mimo,
        emotion: opts.emotion || null,
        strict: !!opts.strict,
      });
      if (outcome.fallbackReason && !fallbackNotified && !opts.strict) {
        fallbackNotified = true;
        A.toast(`MiMo 语音暂不可用，已自动回退系统朗读（${outcome.fallbackReason}）`, 4200);
      }
      return outcome;
    },
  };

  A.on('set:voice', () => { fallbackNotified = false; });
}
