import { command } from './services/runtime';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Runs only in an isolated development profile, never in a release build.
export async function settingsViewSmoke(A: any) {
  await listen<string>('settings-smoke-step', async ({ payload }) => {
    try {
      let diagnostics: any;
      if (payload === 'edit') {
        A.openSettings('agent');
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.sh-page input[type=text]'));
        const nickInput = inputs.at(-1)!;
        nickInput.value = '窗口同步验证';
        nickInput.dispatchEvent(new Event('change', { bubbles: true }));
        await A.flushSettings();
        A.openSettings('voice');
        const switches = Array.from(document.querySelectorAll<HTMLButtonElement>('.sh-page .switch'));
        switches[0]?.click();
        await A.flushSettings();
      } else if (payload === 'close-edit') {
        A.openSettings('agent');
        const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.sh-page input[type=text]'));
        const nickInput = inputs.at(-1)!;
        nickInput.focus();
        nickInput.value = '关闭前尚未失焦';
        diagnostics = { focused: document.activeElement === nickInput, connected: nickInput.isConnected };
        nickInput.dispatchEvent(new Event('input', { bubbles: true }));
        A.closeSettings();
        await A.flushSettings();
        diagnostics.nickname = A.S.nickname;
      }
      await emitTo('main', 'settings-smoke-result', { step: payload, diagnostics });
    } catch (error) {
      await emitTo('main', 'settings-smoke-result', { step: payload, error: String(error) });
    }
  });
  await emitTo('main', 'settings-smoke-ready', true);
}

export async function nativeSmoke(A: any) {
  const results: Record<string, unknown> = {};
  const assert = (name: string, value: unknown) => { if (!value) throw new Error(name); results[name] = true; };
  try {
    const keys = await command<Record<string, boolean>>('key_status');
    assert('isolated keychain starts empty', !keys.tts);
    await command('save_key', { slot: 'tts', key: 'local-mimo-fixture-only' });
    const savedKeys = await command<Record<string, boolean>>('key_status');
    assert('keychain metadata reports tts slot without returning secrets', savedKeys.tts === true);

    const state = { smoke: '本地存储验证', S: { onboarding: false } };
    await command('save_state', { data: state });
    assert('native persistence', (await command<any>('load_state')).smoke === state.smoke);
    await command('save_state', { data: {} });

    A.S.onboarding = true; A.S.senseIdle = false;
    document.querySelector('#onboarding')?.remove();

    const opening = '今天的待办可以慢慢清空，我的陪伴电量倒是挺足的。';
    A.bubble.show({ kind: 'speech', pri: 'low', text: opening });
    A.panel.open();
    await new Promise(r => setTimeout(r, 250));
    assert('chat input obtains focus', document.activeElement === document.querySelector('#input'));
    assert('opening chat from the robot preserves its visible speech', A.chat.cur.messages[0]?.text === opening && A.chat.cur.messages[0]?.proactive === true);
    assert('proactive conversation metadata survives serialization', A.chat.serialize()[0]?.messages[0]?.proactive === true);
    A.chat.clearAll();
    A.panel.close();
    assert('closed panel is inert', document.querySelector<HTMLElement>('#panel')?.inert);

    const until = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 50));
      if (!predicate()) throw new Error('UI flow timeout');
    };

    const pet = document.querySelector<HTMLElement>('#pet')!;
    const rect = pet.getBoundingClientRect();
    pet.classList.remove('interactive');
    const directHit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    assert('native robot receives clicks without a hover update', !!directHit && pet.contains(directHit));
    const pointer = (type: string, id: number) => new PointerEvent(type, { bubbles: true, pointerId: id, button: 0, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 });
    let rapidClicksToggle = true;
    for (let i = 0; i < 12; i++) {
      const before = A.panel.isOpen();
      pet.dispatchEvent(pointer('pointerdown', 1000 + i));
      pet.dispatchEvent(pointer('pointerup', 1000 + i));
      pet.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      rapidClicksToggle &&= A.panel.isOpen() !== before;
    }
    assert('every rapid click toggles the panel without being consumed as a poke', rapidClicksToggle);
    A.panel.close();
    for (let i = 1; i <= 200; i++) {
      pet.dispatchEvent(pointer('pointerdown', i));
      pet.dispatchEvent(pointer(i % 4 === 0 ? 'lostpointercapture' : i % 3 === 0 ? 'pointercancel' : 'pointerup', i));
      if (i % 4 !== 0 && i % 3 !== 0) pet.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
      if (i % 10 === 0) { A.panel.toggle(); await new Promise(r => setTimeout(r, 5)); }
    }
    assert('rapid clicks and capture loss release the robot', !A.petPointerActive && !A.robot.pressed && !A.robot.held && !pet.classList.contains('dragging'));
    pet.dispatchEvent(pointer('pointerdown', 201)); window.dispatchEvent(new Event('blur'));
    assert('focus loss cancels a pressed pointer', !A.petPointerActive && !A.robot.pressed);
    A.panel.close(); A.panel.open();
    await new Promise(r => setTimeout(r, 300));
    assert('panel stays usable after rapid open and close', A.panel.isOpen() && !document.querySelector<HTMLElement>('#panel')?.inert && !document.querySelector<HTMLElement>('#panel')?.hidden);
    A.panel.close();

    await new Promise(r => setTimeout(r, 250));
    const focusedBeforeHover = await getCurrentWindow().isFocused();
    await emitTo('main', 'desktop-cursor', { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, buttonsDown: false, sampledAt: Date.now() });
    await until(() => !!A.robot.hover);
    assert('native cursor sampling updates robot hover without quick pills or window focus', !A.panel.isOpen() && !document.querySelector('#quick') && await getCurrentWindow().isFocused() === focusedBeforeHover);

    pet.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('勿扰 30 分钟'))!.click();
    assert('right-click DND menu item activates DND without toggling chat', A.isDnd() && !A.panel.isOpen());
    pet.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('结束勿扰'))!.click();
    assert('right-click DND menu item can be switched off', !A.isDnd() && !A.panel.isOpen());

    let ready!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const unready = await listen('settings-smoke-ready', ready);
    pet.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('设置…'))!.click();
    await Promise.race([readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('settings window boot timeout')), 10_000))]);
    unready();
    assert('right-click settings action opens settings without toggling chat', A.settingsVisible && !A.panel.isOpen());
    const runSettings = (step: string) => new Promise<void>(async (resolve, reject) => {
      const timer = setTimeout(() => { stop(); reject(new Error('settings step timeout: ' + step)); }, 10_000);
      const stop = await listen<any>('settings-smoke-result', ({ payload }) => {
        if (payload.step !== step) return;
        clearTimeout(timer); stop();
        if (payload.diagnostics) results[`settings ${step} diagnostics`] = payload.diagnostics;
        if (payload.error) reject(new Error(payload.error)); else resolve();
      });
      await emitTo('settings', 'settings-smoke-step', step);
    });
    await runSettings('edit');
    assert('settings edits sync to main owner', A.S.nickname === '窗口同步验证' && A.S.voice.enabled === true);

    const unchanged = (s: any) => s.mainVisible && !s.mainMinimized && !s.mainFullscreen;
    let controls = await command<any>('settings_window_action', { action: 'minimize' });
    assert('settings minimizes without minimizing companion', controls.minimized && unchanged(controls));
    await command('settings_window_action', { action: 'restore' });
    await command('settings_window_action', { action: 'fullscreen' });
    await new Promise(r => setTimeout(r, 1200));
    controls = await command<any>('settings_window_action', { action: 'state' });
    assert('settings enters fullscreen independently', controls.fullscreen && unchanged(controls));
    await command('settings_window_action', { action: 'fullscreen' });
    await new Promise(r => setTimeout(r, 1200));
    await runSettings('close-edit');
    controls = await command<any>('settings_window_action', { action: 'state' });
    const closingStarted = Date.now();
    while (controls.visible && Date.now() - closingStarted < 2000) {
      await new Promise(r => setTimeout(r, 50));
      controls = await command<any>('settings_window_action', { action: 'state' });
    }
    results['settings close snapshot'] = { ...controls, nickname: A.S.nickname };
    assert('settings close saves focused field and leaves companion running', !controls.visible && unchanged(controls) && A.S.nickname === '关闭前尚未失焦');
    await A.openSettings('agent');
    await new Promise(r => setTimeout(r, 300));
    controls = await command<any>('settings_window_action', { action: 'state' });
    assert('settings can be restored after closing', controls.visible && !controls.minimized && !controls.fullscreen);
    await command('settings_window_action', { action: 'close' });
    await command('delete_key', { slot: 'tts' });
    await command('delete_key', { slot: 'tts' });
    assert('keychain metadata clears after idempotent deletion', (await command<any>('key_status')).tts === false);
  } catch (error) { results.error = String(error); }
  finally {
    await command('delete_key', { slot: 'tts' }).catch(() => {});
    A.save = () => {};
    await A.flush().catch(() => {});
    await command('save_state', { data: {} });
    await command('debug_smoke_report', { report: results });
    await command('quit_app');
  }
}
