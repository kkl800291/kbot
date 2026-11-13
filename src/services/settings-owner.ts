import { emitTo, listen } from '@tauri-apps/api/event';
import { command } from './runtime';
import { applySettingsChanges } from './settings-patch';

// The companion window remains the only owner of DSH management and persistence.
// The settings window only sends field-granular patches and explicit actions.
export async function installSettingsOwner(A: any) {
  const snapshot = () => JSON.parse(JSON.stringify({
    S: A.S,
    builtin: A.builtin || {},
    birthdays: A.birthdays || [],
    dshState: A.dshState || null,
    accountState: A.accountState || null,
    updateState: A.updateState || null,
    conversations: A.chat.convs.map((c: any) => ({ id: c.id, messages: c.messages.length ? [{}] : [] })),
    hidden: A.hidden,
    version: A.version,
  }));
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => emitTo('settings', 'settings-state', snapshot()).catch(() => {}), 60);
  };
  const save = A.save;
  A.save = () => { save(); publish(); };
  A.on('hidden', publish);
  A.on('dsh:state', publish);
  A.on('account:state', publish);
  A.on('updater:state', publish);

  let tail = Promise.resolve();
  await listen<any>('settings-request', ({ payload: request }) => {
    tail = tail.catch(() => {}).then(async () => {
      try {
        const { action, payload = {} } = request;
        if (action === 'patch') {
          const state = applySettingsChanges(snapshot(), payload.changes);
          const changed = Object.keys(state.S).filter(k => JSON.stringify(state.S[k]) !== JSON.stringify(A.S[k]));
          const birthdaysChanged = JSON.stringify(state.birthdays) !== JSON.stringify(A.birthdays || []);
          Object.assign(A.S, state.S);
          A.builtin = state.builtin;
          A.birthdays = state.birthdays;
          for (const k of changed) A.emit('set:' + k, A.S[k]);
          if (changed.some(k => ['palette', 'reduced'].includes(k))) A.applyLook();
          if (changed.includes('city') || changed.includes('cityCoords')) A.emit('sense:city');
          if (birthdaysChanged) A.emit('birthdays');
          A.save();
        } else if (action === 'dsh-reconnect') {
          await A.agent?.reconnect?.();
        } else if (action === 'dsh-restart') {
          await A.agent?.restart?.();
        } else if (action === 'dsh-open-workspace') {
          await A.agent?.openWorkspace?.();
        } else if (action === 'dsh-open-console') {
          await A.agent?.openConsole?.();
        } else if (action === 'dsh-init-workspace') {
          await A.agent?.initWorkspace?.(Boolean(payload.overwrite));
        } else if (action === 'dsh-desktop-patch') {
          await A.agent?.setDesktopPatch?.(Boolean(payload.enabled));
        } else if (action.startsWith('account-')) {
          const methods: Record<string, string> = {
            'account-sign-in': 'signIn', 'account-cancel': 'cancelSignIn', 'account-refresh': 'refresh',
            'account-top-up': 'openTopUp', 'account-usage': 'openUsage', 'account-sign-out': 'signOut',
          };
          const method = methods[action];
          if (!method) throw new Error('不支持的账号操作');
          // Browser authorization can outlive the settings RPC. State updates
          // continue through the owner window while the browser is open.
          A.account?.[method]?.()?.catch?.(() => {});
        } else if (action === 'updater-check') {
          // 检查和安装都可能很久，不让设置窗口干等：马上回一个“进行中”的状态，之后的进展靠状态推送
          A.updater?.check?.(payload.manual !== false)?.catch?.(() => {});
        } else if (action === 'updater-install') {
          A.updater?.install?.()?.catch?.(() => {});
        } else if (action === 'clear-chats') A.chat.clearAll();
        else if (action === 'prune-chats') A.chat.prune();
        else if (action === 'preview-persona') {
          if (!A.hidden && !A.panel.isOpen() && !A.summon.isOpen()) {
            A.bubble.show({ kind: 'speech', pri: 'low', text: String(payload.text).slice(0, 100), expr: 'happy' });
          }
        } else if (action === 'preview-sound') A.blip();
        else if (action === 'notifications') await A.requestNotifications();
        else if (action === 'reset') {
          await command('settings_window_action', { action: 'close' });
          await A.resetData();
        } else if (action !== 'snapshot') throw new Error('不支持的设置操作');
        await emitTo('settings', 'settings-response', { id: request.id, state: snapshot() });
      } catch (error) {
        await emitTo('settings', 'settings-response', {
          id: request.id,
          error: String(error instanceof Error ? error.message : error),
          state: snapshot(),
        });
      }
    });
  });

  await listen<boolean>('settings-visibility', ({ payload: visible }) => { A.settingsVisible = visible; });
  A.openSettings = async (page?: string) => {
    A.menu.close();
    if (A.panel.isOpen()) A.panel.close();
    A.summon.close();
    A.cancelFocusRelease?.();
    try {
      await command('release_focus');
      await command('open_settings_window', { page: page || null, theme: A.S.theme });
    } catch (error) {
      A.toast(`无法打开设置：${String(error)}`, 5000);
    }
  };
}
