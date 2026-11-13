import { listen } from '@tauri-apps/api/event';
import { command, native } from './runtime';

export interface UpdateProgressInfo {
  stage: string;
  percent: number | null;
  message: string;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'up-to-date' | 'installing' | 'error';
  configured: boolean;
  endpoint: string | null;
  currentVersion: string;
  latestVersion: string | null;
  hasUpdate: boolean;
  downloadUrl: string | null;
  releaseUrl: string | null;
  notes: string | null;
  publishedAt: string | null;
  sha256: string | null;
  progress: UpdateProgressInfo | null;
  error: string | null;
  lastCheckedAt: number | null;
}

export function summarizeUpdateNotes(notes?: string | null, maxChars = 110): string {
  if (!notes) return '';
  const cleaned = String(notes)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/[*_~`]+/g, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!cleaned) return '';
  if (cleaned.length <= maxChars) return cleaned;
  return cleaned.slice(0, maxChars).replace(/[，,、；;：:\s]+$/, '') + '…';
}

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_UPDATE_ENDPOINT = 'https://schathub.xyz/kbot/releases/latest.json';
export const DEFAULT_UPDATE_REPO = DEFAULT_UPDATE_ENDPOINT;

export function installUpdater(A: any) {
  const state: UpdateState = {
    status: 'idle',
    configured: true,
    endpoint: A.S?.updater?.endpoint || DEFAULT_UPDATE_ENDPOINT,
    currentVersion: A.version || '0.1.9',
    latestVersion: null,
    hasUpdate: false,
    downloadUrl: null,
    releaseUrl: null,
    notes: null,
    publishedAt: null,
    sha256: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
  };
  A.updateState = { ...state };

  let announcedVersion: string | null = null;
  let lastEndpoint = A.S?.updater?.endpoint || '';
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  function emitState() {
    A.updateState = { ...state, progress: state.progress ? { ...state.progress } : null };
    A.emit('updater:state', A.updateState);
  }

  function announceUpdate(manual = false) {
    if (!state.hasUpdate || !state.latestVersion) return;
    const ver = state.latestVersion;
    if (!manual) {
      if (A.S?.updater?.skippedVersion === ver) return;
      if (announcedVersion === ver) return;
    }
    announcedVersion = ver;

    const noteSummary = summarizeUpdateNotes(state.notes, 110);
    const text = noteSummary
      ? `新版本 **v${ver}** 已发布（当前 v${state.currentVersion}）。\n${noteSummary}`
      : `新版本 **v${ver}** 已发布（当前 v${state.currentVersion}）。可以一键更新并自动重启，无需手动安装。`;

    const actions: any[] = [
      state.downloadUrl
        ? {
            label: '立即更新并重启',
            primary: true,
            fn: () => {
              installUpdate().catch(() => {});
            },
          }
        : {
            label: '查看新版本',
            primary: true,
            fn: () => {
              if (state.releaseUrl) A.openUrl?.(state.releaseUrl);
              else A.openSettings?.('general');
            },
          },
      {
        label: '稍后提醒',
        quiet: true,
        fn: () => {},
      },
    ];
    if (!manual) {
      actions.push({
        label: '跳过此版本',
        quiet: true,
        fn: () => {
          A.sput?.('updater.skippedVersion', ver);
          A.toast?.(`已跳过 v${ver} 的自动提醒`);
        },
      });
    }

    A.speak?.({
      kind: 'remind',
      pri: 'mid',
      title: `发现新版本 v${ver}`,
      text,
      expr: 'sparkle',
      actions,
    });
  }

  async function checkForUpdates(opts: { manual?: boolean; announce?: boolean } = {}) {
    const manual = Boolean(opts.manual);
    if (state.status === 'checking' || state.status === 'installing') {
      return { ...state };
    }
    if (!native) {
      state.status = 'error';
      state.error = '浏览器预览模式不支持应用自更新';
      emitState();
      if (manual) A.toast?.(state.error, 3500);
      return { ...state };
    }

    state.status = 'checking';
    state.error = null;
    emitState();

    try {
      const endpoint = (A.S?.updater?.endpoint || '').trim() || null;
      const res = await command<any>('check_app_update', { endpoint });
      state.configured = Boolean(res?.configured);
      state.endpoint = res?.endpoint ?? endpoint;
      state.currentVersion = res?.currentVersion || state.currentVersion;
      state.latestVersion = res?.latestVersion ?? null;
      state.hasUpdate = Boolean(res?.hasUpdate);
      state.downloadUrl = res?.downloadUrl ?? null;
      state.releaseUrl = res?.releaseUrl ?? null;
      state.notes = res?.notes ?? null;
      state.publishedAt = res?.publishedAt ?? null;
      state.sha256 = res?.sha256 ?? null;
      state.lastCheckedAt = Date.now();
      state.progress = null;

      if (!state.configured) {
        state.status = 'idle';
        if (manual) {
          A.toast?.('请先在「设置 → 通用 → 版本更新」填写 GitHub 仓库或更新清单地址', 4500);
        }
      } else if (state.hasUpdate && state.latestVersion) {
        state.status = 'available';
        if (manual) {
          A.toast?.(`发现新版本 v${state.latestVersion}，可一键更新并重启`, 4000);
        }
        if (opts.announce !== false) {
          announceUpdate(manual);
        }
      } else {
        state.status = 'up-to-date';
        if (manual) {
          A.toast?.(`当前已是最新版本（v${state.currentVersion}）`, 3200);
        }
      }
      emitState();
      return { ...state };
    } catch (err: any) {
      state.status = 'error';
      state.error = err?.message || String(err);
      state.lastCheckedAt = Date.now();
      emitState();
      if (manual) {
        A.toast?.(`检查更新失败：${state.error}`, 5000);
      }
      return { ...state };
    }
  }

  // 更新进行中：屏幕顶部出一条带进度带的常驻条，文字是此刻在做什么，右边是整体百分比。
  // 召唤态和对话窗口里看不到常驻条，更新开始时先把它们收起来（反正装完就要重启）
  function showProgress() {
    const p = state.progress;
    if (!p || !A.top) return;
    const percent = typeof p.percent === 'number' ? Math.max(0, Math.min(100, Math.round(p.percent))) : 0;
    const patch = { label: (p.message || '正在更新').replace(/…$/, ''), aux: percent + '%', progress: percent / 100 };
    if (A.top.act?.()?.source === 'updater') A.top.updateAct(patch, 'updater');
    else {
      A.summon?.close?.();
      A.panel?.close?.();
      A.top.startAct({ kind: 'task', source: 'updater', ...patch });
    }
  }

  async function installUpdate() {
    if (!native) {
      A.toast?.('请在 macOS 桌面应用中使用一键更新', 3500);
      return false;
    }
    if (state.status === 'installing') return false;
    if (!state.downloadUrl) {
      if (state.releaseUrl) {
        A.openUrl?.(state.releaseUrl);
        return true;
      }
      A.toast?.('当前新版本未提供自动安装包链接，请前往发布页手动下载', 4500);
      return false;
    }

    state.status = 'installing';
    state.error = null;
    state.progress = {
      stage: 'preparing',
      percent: 0,
      message: '正在准备下载新版本…',
    };
    emitState();
    showProgress();

    try {
      await A.flush?.();
    } catch {
      /* Continue update even if flush had nothing pending. */
    }

    try {
      await command('install_app_update', {
        downloadUrl: state.downloadUrl,
        expectedSha256: state.sha256 || null,
      });
      return true;
    } catch (err: any) {
      state.status = 'error';
      state.error = err?.message || String(err);
      state.progress = null;
      emitState();
      A.top?.endAct?.('task');
      A.toast?.(`自动更新失败：${state.error}`, 5500);
      return false;
    }
  }

  A.updater = {
    state: () => ({ ...state }),
    check: (manual = true) => checkForUpdates({ manual, announce: !manual || !A.settingsVisible }),
    install: () => installUpdate(),
  };

  A.on('set:updater', () => {
    const curEndpoint = (A.S?.updater?.endpoint || '').trim();
    if (curEndpoint !== lastEndpoint) {
      lastEndpoint = curEndpoint;
      state.endpoint = curEndpoint || DEFAULT_UPDATE_REPO;
      state.configured = true;
      emitState();
      if (curEndpoint && A.S?.updater?.autoCheck !== false) {
        checkForUpdates({ manual: false, announce: true }).catch(() => {});
      }
    }
  });

  A.init(async () => {
    if (native) {
      await listen<any>('updater-progress', ({ payload }) => {
        if (!payload) return;
        state.status = payload.stage === 'done' ? 'installing' : state.status === 'installing' ? 'installing' : state.status;
        state.progress = {
          stage: String(payload.stage || 'downloading'),
          percent: typeof payload.percent === 'number' ? payload.percent : null,
          message: String(payload.message || ''),
        };
        emitState();
        if (state.status === 'installing') showProgress();
      });
    }

    setTimeout(() => {
      if (A.S?.updater?.autoCheck !== false) {
        checkForUpdates({ manual: false, announce: true }).catch(() => {});
      }
    }, 6500);

    if (intervalTimer) clearInterval(intervalTimer);
    intervalTimer = setInterval(() => {
      if (A.S?.updater?.autoCheck !== false) {
        checkForUpdates({ manual: false, announce: true }).catch(() => {});
      }
    }, CHECK_INTERVAL_MS);
  });
}
