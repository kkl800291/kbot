/* 赛博伙伴 · 设置窗口：外壳、导航与通用控件（各页内容在 settings-a.js / settings-b.js） */
(function () {
  'use strict';
  const A = window.App, { $, $$, h } = A;
  const PAGES = [
    ['general', '通用', 'gear'], ['persona', '角色', 'robot'], ['routine', '作息', 'clock'], ['dates', '日期', 'leaf'],
    ['remind', '提醒', 'bell'], ['sense', '感知', 'eye'], ['ai', 'AI', 'sparkle'], ['chat', '对话', 'chat'], ['memory', '记忆', 'bookmark'],
  ];
  // 页面在数据变化时需要重绘（例如在聊天里新建了提醒）
  const LIVE = { reminders: 'remind', memories: 'memory', birthdays: 'dates' };
  A.settingsPages = {};
  let sheet, nav, titleEl, pageEl, current = 'general', isOpen = false;

  // ---------- 通用控件 ----------
  const X = A.sx = {};
  X.group = (title, ...rows) => h('section', { class: 'sx-group' }, [title ? h('h4', {}, title) : null, h('div', { class: 'sx-card' }, rows)]);
  X.row = (label, desc, ctl) => h('div', { class: 'sx-row' }, [
    h('div', { class: 'sx-l' }, [h('div', { class: 'sx-t' }, label), desc ? h('div', { class: 'sx-d' }, desc) : null]),
    ctl ? h('div', { class: 'sx-c' }, ctl) : null,
  ]);
  X.note = text => h('p', { class: 'sx-note' }, text);
  X.btn = (label, fn, cls = '') => h('button', { class: 'btn sm ' + cls, type: 'button', onclick: fn }, label);
  X.empty = text => h('div', { class: 'sx-empty' }, text);
  // 两步确认：第一次点击变成“再点一次确认”，3 秒内不点就还原
  X.danger = (label, confirmLabel, fn) => {
    let t = 0;
    const b = X.btn(label, () => {
      if (b.dataset.arm) { clearTimeout(t); delete b.dataset.arm; b.textContent = label; fn(); return; }
      b.dataset.arm = '1'; b.textContent = confirmLabel;
      t = setTimeout(() => { delete b.dataset.arm; b.textContent = label; }, 3000);
    }, 'danger');
    return b;
  };

  X.switch = (on, fn) => {
    const i = h('input', { type: 'checkbox', role: 'switch' });
    i.checked = !!on;
    i.addEventListener('change', () => fn(i.checked));
    return h('label', { class: 'sx-tg' }, [i, h('i')]);
  };
  X.toggle = (path, after) => X.switch(A.sget(path), v => { A.sput(path, v); if (after) after(v); });

  X.seg = (path, opts, after) => {
    const el = h('div', { class: 'sx-seg', role: 'radiogroup' }, opts.map(([v, l]) => h('button', { type: 'button', role: 'radio', 'data-v': String(v) }, l)));
    const sync = () => $$('button', el).forEach(b => {
      const on = b.dataset.v === String(A.sget(path));
      b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on));
    });
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const v = opts.find(o => String(o[0]) === b.dataset.v)[0];
      A.sput(path, v); sync(); if (after) after(v);
    });
    sync();
    return el;
  };

  X.select = (path, opts, after, w) => {
    const s = h('select', { class: 'sx-in', style: w ? `width:${w}px` : null }, opts.map(([v, l]) => h('option', { value: String(v) }, l)));
    s.value = String(A.sget(path));
    s.addEventListener('change', () => { const v = opts.find(o => String(o[0]) === s.value)[0]; A.sput(path, v); if (after) after(v); });
    return s;
  };

  X.text = (path, o = {}) => {
    const i = h('input', { class: 'sx-in', type: 'text', placeholder: o.ph || '', maxlength: o.max || 20, style: `width:${o.w || 160}px`, spellcheck: 'false' });
    i.value = A.sget(path) || '';
    i.addEventListener('change', () => {
      const v = i.value.trim();
      if (!v) { i.value = A.sget(path) || ''; return; }
      A.sput(path, v); if (o.after) o.after(v);
    });
    return i;
  };

  // 24 小时制的时分选择；不用 <input type=time>，因为它会跟着系统语言显示成“上午/下午”
  X.timeOf = (val, onChange) => {
    const [hh, mm] = String(val).split(':').map(Number);
    const hs = h('select', { class: 'sx-in sx-hm' }, Array.from({ length: 24 }, (_, i) => h('option', { value: String(i) }, A.pad(i))));
    const ms = h('select', { class: 'sx-in sx-hm' }, Array.from({ length: 12 }, (_, i) => h('option', { value: String(i * 5) }, A.pad(i * 5))));
    if (mm % 5) ms.append(h('option', { value: String(mm) }, A.pad(mm)));
    hs.value = String(hh); ms.value = String(mm);
    const fire = () => onChange(`${A.pad(+hs.value)}:${A.pad(+ms.value)}`);
    hs.addEventListener('change', fire); ms.addEventListener('change', fire);
    return h('span', { class: 'sx-time' }, [hs, h('b', {}, ':'), ms]);
  };
  X.time = (path, after) => X.timeOf(A.sget(path), v => { A.sput(path, v); if (after) after(v); });

  // 整数输入：保存时校验范围，不合法就标红并保留旧值
  // o.err：外部提供的错误提示位置（多个输入共用一行提示时使用）
  X.num = (path, o) => {
    const i = h('input', { class: 'sx-in', type: 'number', min: o.min, max: o.max, step: 1, inputmode: 'numeric', style: 'width:68px' });
    const err = o.err || h('span', { class: 'sx-err' });
    i.value = A.sget(path);
    const commit = () => {
      const n = Number(i.value);
      const ok = i.value.trim() !== '' && Number.isInteger(n) && n >= o.min && n <= o.max;
      i.classList.toggle('bad', !ok);
      err.textContent = ok ? '' : `请输入 ${o.min}–${o.max} 的整数`;
      if (ok) { A.sput(path, n); if (o.after) o.after(n); }
      return ok;
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', e => { if (e.key === 'Enter' && commit()) i.blur(); });
    return h('span', { class: 'sx-num' }, [i, o.unit ? h('span', { class: 'sx-u' }, o.unit) : null, o.err ? null : err]);
  };

  // ---------- 外壳 ----------
  function build() {
    titleEl = h('h2');
    pageEl = h('div', { class: 'sh-page' });
    nav = h('nav', { class: 'sh-nav', 'aria-label': '设置分类' }, PAGES.map(([id, label, ic]) => h('button', { type: 'button', 'data-page': id }, [h('span', { html: A.icon(ic, 15) }), label])));
    sheet = h('div', { id: 'sheet', hidden: true, role: 'dialog', 'aria-label': '设置' }, h('div', { class: 'sh-win' }, [
      h('div', { class: 'sh-bar' }, [
        h('button', { class: 'sh-dot', type: 'button', title: '关闭（Esc）', 'aria-label': '关闭设置', onclick: () => A.closeSettings() }),
        h('i'), h('i'), h('span', {}, '赛博伙伴 · 设置'),
      ]),
      h('div', { class: 'sh-body' }, [nav, h('div', { class: 'sh-main' }, [titleEl, pageEl])]),
    ]));
    nav.addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) go(b.dataset.page); });
    document.body.append(sheet);
    markNav();
  }

  function markNav() { $('[data-page="ai"]', nav).classList.toggle('warn', A.S.model === 'none'); }

  function go(id, keepScroll) {
    if (!A.settingsPages[id]) id = 'general';
    const top = pageEl.scrollTop;
    current = id;
    $$('[data-page]', nav).forEach(b => b.classList.toggle('on', b.dataset.page === id));
    titleEl.textContent = PAGES.find(p => p[0] === id)[1];
    pageEl.innerHTML = ''; pageEl._redraw = null;
    A.settingsPages[id](pageEl);
    pageEl.scrollTop = keepScroll ? top : 0;
  }

  A.openSettings = page => {
    if (!sheet) build();
    A.menu.close();
    // 对话面板浮在设置窗口之上，会盖住右侧的开关和按钮，所以打开设置时先收起
    if (A.panel.isOpen()) A.panel.close();
    sheet.hidden = false;
    go(page || current);
    void sheet.offsetWidth;
    sheet.classList.add('open'); isOpen = true;
    A.emit('settings', true);
  };
  A.closeSettings = () => {
    if (!isOpen) return false;
    isOpen = false; sheet.classList.remove('open');
    setTimeout(() => { if (!isOpen) sheet.hidden = true; }, 200);
    A.emit('settings', false);
    return true;
  };

  Object.keys(LIVE).forEach(ev => A.on(ev, () => { if (isOpen && current === LIVE[ev]) go(current, true); }));
  A.on('set:model', () => { if (nav) markNav(); });
})();
