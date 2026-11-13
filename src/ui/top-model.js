/* KBOT · 屏幕顶部的布局与通知规则（纯逻辑，不碰 DOM） */

/**
 * @typedef {{ kind: string, label?: string, aux?: string, progress?: number, source?: string, surface?: string } | null} Act
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ act?: Act, expanded?: boolean, safeTop?: number, caption?: number, chatOffset?: { x: number, y: number }, bounds?: Rect, viewport?: Rect }} LayoutOpts
 */

// 能量体的舞台固定大小；透明宿主铺满屏幕，对话窗口可以移到舞台以外
export const WIN = { w: 1000, h: 740 };
// 内容区离顶边（顶边指菜单栏或刘海的下沿，不占它们的位置）
export const GAP = 10;
export const HOTZONE = { w: 300, h: 6 };
export const SPEECH_TTL = 10 * 60_000;
export const MAX_QUEUE = 5;
// 全屏待命空间中的内容：光球占上方，字幕和输入胶囊在下方。
// orbY：球心离内容区顶边多远；sight：球心落在屏幕高度的这个比例上（和概念图一样，约三分之一处）
export const SUMMON = { w: 1100, h: 506, max: 646, inputY: 416, input: 48, bottom: 42, caption: 140, orbY: 185, sight: 0.33 };
export const SUMMON_IDLE = 30_000;
// 鼠标离身体中心这么近，能量体才看向它
export const GAZE_R = 420;

/**
 * 内容区大小（宽、高）。隐身时高度为 0。caption 是召唤态字幕区的高度。
 * @param {string} state
 * @param {LayoutOpts} [opts]
 */
export function contentSize(state, { act = null, expanded = false, caption = 0 } = {}) {
  if (state === 'peek') return [340, 40];
  if (state === 'compact') {
    if (act?.kind === 'task') return [340, 52];
    return [act?.kind === 'error' ? 300 : 280, 40];
  }
  if (state === 'note') return [440, 116];
  if (state === 'summon') return [SUMMON.w, Math.min(SUMMON.max, SUMMON.h + Math.max(0, Math.round(caption)))];
  if (state === 'chat') return expanded ? [760, 620] : [540, 440];
  return [300, 0];
}

/**
 * 能量体身体在画布内的框：召唤态是主角，窗口里退成头像。
 * @param {string} state
 * @param {{ x: number, y: number, w: number, h: number }} c
 */
export function energyBox(state, c) {
  if (state === 'summon') {
    const w = Math.min(960, c.w - 64), h = Math.min(360, Math.max(100, c.h - 146));
    return [c.x + (c.w - w) / 2, c.y + 16, w, h];
  }
  if (state === 'chat') return [c.x + 10, c.y + 6, 40, 40];
  if (state === 'note') return [c.x + 14, c.y + 14, 88, 88];
  return [c.x + 10, c.y + 7, 26, 26];
}

/** 任务常驻条沿底边的进度带；其他状态没有。 */
export function bandBox(state, c, act = null) {
  return state === 'compact' && act?.kind === 'task' ? [c.x + 46, c.y + c.h - 14, c.w - 66, 8] : null;
}

// 衬底一律是边界清晰的圆角底板，不羽化：对话窗口和通知圆角 24，常驻条是一枚胶囊（圆角 20）
export const PANEL_R = 24;
export const BAR_R = 20;
// 召唤态没有整块衬底，光球直接浮在桌面上；只有字幕和输入框共用一张小卡片（相对内容区）
export const SUMMON_CARD = { x: 120, y: 320, w: 520, input: 48, r: 24 };

/**
 * 内容区、底板（舞台坐标，feather 恒为 0）、能量框、画布位移和进度带。
 * 底板：对话窗口、通知、常驻条就是内容区本身；召唤态只垫在字幕和输入框下面。
 * energyOffset 表示身体相对舞台基准的位移；绘制时换算到固定的屏幕画布，画布不随窗口移动。
 * @param {string} state
 * @param {LayoutOpts} [opts]
 */
export function layout(state, { act = null, expanded = false, safeTop = 0, caption = 0, chatOffset = { x: 0, y: 0 }, bounds, viewport = { x: 0, y: 0, w: WIN.w, h: WIN.h } } = {}) {
  let [w, h] = contentSize(state, { act, expanded, caption });
  let summon = null, summonTop = 0;
  if (state === 'summon') {
    w = Math.min(w, Math.max(280, viewport.w - 48));
    summonTop = Math.max(GAP + safeTop, Math.round(viewport.h * SUMMON.sight - SUMMON.orbY));
    const available = Math.max(0, viewport.h - summonTop - GAP);
    // 先为整段字幕留好空间，再确定输入框的位置；步骤与正文切换时不重新挪输入框或缩放生命体。
    // 156 = 生命体最小高度 100 + 顶边 16 + 输入框前的间距 40。
    const captionMax = Math.min(SUMMON.caption, Math.max(0, available - 156 - SUMMON.input - SUMMON.bottom));
    const inputY = Math.max(0, Math.min(SUMMON.inputY, available - SUMMON.input - SUMMON.bottom - captionMax));
    summon = { inputY, captionMax };
    h = inputY + SUMMON.input + SUMMON.bottom + Math.min(captionMax, Math.max(0, Math.round(caption)));
  }
  const content = { x: (WIN.w - w) / 2, y: GAP + safeTop, w, h };
  const box = energyBox(state, summon ? { ...content, h: summon.inputY + SUMMON.input + SUMMON.bottom } : content);
  const origin = { x: content.x, y: content.y };
  if (state === 'summon') content.y = viewport.y + summonTop;
  if (state === 'chat') {
    content.x += chatOffset.x;
    content.y += chatOffset.y;
    if (bounds) {
      content.x = Math.max(bounds.x, Math.min(content.x, bounds.x + Math.max(0, bounds.w - w)));
      content.y = Math.max(bounds.y, Math.min(content.y, bounds.y + Math.max(0, bounds.h - h)));
    }
  }
  const halo = state === 'summon'
    ? { ...viewport, feather: 0, radius: 0, standby: true, focusX: content.x + content.w / 2, focusY: box[1] + content.y - origin.y + box[3] / 2 }
    : { ...content, feather: 0, radius: state === 'chat' || state === 'note' ? PANEL_R : BAR_R };
  const energyOffset = state === 'chat' || state === 'summon' ? { x: content.x - origin.x, y: content.y - origin.y } : { x: 0, y: 0 };
  return { content, halo, box, energyOffset, band: bandBox(state, content, act), summon };
}

/** 身体和进度带从舞台坐标换到视口坐标；整段飞行动画共用同一块固定画布。 */
export function energyPlacement(L, origin = { x: 0, y: 0 }) {
  const dx = origin.x + L.energyOffset.x, dy = origin.y + L.energyOffset.y;
  const move = rect => [rect[0] + dx, rect[1] + dy, rect[2], rect[3]];
  return { box: move(L.box), band: L.band ? move(L.band) : null };
}

const ACT_MODE = { think: 'think', talk: 'talk', task: 'progress', error: 'error' };

/**
 * 能量体此刻该用的模式。
 * @param {string} state
 * @param {{ act?: Act, chatMode?: string, note?: { mode: string } | null }} [opts]
 */
export function energyMode(state, { act = null, chatMode = 'listen', note = null } = {}) {
  if (state === 'chat' || state === 'summon') return chatMode;
  if (state === 'note') return note?.mode || 'idle';
  if (state === 'compact' && act) return ACT_MODE[act.kind] || 'idle';
  return 'idle';
}

/** 陪伴话出现时先“开口”说一会儿：字数 × 60ms，限制在 0.8～3 秒。 */
export const talkMs = text => Math.max(800, Math.min(3000, String(text || '').length * 60));

/**
 * 收起召唤态、窗口或通知后：有进行中的事就回到常驻，否则隐身。
 * @param {Act} act
 */
export const settleState = act => (act ? 'compact' : 'hidden');

/** 快捷键：没召唤时召唤；召唤态或窗口里再按一次就收起。 */
export const hotkeyRoute = state => (state === 'summon' || state === 'chat' ? 'close' : 'summon');

/** 点常驻条：进行中的事来自窗口里的对话就回窗口，否则召唤。 */
export const barTarget = act => (act?.surface === 'chat' ? 'chat' : 'summon');

/** 回复结束后 30 秒没有悬停、没有输入、输入框为空，召唤态自动收起。 */
export const shouldAutoClose = ({ idle, hovering, empty, generating }) =>
  idle >= SUMMON_IDLE && !hovering && empty && !generating;

const GAZE_STATES = new Set(['summon', 'peek', 'note']);
/** 能量体该看的点：召唤、探出、通知时，鼠标在身体 420px 以内才看，否则 null。 */
export function gazeAt(state, box, x, y) {
  if (!GAZE_STATES.has(state) || !box) return null;
  const cx = box[0] + box[2] / 2, cy = box[1] + box[3] / 2;
  return Math.hypot(x - cx, y - cy) <= GAZE_R ? [x, y] : null;
}

// ---------- 召唤态字幕 ----------
const CJK = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * markdown 转成一段连续的字幕文字。代码块（含流式中没闭合的）、图片、表格都去掉，并记 rich。
 * @param {string} md
 */
export function plainText(md = '') {
  let rich = false;
  const mark = () => { rich = true; return '\n'; };
  let s = String(md || '').replace(/\r/g, '')
    .replace(/```[\s\S]*?(?:```|$)/g, mark)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, mark);
  s = s.split('\n').filter(l => {
    if (/^\s*\|/.test(l)) { rich = true; return false; }
    return !/^\s*(?:[-*_=]\s*){3,}$/.test(l);
  }).join('\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\d{1,2}\](?!\()/g, '')
    .replace(/`([^`\n]*)`?/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d{1,2}[.)])\s+/gm, '')
    .replace(/\*\*|__|~~/g, '')
    .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1$2');
  // 换行并成一段：挨着中文就直接接上，否则留一个空格
  s = s.replace(/[ \t]*\n+[ \t]*/g, (w, i, all) => (CJK.test(all[i - 1] || '') || CJK.test(all[i + w.length] || '') ? '' : ' '));
  return { text: s.replace(/[ \t]{2,}/g, ' ').trim(), rich };
}

/**
 * 一条回复在召唤态字幕里显示什么。
 * text：字幕正文；dim：没有正文时的一行淡色状态；rich：有字幕放不下的内容，总要给“在窗口中查看全文”。
 * @param {{ text?: string, status?: string, error?: string, card?: any, images?: any[], steps?: any[] } | null} m
 */
export function captionOf(m) {
  if (!m) return { text: '', dim: '', rich: false };
  const { text, rich } = plainText(m.text);
  const card = m.card?.type === 'question' || m.card?.type === 'approval' ? m.card : null;
  let dim = '';
  if (!text) {
    const step = (m.steps || []).find(s => s && s.kind !== 'note' && !s.done);
    if (card?.state === 'pending' && card.type === 'question') dim = '想请教您：' + (card.questions?.[0]?.question || '有件事需要您定夺');
    else if (card?.state === 'pending') dim = `需要您确认一项操作：${card.toolName || '工具调用'}`;
    else if (m.status === 'error') dim = m.error || '回复中断';
    else if (m.status === 'stopped') dim = '已停止生成';
    else if (step) dim = step.t;
  }
  return { text, dim, rich: rich || !!card || !!m.images?.length || m.status === 'error' };
}

/** 鼠标是否在顶边中央的感应区里。 */
export function inHotzone(x, y, safeTop = 0) {
  return y >= 0 && y <= HOTZONE.h + safeTop && Math.abs(x - WIN.w / 2) <= HOTZONE.w / 2;
}

export const inRect = (r, x, y) => !!r && r.h > 0 && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;

/**
 * 新通知到达时，当前正显示一条：
 * 当前是陪伴话，或者新来的是高优先级而当前不是，就顶掉当前；否则陪伴话直接丢弃，提醒排队。
 */
export function arrival(current, ev) {
  if (!current) return 'show';
  if (current.kind === 'speech' || (ev.pri === 'high' && current.pri !== 'high')) return 'replace';
  return (ev.kind || 'speech') === 'speech' ? 'drop' : 'queue';
}

/** 用户最近 2 秒内动过键盘鼠标，通知就先等一等。 */
export const shouldWait = idleSeconds => typeof idleSeconds === 'number' && idleSeconds < 2;

/** 排队中的通知：超过 5 条丢掉最早的陪伴话，提醒不丢；陪伴话等超过 10 分钟作废。 */
export function createNoteQueue() {
  const q = [];
  return {
    get size() { return q.length; },
    push(ev, now) {
      q.push({ ev, at: now });
      while (q.length > MAX_QUEUE) {
        const i = q.findIndex(n => (n.ev.kind || 'speech') === 'speech');
        if (i < 0) break;
        q.splice(i, 1);
      }
    },
    next(now) {
      for (let i = q.length - 1; i >= 0; i--) {
        if ((q[i].ev.kind || 'speech') === 'speech' && now - q[i].at > SPEECH_TTL) q.splice(i, 1);
      }
      return q.shift()?.ev || null;
    },
    clear() { q.length = 0; },
  };
}
