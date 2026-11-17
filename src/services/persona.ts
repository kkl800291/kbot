export const PERSONAS = ['cute', 'gentle', 'lively', 'quiet'] as const;
export type Persona = (typeof PERSONAS)[number];

// 早期版本的性格键，读到时并入对应的新性格
const LEGACY_PERSONAS: Record<string, Persona> = { calm: 'cute', witty: 'lively', warm: 'gentle' };

const HINTS: Record<Persona, string> = {
  cute: '从容：自然平实、条理清晰，偶尔带点冷幽默，不刻意客套',
  gentle: '温和：语气柔和、照顾节奏，表达体贴但不腻味',
  lively: '机敏：反应快、说话利落，偶尔有一点轻快冷幽默',
  quiet: '简洁：直说重点，尽量不寒暄',
};

const VOICE_STYLES: Record<Persona, string> = {
  cute: '自然沉稳的桌面搭档口吻，吐字清晰，不端腔；英文名 Kbot 连读作一个词，不要逐字母拼读。',
  gentle: '温和亲近的搭档口吻，声音轻柔，节奏舒缓；英文名 Kbot 连读作一个词，不要逐字母拼读。',
  lively: '机敏利落的搭档口吻，语调轻快自然；英文名 Kbot 连读作一个词，不要逐字母拼读。',
  quiet: '干净克制的搭档口吻，直入重点，不拖音；英文名 Kbot 连读作一个词，不要逐字母拼读。',
};

export function normalizePersona(key: unknown): Persona {
  const k = String(key || '');
  if ((PERSONAS as readonly string[]).includes(k)) return k as Persona;
  return LEGACY_PERSONAS[k] || 'cute';
}

export const personaHint = (key: unknown): string => HINTS[normalizePersona(key)];
export const personaVoiceStyle = (key: unknown): string => VOICE_STYLES[normalizePersona(key)];

/** 设置里填的称呼；没填或填的是“你”“您”时返回空串，由桌面搭档默认平实称呼。 */
export function addressName(nickname: unknown): string {
  const n = String(nickname || '').trim();
  return n === '你' || n === '您' ? '' : n;
}
