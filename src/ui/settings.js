/* KBOT · 设置窗口：外壳、导航与通用控件（纯桌面壳 5 页：通用 / 智能核心 / 语音 / 感知 / 对话） */
(function () {
  'use strict';
  const A = window.App, { $, $$, h } = A;
  const PAGES = [
    ['general', '通用', 'gear'],
    ['agent', '智能核心', 'sparkle'],
    ['voice', '语音', 'speaker'],
    ['sense', '感知', 'eye'],
    ['chat', '对话', 'chat'],
  ];
  A.settingsPages = {};
  let sheet, nav, titleEl, pageEl, current = 'general', isOpen = false;

  // ---------- 通用控件 ----------
  const X = A.sx = {};
  X.group = (title, ...rows) => h('section', { class: 'sx-group' }, [title ? h('h4', {}, title) : null, h('div', { class: 'sx-card' }, rows.filter(Boolean))]);
  X.row = (label, desc, ctl) => {
    const row = h('div', { class: 'sx-row' }, [
      h('div', { class: 'sx-l' }, [h('div', { class: 'sx-t' }, label), desc ? h('div', { class: 'sx-d' }, desc) : null]),
      ctl ? h('div', { class: 'sx-c' }, ctl) : null,
    ]);
    const title = row.querySelector('.sx-t');
    if (title) {
      title.id = 'label-' + A.uid();
      row.querySelectorAll('input, select, [role="radiogroup"]').forEach(input => {
        if (!input.hasAttribute('aria-label')) input.setAttribute('aria-labelledby', title.id);
      });
    }
    return row;
  };
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
      const hit = opts.find(o => String(o[0]) === b.dataset.v);
      if (!hit) return;
      A.sput(path, hit[0]); sync(); if (after) after(hit[0]);
    });
    sync();
    return el;
  };

  X.select = (path, opts, after, w) => {
    const s = h('select', { class: 'sx-in', style: w ? `width:${w}px` : null }, opts.map(([v, l]) => h('option', { value: String(v) }, l)));
    s.value = String(A.sget(path) ?? '');
    s.addEventListener('change', () => {
      const hit = opts.find(o => String(o[0]) === s.value);
      const v = hit ? hit[0] : s.value;
      A.sput(path, v); if (after) after(v);
    });
    return s;
  };

  X.text = (path, o = {}) => {
    const i = h('input', { class: 'sx-in', type: 'text', placeholder: o.ph || '', maxlength: o.max || 120, style: `width:${o.w || 160}px`, spellcheck: 'false' });
    i.value = A.sget(path) || '';
    i.addEventListener('change', () => {
      const v = i.value.trim();
      if (!v && !o.allowEmpty) { i.value = A.sget(path) || ''; return; }
      A.sput(path, v); if (o.after) o.after(v);
    });
    return i;
  };

  X.num = (path, o) => {
    const i = h('input', { class: 'sx-in', type: 'number', min: o.min, max: o.max, step: o.step || 1, inputmode: 'numeric', style: `width:${o.w || 72}px` });
    const err = o.err || h('span', { class: 'sx-err' });
    i.value = A.sget(path);
    const commit = () => {
      const n = Number(i.value);
      const ok = i.value.trim() !== '' && Number.isInteger(n) && n >= o.min && n <= o.max;
      i.classList.toggle('bad', !ok); i.setAttribute('aria-invalid', String(!ok));
      err.textContent = ok ? '' : `请输入 ${o.min}–${o.max} 的整数`;
      if (ok) { A.sput(path, n); if (o.after) o.after(n); }
      return ok;
    };
    i.addEventListener('change', commit);
    i.addEventListener('keydown', e => { if (e.key === 'Enter' && commit()) i.blur(); });
    return h('span', { class: 'sx-num' }, [i, o.unit ? h('span', { class: 'sx-u' }, o.unit) : null, o.err ? null : err]);
  };

  X.keyCtl = (cfgPath, slot, after) => {
    const wrap = h('div', { class: 'sx-key' });
    const hasKey = () => !!A.sget(cfgPath + '.hasKey');
    const draw = editing => {
      wrap.replaceChildren();
      if (hasKey() && !editing) {
        wrap.append(
          h('span', { class: 'sx-status ok' }, '已保存在钥匙串'),
          X.btn('更换', () => draw(true), 'ghost'),
          X.btn('删除', async () => {
            try {
              await A.nativeCommand('delete_key', { slot });
              A.sput(cfgPath + '.hasKey', false);
              if (after) after(false);
              draw(false);
            } catch (e) { A.toast(String(e), 5000); }
          }, 'ghost'),
        );
        return;
      }
      const i = h('input', { class: 'sx-in', type: 'password', placeholder: '输入 API Key…', style: 'width:190px', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'API Key' });
      const eye = h('button', { class: 'ib', type: 'button', title: '显示 / 隐藏', 'aria-label': '显示或隐藏 Key', html: A.icon('eye', 15) });
      eye.addEventListener('click', () => {
        const show = i.type === 'password';
        i.type = show ? 'text' : 'password';
        eye.innerHTML = A.icon(show ? 'eyeoff' : 'eye', 15);
      });
      const save = async () => {
        const v = i.value.trim();
        if (!v) { i.focus(); return; }
        try {
          await A.nativeCommand('save_key', { slot, key: v });
          A.sput(cfgPath + '.hasKey', true);
          i.value = '';
          if (after) after(true);
          draw(false);
          A.toast('Key 已保存到本机钥匙串');
        } catch (e) { A.toast(String(e), 5000); }
      };
      i.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
      wrap.append(i, eye, X.btn('保存', save, 'primary'));
      if (hasKey()) wrap.append(X.btn('取消', () => draw(false), 'ghost'));
      if (editing) setTimeout(() => i.focus(), 0);
    };
    draw(false);
    return wrap;
  };

  // ---------- 外壳 ----------
  function build() {
    titleEl = h('h2');
    pageEl = h('div', { class: 'sh-page' });
    nav = h('nav', { class: 'sh-nav', 'aria-label': '设置分类' }, PAGES.map(([id, label, ic]) => h('button', { type: 'button', 'data-page': id }, [h('span', { html: A.icon(ic, 15) }), label])));
    sheet = h('div', { id: 'sheet', hidden: true, role: 'dialog', 'aria-label': '设置' }, h('div', { class: 'sh-win' }, [
      h('div', { class: 'sh-bar' }, [
        h('button', { class: 'sh-dot', type: 'button', title: '关闭（Esc）', 'aria-label': '关闭设置', onclick: () => A.closeSettings() }),
        h('i'), h('i'), h('span', {}, 'KBOT · 设置'),
      ]),
      h('div', { class: 'sh-body' }, [nav, h('div', { class: 'sh-main' }, [titleEl, pageEl])]),
    ]));
    nav.addEventListener('click', e => { const b = e.target.closest('[data-page]'); if (b) go(b.dataset.page); });
    document.body.append(sheet);
    markNav();
  }

  function markNav() {
    if (!nav) return;
    const btn = $('[data-page="agent"]', nav);
    if (!btn) return;
    const st = A.dshState;
    const disconnected = st ? (!st.connected && st.status !== 'connecting') : A.S.model === 'none';
    btn.classList.toggle('warn', disconnected);
  }

  function go(id, keepScroll) {
    if (id === 'ai' || id === 'persona' || id === 'memory' || id === 'remind') id = 'agent';
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
    A.menu?.close?.();
    if (A.panel?.isOpen?.()) A.panel.close();
    A.focusWindow?.();
    sheet.hidden = false; sheet.inert = false;
    go(page || current);
    void sheet.offsetWidth;
    sheet.classList.add('open'); isOpen = true;
    sheet.querySelector('[data-page="' + current + '"]')?.focus();
    A.emit('settings', true);
  };
  A.closeSettings = () => {
    if (!isOpen) return false;
    isOpen = false; sheet.inert = true; sheet.classList.remove('open');
    setTimeout(() => { if (!isOpen) sheet.hidden = true; }, 200);
    A.emit('settings', false);
    return true;
  };
  A.refreshSettings = () => { if (isOpen) go(current, true); markNav(); };

  A.on('set:model', () => { if (nav) markNav(); });
  A.on('dsh:state', () => {
    if (nav) markNav();
    if (isOpen && current === 'agent' && pageEl?._redraw) pageEl._redraw();
  });
  A.on('updater:state', () => {
    if (isOpen && current === 'general' && pageEl?._redraw) pageEl._redraw();
  });
})();

export {};
