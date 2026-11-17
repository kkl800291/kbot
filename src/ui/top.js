/* KBOT · 屏幕顶部：圆角底板、六个状态（召唤态为主，对话窗口另有入口）、通知排队、能量体；勿扰、离开、隐藏。
   旧桌宠、对话面板、气泡的对外接口（A.panel 现在表示对话窗口、A.bubble、A.speak、A.robot、A.setBase…）保留，调用方不用改 */
import { command, listen } from '../services/runtime';
import { addressName, personaHint } from '../services/persona';
import { buildRealtimeInstructions, extractDshBridgeDirective, normalizeSpokenBrand, resolveSummonVoiceBackend } from '../services/voice';
import { createEnergy } from './energy.js';
import { uiAccent } from './accent.js';
import {
  arrival, barTarget, chatRest, contentSize, createNoteQueue, energyMode, energyPlacement, GAP, gazeAt, hotkeyRoute, inHotzone, inRect, layout,
  resizeChatRect, settleState, shouldAutoClose, shouldStartFresh, shouldWait, SUMMON, SUMMON_IDLE, talkMs, WIN,
} from './top-model.js';

(function () {
  'use strict';
  const A = window.App, { $, h } = A;
  const stage = $('#stage'), contentEl = $('#topContent'), haloEl = $('#halo'), energyEl = $('#energy');
  const barLabel = $('#tLabel'), barAux = $('#tAux'), bar = $('#tBar');
  const noteEl = $('#tNote'), noteTitle = $('#tNoteTitle'), noteBody = $('#tNoteBody'), noteActs = $('#tNoteActs');
  const summonEl = $('#summon'), capEl = $('#sCap'), capBar = $('#sCapBar'), titleEl = $('#sTitle');
  const tallBtn = $('#sTall'), newBtn = $('#sNew'), scrollEl = $('#sScroll'), threadEl = $('#sThread');
  const noteSlot = $('#sNoteSlot'), interimEl = $('#sInterim');
  const sMic = $('#sMic'), sInput = $('#sInput'), sBtn = $('#sBtn');
  const panel = $('#panel'), input = $('#input');
  const standbyEl = $('#standby');
  const PALETTES = ['molten', 'aurora', 'iri'];

  A.hidden = false; A.away = false; A.meeting = false;
  A.dnd = { until: 0 };
  A.missed = [];

  // cap：召唤态对话区高度；tall：是否展开更多阅读空间；surface：进行中的回复最后是在召唤态还是窗口里看的
  const T = { state: 'hidden', act: null, chatMode: 'listen', note: null, safeTop: 0, notch: 0, area: 0, layout: null, moving: false, cap: 0, tall: false, surface: 'summon', chatOffset: { x: 0, y: 0 } };
  const V = { mode: 'off', phase: 'off', wanted: false, manualTyping: false, prompting: false, dictTimer: 0, resumeTimer: 0, rtTurn: null, bridging: null };
  const notes = createNoteQueue();
  const energy = A.energy = createEnergy(energyEl, {
    palette: PALETTES.includes(A.S.palette) ? A.S.palette : 'molten', reduced: !!A.S.reduced,
  });

  // ---------- 衬底 ----------
  // 原生模式：系统模糊视图垫在网页下面，裁成和底板一样的圆角矩形，网页只画一层着色把底色拉平。
  // 原生不可用（浏览器预览或创建失败）就由网页自己画整块衬底。
  // 屏幕顶部的界面不跟系统深浅走：底板始终是中性的烟灰玻璃，光直接叠在上面
  const toneFor = () => 'dark';
  let nativeBackdrop = !!A.native, hideTimer = 0, lastStandby = false;
  const cssBackdrop = () => { stage.classList.add('css-backdrop'); standbyEl.classList.add('css-backdrop'); };
  if (!nativeBackdrop) cssBackdrop();
  if (A.native) {
    addEventListener('pagehide', () => {
      if (nativeBackdrop) command('set_backdrop', { backdrop: { x: 0, y: 0, w: 0, h: 0, feather: 0, radius: 0, visible: false, duration: 0, spring: false, standby: false } }).catch(() => {});
    });
  }
  /** fade：原位淡入淡出（出现、收回）；否则是两种底板之间的变形，时长和网页那层一致。 */
  function backdrop(halo, visible, grow, immediate = false, fade = false) {
    if (!halo) return;
    if (!nativeBackdrop) return;
    const r = stage.getBoundingClientRect();
    const args = {
      x: r.left + halo.x, y: r.top + halo.y, w: halo.w, h: Math.max(1, halo.h), feather: halo.feather, radius: halo.radius || 0, visible, standby: !!halo.standby,
      // 待命空间的衬底整体淡入淡出，和网页那层暮色同一个节奏
      duration: immediate || (lastStandby && !halo.standby) ? 0 : A.S.reduced ? 0.15 : halo.standby ? (visible ? 0.5 : 0.58) : fade ? 0.3 : 0.44, spring: false,
    };
    lastStandby = !!halo.standby;
    command('set_backdrop', { backdrop: args }).catch(err => {
      console.warn('[top] 原生衬底不可用，改用网页衬底', err);
      nativeBackdrop = false;
      cssBackdrop();
    });
    clearTimeout(hideTimer);
    // 淡出结束后把系统模糊视图真正藏起来，不再参与合成
    if (!visible) hideTimer = setTimeout(() => {
      if (T.state === 'hidden' && nativeBackdrop) command('set_backdrop', { backdrop: { ...args, duration: 0 } }).catch(() => {});
    }, halo.standby ? (A.S.reduced ? 180 : 640) : 460);
  }

  /** 待命空间里球背后那一小片压深的暮色对准球的位置。衬底本身是整体淡入淡出的，不从哪里铺开。 */
  function aimDusk(halo) {
    if (!halo?.standby) return;
    standbyEl.style.setProperty('--focus-x', halo.focusX - halo.x + 'px');
    standbyEl.style.setProperty('--focus-y', halo.focusY - halo.y + 'px');
  }

  // ---------- 状态 ----------
  function screenFrame() {
    const r = stage.getBoundingClientRect(), top = GAP + T.safeTop;
    return { x: GAP - r.left, y: top - r.top, w: Math.max(0, innerWidth - GAP * 2), h: Math.max(0, innerHeight - top - GAP) };
  }
  function currentLayout(st) {
    const r = stage.getBoundingClientRect();
    return layout(st, {
      act: T.act, expanded: !!A.S.expanded, safeTop: T.safeTop, caption: T.cap, tall: T.tall, chatSize: A.S.chatSize, chatOffset: T.chatOffset,
      bounds: screenFrame(),
      viewport: { x: -r.left, y: -r.top, w: innerWidth, h: innerHeight },
    });
  }
  function rememberPanelPosition(c) {
    if (A.S.expanded) return;
    const rest = chatRest(c.w, c.h, screenFrame());
    T.chatOffset = { x: c.x - rest.x, y: c.y - rest.y };
  }
  let motionTimer = 0, pinTimer = 0;
  const isPlate = st => st === 'peek' || st === 'compact' || st === 'note' || st === 'chat';
  const elOf = st => (st === 'chat' ? panel : st === 'note' ? noteEl : st === 'summon' ? summonEl : isPlate(st) ? bar : null);
  // 变形途中，内容不跟着底板的大小重排：旧内容按原来的大小留在原地淡出，新内容一开始就是最终的大小，都靠顶居中
  const pin = (el, w, h) => Object.assign(el.style, { left: '50%', marginLeft: -w / 2 + 'px', width: w + 'px', height: h + 'px' });
  const unpin = el => { if (el) Object.assign(el.style, { left: '', marginLeft: '', width: '', height: '' }); };
  function setState(st) {
    if (A.hidden && st !== 'hidden') return;
    const prev = T.state;
    T.state = st;
    const L = currentLayout(st);
    const c = L.content, visible = c.h > 0, area = c.w * c.h, grow = area >= T.area;
    if (st === 'chat') rememberPanelPosition(c);
    T.area = area;
    // 两种底板之间（常驻条、通知、对话窗口）：内容区和底板用同一条曲线一起变形，和原生那层的曲线一致
    const morph = isPlate(prev) && isPlate(st);
    const tr = A.S.reduced ? '.15s ease' : '.44s cubic-bezier(.4, 0, .2, 1)';
    // 同一个状态里尺寸变了（召唤态字幕长高、对话窗口放大）也跟着平滑过去
    contentEl.style.transition = morph || prev === st ? `left ${tr}, top ${tr}, width ${tr}, height ${tr}, border-radius ${tr}` : 'none';
    // 收回隐身时内容区留在原地淡出，不先塌成一条线
    if (visible) Object.assign(contentEl.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px', borderRadius: (L.halo.radius || 0) + 'px' });
    clearTimeout(pinTimer);
    const out = elOf(prev), inn = elOf(st), swap = morph && out !== inn;
    if (swap && T.layout) {
      pin(out, T.layout.content.w, T.layout.content.h);
      pin(inn, c.w, c.h);
      pinTimer = setTimeout(() => unpin(inn), A.S.reduced ? 200 : 500);
    } else unpin(inn);
    stage.classList.toggle('morph', swap);
    if (st === 'summon') {
      capEl.style.transition = `height ${tr}`; capEl.style.height = Math.min(T.cap, L.summon.captionMax) + 'px';
      summonEl.style.transition = prev === 'summon' ? `opacity .3s ease, padding-top ${tr}, visibility 0s` : '';
      summonEl.style.setProperty('--summon-top', L.summon.inputY + 'px');
      summonEl.classList.toggle('tall', !!L.summon.tall);
    } else summonEl.style.transition = '';
    const halo = visible ? L.halo : T.layout?.halo;
    // 底板只给常驻条、通知、对话窗口用。待命空间没有底板：整片暮色画在 #standby 上，自己淡入淡出
    const plate = !!halo && !halo.standby;
    if (plate) {
      // 出现和收回都在原位淡入淡出，不从顶边伸出来、缩回去；只有两种底板之间互相切换时才变形
      haloEl.style.transition = morph ? `left ${tr}, top ${tr}, width ${tr}, height ${tr}, --r ${tr}, --panel-a ${tr}, opacity .3s` : `opacity ${prev === 'summon' ? '.45s' : '.3s'} ease`;
      if (visible) {
        Object.assign(haloEl.style, { left: halo.x + 'px', top: halo.y + 'px', width: halo.w + 'px', height: halo.h + 'px' });
        haloEl.style.setProperty('--r', (halo.radius || 0) + 'px');
      }
    }
    haloEl.classList.toggle('vis', visible && plate);
    aimDusk(halo);
    backdrop(halo, visible, grow, false, !morph);
    if (visible) T.layout = L;
    stage.dataset.s = st;
    // 从隐身出现：内容和底板一起淡入，不用等变形
    stage.dataset.fresh = prev === 'hidden' ? '1' : '';
    standbyEl.classList.toggle('vis', st === 'summon');
    standbyEl.inert = st !== 'summon';
    standbyEl.setAttribute('aria-hidden', String(st !== 'summon'));
    stage.dataset.act = T.act?.kind || '';
    contentEl.inert = !visible;
    summonEl.inert = st !== 'summon';

    T.moving = true;
    A.emit('panelmotion', true);
    clearTimeout(motionTimer);
    motionTimer = setTimeout(() => { T.moving = false; stage.classList.remove('morph'); A.emit('panelmotion', false); }, A.S.reduced ? 180 : 480);

    if (visible) {
      placeEnergy(L);
      if (prev === 'hidden') energy.start();
    } else energy.stop();
    syncMode();
    renderBar();
    A.emit('top', st);
  }

  function placeEnergy(L, { immediate = false } = {}) {
    const r = stage.getBoundingClientRect(), at = energyPlacement(L, { x: r.left, y: r.top });
    if (energy.setBand) {
      energy.setBox(at.box, { immediate });
      energy.setBand(at.band);
    }
    // 能量体还没有进度带接口时，任务条仍把整个身体铺成底边的带子
    else energy.setBox(at.band || at.box, { immediate });
    if (energy.setEdge) {
      if (T.state === 'summon') energy.setEdge(null, { immediate });
      else if (T.state === 'chat' && L?.halo) energy.setEdge([r.left + L.halo.x, r.top + L.halo.y, L.halo.w, L.halo.h, L.halo.radius || 24], { immediate });
      else energy.setEdge(false, { immediate });
    }
  }

  function syncMode() {
    energy.setMode(energyMode(T.state, { act: T.act, chatMode: T.chatMode, note: T.note }));
  }

  /** 收起对话或通知后：有排队的通知就接着出；有进行中的事回到常驻，否则隐身。 */
  function settle() {
    if (A.hidden) return;
    setState(settleState(T.act));
    setTimeout(pump, 500);
  }

  // ---------- 常驻条和探出 ----------
  function peekLine() {
    const st = A.proactive?.state?.(), mins = Math.round(st?.activeMinutes || 0);
    const left = typeof st?.nextBreakMinutes === 'number' ? st.nextBreakMinutes : 0;
    if (!mins) return '一切就绪，随时找我';
    return `已专注 ${mins} 分钟` + (A.S.aiCompanion !== false && left ? ` · ${left} 分钟后提醒休息` : '');
  }
  function renderBar() {
    if (T.state === 'peek') {
      barLabel.textContent = T.act ? T.act.label : peekLine();
      barAux.textContent = T.act?.aux || A.hm(new Date());
    } else if (T.act) {
      barLabel.textContent = T.act.label;
      barAux.textContent = T.act.aux || '';
    }
  }

  function startAct(act) {
    T.act = act;
    if (act.kind === 'task') energy.setProgress(act.progress || 0);
    if (T.state === 'hidden' || T.state === 'peek' || T.state === 'compact') setState('compact');
    else { stage.dataset.act = act.kind; syncMode(); }
    renderBar();
  }
  function endAct(kind) {
    if (!T.act || (kind && T.act.kind !== kind)) return;
    T.act = null;
    if (T.state === 'compact') settle();
    else stage.dataset.act = '';
  }
  /** source：只在当前这件事是它发起的时候才改，免得改到别人的条上。 */
  function updateAct(patch, source) {
    if (!T.act || (source && T.act.source !== source)) return;
    Object.assign(T.act, patch);
    if (patch.progress != null) energy.setProgress(patch.progress);
    renderBar();
  }

  // 探出条进召唤态；常驻条回到那件事所在的地方；“正在朗读”的常驻条点一下就停
  const openBar = () => {
    if (T.state === 'compact' && T.act?.source === 'voice') { A.voice?.stop?.(); return; }
    if (T.state === 'compact' && barTarget(T.act) === 'chat') A.panel.open(); else A.summon.open();
  };
  bar.addEventListener('click', openBar);
  bar.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBar(); } });
  contentEl.addEventListener('contextmenu', e => {
    if (T.state === 'chat' || e.target.closest('input, textarea, .s-thread, .s-note-slot, .s-interim')) return;
    e.preventDefault();
    A.openContextMenu?.(e.clientX, e.clientY);
  });

  // ---------- 通知 ----------
  const DUR = { remind: 12000, speech: 8500 };
  let noteTimer = 0, flashTimer = 0, idleTimer = 0, talkTimer = 0, pumping = false;

  function armNote(after) {
    clearTimeout(noteTimer);
    const n = T.note;
    if (!n || n.ev.sticky) return;
    const ms = after ? (n.kind === 'speech' ? 2500 : 6000) : n.ev.dur || DUR[n.kind] || 8500;
    noteTimer = setTimeout(() => dismiss('expire'), ms);
  }

  function mountNote(ev) {
    const kind = ev.kind || 'speech';
    // 陪伴话先“开口”说一会儿再回到待命；提醒用提醒形态
    const talk = !ev.mode && kind === 'speech';
    const n = T.note = { ev, kind, pri: ev.pri, mode: ev.mode || (kind === 'remind' ? 'remind' : talk ? 'talk' : 'idle') };
    clearTimeout(talkTimer);
    if (talk) talkTimer = setTimeout(() => { if (T.note === n) { n.mode = 'idle'; syncMode(); } }, talkMs(ev.text));
    noteTitle.textContent = (ev.silent ? '勿扰中 · ' : '') + (ev.title || (kind === 'remind' ? '提醒' : 'KBOT'));
    noteBody.textContent = ev.text || '';
    noteActs.replaceChildren(...(ev.actions || []).slice(0, 2).map(a => h('button', {
      class: 'btn sm' + (a.primary ? ' primary' : ''),
      onclick: e => {
        e.stopPropagation();
        dismiss('action');
        try { a.fn?.(); } finally { if (!a.quiet) energy.accent(a.expr || 'happy'); }
      },
    }, a.label)));
    if (ev.ring) noteActs.append(A.makeRing());
    noteEl.dataset.kind = kind;
    setState('note');
    if (ev.expr && T.note.mode !== 'remind') energy.accent(ev.expr);
    armNote(false);
  }

  function dismiss(why = 'action') {
    const n = T.note;
    if (!n) return;
    T.note = null;
    clearTimeout(noteTimer); clearTimeout(flashTimer); clearTimeout(talkTimer);
    A.emit('bubble:dismiss', why, n.ev);
    if ((why === 'expire' || why === 'preempt') && n.ev.onExpire) n.ev.onExpire();
    if (why !== 'preempt' && T.state === 'note') settle();
  }

  // 通知到点时用户正在操作键盘鼠标，就每秒看一次，等空闲满 2 秒再出现
  async function userBusy() {
    if (!A.native || !A.S.senseIdle) return false;
    try { return shouldWait(await command('idle_seconds')); } catch { return false; }
  }
  // 召唤态和窗口里不弹通知：召唤态里正在回复时来的通知先排队，收起后再出
  const engaged = () => T.state === 'chat' || T.state === 'summon';
  function pump() {
    if (pumping || A.hidden || T.note || engaged() || !notes.size) return;
    if (!A.native || !A.S.senseIdle) {
      const ev = notes.next(Date.now());
      if (ev) mountNote(ev);
      return;
    }
    pumping = true;
    userBusy().then(busy => {
      pumping = false;
      if (A.hidden || T.note || engaged()) return;
      if (busy) { clearTimeout(idleTimer); idleTimer = setTimeout(pump, 1000); return; }
      const ev = notes.next(Date.now());
      if (ev) mountNote(ev);
    });
  }

  // 点通知正文进召唤态，文字成为字幕；指向某段对话的通知开窗口。
  // 回复完成的通知（带 msgId）回到这条回复最后被看的地方
  noteEl.addEventListener('click', e => {
    if (e.target.closest('button, a') || !T.note) return;
    const ev = T.note.ev;
    if (ev.rich || (ev.convId && !(ev.msgId && T.surface === 'summon'))) A.panel.open(); else A.summon.open();
  });
  noteEl.addEventListener('mousedown', e => e.preventDefault());

  A.bubble = {
    show(ev) {
      if (A.hidden) return false;
      // 召唤态里：字幕正显示着的那条回复不再重复通知；没在回复就直接成为字幕，否则排队等收起
      if (T.state === 'summon') {
        if (ev.msgId && ev.msgId === S.msg?.id) return true;
        if (!A.chat?.generating) { showNote(ev); scheduleSummonSync(true); armAuto(); return true; }
      }
      const r = arrival(T.note && { kind: T.note.kind, pri: T.note.pri }, ev);
      if (r === 'drop') return false;
      if (r === 'replace') { dismiss('preempt'); mountNote(ev); return true; }
      notes.push(ev, Date.now());
      pump();
      return true;
    },
    hide() { notes.clear(); dismiss('hide'); },
    close() { dismiss('hide'); },
    hideSpeech() { if (T.note?.kind === 'speech') dismiss('hide'); },
    // 打开窗口或召唤时，正在显示（queue 为真时也包括正等着出现）的通知搬过去，并保留按钮
    takeover(queue = true) {
      const n = T.note;
      if (!n) return queue ? notes.next(Date.now()) : null;
      T.note = null;
      clearTimeout(noteTimer); clearTimeout(flashTimer); clearTimeout(talkTimer);
      A.emit('bubble:dismiss', 'hide', n.ev);
      return n.ev;
    },
    /** 取出所有排队中的通知（展开对话时把它们放进对话）。 */
    drain() {
      const out = [];
      for (let ev = notes.next(Date.now()); ev; ev = notes.next(Date.now())) out.push(ev);
      return out;
    },
    // 在当前通知里临时换一句话，过一会儿恢复原文
    flashText(text, ms) {
      const n = T.note;
      if (!n) return false;
      noteBody.textContent = text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { if (T.note === n) noteBody.textContent = n.ev.text; }, ms);
      return true;
    },
    current: () => T.note && { kind: T.note.kind, ev: T.note.ev },
    place() {},
  };

  // ---------- 召唤态：光纹生命体为主角，下方承接可滚动富文本完整对话 ----------
  // msg：当前跟进的回复；note：跨会话的外部通知（仅在指向其他会话时单独渲染）；
  // interim：语音实时输入草稿；replied：有过回复，可以开始计时自动收起；hold：进行中对话区到过的最高高度
  const S = { msg: null, note: null, pro: null, interim: '', replied: false, active: 0, hold: 0 };
  let closeTimer = 0, focusTimer = 0, autoTimer = 0, capTimer = 0, captionFrame = 0, threadMounted = false, stickBottom = true, base = 'idle';
  const focusInput = () => { if (!input.disabled) input.focus({ preventScroll: true }); };
  const focusSummon = () => { if (T.state === 'summon') { sInput.focus({ preventScroll: true }); sInput.select(); } };
  const agentAct = () => ({ kind: 'think', label: base === 'talk' ? '正在回复…' : '正在思考…', source: 'agent', surface: T.surface });
  const MODS = ['Shift', 'Meta', 'Alt', 'Control', 'CapsLock', 'Escape', 'Tab'];

  function follow(m) { S.msg = m || null; S.note = null; S.pro = null; S.hold = 0; renderNoteSlot(); }
  const lastReply = () => [...(A.chat.cur?.messages || [])].reverse().find(m => m.role === 'assistant' && (m.status === 'thinking' || m.status === 'streaming'));
  const hasPendingCard = () => !!A.chat?.cur?.messages?.some(m => m?.card && (m.card.state === 'pending' || m.card.state === 'submitting'));

  function syncTallBtn() {
    if (!tallBtn) return;
    tallBtn.innerHTML = A.icon(T.tall ? 'shrink' : 'expand', 13);
    const tip = T.tall ? '恢复常规高度' : '展开更多阅读空间';
    tallBtn.title = tip;
    tallBtn.setAttribute('aria-label', tip);
    tallBtn.setAttribute('aria-pressed', String(T.tall));
  }

  function revealSummonMsg(id) {
    if (!id) return;
    const el = threadEl.querySelector(`.msg[data-id="${id}"]`);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  }

  function renderNoteSlot() {
    if (!noteSlot) return;
    if (!S.note) {
      noteSlot.hidden = true;
      noteSlot.replaceChildren();
      return;
    }
    const ev = S.note;
    const card = A.chat?.proElFromEvent?.(ev);
    if (!card) { noteSlot.hidden = true; return; }
    if (ev.convId && ev.convId !== A.chat?.cur?.id) {
      let btns = card.querySelector('.m-btns');
      if (!btns) { btns = h('div', { class: 'm-btns' }); card.append(btns); }
      btns.append(h('button', {
        class: 'btn sm ghost',
        onclick: () => {
          S.note = null;
          renderNoteSlot();
          A.chat.switchTo(ev.convId);
          if (ev.msgId) requestAnimationFrame(() => revealSummonMsg(ev.msgId));
        },
      }, '切换至所属对话'));
    }
    noteSlot.replaceChildren(card);
    noteSlot.hidden = false;
  }

  function renderInterim() {
    if (!interimEl) return;
    const live = S.interim.trim();
    interimEl.textContent = live ? `正在听：${live}` : '';
    interimEl.hidden = !live;
  }

  function showNote(ev) {
    const C = A.chat, m = ev.msgId && C.find(ev.msgId);
    // 回复完成的通知：直接滚动到那条回复
    if (m) {
      follow(m); S.replied = true; S.active = Date.now();
      requestAnimationFrame(() => revealSummonMsg(m.id));
      return;
    }
    follow(null);
    if (!ev.convId || ev.convId === C.cur?.id) {
      C.pushPro(ev);
      S.pro = C.cur.messages.at(-1);
    } else {
      S.note = ev;
      renderNoteSlot();
    }
    S.replied = true; S.active = Date.now();
    energy.accent((ev.kind || 'speech') === 'speech' ? (ev.expr || 'happy') : 'remind');
  }

  function syncSummonCard() {
    ensureThreadMounted();
    renderNoteSlot();
    renderInterim();
    const C = A.chat, msgs = C?.cur?.messages || [];
    const hasConv = msgs.length > 0 || !!S.note || !!S.interim.trim();
    summonEl.classList.toggle('has-conv', hasConv);

    if (titleEl) {
      if (C?.generating || V.phase === 'thinking') titleEl.textContent = 'KBOT 思考中…';
      else if (V.phase === 'speaking') titleEl.textContent = 'KBOT 正在回复…';
      else if (S.note) titleEl.textContent = S.note.title || (S.note.kind === 'remind' ? '提醒' : 'KBOT');
      else {
        const title = C?.cur?.title;
        titleEl.textContent = title && title !== '新对话' ? title : 'KBOT 对话';
      }
    }
    if (newBtn) {
      newBtn.disabled = !!C?.generating;
      newBtn.hidden = !!C?.generating || (!msgs.length && !S.note);
    }
    syncTallBtn();

    let capH = 0;
    if (hasConv) {
      const L = currentLayout('summon');
      const barH = capBar.offsetHeight || 32;
      const rawH = Math.ceil(barH + scrollEl.scrollHeight);
      capH = Math.min(L.summon.captionMax, Math.max(92, rawH));
      if (C?.generating || V.phase === 'thinking' || V.phase === 'speaking') {
        capH = S.hold = Math.max(capH, S.hold);
      } else {
        S.hold = 0;
      }
    } else {
      S.hold = 0;
      if (T.tall) T.tall = false;
    }

    if (capH !== T.cap) {
      T.cap = capH;
      if (T.state === 'summon') setState('summon');
    }
    if (hasConv && stickBottom) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  }

  function scheduleSummonSync(forceScroll = false) {
    if (forceScroll) stickBottom = true;
    if (captionFrame) return;
    captionFrame = requestAnimationFrame(() => {
      captionFrame = 0;
      syncSummonCard();
    });
  }

  function ensureThreadMounted() {
    if (threadMounted || !A.chat?.mountThread) return;
    threadMounted = true;
    A.chat.mountThread(threadEl, {
      scrollEl,
      onSync: (kind, m) => {
        if (m?.role === 'user' || kind === 'append') stickBottom = true;
        else stickBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90;
        if (m && m.role === 'assistant') S.msg = m;
        syncSummonCard();
        if (kind === 'paint' || kind === 'text' || kind === 'append') armAuto();
      },
    });
  }

  function setVoiceUi(phase, level = 0) {
    V.phase = phase;
    if (summonEl) {
      summonEl.dataset.voice = phase === 'off' ? '' : phase;
      summonEl.style.setProperty('--voice-level', String(Math.max(0, Math.min(1, Number(level) || 0))));
    }
    energy.setVoiceActive(phase === 'listening' || phase === 'connecting');
    if (sMic) {
      const active = phase !== 'off' && phase !== 'muted';
      const tip = phase === 'speaking' ? '正在说话，点击打断'
        : phase === 'listening' ? '正在倾听，点击静音'
          : phase === 'connecting' ? '正在连接语音…'
            : phase === 'thinking' ? '正在思考…'
              : phase === 'muted' ? '语音已静音，点击继续说话'
                : '点击开启语音交流';
      sMic.setAttribute('aria-pressed', String(active));
      sMic.title = tip;
      sMic.setAttribute('aria-label', tip);
    }
  }

  function clearVoiceTimers() {
    clearTimeout(V.dictTimer);
    clearTimeout(V.resumeTimer);
    V.dictTimer = 0;
    V.resumeTimer = 0;
  }

  function stopSummonVoice() {
    clearVoiceTimers();
    V.wanted = false;
    V.manualTyping = false;
    V.mode = 'off';
    V.rtTurn = null;
    V.bridging = null;
    A.voice?.setRealtimeBridging?.(false);
    A.voice?.stopDictation?.().catch?.(() => {});
    A.voice?.stopRealtime?.().catch?.(() => {});
    setVoiceUi('off');
  }

  function parseToolTask(rawArgs) {
    try {
      const obj = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs;
      return String(obj?.task || obj?.query || obj?.instruction || '').trim();
    } catch {
      return String(rawArgs || '').trim();
    }
  }

  function ensureRealtimeTurn(userText = '') {
    if (!V.rtTurn) {
      V.rtTurn = { userText, userMsg: null, rawText: '', assistantMsg: null, bridged: false };
    }
    return V.rtTurn;
  }

  function runDshBridge(task, callId) {
    const cleanTask = String(task || '').trim();
    if (!cleanTask) {
      if (callId) A.voice?.sendRealtimeToolOutput?.(callId, '未提供需要执行的具体任务，请重新说明你的指令。').catch(() => {});
      return;
    }
    if (A.S.model === 'none') {
      if (callId) A.voice?.sendRealtimeToolOutput?.(callId, '智能核心尚未连接或未登录，请提醒对方先到设置中连接。').catch(() => {});
      return;
    }
    if (A.chat.generating) {
      if (callId) A.voice?.sendRealtimeToolOutput?.(callId, '智能核心正在处理上一项任务，请稍候再试。').catch(() => {});
      return;
    }
    A.voice?.setRealtimeBridging?.(true);
    T.chatMode = 'think';
    syncMode();
    setVoiceUi('thinking');
    syncField();
    A.chat.send(cleanTask, []);
    const dshMsg = A.chat.cur?.messages?.at(-1);
    if (dshMsg?.role === 'assistant') {
      follow(dshMsg);
      scheduleSummonSync(true);
      V.bridging = { callId, msg: dshMsg };
    } else {
      A.voice?.setRealtimeBridging?.(false);
    }
  }

  async function startRealtimeSession() {
    if (T.state !== 'summon' || !A.native) return;
    clearVoiceTimers();
    V.mode = 'qwen-realtime';
    V.wanted = true;
    V.rtTurn = null;
    V.bridging = null;
    setVoiceUi('connecting');
    syncField();
    const instructions = buildRealtimeInstructions({
      personaHint: personaHint(A.S.persona),
      nickname: addressName(A.S.nickname),
    });
    try {
      await A.voice.startRealtime({
        instructions,
        onReady() {
          if (T.state !== 'summon') return;
          A.focusWindow?.();
          T.chatMode = 'listen';
          syncMode();
          setVoiceUi('listening');
          syncField();
          S.active = Date.now();
          armAuto();
          focusSummon();
        },
        onLevel(lvl) {
          if (T.state !== 'summon') return;
          summonEl.style.setProperty('--voice-level', String(lvl));
          energy.setVoiceLevel(lvl);
          if (lvl > 0.08) S.active = Date.now();
        },
        onListening() {
          if (T.state !== 'summon') return;
          V.rtTurn = null;
          T.chatMode = 'listen';
          syncMode();
          setVoiceUi(A.voice?.realtimeMuted ? 'muted' : 'listening');
          syncField();
          S.active = Date.now();
        },
        onThinking() {
          if (T.state !== 'summon') return;
          T.chatMode = 'think';
          syncMode();
          setVoiceUi('thinking');
          syncField();
        },
        onSpeaking() {
          if (T.state !== 'summon') return;
          T.chatMode = 'talk';
          syncMode();
          setVoiceUi('speaking');
          syncField();
          S.active = Date.now();
        },
        onSpeakingDone() {
          if (T.state !== 'summon') return;
          if (V.mode === 'qwen-realtime' && !V.bridging) {
            T.chatMode = 'listen';
            syncMode();
            setVoiceUi(A.voice?.realtimeMuted ? 'muted' : 'listening');
            syncField();
            S.active = Date.now();
            armAuto();
          }
        },
        onUserTranscript(text, isFinal) {
          if (T.state !== 'summon') return;
          const turn = ensureRealtimeTurn();
          if (!isFinal) {
            turn.userText += text;
            const live = turn.userText.trim();
            if (live) {
              S.interim = live;
              renderInterim();
              scheduleSummonSync(true);
              if (!sInput.value) sInput.placeholder = `正在听：${live}`;
            }
            S.active = Date.now();
            return;
          }
          const spoken = String(text || turn.userText || '').trim();
          S.interim = '';
          renderInterim();
          syncField();
          if (!spoken) { scheduleSummonSync(); return; }
          const conv = A.chat.cur;
          const um = { id: A.uid(), role: 'user', text: spoken, images: [], time: Date.now() };
          conv.messages.push(um);
          if (conv.title === '新对话') {
            conv.title = spoken.replace(/\s+/g, ' ').slice(0, 18);
            conv.titleSource = 'auto';
          }
          conv.t = Date.now();
          A.chat.append(um);
          const am = {
            id: A.uid(),
            role: 'assistant',
            text: '',
            status: 'streaming',
            steps: [],
            time: Date.now(),
          };
          conv.messages.push(am);
          A.chat.append(am);
          A.save();
          turn.userText = spoken;
          turn.userMsg = um;
          turn.assistantMsg = am;
          follow(am);
          S.replied = false;
          scheduleSummonSync(true);
        },
        onAssistantDelta(delta) {
          if (T.state !== 'summon') return;
          const turn = ensureRealtimeTurn();
          if (!turn.assistantMsg) {
            const conv = A.chat.cur;
            const am = {
              id: A.uid(),
              role: 'assistant',
              text: '',
              status: 'streaming',
              steps: [],
              time: Date.now(),
            };
            conv.messages.push(am);
            A.chat.append(am);
            turn.assistantMsg = am;
            follow(am);
          }
          turn.rawText += delta;
          const parsed = extractDshBridgeDirective(turn.rawText);
          turn.assistantMsg.text = parsed.cleanText;
          A.chat.paintText(turn.assistantMsg);
        },
        onToolCall({ callId, name, arguments: rawArgs }) {
          if (T.state !== 'summon') return;
          if (name === 'ask_dsh') {
            const turn = ensureRealtimeTurn();
            turn.bridged = true;
            runDshBridge(parseToolTask(rawArgs), callId);
          }
        },
        onTurnDone() {
          const turn = V.rtTurn;
          if (turn?.assistantMsg) {
            const parsed = extractDshBridgeDirective(turn.rawText);
            turn.assistantMsg.text = parsed.cleanText;
            turn.assistantMsg.status = 'done';
            A.chat.paint(turn.assistantMsg);
            A.save();
            if (parsed.dshTask && !turn.bridged) {
              turn.bridged = true;
              runDshBridge(parsed.dshTask, null);
            }
          }
          if (T.state === 'summon') {
            S.replied = true;
            S.active = Date.now();
            if (!A.voice?.realtimeSpeaking && !V.bridging) {
              T.chatMode = 'listen';
              syncMode();
              setVoiceUi(A.voice?.realtimeMuted ? 'muted' : 'listening');
              syncField();
            }
            armAuto();
          }
        },
        onError(message) {
          A.toast?.(message, 4500);
          const noMic = /麦克风/.test(String(message || ''));
          if (!noMic && V.phase === 'connecting' && A.S.voice?.realtimeMode === 'auto' && A.S.model !== 'none') {
            A.voice?.stopRealtime?.().catch?.(() => {});
            startNativeVoiceSession();
          } else if (T.state === 'summon') {
            V.mode = 'off';
            setVoiceUi('off');
            syncField();
          }
        },
        onEnd() {
          if (V.mode === 'qwen-realtime') {
            V.mode = 'off';
            V.bridging = null;
            A.voice?.setRealtimeBridging?.(false);
            T.chatMode = 'listen';
            syncMode();
            setVoiceUi('off');
            syncField();
            armAuto();
          }
        },
      });
    } catch (err) {
      const msg = (err && err.message) || String(err || '暂时无法开启实时语音');
      A.toast?.(msg, 4500);
      const noMic = /麦克风/.test(msg);
      if (!noMic && A.S.voice?.realtimeMode === 'auto' && A.S.model !== 'none' && T.state === 'summon') {
        startNativeVoiceSession();
      } else {
        V.mode = 'off';
        setVoiceUi('off');
        syncField();
      }
    }
  }

  function scheduleNativeResume() {
    clearTimeout(V.resumeTimer);
    V.resumeTimer = setTimeout(() => {
      V.resumeTimer = 0;
      if (
        T.state === 'summon' &&
        V.mode === 'dsh-native' &&
        V.wanted &&
        !V.manualTyping &&
        !A.chat?.generating &&
        !A.voice?.speaking &&
        !A.isDnd?.()
      ) {
        startNativeVoiceSession();
      }
    }, 320);
  }

  async function startNativeVoiceSession() {
    if (T.state !== 'summon' || !A.native || A.S.model === 'none' || A.chat?.generating || A.voice?.speaking) return;
    clearVoiceTimers();
    V.mode = 'dsh-native';
    V.wanted = true;
    V.manualTyping = false;
    setVoiceUi('connecting');
    syncField();
    try {
      await A.voice.startDictation({
        onLevel(lvl) {
          if (T.state !== 'summon') return;
          summonEl.style.setProperty('--voice-level', String(lvl));
          energy.setVoiceLevel(lvl);
          if (lvl > 0.08) S.active = Date.now();
        },
        onPartial(text) {
          if (T.state !== 'summon' || V.manualTyping) return;
          sInput.value = text;
          S.active = Date.now();
          energy.kick();
          clearTimeout(V.dictTimer);
          if (text.trim()) {
            V.dictTimer = setTimeout(() => {
              if (T.state === 'summon' && !V.manualTyping && sInput.value.trim() && !A.chat.generating) {
                A.voice?.stopDictation?.().catch?.(() => {});
                send();
              }
            }, 1150);
          }
        },
        onFinal(text) {
          clearTimeout(V.dictTimer);
          if (T.state !== 'summon' || V.manualTyping) return;
          const spoken = String(text || '').trim();
          if (spoken && !A.chat.generating) {
            sInput.value = spoken;
            send();
          }
        },
        onError(message) {
          clearTimeout(V.dictTimer);
          const silenceOnly = !sInput.value.trim() && String(message || '').includes('没有听到声音');
          if (!silenceOnly && message) A.toast?.(message, 4500);
          if (T.state === 'summon') {
            setVoiceUi('off');
            syncField();
            armAuto();
          }
        },
        onEnd() {
          clearTimeout(V.dictTimer);
          if (T.state === 'summon' && V.mode === 'dsh-native') {
            if (A.chat.generating) setVoiceUi('thinking');
            else if (A.voice?.speaking) setVoiceUi('speaking');
            else if (V.phase !== 'muted') setVoiceUi('off');
            syncField();
            armAuto();
          }
        },
      });
      if (T.state === 'summon' && !V.manualTyping && A.voice?.dictating) {
        A.focusWindow?.();
        T.chatMode = 'listen';
        syncMode();
        setVoiceUi('listening');
        syncField();
        focusSummon();
      }
    } catch (err) {
      const msg = (err && err.message) || String(err || '听写暂时没能开始');
      A.toast?.(msg, 4500);
      setVoiceUi('off');
      syncField();
    }
  }

  function startSummonVoice({ force = false } = {}) {
    if (T.state !== 'summon' || !A.native) return;
    if (!force && location.search.includes('visualPreview')) return;
    const backend = resolveSummonVoiceBackend(A.S);
    if (!force && (backend === 'off' || A.isDnd?.())) return;
    if (backend === 'qwen-realtime' || (force && A.S.voice?.realtimeHasKey && A.S.voice?.realtimeMode !== 'dsh-native')) {
      startRealtimeSession();
    } else if (A.S.model !== 'none') {
      startNativeVoiceSession();
    } else if (force) {
      A.toast?.('请先在设置中连接智能核心或开启实时语音服务', 4000);
    }
  }

  function syncField() {
    const C = A.chat, off = C?.offText?.() || '', gen = !!C?.generating;
    const speaking = !!A.voice?.speaking || V.phase === 'speaking';
    const busy = gen || speaking;
    const canChat = V.mode === 'qwen-realtime' || !off;
    sInput.readOnly = !canChat;
    const ph = !canChat ? off
      : V.phase === 'connecting' ? '正在连接语音交流…'
        : V.phase === 'listening' ? '正在倾听，直接说或打字…'
          : V.phase === 'thinking' ? '正在思考…'
            : V.phase === 'speaking' ? '正在回复…（可直接开口打断）'
              : V.phase === 'muted' ? '已静音，可直接打字或点击左侧麦克风说话'
                : A.S.voice?.summonVoice === false ? '打字吩咐，或点左侧麦克风说话' : '直接说，或者打字…';
    sInput.placeholder = ph;
    // 右侧按钮：生成中是“停止生成”，朗读/说话中是“停止说话”，其余是“在窗口中继续”
    const tip = gen ? '停止生成' : speaking ? '停止说话（Esc）' : '在窗口中继续（⌘↩）';
    sBtn.classList.toggle('stop', busy);
    sBtn.innerHTML = A.icon(busy ? 'stop' : 'expand', busy ? 14 : 15);
    sBtn.title = tip;
    sBtn.setAttribute('aria-label', tip.replace(/（.*/, ''));
  }

  function send() {
    const C = A.chat, text = sInput.value.trim();
    if (!text) return;
    if (V.mode === 'qwen-realtime' && A.voice?.realtimeActive) {
      sInput.value = '';
      const conv = C.cur;
      const um = { id: A.uid(), role: 'user', text, images: [], time: Date.now() };
      conv.messages.push(um);
      if (conv.title === '新对话') { conv.title = text.replace(/\s+/g, ' ').slice(0, 18); conv.titleSource = 'auto'; }
      conv.t = Date.now();
      C.append(um);
      const am = {
        id: A.uid(),
        role: 'assistant',
        text: '',
        status: 'streaming',
        steps: [],
        time: Date.now(),
      };
      conv.messages.push(am);
      C.append(am);
      A.save();
      V.rtTurn = { userText: text, userMsg: um, rawText: '', assistantMsg: am, bridged: false };
      follow(am);
      S.replied = false;
      clearTimeout(autoTimer);
      setVoiceUi('thinking');
      syncField();
      scheduleSummonSync(true);
      A.voice.sendRealtimeText(text).catch(err => A.toast?.(String(err), 4000));
      return;
    }
    if (C.generating || A.S.model === 'none') return;
    sInput.value = '';
    C.send(text, []);
    const m = C.cur.messages.at(-1);
    follow(m?.role === 'assistant' ? m : null);
    S.replied = false;
    clearTimeout(autoTimer);
    if (V.mode === 'dsh-native' && V.wanted) {
      setVoiceUi('thinking');
      syncField();
    }
    scheduleSummonSync(true);
  }

  // 回复结束后 30 秒没有悬停、没有输入、没有持续语音、没有待操作卡片且输入框为空就收起
  function armAuto() {
    clearTimeout(autoTimer);
    if (T.state !== 'summon' || !S.replied) return;
    const voiceActive = V.phase === 'listening' || V.phase === 'speaking' || V.phase === 'connecting' || V.phase === 'thinking';
    const busyWait = voiceActive || hasPendingCard();
    autoTimer = setTimeout(function check() {
      if (T.state !== 'summon') return;
      const idle = Date.now() - S.active;
      const va = V.phase === 'listening' || V.phase === 'speaking' || V.phase === 'connecting' || V.phase === 'thinking' || hasPendingCard();
      if (shouldAutoClose({ idle, hovering: overContent, empty: !sInput.value.trim(), generating: !!A.chat.generating, voiceActive: va })) A.summon.close();
      else autoTimer = setTimeout(check, Math.max(1000, SUMMON_IDLE - idle));
    }, busyWait ? SUMMON_IDLE : Math.max(1000, SUMMON_IDLE - (Date.now() - S.active)));
  }

  function leaveSummon() {
    clearTimeout(autoTimer); clearTimeout(focusTimer);
    stopSummonVoice();
    sInput.blur();
    S.interim = '';
    renderInterim();
    S.hold = 0;
    S.replied = false;
    clearTimeout(capTimer);
    capTimer = setTimeout(() => { if (T.state !== 'summon') { capEl.style.transition = 'none'; capEl.style.height = T.cap + 'px'; } }, 400);
  }
  function leavePanel() {
    stopPanelDrag();
    stopPanelResize(true);
    panel.inert = true;
    clearTimeout(focusTimer);
    A.chat.closeHistory();
    input.blur();
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (T.state !== 'chat') panel.hidden = true; }, 400);
  }

  const toWindow = () => A.panel.open();
  sInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); toWindow(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      clearTimeout(V.dictTimer);
      if (A.voice?.dictating) A.voice.stopDictation().catch(() => {});
      send();
      return;
    }
    if (MODS.includes(e.key) || e.metaKey || e.ctrlKey) return;
    S.active = Date.now();
    V.manualTyping = true;
    if (A.voice?.dictating) {
      clearTimeout(V.dictTimer);
      A.voice.stopDictation().catch(() => {});
      setVoiceUi('off');
      syncField();
    }
  });
  sInput.addEventListener('input', () => { S.active = Date.now(); energy.kick(); });
  input.addEventListener('input', () => { if (T.state === 'chat') energy.kick(); });
  if (sMic) {
    sMic.addEventListener('click', async () => {
      if (!A.native) { A.toast?.('请在桌面应用中使用语音交流'); return; }
      if (V.phase === 'connecting') {
        stopSummonVoice();
        setVoiceUi('muted');
        syncField();
        armAuto();
        return;
      }
      if (V.phase === 'speaking' || A.voice?.speaking) {
        await A.voice.stop?.();
        if (V.mode === 'qwen-realtime' && A.voice?.realtimeActive) {
          T.chatMode = 'listen';
          syncMode();
          setVoiceUi(A.voice.realtimeMuted ? 'muted' : 'listening');
          syncField();
        } else if (V.mode === 'dsh-native') {
          V.manualTyping = false;
          startNativeVoiceSession();
        }
        return;
      }
      if (V.mode === 'qwen-realtime' && A.voice?.realtimeActive) {
        const nextMuted = !A.voice.realtimeMuted;
        await A.voice.setRealtimeMuted(nextMuted);
        V.wanted = !nextMuted;
        setVoiceUi(nextMuted ? 'muted' : 'listening');
        syncField();
        armAuto();
        return;
      }
      if (A.voice?.dictating) {
        V.wanted = false;
        clearVoiceTimers();
        await A.voice.stopDictation().catch(() => {});
        setVoiceUi('muted');
        syncField();
        armAuto();
        return;
      }
      V.manualTyping = false;
      V.wanted = true;
      startSummonVoice({ force: true });
    });
  }
  sBtn.addEventListener('click', () => {
    const gen = A.chat.generating, speaking = !!A.voice?.speaking || V.phase === 'speaking';
    if (gen) A.chat.stop();
    if (speaking) A.voice.stop();
    if (!gen && !speaking) toWindow();
  });
  tallBtn?.addEventListener('click', () => {
    T.tall = !T.tall;
    syncSummonCard();
    if (T.state === 'summon') setState('summon');
  });
  capBar?.addEventListener('dblclick', e => {
    if (T.state !== 'summon' || e.target.closest('button, input, a')) return;
    T.tall = !T.tall;
    syncSummonCard();
    setState('summon');
  });
  newBtn?.addEventListener('click', () => {
    if (A.chat?.generating) return;
    S.note = null; S.pro = null; S.interim = ''; S.msg = null; S.hold = 0; T.tall = false; S.replied = false;
    renderNoteSlot();
    renderInterim();
    A.chat.newConv(false);
    syncSummonCard();
    focusSummon();
  });
  noteSlot?.addEventListener('click', e => {
    const t = e.target.closest('[data-a="pro"]');
    if (!t || !S.note) return;
    const act = S.note.actions?.[+t.dataset.i];
    if (!act) return;
    S.note = null;
    renderNoteSlot();
    syncSummonCard();
    try { act.fn?.(); } finally { if (!act.quiet) energy.accent(act.expr || 'happy'); }
  });
  scrollEl?.addEventListener('scroll', () => {
    stickBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 90;
    S.active = Date.now();
  }, { passive: true });
  scrollEl?.addEventListener('load', () => scheduleSummonSync(), true);
  capEl?.addEventListener('transitionend', e => {
    if (e.target === capEl && e.propertyName === 'height' && stickBottom && scrollEl) {
      scrollEl.scrollTop = scrollEl.scrollHeight;
    }
  });
  summonEl.addEventListener('click', e => { if (!e.target.closest('button, input, textarea, a, .s-cap, .s-scroll')) focusSummon(); });

  A.on('chat:msg', m => {
    if (!S.msg || m.id !== S.msg.id) return;
    scheduleSummonSync();
  });
  A.on('generating', on => {
    syncField();
    if (T.state === 'summon') syncSummonCard();
    if (on) return;
    if (V.bridging) {
      const br = V.bridging;
      V.bridging = null;
      A.voice?.setRealtimeBridging?.(false);
      const raw = br.msg?.text || br.msg?.error || (br.msg?.status === 'stopped' ? '任务已取消。' : '已完成。');
      const resultText = normalizeSpokenBrand(raw.trim());
      if (A.voice?.realtimeActive) {
        V.rtTurn = null;
        if (br.callId) {
          A.voice.sendRealtimeToolOutput(br.callId, resultText).catch(err => A.toast?.(String(err), 4000));
        } else {
          A.voice.sendRealtimeText(`[任务执行结果]\n${resultText}\n请用简短自然的口语直接说明结果，不要客服式收尾，提到自己时读作 Kbot（kay-bot）。`).catch(err => A.toast?.(String(err), 4000));
        }
      }
      return;
    }
    if (T.state === 'summon') {
      if (S.msg) { S.replied = true; S.active = Date.now(); armAuto(); }
      if (V.mode === 'dsh-native' && V.wanted && !V.manualTyping && !A.isDnd?.()) {
        setTimeout(() => {
          if (T.state !== 'summon' || V.mode !== 'dsh-native' || !V.wanted || V.manualTyping || A.chat?.generating) return;
          if (A.voice?.speaking) {
            setVoiceUi('speaking');
            syncField();
            return;
          }
          if (S.msg?.text?.trim() && A.S.voice?.hasKey && A.S.voice?.enabled) {
            setVoiceUi('speaking');
            syncField();
            A.voice.speakAuto(S.msg.text, { emotion: 'happy' });
          } else {
            scheduleNativeResume();
          }
        }, 80);
      }
    } else if (S.msg) { follow(null); syncSummonCard(); }
  });
  A.on('dsh:state', syncField);
  A.on('set:model', syncField);
  A.on('set:voice', () => {
    if (T.state === 'summon' && A.S.voice?.summonVoice === false && V.mode !== 'off') {
      stopSummonVoice();
      syncField();
    }
  });
  A.on('realtime:stopped', () => {
    if (T.state === 'summon' && V.mode === 'qwen-realtime') {
      T.chatMode = 'listen';
      syncMode();
      setVoiceUi(A.voice?.realtimeMuted ? 'muted' : 'listening');
      syncField();
      armAuto();
    }
  });

  A.summon = {
    /** opts.note：在对话卡片里展现该通知；opts.msgId：定位到这条回复。 */
    open(opts = {}) {
      if (A.hidden || !A.chat?.cur) return;
      ensureThreadMounted();
      const C = A.chat, was = T.state;
      // 隔了很久再唤起，就从新对话开始；没隔多久就接着聊。指向某条消息、带通知的唤起，以及从窗口过来的不动
      if (was !== 'summon' && was !== 'chat' && !opts.note && !opts.msgId && !A.bubble.current()) {
        const last = C.cur.messages.at(-1);
        if (last && shouldStartFresh({ lastTime: last.time, now: Date.now(), afterMin: A.S.newChatAfter, generating: !!C.generating })) {
          follow(null);
          C.newConv(false);
        }
      }
      if (was === 'chat') { leavePanel(); T.surface = 'summon'; }
      else if (was !== 'summon') A.focusWindow?.();
      // 通知并入：正在显示的那条（没有就取排队里最新的一条）进入对话流，其余放进当前对话
      let ev = opts.note || A.bubble.takeover(false);
      const queued = A.bubble.drain();
      if (!ev) ev = queued.pop();
      queued.forEach(q => C.pushPro(q));
      if (ev) showNote(ev);
      else if (opts.msgId) {
        follow(C.find(opts.msgId));
        requestAnimationFrame(() => revealSummonMsg(opts.msgId));
      }
      else if (C.generating && !S.msg) follow(lastReply());
      else if (!S.msg) {
        const last = C.cur.messages.at(-1);
        if (last?.role === 'assistant' && last.status !== 'thinking' && last.status !== 'streaming') follow(last);
      }
      if (S.msg && !C.generating && !S.replied) { S.replied = true; S.active = Date.now(); }
      if (T.act?.source === 'agent') T.act = null;
      clearTimeout(capTimer);
      syncField();
      syncSummonCard();
      setState('summon');
      if (!opts.msgId) requestAnimationFrame(() => { if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight; });
      armAuto();
      clearTimeout(focusTimer);
      focusTimer = setTimeout(focusSummon, 60);
      if (was !== 'summon') startSummonVoice();
      if (was === 'chat') A.emit('panel', false);
      if (was !== 'summon') A.emit('summon', true);
    },
    close() {
      if (T.state !== 'summon') return;
      T.surface = 'summon';
      // 收起时还在回复，就留一条常驻条，点它回到召唤态
      if (A.chat?.generating && !T.act) T.act = agentAct();
      settle();
      leaveSummon();
      A.emit('summon', false);
    },
    toggle: () => (T.state === 'summon' ? A.summon.close() : A.summon.open()),
    isOpen: () => T.state === 'summon',
  };

  // ---------- 对话窗口 ----------
  const panelHead = $('.p-head', panel);
  let panelDrag = null, panelResize = null;
  function movePanel() {
    const L = currentLayout('chat'), c = L.content;
    rememberPanelPosition(c);
    T.layout = L;
    contentEl.style.transition = haloEl.style.transition = 'none';
    for (const el of [contentEl, haloEl]) Object.assign(el.style, { left: c.x + 'px', top: c.y + 'px', width: c.w + 'px', height: c.h + 'px' });
    // 拖动或缩放窗口时头像直接跟手；状态切换时仍保留从大球缩进头像的飞行动画。
    placeEnergy(L, { immediate: true });
    backdrop(L.halo, true, false, true);
    A.emit('panelmove');
  }
  function stopPanelDrag() {
    if (!panelDrag) return;
    const { id, moved } = panelDrag;
    panelDrag = null;
    stage.classList.remove('panel-dragging');
    if (panelHead.hasPointerCapture(id)) panelHead.releasePointerCapture(id);
    if (moved) A.emit('paneldrag', false);
  }
  function applyChatRect(c) {
    const frame = screenFrame();
    A.S.chatSize = { w: c.w, h: c.h };
    const rest = chatRest(c.w, c.h, frame);
    T.chatOffset = { x: c.x - rest.x, y: c.y - rest.y };
    movePanel();
  }
  function stopPanelResize(commit = false) {
    if (!panelResize) return;
    const { id, el } = panelResize;
    panelResize = null;
    stage.classList.remove('panel-resizing');
    delete stage.dataset.resizing;
    if (el?.hasPointerCapture?.(id)) el.releasePointerCapture(id);
    if (commit) A.save();
    A.emit('paneldrag', false);
  }
  function toggleExpand() {
    stopPanelDrag();
    stopPanelResize(true);
    A.S.expanded = !A.S.expanded;
    A.save();
    syncExpand();
    if (T.state === 'chat') setState('chat');
  }
  panelHead.addEventListener('pointerdown', e => {
    if (T.state !== 'chat' || A.S.expanded || !e.isPrimary || e.button !== 0 || e.detail >= 2 || e.target.closest('button, input, textarea, select, a, [contenteditable], [role="button"], .p-rz')) return;
    e.preventDefault();
    const r = contentEl.getBoundingClientRect(), s = stage.getBoundingClientRect();
    const c = currentLayout('chat').content;
    rememberPanelPosition({ ...c, x: r.left - s.left, y: r.top - s.top });
    panelDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, offset: { ...T.chatOffset }, moved: false };
    panelHead.setPointerCapture(e.pointerId);
  });
  panelHead.addEventListener('pointermove', e => {
    if (!panelDrag || panelDrag.id !== e.pointerId) return;
    const dx = e.clientX - panelDrag.x, dy = e.clientY - panelDrag.y;
    if (!panelDrag.moved) {
      if (Math.hypot(dx, dy) < 2) return;
      panelDrag.moved = true;
      stage.classList.add('panel-dragging');
      A.emit('paneldrag', true);
    }
    T.chatOffset = { x: panelDrag.offset.x + dx, y: panelDrag.offset.y + dy };
    movePanel();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) panelHead.addEventListener(name, e => {
    if (panelDrag?.id === e.pointerId) stopPanelDrag();
  });
  panelHead.addEventListener('dblclick', e => {
    if (T.state !== 'chat' || e.target.closest('button, input, textarea, select, a, [contenteditable], [role="button"], .p-rz')) return;
    e.preventDefault();
    toggleExpand();
  });
  panel.querySelectorAll('.p-rz').forEach(rzEl => {
    rzEl.addEventListener('pointerdown', e => {
      if (T.state !== 'chat' || A.S.expanded || !e.isPrimary || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      stopPanelDrag();
      const c = currentLayout('chat').content;
      panelResize = { id: e.pointerId, el: rzEl, edge: rzEl.dataset.rz || 'se', x: e.clientX, y: e.clientY, rect: { x: c.x, y: c.y, w: c.w, h: c.h } };
      rzEl.setPointerCapture(e.pointerId);
      stage.classList.add('panel-resizing');
      stage.dataset.resizing = panelResize.edge;
      A.emit('paneldrag', true);
    });
    rzEl.addEventListener('pointermove', e => {
      if (!panelResize || panelResize.id !== e.pointerId) return;
      const next = resizeChatRect(panelResize.rect, panelResize.edge, e.clientX - panelResize.x, e.clientY - panelResize.y, screenFrame());
      applyChatRect(next);
    });
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) rzEl.addEventListener(name, e => {
      if (panelResize?.id === e.pointerId) stopPanelResize(name === 'pointerup');
    });
  });
  addEventListener('blur', () => { stopPanelDrag(); stopPanelResize(true); });
  addEventListener('resize', () => { stopPanelDrag(); stopPanelResize(true); if (T.state !== 'hidden') setState(T.state); });

  A.panel = {
    /** opts.msgId：打开后滚到这条消息；从召唤态进来时把胶囊里没发的文字带过来。 */
    open(opts = {}) {
      if (A.hidden || !A.chat?.cur) return;
      if (T.state === 'chat') {
        if (opts.convId || opts.seed) A.chat.onOpen({ convId: opts.convId, seed: opts.seed });
        if (opts.msgId) A.chat.reveal(opts.msgId);
        focusInput();
        return;
      }
      const fromSummon = T.state === 'summon';
      if (!fromSummon) A.focusWindow?.();
      let pro = null, seed = opts.seed, convId = opts.convId;
      const ev = A.bubble.takeover();
      if (!seed && !convId && ev) {
        if (ev.convId) convId = ev.convId;
        else if ((ev.kind || 'speech') === 'speech') seed = ev.text;
        else pro = ev;
      }
      const draft = fromSummon ? sInput.value.trim() : '';
      clearTimeout(closeTimer);
      panel.hidden = false; panel.inert = false;
      A.chat.onOpen({ convId, seed, pro });
      A.bubble.drain().forEach(ev => A.chat.pushPro(ev));
      if (T.act?.source === 'agent') T.act = null;
      if (fromSummon) T.surface = 'chat';
      setState('chat');
      if (fromSummon) { if (S.msg) A.chat.paint(S.msg); sInput.value = ''; leaveSummon(); A.emit('summon', false); }
      if (draft) A.chat.setDraft(draft);
      // onOpen 会在下一帧滚到底，等它之后再定位
      if (opts.msgId) requestAnimationFrame(() => requestAnimationFrame(() => A.chat.reveal(opts.msgId)));
      clearTimeout(focusTimer);
      focusTimer = setTimeout(() => { if (T.state === 'chat') focusInput(); }, 60);
      A.emit('panel', true);
    },
    close() {
      if (T.state !== 'chat') return;
      leavePanel();
      T.surface = 'chat';
      // 收起时模型还在回复，就留一条常驻条，点它回到窗口
      if (A.chat?.generating && !T.act) T.act = agentAct();
      settle();
      A.emit('panel', false);
    },
    toggle: () => (T.state === 'chat' ? A.panel.close() : A.panel.open()),
    isOpen: () => T.state === 'chat',
    isTransitioning: () => T.moving,
    isDragging: () => !!panelDrag || !!panelResize,
    place() { if (T.state === 'chat') movePanel(); },
  };

  function syncExpand() {
    const b = $('#expandBtn');
    panel.classList.toggle('expanded', !!A.S.expanded);
    b.innerHTML = A.icon(A.S.expanded ? 'shrink' : 'expand');
    b.title = A.S.expanded ? '还原大小' : '铺满屏幕';
  }
  $('.p-tools').addEventListener('click', e => {
    const b = e.target.closest('[data-p]');
    if (!b) return;
    ({
      history: () => A.chat.toggleHistory(),
      new: () => A.chat.newConv(true),
      expand: toggleExpand,
      close: () => A.panel.close(),
    })[b.dataset.p]();
  });

  /** 快捷键：没召唤时召唤；召唤态或窗口里再按一次收起。隐藏时先现身。 */
  function hotkey() {
    if (A.hidden) A.setHidden(false);
    if (hotkeyRoute(T.state) === 'summon') A.summon.open();
    else if (T.state === 'chat') A.panel.close();
    else A.summon.close();
  }
  /** 点外面或窗口失焦只收起召唤态（正在弹出系统授权时不收起）。已经打开的对话框保持不动，要手动关闭。 */
  function outside() {
    if (!A.S.outsideClose || panelDrag || panelResize) return;
    if (T.state === 'summon' && !V.prompting) A.summon.close();
  }
  standbyEl.addEventListener('pointerdown', () => outside());

  // 浏览器预览没有原生的鼠标轮询和全局快捷键，用页面事件代替
  if (!A.native) {
    document.addEventListener('pointerdown', e => {
      if (e.target.closest('#topContent, #menu, #lightbox, #toast, #tray, #sheet, #shot, #preview')) return;
      outside();
    }, true);
    document.addEventListener('pointermove', e => {
      const r = stage.getBoundingClientRect();
      cursor(e.clientX - r.left, e.clientY - r.top);
    }, { passive: true });
    const hotkeyHit = e => { const k = A.S.hotkey; return e.code === k.code && e.altKey === k.alt && e.metaKey === k.meta && e.ctrlKey === k.ctrl && e.shiftKey === k.shift; };
    addEventListener('keydown', e => {
      if (e.defaultPrevented || !hotkeyHit(e)) return;
      e.preventDefault();
      hotkey();
    });
  }
  addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === ',' && !e.defaultPrevented) { e.preventDefault(); A.openSettings?.(); }
  });

  // 图片拖到对话或常驻条上都可以
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  const overTop = e => T.state !== 'hidden' && e.target.closest?.('#topContent');
  addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    panel.classList.toggle('dropping', T.state === 'chat' && !!overTop(e));
    e.dataTransfer.dropEffect = overTop(e) ? 'copy' : 'none';
  });
  addEventListener('dragleave', e => { if (e.relatedTarget === null) panel.classList.remove('dropping'); });
  addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    panel.classList.remove('dropping');
    if (!overTop(e)) return;
    const files = Array.from(e.dataTransfer.files);
    if (T.state !== 'chat') A.panel.open();
    setTimeout(() => A.chat.addFiles(files), 40);
  });

  // ---------- 感应区：鼠标在顶边中央停 0.4 秒才探出，离开 0.45 秒后收回 ----------
  let hoverT = 0, leaveT = 0, overContent = false;
  function cursor(x, y) {
    T.cx = x; T.cy = y;
    // 先在舞台坐标里判断视线范围，再把指针换到固定画布的视口坐标。
    const L = T.layout, off = L?.energyOffset;
    const gaze = L && !A.hidden ? gazeAt(T.state, L.box, x - off.x, y - off.y) : null;
    const origin = gaze ? stage.getBoundingClientRect() : null;
    energy.lookAt(gaze ? x + origin.left : null, gaze ? y + origin.top : null);
    if (A.hidden || !A.S.onboarding) return;
    const over = T.state !== 'hidden' && inRect(T.layout?.content, x, y);
    if (over !== overContent) {
      overContent = over;
      if (T.state === 'note') { if (over) clearTimeout(noteTimer); else armNote(true); }
    }
    if (over && T.state === 'summon') S.active = Date.now();
    if (inHotzone(x, y, T.notch) || (T.state === 'peek' && over)) {
      clearTimeout(leaveT); leaveT = 0;
      if (T.state === 'hidden' && !hoverT) {
        hoverT = setTimeout(() => { hoverT = 0; if (T.state === 'hidden') setState('peek'); }, 400);
      }
    } else {
      clearTimeout(hoverT); hoverT = 0;
      if (T.state === 'peek' && !leaveT) {
        leaveT = setTimeout(() => { leaveT = 0; if (T.state === 'peek') settle(); }, 450);
      }
    }
  }

  // ---------- 能量体对旧接口的映射 ----------
  // agent.ts 用 setBase 报告思考 / 说话 / 空闲，用 robot.flash 叠加回复里的表情
  A.setBase = name => {
    base = name;
    T.chatMode = name === 'think' ? 'think' : name === 'talk' ? 'talk' : 'listen';
    if (name === 'think' && engaged()) T.surface = T.state;
    const busy = (name === 'think' || name === 'talk') && A.chat?.generating;
    if (!engaged()) {
      if (busy && (!T.act || T.act.source === 'agent')) startAct(agentAct());
      else if (!busy && T.act?.source === 'agent') endAct();
    } else syncMode();
    A.emit('base', name);
  };
  A.robot = {
    flash: expr => { if (expr && expr !== 'talk' && T.state !== 'hidden') energy.accent(expr); },
    clearFlash() {}, talkPulse() {}, lookAtPoint() {},
    hover: false, pressed: false, held: false,
  };

  // 朗读时留一条常驻条，计时显示已经读了多久；在召唤态本地语音模式下播完自动继续倾听
  let voiceTimer = 0;
  A.on('voice', on => {
    clearInterval(voiceTimer);
    syncField();
    if (!on) {
      endAct('talk');
      if (T.state === 'summon' && V.mode === 'dsh-native' && V.wanted && !V.manualTyping && !A.chat?.generating) {
        scheduleNativeResume();
      }
      return;
    }
    const started = Date.now();
    startAct({ kind: 'talk', label: '正在朗读 · 点击停止', aux: '0:00', source: 'voice' });
    voiceTimer = setInterval(() => updateAct({ aux: A.mmss((Date.now() - started) / 1000).replace(/^0/, '') }), 1000);
  });

  // DSH 连接断开、正在重连时显示出错条；连上或 20 秒后收起
  let everConnected = false, errTimer = 0;
  A.on('dsh:state', st => {
    if (st?.connected) { everConnected = true; clearTimeout(errTimer); endAct('error'); return; }
    if (!everConnected || (st?.status !== 'error' && st?.status !== 'connecting')) return;
    if (T.act && T.act.kind !== 'error') return;
    startAct({ kind: 'error', label: '连接中断，正在重连…', source: 'dsh' });
    clearTimeout(errTimer);
    errTimer = setTimeout(() => endAct('error'), 20000);
  });

  // ---------- 外观：跟随系统深浅，配色和减弱动态来自设置 ----------
  A.applyLook = () => {
    // 屏幕顶部（常驻条、通知、对话窗口、菜单）始终是烟灰玻璃，不跟系统深浅；设置窗口有自己的主题
    const root = document.documentElement;
    root.classList.add('theme-dark');
    root.classList.remove('theme-light');
    root.classList.toggle('reduced', !!A.S.reduced);
    root.style.setProperty('--glow-rgb', uiAccent(A.S.palette, true).join(', '));
    energy.setTone(toneFor());
    energy.setPalette(A.S.palette);
    energy.setReduced(!!A.S.reduced);
  };

  // ---------- 勿扰、会议、离开、隐藏 ----------
  A.isDnd = () => A.dnd.until > Date.now() || A.meeting;
  A.dndLabel = () => A.meeting ? '勿扰中 · 会议进行中（自动）' : A.dnd.until > Date.now() ? `勿扰中 · 到 ${A.hm(A.dnd.until)}` : '';
  function syncDnd() {
    const on = A.isDnd();
    $('#tray').classList.toggle('dnd', on);
    A.emit('dnd', on);
  }
  A.setDnd = m => {
    if (!m) { A.dnd.until = 0; syncDnd(); A.toast('勿扰已结束'); return; }
    let until;
    if (m === 'tomorrow') { const d = new Date(); d.setHours(24, 0, 0, 0); until = d.getTime(); }
    else until = Date.now() + m * 60000;
    A.dnd.until = until;
    A.bubble.hideSpeech();
    syncDnd();
    A.toast(`已开启勿扰（到${m === 'tomorrow' ? '明天 0:00' : ' ' + A.hm(until)}）：只有您设的提醒会静默出现`, 3400);
  };
  A.setMeeting = b => {
    if (A.meeting === !!b) return;
    A.meeting = !!b; syncDnd();
    A.toast(b ? '检测到会议进行中：自动进入勿扰' : '会议结束，勿扰已解除');
  };
  setInterval(() => {
    if (A.dnd.until && A.dnd.until <= Date.now()) { A.dnd.until = 0; syncDnd(); A.toast('勿扰时间到，已恢复'); }
  }, 1000);

  A.setAway = b => {
    b = !!b;
    if (b === A.away) return;
    A.away = b;
    if (b) A.bubble.hide();
    else if (T.state !== 'hidden') energy.accent('happy');
    A.emit('away', b);
  };

  A.setHidden = b => {
    b = !!b;
    if (b) { A.panel.close(); A.summon.close(); A.bubble.hide(); T.act = null; setState('hidden'); }
    A.hidden = b;
    A.toast(b ? `已隐藏。提醒会以系统通知送达；按 ${A.S.hotkey.label} 或点菜单栏图标，即可再召唤我` : '我回来了。', b ? 3800 : 2000);
    A.emit('hidden', b);
  };

  A.touch = () => {}; // 活动时长由 macOS 采样，不只看这个网页

  // ---------- 发言分发：先过勿扰与离开，再决定去通知、对话还是系统通知 ----------
  A.rest = { phase: 'idle', total: 300, left: 300 };
  A.makeRing = () => {
    const C = 2 * Math.PI * 24;
    const el = h('div', { class: 'ring', html: `<svg viewBox="0 0 58 58"><circle class="r-bg" cx="29" cy="29" r="24"/><circle class="r-fg" cx="29" cy="29" r="24" stroke-dasharray="${C}"/></svg><div class="r-time"></div>` });
    const fg = el.querySelector('.r-fg'), t = el.querySelector('.r-time');
    const update = () => {
      const r = A.rest, left = r.phase === 'prompt' ? r.total : r.left;
      fg.style.strokeDashoffset = String(C * (1 - left / r.total));
      t.textContent = A.mmss(left);
    };
    let seen = false;
    const f = () => {
      if (el.isConnected) seen = true; else if (seen) { A.off('rest:tick', f); return; }
      update();
    };
    A.on('rest:tick', f); update();
    return el;
  };

  A.blip = () => {
    if (!A.S.sound) return;
    try {
      const ctx = A.audio || (A.audio = new (window.AudioContext || window.webkitAudioContext)());
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(880, ctx.currentTime); o.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      g.gain.setValueAtTime(0.0001, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
      o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.4);
    } catch (e) { /* 浏览器不允许自动播放时静默 */ }
  };

  // 勿扰期间到点的中优先级提醒先攒着；勿扰结束后只补最近的一条，过期的丢弃
  A.held = [];
  A.on('dnd', on => {
    if (on || !A.held.length) return;
    const now = Date.now(), live = A.held.splice(0).filter(x => now - x.at < x.ttl);
    if (!live.length) return;
    setTimeout(() => { if (!A.isDnd()) live[live.length - 1].run(); }, 1500);
  });

  A.speak = ev => {
    ev = Object.assign({ kind: 'speech', pri: 'low' }, ev);
    const dnd = A.isDnd();
    if (A.away) { if (ev.pri !== 'low') A.missed.push(ev); return false; }
    if (dnd && ev.pri !== 'high') {
      if (ev.pri === 'mid') {
        A.held.push({ at: Date.now(), ttl: ev.ttl || 30 * 60000, run: ev.again || (() => A.speak(ev)) });
        A.toast('勿扰中：这条提醒先攒着，勿扰结束后再说（过期则丢弃）', 2800);
      } else A.toast('勿扰中：自言自语不会触发', 2800);
      return false;
    }
    if (A.hidden) { A.sysNotify(ev); return true; }
    if (!dnd) A.blip();
    if (A.panel.isOpen()) {
      A.chat.pushPro(ev);
      if (!A.chat.generating) energy.accent(ev.kind === 'speech' ? (ev.expr || 'happy') : 'remind');
      return true;
    }
    ev.silent = dnd;
    return A.bubble.show(ev);
  };
  A.say = (text, o) => A.speak(Object.assign({ kind: 'speech', pri: 'low', text }, o));

  // ---------- 对外 ----------
  A.top = {
    cursor(x, y) { const r = stage.getBoundingClientRect(); cursor(x - r.left, y - r.top); }, hotkey, outside,
    startAct, endAct, updateAct,
    /** 常驻条上正在进行的那件事（没有就是 null）。 */
    act: () => (T.act ? { ...T.act } : null),
    state: () => T.state,
    /** 内容区在窗口里的矩形（隐身时为 null），点击区域按它上报。 */
    contentRect: () => (T.state === 'hidden' || A.hidden ? null : (T.state === 'summon' ? standbyEl : contentEl).getBoundingClientRect()),
    async relayout() {
      stopPanelDrag();
      // 常驻条和通知让开菜单栏和刘海，取两者里高的那个；顶边感应区只算刘海，不把整条菜单栏都算进去
      if (A.native) {
        try {
          const m = await command('top_metrics');
          T.notch = m?.safeTop || 0; T.safeTop = Math.max(T.notch, m?.menuTop || 0);
        } catch { T.notch = T.safeTop = 0; }
      } else { T.notch = 0; T.safeTop = 28; }   // 浏览器预览：假装有一条 28 高的菜单栏
      if (T.state !== 'hidden') setState(T.state);
    },
  };

  A.init(async () => {
    if (A.native) {
      listen('voice-permission-prompting', ({ payload }) => {
        const was = V.prompting;
        V.prompting = Boolean(payload);
        if (was && !V.prompting && T.state === 'summon') {
          A.focusWindow?.();
          focusSummon();
        }
      }).catch(() => {});
    }
    ensureThreadMounted();
    A.applyLook();
    syncDnd();
    syncExpand();
    syncField();
    syncTallBtn();
    await A.top.relayout();
    setState('hidden');
  });
})();

export {};
