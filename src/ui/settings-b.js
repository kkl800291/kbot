/* KBOT · 设置页（二）：智能核心（DeepSeek Harness 双模桥接、~/KBOT 养成目录、角色语气） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;

  const PERSONAS = [
    ['cute', '可爱灵动', '默认', '嗨～今天也一起高效搞定手头的事吧！'],
    ['gentle', '温柔体贴', '', '累了就歇一会儿，我一直在桌角陪着你。'],
    ['lively', '元气明快', '', '能量满格！有什么任务尽管交给我～'],
    ['quiet', '安静克制', '', '在线待命，有事随时叫我。'],
  ];

  const MODES = [
    ['auto', '自动'],
    ['external', '仅连接已打开的实例'],
    ['managed', '始终由 KBOT 托管'],
  ];

  pages.agent = el => {
    const statusSlot = h('div', {});
    const patchSlot = h('div', {});

    const drawStatus = () => {
      statusSlot.replaceChildren();
      patchSlot.replaceChildren();
      const st = A.dshState || {};
      const connected = !!st.connected;
      const connecting = st.status === 'connecting';
      const badgeText = connected
        ? (st.activeMode === 'external' ? '已连接 · 外部实例' : '已连接 · 内置托管')
        : connecting
          ? '正在连接…'
          : '未连接';
      const badgeCls = 'sx-status' + (connected ? ' ok' : connecting ? '' : ' bad');
      const detailParts = [];
      if (st.modelLabel || st.model) {
        const mText = st.modelLabel && st.model && st.modelLabel !== st.model
          ? `${st.modelLabel} (${st.model})`
          : (st.modelLabel || st.model);
        detailParts.push(`当前模型：${mText}`);
      }
      if (st.port) detailParts.push(`桥接端口：127.0.0.1:${st.port}`);
      if (st.pid) detailParts.push(`托管 PID：${st.pid}`);
      if (!connected && st.error) detailParts.push(st.error);
      const detail = detailParts.join(' · ') || '推理、工具、记忆与提醒都由本机 DeepSeek Harness 提供';

      const reconnectBtn = X.btn(connecting ? '连接中…' : '重新连接', async () => {
        reconnectBtn.disabled = true;
        try { await A.agent?.reconnect?.(); }
        finally { reconnectBtn.disabled = false; drawStatus(); }
      }, connected ? 'ghost' : 'primary');
      reconnectBtn.disabled = connecting;

      const restartBtn = X.btn('重启', async () => {
        restartBtn.disabled = true;
        try {
          await A.agent?.restart?.();
          A.toast('已重新启动 DeepSeek Harness 桥接核心');
        } catch (err) {
          A.toast(String(err), 5000);
        } finally {
          restartBtn.disabled = false;
          drawStatus();
        }
      }, 'ghost');

      const patchInstalled = !!(st.desktopPatchInstalled ?? A.S.dsh?.desktopPatch);
      const patchSwitch = X.switch(patchInstalled, async enabled => {
        try {
          await A.agent?.setDesktopPatch?.(enabled);
          A.toast(enabled
            ? '已写入 ~/.dsh/profiles/desktop/cordis.patch.yml，重启 DeepSeek Harness.app 后即可双端共享直连'
            : '已从桌面端配置移除 KBOT 桥接插件');
        } catch (err) {
          A.toast(String(err), 5000);
          drawStatus();
        }
      });

      statusSlot.append(
        X.row('状态', detail, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
          h('span', { class: badgeCls }, badgeText),
          reconnectBtn,
          restartBtn,
        ])),
      );
      patchSlot.append(patchSwitch);
    };
    drawStatus();

    const openConsoleBtn = X.btn('打开控制台', async () => {
      openConsoleBtn.disabled = true;
      try {
        await A.agent?.openConsole?.();
      } finally {
        openConsoleBtn.disabled = false;
      }
    }, 'primary');

    const statusGroup = X.group('DeepSeek Harness',
      statusSlot,
      X.row('模型与扩展', 'API Key、默认模型和 MCP 插件', openConsoleBtn),
      X.row('接入方式', null, X.select('dsh.mode', MODES, () => {
        A.agent?.reconnect?.();
      }, 190)),
      X.row('与 DeepSeek Harness.app 互通', '写入桌面端插件配置，保留你现有的设置', patchSlot),
      X.row('dsh 路径', '留空时自动查找', X.text('dsh.binary', {
        ph: '自动',
        w: 240,
        max: 240,
        allowEmpty: true,
        after: () => A.agent?.reconnect?.(),
      })),
    );

    const wsInput = X.text('dsh.workspace', {
      ph: '~/KBOT',
      w: 210,
      max: 240,
      after: () => {
        A.toast('养成目录已更新，正在重新挂载会话…');
        A.agent?.reconnect?.();
      },
    });
    const openWsBtn = X.btn('在访达中打开', () => A.agent?.openWorkspace?.());
    const initWsBtn = X.btn('补齐模板文件', async () => {
      try {
        await A.agent?.initWorkspace?.(false);
        A.toast('已检查并补齐 AGENTS.md、MEMORY.md 与 diary/ 目录');
      } catch (err) {
        A.toast(String(err), 4500);
      }
    }, 'ghost');

    const cards = h('div', { class: 'sx-persona' }, PERSONAS.map(([k, name, tag, line]) => h('button', { type: 'button', class: 'sx-pcard', 'data-k': k }, [
      h('b', {}, [name, tag ? h('em', {}, tag) : null]), h('span', {}, `「${line}」`),
    ])));
    const syncPersona = () => $$('.sx-pcard', cards).forEach(b => b.classList.toggle('on', b.dataset.k === A.S.persona));
    cards.addEventListener('click', e => {
      const b = e.target.closest('.sx-pcard'); if (!b) return;
      A.sput('persona', b.dataset.k); syncPersona();
      const line = PERSONAS.find(p => p[0] === b.dataset.k)[3];
      if (!A.hidden && !A.panel?.isOpen?.()) A.bubble?.show?.({ kind: 'speech', pri: 'low', text: line, expr: 'wink' });
    });
    syncPersona();

    const nick = X.text('nickname', { ph: '你', w: 140, max: 12 });
    const callsToday = A.S.ai?.calls?.day === new Date().toDateString() ? A.S.ai.calls.n : 0;

    el.append(
      statusGroup,
      X.note('“自动”会优先复用已打开的 DeepSeek Harness，没有打开时由 KBOT 在后台启动。'),
      X.group('养成目录',
        X.row('位置', '人格、长期记忆和日记都以 Markdown 保存在这里', wsInput),
        X.row('管理', null, h('div', { style: 'display:flex;gap:8px' }, [openWsBtn, initWsBtn])),
      ),
      X.note('在对话里说“20 分钟后提醒我喝水”，到点后 KBOT 会用气泡和语音提醒你。'),
      X.group('性格与称呼',
        cards,
        X.row('怎么称呼你', null, nick),
      ),
      X.group('今天',
        X.row('对话回复', null, h('span', { class: 'sx-status' }, `${callsToday} 次`)),
      ),
    );

    el._redraw = drawStatus;
  };
})();

export {};
