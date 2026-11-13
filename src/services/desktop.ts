import { command, listen, native } from './runtime';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { openUrl } from '@tauri-apps/plugin-opener';
import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart';
import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification';

export function installDesktop(A: any) {
  A.nativeCommand = command;
  A.openUrl = async (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    try { if (native) await openUrl(url); else window.open(url, '_blank', 'noopener,noreferrer'); }
    catch { A.toast('无法打开链接，请稍后重试'); }
  };
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let focusVersion = 0, focusTail = Promise.resolve();
  const changeFocus = (focused: boolean, version: number) => {
    focusTail = focusTail.catch(() => {}).then(async () => {
      if (native && version === focusVersion) await command(focused ? 'focus_companion' : 'release_focus');
    });
    focusTail.catch(() => {});
  };
  // 召唤态和对话窗口都要拿焦点
  const engaged = () => A.panel.isOpen() || !!A.summon?.isOpen?.();
  A.focusWindow = () => { clearTimeout(releaseTimer); changeFocus(true, ++focusVersion); };
  A.cancelFocusRelease = () => { clearTimeout(releaseTimer); focusVersion++; };
  A.releaseWindow = () => {
    clearTimeout(releaseTimer);
    const version = ++focusVersion;
    if (native) releaseTimer = setTimeout(() => {
      if (!engaged() && !A.panel.isTransitioning?.() && !document.querySelector('#menu.open, #sheet.open, #onboarding')) changeFocus(false, version);
    }, 80);
  };
  A.captureScreen = async () => {
    if (!native) throw new Error('请在桌面应用中截图');
    A.panel.close();
    // Hide all companion UI so it cannot appear in the user's screenshot.
    await command('hide_companion', { hidden: true });
    try {
      const src = await command<string | null>('capture_screen');
      if (!src) return null;
      const blob = await (await fetch(src)).blob();
      return new File([blob], '截图.png', { type: 'image/png' });
    } finally { await command('hide_companion', { hidden: false }); A.panel.open(); }
  };
  A.requestNotifications = async () => {
    if (!native) { A.toast('请在桌面应用中开启系统通知'); return; }
    try {
      let granted = await isPermissionGranted();
      if (!granted) granted = await requestPermission() === 'granted';
      A.toast(granted ? '已允许系统通知' : '请在系统设置 → 通知 → KBOT 中开启');
    } catch { A.toast('通知权限读取失败，请到系统设置中检查'); }
  };

  let sensorKey = '';
  const sensors = () => {
    const idle = !!A.S.onboarding && !!A.S.senseIdle, app = !!A.S.onboarding && !!A.S.senseApp;
    const key = JSON.stringify([idle, app]);
    if (sensorKey === key) return;
    sensorKey = key;
    command('configure_sensors', { idle, app }).catch(() => {});
  };
  ['senseIdle', 'senseApp'].forEach(key => A.on('set:' + key, sensors));
  A.on('onboarded', sensors);
  A.on('set:autostart', async () => {
    if (!native) { A.S.autostart = false; A.toast('开机启动需要在桌面应用中设置'); return; }
    try { if (A.S.autostart) await enable(); else await disable(); }
    catch { A.S.autostart = await isEnabled().catch(() => false); A.save(); A.toast('开机启动设置失败，请重新打开设置后重试'); }
  });
  let shortcut = '';
  const hotkey = async () => {
    if (!native) return;
    const k = A.S.hotkey;
    const code = k.code.replace(/^Key|^Digit/, '');
    const next = [k.meta && 'Super', k.ctrl && 'Control', k.alt && 'Alt', k.shift && 'Shift', code].filter(Boolean).join('+');
    if (shortcut === next) return;
    const previous = shortcut;
    try {
      await register(next, event => {
        if (event.state === 'Pressed') A.top.hotkey();
      });
      shortcut = next;
      if (previous) await unregister(previous);
    } catch { A.toast('召唤快捷键被其他应用占用或不受支持，请在设置 → 对话中更换', 6000); }
  };
  A.on('set:hotkey', hotkey);
  const released = (open: boolean) => { if (!open && !document.querySelector('#sheet.open')) A.releaseWindow(); };
  A.on('panel', released);
  A.on('summon', released);
  A.on('settings', (open: boolean) => { if (!open && !engaged()) A.releaseWindow(); });
  A.on('hidden', (hidden: boolean) => { if (native) command('hide_companion', { hidden }).catch(() => {}); });

  let regionKey = '', regionPending = false, regionDirty = false, capturing = false;
  function updateRegions() {
    if (!native) return;
    if (regionPending) { regionDirty = true; return; }
    regionDirty = false;
    const regions: any[] = [];
    if (!A.hidden && !capturing) {
      // 只有顶部的内容区接收点击；羽化的衬底外圈和感应区都穿透给下面的应用
      const top = A.top?.contentRect?.();
      if (top && top.width && top.height) regions.push({ x: top.x, y: top.y, w: top.width, h: top.height, radius: 14 });
      for (const element of document.querySelectorAll('#menu.open, #sheet.open .sh-win, #onboarding .welcome-card, #lightbox.open img')) {
        const r = element.getBoundingClientRect();
        if (r.width && r.height) regions.push({ x: r.x, y: r.y, w: r.width, h: r.height, radius: 10 });
      }
    }
    const dragging = !A.hidden && !!A.panel.isDragging?.();
    const interactive = engaged() || !!document.querySelector('#menu.open, #sheet.open, #onboarding');
    const key = JSON.stringify([regions.map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h)]), dragging, interactive]);
    if (key === regionKey) return;
    regionPending = true;
    command('set_regions', { regions, dragging, interactive }).then(() => { regionKey = key; }).catch(() => {}).finally(() => {
      regionPending = false;
      if (regionDirty) updateRegions();
    });
  }
  A.on('top', updateRegions);
  A.on('menu', updateRegions);
  A.on('panel', updateRegions);
  A.on('panelmove', updateRegions);
  A.on('paneldrag', updateRegions);
  A.on('summon', updateRegions);
  A.on('panelmotion', (active: boolean) => { updateRegions(); if (!active && !engaged()) A.releaseWindow(); });

  A.sysNotify = async (ev: any) => {
    if (!native) { A.toast(`${ev.title || '提醒'}：${ev.text}`, 8000); return; }
    try {
      if (await isPermissionGranted()) sendNotification({ title: ev.title || 'KBOT', body: ev.text, sound: undefined });
      else {
        // Keep a missed reminder in the local inbox instead of silently dropping it.
        if (ev.pri === 'high') { A.missed.push(ev); A.save(); }
      }
    } catch { if (ev.pri === 'high') A.missed.push(ev); }
  };

  A.init(async () => {
    if (!native) {
      document.documentElement.classList.add('browser-preview');
      document.querySelector<HTMLElement>('#preview')!.hidden = false;
      document.querySelector('#preview-summon')!.addEventListener('click', () => A.summon.toggle());
      document.querySelector('#preview-chat')!.addEventListener('click', () => A.panel.toggle());
      document.querySelector('#preview-settings')!.addEventListener('click', () => A.openSettings());
      return;
    }
    await listen<any>('desktop-cursor', ({ payload: p }) => A.top?.cursor(p.x, p.y));
    await listen('desktop-outside', () => {
      if (A.menu?.isOpen?.()) A.menu.close();
      A.top?.outside?.();
    });
    await listen<any>('desktop-sensors', ({ payload }) => A.emit('sensors', payload));
    await listen('desktop-tick', () => A.emit('tick'));
    await listen<string>('desktop-action', async ({ payload: action }) => {
      if (action === 'visibility') A.setHidden(!A.hidden);
      else if (action === 'hide') A.setHidden(true);
      else if (action === 'show') A.setHidden(false);
      else if (action === 'chat') { if (A.hidden) A.setHidden(false); A.panel.open(); }
      else if (action === 'summon') { if (A.hidden) A.setHidden(false); A.summon.open(); }
      else if (action === 'workspace') { await A.agent?.openWorkspace?.(); }
      else if (action === 'settings' || action === 'agent') { if (A.hidden) A.setHidden(false); A.openSettings(action === 'agent' ? 'agent' : undefined); }
      else if (action === 'dnd') A.setDnd(A.isDnd() ? 0 : 30);
      else if (action === 'quit') await A.quit();
      else if (action === 'reposition') { if (A.hidden) A.setHidden(false); await A.top?.relayout(); }
      else if (action === 'relayout') await A.top?.relayout();
    });
    const win = getCurrentWindow();
    await win.onFocusChanged(({ payload: focused }) => {
      if (!focused) {
        if (A.menu?.isOpen?.()) A.menu.close();
        A.top?.outside?.();
      }
    });
    A.S.autostart = await isEnabled().catch(() => false);
    A.set('screenPerm', await command('screen_permission', { request: false }));
    sensors(); await hotkey();
    updateRegions(); setInterval(updateRegions, 100);
    await command('desktop_ready');
    if (!A.S.onboarding) A.focusWindow();
  });
}
