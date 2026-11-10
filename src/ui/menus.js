/* KBOT · 菜单：菜单栏图标菜单、角色右键菜单 */
(function () {
  'use strict';
  const A = window.App, { $ } = A;
  const tray = $('#tray');

  const dndItems = () => {
    const items = [
      { label: '勿扰 30 分钟', fn: () => A.setDnd(30) },
      { label: '勿扰 1 小时', fn: () => A.setDnd(60) },
      { label: '勿扰到明天', fn: () => A.setDnd('tomorrow') },
    ];
    if (A.dnd.until > Date.now()) items.push({ label: '结束勿扰', fn: () => A.setDnd(0) });
    return items;
  };

  function statusHeads() {
    const w = A.workInfo(), R = A.rest, heads = [];
    if (A.isDnd()) heads.push({ head: A.dndLabel() });
    else if (R.phase === 'resting') heads.push({ head: `休息中 · 剩余 ${A.mmss(R.left)}` });
    else heads.push({ head: `工作中 · 已连续 ${w.minutes} 分钟` });
    if (R.phase !== 'resting') heads.push({ head: w.nextIn ? `下次休息提醒 · ${w.nextIn} 分钟后` : '该休息啦' });
    return heads;
  }

  const openChat = () => { if (A.hidden) A.setHidden(false); A.panel.open(); };

  A.openTrayMenu = () => {
    const r = tray.getBoundingClientRect();
    tray.classList.add('active');
    A.menu.open([
      ...statusHeads(),
      { sep: true },
      { label: A.hidden ? '显示角色' : '隐藏角色', fn: () => A.setHidden(!A.hidden) },
      { label: '打开聊天', kbd: A.S.hotkey.label, fn: openChat },
      { sep: true },
      ...dndItems(),
      { sep: true },
      { label: '提醒列表…', fn: () => A.openSettings && A.openSettings('remind') },
      { label: '设置…', kbd: '⌘ ,', fn: () => A.openSettings && A.openSettings() },
      { sep: true },
      { label: '退出 KBOT', kbd: '⌘ Q', fn: () => A.quit() },
    ], r.right, r.bottom + 4, { right: true, onClose: () => tray.classList.remove('active') });
  };
  tray.addEventListener('click', () => (A.menu.isOpen() ? A.menu.close() : A.openTrayMenu()));

  A.openContextMenu = (x, y) => {
    A.menu.open([
      { label: A.panel.isOpen() ? '收起对话' : '打开对话', kbd: A.S.hotkey.label, fn: () => A.panel.toggle() },
      { label: '新对话', fn: () => { A.panel.open(); A.chat.newConv(true); } },
      { sep: true },
      ...dndItems(),
      { sep: true },
      { label: '提醒列表…', fn: () => A.openSettings && A.openSettings('remind') },
      { label: '设置…', kbd: '⌘ ,', fn: () => A.openSettings && A.openSettings() },
      { label: '隐藏角色', fn: () => A.setHidden(true) },
    ], x, y);
  };
})();

export {};
