/* KBOT · 屏幕顶部的布局与通知规则（纯逻辑，不碰 DOM） */

/**
 * @typedef {{ kind: string, label?: string, aux?: string, progress?: number, source?: string, surface?: string } | null} Act
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ w: number, h: number }} Size
 * @typedef {{ act?: Act, expanded?: boolean, safeTop?: number, caption?: number, tall?: boolean, chatSize?: Size | null, chatOffset?: { x: number, y: number }, bounds?: Rect, viewport?: Rect }} LayoutOpts
 */

// 能量体的舞台固定大小；透明宿主铺满屏幕，对话窗口可以移到舞台以外
export const WIN = { w: 1000, h: 740 };
export const CHAT = { w: 540, h: 440, minW: 360, minH: 300 };
// 内容区离顶边（顶边指菜单栏或刘海的下沿，不占它们的位置）
export const GAP = 10;
export const HOTZONE = { w: 300, h: 6 };
export const SPEECH_TTL = 10 * 60_000;
export const MAX_QUEUE = 5;
// 全屏待命空间中的内容：光球占上方，富文本对话卡片在下方。
// orbY：球心离内容区顶边多远；sight：球心落在屏幕高度的这个比例上（上方留主视觉，下方给完整对话）
export const SUMMON = {
  w: 1100, h: 494, max: 954,
  inputY: 416, tallInputY: 304, input: 48, bottom: 30, caption: 460, tallCaption: 560, orbY: 185, sight: 0.28,
};
export const SUMMON_IDLE = 30_000;
// 鼠标离身体中心这么近，能量体才看向它
export const GAZE_R = 420;

/**
 * 内容区大小（宽、高）。隐身时高度为 0。caption 是召唤态对话区的高度。
 * @param {string} state
 * @param {LayoutOpts} [opts]
 */
export function contentSize(state, { act = null, caption = 0, tall = false, chatSize = null } = {}) {
  if (state === 'peek') return [340, 40];
  if (state === 'compact') {
    if (act?.kind === 'task') return [340, 52];
    return [act?.kind === 'error' ? 300 : 280, 40];
  }
  if (state === 'note') return [440, 116];
  if (state === 'summon') {
    const base = tall ? SUMMON.tallInputY + SUMMON.input + SUMMON.bottom : SUMMON.h;
    const cap = tall ? SUMMON.tallCaption : SUMMON.caption;
    return [SUMMON.w, base + Math.min(cap, Math.max(0, Math.round(caption)))];
  }
  if (state === 'chat') {
    const w = Number(chatSize?.w), h = Number(chatSize?.h);
    return [
      Number.isFinite(w) && w > 0 ? Math.max(CHAT.minW, Math.round(w)) : CHAT.w,
      Number.isFinite(h) && h > 0 ? Math.max(CHAT.minH, Math.round(h)) : CHAT.h,
    ];
  }
  return [300, 0];
}

/** 对话窗口可活动的屏幕范围。传入 bounds 时用它，否则用视口减去顶边和四周留白。 */
export function chatFrame({ safeTop = 0, bounds, viewport = { x: 0, y: 0, w: WIN.w, h: WIN.h } } = {}) {
  if (bounds) return bounds;
  return {
    x: viewport.x + GAP,
    y: viewport.y + GAP + safeTop,
    w: Math.max(0, viewport.w - GAP * 2),
    h: Math.max(0, viewport.h - GAP * 2 - safeTop),
  };
}

/** 未放大时，对话窗口在可活动范围内水平、垂直居中。 */
export function chatRest(w, h, frame) {
  return {
    x: frame.x + Math.max(0, (frame.w - w) / 2),
    y: frame.y + Math.max(0, (frame.h - h) / 2),
  };
}

/**
 * 能量体身体在画布内的框：召唤态是主角，窗口里退成头像。
 * @param {string} state
 * @param {{ x: number, y: number, w: number, h: number }} c
 */
export function energyBox(state, c) {
  if (state === 'summon') {
    const w = Math.min(960, c.w - 64), h = Math.min(360, Math.max(100, c.h - 134));
    return [c.x + (c.w - w) / 2, c.y + 16, w, h];
  }
  if (state === 'chat') return [c.x + 10, c.y + 7, 40, 40];
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
export function layout(state, { act = null, expanded = false, safeTop = 0, caption = 0, tall = false, chatSize = null, chatOffset = { x: 0, y: 0 }, bounds, viewport = { x: 0, y: 0, w: WIN.w, h: WIN.h } } = {}) {
  let [w, h] = contentSize(state, { act, caption, tall, chatSize });
  const frame = chatFrame({ safeTop, bounds, viewport });
  if (state === 'chat') {
    if (expanded) {
      w = frame.w;
      h = frame.h;
    } else {
      if (frame.w > 0) w = Math.min(w, Math.max(1, frame.w));
      if (frame.h > 0) h = Math.min(h, Math.max(1, frame.h));
    }
  }
  let summon = null, summonTop = 0;
  if (state === 'summon') {
    w = Math.min(w, Math.max(280, viewport.w - 48));
    summonTop = Math.max(GAP + safeTop, Math.round(viewport.h * SUMMON.sight - SUMMON.orbY));
    const available = Math.max(0, viewport.h - summonTop - GAP);
    // 优先保证光球舞台，下方剩余高度全部留给可滚动对话区；156 = 生命体最小高度 100 + 顶边 16 + 输入框前的间距 40。
    const minCaption = Math.min(140, Math.max(0, available - 156 - SUMMON.input - SUMMON.bottom));
    const baseInputY = tall ? SUMMON.tallInputY : SUMMON.inputY;
    const inputY = Math.max(0, Math.min(baseInputY, available - SUMMON.input - SUMMON.bottom - minCaption));
    const capLimit = tall ? SUMMON.tallCaption : SUMMON.caption;
    const captionMax = Math.min(capLimit, Math.max(minCaption, available - inputY - SUMMON.input - SUMMON.bottom));
    summon = { inputY, captionMax, tall: !!tall };
    h = inputY + SUMMON.input + SUMMON.bottom + Math.min(captionMax, Math.max(0, Math.round(caption)));
  }
  const content = state === 'chat'
    ? { ...(expanded ? { x: frame.x, y: frame.y } : chatRest(w, h, frame)), w, h }
    : { x: (WIN.w - w) / 2, y: GAP + safeTop, w, h };
  const box = energyBox(state, summon ? { ...content, h: summon.inputY + SUMMON.input + SUMMON.bottom } : content);
  const origin = { x: content.x, y: content.y };
  if (state === 'summon') content.y = viewport.y + summonTop;
  if (state === 'chat' && !expanded) {
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

/**
 * 拖动对话窗口边缘/角缩放矩形，保持对侧不动并限制在最小尺寸与活动边界内。
 * @param {Rect} start
 * @param {string} edge
 * @param {number} dx
 * @param {number} dy
 * @param {Rect | null} [bounds]
 * @param {{ minW?: number, minH?: number }} [limits]
 */
export function resizeChatRect(start, edge, dx, dy, bounds = null, { minW = CHAT.minW, minH = CHAT.minH } = {}) {
  let left = start.x, right = start.x + start.w;
  let top = start.y, bottom = start.y + start.h;
  const minWidth = bounds ? Math.min(minW, Math.max(1, bounds.w)) : minW;
  const minHeight = bounds ? Math.min(minH, Math.max(1, bounds.h)) : minH;

  if (edge.includes('w')) {
    left = Math.min(right - minWidth, start.x + dx);
    if (bounds) left = Math.max(bounds.x, left);
  } else if (edge.includes('e')) {
    right = Math.max(left + minWidth, start.x + start.w + dx);
    if (bounds) right = Math.min(bounds.x + bounds.w, right);
  }

  if (edge.includes('n')) {
    top = Math.min(bottom - minHeight, start.y + dy);
    if (bounds) top = Math.max(bounds.y, top);
  } else if (edge.includes('s')) {
    bottom = Math.max(top + minHeight, start.y + start.h + dy);
    if (bounds) bottom = Math.min(bounds.y + bounds.h, bottom);
  }

  return { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
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

/** 回复结束后 30 秒没有悬停、没有输入、没有持续语音、输入框为空，召唤态自动收起。 */
export const shouldAutoClose = ({ idle, hovering, empty, generating, voiceActive = false }) =>
  idle >= SUMMON_IDLE && !hovering && empty && !generating && !voiceActive;

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

/** 还没有任何输出时，字幕那一行淡色状态：先“正在思考…”，等得久了加上时间，再久就提示可以停止。 */
export function waitLine(ms) {
  const sec = Math.floor(Math.max(0, ms) / 1000);
  if (sec < 5) return '正在思考…';
  if (sec < 20) return `正在思考… ${sec} 秒`;
  return `还在等回复… ${sec} 秒，太久可以点右侧停止`;
}

/** 重新唤起时是否另起一个新对话：当前对话有消息、没在回复，且距最后一条消息超过 afterMin 分钟。0 表示从不自动新建。 */
export function shouldStartFresh({ lastTime, now, afterMin, generating = false }) {
  if (!afterMin || generating || !Number.isFinite(lastTime)) return false;
  return now - lastTime >= afterMin * 60_000;
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
