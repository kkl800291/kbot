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
    const heads = [];
    const st = A.dshState;
    if (st && st.connected) {
      const mode = st.activeMode === 'external' ? '外部实例' : '内置托管';
      const mLabel = st.modelLabel || st.model;
      heads.push({ head: `DSH 已连接 · ${mode}${mLabel ? ' · ' + mLabel : ''}` });
    } else if (st && st.status === 'connecting') {
      heads.push({ head: '正在连接 DeepSeek Harness…' });
    } else {
      heads.push({ head: 'DeepSeek Harness 未连接' });
    }
    if (A.isDnd()) heads.push({ head: A.dndLabel() });
    return heads;
  }

  const openChat = () => { if (A.hidden) A.setHidden(false); A.panel.open(); };

  const updateMenuItem = () => {
    const u = A.updateState;
    if (u && u.hasUpdate && u.latestVersion) {
      return {
        label: `更新至 v${u.latestVersion}…`,
        fn: () => (u.downloadUrl ? A.updater?.install?.() : A.openSettings?.('general')),
      };
    }
    return {
      label: '检查版本更新…',
      fn: () => A.updater?.check?.(true),
    };
  };

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
      { label: '打开 DSH 模型控制台…', fn: () => A.agent && A.agent.openConsole() },
      { label: '打开养成目录', fn: () => A.agent && A.agent.openWorkspace() },
      { label: '智能核心设置…', fn: () => A.openSettings && A.openSettings('agent') },
      updateMenuItem(),
      { label: '设置…', kbd: '⌘ ,', fn: () => A.openSettings && A.openSettings() },
      { sep: true },
      { label: '退出 KBOT', kbd: '⌘ Q', fn: () => A.quit() },
    ], r.right, r.bottom + 4, { right: true, onClose: () => tray.classList.remove('active') });
  };
  tray.addEventListener('click', () => (A.menu.isOpen() ? A.menu.close() : A.openTrayMenu()));

  A.openContextMenu = (x, y) => {
    A.menu.open([
      ...statusHeads(),
      { sep: true },
      { label: A.panel.isOpen() ? '收起对话' : '打开对话', kbd: A.S.hotkey.label, fn: () => A.panel.toggle() },
      { label: '新对话', fn: () => { A.panel.open(); A.chat.newConv(true); } },
      { sep: true },
      ...dndItems(),
      { sep: true },
      { label: '打开 DSH 模型控制台…', fn: () => A.agent && A.agent.openConsole() },
      { label: '打开养成目录', fn: () => A.agent && A.agent.openWorkspace() },
      { label: '智能核心设置…', fn: () => A.openSettings && A.openSettings('agent') },
      updateMenuItem(),
      { label: '设置…', kbd: '⌘ ,', fn: () => A.openSettings && A.openSettings() },
      { label: '隐藏角色', fn: () => A.setHidden(true) },
    ], x, y);
  };
})();

export {};
