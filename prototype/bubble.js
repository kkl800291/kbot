/* 赛博伙伴 · 气泡、发言分发（勿扰/隐藏/面板打开时的去向）、系统通知、倒计时环 */
(function () {
  'use strict';
  const A = window.App, { h, clamp } = A, robot = A.robot;
  let cur = null;
  const queue = [];
  A.rest = { phase: 'idle', total: 300, left: 300 };

  // 休息倒计时环：气泡和面板里的提醒共用同一份 A.rest 状态
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

  function place() {
    if (!cur) return;
    const el = cur.el, b = A.petBody(), bw = el.offsetWidth, bh = el.offsetHeight;
    const left = clamp(b.cx - bw / 2, 8, Math.max(8, innerWidth - bw - 8));
    const above = b.top - 12 - bh >= 34;
    const top = above ? b.top - 12 - bh : Math.min(b.bottom + 8, innerHeight - bh - 8);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    el.style.setProperty('--tail-x', clamp(b.cx - left, 18, Math.max(18, bw - 18)) + 'px');
    el.classList.toggle('below', !above);
  }

  function dismiss(b, instant, why) {
    if (!b || b.gone) return;
    b.gone = true;
    b.timers.forEach(t => { clearTimeout(t); clearInterval(t); });
    b.el.classList.remove('show');
    setTimeout(() => b.el.remove(), instant ? 0 : 260);
    if (cur === b) {
      cur = null; robot.clearFlash();
      const next = queue.shift();
      if (next) setTimeout(() => { if (!cur) A.bubble.show(next); }, 500);
    }
    if (why === 'expire' && b.ev.onExpire) b.ev.onExpire();
  }

  function act(b, a) {
    dismiss(b, false);
    try { if (a.fn) a.fn(); } finally { if (!a.quiet) robot.flash(a.expr || 'happy', 1400); }
  }

  function startFade(b, ms) {
    clearTimeout(b.fade);
    b.fade = setTimeout(() => dismiss(b, false, 'expire'), ms);
    b.timers.push(b.fade);
  }

  function mount(ev) {
    const kind = ev.kind || 'speech';
    // 全文先放进隐藏的占位里：气泡一开始就是最终尺寸，打字时不会变宽、位置也不会飘
    const typed = h('span'), rest = h('span', { style: 'visibility:hidden' }, ev.text);
    const acts = h('div', { class: 'b-actions' });
    const el = h('div', { class: `bubble ${kind}`, role: kind === 'speech' ? 'status' : 'alertdialog' }, [
      ev.silent ? h('div', { class: 'b-tag' }, '勿扰中 · 静默提示') : null,
      ev.title ? h('div', { class: 'b-title' }, ev.title) : null,
      h('div', { class: 'b-main' }, [h('div', { class: 'b-text' }, [typed, rest]), ev.ring ? A.makeRing() : null]),
      acts,
      h('div', { class: 'b-tail' }),
    ]);
    const b = { el, ev, kind, timers: [], gone: false, typed, rest };
    cur = b;
    (ev.actions || []).forEach(a => acts.append(h('button', { class: 'btn sm' + (a.primary ? ' primary' : ''), onclick: e => { e.stopPropagation(); act(b, a); } }, a.label)));
    // 点按钮不能抢走用户正在输入的应用的焦点
    el.addEventListener('mousedown', e => e.preventDefault());
    el.addEventListener('mouseenter', () => clearTimeout(b.fade));
    el.addEventListener('mouseleave', () => { if (b.typedDone && !ev.sticky) startFade(b, kind === 'speech' ? 2500 : 120000); });
    if (kind === 'speech') {
      el.addEventListener('click', e => {
        if (e.target.closest('a, button')) return;
        const text = ev.text; dismiss(b, true); A.panel.open({ seed: text });
      });
    }
    document.body.append(el);
    place();
    requestAnimationFrame(() => el.classList.add('show'));

    const text = ev.text, step = kind === 'speech' ? 42 : 22;
    let i = 0;
    robot.flash(kind === 'speech' ? 'talk' : 'remind', kind === 'speech' ? text.length * step + 400 : 120000);
    const tm = setInterval(() => {
      i++; typed.textContent = text.slice(0, i); rest.textContent = text.slice(i);
      if (kind === 'speech') robot.talkPulse();
      if (i >= text.length) b.finishTyping();
    }, step);
    b.finishTyping = () => {
      if (b.typedDone) return;
      clearInterval(tm); b.typedDone = true;
      typed.textContent = text; rest.textContent = '';
      if (kind === 'speech') { robot.clearFlash(); if (ev.expr) robot.flash(ev.expr, 2200); }
      if (!ev.sticky) startFade(b, kind === 'speech' ? 8000 : 120000);
    };
    b.timers.push(tm);
    return b;
  }

  A.bubble = {
    show(ev) {
      if (cur && !cur.gone) {
        if (cur.kind === 'speech') dismiss(cur, true);
        else if ((ev.kind || 'speech') === 'speech') return false;
        else { queue.push(ev); return true; }
      }
      mount(ev); return true;
    },
    hide(instant) { queue.length = 0; if (cur) dismiss(cur, instant); },
    hideSpeech() { if (cur && cur.kind === 'speech') dismiss(cur, true); },
    // 打开面板时，未处理的提醒改到面板里显示，并保留按钮
    takeover() { const c = cur; if (!c) return null; const ev = c.ev; dismiss(c, true); return ev; },
    // 在当前气泡里临时换一句话（比如休息中的轻声提醒），过一会儿恢复原文
    flashText(text, ms) {
      const b = cur; if (!b || b.gone) return false;
      b.finishTyping();
      b.typed.textContent = text; b.rest.textContent = '';
      clearTimeout(b.flashT);
      b.flashT = setTimeout(() => { b.typed.textContent = b.ev.text; place(); }, ms);
      b.timers.push(b.flashT); place();
      return true;
    },
    current: () => cur,
    place,
  };
  A.on('petmove', place);
  addEventListener('resize', place);

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

  // 系统通知：角色被隐藏时，提醒改为通知形式
  let nTimer;
  A.sysNotify = ev => {
    const n = A.$('#notify');
    n.innerHTML = `<div class="n-icon">${A.icon('robot', 20)}</div><div><div class="n-title">${MD.esc(ev.title || '赛博伙伴')}</div><div class="n-text">${MD.esc(ev.text)}</div><div class="n-from">小派 · 刚刚${A.isDnd() ? ' · 静默' : ''}</div></div>`;
    n.classList.add('show');
    clearTimeout(nTimer); nTimer = setTimeout(() => n.classList.remove('show'), 7000);
  };
  A.$('#notify').addEventListener('click', () => { A.$('#notify').classList.remove('show'); A.setHidden(false); });

  // 勿扰期间到点的中优先级提醒先攒着；勿扰结束后补说，过期的丢弃。同时攒了几条时只补最近的一条，避免一下子全冒出来
  A.held = [];
  A.on('dnd', on => {
    if (on || !A.held.length) return;
    const now = Date.now(), live = A.held.splice(0).filter(x => now - x.at < x.ttl);
    if (!live.length) return;
    setTimeout(() => { if (!A.isDnd()) live[live.length - 1].run(); }, 1500);
  });

  // 发言分发：先过勿扰与离开，再决定去气泡、面板还是系统通知
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
      if (!A.chat.generating) robot.flash(ev.kind === 'speech' ? (ev.expr || 'happy') : 'remind', 1800);
      return true;
    }
    ev.silent = dnd;
    return A.bubble.show(ev);
  };
  A.say = (text, o) => A.speak(Object.assign({ kind: 'speech', pri: 'low', text }, o));
})();
