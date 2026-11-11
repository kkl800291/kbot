/* KBOT · 设置页（一）：通用（版本、启动、外观、系统通知、数据重置） */
(function () {
  'use strict';
  const A = window.App, { h, $$ } = A, X = A.sx, pages = A.settingsPages;
  const look = () => A.applyLook();

  const PAL_NAMES = { blue: '蓝色', indigo: '靛蓝', orange: '橙色', green: '绿色' };
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

      let desc = '有新版本时，KBOT 会主动提醒你';
      if (installing && u.progress) {
        const pct = typeof u.progress.percent === 'number' ? ` (${u.progress.percent}%)` : '';
        desc = `${u.progress.message || '正在安装更新…'}${pct}`;
      } else if (hasUpdate) {
        const noteText = (u.notes || '').replace(/\s+/g, ' ').trim();
        desc = noteText
          ? `发现新版本 v${u.latestVersion}：${noteText.slice(0, 88)}${noteText.length > 88 ? '…' : ''}`
          : `发现新版本 v${u.latestVersion}，更新后会自动重启`;
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
      X.group('软件更新',
        updateSlot,
        X.row('自动检查更新', null, X.toggle('updater.autoCheck')),
        X.row('更新源', null, X.text('updater.endpoint', {
          ph: '默认更新源',
          w: 250,
          max: 280,
          allowEmpty: true,
          after: v => {
            if (v) A.sput('updater.skippedVersion', '');
          },
        })),
      ),
      X.note('默认使用 KBOT 自建更新源，也可以填写 latest.json 链接或 GitHub 仓库。'),
      X.group('启动与窗口',
        X.row('登录时打开', null, X.toggle('autostart')),
        X.row('角色置顶', '关闭后，角色可能被其他窗口遮住', X.toggle('onTop', look)),
      ),
      X.group('外观',
        X.row('界面主题', null, X.seg('theme', [['light', '浅色'], ['dark', '深色']], look)),
        X.row('强调色', null, swatches()),
        X.row('机身', null, X.seg('shell', [['light', '彩色玻璃'], ['graphite', '石墨']], look)),
        X.row('角色大小', null, X.seg('size', [[96, '小'], [120, '中'], [150, '大']], look)),
        X.row('减少动态效果', null, X.toggle('reduced', look)),
      ),
      X.note('提醒、被戳和休息时，角色会临时换成对应的颜色；思考时边缘会出现流动的彩色光。'),
      X.group('提示与通知',
        X.row('提示音', '勿扰时自动静音', X.toggle('sound', v => { if (v) A.blip(); })),
        X.row('系统通知', '角色隐藏时，用系统通知送达提醒', X.btn('允许通知', () => A.requestNotifications())),
      ),
      X.group('本机数据',
        X.row('重置 KBOT', '清空外观设置、本地对话和语音 Key，不会删除 ~/KBOT 里的记忆和日记', X.danger('重置…', '再点一次确认', () => A.resetData())),
      ),
    );
  };
})();

export {};
