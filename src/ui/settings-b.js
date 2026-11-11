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
    ['auto', '双模自动（优先连外部实例，否则自动托管启动）'],
    ['external', '仅连接外部已运行的 DeepSeek Harness'],
    ['managed', '始终由 KBOT 独立后台托管进程'],
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
      const detail = detailParts.join(' · ') || '智能推理、工具调用、长期记忆与定时提醒均由本机 DeepSeek Harness 驱动';

      const reconnectBtn = X.btn(connecting ? '连接中…' : '重新检测连接', async () => {
        reconnectBtn.disabled = true;
        try { await A.agent?.reconnect?.(); }
        finally { reconnectBtn.disabled = false; drawStatus(); }
      }, connected ? 'ghost' : 'primary');
      reconnectBtn.disabled = connecting;

      const restartBtn = X.btn('重启托管核心', async () => {
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
        X.row('当前状态', detail, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
          h('span', { class: badgeCls }, badgeText),
          reconnectBtn,
          restartBtn,
        ])),
      );
      patchSlot.append(patchSwitch);
    };
    drawStatus();

    const openConsoleBtn = X.btn('打开 DSH 模型与扩展控制台', async () => {
      openConsoleBtn.disabled = true;
      try {
        await A.agent?.openConsole?.();
      } finally {
        openConsoleBtn.disabled = false;
      }
    }, 'primary');

    const statusGroup = X.group('DeepSeek Harness 连接状态',
      statusSlot,
      X.row('模型与扩展配置', '一键打开当前 DeepSeek Harness 控制台，填写模型 API Key、切换默认模型或管理 MCP 插件；不开启 DeepSeek Harness.app 也能独立运行', openConsoleBtn),
      X.row('接入模式', '双模自动模式下，已打开带桥接的 DeepSeek Harness 时直接复用，未打开时由 KBOT 自动后台拉起', X.select('dsh.mode', MODES, () => {
        A.agent?.reconnect?.();
      }, 290)),
      X.row('注入桥接到 DeepSeek Harness.app', '在 ~/.dsh/profiles/desktop/cordis.patch.yml 登记桥接插件（保留你现有的桌面端配置），实现桌面端 App 与 KBOT 实时互通', patchSlot),
      X.row('自定义 dsh 可执行路径', '留空则自动查找 PATH、~/.dsh/bin/dsh 与 DeepSeek Harness.app', X.text('dsh.binary', {
        ph: '自动检测（可留空）',
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
      X.group('专属养成目录（记忆、日记与定时任务）',
        X.row('养成目录路径', 'KBOT 的人格提示词（AGENTS.md）、长期记忆（MEMORY.md）与相处日记（diary/）均以纯 Markdown 保存在此目录中', wsInput),
        X.row('目录管理', '你可以直接用任意编辑器查看或修改记忆文件，也可以在 DeepSeek Harness 中打开同一目录协同使用', h('div', { style: 'display:flex;gap:8px' }, [openWsBtn, initWsBtn])),
      ),
      X.note('提示：在对话里说「20 分钟后提醒我喝水」或「每天早上 9:30 提醒我站会」，DSH 会使用内置定时调度器创建提醒，到点自动通过 KBOT 气泡与语音通知你。'),
      X.group('角色性格与称呼（实时同步至 DSH 上下文与语音风格）',
        cards,
        X.row('你希望我怎么叫你', '默认称呼「你」，修改后立即同步到桌面感知上下文', nick),
      ),
      X.group('今日互动统计',
        X.row('今日对话回复次数', '仅在本机统计', h('span', { class: 'sx-status' }, `${callsToday} 次`)),
      ),
    );

    el._redraw = drawStatus;
  };
})();

export {};
