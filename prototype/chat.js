/* 赛博伙伴 · 对话：会话数据、历史列表、消息渲染、确认卡片、主动发言 */
(function () {
  'use strict';
  const A = window.App, { $, h } = A;
  const C = A.chat = { convs: [], cur: null, generating: false };
  const box = $('#messages'), hist = $('#history'), hl = $('.h-list', hist), hs = $('input', hist);
  const DAY = 86400000;
  const EXAMPLES = ['20 分钟后提醒我给老王回电话', '查一下今年冬至是哪天', '写个防抖函数，顺便对比下节流', '我今天有点累了'];

  const mkConv = () => ({ id: A.uid(), title: '新对话', t: Date.now(), webOn: A.S.webDefault, serious: false, messages: [] });
  const find = id => C.cur && C.cur.messages.find(m => m.id === id);
  const elOf = id => box.querySelector(`.msg[data-id="${id}"]`);
  const nearBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const toBottom = () => box.scrollTo({ top: box.scrollHeight, behavior: 'auto' });
  C.find = find;

  function seed() {
    const now = Date.now();
    const mk = (title, ago, msgs) => ({
      id: A.uid(), title, t: now - ago, webOn: true, serious: false,
      messages: msgs.map(([role, text, more]) => Object.assign({ id: A.uid(), role, text, status: 'done', time: now - ago }, more)),
    });
    return [
      mk('今年冬至是哪天', 26 * 3600e3, [
        ['user', '查一下今年冬至是哪天？'],
        ['assistant', '**2026 年冬至是 12 月 22 日（周二）** [1]。\n\n- 这天北半球白昼最短、黑夜最长 [2]\n- 北方习俗吃饺子，南方不少地方吃汤圆 [2]', {
          sources: [
            { title: '2026 年二十四节气时间表', site: 'example.com', url: 'https://example.com/jieqi-2026' },
            { title: '冬至的天文意义与民间习俗', site: 'example.org', url: 'https://example.org/dongzhi' },
          ],
        }],
      ]),
      mk('防抖和节流的区别', 27 * 3600e3, [
        ['user', '防抖和节流有什么区别？'],
        ['assistant', '一句话区分：**防抖**是“等你停下来再执行”，**节流**是“隔一段时间最多执行一次”。\n\n| 对比 | 防抖 debounce | 节流 throttle |\n| --- | --- | --- |\n| 触发时机 | 停止触发后执行一次 | 固定间隔最多执行一次 |\n| 典型场景 | 搜索联想、窗口 resize | 滚动监听、拖拽 |'],
      ]),
      mk('周报怎么写', 4 * DAY, [
        ['user', '帮我润色一句周报：这周做了登录页改版，修了一些 bug'],
        ['assistant', '可以这样写：\n\n> 本周完成登录页改版并上线灰度，修复 6 个影响下单流程的缺陷。\n\n想更有说服力的话，补上数据（比如转化率的变化）。'],
      ]),
    ];
  }

  C.serialize = () => C.convs.filter(c => c.messages.length).slice(0, 30).map(c => ({
    id: c.id, title: c.title, t: c.t, webOn: c.webOn, serious: c.serious,
    messages: c.messages.map(m => {
      const o = {
        id: m.id, role: m.role, text: m.text, time: m.time, kind: m.kind, via: m.via, title: m.title,
        sources: m.sources, chips: m.chips, card: m.card, done: m.done,
        status: m.status === 'streaming' || m.status === 'thinking' ? 'stopped' : m.status,
      };
      if (m.images) o.images = m.images.map(i => ({ src: i.thumb || i.src, thumb: i.thumb || i.src, ow: i.ow, oh: i.oh }));
      return o;
    }),
  }));
  A.persisters.convs = C.serialize;

  // ---------- 状态行 ----------
  C.status = (text, cls) => {
    const s = $('#pSub');
    if (!text) {
      if (A.S.model === 'none') { text = '未配置 AI · 提醒功能照常可用'; cls = 'off'; }
      else { text = A.dndLabel() || '在线 · 随时可聊'; cls = ''; }
    }
    s.textContent = text; s.className = 'p-sub' + (cls ? ' ' + cls : '');
  };
  A.on('dnd', () => { if (!C.generating) C.status(); });

  // ---------- 会话 ----------
  C.newConv = focus => {
    if (C.generating && C.stop) C.stop();
    if (C.cur && !C.cur.messages.length) {
      C.closeHistory(); if (focus) { C.render(); $('#input').focus(); }
      return C.cur;
    }
    const c = mkConv(); C.convs.unshift(c); C.cur = c;
    C.closeHistory(); C.render();
    if (focus && !$('#input').disabled) $('#input').focus();
    return c;
  };
  C.switchTo = id => {
    const c = C.convs.find(x => x.id === id); if (!c) return;
    if (C.generating && C.stop) C.stop();
    C.cur = c; C.closeHistory(); C.render();
  };
  C.deleteConv = id => {
    const c = C.convs.find(x => x.id === id); if (!c) return;
    C.convs = C.convs.filter(x => x !== c);
    if (c === C.cur) { C.cur = null; C.newConv(false); }
    A.save(); renderHistory(); A.toast(`已删除对话「${c.title}」`);
  };
  // 按“对话记录保留期限”删除过期对话；当前正在看的对话不删
  C.prune = () => {
    const days = A.S.retention; if (!days) return 0;
    const cut = Date.now() - days * DAY, keep = C.convs.filter(c => c === C.cur || c.t >= cut), n = C.convs.length - keep.length;
    if (n) { C.convs = keep; A.save(); if (hist.classList.contains('open')) renderHistory(); }
    return n;
  };
  C.clearAll = () => { if (C.generating && C.stop) C.stop(); C.convs = []; C.cur = null; C.newConv(false); A.save(); };

  C.onOpen = ({ seed: text, pro } = {}) => {
    if (text) {
      if (C.cur.messages.length) C.newConv(false);
      C.cur.title = text.slice(0, 18);
      C.cur.messages.push({ id: A.uid(), role: 'assistant', text, status: 'done', time: Date.now() });
      C.render();
    } else if (!box.children.length) C.render();
    if (pro) C.pushPro(pro);
  };

  // ---------- 渲染 ----------
  const ico = (n, s = 14) => A.icon(n, s);
  const abtn = (icon, title, a) => h('button', { title, 'aria-label': title, 'data-a': a, html: ico(icon) });
  const renderText = m => MD.render(m.text + (m.status === 'streaming' ? '\u2588' : '')).replace(/\u2588/g, '<span class="caret"></span>');

  function emptyEl() {
    return h('div', { class: 'empty' }, [
      h('div', { class: 'e-face' }, [h('i'), h('i')]),
      h('div', { class: 'e-title' }, '嗨，我是小派～'),
      h('div', { class: 'e-sub' }, '想聊什么都可以。查资料、写代码、看图片、记提醒，我都能帮你。'),
      h('div', { class: 'e-chips' }, EXAMPLES.map(t => h('button', { class: 'chip', 'data-a': 'example', 'data-send': t }, t))),
      h('div', { class: 'e-tip', html: ico('image', 13) + '<span>可以粘贴、拖入图片，或点输入框旁的图片按钮</span>' }),
    ]);
  }
  function guideEl() {
    return h('div', { class: 'guide' }, [
      h('div', { class: 'e-face sad' }, [h('i'), h('i')]),
      h('div', { class: 'e-title' }, '还没配置 AI 服务'),
      h('div', { class: 'e-sub' }, '填上 API Key 就能和我聊天、查资料、看图片啦。休息、喝水这些提醒不需要 AI，现在就能用。'),
      h('div', { class: 'providers' }, ['DeepSeek', '通义千问', 'Grok', 'OpenAI', '自定义'].map(n => h('span', {}, n))),
      h('button', { class: 'btn primary', 'data-a': 'cfg' }, '去设置'),
      h('div', { class: 'e-tip' }, 'API Key 只保存在本机钥匙串'),
    ]);
  }

  function userEl(m) {
    const el = h('div', { class: 'msg user', 'data-id': m.id });
    if (m.images && m.images.length) {
      el.append(h('div', { class: 'm-images' }, m.images.map((im, i) => h('img', { src: im.src, alt: `图片 ${i + 1}`, 'data-a': 'img', 'data-i': i }))));
    }
    if (m.text) el.append(h('div', { class: 'm-bubble' }, m.text));
    el.append(h('div', { class: 'm-actions' }, [abtn('copy', '复制', 'copy'), abtn('pencil', '编辑后重新发送', 'edit')]));
    return el;
  }

  function cardEl(m) {
    const c = m.card, rem = c.type === 'reminder';
    const el = h('div', { class: `card ${c.type} ${c.state}` });
    el.append(h('div', { class: 'c-title', html: ico(rem ? 'bell' : 'bookmark', 15) + `<span>${rem ? '提醒确认' : '要我记住吗？'}</span>` }));
    const ed = c.state === 'editing' ? 'true' : null;
    if (rem) {
      const rows = h('div', { class: 'c-rows' });
      [['时间', 'when'], ['重复', 'repeat'], ['内容', 'content']].forEach(([l, k]) => rows.append(h('span', {}, l), h('b', { 'data-f': k, contenteditable: ed, spellcheck: 'false' }, c[k])));
      el.append(rows);
    } else el.append(h('div', { class: 'c-text', 'data-f': 'content', contenteditable: ed, spellcheck: 'false' }, c.content));
    const B = (label, d, cls) => h('button', { class: 'btn sm' + (cls ? ' ' + cls : ''), 'data-a': 'card', 'data-do': d }, label);
    const foot = h('div', { class: 'c-foot' });
    if (c.state === 'pending') foot.append(...[B(rem ? '确认保存' : '记住', 'save', 'primary'), rem ? B('修改', 'edit') : null, B(rem ? '取消' : '不用了', 'no', 'ghost')].filter(Boolean));
    else if (c.state === 'editing') foot.append(B('完成修改', 'apply', 'primary'), B('取消修改', 'cancel-edit', 'ghost'));
    else if (c.state === 'saved') foot.append(h('span', { class: 'done', html: ico('check') + (rem ? '已保存，可在「提醒列表」查看' : '记住啦，可在「设置 → 记忆」管理') }));
    else foot.append(h('span', { class: 'done muted' }, c.state === 'cancelled' ? '已取消' : '好的，不记'));
    el.append(foot);
    return el;
  }

  function assistantEl(m) {
    const el = h('div', { class: 'msg assistant', 'data-id': m.id });
    if (m.via) el.append(h('div', { class: 'm-via' }, m.via));
    if (m.steps && m.steps.length) {
      el.append(h('div', { class: 'steps' }, m.steps.map(s => h('div', { class: 'step' + (s.done ? ' done' : '') }, [s.done ? h('span', { html: ico('check', 12) }) : h('i', { class: 'spin' }), s.t]))));
    }
    if (m.status === 'thinking' && !(m.steps && m.steps.length)) el.append(h('div', { class: 'typing' }, [h('i'), h('i'), h('i')]));
    if (m.text || m.status === 'streaming') el.append(h('div', { class: 'md', html: renderText(m) }));
    if (m.sources && m.sources.length) {
      el.append(h('div', { class: 'sources' }, [
        h('div', { class: 's-title' }, `来源 · ${m.sources.length}`),
        ...m.sources.map((s, i) => h('a', { class: 'src', href: s.url, target: '_blank', rel: 'noopener noreferrer' }, [h('b', {}, String(i + 1)), h('span', { class: 's-t' }, s.title), h('span', { class: 's-d' }, s.site)])),
      ]));
    }
    if (m.chips && m.chips.length && C.cur.messages[C.cur.messages.length - 1] === m) {
      el.append(h('div', { class: 'chips' }, m.chips.map(c => h('button', { class: 'chip', 'data-a': 'chip', 'data-send': c.send }, c.label))));
    }
    if (m.card) el.append(cardEl(m));
    if (m.status === 'stopped') el.append(h('div', { class: 'm-status' }, '已停止生成'));
    if (m.status === 'error') el.append(h('div', { class: 'm-status err' }, ['回复中断了（网络异常），已保留已输出的内容', h('button', { class: 'btn sm', 'data-a': 'retry' }, '重试')]));
    if (m.status === 'done' || m.status === 'stopped' || m.status === 'error') {
      el.append(h('div', { class: 'm-actions' }, [abtn('copy', '复制', 'copy'), abtn('refresh', '重新生成', 'regen')]));
    }
    return el;
  }

  function proEl(m) {
    const icon = m.kind === 'rest' ? 'leaf' : m.kind === 'remind' ? 'bell' : 'sparkle';
    return h('div', { class: `msg pro ${m.kind}`, 'data-id': m.id }, [
      h('div', { class: 'm-tag', html: ico(icon, 12) + `<span>小派主动说${m.title ? ' · ' + MD.esc(m.title) : ''}</span>` }),
      h('div', { class: 'm-body md', html: MD.render(m.text) }),
      m.ring ? A.makeRing() : null,
      m.actions && !m.done ? h('div', { class: 'm-btns' }, m.actions.map((a, i) => h('button', { class: 'btn sm' + (a.primary ? ' primary' : ''), 'data-a': 'pro', 'data-i': String(i) }, a.label))) : null,
      m.done ? h('div', { class: 'done muted' }, `已处理：${m.done}`) : null,
    ]);
  }

  function msgEl(m) {
    if (m.role === 'user') return userEl(m);
    if (m.role === 'assistant') return assistantEl(m);
    if (m.role === 'pro') return proEl(m);
    return h('div', { class: 'notice', 'data-id': m.id }, m.text);
  }

  C.render = () => {
    box.innerHTML = '';
    const c = C.cur;
    if (A.S.model === 'none') box.append(guideEl());
    else if (!c.messages.length) box.append(emptyEl());
    else c.messages.forEach(m => box.append(msgEl(m)));
    toBottom();
    if (!C.generating) C.status();
    if (C.refreshComposer) C.refreshComposer();
  };
  C.append = m => {
    const near = nearBottom();
    const first = box.querySelector('.empty, .guide'); if (first) first.remove();
    box.append(msgEl(m));
    if (near || m.role === 'user') toBottom();
  };
  C.paint = m => {
    const el = box.querySelector(`[data-id="${m.id}"]`); if (!el) return;
    const near = nearBottom(); el.replaceWith(msgEl(m)); if (near) toBottom();
  };
  C.paintText = m => {
    const el = elOf(m.id), md = el && el.querySelector('.md');
    if (!md) return C.paint(m);
    const near = nearBottom(); md.innerHTML = renderText(m); if (near) toBottom();
  };
  C.dropChips = () => { C.cur.messages.forEach(m => { if (m.chips) { m.chips = null; const e = elOf(m.id); const c = e && e.querySelector('.chips'); if (c) c.remove(); } }); };

  // 对话面板打开时，主动发言以“小派主动说”的形式出现在对话里
  C.pushPro = ev => {
    const m = { id: A.uid(), role: 'pro', kind: ev.kind || 'speech', text: ev.text, title: ev.title, ring: !!ev.ring, actions: ev.actions || null, time: Date.now() };
    C.cur.messages.push(m); C.cur.t = Date.now(); C.append(m); A.save();
  };

  // ---------- 消息上的操作（事件委托）----------
  function cardAction(m, d, el) {
    const c = m.card, rem = c.type === 'reminder';
    if (d === 'save') {
      if (rem) { A.brain.addReminder({ when: c.when, repeat: c.repeat, content: c.content, at: c.at }); A.toast(`已保存：${c.when} 提醒你${c.content}`); }
      else { A.brain.addMemory(c.content); A.toast('记住啦'); }
      c.state = 'saved';
    } else if (d === 'edit') c.state = 'editing';
    else if (d === 'cancel-edit') c.state = 'pending';
    else if (d === 'apply') {
      const timeBefore = c.when;
      A.$$('[data-f]', el).forEach(n => { const v = n.textContent.trim(); if (v) c[n.dataset.f] = v; });
      if (c.when !== timeBefore) c.at = null;
      c.state = 'pending';
    } else if (d === 'no') c.state = rem ? 'cancelled' : 'declined';
    C.paint(m); A.save();
  }

  box.addEventListener('click', e => {
    const link = e.target.closest('a[href]');
    if (link) { e.preventDefault(); A.toast('正式版会用系统浏览器打开：' + link.getAttribute('href'), 3000); return; }
    const t = e.target.closest('[data-a]'); if (!t) return;
    const a = t.dataset.a, mEl = t.closest('.msg'), m = mEl && find(mEl.dataset.id);
    if (a === 'copy' && m) { A.copy(m.text || ''); A.toast('已复制'); }
    else if (a === 'code-copy') {
      A.copy(t.closest('.code').querySelector('pre').textContent);
      t.textContent = '已复制'; setTimeout(() => { t.textContent = '复制'; }, 1300);
    }
    else if (a === 'edit' && m) C.edit(m.id);
    else if (a === 'regen' && m) C.regenerate(m.id);
    else if (a === 'retry' && m) C.regenerate(m.id);
    else if (a === 'img' && m) A.lightbox(m.images[+t.dataset.i].src);
    else if (a === 'chip' || a === 'example') C.send(t.dataset.send, []);
    else if (a === 'card' && m) cardAction(m, t.dataset.do, mEl);
    else if (a === 'cfg') A.openSettings && A.openSettings('ai');
    else if (a === 'pro' && m) {
      const act = m.actions && m.actions[+t.dataset.i]; if (!act) return;
      m.done = act.label; C.paint(m);
      if (act.fn) act.fn();
    }
  });

  // ---------- 历史对话 ----------
  C.closeHistory = () => hist.classList.remove('open');
  C.toggleHistory = force => {
    const on = force != null ? force : !hist.classList.contains('open');
    hist.classList.toggle('open', on);
    if (on) { hs.value = ''; renderHistory(); setTimeout(() => hs.focus({ preventScroll: true }), 230); }
  };
  function renderHistory() {
    const q = hs.value.trim().toLowerCase();
    const list = C.convs.filter(c => c.messages.length && (!q || c.title.toLowerCase().includes(q) || c.messages.some(m => (m.text || '').toLowerCase().includes(q))));
    hl.innerHTML = '';
    if (!list.length) { hl.append(h('div', { class: 'h-empty' }, q ? '没有找到相关对话' : '还没有历史对话')); return; }
    const today = new Date().setHours(0, 0, 0, 0), groups = { 今天: [], 昨天: [], 更早: [] };
    list.sort((a, b) => b.t - a.t).forEach(c => {
      const d = Math.round((today - new Date(c.t).setHours(0, 0, 0, 0)) / DAY);
      groups[d <= 0 ? '今天' : d === 1 ? '昨天' : '更早'].push(c);
    });
    Object.keys(groups).forEach(g => {
      if (!groups[g].length) return;
      hl.append(h('div', { class: 'h-group' }, g));
      groups[g].forEach(c => hl.append(h('div', { class: 'h-item' + (c === C.cur ? ' current' : ''), role: 'button', tabindex: '0', 'data-id': c.id }, [
        h('span', {}, c.title),
        h('button', { title: '重命名', 'aria-label': '重命名', 'data-h': 'rename', html: ico('pencil', 13) }),
        h('button', { title: '删除', 'aria-label': '删除', 'data-h': 'del', html: ico('trash', 13) }),
      ])));
    });
  }
  hs.addEventListener('input', renderHistory);
  hl.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.classList.contains('h-item')) C.switchTo(e.target.dataset.id); });
  hl.addEventListener('click', e => {
    const it = e.target.closest('.h-item'); if (!it || e.target.closest('input')) return;
    const c = C.convs.find(x => x.id === it.dataset.id), act = e.target.closest('[data-h]');
    if (!act) { C.switchTo(c.id); return; }
    if (act.dataset.h === 'del') { C.deleteConv(c.id); return; }
    const span = $('span', it), inp = h('input', { class: 'h-rename', value: c.title, maxlength: '40' });
    let finished = false;
    const done = ok => { if (finished) return; finished = true; if (ok && inp.value.trim()) { c.title = inp.value.trim(); A.save(); } renderHistory(); };
    span.replaceWith(inp); inp.focus(); inp.select();
    inp.addEventListener('keydown', ev => { if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') { ev.stopPropagation(); done(false); } });
    inp.addEventListener('blur', () => done(true));
  });

  A.on('set:model', () => { if (C.cur) C.render(); });
  A.init(() => {
    const saved = A.stored.convs;
    C.convs = Array.isArray(saved) ? saved : seed();
    C.cur = null; C.prune(); C.newConv(false);
  });
})();
