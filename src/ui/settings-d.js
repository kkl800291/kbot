/* KBOT · 设置页（四）：感知（空闲、前台应用、会议勿扰、截图、天气）与对话（快捷键、记录保留） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;

  // ---------- 感知 ----------
  function cityCtl() {
    const wrap = h('div', { style: 'width:100%' });
    const input = h('input', { class: 'sx-in', type: 'text', placeholder: '输入城市名', style: 'width:160px', 'aria-label': '城市名' });
    const res = h('div', { class: 'sx-chips', style: 'margin-top:8px' });
    const msg = h('div', { class: 'sx-err' });
    const search = async () => {
      const name = input.value.trim(); if (!name) return;
      res.replaceChildren(); msg.textContent = '正在查找…';
      try {
        const data = await A.nativeCommand('city_search', { name });
        msg.textContent = data.results?.length ? '' : '没有找到城市，换个写法试试';
        for (const c of data.results || []) res.append(X.btn([c.name, c.admin1, c.country].filter(Boolean).join(' · '), () => {
          A.sput('city', c.name); A.sput('cityInfo', [c.name, c.admin1, c.country].filter(Boolean).join(' · '));
          A.sput('cityCoords', { latitude: c.latitude, longitude: c.longitude });
          A.emit('sense:city'); A.toast('城市已更新'); res.replaceChildren();
        }));
      } catch (e) { msg.textContent = String(e); }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    wrap.append(h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, [input, X.btn('查找', search)]), res, msg);
    return wrap;
  }

  const CATS = [['dev', '开发'], ['office', '办公'], ['meeting', '会议'], ['video', '视频'], ['game', '游戏'], ['chat', '聊天'], ['browser', '浏览器']];
  function appRow([key, name], redraw) {
    const apps = A.S.apps, chips = h('div', { class: 'sx-chips' });
    const add = h('input', { class: 'sx-chip-add', type: 'text', placeholder: '＋ 添加应用', maxlength: '24', 'aria-label': `向「${name}」添加应用` });
    (apps[key] || []).forEach(a => chips.append(h('span', { class: 'sx-chip' }, [a, h('button', {
      type: 'button', title: '移除', 'aria-label': `移除${a}`, html: A.icon('x', 10),
      onclick: () => { apps[key] = apps[key].filter(x => x !== a); A.save(); redraw(); },
    })])));
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const v = add.value.trim(); if (!v) return;
      const from = CATS.find(([k]) => (apps[k] || []).some(x => x.toLowerCase() === v.toLowerCase()));
      if (from && from[0] === key) { A.toast(`「${v}」已经在「${name}」里了`); add.value = ''; return; }
      if (from) apps[from[0]] = apps[from[0]].filter(x => x.toLowerCase() !== v.toLowerCase());
      apps[key] = apps[key] || [];
      apps[key].push(v); A.save();
      A.toast(from ? `已把「${v}」从「${from[1]}」移到「${name}」` : `已把「${v}」归入「${name}」`);
      redraw();
    });
    chips.append(add);
    return h('div', { class: 'sx-row', style: 'align-items:flex-start' }, [
      h('div', { class: 'sx-l', style: 'flex:none;width:56px;padding-top:3px' }, h('div', { class: 'sx-t' }, name)),
      h('div', { class: 'sx-l' }, chips),
    ]);
  }

  pages.sense = el => {
    const appsCard = h('div', { class: 'sx-card' });
    const drawApps = () => { appsCard.replaceChildren(...CATS.map(c => appRow(c, drawApps))); };
    drawApps();
    const city = X.row('所在城市', null, null);
    const cityInfo = h('div', { class: 'sx-d' }, A.S.cityInfo);
    $$('.sx-l', city)[0].append(cityInfo);
    city.append(h('div', { class: 'sx-c', style: 'flex:0 1 330px' }, cityCtl()));
    A.on('sense:city', () => { cityInfo.textContent = A.S.cityInfo; });

    el.append(
      X.group('桌面感知',
        X.row('离开检测', '5 分钟没有操作时休息，回来后自动醒来', X.toggle('senseIdle')),
        X.row('前台应用', '识别应用类别，开会时自动勿扰', X.toggle('senseApp')),
        X.row('发送具体应用名', '关闭时只发送“开发”“会议”这类类别', X.toggle('send.appName')),
        X.row('截图提问', '需要屏幕录制权限', X.btn('检查权限', async () => {
          try {
            const allowed = await A.nativeCommand('screen_permission', { request: true });
            A.set('screenPerm', allowed);
            A.toast(allowed ? '已允许框选截图提问' : '请在系统设置 → 隐私与安全性 → 屏幕录制中允许 KBOT，之后重启应用');
          } catch (e) { A.toast(String(e)); }
        })),
        X.row('天气', '不需要定位权限', X.toggle('senseWeather')),
        city,
      ),
      X.note('天气来自 Open-Meteo，每小时最多刷新一次。'),
      X.group('应用类别', appsCard),
      X.note('“会议”里的应用在前台时，KBOT 会自动勿扰，结束后恢复。'),
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
        A.toast(`召唤快捷键已改为 ${k.label}`);
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
    const count = () => {
      const n = (A.chat?.convs || []).filter(c => c.messages?.length).length;
      stat.textContent = `本机保存了 ${n} 个对话`;
    };
    count();
    const keepRow = X.row('保留期限', null, X.select('retention', KEEP, v => { if (v) A.chat.prune(); count(); }, 100));
    $$('.sx-l', keepRow)[0].append(stat);
    el.append(
      X.group('召唤与收起',
        X.row('召唤快捷键', '按一下召唤 KBOT，再按一下收起。点击按键框后按下新的组合键即可更换', hotkeyCtl()),
        X.row('点击外部时收起', null, X.toggle('outsideClose')),
      ),
      X.group('对话记录', keepRow,
        X.row('清空对话记录', '不影响 ~/KBOT 里的长期记忆', X.danger('清空…', '再点一次确认', () => { A.chat.clearAll(); count(); A.toast('对话记录已清空'); })),
      ),
    );
  };
})();

export {};
