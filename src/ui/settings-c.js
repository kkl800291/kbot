/* KBOT · 设置页（三）：感知、AI */
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
      } catch(e) { msg.textContent = String(e); }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') search(); });
    wrap.append(h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' }, [input, X.btn('查找', search)]), res, msg);
    return wrap;
  }

  const CATS = [['dev', '开发'], ['office', '办公'], ['meeting', '会议'], ['video', '视频'], ['game', '游戏'], ['chat', '聊天'], ['browser', '浏览器']];
  function appRow([key, name], redraw) {
    const apps = A.S.apps, chips = h('div', { class: 'sx-chips' });
    const add = h('input', { class: 'sx-chip-add', type: 'text', placeholder: '＋ 添加应用', maxlength: '24', 'aria-label': `向「${name}」添加应用` });
    apps[key].forEach(a => chips.append(h('span', { class: 'sx-chip' }, [a, h('button', {
      type: 'button', title: '移除', 'aria-label': `移除${a}`, html: A.icon('x', 10),
      onclick: () => { apps[key] = apps[key].filter(x => x !== a); A.save(); redraw(); },
    })])));
    add.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const v = add.value.trim(); if (!v) return;
      const from = CATS.find(([k]) => apps[k].some(x => x.toLowerCase() === v.toLowerCase()));
      if (from && from[0] === key) { A.toast(`「${v}」已经在「${name}」里了`); add.value = ''; return; }
      if (from) apps[from[0]] = apps[from[0]].filter(x => x.toLowerCase() !== v.toLowerCase());
      apps[key].push(v); A.save();
      A.toast(from ? `已把「${v}」从「${from[1]}」移到「${name}」` : `已把「${v}」归入「${name}」`);
      redraw();
    });
    chips.append(add);
    return h('div', { class: 'sx-row', style: 'align-items:flex-start' }, [h('div', { class: 'sx-l', style: 'flex:none;width:56px;padding-top:3px' }, h('div', { class: 'sx-t' }, name)), h('div', { class: 'sx-l' }, chips)]);
  }

  pages.sense = el => {
    const cal = X.row('系统日历', '日历会议读取将在后续版本接入；当前可以识别前台会议应用并手动勿扰', h('span', { class: 'sx-status' }, '暂不可用'));
    const appsCard = h('div', { class: 'sx-card' });
    const drawApps = () => { appsCard.replaceChildren(...CATS.map(c => appRow(c, drawApps))); };
    drawApps();
    const city = X.row('城市', null, null);
    const cityInfo = h('div', { class: 'sx-d' }, A.S.cityInfo);
    $$('.sx-l', city)[0].append(cityInfo);
    city.append(h('div', { class: 'sx-c', style: 'flex:0 1 330px' }, cityCtl()));
    A.on('sense:city', () => { cityInfo.textContent = A.S.cityInfo; });

    el.append(
      X.group('感知能力（每一项都可以单独关闭）',
        X.row('离开电脑检测', '连续 5 分钟没有键鼠操作时角色休眠，短暂停顿仍会陪伴。只读取空闲时长；关闭后不再自动休眠或清零休息计时', X.toggle('senseIdle')),
        X.row('前台应用类别', '只读取你正在用的应用名称，并归到「开发、会议、视频…」这样的类别，用来判断要不要勿扰、说什么。不读窗口标题，也不读屏幕内容', X.toggle('senseApp')),
        cal,
        X.row('截图提问', '只在你主动框选时截取；需要 macOS 屏幕录制权限', X.btn('检查／申请权限', async () => { try { const allowed = await A.nativeCommand('screen_permission', { request: true }); A.set('screenPerm', allowed); A.toast(allowed ? '已允许截图提问' : '请在系统设置 → 隐私与安全性 → 屏幕录制中允许，之后重启应用'); } catch(e) { A.toast(String(e)); } })),
        X.row('天气', '用你填的城市查询，不使用定位权限。用于早安播报、下雨带伞、高温降温的提醒', X.toggle('senseWeather')),
        city,
      ),
      X.note('天气数据来自 Open-Meteo（CC BY 4.0，免费、无需 Key）。每小时最多请求一次并缓存；获取失败时用最近一次的缓存，超过 6 小时就不再提天气，也不会报错打扰你。'),
      X.group('应用归类', appsCard),
      X.note('一个应用只属于一个类别；在别的类别里添加同名应用，会把它移过来。「会议」类应用在前台时，角色会自动进入勿扰。'),
    );
  };
})();

export {};
