/* 赛博伙伴 · 启动：模拟桌面内容、Esc 逐层关闭、启动各模块 */
(function () {
  'use strict';
  const A = window.App;

  // 右侧的“其他应用”窗口：一段看起来像代码的色块，用来展示角色悬浮在其他应用之上
  function fakeCode() {
    const el = A.$('#fwCode'), cols = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7', '#7dcfff', '#f7768e'];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 1; i <= 26; i++) {
      const line = A.h('div', { class: 'fw-line' }, [A.h('em', {}, String(i)), A.h('div', { style: `width:${[0, 0, 1, 1, 2, 2, 3][Math.floor(rnd() * 7)] * 18}px;flex:none` })]);
      for (let k = 0, n = 1 + Math.floor(rnd() * 3); k < n; k++) {
        line.append(A.h('span', { style: `width:${30 + Math.floor(rnd() * 120)}px;background:${cols[Math.floor(rnd() * cols.length)]}` }));
      }
      el.append(line);
    }
  }

  // Esc 从最上层开始逐层关闭
  addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const lb = A.$('#lightbox');
    if (lb.classList.contains('open')) { lb.classList.remove('open'); return; }
    if (A.menu.isOpen()) { A.menu.close(); return; }
    if (A.closeSettings && A.closeSettings()) return;
    if (A.$('#history').classList.contains('open')) { A.chat.closeHistory(); return; }
    if (A.panel.isOpen()) { A.panel.close(); return; }
    const b = A.bubble.current();
    if (b && b.kind === 'speech') A.bubble.hide(false);
  });

  // 原型模拟的是整块 Mac 桌面，窗口太小时控制台、设置窗口和角色会挤在一起
  let sizeWarned = false;
  const checkSize = () => {
    if (sizeWarned || (innerWidth >= 960 && innerHeight >= 620)) return;
    sizeWarned = true;
    A.toast('窗口太小了，界面会挤在一起。请把浏览器窗口放大到 1000×700 以上再看', 6000);
  };
  addEventListener('resize', checkSize);

  A.init(() => { fakeCode(); A.clock(); setInterval(A.clock, 15000); });
  Icons.mount();
  A.start();
  Icons.mount();
  setTimeout(checkSize, 800);
})();
