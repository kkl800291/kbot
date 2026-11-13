import { personaVoiceStyle } from './persona';
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
  mimo?: MimoVoiceConfig | null;
  emotion?: string | null;
}

export interface SpeechRequest {
  command: 'voice_speak';
  args: {
    text: string;
    mimo: MimoVoiceConfig | null;
    emotion: string | null;
  };
}

export interface SpeakOutcome {
  provider: 'mimo';
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

/** 清理 Markdown 与表情标签，生成适合语音朗读的纯文本。 */
export function cleanSpeechText(raw: string): string {
  return (raw || '')
    .replace(/```[\s\S]*?```/g, '，代码已显示在对话中，')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([a-z_]+)\]/gi, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    // 列表符号不读出来
    .replace(/^[ \t]*(?:[-+•·]|\d{1,2}[.)、])[ \t]+/gm, '')
    .replace(/[#>*_~|]/g, '')
    .replace(/K[\s.-]*B[\s.-]*O[\s.-]*T/gi, 'Kbot')
    // 换行就是一处停顿：行尾没有标点的补一个句号，否则标题、列表会和下一行连成一句
    .replace(/([^\s。！？!?；;…，,、：:.])[ \t]*\n+\s*(?=\S)/g, '$1。')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

const SENTENCE = /(?:[^。！？!?；;…\n.]|\.(?!\s|$))+(?:[。！？!?；;…\n]|\.(?=\s|$))*\s*/g;

/** 自动朗读只读开头的完整句子，总长不超过 max 字。 */
export function briefSpeechText(text: string, max = 200): string {
  let out = '';
  for (const sentence of text.match(SENTENCE) || []) {
    if (out && (out + sentence).trim().length > max) break;
    out += sentence;
  }
  out = out.trim();
  return out.length > max ? out.slice(0, max) : out;
}

export interface SpeechPlan {
  text: string;
  mimo: MimoVoiceConfig | null;
  emotion: string | null;
}

export function speechPlan(
  S: any,
  rawText: string,
  opts: { emotion?: string | null; brief?: boolean } = {},
): SpeechPlan {
  const v = S?.voice || {};
  const cleaned = cleanSpeechText(rawText);
  const text = opts.brief ? briefSpeechText(cleaned) : cleaned;
  if (!v.hasKey) return { text, mimo: null, emotion: null };
  const customStyle = (v.style || '').trim();
  return {
    text,
    mimo: {
      enabled: true,
      base: v.base || 'https://api.xiaomimimo.com/v1',
      model: v.model || 'mimo-v2.5-tts',
      voice: v.mimoVoice || '冰糖',
      style: customStyle || personaVoiceStyle(S?.persona),
    },
    // 自定义语气风格（如 AI 管家的音色描述）是完整设定，叠加表情语气会改变音色
    emotion: customStyle ? null : opts.emotion || null,
  };
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
      mimo: options?.mimo ?? null,
      emotion: options?.emotion ?? null,
    },
  };
}

export async function speak(
  text: string,
  options?: SpeechOptions,
  run: CommandFn = runtimeCommand,
): Promise<{ request: SpeechRequest; outcome: SpeakOutcome }> {
  const request = speechRequest(text, options);
  const outcome = (await run<SpeakOutcome>(request.command, request.args)) || { provider: 'mimo' };
  return { request, outcome };
}

export async function stopSpeech(run: CommandFn = runtimeCommand): Promise<void> {
  await run('voice_stop');
}

export async function dictationStatus(run: CommandFn = runtimeCommand): Promise<DictationPermission> {
  return run('voice_permission_status');
}

export function installVoice(A: any, run: CommandFn = runtimeCommand, isNative = native) {
  // 新的朗读会顶掉旧的，旧的那次稍后才返回；按次数计，最后一次结束才算读完
  let active = 0;
  A.voice = {
    clean: cleanSpeechText,
    speaking: false,
    stop: () => (isNative ? stopSpeech(run) : Promise.resolve()),
    async speakText(rawText: string, opts: { emotion?: string; force?: boolean; brief?: boolean } = {}) {
      if (!isNative) return null;
      const v = A.S.voice || {};
      if (!opts.force && !v.enabled) return null;
      if (!opts.force && A.isDnd?.()) return null;
      const plan = speechPlan(A.S, rawText, opts);
      if (!plan.text) return null;
      if (!plan.mimo) {
        if (opts.force) throw new Error('尚未配置 MiMo API Key，请到设置中保存');
        return null;
      }
      // voice_speak 在朗读播完后才返回，顶部据此显示“正在朗读”
      if (++active === 1) { A.voice.speaking = true; A.emit?.('voice', true); }
      try {
        const { outcome } = await speak(plan.text, { mimo: plan.mimo, emotion: plan.emotion }, run);
        return outcome;
      } finally {
        if (--active === 0) { A.voice.speaking = false; A.emit?.('voice', false); }
      }
    },
    async speakAuto(rawText: string, opts: { emotion?: string } = {}) {
      try {
        return await A.voice.speakText(rawText, { ...opts, brief: true });
      } catch (err: any) {
        A.toast?.(`朗读失败：${err?.message || err}`, 4000);
        return null;
      }
    },
  };
}
