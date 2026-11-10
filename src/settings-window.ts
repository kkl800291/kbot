import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { command } from './services/runtime';
import { diffSettings } from './services/settings-patch';
import { validateReminder } from './services/scheduler';
import { isWorkday } from './services/calendar';

const clone = (value: any) => JSON.parse(JSON.stringify(value));

export async function bootSettingsWindow() {
  const pending = new Map<string, { resolve: (s: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  await listen<any>('settings-response', ({ payload: response }) => {
    const request = pending.get(response.id); if (!request) return;
    pending.delete(response.id); clearTimeout(request.timer);
    if (response.error) request.reject(Object.assign(new Error(response.error), { state: response.state }));
    else request.resolve(response.state);
  });
  const rpc = (action: string, payload: any = {}) => new Promise<any>((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('主窗口暂未响应，请稍后重试')); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    emitTo('main', 'settings-request', { id, action, payload }).catch(error => {
      clearTimeout(timer); pending.delete(id); reject(error);
    });
  });
  let state = await rpc('snapshot');
  window.__COMPANION_STATE__ = state;
  document.documentElement.classList.add('settings-host');
  await import('./ui/icons.js');
  await import('./ui/core.js');
  const A = window.App;
  A.native = true; A.settingsHost = true;
  A.version = state.version;
  A.focusWindow = () => {};
  A.releaseWindow = () => {};
  let baseline = clone(state), queued = 0;
  let tail = Promise.resolve();
  let metadata = state.builtins;
  const roots = ['S', 'builtin', 'birthdays'] as const;
  const edited = () => ({ S: A.S, builtin: A.builtin, birthdays: A.birthdays });
  const theme = () => {
    document.documentElement.classList.toggle('theme-dark', A.S.theme === 'dark');
    document.documentElement.classList.toggle('theme-light', A.S.theme === 'light');
    document.documentElement.classList.toggle('reduced', !!A.S.reduced);
    document.documentElement.style.setProperty('--glow-rgb', window.Robot.PALETTES[A.S.palette].join(', '));
  };
  // Mutate existing settings objects: fields in the current page hold references to them.
  const merge = (target: any, source: any) => {
    for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
    for (const [k, v] of Object.entries(source)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
      else target[k] = clone(v);
    }
  };
  function accept(next: any, redraw = false) {
    const remindersChanged = JSON.stringify(A.reminders) !== JSON.stringify(next.reminders);
    const memoriesChanged = JSON.stringify(A.memories) !== JSON.stringify(next.memories);
    const birthdaysChanged = JSON.stringify(A.birthdays) !== JSON.stringify(next.birthdays);
    for (const root of roots) {
      if (root === 'S') merge(A.S, next.S);
      else A[root] = clone(next[root]);
    }
    A.reminders = clone(next.reminders); A.memories = clone(next.memories); A.hidden = next.hidden;
    const habitsChanged = JSON.stringify(A.habits) !== JSON.stringify(next.habits);
    const driftChanged = JSON.stringify(A.drift) !== JSON.stringify(next.drift);
    A.habits = clone(next.habits || []);
    A.drift = clone(next.drift || { talkativeness: 0, nightQuiet: 0 });
    A.habitProgress = clone(next.habitProgress || []);
    A.chat.convs = clone(next.conversations); metadata = next.builtins;
    state = next; baseline = clone(next); theme();
    if (redraw) A.refreshSettings?.();
    else {
      if (remindersChanged) A.emit('reminders');
      if (memoriesChanged) A.emit('memories');
      if (birthdaysChanged) A.emit('birthdays');
      if (habitsChanged) A.emit('habits');
      if (driftChanged) A.emit('drift');
    }
  }
  const enqueue = (action: string, payload = {}) => {
    queued++;
    const job = tail.catch(() => {}).then(() => rpc(action, payload));
    tail = job.then(next => {
      queued--; if (!queued) accept(next);
    }, error => {
      queued--; if (!queued && error.state) accept(error.state, true);
      A.toast(String(error.message || error), 5000);
    });
    return tail;
  };
  let initializing = true;
  A.save = () => {
    if (initializing) return;
    const changes = diffSettings(baseline, edited());
    if (!changes.length) return;
    // Advance the local baseline synchronously so successive edits aren't sent twice.
    for (const root of roots) baseline[root] = clone(A[root]);
    enqueue('patch', { changes });
  };
  A.flushSettings = () => { A.save(); return tail; };
  const action = (name: string, payload = {}) => { A.save(); return enqueue(name, payload); };
  A.applyLook = theme;
  A.nativeCommand = command;
  A.requestNotifications = () => action('notifications');
  A.resetData = () => action('reset');
  A.blip = () => action('preview-sound');
  A.bubble = { show: (ev: any) => action('preview-persona', { text: ev.text }) };
  A.panel = { isOpen: () => false, close: () => {} };
  A.chat = {
    convs: clone(state.conversations), prune: () => action('prune-chats'),
    clearAll: () => { A.chat.convs = []; action('clear-chats'); },
  };
  A.builtin = clone(state.builtin); A.birthdays = clone(state.birthdays);
  A.reminders = clone(state.reminders); A.memories = clone(state.memories); A.hidden = state.hidden;
  A.habits = clone(state.habits || []); A.drift = clone(state.drift || { talkativeness: 0, nightQuiet: 0 }); A.habitProgress = clone(state.habitProgress || []);
  A.BUILTINS = state.builtins.map((b: any) => ({ ...b, desc: () => {
    const p = A.S.params;
    const description: Record<string, string> = {
      rest: `每工作 ${A.S.work} 分钟，休息 ${A.S.rest} 分钟`,
      water: `工作时间内每 ${p.waterEvery} 分钟，离开期间不累计`,
      eye: `每 ${p.eyeEvery} 分钟看远处 20 秒`,
      lunch: `工作日 ${p.lunchAt}，17:30 仍工作时再提醒`,
      offwork: `下班前 ${p.offworkLead} 分钟`,
      night: `${p.nightAt} 后仍在使用电脑，每晚最多 2 次`,
    };
    return description[b.k] || metadata.find((entry: any) => entry.k === b.k).description;
  } }));
  A.brain = {};
  const run = (method: string, args: any[]) => action('brain', { method, args });
  const at = (r: any) => validateReminder(r, Date.now(), date => isWorkday(date, A.S.holidays));
  A.brain.addReminder = (data: any) => {
    const r = { ...data, id: A.uid(), at: at(data), fired: false };
    A.reminders.push(r); run('addReminder', [data]); A.emit('reminders'); return r;
  };
  A.brain.updateReminder = (id: string, data: any) => {
    const r = A.reminders.find((r: any) => r.id === id); if (!r) return;
    Object.assign(r, data, { at: at(data), fired: false }); run('updateReminder', [id, data]); A.emit('reminders');
  };
  A.brain.removeReminder = (id: string) => { A.reminders = A.reminders.filter((r: any) => r.id !== id); run('removeReminder', [id]); A.emit('reminders'); };
  A.brain.addMemory = (text: string) => { A.memories.push({ id: A.uid(), text, t: Date.now() }); run('addMemory', [text]); A.emit('memories'); };
  A.brain.updateMemory = (id: string, text: string) => { const m = A.memories.find((m: any) => m.id === id); if (m) m.text = text; run('updateMemory', [id, text]); A.emit('memories'); };
  A.brain.removeMemory = (id: string) => { A.memories = A.memories.filter((m: any) => m.id !== id); run('removeMemory', [id]); A.emit('memories'); };
  A.brain.clearMemories = () => { A.memories = []; run('clearMemories', []); A.emit('memories'); };
  A.brain.removeHabit = (id: string) => {
    A.habits = (A.habits || []).filter((item: any) => item.id !== id);
    A.habitProgress = (A.habitProgress || []).map((item: any) => item.id === id ? { ...item, samples: 0 } : item);
    run('removeHabit', [id]); A.emit('habits');
  };
  A.brain.resetDrift = () => { A.drift = { talkativeness: 0, nightQuiet: 0 }; run('resetDrift', []); A.emit('drift'); };
  // Palette metadata only; the settings process never creates a renderer or a second timer engine.
  window.Robot = { PALETTES: { cyan: [92, 225, 255], violet: [172, 148, 255], amber: [255, 198, 106], mint: [112, 242, 192] } };
  await import('./ui/settings.js');
  await import('./ui/settings-a.js');
  await import('./ui/settings-b.js');
  await import('./ui/settings-c.js');
  await import('./ui/settings-d.js');
  initializing = false;
  const openLocal = A.openSettings;
  const show = async (page?: string) => {
    await tail;
    accept(await rpc('snapshot'));
    // Restoring a minimized/closed native window keeps its form and scroll.
    if (page) openLocal(page);
  };
  await listen<string>('settings-open', ({ payload }) => { show(payload).catch(error => A.toast(String(error))); });
  await listen<any>('settings-state', ({ payload }) => { if (!queued) accept(payload); });
  const dirtyInputs = new Set<HTMLInputElement | HTMLTextAreaElement>();
  document.addEventListener('input', event => {
    const input = event.target;
    if ((input instanceof HTMLInputElement && ['text', 'number'].includes(input.type)) || input instanceof HTMLTextAreaElement) dirtyInputs.add(input);
  }, true);
  document.addEventListener('change', event => { dirtyInputs.delete(event.target as HTMLInputElement); }, true);
  const flushInput = () => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    // WebKit can retain its activeElement without firing blur/change when the
    // native window has just left fullscreen or lost application focus.
    for (const input of Array.from(dirtyInputs)) {
      dirtyInputs.delete(input);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    A.save();
  };
  await listen('settings-closed', flushInput);
  await listen('settings-blur', flushInput);
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => { if (!focused) flushInput(); });
  A.closeSettings = () => { flushInput(); command('settings_window_action', { action: 'close' }).catch(error => A.toast(String(error))); return true; };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); A.closeSettings(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'w') { e.preventDefault(); A.closeSettings(); }
  });
  window.Icons.mount(); theme();
  openLocal(new URLSearchParams(location.search).get('page') || undefined);
  if (import.meta.env.DEV && await command('debug_smoke_enabled')) {
    const { settingsViewSmoke } = await import('./smoke');
    await settingsViewSmoke(A);
  }
}
