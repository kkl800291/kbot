import { emitTo, listen } from '@tauri-apps/api/event';
import { command } from './runtime';
import { emptyDrift, emptyHabits, settingsView } from './habits';
import { applySettingsChanges } from './settings-patch';

// The companion window remains the only owner of scheduling and persistence.
// The settings window only sends edits, never writes an older state.json snapshot.
export async function installSettingsOwner(A: any) {
  const snapshot = () => JSON.parse(JSON.stringify({
    S: A.S, builtin: A.builtin, birthdays: A.birthdays, reminders: A.reminders,
    memories: A.memories,
    ...settingsView(A.habits || emptyHabits(), A.drift || emptyDrift(), A.journal || [], A.S.params?.nightAt || '23:30', Date.now()),
    conversations: A.chat.convs.map((c: any) => ({ id: c.id, messages: c.messages.length ? [{}] : [] })),
    builtins: A.BUILTINS.map((b: any) => ({ k: b.k, name: b.name, description: b.desc(), param: b.param })),
    hidden: A.hidden, version: A.version,
  }));
  let publishTimer: ReturnType<typeof setTimeout> | undefined;
  const publish = () => {
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => emitTo('settings', 'settings-state', snapshot()).catch(() => {}), 60);
  };
  const save = A.save;
  A.save = () => { save(); publish(); };
  A.on('hidden', publish);
  let tail = Promise.resolve();
  await listen<any>('settings-request', ({ payload: request }) => {
    tail = tail.catch(() => {}).then(async () => {
      try {
        const { action, payload = {} } = request;
        if (action === 'patch') {
          const state = applySettingsChanges(snapshot(), payload.changes);
          const changed = Object.keys(state.S).filter(k => JSON.stringify(state.S[k]) !== JSON.stringify(A.S[k]));
          const birthdaysChanged = JSON.stringify(state.birthdays) !== JSON.stringify(A.birthdays);
          // Keep object identities used by model/composer closures intact.
          Object.assign(A.S, state.S); A.builtin = state.builtin; A.birthdays = state.birthdays;
          for (const k of changed) A.emit('set:' + k, A.S[k]);
          if (changed.some(k => ['theme', 'palette', 'shell', 'size', 'reduced', 'onTop'].includes(k))) A.applyLook();
          if (changed.includes('city') || changed.includes('cityCoords')) A.emit('sense:city');
          A.deriveModel(); A.deriveWeb();
          if (birthdaysChanged) A.emit('birthdays');
          A.save();
        } else if (action === 'brain') {
          const allowed = ['addReminder', 'updateReminder', 'removeReminder', 'addMemory', 'updateMemory', 'removeMemory', 'clearMemories', 'removeHabit', 'resetDrift'];
          if (!allowed.includes(payload.method)) throw new Error('不支持的设置操作');
          A.brain[payload.method](...(payload.args || []));
        } else if (action === 'clear-chats') A.chat.clearAll();
        else if (action === 'prune-chats') A.chat.prune();
        else if (action === 'preview-persona') {
          if (!A.hidden && !A.panel.isOpen()) A.bubble.show({ kind: 'speech', pri: 'low', text: String(payload.text).slice(0, 100), expr: 'wink' });
        } else if (action === 'preview-sound') A.blip();
        else if (action === 'notifications') await A.requestNotifications();
        else if (action === 'reset') {
          await command('settings_window_action', { action: 'close' });
          await A.resetData();
        } else if (action !== 'snapshot') throw new Error('不支持的设置操作');
        await emitTo('settings', 'settings-response', { id: request.id, state: snapshot() });
      } catch (error) {
        await emitTo('settings', 'settings-response', { id: request.id, error: String(error instanceof Error ? error.message : error), state: snapshot() });
      }
    });
  });
  await listen<boolean>('settings-visibility', ({ payload: visible }) => { A.settingsVisible = visible; });
  A.openSettings = async (page?: string) => {
    A.menu.close();
    if (A.panel.isOpen()) A.panel.close();
    A.cancelFocusRelease?.();
    try {
      // A tray/context menu may have focused the transparent companion. Release
      // that focus before activating the independent settings window.
      await command('release_focus');
      await command('open_settings_window', { page: page || null });
    }
    catch (error) { A.toast(`无法打开设置：${String(error)}`, 5000); }
  };
}
