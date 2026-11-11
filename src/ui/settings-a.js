/* KBOT · 设置页（一）：通用（版本、启动、外观、系统通知、数据重置） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;
  const look = () => A.applyLook();

  const PAL_NAMES = { cyan: '青色', violet: '紫色', amber: '琥珀', mint: '薄荷' };
  function swatches() {
    const el = h('div', { class: 'sx-swatches' }, Object.keys(Robot.PALETTES).map(k => h('button', {
      type: 'button', 'data-pal': k, title: PAL_NAMES[k] || k, 'aria-label': PAL_NAMES[k] || k, style: `--c:${Robot.PALETTES[k].join(',')}`,
    })));
    const sync = () => $$('button', el).forEach(b => b.classList.toggle('on', b.dataset.pal === A.S.palette));
    el.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      A.sput('palette', b.dataset.pal); look(); sync();
    });
    sync();
    return el;
  }

  pages.general = el => {
    const updateSlot = h('div', {});

    const drawUpdate = () => {
      updateSlot.replaceChildren();
      const u = A.updateState || {};
      const curVer = A.version || u.currentVersion || '开发预览';
      const checking = u.status === 'checking';
      const installing = u.status === 'installing';
      const hasUpdate = !!u.hasUpdate && !!u.latestVersion;

      let desc = '纯桌面壳架构 · 检测到新版本时将由角色气泡或对话主动提醒，支持静默替换并自动重启';
      if (installing && u.progress) {
        const pct = typeof u.progress.percent === 'number' ? ` (${u.progress.percent}%)` : '';
        desc = `${u.progress.message || '正在安装更新…'}${pct}`;
      } else if (hasUpdate) {
        const noteText = (u.notes || '').replace(/\s+/g, ' ').trim();
        desc = noteText
          ? `发现新版本 v${u.latestVersion}：${noteText.slice(0, 88)}${noteText.length > 88 ? '…' : ''}`
          : `发现新版本 v${u.latestVersion}，可一键下载替换当前应用并自动重启`;
      } else if (u.status === 'up-to-date') {
        desc = `已是最新版本（v${curVer}）`;
      } else if (u.status === 'error' && u.error) {
        desc = `上次检查失败：${u.error}`;
      }

      const badgeCls = 'sx-status' + (hasUpdate || u.status === 'up-to-date' ? ' ok' : u.status === 'error' ? ' bad' : '');
      const badgeLabel = hasUpdate ? `v${curVer} → v${u.latestVersion}` : `v${curVer}`;

      const checkBtn = X.btn(checking ? '检查中…' : '检查更新', async () => {
        checkBtn.disabled = true;
        try { await A.updater?.check?.(true); }
        finally { checkBtn.disabled = false; drawUpdate(); }
      }, hasUpdate ? 'ghost' : '');
      checkBtn.disabled = checking || installing;

      const installBtn = hasUpdate
        ? X.btn(
            installing ? '正在更新…' : (u.downloadUrl ? `立即更新 v${u.latestVersion}` : '前往下载页'),
            () => A.updater?.install?.(),
            'primary',
          )
        : null;
      if (installBtn) installBtn.disabled = installing;

      updateSlot.append(
        X.row('当前版本', desc, h('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap' }, [
          h('span', { class: badgeCls }, badgeLabel),
          installBtn,
          checkBtn,
        ].filter(Boolean))),
      );
    };
    drawUpdate();
    el._redraw = drawUpdate;

    el.append(
      X.group('关于与版本更新',
        updateSlot,
        X.row('自动检查更新', '启动时及后台定期检测新版本；发现更新时由 KBOT 主动在气泡或对话窗提醒你一键升级', X.toggle('updater.autoCheck')),
        X.row('更新源地址', '默认绑定 kkl800291/kbot Releases；也支持自定义 GitHub 仓库、.git 地址或 latest.json 清单链接（留空自动回退默认仓库或 ~/KBOT/releases/latest.json）', X.text('updater.endpoint', {
          ph: '默认 kkl800291/kbot',
          w: 250,
          max: 280,
          allowEmpty: true,
          after: v => {
            if (v) A.sput('updater.skippedVersion', '');
          },
        })),
      ),
      X.group('启动与窗口',
        X.row('开机启动', '登录 macOS 后自动出现在桌面，默认关闭', X.toggle('autostart')),
        X.row('角色置顶', '关闭后，角色会被其他应用的窗口遮住', X.toggle('onTop', look)),
      ),
      X.group('机器人外观',
        X.row('角色大小', null, X.seg('size', [[96, '小'], [120, '中'], [150, '大']], look)),
        X.row('界面主题', '对话面板、气泡和设置窗口的明暗风格', X.seg('theme', [['dark', '深色'], ['light', '浅色']], look)),
        X.row('发光颜色', '屏幕脸的主色；思考、提醒、休眠等状态会自动切换光效', swatches()),
        X.row('机身外壳', null, X.seg('shell', [['light', '亮色'], ['graphite', '石墨']], look)),
        X.row('减少动态效果', '开启后面板改为淡入淡出，角色弹簧与呼吸动作更克制', X.toggle('reduced', look)),
      ),
      X.group('提示与通知',
        X.row('轻提示音', '气泡与提醒出现时播放一声轻响；勿扰期间自动静音', X.toggle('sound', v => { if (v) A.blip(); })),
        X.row('系统通知', '角色隐藏后通过 macOS 系统通知送达提醒', X.btn('允许系统通知', () => A.requestNotifications())),
      ),
      X.group('本机数据',
        X.row('重置桌面壳数据', '清空外观设置、本地对话缓存与保存的语音 API Key（不会删除 ~/KBOT 养成目录中的记忆与日记文件）', X.danger('重置…', '再次点击确认重置', () => A.resetData())),
      ),
    );
  };
})();

export {};
