/* KBOT · 核心：事件、工具、本地存储、菜单、提示 */
(function () {
  'use strict';
  const A = window.App = {};

  const ls = {};
  A.on = (e, f) => ((ls[e] = ls[e] || []).push(f), f);
  A.off = (e, f) => { ls[e] = (ls[e] || []).filter(x => x !== f); };
  A.emit = (e, ...args) => (ls[e] || []).slice().forEach(f => f(...args));

  const $ = A.$ = (s, r = document) => r.querySelector(s);
  A.$$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  A.clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  A.uid = () => Math.random().toString(36).slice(2, 9);
  A.rand = (a, b) => a + Math.random() * (b - a);
  A.pad = n => String(n).padStart(2, '0');
  A.sleep = ms => new Promise(r => setTimeout(r, ms));
  A.icon = (n, s) => Icons.svg(n, s);
  A.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  A.mmss = s => { s = Math.max(0, Math.ceil(s)); return `${A.pad(Math.floor(s / 60))}:${A.pad(s % 60)}`; };
  A.hm = t => { const d = new Date(t); return `${A.pad(d.getHours())}:${A.pad(d.getMinutes())}`; };

  A.h = function h(tag, props, kids) {
    const el = document.createElement(tag);
    for (const k in props || {}) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    if (tag === 'button' && props?.title && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', props.title);
    [].concat(kids == null ? [] : kids).forEach(c => {
      if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
    });
    return el;
  };

  // ---- 设置与持久化（状态由 runtime.ts 注入，并写入本机数据文件）----
  const stored = window.__COMPANION_STATE__ || {};
  A.stored = stored;
  const DEFAULTS = {
    theme: 'light', palette: 'blue', shell: 'light', size: 120, reduced: false,
    outsideClose: true, sound: false, persona: 'cute', freq: 'normal', nickname: '你',
    work: 60, rest: 5, model: 'none', webAvailable: false, webDefault: false, screenPerm: false,
    panelW: 360, panelH: 480, expanded: false, pos: null, speed: 1,
    autostart: false, onTop: true,
    workFrom: '09:30', workTo: '18:30', holidays: true,
    params: { waterEvery: 45, eyeEvery: 20, lunchAt: '11:15', offworkLead: 10, nightAt: '23:30' },
    festival: true, term: true,
    city: '上海', senseIdle: true, senseApp: true, senseWeather: true, senseCal: 'ask',
    apps: {
      dev: ['VS Code', 'Xcode', 'Terminal', 'Cursor'],
      office: ['Word', 'Excel', 'Keynote', 'Notion'],
      meeting: ['腾讯会议', '飞书会议', 'Zoom'],
      video: ['Bilibili', 'QuickTime', 'IINA'],
      game: ['Steam'],
      chat: ['微信', 'Slack', '飞书'],
      browser: ['Chrome', 'Safari', 'Arc'],
    },
    hotkey: { alt: true, meta: false, ctrl: false, shift: false, code: 'Space', label: '⌥ Space' },
    retention: 0,
    send: { appName: false, calTitle: false, memory: true },
    aiCompanion: false,
    dsh: {
      mode: 'auto',
      workspace: '~/KBOT',
      binary: '',
      desktopPatch: false,
    },
    updater: {
      autoCheck: true,
      endpoint: 'https://schathub.xyz/kbot/releases/latest.json',
      skippedVersion: '',
    },
    voice: {
      enabled: false,
      autoReply: false,
      autoProactive: true,
      provider: 'mimo',
      base: 'https://api.xiaomimimo.com/v1',
      model: 'mimo-v2.5-tts',
      mimoVoice: '冰糖',
      style: '',
      hasKey: false,
      sayVoice: '',
      rate: 190,
    },
    ai: {
      chat: { provider: 'deepseek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: false },
      vision: { on: false, provider: 'qwen', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', hasKey: false },
      search: { provider: 'none', hasKey: false, protocol: 'auto' },
      calls: { day: '', n: 0 },
    },
    cityInfo: '上海市 · 中国', cityCoords: { latitude: 31.23, longitude: 121.47 }, onboarding: false,
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const merge = (base, over) => {
    for (const k in over || {}) base[k] = isObj(over[k]) && isObj(base[k]) ? merge(base[k], over[k]) : over[k];
    return base;
  };
  A.defaults = () => clone(DEFAULTS);
  A.S = merge(clone(DEFAULTS), stored.S);
  // 旧版发光色（青/紫/琥珀/薄荷）对应到新的系统强调色
  const OLD_PALETTE = { cyan: 'blue', violet: 'indigo', amber: 'orange', mint: 'green' };
  if (OLD_PALETTE[A.S.palette]) A.S.palette = OLD_PALETTE[A.S.palette];
  if (A.S?.updater?.endpoint === 'kkl800291/kbot') {
    A.S.updater.endpoint = DEFAULTS.updater.endpoint;
  }
  if (!('reduced' in (stored.S || {})) && window.matchMedia) A.S.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  // 按路径读写设置（如 'params.waterEvery'）；写入后保存并广播 set:<顶层键>
  A.sget = path => path.split('.').reduce((o, k) => (o == null ? o : o[k]), A.S);
  A.sput = (path, v) => {
    const ks = path.split('.'), last = ks.pop();
    ks.reduce((o, k) => o[k], A.S)[last] = v;
    A.save(); A.emit('set:' + (ks[0] || last), A.S[ks[0] || last]);
  };

  A.persisters = {};
  A.save = () => {}; // Attached to atomic native persistence before startup.
  A.set = (k, v) => { A.S[k] = v; A.save(); A.emit('set:' + k, v); };
  // 记录当天对话调用次数（只在本机统计）
  A.countCall = () => {
    const c = A.S.ai.calls, day = new Date().toDateString();
    if (c.day !== day) { c.day = day; c.n = 0; }
    c.n++; A.save();
  };
  // ---- 提示、复制、大图 ----
  let toastTimer;
  A.toast = (msg, ms = 2400) => {
    const el = $('#toast');
    el.textContent = msg; el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  };
  A.copy = async text => {
    try { await navigator.clipboard.writeText(text); }
    catch (e) {
      const t = A.h('textarea', { style: 'position:fixed;left:-999px;top:0' });
      t.value = text; document.body.append(t); t.select();
      try { document.execCommand('copy'); } catch (_) { /* 忽略 */ }
      t.remove();
    }
  };
  A.lightbox = src => { const lb = $('#lightbox'); $('img', lb).src = src; lb.classList.add('open'); };
  $('#lightbox').addEventListener('click', () => $('#lightbox').classList.remove('open'));

  // ---- 菜单（右键菜单、菜单栏菜单共用）----
  const menuEl = $('#menu');
  let menuOpen = false, menuClose = null;
  A.menu = {
    isOpen: () => menuOpen,
    open(items, x, y, o = {}) {
      A.menu.close();
      menuEl.innerHTML = '';
      items.forEach(it => {
        if (it.sep) return menuEl.append(A.h('div', { class: 'm-sep' }));
        if (it.head) return menuEl.append(A.h('div', { class: 'm-head' }, it.head));
        const b = A.h('button', { class: 'mi', role: 'menuitem', disabled: it.disabled }, [
          A.h('span', { class: 'mi-check' }, it.check ? '✓' : ''),
          A.h('span', { class: 'mi-label' }, it.label),
          it.kbd ? A.h('span', { class: 'mi-kbd' }, it.kbd) : null,
        ]);
        b.addEventListener('click', () => { A.menu.close(); if (it.fn) it.fn(); });
        menuEl.append(b);
      });
      menuEl.classList.add('open');
      const w = menuEl.offsetWidth, h = menuEl.offsetHeight;
      menuEl.style.left = A.clamp(o.right ? x - w : x, 8, innerWidth - w - 8) + 'px';
      menuEl.style.top = A.clamp(y, 8, Math.max(8, innerHeight - h - 8)) + 'px';
      menuOpen = true; menuClose = o.onClose || null;
      A.emit('menu', true);
      A.focusWindow?.(); setTimeout(() => { if (menuOpen) menuEl.querySelector('.mi:not(:disabled)')?.focus(); }, 30);
    },
    close() {
      if (!menuOpen) return;
      menuOpen = false; menuEl.classList.remove('open'); menuEl.innerHTML = '';
      const f = menuClose; menuClose = null; if (f) f();
      A.emit('menu', false);
      if (!A.panel?.isOpen() && !document.querySelector('#sheet.open, #onboarding')) A.releaseWindow?.();
    },
  };
  document.addEventListener('pointerdown', e => {
    if (menuOpen && !menuEl.contains(e.target) && !e.target.closest('#tray, #modelTag')) A.menu.close();
  }, true);
  menuEl.addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = A.$$('.mi:not(:disabled)', menuEl), i = items.indexOf(document.activeElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
  });

  // ---- 菜单栏时钟 ----
  A.clock = () => {
    const d = new Date();
    $('#clock').textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${'日一二三四五六'[d.getDay()]} ${A.hm(d)}`;
  };

  // ---- 启动序列：各模块用 A.init 登记，main.js 统一调用 ----
  const inits = [];
  A.init = fn => { inits.push(fn); };
  A.start = async () => { for (const fn of inits) await fn(); };
})();

export {};
