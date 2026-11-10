/* 赛博伙伴 · 设置页（三）：感知、AI */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;

  // ---------- 感知 ----------
  // 原型里的“地理编码”：真实版调用 Open-Meteo 的城市搜索接口，这里用几个常见城市演示
  const CITIES = [
    ['上海', '上海市', '中国', 31.23, 121.47], ['北京', '北京市', '中国', 39.90, 116.41], ['广州', '广州市', '中国', 23.13, 113.26],
    ['深圳', '深圳市', '中国', 22.54, 114.06], ['杭州', '杭州市', '中国', 30.27, 120.15], ['成都', '成都市', '中国', 30.57, 104.07],
    ['南京', '南京市', '中国', 32.06, 118.80], ['武汉', '武汉市', '中国', 30.59, 114.31], ['西安', '西安市', '中国', 34.34, 108.94],
    ['重庆', '重庆市', '中国', 29.56, 106.55], ['天津', '天津市', '中国', 39.34, 117.36], ['苏州', '苏州市', '中国', 31.30, 120.59],
    ['南昌', '南昌市', '中国', 28.68, 115.86], ['南宁', '南宁市', '中国', 22.82, 108.32], ['长沙', '长沙市', '中国', 28.23, 112.94],
    ['厦门', '厦门市', '中国', 24.48, 118.09], ['青岛', '青岛市', '中国', 36.07, 120.38], ['香港', '香港', '中国', 22.32, 114.17],
  ];
  const geoText = c => `${c[1]} · ${c[2]} · ${c[3].toFixed(2)}°N ${c[4].toFixed(2)}°E`;

  function cityCtl() {
    const wrap = h('div', { style: 'width:100%' });
    const input = h('input', { class: 'sx-in', type: 'text', placeholder: '城市名，如 杭州', style: 'width:170px', maxlength: '20' });
    const res = h('div', { class: 'sx-chips', style: 'margin-top:8px;justify-content:flex-end' });
    const msg = h('div', { class: 'sx-err', style: 'margin-top:6px;text-align:right' });
    const search = () => {
      const q = input.value.trim(); res.replaceChildren(); msg.textContent = '';
      if (!q) return;
      const hit = CITIES.filter(c => c[0].includes(q) || q.includes(c[0]) || c[1].includes(q));
      if (!hit.length) { msg.textContent = `没找到「${q}」。可以试试换个写法，或只写城市名（支持中文）`; return; }
      hit.slice(0, 5).forEach(c => res.append(h('button', {
        class: 'chip', type: 'button', onclick: () => { A.sput('city', c[0]); A.sput('cityInfo', geoText(c)); A.toast(`城市已设为 ${c[1]}`); A.emit('sense:city'); },
      }, geoText(c))));
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
    const calDesc = h('div', { class: 'sx-d' });
    const calText = () => { calDesc.textContent = { ask: '还没有授权：打开后 macOS 会弹出日历授权窗口。只读，会议开始前 5 分钟提醒，会议中自动勿扰。', on: '已开启（只读）。会议开始前 5 分钟提醒，会议中自动勿扰；会议标题默认不发给模型。', off: '已关闭：不读取日历，会议相关的提醒和自动勿扰都不会出现。' }[A.S.senseCal]; };
    calText();
    const cal = X.row('系统日历', null, X.switch(A.S.senseCal === 'on', v => {
      if (v && A.S.senseCal === 'ask') A.toast('正式版这里会弹出 macOS 的日历授权窗口；原型里按「允许」处理', 3600);
      A.sput('senseCal', v ? 'on' : 'off'); calText();
    }));
    $$('.sx-l', cal)[0].append(calDesc);

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
        X.row('离开电脑检测', '读取键盘鼠标的空闲时长，不需要任何权限。关闭后，角色不会因你离开而睡觉，休息计时也不再自动清零', X.toggle('senseIdle')),
        X.row('前台应用类别', '只读取你正在用的应用名称，并归到「开发、会议、视频…」这样的类别，用来判断要不要勿扰、说什么。不读窗口标题，也不读屏幕内容', X.toggle('senseApp')),
        cal,
        X.row('天气', '用你填的城市查询，不使用定位权限。用于早安播报、下雨带伞、高温降温的提醒', X.toggle('senseWeather')),
        city,
      ),
      X.note('天气数据来自 Open-Meteo（CC BY 4.0，免费、无需 Key）。每小时最多请求一次并缓存；获取失败时用最近一次的缓存，超过 6 小时就不再提天气，也不会报错打扰你。'),
      X.group('应用归类', appsCard),
      X.note('一个应用只属于一个类别；在别的类别里添加同名应用，会把它移过来。「会议」类应用在前台时，角色会自动进入勿扰。'),
    );
  };
})();
