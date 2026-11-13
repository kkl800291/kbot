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

export function formatToolStepLabel(name?: string, rawArgs?: any): string {
  const tool = String(name || 'tool').trim();
  const lower = tool.toLowerCase();
  const args = parseToolArgs(rawArgs);
  if (lower === 'ask_user_question' || lower.includes('ask_user')) {
    const firstHeader = Array.isArray(args?.questions) ? String(args.questions[0]?.header || '').trim() : '';
    return firstHeader ? `向你提问 · ${firstHeader}` : '向你提问 · 等待回答';
  }
  if (lower.includes('web_search') || lower.includes('search')) {
    const q = String(args?.query || args?.q || '').trim();
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
  if (lower.includes('edit') || lower.includes('write')) {
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
  if (lower.includes('bash') || lower.includes('pty') || lower.includes('shell')) {
    const cmd = String(args?.command || args?.cmd || '').trim().split(/\s+/)[0] || '';
    return cmd && cmd.length <= 20 ? `执行命令 · ${cmd}` : '执行终端命令';
  }
  return `调用工具 · ${tool}`;
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
  if (!text) return { message: 'DSH 执行出错', needModelConfig: false };
  const lower = text.toLowerCase();
  if (/account_sign_in_required|account_token_invalid/.test(lower)) {
    return { message: '请登录 DeepSeek 账号后重试。', needModelConfig: false, accountAction: 'sign-in' };
  }
  if (/account_quota/.test(lower)) {
    return { message: 'DeepSeek 账号额度不足，请到官方平台充值后重试。', needModelConfig: false, accountAction: 'top-up' };
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
      message: `当前模型通道${routeLabel}尚未配置 API Key。请点击「配置模型」打开 DeepSeek Harness 控制台填入 Key 或切换模型，保存后点「重试」即可。`,
      needModelConfig: true,
    };
  }
  return { message: text, needModelConfig: false };
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
    binaryPath: null,
    desktopPatchInstalled: false,
    error: null,
  };
  A.dshState = state;

  function applyModelPayload(raw: any): boolean {
    if (!raw || !raw.model) return false;
    const nextModel = String(raw.model);
    const nextLabel = formatModelDisplayName(nextModel, raw.displayName || raw.name);
    const nextProvider = raw.provider ? String(raw.provider) : state.provider;
    const nextProviderLabel = raw.providerName ? String(raw.providerName) : (nextProvider || state.providerLabel);
    const changed =
      state.model !== nextModel ||
      state.modelLabel !== nextLabel ||
      state.provider !== nextProvider ||
      state.providerLabel !== nextProviderLabel;
    state.model = nextModel;
    state.modelLabel = nextLabel;
    state.provider = nextProvider ?? null;
    state.providerLabel = nextProviderLabel ?? null;
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

  let activeTurn: {
    conv: any;
    msg: any;
    sessionId: string;
    requestId: string;
    parser: ReturnType<typeof createExpressionStreamParser>;
    sawText: boolean;
    cancelled: boolean;
    lastExpr: string | null;
    stepByCallId: Map<string, { kind?: string; t: string; done: boolean }>;
  } | null = null;

  const proactiveTurns = new Map<string, { text: string; sourceKind: string }>();
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
      state.model = state.modelLabel = state.provider = state.providerLabel = null;
    }
    syncModelFlag();
    if (Array.isArray(sess.pendingQuestions)) {
      sess.pendingQuestions.forEach((q: any) => attachPendingQuestion(q));
    }
  }

  async function pushSensorContext(force = false) {
    if (!native || !state.connected) return;
    const snapshot = {
      nickname: addressName(A.S.nickname),
      persona: personaHint(A.S.persona),
      away: Boolean(A.away),
      frontmostCategory: A.S.senseApp && lastFrontmostCat ? CATEGORY_LABELS[lastFrontmostCat] || lastFrontmostCat : '',
      frontmostApp: A.S.senseApp && A.S.send?.appName && lastFrontmostApp ? lastFrontmostApp : '',
      dnd: Boolean(A.isDnd?.()),
      dndLabel: A.dndLabel?.() || '',
      weather: A.weatherSummary?.() || '',
    };
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
      state.error = '浏览器预览模式暂不直连本机 DSH';
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
      throw new Error(state.error || '无法连接 DeepSeek Harness');
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

  function finishActiveTurn(status: 'done' | 'stopped' | 'error', errorMsg?: string) {
    if (!activeTurn) return;
    const turn = activeTurn;
    activeTurn = null;
    const rest = turn.parser.flush();
    if (rest) turn.msg.text += rest;
    if (status === 'done' && !turn.msg.text.trim() && Array.isArray(turn.msg.steps) && turn.msg.steps.length > 0) {
      const last = turn.msg.steps[turn.msg.steps.length - 1];
      if (last?.kind === 'note' && typeof last.t === 'string' && last.t.trim()) {
        turn.msg.steps.pop();
        turn.msg.text = last.t;
      }
    }
    if (Array.isArray(turn.msg.steps)) {
      turn.msg.steps.forEach((s: any) => {
        s.done = true;
      });
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
    const viaLabel = state.modelLabel || (state.model ? formatModelDisplayName(state.model) : '');
    if (viaLabel && !turn.msg.via) {
      turn.msg.via = `DSH · ${viaLabel}`;
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
      turn.msg.text.trim() &&
      A.S.voice?.enabled &&
      A.S.voice?.autoReply &&
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
      state.error = '与 DeepSeek Harness 的连接已断开，正在尝试重连…';
      if (activeTurn) {
        finishActiveTurn('error', 'DSH 连接中断，已保留当前输出');
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

    if (ev.type === 'question/request') {
      attachPendingQuestion(ev);
      return;
    }
    if (ev.type === 'question/resolved') {
      resolvePendingQuestion(ev);
      return;
    }

    // 1. Events belonging to the active user turn in KBOT's chat window
    if (activeTurn && sessionId === activeTurn.sessionId) {
      const m = activeTurn.msg;
      switch (ev.type) {
        case 'stream/reasoning':
          if (!activeTurn.sawText) {
            C.status('深度思考中…', 'busy');
            A.setBase?.('think');
          }
          break;
        case 'stream/text': {
          const clean = activeTurn.parser.push(String(ev.delta || ''));
          if (!clean) break;
          if (!activeTurn.sawText) {
            activeTurn.sawText = true;
            m.status = 'streaming';
            C.status('正在回复…', 'busy');
            A.setBase?.('talk');
          }
          m.text += clean;
          A.robot?.talkPulse?.();
          if (C.cur === activeTurn.conv) C.paintText(m);
          break;
        }
        case 'tool/call': {
          const flushed = activeTurn.parser.flush();
          const priorText = (m.text + flushed).trim();
          m.steps = m.steps || [];
          if (priorText) {
            m.steps.push({ kind: 'note', t: priorText, done: true });
            m.text = '';
            activeTurn.sawText = false;
            m.status = 'thinking';
          }
          const label = formatToolStepLabel(ev.name, ev.arguments);
          const step = { kind: 'tool', t: label, done: false };
          m.steps.push(step);
          if (ev.callId) activeTurn.stepByCallId.set(String(ev.callId), step);
          C.status(label, 'busy');
          A.setBase?.('think');
          if (C.cur === activeTurn.conv) C.paint(m);
          break;
        }
        case 'tool/result': {
          const step = ev.callId ? activeTurn.stepByCallId.get(String(ev.callId)) : undefined;
          if (step) step.done = true;
          const stillRunning = Array.isArray(m.steps) ? m.steps.find((s: any) => !s.done) : null;
          if (stillRunning) {
            C.status(stillRunning.t, 'busy');
          } else if (!activeTurn.sawText) {
            C.status('正在整理结果…', 'busy');
          }
          if (C.cur === activeTurn.conv) C.paint(m);
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
            const label = state.modelLabel || formatModelDisplayName(ev.model, ev.displayName);
            m.via = `DSH · ${label}`;
            if (changed) A.emit('dsh:state', { ...state });
            C.refreshComposer?.();
          }
          if (!activeTurn.sawText && typeof ev.text === 'string' && ev.text.trim()) {
            const parsed = extractExpressions(ev.text);
            m.text = parsed.text;
            if (parsed.lastExpr) activeTurn.lastExpr = parsed.lastExpr;
          }
          break;
        }
        case 'agent/error': {
          finishActiveTurn('error', ev.code?.startsWith('ACCOUNT_') ? ev.code : ev.message || 'DSH 执行出错');
          break;
        }
        case 'turn/end': {
          const cancelled = activeTurn.cancelled || ev.reason === 'cancelled' || ev.reason === 'interrupted';
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
      time: Date.now(),
    };
    conv.messages.push(m);
    conv.t = Date.now();
    C.append(m);
    C.setGenerating(true);
    C.status('思考中…', 'busy');
    A.setBase?.('think');

    const requestId = `kbot-${Date.now()}-${A.uid()}`;
    const parser = createExpressionStreamParser(expr => {
      if (activeTurn) activeTurn.lastExpr = expr;
      A.robot?.flash?.(expr, 2000);
    });

    try {
      const sessionId = await ensureConversationSession(conv);
      activeTurn = {
        conv,
        msg: m,
        sessionId,
        requestId,
        parser,
        sawText: false,
        cancelled: false,
        lastExpr: null,
        stepByCallId: new Map(),
      };
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
      await command('dsh_request', {
        endpoint: '/session/prompt',
        body: {
          sessionId,
          requestId,
          text: um.text || '',
          images: Array.isArray(um.images) ? um.images.map((im: any) => im.src) : [],
          clientTimeZone: tz,
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
          time: Date.now(),
        };
        conv.messages.push(followMsg);
        conv.t = Date.now();
        if (C.cur === conv) C.append(followMsg);
        C.setGenerating(true);
        C.status('收到回答，正在继续…', 'busy');
        A.setBase?.('think');
        const parser = createExpressionStreamParser(expr => {
          if (activeTurn) activeTurn.lastExpr = expr;
          A.robot?.flash?.(expr, 2000);
        });
        activeTurn = {
          conv,
          msg: followMsg,
          sessionId: sid,
          requestId: `kbot-qreply-${Date.now()}`,
          parser,
          sawText: false,
          cancelled: false,
          lastExpr: null,
          stepByCallId: new Map(),
        };
      }
      A.save();
      return res;
    },
    listModels: async () => {
      if (!native) return { providers: [], current: null };
      const ok = state.connected || (await ensureConnected(C.cur?.dshSessionId || null));
      if (!ok) throw new Error(state.error || '尚未连接 DeepSeek Harness');
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
    selectModel: async (provider: string, model: string) => {
      if (!native) return null;
      const ok = state.connected || (await ensureConnected(C.cur?.dshSessionId || null));
      if (!ok) throw new Error(state.error || '尚未连接 DeepSeek Harness');
      const sid = C.cur?.dshSessionId || state.sessionId || null;
      const res = await command<any>('dsh_request', {
        endpoint: '/session/select-model',
        body: {
          sessionId: sid,
          workspacePath: state.workspacePath,
          provider,
          model,
        },
      });
      if (res?.sessionId && C.cur && !C.cur.dshSessionId) {
        C.cur.dshSessionId = String(res.sessionId);
        state.sessionId = C.cur.dshSessionId;
        A.save();
      }
      applyModelPayload(res?.model || { provider, model });
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
