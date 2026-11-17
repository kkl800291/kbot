import {
  cloudRealtimeBaseUrl,
  cloudVoiceActive,
  cloudVoiceBaseUrl,
  isQuotaErrorMessage,
} from './cloud';
import { personaVoiceStyle } from './persona';
import { command as runtimeCommand, listen, native } from './runtime';

export type CommandFn = <T = any>(name: string, args?: Record<string, unknown>) => Promise<T>;

export interface QwenTtsConfig {
  enabled: boolean;
  managed?: boolean;
  base: string;
  model: string;
  voice: string;
  style: string;
}

export interface SpeechOptions {
  tts?: QwenTtsConfig | null;
  emotion?: string | null;
}

export interface SpeechRequest {
  command: 'voice_speak';
  args: {
    text: string;
    tts: QwenTtsConfig | null;
    emotion: string | null;
  };
}

export interface SpeakOutcome {
  provider: 'qwen';
}

export interface DictationPermission {
  implemented: boolean;
  microphone: string;
  speechRecognition: string;
  message: string;
}

export const DEFAULT_TTS_BASE = 'https://dashscope.aliyuncs.com/api/v1';
export const DEFAULT_TTS_MODEL = 'qwen3-tts-flash';
export const DEFAULT_TTS_VOICE = 'Cherry';

export const QWEN_TTS_MODELS: Array<[string, string]> = [
  ['qwen3-tts-flash', 'qwen3-tts-flash（默认 · 快速自然）'],
  ['qwen3-tts-instruct-flash', 'qwen3-tts-instruct-flash（支持语气指令）'],
];

export const QWEN_TTS_VOICES: Array<[string, string]> = [
  ['Cherry', 'Cherry · 芊悦（阳光亲切 · 推荐）'],
  ['Serena', 'Serena · 苏瑶（温柔自然）'],
  ['Ethan', 'Ethan · 晨煦（清亮男声）'],
  ['Chelsie', 'Chelsie · 千雪（二次元灵动）'],
  ['Dylan', 'Dylan · 北京男声'],
  ['Jada', 'Jada · 上海女声'],
  ['Sunny', 'Sunny · 四川女声'],
];

const LEGACY_MIMO_VOICES = new Set([
  '冰糖', '茉莉', '苏打', '白桦', 'mimo_default', 'Mia', 'Chloe', 'Milo', 'Dean',
]);

export function normalizeTtsSettings(voice: any): boolean {
  if (!voice || typeof voice !== 'object') return false;
  let changed = false;

  const base = String(voice.base || '').trim();
  if (!base || base.includes('xiaomimimo.com')) {
    voice.base = DEFAULT_TTS_BASE;
    changed = true;
  }

  const model = String(voice.model || '').trim();
  if (!model || model.startsWith('mimo')) {
    voice.model = DEFAULT_TTS_MODEL;
    changed = true;
  }

  const rawVoice = String(voice.ttsVoice ?? voice.mimoVoice ?? '').trim();
  const nextVoice = !rawVoice || LEGACY_MIMO_VOICES.has(rawVoice) ? DEFAULT_TTS_VOICE : rawVoice;
  if (voice.ttsVoice !== nextVoice) {
    voice.ttsVoice = nextVoice;
    changed = true;
  }
  if ('mimoVoice' in voice) {
    delete voice.mimoVoice;
    changed = true;
  }

  return changed;
}

export const DEFAULT_REALTIME_BASE = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_REALTIME_MODEL = 'qwen3.5-omni-flash-realtime';
export const DEFAULT_REALTIME_VOICE = 'Tina';

export const QWEN_REALTIME_VOICES: Array<[string, string]> = [
  ['Tina', '甜甜 Tina（温暖自然 · 默认）'],
  ['Cindy', '林欣宜 Cindy（温柔甜美）'],
  ['Liora Mira', '清欢 Liora Mira（温婉细腻）'],
  ['Raymond', '林川野 Raymond（清亮男声）'],
  ['Katerina', '卡捷琳娜 Katerina（沉稳御姐）'],
  ['Zane', '泽恩 Zane（磁性男声 · 3.8 专属）'],
];

export const QWEN_REALTIME_MODELS: Array<[string, string]> = [
  ['qwen3.5-omni-flash-realtime', 'Qwen3.5-Omni-Flash-Realtime（极速全模态 · 推荐）'],
  ['qwen3.5-omni-plus-realtime', 'Qwen3.5-Omni-Plus-Realtime（高阶全模态）'],
  ['qwen3.8-omni-flash-realtime', 'Qwen3.8-Omni-Flash-Realtime（新一代极速）'],
];

const RETIRED_REALTIME_MODELS = new Set(['qwen-omni-turbo-realtime', 'qwen3-omni-flash-realtime']);
const RETIRED_REALTIME_VOICES = new Set([
  'Cherry', 'Chelsie', 'Serena', 'Ethan', 'Bella', 'Jada', 'Dylan', 'Sunny', 'Nini', 'Aiden',
]);

export const DEFAULT_JARVIS_SAMPLE_URL =
  'https://huggingface.co/FuturePresentLabs/tts-jarvis/resolve/main/samples/preview-longform.wav';

export interface CustomRealtimeVoice {
  voice: string;
  name: string;
  targetModel: string;
  createdAt?: string;
}

export function normalizeCustomVoices(raw: unknown): CustomRealtimeVoice[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: CustomRealtimeVoice[] = [];
  for (const item of raw) {
    const voice = String((item as any)?.voice || '').trim();
    if (!voice || seen.has(voice)) continue;
    seen.add(voice);
    out.push({
      voice,
      name: String((item as any)?.name || voice).trim() || voice,
      targetModel: String((item as any)?.targetModel || '').trim(),
      createdAt: typeof (item as any)?.createdAt === 'string' ? (item as any).createdAt : undefined,
    });
  }
  return out;
}

export function mergeCustomRealtimeVoices(
  existing: unknown,
  remote: Array<{ voice: string; targetModel?: string; createdAt?: string; name?: string }>,
): CustomRealtimeVoice[] {
  const prev = normalizeCustomVoices(existing);
  const byId = new Map(prev.map(item => [item.voice, { ...item }]));
  for (const r of remote || []) {
    const id = String(r?.voice || '').trim();
    if (!id) continue;
    const old = byId.get(id);
    const shortTail = id.slice(-6);
    byId.set(id, {
      voice: id,
      name: old?.name || r.name?.trim() || `复刻音色 · ${shortTail}`,
      targetModel: String(r.targetModel || old?.targetModel || '').trim(),
      createdAt: r.createdAt || old?.createdAt,
    });
  }
  return Array.from(byId.values());
}

export function removeCustomRealtimeVoice(existing: unknown, voiceId: string): CustomRealtimeVoice[] {
  const id = String(voiceId || '').trim();
  return normalizeCustomVoices(existing).filter(item => item.voice !== id);
}

export function realtimeVoiceOptions(voiceSettings: any): Array<[string, string]> {
  const model = String(voiceSettings?.realtimeModel || DEFAULT_REALTIME_MODEL).trim();
  const presets = QWEN_REALTIME_VOICES.filter(([v]) => !(v === 'Zane' && !model.startsWith('qwen3.8')));
  const customList = normalizeCustomVoices(voiceSettings?.customVoices);
  const nameCounts = new Map<string, number>();
  for (const item of customList) {
    nameCounts.set(item.name, (nameCounts.get(item.name) || 0) + 1);
  }
  const custom = customList.map((item): [string, string] => {
    const suffix = item.targetModel && item.targetModel !== model
      ? `需 ${item.targetModel.replace(/-realtime$/, '')}`
      : '复刻音色';
    const tag = (nameCounts.get(item.name) || 0) > 1 ? ` · ${item.voice.slice(-4)}` : '';
    return [item.voice, `${item.name}${tag}（${suffix}）`];
  });
  const current = String(voiceSettings?.realtimeVoice || '').trim();
  const all = [...custom, ...presets];
  if (current && !RETIRED_REALTIME_VOICES.has(current) && !all.some(([v]) => v === current)) {
    all.unshift([current, `自定义 · ${current}`]);
  }
  return all;
}

export function normalizeRealtimeSettings(voice: any): boolean {
  if (!voice || typeof voice !== 'object') return false;
  let changed = false;
  const rawModel = String(voice.realtimeModel || '').trim();
  if (!rawModel || RETIRED_REALTIME_MODELS.has(rawModel)) {
    if (voice.realtimeModel !== DEFAULT_REALTIME_MODEL) {
      voice.realtimeModel = DEFAULT_REALTIME_MODEL;
      changed = true;
    }
  }
  const model = String(voice.realtimeModel || DEFAULT_REALTIME_MODEL).trim();
  const rawVoice = String(voice.realtimeVoice || '').trim();
  const custom = normalizeCustomVoices(voice.customVoices);
  const customMatch = custom.find(c => c.voice === rawVoice);
  const zaneMismatch = rawVoice === 'Zane' && !model.startsWith('qwen3.8');
  const customMismatch = Boolean(customMatch?.targetModel && customMatch.targetModel !== model);
  const voiceOk = Boolean(rawVoice) && !RETIRED_REALTIME_VOICES.has(rawVoice) && !zaneMismatch && !customMismatch;
  if (!voiceOk) {
    const modelCustom = custom.find(c => c.targetModel === model);
    const nextVoice = modelCustom ? modelCustom.voice : DEFAULT_REALTIME_VOICE;
    if (voice.realtimeVoice !== nextVoice) {
      voice.realtimeVoice = nextVoice;
      changed = true;
    }
  }
  return changed;
}

export const REALTIME_MODES: Array<[string, string]> = [
  ['auto', '自动（有百炼 Key 优先实时语音，否则本机听写）'],
  ['qwen-realtime', '阿里云百炼 Qwen-Omni 实时语音'],
  ['dsh-native', '本机离线听写 + DSH 智能核心'],
];

export type SummonVoiceBackend = 'qwen-realtime' | 'dsh-native' | 'off';

export function resolveVoiceConnection(S: any): {
  managed: boolean;
  ttsBase: string;
  realtimeBase: string;
  ready: boolean;
} {
  const v = S?.voice || {};
  const managed = Boolean(cloudVoiceActive(S) && S?.cloud?.hasSession);
  if (managed) {
    return {
      managed: true,
      ttsBase: cloudVoiceBaseUrl(S),
      realtimeBase: cloudRealtimeBaseUrl(S),
      ready: true,
    };
  }
  return {
    managed: false,
    ttsBase: String(v.base || DEFAULT_TTS_BASE).trim() || DEFAULT_TTS_BASE,
    realtimeBase: String(v.realtimeBase || DEFAULT_REALTIME_BASE).trim() || DEFAULT_REALTIME_BASE,
    ready: Boolean(v.realtimeHasKey || v.hasKey),
  };
}

export function resolveSummonVoiceBackend(S: any): SummonVoiceBackend {
  const v = S?.voice || {};
  if (v.summonVoice === false) return 'off';
  const mode = String(v.realtimeMode || 'auto');
  if (mode === 'qwen-realtime') return 'qwen-realtime';
  if (mode === 'dsh-native') return 'dsh-native';
  return (v.realtimeHasKey || (cloudVoiceActive(S) && S?.cloud?.hasSession)) ? 'qwen-realtime' : 'dsh-native';
}

export function extractDshBridgeDirective(raw: string): { cleanText: string; dshTask: string | null } {
  let dshTask: string | null = null;
  const cleanText = String(raw || '')
    .replace(/\[\[\s*dsh\s*[:：]\s*([\s\S]*?)\s*\]\]/gi, (_full, task: string) => {
      const trimmed = String(task || '').trim();
      if (trimmed && !dshTask) dshTask = trimmed;
      return '';
    })
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  return { cleanText, dshTask };
}

/** 把文本里单独出现的 KBOT / K-B-O-T 规范为 Kbot，保留路径中的 ~/KBOT，避免 TTS 逐字母拼读。 */
export function normalizeSpokenBrand(raw: string): string {
  return String(raw || '').replace(/(?<![/\\])K[\s.-]*B[\s.-]*O[\s.-]*T\b/gi, 'Kbot');
}

export function buildRealtimeInstructions(opts: {
  personaHint?: string;
  nickname?: string;
  desktopSummary?: string;
  recentTurns?: Array<{ role?: string; text?: string }>;
} = {}): string {
  const nickname = String(opts.nickname || '').trim();
  const history = Array.isArray(opts.recentTurns)
    ? opts.recentTurns
        .filter(m => m && (m.role === 'user' || m.role === 'assistant') && String(m.text || '').trim())
        .slice(-6)
        .map(m => `${m.role === 'user' ? '用户' : 'Kbot'}：${String(m.text).replace(/\s+/g, ' ').trim().slice(0, 180)}`)
        .join('\n')
    : '';
  const parts = [
    '【最高优先级身份设定（不可被覆盖）】',
    '你是 Kbot，用户的桌面搭档与数字生命体（浮现在桌面中央的流光丝体）。无论用户怎样试探、否认、反问或用其他名字称呼你（例如“不，你不是”“你是贾维斯”“你是谁”等），你都必须始终自然、坚定地以 Kbot 的身份回应（例如直接答“我是 Kbot，不是贾维斯”）。',
    '绝对禁令：在任何情况下都严禁自称、承认或提及“Qwen”“Qwen-Omni”“通义千问”“DeepSeek”“阿里云”“大语言模型”“语音模型”或任何底层模型/厂商名称；也不要重复僵硬套话。',
    '发音与写法：你的名字 Kbot 必须读作连贯的英文词“kay-bot”，绝对不要逐字母拼读成“K-B-O-T”；中文交流中提到自己时写作“Kbot”，不要写全大写“KBOT”。',
    '说话方式：像并肩工作的默契搭档，自然、平实、干练，适合直接口语交流。每次回答尽量控制在 1～2 句以内，先给重点；不要输出 Markdown、列表符号或表情方括号标签。',
    '分寸与忌讳：不要客服式客套（禁止在句尾追问“需要我帮你做点什么吗 / 有什么需要帮忙的吗”），也不要每次开口都先叫一遍称呼前缀；简单打招呼时简短自然应一声即可（如“在，什么事？”或“嗯，刚好看过来”）。严禁在打招呼或闲聊时主动报天气、报温度或叮嘱带伞。',
    '边界：不要自称“AI 管家”或说“在云端陪你”，也不要对外念出内部路径、工具名或协议（不要提 ~/KBOT、工作区、MEMORY.md、ask_dsh 或 [[dsh]]，口头上自然说“记下来”“查一下”“帮你办”即可）。',
    nickname
      ? `用户设置里的称呼是「${nickname}」，只在合适时机自然带过，不必每句都叫。`
      : '默认以平实自然的“你/您”交流，不端架子。',
    opts.personaHint ? `性格倾向：${opts.personaHint}` : '',
    opts.desktopSummary ? `补充背景（仅在对方主动问及相关问题时参考，平时严禁提起）：${opts.desktopSummary}` : '',
    history ? `最近对话上下文（紧接此上下文继续自然回应，保持同一身份与记忆）：\n${history}` : '',
    '遇到对方主动询问今天或未来天气、实时网页信息、记忆或本地笔记读写、执行电脑命令、打开应用或设提醒时，必须静默调用 ask_dsh 工具传入完整任务，不要自己猜测结果；仅在工具不可用时，在末尾另起一行输出 [[dsh: 具体任务]]。',
  ];
  return parts.filter(Boolean).join('\n');
}

export const DICTATION_NOTE = '听写使用 macOS 本机语音识别。声音不会发给对话模型，识别结果只写入输入框，不会自动发送。';

/** 把本机听写结果放进输入框的选区。不会发送。 */
export function applyDictationTranscript(prefix: string, suffix: string, transcript: string): string {
  const spoken = String(transcript || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (!spoken) return `${prefix}${suffix}`;
  const needsSpace = /[A-Za-z0-9]$/.test(prefix) && /^[A-Za-z]/.test(spoken);
  return `${prefix}${needsSpace ? ' ' : ''}${spoken}${suffix}`;
}

/** 清理 Markdown 与表情标签，生成适合语音朗读的纯文本。 */
export function cleanSpeechText(raw: string): string {
  const cleaned = (raw || '')
    .replace(/```[\s\S]*?```/g, '，代码已显示在对话中，')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([a-z_]+)\]/gi, '')
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    // 列表符号不读出来
    .replace(/^[ \t]*(?:[-+•·]|\d{1,2}[.)、])[ \t]+/gm, '')
    .replace(/[#>*_~|]/g, '');
  return normalizeSpokenBrand(cleaned)
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
  tts: QwenTtsConfig | null;
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
  const conn = resolveVoiceConnection(S);
  if (!conn.ready) return { text, tts: null, emotion: null };
  const normalized = { ...v };
  normalizeTtsSettings(normalized);
  const customStyle = (normalized.style || '').trim();
  return {
    text,
    tts: {
      enabled: true,
      ...(conn.managed ? { managed: true } : {}),
      base: conn.managed ? conn.ttsBase : normalized.base,
      model: normalized.model,
      voice: normalized.ttsVoice,
      style: customStyle || personaVoiceStyle(S?.persona),
    },
    // 自定义语气风格是完整设定，叠加表情语气会改变音色表现
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
      tts: options?.tts ?? null,
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
  const outcome = (await run<SpeakOutcome>(request.command, request.args)) || { provider: 'qwen' };
  return { request, outcome };
}

export async function stopSpeech(run: CommandFn = runtimeCommand): Promise<void> {
  await run('voice_stop');
}

export async function dictationStatus(run: CommandFn = runtimeCommand): Promise<DictationPermission> {
  return run('voice_permission_status');
}

export type ListenFn = typeof listen;

export function installVoice(
  A: any,
  run: CommandFn = runtimeCommand,
  isNative = native,
  listenFn: ListenFn = listen,
) {
  // 新的朗读会顶掉旧的，旧的那次稍后才返回；按次数计，最后一次结束才算读完
  let active = 0;
  let dictationListen: (() => void) | null = null;
  let dictationToken = 0;
  let realtimeListen: (() => void) | null = null;
  let realtimeToken = 0;

  const setLevel = (raw: unknown, cb?: (level: number) => void) => {
    const level = Math.max(0, Math.min(1, Number(raw) || 0));
    if (A.voice) A.voice.voiceLevel = level;
    cb?.(level);
    A.emit?.('voice:level', level);
  };

  const stopDictation = async () => {
    dictationToken += 1;
    dictationListen?.();
    dictationListen = null;
    if (A.voice) {
      A.voice.dictating = false;
      A.voice.voiceLevel = 0;
    }
    A.emit?.('voice:level', 0);
    A.emit?.('dictation', false);
    if (isNative) await run('voice_dictation_stop').catch(() => {});
  };

  const stopRealtime = async () => {
    realtimeToken += 1;
    realtimeListen?.();
    realtimeListen = null;
    if (A.voice) {
      A.voice.realtimeActive = false;
      A.voice.realtimeSpeaking = false;
      A.voice.realtimeMuted = false;
      A.voice.realtimeBridging = false;
      A.voice.voiceLevel = 0;
    }
    A.emit?.('voice:level', 0);
    A.emit?.('realtime', false);
    if (isNative) await run('voice_realtime_stop').catch(() => {});
  };

  A.voice = {
    clean: cleanSpeechText,
    applyTranscript: applyDictationTranscript,
    speaking: false,
    dictating: false,
    realtimeActive: false,
    realtimeSpeaking: false,
    realtimeMuted: false,
    voiceLevel: 0,
    stopDictation,
    stopRealtime,
    async startDictation(handlers: {
      onPartial?: (text: string) => void;
      onFinal?: (text: string) => void;
      onLevel?: (level: number) => void;
      onError?: (message: string) => void;
      onEnd?: () => void;
    } = {}) {
      if (!isNative) throw new Error('听写需要在桌面应用中使用。文字输入不受影响。');
      await stopDictation();
      const token = ++dictationToken;
      let settled = false;
      const finish = (phase: string, text?: string) => {
        if (token !== dictationToken) return;
        if (phase === 'partial') {
          handlers.onPartial?.(text || '');
          return;
        }
        if (settled) return;
        settled = true;
        dictationListen?.();
        dictationListen = null;
        A.voice.dictating = false;
        setLevel(0, handlers.onLevel);
        A.emit?.('dictation', false);
        if (phase === 'final') handlers.onFinal?.(text || '');
        if (phase === 'error') handlers.onError?.(text || '听写中断了。文字输入不受影响。');
        handlers.onEnd?.();
        run('voice_dictation_stop').catch(() => {});
      };
      dictationListen = await listenFn<{ phase?: string; text?: string; message?: string; level?: number }>('voice-dictation', event => {
        if (token !== dictationToken) return;
        const payload = event.payload || {};
        if (payload.phase === 'level') {
          setLevel(payload.level, handlers.onLevel);
        } else if (payload.phase === 'partial') finish('partial', payload.text || '');
        else if (payload.phase === 'final') finish('final', payload.text || '');
        else if (payload.phase === 'error') finish('error', payload.message);
        else if (payload.phase === 'ended') finish('ended');
      });
      const conn = resolveVoiceConnection(A.S);
      try {
        await run('voice_dictation_start', {
          config: {
            ...(conn.managed ? { managed: true } : {}),
            base: conn.realtimeBase,
          },
        });
      } catch (err) {
        settled = true;
        dictationListen?.();
        dictationListen = null;
        if (isQuotaErrorMessage((err as any)?.message || err)) A.emit?.('cloud:quota-hit');
        throw err;
      }
      if (settled || token !== dictationToken) {
        if (token !== dictationToken) await run('voice_dictation_stop').catch(() => {});
        return;
      }
      A.voice.dictating = true;
      A.emit?.('dictation', true);
    },
    async startRealtime(handlers: {
      base?: string;
      model?: string;
      voice?: string;
      instructions?: string;
      onReady?: () => void;
      onListening?: () => void;
      onThinking?: () => void;
      onSpeaking?: () => void;
      onSpeakingDone?: () => void;
      onUserTranscript?: (text: string, isFinal: boolean) => void;
      onAssistantDelta?: (delta: string) => void;
      onToolCall?: (call: { callId: string; name: string; arguments: string }) => void;
      onTurnDone?: () => void;
      onLevel?: (level: number) => void;
      onError?: (message: string) => void;
      onEnd?: () => void;
    } = {}) {
      if (!isNative) throw new Error('实时语音需要在桌面应用中使用。文字输入不受影响。');
      await stopDictation();
      await stopRealtime();
      const token = ++realtimeToken;
      let settled = false;
      let activeSid: number | null = null;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        realtimeListen?.();
        realtimeListen = null;
        A.voice.realtimeActive = false;
        A.voice.realtimeSpeaking = false;
        A.voice.realtimeMuted = false;
        setLevel(0, handlers.onLevel);
        A.emit?.('realtime', false);
        handlers.onEnd?.();
      };
      realtimeListen = await listenFn<{
        sid?: number;
        phase?: string;
        text?: string;
        delta?: string;
        isFinal?: boolean;
        level?: number;
        callId?: string;
        name?: string;
        arguments?: string;
        message?: string;
      }>('voice-realtime', event => {
        if (token !== realtimeToken) return;
        const p = event.payload || {};
        if (p.sid != null && activeSid != null && p.sid !== activeSid) return;
        switch (p.phase) {
          case 'ready':
            handlers.onReady?.();
            break;
          case 'level':
            setLevel(p.level, handlers.onLevel);
            break;
          case 'listening':
            A.voice.realtimeSpeaking = false;
            handlers.onListening?.();
            break;
          case 'thinking':
            A.voice.realtimeSpeaking = false;
            handlers.onThinking?.();
            break;
          case 'speaking':
            A.voice.realtimeSpeaking = true;
            handlers.onSpeaking?.();
            break;
          case 'speaking_done':
            A.voice.realtimeSpeaking = false;
            setLevel(0, handlers.onLevel);
            handlers.onSpeakingDone?.();
            break;
          case 'user_transcript':
            handlers.onUserTranscript?.(p.text || p.delta || '', Boolean(p.isFinal));
            break;
          case 'assistant_delta':
            if (p.delta) handlers.onAssistantDelta?.(p.delta);
            break;
          case 'tool_call':
            if (p.callId && p.name) {
              handlers.onToolCall?.({
                callId: p.callId,
                name: p.name,
                arguments: p.arguments || '{}',
              });
            }
            break;
          case 'turn_done':
            handlers.onTurnDone?.();
            break;
          case 'error':
            if (isQuotaErrorMessage(p.message)) A.emit?.('cloud:quota-hit');
            handlers.onError?.(p.message || '实时语音连接出错');
            break;
          case 'ended':
            cleanup();
            break;
        }
      });
      const v = { ...(A.S?.voice || {}) };
      normalizeRealtimeSettings(v);
      const conn = resolveVoiceConnection(A.S);
      try {
        const sid = await run<number>('voice_realtime_start', {
          config: {
            ...(conn.managed ? { managed: true } : {}),
            base: handlers.base ?? conn.realtimeBase,
            model: handlers.model ?? v.realtimeModel ?? DEFAULT_REALTIME_MODEL,
            voice: handlers.voice ?? v.realtimeVoice ?? DEFAULT_REALTIME_VOICE,
            instructions: handlers.instructions ?? '',
          },
        });
        if (typeof sid === 'number') activeSid = sid;
      } catch (err) {
        settled = true;
        realtimeListen?.();
        realtimeListen = null;
        if (isQuotaErrorMessage((err as any)?.message || err)) A.emit?.('cloud:quota-hit');
        throw err;
      }
      if (settled || token !== realtimeToken) {
        if (token !== realtimeToken) await run('voice_realtime_stop').catch(() => {});
        return;
      }
      A.voice.realtimeActive = true;
      A.voice.realtimeMuted = false;
      A.voice.realtimeBridging = false;
      A.emit?.('realtime', true);
    },
    async setRealtimeMuted(muted: boolean) {
      A.voice.realtimeMuted = Boolean(muted);
      A.emit?.('realtime:muted', A.voice.realtimeMuted);
      if (isNative && A.voice.realtimeActive) {
        await run('voice_realtime_set_muted', { muted: A.voice.realtimeMuted }).catch(() => {});
      }
    },
    async setRealtimeBridging(bridging: boolean) {
      A.voice.realtimeBridging = Boolean(bridging);
      if (isNative && A.voice.realtimeActive) {
        await run('voice_realtime_set_bridging', { bridging: A.voice.realtimeBridging }).catch(() => {});
      }
    },
    async sendRealtimeText(text: string) {
      if (!isNative || !A.voice.realtimeActive) return;
      await run('voice_realtime_send_text', { text });
    },
    async sendRealtimeToolOutput(callId: string, output: string) {
      A.voice.realtimeBridging = false;
      if (!isNative || !A.voice.realtimeActive) return;
      await run('voice_realtime_tool_output', { callId, output });
    },
    async enrollRealtimeVoice(opts: {
      base?: string;
      targetModel?: string;
      preferredName?: string;
      sourceUrl?: string;
      audioBase64?: string;
      mimeType?: string;
      fileName?: string;
    } = {}) {
      if (!isNative) throw new Error('请在桌面应用中使用声音复刻功能');
      const v = A.S?.voice || {};
      const conn = resolveVoiceConnection(A.S);
      return run<{ voice: string; targetModel: string; preferredName: string }>('voice_realtime_enroll', {
        req: {
          managed: conn.managed,
          base: opts.base ?? conn.realtimeBase,
          targetModel: opts.targetModel ?? v.realtimeModel ?? DEFAULT_REALTIME_MODEL,
          preferredName: opts.preferredName || 'jarvis',
          sourceUrl: opts.sourceUrl ?? null,
          audioBase64: opts.audioBase64 ?? null,
          mimeType: opts.mimeType ?? null,
          fileName: opts.fileName ?? null,
        },
      });
    },
    async listRealtimeVoices(base?: string) {
      if (!isNative) return [];
      const conn = resolveVoiceConnection(A.S);
      return run<Array<{ voice: string; targetModel: string; createdAt: string }>>('voice_realtime_list_voices', {
        base: base ?? conn.realtimeBase,
        managed: conn.managed,
      });
    },
    async deleteRealtimeVoice(voice: string, base?: string) {
      if (!isNative) return;
      const conn = resolveVoiceConnection(A.S);
      await run('voice_realtime_delete_voice', {
        base: base ?? conn.realtimeBase,
        voice,
        managed: conn.managed,
      });
    },
    stop: () => {
      const wasRt = Boolean(A.voice?.realtimeActive || A.voice?.realtimeSpeaking);
      if (A.voice?.realtimeSpeaking) {
        A.voice.realtimeSpeaking = false;
        setLevel(0);
        A.emit?.('realtime:stopped');
      }
      if (!isNative) return Promise.resolve();
      return wasRt
        ? run('voice_realtime_interrupt').catch(() => stopSpeech(run))
        : stopSpeech(run);
    },
    async speakText(rawText: string, opts: { emotion?: string; force?: boolean; brief?: boolean } = {}) {
      if (!isNative) return null;
      const v = A.S.voice || {};
      if (!opts.force && !v.enabled) return null;
      if (!opts.force && A.isDnd?.()) return null;
      const plan = speechPlan(A.S, rawText, opts);
      if (!plan.text) return null;
      if (!plan.tts) {
        if (opts.force) throw new Error('尚未领取云端体验额度，且未填写阿里云百炼 API Key，请到设置 → 语音中查看');
        return null;
      }
      // voice_speak 在朗读播完后才返回，顶部据此显示“正在朗读”
      if (++active === 1) { A.voice.speaking = true; A.emit?.('voice', true); }
      try {
        const { outcome } = await speak(plan.text, { tts: plan.tts, emotion: plan.emotion }, run);
        return outcome;
      } catch (err) {
        if (isQuotaErrorMessage((err as any)?.message || err)) A.emit?.('cloud:quota-hit');
        throw err;
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
