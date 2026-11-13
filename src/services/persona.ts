export const PERSONAS = ['cute', 'gentle', 'lively', 'quiet'] as const;
export type Persona = (typeof PERSONAS)[number];

// 早期版本的性格键，读到时并入对应的新性格
const LEGACY_PERSONAS: Record<string, Persona> = { calm: 'cute', witty: 'lively', warm: 'gentle' };

const HINTS: Record<Persona, string> = {
  cute: '从容：沉稳得体、条理清晰，偶尔一点冷幽默',
  gentle: '温和：体贴周到，语气更柔，留意对方是否疲惫',
  lively: '机敏：反应快、言简意赅，冷幽默多一点',
  quiet: '简洁：只说必要的话，不寒暄',
};

const VOICE_STYLES: Record<Persona, string> = {
  cute: '沉稳得体的管家语气，吐字清晰，节奏从容。',
  gentle: '体贴周到的管家语气，声音放柔，节奏舒缓。',
  lively: '机敏利落的管家语气，语调轻快，带一点冷幽默。',
  quiet: '简洁克制的管家语气，干净利落，不拖音。',
};

export function normalizePersona(key: unknown): Persona {
  const k = String(key || '');
  if ((PERSONAS as readonly string[]).includes(k)) return k as Persona;
  return LEGACY_PERSONAS[k] || 'cute';
}

export const personaHint = (key: unknown): string => HINTS[normalizePersona(key)];
export const personaVoiceStyle = (key: unknown): string => VOICE_STYLES[normalizePersona(key)];

/** 设置里填的称呼；没填或填的是“你”“您”时返回空串，由管家默认称“您”。 */
export function addressName(nickname: unknown): string {
  const n = String(nickname || '').trim();
  return n === '你' || n === '您' ? '' : n;
}
