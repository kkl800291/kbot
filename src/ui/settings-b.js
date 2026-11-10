import { HABIT_LABELS, emptyDrift, emptyHabits, settingsView } from '../services/habits';

/* KBOT · 设置页（二）：提醒、记忆、对话 */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages, B = A.brain;
  const WEEK = '日一二三四五六';
  const dayLabel = d => ['今天', '明天', '后天'][Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5)] || `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  const fmtAt = at => { const d = new Date(at); return `${dayLabel(d)} ${A.hm(at)}`; };
  const btn = (icon, title, fn) => h('button', { class: 'ib', type: 'button', title, 'aria-label': title, html: A.icon(icon, 15), onclick: fn });

  // ---------- 提醒 ----------
  const REPEATS = [['once', '仅一次'], ['daily', '每天'], ['workday', '每个工作日'], ['weekly', '每周'], ['monthly', '每月']];

  function remindForm(rem, done) {
    const m = rem && /(\d{1,2}):(\d{2})/.exec(rem.when);
    const wk = rem && /^每周([日一二三四五六])$/.exec(rem.repeat), dm = rem && /^每月(\d+)号$/.exec(rem.repeat);
    const kind = !rem || rem.repeat === '仅一次' ? 'once' : rem.repeat === '每天' ? 'daily' : rem.repeat === '每个工作日' ? 'workday' : wk ? 'weekly' : dm ? 'monthly' : 'once';
    const content = h('input', { class: 'sx-in', type: 'text', maxlength: '40', placeholder: '例如：给老王回电话', style: 'width:100%' });
    content.value = rem ? rem.content : '';
    const rep = h('select', { class: 'sx-in' }, REPEATS.map(([v, l]) => h('option', { value: v }, l)));
    rep.value = kind;
    const days = h('select', { class: 'sx-in' }, Array.from({ length: 30 }, (_, i) => { const d = new Date(Date.now() + i * 864e5); return h('option', { value: String(d.setHours(0, 0, 0, 0)) }, `${dayLabel(d)}（${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]}）`); }));
    const wsel = h('select', { class: 'sx-in' }, [1, 2, 3, 4, 5, 6, 0].map(i => h('option', { value: WEEK[i] }, '周' + WEEK[i])));
    const msel = h('select', { class: 'sx-in' }, Array.from({ length: 31 }, (_, i) => h('option', { value: String(i + 1) }, `${i + 1} 号`)));
    wsel.value = wk ? wk[1] : WEEK[new Date().getDay()]; msel.value = dm ? dm[1] : String(new Date().getDate());
    if (rem && kind === 'once' && rem.at) { const base = new Date(rem.at).setHours(0, 0, 0, 0); if ([...days.options].some(o => o.value === String(base))) days.value = String(base); }
    let hhmm = m ? `${A.pad(+m[1])}:${A.pad(+m[2])}` : (() => { const d = new Date(Date.now() + 3600e3); return `${A.pad(d.getHours())}:00`; })();
    const time = X.timeOf(hhmm, v => { hhmm = v; });
    const err = h('span', { class: 'sx-err' });
    const hint = h('div', { class: 'sx-note', style: 'grid-column:1/-1;margin:-4px 0 0' });
    const when = h('div', { class: 'inl' });
    const sync = () => {
      const k = rep.value;
      when.replaceChildren(...[k === 'once' ? days : k === 'weekly' ? wsel : k === 'monthly' ? msel : null, time].filter(Boolean));
      hint.textContent = k === 'monthly' ? '31 号这类日期，在没有这一天的月份里会改在当月最后一天提醒。' : k === 'workday' ? '按「作息」里设置的工作日，并跟随法定节假日与调休。' : '';
      hint.hidden = !hint.textContent;
    };
    rep.addEventListener('change', () => { err.textContent = ''; sync(); });
    sync();
    const save = () => {
      const text = content.value.trim(), k = rep.value;
      if (!text) { err.textContent = '请填写要提醒的内容'; content.focus(); return; }
      let r;
      if (k === 'once') {
        const d = new Date(+days.value); const [hh, mm] = hhmm.split(':').map(Number); d.setHours(hh, mm, 0, 0);
        if (d.getTime() <= Date.now()) { err.textContent = '这个时间已经过了，请选一个之后的时间'; return; }
        r = { repeat: '仅一次', when: `${d.getFullYear()}-${A.pad(d.getMonth()+1)}-${A.pad(d.getDate())} ${hhmm}`, at: d.getTime(), content: text };
      } else {
        const rp = k === 'daily' ? '每天' : k === 'workday' ? '每个工作日' : k === 'weekly' ? `每周${wsel.value}` : `每月${msel.value}号`;
        r = { repeat: rp, when: `${k === 'workday' ? '工作日' : rp} ${hhmm}`, content: text, at: null };
      }
      try { if (rem) { B.updateReminder(rem.id, r); A.toast('提醒已更新'); } else { B.addReminder(r); A.toast('提醒已添加'); } } catch(e) { err.textContent = e.message; return; }
      done();
    };
    content.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    const form = h('div', { class: 'sx-form' }, [
      h('label', {}, '内容'), content,
      h('label', {}, '重复'), rep,
      h('label', {}, '时间'), when, hint,
      h('div', { class: 'full' }, [err, X.btn('取消', done, 'ghost'), X.btn(rem ? '保存' : '添加', save, 'primary')]),
    ]);
    setTimeout(() => content.focus(), 0);
    return form;
  }

  pages.remind = el => {
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren();
      const items = A.reminders.slice().sort((a, b) => (a.fired - b.fired) || ((a.at || 9e15) - (b.at || 9e15)));
      if (!items.length) list.append(X.empty('还没有自定义提醒。点下面的按钮添加，也可以直接在聊天里说：「20 分钟后提醒我给老王回电话」。'));
      items.forEach(r => {
        const rp = r.repeat && r.repeat !== '仅一次';
        const sub = r.fired ? `${r.when} · 已提醒` : rp ? `${r.when}${r.at ? ` · 下次 ${fmtAt(r.at)}` : ''}` : `${r.when}${r.at ? '' : ' · 未排期'}`;
        const row = h('div', { class: 'sx-item' + (r.fired ? ' fin' : '') }, [
          h('span', { class: 'ic', html: A.icon('bell', 16) }),
          h('div', { class: 'tx' }, [h('div', { class: 'tt' }, r.content), h('div', { class: 'ss' }, sub)]),
          h('div', { class: 'ops' }, [
            btn('pencil', '修改', () => { row.replaceWith(remindForm(r, draw)); }),
            btn('trash', '删除', () => { B.removeReminder(r.id); A.toast('提醒已删除'); }),
          ]),
        ]);
        list.append(row);
      });
      const add = h('div', { class: 'sx-add' });
      add.append(X.btn('＋ 添加提醒', () => { add.replaceWith(remindForm(null, draw)); }));
      list.append(add);
    };
    draw();
    el.append(
      X.group('我设的提醒', list),
      X.note('支持一次性、每天、每个工作日、每周几、每月几号。聊天里说的提醒，确认保存后也会出现在这里。'),
      X.group('到点之后', X.row('怎么提醒你', '你设的提醒优先级最高：勿扰时也会出现，但是以静默气泡，不响提示音', null)),
    );
  };

  // ---------- 记忆 ----------
  pages.memory = el => {
    const list = h('div', {});
    const draw = () => {
      list.replaceChildren();
      if (!A.memories.length) list.append(X.empty('我还没有记住什么。聊天里你告诉我的偏好、称呼、生日，我会先问你「要记住吗」，你同意了才会保存。'));
      A.memories.forEach(mm => {
        const tt = h('div', { class: 'tt' }, mm.text);
        let editing = false;
        const stop = ok => {
          if (!editing) return; editing = false;
          tt.contentEditable = 'false'; tt.removeEventListener('keydown', onKey); tt.removeEventListener('blur', onBlur);
          const v = tt.textContent.trim();
          if (ok && v && v !== mm.text) { B.updateMemory(mm.id, v); A.toast('记忆已更新'); } else tt.textContent = mm.text;
        };
        const onKey = e => { if (e.key === 'Enter') { e.preventDefault(); stop(true); } else if (e.key === 'Escape') { e.stopPropagation(); stop(false); } };
        const onBlur = () => stop(true);
        const edit = () => {
          if (editing) return; editing = true;
          tt.contentEditable = 'true'; tt.addEventListener('keydown', onKey); tt.addEventListener('blur', onBlur); tt.focus();
          getSelection().selectAllChildren(tt);
        };
        list.append(h('div', { class: 'sx-item' }, [
          h('span', { class: 'ic', html: A.icon('bookmark', 16) }),
          h('div', { class: 'tx' }, [tt, h('div', { class: 'ss' }, `${dayLabel(new Date(mm.t))} 记下的`)]),
          h('div', { class: 'ops' }, [btn('pencil', '修改', edit), btn('trash', '删除', () => { B.removeMemory(mm.id); A.toast('已忘掉这条'); })]),
        ]));
      });
      const input = h('input', { class: 'sx-in', type: 'text', maxlength: '60', placeholder: '手动添加一条，例如：不喝冰咖啡', style: 'flex:1' });
      const add = () => { const v = input.value.trim(); if (!v) return; B.addMemory(v); A.toast('记住啦'); };
      input.addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
      list.append(h('div', { class: 'sx-add', style: 'display:flex;gap:8px' }, [input, X.btn('添加', add)]));
    };
    draw();
    const habitView = Array.isArray(A.habits)
      ? { habits: A.habits, habitProgress: A.habitProgress || [] }
      : settingsView(A.habits || emptyHabits(), A.drift || emptyDrift(), A.journal || [], A.S.params.nightAt, Date.now());
    const formed = habitView.habits || [];
    const formedIds = new Set(formed.map(item => item.id));
    const habits = h('div', {});
    if (!formed.length) habits.append(X.empty('还在观察相处节奏。今天的记录要到明天才会算进去。'));
    formed.forEach(item => {
      const date = item.updatedAt ? new Date(item.updatedAt) : null;
      const when = date ? `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日` : '';
      habits.append(h('div', { class: 'sx-item' }, [
        h('span', { class: 'ic', html: A.icon('bookmark', 16) }),
        h('div', { class: 'tx' }, [h('div', { class: 'tt' }, item.text), h('div', { class: 'ss' }, `样本 ${item.samples} 次${when ? ' · ' + when : ''}`)]),
        h('div', { class: 'ops' }, [btn('trash', '删除', () => { B.removeHabit(item.id); A.toast('这条习惯已删除，之后要重新攒够'); })]),
      ]));
    });
    (habitView.habitProgress || []).filter(item => !formedIds.has(item.id)).forEach(item => {
      const left = Math.max(0, item.need - item.samples - item.pending);
      const text = left ? `还差 ${left} 次（已累计 ${item.samples} 次，今天还有 ${item.pending} 次明天才算）` : '次数够了，还要再观察才会定下来';
      habits.append(h('div', { class: 'sx-item' }, [
        h('span', { class: 'ic', html: A.icon('clock', 16) }),
        h('div', { class: 'tx' }, [h('div', { class: 'tt' }, HABIT_LABELS[item.id] || item.id), h('div', { class: 'ss' }, text)]),
      ]));
    });
    el.append(
      X.group('我记得的', list),
      X.note('记忆只保存在这台电脑上。聊天时，我只会把和当前话题相关的几条发给模型；不想发的话，可以在「AI → 发送内容范围」里关掉。'),
      X.group('相处里养成的习惯', habits),
      X.note('这些习惯由相处记录按天养成，不会改提醒时间和休息规则。今天的记录要到明天才会算进去。清空记忆不会删掉它们。'),
      X.group('管理', X.row('清空全部记忆', '只清空你确认过的偏好，不删除相处习惯', X.danger('清空…', '再点一次确认清空', () => { B.clearMemories(); A.toast('记忆已全部清空'); }))),
    );
  };

  // ---------- 对话 ----------
  const KEYS = { Space: 'Space', Enter: '↩', Tab: '⇥', Backspace: '⌫', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
  const CONFLICTS = [
    [{ meta: true, alt: false, ctrl: false, shift: false, code: 'Space' }, 'Spotlight 搜索'],
    [{ meta: true, alt: true, ctrl: false, shift: false, code: 'Space' }, 'Finder 搜索'],
    [{ meta: false, alt: false, ctrl: true, shift: false, code: 'Space' }, '切换输入法'],
    [{ meta: true, alt: false, ctrl: false, shift: false, code: 'Tab' }, '应用切换'],
  ];
  const keyName = e => KEYS[e.code] || (/^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F\d{1,2}$/.test(e.code) ? e.code : null);
  const labelOf = k => `${k.ctrl ? '⌃ ' : ''}${k.alt ? '⌥ ' : ''}${k.shift ? '⇧ ' : ''}${k.meta ? '⌘ ' : ''}${KEYS[k.code] || k.code.replace(/^Key|^Digit/, '')}`;

  function hotkeyCtl() {
    const box = h('span', { class: 'sx-time' });
    const msg = h('span', { class: 'sx-err' });
    const chip = h('button', { class: 'sx-kbd', type: 'button', title: '点击后按下新的组合键' }, A.S.hotkey.label);
    let rec = null;
    const stop = () => { if (!rec) return; removeEventListener('keydown', rec, true); rec = null; chip.classList.remove('rec'); chip.textContent = A.S.hotkey.label; };
    chip.addEventListener('click', () => {
      if (rec) { stop(); return; }
      msg.textContent = ''; chip.classList.add('rec'); chip.textContent = '请按下新的组合键…';
      rec = e => {
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        if (e.key === 'Escape') { stop(); return; }
        const code = keyName(e);
        const k = { alt: e.altKey, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, code: code ? e.code : '' };
        if (!code || !(k.alt || k.meta || k.ctrl)) { msg.textContent = '请加上 ⌘ ⌥ ⌃ 之一，避免和打字冲突'; return; }
        const hit = CONFLICTS.find(([c]) => ['alt', 'meta', 'ctrl', 'shift'].every(m => c[m] === k[m]) && c.code === k.code);
        if (hit) { msg.textContent = `与「${hit[1]}」的系统快捷键冲突，换一个吧`; return; }
        k.label = labelOf(k); A.sput('hotkey', k); stop();
        A.toast(`快捷键已改为 ${k.label}`);
      };
      addEventListener('keydown', rec, true);
    });
    const reset = X.btn('恢复默认', () => { stop(); msg.textContent = ''; A.sput('hotkey', A.defaults().hotkey); chip.textContent = A.S.hotkey.label; }, 'ghost');
    box.append(chip, reset);
    const wrap = h('div', {}, [box]);
    wrap.append(msg);
    return wrap;
  }

  const KEEP = [[0, '不清理'], [7, '7 天'], [30, '30 天'], [90, '90 天']];
  pages.chat = el => {
    const stat = h('div', { class: 'sx-d' });
    const count = () => { const n = A.chat.convs.filter(c => c.messages.length).length; stat.textContent = `现在保存了 ${n} 个对话（含图片），只存在这台电脑上`; };
    count();
    const keepRow = X.row('对话记录保留期限', null, X.select('retention', KEEP, v => { if (v) A.chat.prune(); count(); }, 100));
    $$('.sx-l', keepRow)[0].append(stat);
    el.append(
      X.group('唤出与收起',
        X.row('唤出 / 收起对话的快捷键', '在任何应用里都能按；点一下右边的按键框，再按新的组合', hotkeyCtl()),
        X.row('点击面板外面时收起', '关闭后，只能用 Esc、再点角色或收起按钮来收起', X.toggle('outsideClose')),
      ),
      X.group('对话记录', keepRow,
        X.row('清空所有对话记录', '包括图片；无法恢复', X.danger('清空…', '再点一次确认清空', () => { A.chat.clearAll(); count(); A.toast('对话记录已清空'); }))),
      X.note('超过保留期限的对话会在启动时和每天凌晨自动删除。'),
    );
  };
})();

export {};
