import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { command } from './services/runtime';
import { diffSettings } from './services/settings-patch';
import { installVoice } from './services/voice';

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
  const roots = ['S', 'builtin', 'birthdays'] as const;
  const edited = () => ({ S: A.S, builtin: A.builtin || {}, birthdays: A.birthdays || [] });
  let windowTheme = '';
  const theme = () => {
    if (A.S.theme !== windowTheme) {
      windowTheme = A.S.theme;
      command('settings_window_action', { action: 'theme:' + windowTheme }).catch(() => { windowTheme = ''; });
    }
    document.documentElement.classList.toggle('theme-dark', A.S.theme === 'dark');
    document.documentElement.classList.toggle('theme-light', A.S.theme === 'light');
    document.documentElement.classList.toggle('reduced', !!A.S.reduced);
    document.documentElement.classList.toggle('shell-graphite', A.S.shell === 'graphite');
    document.documentElement.style.setProperty('--glow-rgb', (window.Robot.PALETTES[A.S.palette] || window.Robot.PALETTES.blue).join(', '));
    const orb = window.Robot.orbStyle(A.S.palette);
    document.documentElement.style.setProperty('--orb-hue', orb.hue);
    document.documentElement.style.setProperty('--orb-tint', orb.tint);
  };
  const merge = (target: any, source: any) => {
    for (const k of Object.keys(target)) if (!(k in source)) delete target[k];
    for (const [k, v] of Object.entries(source)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) merge(target[k], v);
      else target[k] = clone(v);
    }
  };
  function accept(next: any, redraw = false) {
    const dshChanged = JSON.stringify(A.dshState) !== JSON.stringify(next.dshState);
    const updChanged = JSON.stringify(A.updateState) !== JSON.stringify(next.updateState);
    for (const root of roots) {
      if (root === 'S') merge(A.S, next.S);
      else A[root] = clone(next[root] || (root === 'birthdays' ? [] : {}));
    }
    A.dshState = clone(next.dshState || null);
    A.updateState = clone(next.updateState || null);
    A.hidden = next.hidden;
    A.chat.convs = clone(next.conversations || []);
    state = next; baseline = clone(next); theme();
    if (redraw) A.refreshSettings?.();
    else {
      if (dshChanged) A.emit('dsh:state', A.dshState);
      if (updChanged) A.emit('updater:state', A.updateState);
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
    convs: clone(state.conversations || []),
    prune: () => action('prune-chats'),
    clearAll: () => { A.chat.convs = []; action('clear-chats'); },
  };
  A.builtin = clone(state.builtin || {});
  A.birthdays = clone(state.birthdays || []);
  A.dshState = clone(state.dshState || null);
  A.updateState = clone(state.updateState || null);
  A.hidden = state.hidden;

  installVoice(A);
  A.agent = {
    state: () => ({ ...(A.dshState || {}) }),
    reconnect: () => action('dsh-reconnect'),
    restart: () => action('dsh-restart'),
    openWorkspace: () => action('dsh-open-workspace'),
    openConsole: () => action('dsh-open-console'),
    initWorkspace: (overwrite = false) => action('dsh-init-workspace', { overwrite }),
    setDesktopPatch: (enabled: boolean) => action('dsh-desktop-patch', { enabled }),
  };
  A.updater = {
    state: () => ({ ...(A.updateState || {}) }),
    check: (manual = true) => action('updater-check', { manual }),
    install: () => action('updater-install'),
  };

  // 设置窗口不加载角色绘制代码，这里保持与 ui/robot.js 的 PALETTES 一致；光之球的色调换算直接复用 robot-orb
  await import('./ui/robot-math.js');
  await import('./ui/robot-orb.js');
  window.Robot = { PALETTES: { blue: [10, 132, 255], indigo: [94, 92, 230], orange: [255, 149, 0], green: [48, 199, 89] }, orbStyle: (window as any).RB.orbStyle };
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
