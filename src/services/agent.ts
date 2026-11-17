import { addressName, personaHint } from './persona';
import { command, listen, native } from './runtime';

export const VALID_EXPRESSIONS = new Set([
  'happy',
  'surprised',
  'think',
  'confused',
  'sad',
  'sleepy',
  'remind',
  'annoyed',
]);

// 旧工作区的提示词里可能还有这两个标签：照样从文字里剥掉，按 happy 处理
const LEGACY_EXPRESSIONS: Record<string, string> = { wink: 'happy', coy: 'happy' };

export function normalizeExpression(tag: string): string | null {
  const lower = tag.toLowerCase();
  if (VALID_EXPRESSIONS.has(lower)) return lower;
  return LEGACY_EXPRESSIONS[lower] || null;
}

const CATEGORY_LABELS: Record<string, string> = {
  dev: '编程开发',
  office: '文档办公',
  meeting: '在线会议',
  video: '影音观看',
  game: '游戏娱乐',
  chat: '即时沟通',
  browser: '网页浏览',
};

export function extractExpressions(raw: string): { text: string; expressions: string[]; lastExpr: string | null } {
  if (!raw) return { text: '', expressions: [], lastExpr: null };
  const expressions: string[] = [];
  // Preserve fenced code blocks untouched while stripping inline [expr] tags outside code blocks.
  const parts = raw.split(/(```[\s\S]*?```)/g);
  const cleaned = parts
    .map((segment, idx) => {
      if (idx % 2 === 1) return segment;
      return segment.replace(/\[([a-z]{3,12})\](\s?)/gi, (full, tag: string) => {
        const expr = normalizeExpression(tag);
        if (!expr) return full;
        expressions.push(expr);
        return '';
      });
    })
    .join('');
  return {
    text: cleaned,
    expressions,
    lastExpr: expressions.length ? expressions[expressions.length - 1] : null,
  };
}

export function createExpressionStreamParser(onExpression?: (expr: string) => void) {
  let pending = '';
  let fenceTicks = 0;
  let inFence = false;

  const emitCleaned = (chunk: string): string => {
    let out = '';
    let i = 0;
    while (i < chunk.length) {
      const ch = chunk[i];
      if (ch === '`') {
        fenceTicks += 1;
        if (fenceTicks === 3) {
          inFence = !inFence;
          fenceTicks = 0;
        }
        out += ch;
        i += 1;
        continue;
      }
      fenceTicks = 0;

      if (!inFence && ch === '[') {
        const closeIdx = chunk.indexOf(']', i + 1);
        if (closeIdx === -1) {
          const tail = chunk.slice(i);
          if (tail.length <= 12 && /^\[[a-zA-Z]*$/.test(tail)) {
            pending = tail;
            break;
          }
          out += ch;
          i += 1;
          continue;
        }
        const expr = normalizeExpression(chunk.slice(i + 1, closeIdx));
        if (expr) {
          onExpression?.(expr);
          i = closeIdx + 1;
          if (chunk[i] === ' ' && (out === '' || out.endsWith('\n'))) {
            i += 1;
          }
          continue;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  };

  return {
    push(delta: string): string {
      if (!delta) return '';
      const combined = pending + delta;
      pending = '';
      return emitCleaned(combined);
    },
    flush(): string {
      const rest = pending;
      pending = '';
      return rest;
    },
  };
}

export function classifyFrontmostApp(
  appName: string | null | undefined,
  appId: string | null | undefined,
  appsMap: Record<string, string[]> | undefined,
): string | null {
  const hay = `${appName || ''} ${appId || ''}`.trim().toLowerCase();
  if (!hay || hay.includes('cybercompanion') || hay === 'kbot') return null;
  const map = appsMap || {};
  for (const [cat, list] of Object.entries(map)) {
    if (!Array.isArray(list)) continue;
    if (list.some(item => item && hay.includes(String(item).toLowerCase()))) {
      return cat;
    }
  }
  return null;
}

const KNOWN_MODEL_DISPLAY_NAMES: Record<string, string> = {
  'deepseek-flash': 'DeepSeek-V4.1-Flash',
  'deepseek-chat': 'DeepSeek-V3.2',
  'deepseek-reasoner': 'DeepSeek-R1',
};

export function formatModelDisplayName(modelId?: string | null, displayName?: string | null): string {
  const rawId = String(modelId || '').trim();
  const rawDisplay = String(displayName || '').trim();
  if (rawDisplay && rawDisplay.toLowerCase() !== rawId.toLowerCase()) {
    return rawDisplay;
  }
  const mapped = KNOWN_MODEL_DISPLAY_NAMES[rawId.toLowerCase()];
  if (mapped) return mapped;
  return rawDisplay || rawId;
}

const REASONING_EFFORT_LABELS: Record<string, string> = {
  off: '不思考',
  none: '不思考',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最高',
};

export function formatReasoningEffortLabel(effortId?: string | null, effortName?: string | null): string {
  const id = String(effortId || '').trim();
  if (!id) return '';
  const mapped = REASONING_EFFORT_LABELS[id.toLowerCase()];
  if (mapped) return mapped;
  return String(effortName || id).trim();
}

function basenameOfPath(rawPath: string): string {
  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = normalized.lastIndexOf('/');
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

function parseToolArgs(rawArgs: any): any {
  if (!rawArgs) return {};
  if (typeof rawArgs === 'string') {
    try {
      const parsed = JSON.parse(rawArgs);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof rawArgs === 'object' ? rawArgs : {};
}

const RECOMMENDED_LABEL_RE = /\s*(?:\((?:recommended|推荐)\)|（(?:recommended|推荐)）)\s*$/i;

export function parseRecommendedOptionLabel(rawLabel?: string | null): {
  label: string;
  displayLabel: string;
  recommended: boolean;
} {
  const label = String(rawLabel || '').trim();
  if (!label) return { label: '', displayLabel: '', recommended: false };
  const recommended = RECOMMENDED_LABEL_RE.test(label);
  const displayLabel = recommended ? label.replace(RECOMMENDED_LABEL_RE, '').trim() || label : label;
  return { label, displayLabel, recommended };
}

export interface QuestionOptionView {
  label: string;
  displayLabel: string;
  recommended: boolean;
  description?: string;
}

export interface QuestionItemView {
  id: string;
  question: string;
  header?: string;
  detail?: string;
  options: QuestionOptionView[];
  multiSelect: boolean;
  intent?: any;
}

export interface QuestionDraftItem {
  selected: string[];
  custom: string;
  skipped?: boolean;
}

export function createQuestionCardState(payload: any) {
  const rawQuestions = Array.isArray(payload?.questions) ? payload.questions : [];
  const questions: QuestionItemView[] = rawQuestions.map((q: any, idx: number) => {
    const options: QuestionOptionView[] = Array.isArray(q?.options)
      ? q.options
          .map((opt: any) => {
            const parsed = parseRecommendedOptionLabel(opt?.label);
            if (!parsed.label) return null;
            return {
              ...parsed,
              ...(typeof opt?.description === 'string' && opt.description.trim()
                ? { description: opt.description.trim() }
                : {}),
            };
          })
          .filter(Boolean) as QuestionOptionView[]
      : [];
    return {
      id: String(q?.id || `q_${idx + 1}`),
      question: String(q?.question || '').trim(),
      ...(typeof q?.header === 'string' && q.header.trim() ? { header: q.header.trim() } : {}),
      ...(typeof q?.detail === 'string' && q.detail.trim() ? { detail: q.detail.trim() } : {}),
      options,
      multiSelect: Boolean(q?.multiSelect ?? q?.multi_select),
      ...(q?.intent && typeof q.intent === 'object' ? { intent: q.intent } : {}),
    };
  });

  const drafts: Record<string, QuestionDraftItem> = {};
  for (const q of questions) {
    const preselect =
      !q.multiSelect && q.options.length > 0 && q.options[0].recommended ? [q.options[0].label] : [];
    drafts[q.id] = {
      selected: preselect,
      custom: '',
      skipped: false,
    };
  }

  return {
    type: 'question' as const,
    questionRequestId: String(payload?.questionRequestId || ''),
    sessionId: String(payload?.sessionId || ''),
    callId: payload?.callId ? String(payload.callId) : null,
    timed: Boolean(payload?.timed),
    mode: payload?.state === 'continued' ? ('continued' as const) : ('open' as const),
    state: 'pending' as 'pending' | 'submitting' | 'answered' | 'cancelled',
    index: 0,
    questions,
    drafts,
    answers: null as Array<{ id: string; selected: string[]; custom?: string }> | null,
  };
}

export function buildSubmittedAnswersFromCard(
  card: any,
): Array<{ id: string; selected: string[]; custom?: string }> {
  const questions: QuestionItemView[] = Array.isArray(card?.questions) ? card.questions : [];
  const drafts: Record<string, QuestionDraftItem> = card?.drafts || {};
  return questions.map(q => {
    const d = drafts[q.id];
    if (!d || d.skipped) {
      return { id: q.id, selected: [] };
    }
    const custom = typeof d.custom === 'string' ? d.custom.trim() : '';
    const selected = Array.isArray(d.selected) ? d.selected.map(s => String(s)).filter(Boolean) : [];
    if (!q.multiSelect) {
      if (custom) {
        return { id: q.id, selected: [], custom };
      }
      return { id: q.id, selected: selected.slice(0, 1) };
    }
    return custom ? { id: q.id, selected, custom } : { id: q.id, selected };
  });
}

/** 把模型给出的开场建议收成最多 4 条可直接发送的吩咐。 */
export function parseOpeners(raw: string): string[] {
  const lines = String(raw || '')
    .replace(/```[\s\S]*?```/g, '\n')
    .split(/\r?\n/)
    .map(line => line
      .replace(/^\s*(?:[-*•]|\d+[.)．、])\s*/, '')
      .replace(/^["'「『]|["'」』]$/g, '')
      .replace(/\s+/g, ' ')
      .trim())
    .filter(line => line && [...line].length <= 24 && !/^[#>]/.test(line));
  const unique: string[] = [];
  for (const line of lines) {
    if (!unique.includes(line)) unique.push(line);
    if (unique.length === 4) break;
  }
  return unique;
}

export const UI_LANGUAGE = '简体中文';
export const REFUSAL_TEXT = '这个请求我不能继续。换个问法，或吩咐我做点别的。';

const TITLE_OPEN = '[[title:';

export function formatDesktopWhen(now: Date, timeZone: string): { date: string; time: string } {
  const dateParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'long',
  }).formatToParts(now);
  const timeParts = new Intl.DateTimeFormat('zh-CN', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const pick = (parts: Intl.DateTimeFormatPart[], type: string) => parts.find(part => part.type === type)?.value || '';
  const hour = pick(timeParts, 'hour').padStart(2, '0');
  const minute = pick(timeParts, 'minute').padStart(2, '0');
  return {
    date: `${pick(dateParts, 'year')}年${pick(dateParts, 'month')}月${pick(dateParts, 'day')}日 ${pick(dateParts, 'weekday')}`.trim(),
    time: `${hour}:${minute}`,
  };
}

export interface DesktopSensorInput {
  now?: Date;
  timeZone?: string;
  language?: string;
  nickname?: string;
  persona?: string;
  away?: boolean;
  frontmostCategory?: string;
  frontmostApp?: string;
  dnd?: boolean;
  dndLabel?: string;
  weather?: string;
  city?: string;
}

export function buildDesktopSensorSnapshot(input: DesktopSensorInput = {}) {
  const timeZone = input.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
  const when = formatDesktopWhen(input.now || new Date(), timeZone);
  return {
    nickname: input.nickname || '',
    persona: input.persona || '',
    away: Boolean(input.away),
    frontmostCategory: input.frontmostCategory || '',
    frontmostApp: input.frontmostApp || '',
    dnd: Boolean(input.dnd),
    dndLabel: input.dndLabel || '',
    weather: input.weather || '',
    city: input.city || '',
    date: when.date,
    time: when.time,
    timeZone,
    language: input.language || UI_LANGUAGE,
  };
}

export function isRefusalSignal(ev?: { refusal?: boolean; reason?: unknown; stopReason?: unknown; code?: unknown; message?: unknown } | null): boolean {
  if (!ev) return false;
  if (ev.refusal === true) return true;
  const blob = `${ev.reason || ''} ${ev.stopReason || ''} ${ev.code || ''} ${ev.message || ''}`.toLowerCase();
  return /\brefusal\b|content[_-]filter|safety_check|model_refusal/.test(blob);
}

export function normalizeSessionTitle(raw?: string | null): string {
  let title = String(raw || '').replace(/\s+/g, ' ').trim();
  title = title.replace(/^["'「『《]+|["'」』》]+$/g, '').trim();
  title = title.replace(/[。！？!?，,、；;：:\s]+$/g, '').trim();
  if (!title || title === '新对话' || title === REFUSAL_TEXT) return '';
  const chars = [...title];
  return chars.length > 18 ? chars.slice(0, 18).join('') : title;
}

function plainTitleSource(raw: string): string {
  return String(raw || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[\[[^\]]*title[:：][^\]]*\]\]/gi, ' ')
    .replace(/\[([a-z]{3,12})\]/gi, ' ')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_~`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipLooseTitle(raw: string): string {
  let title = plainTitleSource(raw);
  const filler = /^(?:请问|请你|请帮我|帮我|帮忙|麻烦你|麻烦|你好|您好|嗨|hi|hello|在吗)[，,。！？!?\s]*/i;
  for (let i = 0; i < 3; i += 1) {
    const next = title.replace(filler, '').trim();
    if (next === title) break;
    title = next;
  }
  const cut = title.search(/[。！？!?\n]/);
  if (cut > 0) title = title.slice(0, cut);
  return normalizeSessionTitle(title);
}

export function suggestSessionTitle(userText?: string, assistantText?: string): string {
  const user = clipLooseTitle(userText || '');
  if ([...user].length >= 2) return user;
  const reply = clipLooseTitle(assistantText || '');
  if ([...reply].length >= 2) return reply;
  return '';
}

export function chooseSessionTitle(modelTitle?: string | null, userText?: string, assistantText?: string): string {
  return normalizeSessionTitle(modelTitle) || suggestSessionTitle(userText, assistantText);
}

export function shouldRefreshSessionTitle(
  conv?: { title?: string; titleLocked?: boolean; titleSource?: string; messages?: Array<{ role?: string; id?: string }> } | null,
  userMsg?: { id?: string } | null,
): boolean {
  if (!conv || conv.titleLocked || conv.titleSource === 'manual') return false;
  if (!conv.titleSource && conv.title && conv.title !== '新对话') return false;
  const first = (conv.messages || []).find(message => message.role === 'user');
  if (!first || !userMsg) return false;
  return first === userMsg || Boolean(first.id && first.id === userMsg.id);
}

function titleOpenLength(rest: string): number {
  if (rest.length >= 8 && rest.slice(0, 7).toLowerCase() === '[[title' && (rest[7] === ':' || rest[7] === '：')) return 8;
  return 0;
}

function holdsTitleOpen(rest: string): boolean {
  if (titleOpenLength(rest)) return false;
  return TITLE_OPEN.startsWith(rest.toLowerCase());
}

export function createSessionTitleFilter(onTitle?: (title: string) => void) {
  let pending = '';
  const emitReady = (flush: boolean): string => {
    let out = '';
    while (pending) {
      const start = pending.indexOf('[[');
      if (start < 0) {
        if (!flush && pending.endsWith('[')) {
          out += pending.slice(0, -1);
          pending = '[';
          return out;
        }
        out += pending;
        pending = '';
        return out;
      }
      out += pending.slice(0, start);
      const rest = pending.slice(start);
      if (holdsTitleOpen(rest)) {
        if (!flush) {
          pending = rest;
          return out;
        }
        out += rest;
        pending = '';
        return out;
      }
      const open = titleOpenLength(rest);
      if (!open) {
        out += rest[0];
        pending = rest.slice(1);
        continue;
      }
      const end = rest.indexOf(']]', open);
      if (end < 0) {
        const body = rest.slice(open);
        const broken = [...body].length > 32 || body.includes('\n');
        if (!flush && !broken) {
          pending = rest;
          return out;
        }
        if (flush && !broken) {
          pending = '';
          return out;
        }
        out += rest[0];
        pending = rest.slice(1);
        continue;
      }
      const body = rest.slice(open, end).trim();
      const title = !body.includes('\n') ? normalizeSessionTitle(body) : '';
      if (title) onTitle?.(title);
      else out += rest.slice(0, end + 2);
      pending = rest.slice(end + 2);
    }
    return out;
  };
  return {
    push(delta: string): string {
      if (!delta) return '';
      pending += delta;
      return emitReady(false);
    },
    flush(): string {
      const out = emitReady(true);
      pending = '';
      return out;
    },
  };
}

export function extractSessionTitle(raw: string): { text: string; title: string | null } {
  let title: string | null = null;
  const filter = createSessionTitleFilter(next => { title = next; });
  return { text: `${filter.push(raw || '')}${filter.flush()}`, title };
}

export type ToolStepIcon = 'think' | 'globe' | 'terminal' | 'file' | 'clock' | 'sparkle' | 'tool';

export interface ClassifiedToolStep {
  icon: ToolStepIcon;
  t: string;
  doneT: string;
}

export interface ChatSourceItem {
  url: string;
  title: string;
  site?: string;
}

function searchQueryFromArgs(args: any): string {
  if (Array.isArray(args?.queries)) {
    const first = args.queries.find((q: any) => typeof q === 'string' && q.trim());
    if (first) return first.trim();
  }
  return String(args?.query || args?.q || '').trim();
}

export function formatToolStepLabel(name?: string, rawArgs?: any): string {
  const tool = String(name || 'tool').trim();
  const lower = tool.toLowerCase();
  const args = parseToolArgs(rawArgs);
  if (lower === 'ask_user_question' || lower.includes('ask_user')) {
    const firstHeader = Array.isArray(args?.questions) ? String(args.questions[0]?.header || '').trim() : '';
    return firstHeader ? `向你提问 · ${firstHeader}` : '向你提问 · 等待回答';
  }
  if (lower === 'mcp_load') {
    const server = String(args?.server || '').trim();
    return `${args?.unload ? '卸载' : '加载'}外部工具${server ? ` · ${server}` : ''}`;
  }
  if (lower.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    return `调用 ${server || 'MCP'} · ${rest.join('__') || tool}`;
  }
  if (lower === 'skill') {
    const skillName = String(args?.name || args?.skill || '').trim();
    return skillName ? `使用技能: ${skillName}` : '调用技能';
  }
  if (lower.includes('web_search') || lower.includes('search')) {
    const q = searchQueryFromArgs(args);
    return q ? `搜索「${q.slice(0, 26)}${q.length > 26 ? '…' : ''}」` : '联网搜索相关信息';
  }
  if (lower.includes('web_fetch') || lower.includes('fetch')) {
    const rawUrl = String(args?.url || args?.uri || '').trim();
    if (rawUrl) {
      try {
        const host = new URL(rawUrl).hostname.replace(/^www\./i, '');
        if (host) return `读取网页 · ${host}`;
      } catch {
        /* ignore invalid URL */
      }
    }
    return '读取网页正文';
  }
  if (lower.includes('read')) {
    const p = String(args?.file_path || args?.path || '').trim();
    if (p.includes('MEMORY.md')) return '读取长期记忆 MEMORY.md';
    if (p.includes('AGENTS.md')) return '读取角色设定 AGENTS.md';
    if (p.includes('diary/')) return '读取相处日记';
    const base = basenameOfPath(p);
    return base ? `读取文件 · ${base}` : '读取工作区文件';
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('str_replace')) {
    const p = String(args?.file_path || args?.path || '').trim();
    if (p.includes('MEMORY.md')) return '更新长期记忆 MEMORY.md';
    if (p.includes('AGENTS.md')) return '更新角色设定 AGENTS.md';
    if (p.includes('diary/')) return '记录今日日记';
    const base = basenameOfPath(p);
    return base ? `写入文件 · ${base}` : '写入工作区文件';
  }
  if (lower.includes('schedule') || lower.includes('cron') || lower.includes('timer')) {
    return '设置定时提醒任务';
  }
  if (lower.includes('bash') || lower.includes('pty') || lower.includes('shell') || lower.includes('terminal')) {
    const cmd = String(args?.command || args?.cmd || '').trim().split(/\s+/)[0] || '';
    return cmd && cmd.length <= 20 ? `执行命令 · ${cmd}` : '执行终端命令';
  }
  return `调用工具 · ${tool}`;
}

export function formatToolStepDetail(name?: string, rawArgs?: any): string {
  const tool = String(name || 'tool').trim();
  const lower = tool.toLowerCase();
  const args = parseToolArgs(rawArgs);
  if (!args || typeof args !== 'object') return '';

  if (!lower.startsWith('mcp') && (lower.includes('web_search') || lower.includes('search'))) {
    const queries = Array.isArray(args.queries)
      ? args.queries.filter((q: any) => typeof q === 'string' && q.trim()).map((q: string) => q.trim())
      : [];
    if (queries.length) return queries.map((q: string) => `搜索：${q}`).join('\n');
    const q = searchQueryFromArgs(args);
    return q ? `搜索：${q}` : '';
  }
  if (!lower.startsWith('mcp') && (lower.includes('web_fetch') || lower.includes('fetch'))) {
    const rawUrl = String(args.url || args.uri || '').trim();
    return rawUrl ? `网址：${rawUrl}` : '';
  }
  if (!lower.startsWith('mcp') && (lower.includes('bash') || lower.includes('pty') || lower.includes('shell') || lower.includes('terminal'))) {
    const cmd = String(args.command || args.cmd || '').trim();
    const desc = String(args.description || '').trim();
    if (desc && cmd) return `${desc}\n$ ${cmd}`;
    if (cmd) return `$ ${cmd}`;
    return desc;
  }
  if (!lower.startsWith('mcp') && (lower.includes('read') || lower.includes('edit') || lower.includes('write') || lower.includes('str_replace'))) {
    const p = String(args.file_path || args.path || '').trim();
    return p ? `路径：${p}` : '';
  }
  if (!lower.startsWith('mcp') && (lower.includes('glob') || lower.includes('grep'))) {
    const pattern = String(args.pattern || args.query || '').trim();
    const dir = String(args.path || args.directory || '').trim();
    return [pattern ? `模式：${pattern}` : '', dir ? `目录：${dir}` : ''].filter(Boolean).join('\n');
  }
  if (lower === 'skill') {
    const skillName = String(args.name || args.skill || '').trim();
    return skillName ? `技能：${skillName}` : '';
  }
  try {
    const keys = Object.keys(args);
    if (!keys.length) return '';
    const json = JSON.stringify(args, null, 2);
    return json.length > 600 ? `${json.slice(0, 600).trimEnd()}…` : json;
  } catch {
    return '';
  }
}

export function classifyToolStep(name?: string, rawArgs?: any): ClassifiedToolStep {
  const tool = String(name || 'tool').trim();
  const lower = tool.toLowerCase();
  const args = parseToolArgs(rawArgs);
  const t = formatToolStepLabel(name, args);

  if (lower === 'ask_user_question' || lower.includes('ask_user')) {
    return { icon: 'sparkle', t, doneT: '已完成问答确认' };
  }
  if (lower === 'mcp_load') {
    return { icon: 'tool', t, doneT: args?.unload ? '已卸载外部工具' : '已加载外部工具' };
  }
  if (lower.startsWith('mcp__')) {
    return { icon: 'tool', t, doneT: t.replace(/^调用/, '已调用') };
  }
  if (lower === 'skill') {
    const skillName = String(args?.name || args?.skill || '').trim();
    return {
      icon: 'tool',
      t,
      doneT: skillName ? `已使用技能: ${skillName}` : '已使用技能',
    };
  }
  if (lower.includes('web_search') || lower.includes('search')) {
    const q = searchQueryFromArgs(args);
    return {
      icon: 'globe',
      t,
      doneT: q ? `已搜索「${q.slice(0, 26)}${q.length > 26 ? '…' : ''}」` : '已完成联网搜索',
    };
  }
  if (lower.includes('web_fetch') || lower.includes('fetch')) {
    return { icon: 'globe', t, doneT: t.replace(/^读取/, '已读取') };
  }
  if (lower.includes('read')) {
    return { icon: 'file', t, doneT: t.replace(/^读取/, '已读取') };
  }
  if (lower.includes('edit') || lower.includes('write') || lower.includes('str_replace')) {
    return { icon: 'file', t, doneT: t.replace(/^(更新|记录|写入)/, '已$1') };
  }
  if (lower.includes('schedule') || lower.includes('cron') || lower.includes('timer')) {
    return { icon: 'clock', t, doneT: '已设置定时提醒任务' };
  }
  if (lower.includes('bash') || lower.includes('pty') || lower.includes('shell') || lower.includes('terminal')) {
    const cmd = String(args?.command || args?.cmd || '').trim().split(/\s+/)[0] || '';
    return {
      icon: 'terminal',
      t,
      doneT: cmd && cmd.length <= 20 ? `已执行命令 · ${cmd}` : '已执行命令',
    };
  }
  return { icon: 'tool', t, doneT: `已调用 · ${tool}` };
}

export function formatElapsedDuration(ms: number, live = false): string {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalSec = live ? Math.floor(safeMs / 1000) : Math.max(1, Math.round(safeMs / 1000));
  if (totalSec < 60) return `${totalSec} 秒`;
  const mins = Math.floor(totalSec / 60);
  const rem = totalSec % 60;
  return rem ? `${mins} 分 ${rem} 秒` : `${mins} 分钟`;
}

const KNOWN_SITE_NAMES: Record<string, string> = {
  'xueqiu.com': '雪球',
  'eastmoney.com': '东方财富',
  'quote.eastmoney.com': '东方财富',
  'finance.eastmoney.com': '东方财富',
  'zhihu.com': '知乎',
  'zhuanlan.zhihu.com': '知乎专栏',
  'cls.cn': '财联社',
  'wallstreetcn.com': '华尔街见闻',
  'sina.com.cn': '新浪财经',
  'finance.sina.com.cn': '新浪财经',
  '163.com': '网易',
  'qq.com': '腾讯网',
  '36kr.com': '36氪',
  'github.com': 'GitHub',
  'wikipedia.org': '维基百科',
  'zh.wikipedia.org': '维基百科',
  'en.wikipedia.org': 'Wikipedia',
  'reuters.com': 'Reuters',
  'bloomberg.com': 'Bloomberg',
  'cnbc.com': 'CNBC',
  'finance.yahoo.com': 'Yahoo Finance',
  'investing.com': 'Investing',
};

function cleanHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

export function sourceShortLabel(source: { url?: string; title?: string; site?: string }): string {
  const host = String(source?.site || cleanHost(String(source?.url || ''))).replace(/^www\./i, '').toLowerCase();
  if (host) {
    if (KNOWN_SITE_NAMES[host]) return KNOWN_SITE_NAMES[host];
    const parts = host.split('.');
    if (parts.length > 2) {
      const rootDomain = parts.slice(-2).join('.');
      if (KNOWN_SITE_NAMES[rootDomain]) return KNOWN_SITE_NAMES[rootDomain];
    }
  }
  const title = String(source?.title || '').trim();
  const suffixMatch = title.match(/(?:\s[-–—|_]\s)([^-–—|_\n]{2,18})$/);
  if (suffixMatch?.[1]) {
    const cand = suffixMatch[1].trim();
    if (!/^(首页|官网|新闻|详情)$/.test(cand)) return cand;
  }
  return host || title || String(source?.url || '');
}

export function mergeChatSources(
  existing: ChatSourceItem[] | undefined,
  incoming: ChatSourceItem[] | undefined,
  max = 12,
): ChatSourceItem[] {
  const out: ChatSourceItem[] = [];
  const seen = new Set<string>();
  for (const item of [...(existing || []), ...(incoming || [])]) {
    const url = String(item?.url || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    const site = String(item?.site || cleanHost(url) || '').trim();
    const title = String(item?.title || site || url).trim();
    out.push({ url, title, ...(site ? { site } : {}) });
    if (out.length >= max) break;
  }
  return out;
}

export function summarizeSourceLinks(
  sources: Array<{ url?: string; title?: string; site?: string }> | undefined,
  max = 6,
): Array<{ url: string; label: string; title: string }> {
  const out: Array<{ url: string; label: string; title: string }> = [];
  const seenLabels = new Set<string>();
  for (const s of sources || []) {
    const url = String(s?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;
    const label = sourceShortLabel(s) || url;
    const key = label.toLowerCase();
    if (seenLabels.has(key)) continue;
    seenLabels.add(key);
    out.push({ url, label, title: String(s?.title || label).trim() });
    if (out.length >= max) break;
  }
  return out;
}

export function summarizeReplyForBubble(raw: string, maxChars = 76): string {
  if (!raw) return '';
  const cleaned = extractExpressions(raw)
    .text
    .replace(/```[\s\S]*?```/g, ' [代码片段] ')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/(\*\*|__|\*|_|\~\~)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(12, maxChars - 1)).trimEnd()}…`;
}

export function normalizeDshError(raw: unknown): { message: string; needModelConfig: boolean; accountAction?: 'sign-in' | 'top-up' } {
  const text = String(raw instanceof Error ? raw.message : raw || '').trim();
  if (!text) return { message: '回复执行出错', needModelConfig: false };
  const lower = text.toLowerCase();
  if (/account_sign_in_required|account_token_invalid/.test(lower)) {
    return { message: '账号尚未登录或授权已失效，请重新登录后重试。', needModelConfig: false, accountAction: 'sign-in' };
  }
  if (/account_quota/.test(lower)) {
    return { message: '当前账号额度不足，请充值后重试。', needModelConfig: false, accountAction: 'top-up' };
  }
  if (
    lower.includes('no api key for provider') ||
    lower.includes('no credential for provider') ||
    lower.includes('missing_credential') ||
    lower.includes('through the credentials service')
  ) {
    const routeMatch = text.match(/provider route\s+"([^"]+)"/i);
    const routeLabel = routeMatch?.[1] ? `（${routeMatch[1]}）` : '';
    return {
      message: `当前模型通道${routeLabel}尚未配置 API Key，请点击「配置模型」完成设置后重试。`,
      needModelConfig: true,
    };
  }
  return { message: text, needModelConfig: false };
}

export interface ReasoningEffortOption {
  id: string;
  name: string;
  description?: string;
}

export interface ModelReasoningInfo {
  efforts: ReasoningEffortOption[];
  defaultEffort?: string;
}

export interface DshRuntimeState {
  status: 'connecting' | 'ready' | 'error';
  connected: boolean;
  activeMode: 'external' | 'managed' | 'none';
  port: number | null;
  pid: number | null;
  workspacePath: string;
  sessionId: string | null;
  model: string | null;
  modelLabel: string | null;
  provider: string | null;
  providerLabel: string | null;
  reasoningEffort: string | null;
  reasoning: ModelReasoningInfo | null;
  binaryPath: string | null;
  desktopPatchInstalled: boolean;
  error: string | null;
}

export function installAgent(A: any) {
  const C = A.chat;

  const state: DshRuntimeState = {
    status: 'connecting',
    connected: false,
    activeMode: 'none',
    port: null,
    pid: null,
    workspacePath: A.S.dsh?.workspace || '~/KBOT',
    sessionId: null,
    model: null,
    modelLabel: null,
    provider: null,
    providerLabel: null,
    reasoningEffort: null,
    reasoning: null,
    binaryPath: null,
    desktopPatchInstalled: false,
    error: null,
  };
  A.dshState = state;

  function normalizeReasoningInfo(raw: any): ModelReasoningInfo | null {
    if (!raw || !Array.isArray(raw.efforts) || !raw.efforts.length) return null;
    const efforts: ReasoningEffortOption[] = raw.efforts
      .filter((e: any) => e && e.id != null)
      .map((e: any) => ({
        id: String(e.id),
        name: String(e.name || e.id),
        ...(e.description ? { description: String(e.description) } : {}),
      }));
    if (!efforts.length) return null;
    return {
      efforts,
      ...(raw.defaultEffort ? { defaultEffort: String(raw.defaultEffort) } : {}),
    };
  }

  function applyModelPayload(raw: any): boolean {
    if (!raw || !raw.model) return false;
    const nextModel = String(raw.model);
    const modelChanged = state.model !== nextModel;
    const nextLabel = formatModelDisplayName(nextModel, raw.displayName || raw.name);
    const nextProvider = raw.provider ? String(raw.provider) : state.provider;
    const nextProviderLabel = raw.providerName ? String(raw.providerName) : (nextProvider || state.providerLabel);
    const hasReasoning = Object.prototype.hasOwnProperty.call(raw, 'reasoning');
    const nextReasoning = hasReasoning
      ? normalizeReasoningInfo(raw.reasoning)
      : (modelChanged ? null : state.reasoning);
    const hasEffort = Object.prototype.hasOwnProperty.call(raw, 'reasoningEffort');
    const nextEffort = hasEffort
      ? (raw.reasoningEffort ? String(raw.reasoningEffort) : (nextReasoning?.defaultEffort ?? null))
      : (modelChanged ? (nextReasoning?.defaultEffort ?? null) : state.reasoningEffort);
    const changed =
      state.model !== nextModel ||
      state.modelLabel !== nextLabel ||
      state.provider !== nextProvider ||
      state.providerLabel !== nextProviderLabel ||
      state.reasoningEffort !== nextEffort ||
      JSON.stringify(state.reasoning) !== JSON.stringify(nextReasoning);
    state.model = nextModel;
    state.modelLabel = nextLabel;
    state.provider = nextProvider ?? null;
    state.providerLabel = nextProviderLabel ?? null;
    state.reasoningEffort = nextEffort ?? null;
    state.reasoning = nextReasoning;
    return changed;
  }

  // Enhance A.speak so proactive reminders/speech bubbles also trigger MiMo TTS when enabled.
  const baseSpeak = A.speak?.bind(A);
  if (baseSpeak) {
    A.speak = (ev: any) => {
      const shown = baseSpeak(ev);
      if (
        shown &&
        ev?.text &&
        !A.isDnd?.() &&
        !A.hidden &&
        A.S.voice?.enabled &&
        A.S.voice?.autoProactive
      ) {
        const emotion = ev.expr || (ev.kind === 'remind' ? 'remind' : 'happy');
        A.voice?.speakAuto?.(ev.text, { emotion });
      }
      return shown;
    };
    A.say = (text: string, o?: any) => A.speak(Object.assign({ kind: 'speech', pri: 'low', text }, o));
  }

  type StepItem = {
    kind?: string;
    icon?: ToolStepIcon;
    t: string;
    doneT?: string;
    done: boolean;
    detail?: string;
    output?: string;
    isError?: boolean;
    open?: boolean;
  };

  let activeTurn: {
    conv: any;
    msg: any;
    sessionId: string;
    requestId: string;
    parser: ReturnType<typeof createExpressionStreamParser>;
    titleFilter: ReturnType<typeof createSessionTitleFilter>;
    sawText: boolean;
    cancelled: boolean;
    refused: boolean;
    lastExpr: string | null;
    modelTitle: string | null;
    wantTitle: boolean;
    userMsg: any;
    reasoningStep: StepItem | null;
    reasoningPaintAt: number;
    stepByCallId: Map<string, StepItem>;
  } | null = null;

  const proactiveTurns = new Map<string, { text: string; sourceKind: string }>();
  let quietSuggest: { sessionId: string; text: string; settle: (lines: string[]) => void } | null = null;
  let suggestJob: Promise<string[]> | null = null;

  function absorbSuggestion(ev: any): boolean {
    if (!quietSuggest || String(ev.sessionId || '') !== quietSuggest.sessionId) return false;
    if (ev.type === 'stream/text') quietSuggest.text += String(ev.delta || '');
    else if (ev.type === 'assistant/message' && typeof ev.text === 'string' && ev.text.trim()) quietSuggest.text = ev.text;
    else if (ev.type === 'turn/end' || ev.type === 'agent/error') {
      const done = quietSuggest;
      quietSuggest = null;
      done.settle(parseOpeners(done.text));
    }
    return true;
  }
  let lastFrontmostCat: string | null = null;
  let lastFrontmostApp: string | null = null;
  let lastSentSensorKey = '';
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function syncModelFlag() {
    const nextModel = state.connected && state.model ? 'vision' : 'none';
    if (A.S.model !== nextModel) {
      A.S.model = nextModel;
      A.emit('set:model', nextModel);
    }
    A.emit('dsh:state', { ...state });
    if (C && !C.generating) {
      C.status?.();
      C.refreshComposer?.();
    }
  }

  function applyEnsureResult(res: any) {
    const st = res?.status || {};
    const sess = res?.session || {};
    state.connected = Boolean(st.connected);
    state.status = state.connected ? 'ready' : 'error';
    state.activeMode = st.activeMode || 'none';
    state.port = st.port ?? null;
    state.pid = st.pid ?? null;
    state.workspacePath = sess.workspacePath || st.workspacePath || A.S.dsh?.workspace || '~/KBOT';
    state.binaryPath = st.binaryPath ?? null;
    state.desktopPatchInstalled = Boolean(st.desktopPatchInstalled);
    state.error = st.error ?? null;
    if (sess.sessionId) state.sessionId = String(sess.sessionId);
    if (!applyModelPayload(sess.model) && !sess.model) {
      state.model = state.modelLabel = state.provider = state.providerLabel = state.reasoningEffort = null;
      state.reasoning = null;
    }
    syncModelFlag();
    if (Array.isArray(sess.pendingQuestions)) {
      sess.pendingQuestions.forEach((q: any) => attachPendingQuestion(q));
    }
  }

  async function pushSensorContext(force = false) {
    if (!native || !state.connected) return;
    const snapshot = buildDesktopSensorSnapshot({
      nickname: addressName(A.S.nickname),
      persona: personaHint(A.S.persona),
      away: Boolean(A.away),
      frontmostCategory: A.S.senseApp && lastFrontmostCat ? CATEGORY_LABELS[lastFrontmostCat] || lastFrontmostCat : '',
      frontmostApp: A.S.senseApp && A.S.send?.appName && lastFrontmostApp ? lastFrontmostApp : '',
      dnd: Boolean(A.isDnd?.()),
      dndLabel: A.dndLabel?.() || '',
      weather: A.weatherSummary?.() || '',
      city: A.S.city || '',
      language: UI_LANGUAGE,
    });
    const key = JSON.stringify(snapshot);
    if (!force && key === lastSentSensorKey) return;
    lastSentSensorKey = key;
    try {
      await command('dsh_request', {
        endpoint: '/sensors/update',
        body: { sensors: snapshot },
      });
    } catch {
      /* Background sensor sync never interrupts the user. */
    }
  }

  async function ensureConnected(preferredSessionId?: string | null): Promise<boolean> {
    if (!native) {
      state.status = 'error';
      state.connected = false;
      state.activeMode = 'none';
      state.error = '浏览器预览模式暂不可用';
      syncModelFlag();
      return false;
    }
    state.status = 'connecting';
    state.error = null;
    A.emit('dsh:state', { ...state });
    try {
      const res = await command<any>('dsh_ensure', {
        config: {
          mode: A.S.dsh?.mode || 'auto',
          workspace: A.S.dsh?.workspace || '~/KBOT',
          binary: A.S.dsh?.binary || '',
          sessionId: preferredSessionId || state.sessionId || null,
        },
      });
      applyEnsureResult(res);
      lastSentSensorKey = '';
      await pushSensorContext(true);
      return state.connected;
    } catch (err: any) {
      state.status = 'error';
      state.connected = false;
      state.activeMode = 'none';
      state.error = err?.message || String(err);
      syncModelFlag();
      return false;
    }
  }

  async function ensureConversationSession(conv: any): Promise<string> {
    const ok = await ensureConnected(conv?.dshSessionId || null);
    if (!ok) {
      throw new Error(state.error || '无法连接智能核心');
    }
    if (conv.dshSessionId) {
      const ensured = await command<any>('dsh_request', {
        endpoint: '/session/ensure',
        body: {
          workspacePath: state.workspacePath,
          sessionId: conv.dshSessionId,
        },
      });
      conv.dshSessionId = String(ensured.sessionId);
      if (applyModelPayload(ensured.model)) syncModelFlag();
      if (Array.isArray(ensured.pendingQuestions)) {
        ensured.pendingQuestions.forEach((q: any) => attachPendingQuestion(q));
      }
      return conv.dshSessionId;
    }
    const usedIds = new Set(
      (C.convs || [])
        .filter((x: any) => x !== conv && x.dshSessionId)
        .map((x: any) => String(x.dshSessionId)),
    );
    if (state.sessionId && !usedIds.has(state.sessionId)) {
      conv.dshSessionId = state.sessionId;
      A.save();
      return conv.dshSessionId;
    }
    const created = await command<any>('dsh_request', {
      endpoint: '/session/new',
      body: { workspacePath: state.workspacePath },
    });
    conv.dshSessionId = String(created.sessionId);
    state.sessionId = conv.dshSessionId;
    if (applyModelPayload(created.model)) syncModelFlag();
    A.save();
    return conv.dshSessionId;
  }

  function markRefusal(turn: any) {
    if (!turn) return;
    turn.refused = true;
    turn.msg.refused = true;
    turn.msg.text = REFUSAL_TEXT;
    turn.lastExpr = null;
    if (Array.isArray(turn.msg.steps)) {
      turn.msg.steps = turn.msg.steps.filter((step: any) => step.kind !== 'note');
    }
  }

  function closeActiveReasoningStep(turn: NonNullable<typeof activeTurn>) {
    if (!turn.reasoningStep || turn.reasoningStep.done) {
      turn.reasoningStep = null;
      return false;
    }
    turn.reasoningStep.done = true;
    turn.reasoningStep.t = turn.reasoningStep.doneT || '思考已完成';
    turn.reasoningStep = null;
    return true;
  }

  function beginActiveTurn(conv: any, msg: any, sessionId: string, requestId: string, extra: Record<string, unknown> = {}) {
    if (typeof msg.startedAt !== 'number') msg.startedAt = Date.now();
    const parser = createExpressionStreamParser(expr => {
      if (activeTurn && !activeTurn.refused) activeTurn.lastExpr = expr;
      A.robot?.flash?.(expr, 2000);
    });
    const titleFilter = createSessionTitleFilter(title => {
      if (activeTurn && !activeTurn.refused) activeTurn.modelTitle = title;
    });
    activeTurn = {
      conv,
      msg,
      sessionId,
      requestId,
      parser,
      titleFilter,
      sawText: false,
      cancelled: false,
      refused: false,
      lastExpr: null,
      modelTitle: null,
      wantTitle: false,
      userMsg: null,
      reasoningStep: null,
      reasoningPaintAt: 0,
      stepByCallId: new Map(),
      ...extra,
    };
  }

  function finishActiveTurn(status: 'done' | 'stopped' | 'error', errorMsg?: string) {
    if (!activeTurn) return;
    const turn = activeTurn;
    activeTurn = null;
    closeActiveReasoningStep(turn);
    const visible = turn.titleFilter ? turn.titleFilter.flush() : '';
    const rest = `${turn.parser.push(visible)}${turn.parser.flush()}`;
    if (turn.refused) {
      turn.msg.text = REFUSAL_TEXT;
    } else if (rest) {
      turn.msg.text += rest;
    }
    if (!turn.refused && turn.msg.text) {
      const extracted = extractSessionTitle(turn.msg.text);
      if (extracted.title) turn.modelTitle = turn.modelTitle || extracted.title;
      turn.msg.text = extracted.text.replace(/\s+$/g, '');
    }
    if (status === 'done' && !turn.msg.text.trim() && Array.isArray(turn.msg.steps) && turn.msg.steps.length > 0) {
      const last = turn.msg.steps[turn.msg.steps.length - 1];
      if (last?.kind === 'note' && typeof last.t === 'string' && last.t.trim()) {
        turn.msg.steps.pop();
        turn.msg.text = last.t;
      }
    }
    if (Array.isArray(turn.msg.steps)) {
      turn.msg.steps.forEach((s: any) => {
        if (!s.done && s.doneT) s.t = s.doneT;
        s.done = true;
      });
    }
    if (typeof turn.msg.startedAt === 'number') {
      turn.msg.durationMs = Math.max(0, Date.now() - turn.msg.startedAt);
    }
    if (turn.msg.card?.state === 'pending') {
      if (status === 'done' && turn.msg.card.type === 'question') {
        turn.msg.card.mode = 'continued';
      } else if (status !== 'done') {
        turn.msg.card.state = 'cancelled';
      }
    }
    turn.msg.status = status;
    if (errorMsg) {
      const norm = normalizeDshError(errorMsg);
      turn.msg.error = norm.message;
      if (norm.needModelConfig) turn.msg.needModelConfig = true;
      if (norm.accountAction) turn.msg.accountAction = norm.accountAction;
    }
    if (status === 'done' && !turn.refused && turn.wantTitle) {
      const title = chooseSessionTitle(turn.modelTitle, turn.userMsg?.text, turn.msg.text);
      if (title) {
        turn.conv.title = title;
        turn.conv.titleSource = 'generated';
        C.refreshHistory?.();
      }
    }
    if (C.cur === turn.conv) C.paint(turn.msg);
    C.setGenerating(false);
    C.status();
    A.setBase?.(A.away ? 'sleep' : A.isDnd?.() ? 'dnd' : 'idle');
    if (turn.lastExpr && status === 'done') {
      A.robot?.flash?.(turn.lastExpr, 2200);
    }
    A.countCall?.();
    A.save();

    // 召唤态里回复已经以字幕显示，不再另发通知
    if (status === 'done' && turn.msg.text.trim() && !A.panel?.isOpen?.() && !A.summon?.isOpen?.()) {
      const brief = summarizeReplyForBubble(turn.msg.text, 78);
      if (brief) {
        const bubbleEv = {
          kind: 'speech',
          pri: 'mid',
          text: brief,
          expr: turn.lastExpr || 'happy',
          convId: turn.conv.id,
          msgId: turn.msg.id,
          silent: Boolean(A.isDnd?.()),
          dur: 9500,
        };
        if (A.away) {
          if (Array.isArray(A.missed)) {
            A.missed.push(bubbleEv);
            if (A.missed.length > 5) A.missed.shift();
          }
        } else if (A.hidden) {
          if (!A.isDnd?.()) {
            A.sysNotify?.('KBOT 已完成回复', brief, () => {
              A.setHidden?.(false);
              A.panel?.open?.({ convId: turn.conv.id });
            });
          }
        } else {
          A.bubble?.show?.(bubbleEv);
        }
      }
    }

    if (
      status === 'done' &&
      !turn.refused &&
      turn.msg.text.trim() &&
      A.S.voice?.enabled &&
      A.S.voice?.autoReply &&
      !A.voice?.realtimeBridging &&
      !A.isDnd?.()
    ) {
      A.voice?.speakAuto?.(turn.msg.text, { emotion: turn.lastExpr || 'happy' });
    }
  }

  function findConversationBySession(sessionId: string): any {
    if (activeTurn && activeTurn.sessionId === sessionId) return activeTurn.conv;
    const found = (C.convs || []).find((x: any) => String(x?.dshSessionId || '') === sessionId);
    return found || C.cur || null;
  }

  function findQuestionMessage(questionRequestId?: string | null, callId?: string | null): { conv: any; msg: any } | null {
    const reqId = String(questionRequestId || '');
    const cid = String(callId || '');
    for (const conv of C.convs || []) {
      for (let i = (conv.messages || []).length - 1; i >= 0; i -= 1) {
        const msg = conv.messages[i];
        const card = msg?.card;
        if (!card || card.type !== 'question') continue;
        if ((reqId && card.questionRequestId === reqId) || (cid && card.callId === cid)) {
          return { conv, msg };
        }
      }
    }
    return null;
  }

  function notifyQuestionIfCollapsed(conv: any, card: any, msgId?: string) {
    if (!conv || A.panel?.isOpen?.()) return;
    const firstQ = card?.questions?.[0]?.question || '有件事需要您定夺。';
    const brief = summarizeReplyForBubble(`想请教您：${firstQ}`, 76);
    if (!brief) return;
    const bubbleEv = {
      kind: 'remind',
      pri: 'high',
      text: brief,
      expr: 'remind',
      convId: conv.id,
      msgId,
      rich: true,
      silent: Boolean(A.isDnd?.()),
      dur: 14000,
    };
    if (A.hidden) {
      if (!A.isDnd?.()) {
        A.sysNotify?.('KBOT 正在等待您的回答', brief, () => {
          A.setHidden?.(false);
          A.panel?.open?.({ convId: conv.id });
        });
      }
    } else {
      A.bubble?.show?.(bubbleEv);
    }
  }

  function notifyApprovalIfCollapsed(conv: any, msg: any, toolName: string) {
    if (!conv || !msg || A.panel?.isOpen?.()) return;
    const brief = `需要您确认一项操作：${toolName || '工具调用'}`;
    if (A.hidden) {
      if (!A.isDnd?.()) {
        A.sysNotify?.('KBOT 正在等待您的确认', brief, () => {
          A.setHidden?.(false);
          A.panel?.open?.({ convId: conv.id, msgId: msg.id });
        });
      }
      return;
    }
    A.bubble?.show?.({
      kind: 'remind',
      pri: 'high',
      text: brief,
      expr: 'remind',
      msgId: msg.id,
      silent: Boolean(A.isDnd?.()),
      dur: 20000,
      actions: [
        { label: '允许一次', primary: true, fn: () => A.chat?.approve?.(msg, true) },
        { label: '拒绝', fn: () => A.chat?.approve?.(msg, false) },
      ],
    });
  }

  function attachPendingQuestion(ev: any) {
    const sessionId = String(ev?.sessionId || '');
    if (!sessionId || !Array.isArray(ev?.questions) || ev.questions.length === 0) return;

    const existing = findQuestionMessage(ev.questionRequestId, ev.callId);
    if (existing) {
      if (ev.questionRequestId) existing.msg.card.questionRequestId = String(ev.questionRequestId);
      if (ev.state === 'continued') existing.msg.card.mode = 'continued';
      if (C.cur === existing.conv) C.paint(existing.msg);
      return;
    }

    const conv = findConversationBySession(sessionId);
    if (!conv) return;

    const card = createQuestionCardState(ev);
    let targetMsg: any = null;

    if (activeTurn && activeTurn.sessionId === sessionId) {
      targetMsg = activeTurn.msg;
      targetMsg.card = card;
      C.status('等待您的回答…', 'busy');
      A.setBase?.('idle');
    } else {
      const lastMsg = conv.messages?.[conv.messages.length - 1];
      if (lastMsg && lastMsg.role === 'assistant' && !lastMsg.card) {
        targetMsg = lastMsg;
        targetMsg.card = card;
      } else {
        targetMsg = {
          id: A.uid(),
          role: 'assistant',
          text: '',
          status: 'done',
          steps: [],
          card,
          time: Date.now(),
        };
        conv.messages.push(targetMsg);
        conv.t = Date.now();
        if (C.cur === conv) {
          C.append(targetMsg);
          A.robot?.flash?.('remind', 2400);
          A.save();
          notifyQuestionIfCollapsed(conv, card, targetMsg.id);
          return;
        }
      }
    }

    A.robot?.flash?.('remind', 2400);
    if (C.cur === conv && targetMsg) C.paint(targetMsg);
    A.save();
    notifyQuestionIfCollapsed(conv, card, targetMsg?.id);
  }

  function resolvePendingQuestion(ev: any) {
    const hit = findQuestionMessage(ev?.questionRequestId, ev?.callId);
    if (!hit) return;
    const { conv, msg } = hit;
    const card = msg.card;
    if (ev.outcome === 'continued') {
      card.mode = 'continued';
      if (card.state === 'submitting') card.state = 'pending';
    } else if (ev.outcome === 'answered') {
      card.state = 'answered';
      if (Array.isArray(ev.answers)) {
        card.answers = ev.answers;
      } else if (!card.answers) {
        card.answers = buildSubmittedAnswersFromCard(card);
      }
      if (activeTurn && activeTurn.msg === msg) {
        const step = card.callId ? activeTurn.stepByCallId.get(String(card.callId)) : undefined;
        if (step) {
          step.t = '已完成问答确认';
          step.done = true;
        }
        C.status('收到回答，正在继续…', 'busy');
        A.setBase?.('think');
      }
    } else {
      card.state = 'cancelled';
    }
    if (C.cur === conv) C.paint(msg);
    A.save();
  }

  function handleDshEvent(ev: any) {
    if (!ev || typeof ev !== 'object') return;

    if (ev.type === 'bridge/disconnected') {
      state.connected = false;
      state.status = 'error';
      state.error = '智能核心连接已断开，正在尝试重连…';
      if (activeTurn) {
        finishActiveTurn('error', '连接中断，已保留当前输出');
      }
      syncModelFlag();
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          ensureConnected().catch(() => {});
        }, 2500);
      }
      return;
    }

    const sessionId = String(ev.sessionId || '');
    if (!sessionId) return;
    if (absorbSuggestion(ev)) return;

    if (ev.type === 'question/request') {
      attachPendingQuestion(ev);
      if (A.voice?.realtimeBridging && !A.panel?.isOpen?.()) {
        A.panel?.open?.(
          activeTurn && sessionId === activeTurn.sessionId
            ? { convId: activeTurn.conv?.id, msgId: activeTurn.msg?.id }
            : undefined,
        );
      }
      return;
    }
    if (ev.type === 'question/resolved') {
      resolvePendingQuestion(ev);
      return;
    }

    // 1. Events belonging to the active user turn in KBOT's chat window
    if (activeTurn && sessionId === activeTurn.sessionId) {
      const m = activeTurn.msg;
      if (ev.type === 'approval/request' && A.voice?.realtimeBridging && !A.panel?.isOpen?.()) {
        A.panel?.open?.({ convId: activeTurn.conv?.id, msgId: m?.id });
      }
      switch (ev.type) {
        case 'stream/reasoning': {
          let created = false;
          if (!activeTurn.reasoningStep) {
            m.steps = m.steps || [];
            const rStep: StepItem = { kind: 'reasoning', icon: 'think', t: '正在思考…', doneT: '思考已完成', done: false, detail: '' };
            m.steps.push(rStep);
            activeTurn.reasoningStep = rStep;
            created = true;
          }
          const delta = typeof ev.delta === 'string' ? ev.delta : '';
          if (delta && (activeTurn.reasoningStep.detail?.length || 0) < 12000) {
            const next = (activeTurn.reasoningStep.detail || '') + delta;
            activeTurn.reasoningStep.detail = next.length > 12000 ? `${next.slice(0, 12000)}…` : next;
          }
          if (C.cur === activeTurn.conv) {
            if (created) {
              activeTurn.reasoningPaintAt = Date.now();
              C.paint(m);
            } else if (activeTurn.reasoningStep.open && Date.now() - activeTurn.reasoningPaintAt > 160) {
              activeTurn.reasoningPaintAt = Date.now();
              (C.paintTrace || C.paint)(m);
            }
          }
          if (!activeTurn.sawText) {
            C.status('深度思考中…', 'busy');
            A.setBase?.('think');
          }
          break;
        }
        case 'stream/refusal':
          markRefusal(activeTurn);
          finishActiveTurn('done');
          return;
        case 'stream/text': {
          if (activeTurn.refused) break;
          const titled = activeTurn.titleFilter.push(String(ev.delta || ''));
          const clean = activeTurn.parser.push(titled);
          if (!clean) break;
          const closedReasoning = closeActiveReasoningStep(activeTurn);
          if (!activeTurn.sawText) {
            activeTurn.sawText = true;
            m.status = 'streaming';
            C.status('正在回复…', 'busy');
            A.setBase?.('talk');
          }
          m.text += clean;
          A.robot?.talkPulse?.();
          if (C.cur === activeTurn.conv) {
            if (closedReasoning) C.paint(m);
            else C.paintText(m);
          }
          break;
        }
        case 'tool/call': {
          closeActiveReasoningStep(activeTurn);
          const flushed = activeTurn.parser.flush();
          const priorText = (m.text + flushed).trim();
          m.steps = m.steps || [];
          if (priorText) {
            m.steps.push({ kind: 'note', t: priorText, done: true });
            m.text = '';
            activeTurn.sawText = false;
            m.status = 'thinking';
          }
          const info = classifyToolStep(ev.name, ev.arguments);
          const detail = formatToolStepDetail(ev.name, ev.arguments);
          const step: StepItem = {
            kind: 'tool',
            icon: info.icon,
            t: info.t,
            doneT: info.doneT,
            done: false,
            ...(detail ? { detail } : {}),
          };
          m.steps.push(step);
          if (ev.callId) activeTurn.stepByCallId.set(String(ev.callId), step);
          C.status(info.t, 'busy');
          A.setBase?.('think');
          if (C.cur === activeTurn.conv) C.paint(m);
          break;
        }
        case 'tool/result': {
          const step = ev.callId ? activeTurn.stepByCallId.get(String(ev.callId)) : undefined;
          if (step) {
            step.done = true;
            if (ev.isError) step.isError = true;
            if (typeof ev.output === 'string' && ev.output.trim()) {
              const out = ev.output.trim();
              step.output = out.length > 800 ? `${out.slice(0, 800).trimEnd()}…` : out;
            }
            if (step.doneT && step.t !== '已完成问答确认') step.t = step.doneT;
          }
          if (Array.isArray(ev.sources) && ev.sources.length) {
            m.sources = mergeChatSources(m.sources, ev.sources);
          }
          const stillRunning = Array.isArray(m.steps) ? m.steps.find((s: any) => !s.done) : null;
          if (stillRunning) {
            C.status(stillRunning.t, 'busy');
          } else if (!activeTurn.sawText) {
            C.status('正在整理结果…', 'busy');
          }
          if (C.cur === activeTurn.conv) (C.paintTrace || C.paint)(m);
          break;
        }
        case 'approval/request': {
          m.card = {
            type: 'approval',
            approvalId: ev.approvalId,
            callId: ev.callId,
            toolName: ev.toolName || 'tool',
            reason: ev.reason || '该操作需要你的授权确认后才能继续执行。',
            state: 'pending',
          };
          C.status('等待确认工具执行权限…', 'busy');
          A.robot?.flash?.('remind', 2600);
          if (C.cur === activeTurn.conv) C.paint(m);
          notifyApprovalIfCollapsed(activeTurn.conv, m, m.card.toolName);
          break;
        }
        case 'approval/resolved': {
          if (m.card?.approvalId === ev.approvalId) {
            m.card.state = ev.outcome === 'allowed-once' ? 'saved' : 'cancelled';
            if (C.cur === activeTurn.conv) C.paint(m);
          }
          break;
        }
        case 'assistant/message': {
          if (ev.model) {
            const changed = applyModelPayload(ev);
            if (changed) A.emit('dsh:state', { ...state });
            C.refreshComposer?.();
          }
          if (typeof ev.title === 'string' && ev.title.trim()) {
            activeTurn.modelTitle = normalizeSessionTitle(ev.title) || activeTurn.modelTitle;
          }
          if (isRefusalSignal(ev)) {
            markRefusal(activeTurn);
            finishActiveTurn('done');
            break;
          }
          if (!activeTurn.sawText && typeof ev.text === 'string' && ev.text.trim()) {
            const extracted = extractSessionTitle(ev.text);
            if (extracted.title) activeTurn.modelTitle = activeTurn.modelTitle || extracted.title;
            const parsed = extractExpressions(extracted.text);
            m.text = parsed.text;
            if (parsed.lastExpr) activeTurn.lastExpr = parsed.lastExpr;
          }
          break;
        }
        case 'agent/error': {
          if (isRefusalSignal(ev)) {
            markRefusal(activeTurn);
            finishActiveTurn('done');
          } else {
            finishActiveTurn('error', ev.code?.startsWith('ACCOUNT_') ? ev.code : ev.message || '执行出错');
          }
          break;
        }
        case 'turn/end': {
          if (typeof ev.title === 'string' && ev.title.trim()) {
            activeTurn.modelTitle = normalizeSessionTitle(ev.title) || activeTurn.modelTitle;
          }
          if (activeTurn.refused || isRefusalSignal(ev)) markRefusal(activeTurn);
          const cancelled = !activeTurn.refused && (activeTurn.cancelled || ev.reason === 'cancelled' || ev.reason === 'interrupted');
          finishActiveTurn(cancelled ? 'stopped' : 'done');
          break;
        }
      }
      return;
    }

    // 2. Proactive / scheduled turns originating inside ~/KBOT (e.g., dsh-schedule reminders)
    if (ev.type === 'user/message' && !ev.fromKbot) {
      proactiveTurns.set(sessionId, { text: '', sourceKind: ev.sourceKind || 'schedule' });
      return;
    }
    if (ev.type === 'assistant/message' && proactiveTurns.has(sessionId)) {
      const entry = proactiveTurns.get(sessionId)!;
      if (typeof ev.text === 'string' && ev.text.trim()) {
        entry.text = ev.text;
      }
      return;
    }
    if (ev.type === 'turn/end' && proactiveTurns.has(sessionId)) {
      const entry = proactiveTurns.get(sessionId)!;
      proactiveTurns.delete(sessionId);
      const raw = entry.text.trim();
      if (!raw) return;
      const { text, lastExpr } = extractExpressions(raw);
      if (!text.trim()) return;
      A.speak?.({
        kind: 'remind',
        pri: 'high',
        title: 'KBOT 提醒',
        text: text.trim(),
        expr: lastExpr || 'remind',
      });
    }
  }

  C.respond = async (um: any) => {
    const conv = C.cur;
    if (!conv) return;
    const m: any = {
      id: A.uid(),
      role: 'assistant',
      text: '',
      status: 'thinking',
      steps: [],
      startedAt: Date.now(),
      time: Date.now(),
    };
    conv.messages.push(m);
    conv.t = Date.now();
    C.append(m);
    C.setGenerating(true);
    C.status('思考中…', 'busy');
    A.setBase?.('think');

    const requestId = `kbot-${Date.now()}-${A.uid()}`;
    const wantTitle = shouldRefreshSessionTitle(conv, um);

    try {
      const sessionId = await ensureConversationSession(conv);
      beginActiveTurn(conv, m, sessionId, requestId, { wantTitle, userMsg: um });
      await pushSensorContext(true);
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      await command('dsh_request', {
        endpoint: '/session/prompt',
        body: {
          sessionId,
          requestId,
          text: um.text || '',
          images: Array.isArray(um.images) ? um.images.map((im: any) => im.src) : [],
          clientTimeZone: tz,
          wantTitle,
        },
      });
    } catch (err: any) {
      if (activeTurn?.msg === m) {
        finishActiveTurn('error', err?.message || String(err));
      } else {
        const norm = normalizeDshError(err);
        m.status = 'error';
        m.error = norm.message;
        if (norm.needModelConfig) m.needModelConfig = true;
        if (norm.accountAction) m.accountAction = norm.accountAction;
        if (C.cur === conv) C.paint(m);
        C.setGenerating(false);
        C.status();
        A.setBase?.(A.away ? 'sleep' : A.isDnd?.() ? 'dnd' : 'idle');
        A.save();
      }
    }
  };

  C.stop = async () => {
    if (!activeTurn) {
      C.setGenerating(false);
      return;
    }
    const sid = activeTurn.sessionId;
    activeTurn.cancelled = true;
    try {
      await command('dsh_request', {
        endpoint: '/session/cancel',
        body: { sessionId: sid },
      });
    } catch {
      finishActiveTurn('stopped');
    }
  };

  A.agent = {
    state: () => ({ ...state }),
    reconnect: () => ensureConnected(),
    suggestOpeners: () => {
      if (suggestJob) return suggestJob;
      suggestJob = (async () => {
        const ok = state.connected || (await ensureConnected());
        if (!ok) return [];
        const created = await command<any>('dsh_request', {
          endpoint: '/session/new',
          body: { workspacePath: state.workspacePath },
        });
        const sessionId = String(created?.sessionId || '');
        if (!sessionId) return [];
        const lines = await new Promise<string[]>((resolve) => {
          const timer = setTimeout(() => {
            if (quietSuggest?.sessionId !== sessionId) return;
            const text = quietSuggest.text;
            quietSuggest = null;
            resolve(parseOpeners(text));
          }, 20000);
          quietSuggest = {
            sessionId,
            text: '',
            settle: (list) => {
              clearTimeout(timer);
              resolve(list);
            },
          };
          const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
          command('dsh_request', {
            endpoint: '/session/prompt',
            body: {
              sessionId,
              requestId: `kbot-openers-${Date.now()}`,
              text: '请根据你已经知道的用户记忆和当前时间，给出 4 条用户此刻可能想聊或想让我处理的事。不要调用任何工具，不要查阅文件，不要寒暄，也不要提天气。只输出 4 行，每行一条可直接发送的话，不超过 22 个字，不要编号。',
              images: [],
              clientTimeZone: tz,
            },
          }).catch(() => {
            if (quietSuggest?.sessionId === sessionId) quietSuggest = null;
            clearTimeout(timer);
            resolve([]);
          });
        });
        return lines;
      })().then(list => {
        if (!list.length) suggestJob = null;
        return list;
      }, () => {
        suggestJob = null;
        return [];
      });
      return suggestJob;
    },
    restart: async () => {
      if (!native) return false;
      state.status = 'connecting';
      state.error = null;
      A.emit('dsh:state', { ...state });
      try {
        const res = await command<any>('dsh_restart', {
          config: {
            mode: A.S.dsh?.mode || 'auto',
            workspace: A.S.dsh?.workspace || '~/KBOT',
            binary: A.S.dsh?.binary || '',
            sessionId: C.cur?.dshSessionId || state.sessionId || null,
          },
        });
        applyEnsureResult(res);
        await pushSensorContext(true);
        return state.connected;
      } catch (err: any) {
        state.status = 'error';
        state.connected = false;
        state.activeMode = 'none';
        state.error = err?.message || String(err);
        syncModelFlag();
        return false;
      }
    },
    openWorkspace: async () => {
      if (!native) {
        A.toast('请在桌面应用中打开养成目录');
        return;
      }
      try {
        await command('dsh_open_workspace', { workspace: A.S.dsh?.workspace || '~/KBOT' });
      } catch (err: any) {
        A.toast(err?.message || String(err), 4000);
      }
    },
    openConsole: async () => {
      if (!native) {
        A.toast('请在桌面应用中打开 DeepSeek Harness 控制台');
        return null;
      }
      try {
        const out = await command<any>('dsh_open_console', {
          config: {
            mode: A.S.dsh?.mode || 'auto',
            workspace: A.S.dsh?.workspace || '~/KBOT',
            binary: A.S.dsh?.binary || '',
            sessionId: C.cur?.dshSessionId || state.sessionId || null,
          },
        });
        if (out?.opened === 'desktop-app') {
          A.toast('已唤起 DeepSeek Harness 客户端，可在设置中调整模型配置');
        } else {
          A.toast('已在浏览器打开内置 DSH 控制台，在 Models 页面配置好 API Key 后回到这里重试即可', 5000);
        }
        return out;
      } catch (err: any) {
        A.toast(err?.message || String(err), 5000);
        return null;
      }
    },
    initWorkspace: async (overwrite = false) => {
      if (!native) return null;
      return command<any>('dsh_init_workspace', {
        workspace: A.S.dsh?.workspace || '~/KBOT',
        overwrite,
      });
    },
    setDesktopPatch: async (enabled: boolean) => {
      if (!native) return false;
      const out = await command<any>('dsh_install_desktop_patch', { enabled });
      state.desktopPatchInstalled = Boolean(out?.installed);
      A.S.dsh.desktopPatch = state.desktopPatchInstalled;
      A.save();
      A.emit('dsh:state', { ...state });
      return state.desktopPatchInstalled;
    },
    respondApproval: async (approvalId: string, outcome: 'allowed-once' | 'rejected') => {
      if (!native || !approvalId) return;
      await command('dsh_request', {
        endpoint: '/approval/respond',
        body: { approvalId, outcome },
      });
    },
    buildQuestionAnswers: (card: any) => buildSubmittedAnswersFromCard(card),
    respondQuestion: async (
      msg: any,
      action: 'answer' | 'cancel',
      explicitAnswers?: Array<{ id: string; selected: string[]; custom?: string }>,
    ) => {
      const card = msg?.card;
      if (!card || card.type !== 'question') return null;
      const answers = action === 'answer' ? explicitAnswers || buildSubmittedAnswersFromCard(card) : undefined;
      if (!native) {
        card.state = action === 'answer' ? 'answered' : 'cancelled';
        if (answers) card.answers = answers;
        return { ok: true, mode: 'preview' };
      }
      const conv = (C.convs || []).find((x: any) => (x.messages || []).includes(msg)) || C.cur;
      const sid = String(card.sessionId || conv?.dshSessionId || state.sessionId || '');
      const res = await command<any>('dsh_request', {
        endpoint: '/question/respond',
        body: {
          questionRequestId: card.questionRequestId,
          sessionId: sid,
          callId: card.callId,
          action,
          ...(answers ? { answers } : {}),
        },
      });
      card.state = action === 'answer' ? 'answered' : 'cancelled';
      if (answers) card.answers = answers;

      // When answering a question that had already transitioned to `continued`,
      // DSH steers a follow-up turn on the session — attach an activeTurn so the reply streams into chat.
      if (action === 'answer' && res?.mode === 'continued' && !activeTurn && conv && sid) {
        const followMsg: any = {
          id: A.uid(),
          role: 'assistant',
          text: '',
          status: 'thinking',
          steps: [],
          startedAt: Date.now(),
          time: Date.now(),
        };
        conv.messages.push(followMsg);
        conv.t = Date.now();
        if (C.cur === conv) C.append(followMsg);
        C.setGenerating(true);
        C.status('收到回答，正在继续…', 'busy');
        A.setBase?.('think');
        beginActiveTurn(conv, followMsg, sid, `kbot-qreply-${Date.now()}`);
      }
      A.save();
      return res;
    },
    listModels: async () => {
      if (!native) return { providers: [], current: null };
      const ok = state.connected || (await ensureConnected(C.cur?.dshSessionId || null));
      if (!ok) throw new Error(state.error || '尚未连接智能核心');
      const sid = C.cur?.dshSessionId || state.sessionId || null;
      const res = await command<any>('dsh_request', {
        endpoint: '/models/list',
        body: { sessionId: sid },
      });
      if (applyModelPayload(res?.current)) {
        syncModelFlag();
      }
      return {
        providers: Array.isArray(res?.providers) ? res.providers : Array.isArray(res?.groups) ? res.groups : [],
        current: res?.current || null,
      };
    },
    selectModel: async (provider: string, model: string, reasoningEffort?: string | null) => {
      if (!native) return null;
      const ok = state.connected || (await ensureConnected(C.cur?.dshSessionId || null));
      if (!ok) throw new Error(state.error || '尚未连接智能核心');
      const sid = C.cur?.dshSessionId || state.sessionId || null;
      const effort = typeof reasoningEffort === 'string' && reasoningEffort.trim() ? reasoningEffort.trim() : null;
      const res = await command<any>('dsh_request', {
        endpoint: '/session/select-model',
        body: {
          sessionId: sid,
          workspacePath: state.workspacePath,
          provider,
          model,
          ...(effort ? { reasoningEffort: effort } : {}),
        },
      });
      if (res?.sessionId && C.cur && !C.cur.dshSessionId) {
        C.cur.dshSessionId = String(res.sessionId);
        state.sessionId = C.cur.dshSessionId;
        A.save();
      }
      applyModelPayload(res?.model || { provider, model, ...(effort ? { reasoningEffort: effort } : {}) });
      syncModelFlag();
      return res?.model || null;
    },
  };

  // Desktop sensor handling: away/return detection, meeting auto-DND, and DSH context push
  A.on('sensors', (payload: any) => {
    if (!payload) return;
    if (A.S.senseIdle && typeof payload.idleSeconds === 'number') {
      if (payload.idleSeconds >= 300 && !A.away) {
        A.setAway(true);
      } else if (payload.idleSeconds < 15 && A.away) {
        A.setAway(false);
        if (Array.isArray(A.missed) && A.missed.length > 0) {
          const latest = A.missed.splice(0).pop();
          if (latest) {
            setTimeout(() => A.speak?.(latest), 1200);
          }
        }
      }
    } else if (!A.S.senseIdle && A.away) {
      A.setAway(false);
    }

    if (A.S.senseApp) {
      const cat = classifyFrontmostApp(payload.appName, payload.appId, A.S.apps);
      if (payload.appName && !payload.appName.toLowerCase().includes('kbot')) {
        lastFrontmostApp = payload.appName;
        lastFrontmostCat = cat;
      }
      A.setMeeting?.(cat === 'meeting');
    } else {
      lastFrontmostCat = null;
      lastFrontmostApp = null;
      if (A.meeting) A.setMeeting?.(false);
    }

    pushSensorContext(false);
  });

  ['dnd', 'away', 'set:nickname', 'set:persona', 'set:senseApp', 'set:senseIdle', 'set:send'].forEach(ev => {
    A.on(ev, () => {
      pushSensorContext(false);
    });
  });

  A.on('set:dsh', () => {
    ensureConnected(C.cur?.dshSessionId || null).catch(() => {});
  });

  A.init(async () => {
    if (native) {
      await listen<any>('dsh-event', ({ payload }) => handleDshEvent(payload));
      window.addEventListener('focus', () => {
        if (!state.connected || C.generating) return;
        const sid = C.cur?.dshSessionId || state.sessionId;
        if (!sid) return;
        command<any>('dsh_request', {
          endpoint: '/session/ensure',
          body: { workspacePath: state.workspacePath, sessionId: sid },
        })
          .then(res => {
            if (applyModelPayload(res?.model)) {
              syncModelFlag();
            }
            if (Array.isArray(res?.pendingQuestions)) {
              res.pendingQuestions.forEach((q: any) => attachPendingQuestion(q));
            }
          })
          .catch(() => {});
      });
    }
    ensureConnected(C.cur?.dshSessionId || null).catch(() => {});
  });
}
