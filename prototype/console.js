/* 赛博伙伴 · 演示控制台（仅原型使用，不属于产品界面）：预览表情、触发提醒、切换外观与模型配置 */
(function () {
  'use strict';
  const A = window.App, { $, h } = A, robot = A.robot;
  const con = $('#console');
  const ORDER = ['idle', 'talk', 'think', 'remind', 'happy', 'surprised', 'coy', 'wink', 'confused', 'sad', 'annoyed', 'sleepy', 'sleep', 'dnd', 'lifted', 'hover'];
  const FIRE = [['休息提醒', 'rest'], ['喝水', 'water'], ['点外卖', 'lunch'], ['下班', 'offwork'], ['深夜', 'night'], ['早安播报', 'morning'],
    ['节气', 'term'], ['生日', 'birthday'], ['自言自语', 'idle'], ['用户回来', 'back'], ['被冷落', 'lonely'], ['远眺护眼', 'eye']];

  const sec = (title, ...kids) => h('section', {}, [h('h4', {}, title), ...kids]);
  const btn = (label, attrs) => h('button', attrs, label);
  const sw = (label, key) => h('label', { class: 'sw' }, [h('input', { type: 'checkbox', 'data-sw': key }), h('i'), label]);
  const seg = (key, opts) => h('div', { class: 'seg', 'data-seg': key }, opts.map(([v, l]) => btn(l, { 'data-v': v })));

  con.append(
    h('div', { class: 'c-head' }, [
      h('b', {}, '演示控制台'), h('span', {}, '不属于产品界面'),
      h('button', { class: 'c-fold', title: '折叠 / 展开', 'aria-label': '折叠或展开', html: A.icon('chevron', 15) }),
    ]),
    h('div', { class: 'c-scroll' }, [
      sec('角色表情（点击预览）', h('div', { class: 'grid' }, ORDER.map(k => btn(Robot.STATES[k].label, { 'data-state': k })))),
      sec('触发提醒与发言',
        h('div', { class: 'grid' }, FIRE.map(([l, k]) => btn(l, { 'data-fire': k }))),
        h('div', { class: 'grid two' }, [btn('我设的提醒到点', { 'data-act': 'due' }), btn('休息中继续操作', { 'data-act': 'resttouch' })])),
      sec('情境', sw('正在开会（自动勿扰）', 'meeting'), sw('离开电脑（角色睡觉）', 'away')),
      sec('外观',
        seg('theme', [['dark', '深色界面'], ['light', '浅色界面']]),
        seg('shell', [['light', '亮色外壳'], ['graphite', '石墨外壳']]),
        seg('size', [['96', '小'], ['120', '中'], ['150', '大']]),
        h('div', { class: 'row', style: 'cursor:default' }, '发光颜色'),
        h('div', { class: 'swatches', style: 'margin-top:6px' }, Object.keys(Robot.PALETTES).map(k => h('button', { 'data-pal': k, title: k, style: `--c:${Robot.PALETTES[k].join(',')}` }))),
        sw('减少动态效果', 'reduced'), sw('提示音', 'sound')),
      sec('对话与 AI',
        h('label', { class: 'sel' }, ['模型配置', h('select', { 'data-sel': 'model' }, [
          ['none', '未配置 API Key'], ['text', '仅文本模型'], ['fallback', '文本 + 看图模型'], ['vision', '多模态模型'],
        ].map(([v, l]) => h('option', { value: v }, l)))]),
        sw('已配置联网搜索', 'web'), sw('已授权屏幕录制（截图入口）', 'screen'),
        h('div', { class: 'grid two' }, [btn('下一条回复中途断网', { 'data-act': 'offline' }), btn('上下文过长提示', { 'data-act': 'ctx' })])),
      sec('倒计时速度（演示用）', seg('speed', [['1', '×1'], ['30', '×30'], ['120', '×120']])),
      sec('试试这些', h('div', { class: 'tips' }, h('ul', {}, [
        '点角色打开对话，再点 / Esc / 点外面收起', '拖动角色，面板和气泡会跟着走', '快速连点角色 3 次以上', '右键角色，或点菜单栏里的机器人图标',
        '输入「20 分钟后提醒我给老王回电话」', '输入「查一下今年冬至是哪天」', '输入「写个防抖函数」，或粘贴 / 拖入一张图片',
        '在右边小窗里打字，再触发提醒，看输入会不会被打断',
      ].map(t => h('li', {}, t))))),
      h('div', { class: 'grid two', style: 'margin-top:12px' }, [btn('重置原型数据', { 'data-act': 'reset' })]),
    ]),
  );

  const acts = {
    due: () => A.brain.fireDemoReminder(),
    resttouch: () => A.brain.restTouch(),
    offline: () => { A.sim.offline = true; A.toast('已设置：下一条回复会在中途断开，可以点「重试」', 3200); },
    ctx: () => {
      if (!A.panel.isOpen()) { A.toast('先点角色打开对话面板'); return; }
      const n = { id: A.uid(), role: 'notice', text: '对话较长，最早的几条消息已不在上下文中' };
      A.chat.cur.messages.push(n); A.chat.append(n);
    },
    reset: () => { if (A.resetData) A.resetData(); },
  };
  const segs = {
    theme: v => { A.set('theme', v); A.applyLook(); },
    shell: v => { A.set('shell', v); A.applyLook(); },
    size: v => { A.set('size', +v); A.applyLook(); },
    speed: v => A.set('speed', +v),
  };
  const sws = {
    reduced: v => { A.set('reduced', v); A.applyLook(); },
    sound: v => { A.set('sound', v); if (v) A.blip(); },
    meeting: v => A.setMeeting(v),
    away: v => A.setAway(v),
    web: v => A.applyWebPreset(v),
    screen: v => A.set('screenPerm', v),
  };

  function sync() {
    A.$$('[data-state]', con).forEach(b => b.classList.toggle('active', b.dataset.state === robot.base));
    A.$$('[data-seg]', con).forEach(s => {
      const v = String(A.S[s.dataset.seg]);
      A.$$('button', s).forEach(b => b.classList.toggle('active', b.dataset.v === v));
    });
    A.$$('[data-pal]', con).forEach(b => b.classList.toggle('active', b.dataset.pal === A.S.palette));
    const on = { reduced: A.S.reduced, sound: A.S.sound, meeting: A.meeting, away: A.away, web: A.S.webAvailable, screen: A.S.screenPerm };
    A.$$('[data-sw]', con).forEach(i => { i.checked = !!on[i.dataset.sw]; });
    $('[data-sel="model"]', con).value = A.S.model;
  }

  con.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('c-fold')) { con.classList.toggle('folded'); return; }
    if (b.dataset.state) { A.setBase(b.dataset.state); return; }
    if (b.dataset.fire) { A.brain.fire(b.dataset.fire); return; }
    if (b.dataset.act) { acts[b.dataset.act](); return; }
    if (b.dataset.pal) { A.set('palette', b.dataset.pal); A.applyLook(); sync(); return; }
    const s = b.closest('[data-seg]');
    if (s) { segs[s.dataset.seg](b.dataset.v); sync(); }
  });
  $('.c-head', con).addEventListener('click', e => { if (con.classList.contains('folded') && !e.target.closest('.c-fold')) con.classList.remove('folded'); });
  con.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.sw) sws[t.dataset.sw](t.checked);
    else if (t.dataset.sel === 'model') A.applyModelPreset(t.value);
    sync();
  });
  A.on('base', sync); A.on('away', sync); A.on('dnd', sync); A.on('set:model', sync); A.on('set:webAvailable', sync);
  A.init(sync);
})();
