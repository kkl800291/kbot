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
        const switches = Array.from(document.querySelectorAll<HTMLInputElement>('.sh-page input[role=switch]'));
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

    // 冒烟期间别的应用可能抢走焦点；“点外面收起”会因此收起窗口，这里关掉，收起只靠显式的操作
    A.S.onboarding = true; A.S.senseIdle = false; A.S.outsideClose = false;
    document.querySelector('#onboarding')?.remove();
    let blurs = 0;
    await getCurrentWindow().onFocusChanged(({ payload }) => { if (!payload) results['window blur events'] = ++blurs; });

    // DSH 还在连接时窗口输入框按设计是禁用的，先等连接有结果
    const connecting = Date.now();
    while (A.dshState?.status === 'connecting' && Date.now() - connecting < 30_000) await new Promise(r => setTimeout(r, 200));
    results['dsh wait ms'] = Date.now() - connecting;

    const opening = '今天的待办可以慢慢清空，有需要随时吩咐。';
    A.bubble.show({ kind: 'speech', pri: 'low', text: opening });
    A.panel.open();
    await new Promise(r => setTimeout(r, 250));
    const chatInput = document.querySelector<HTMLTextAreaElement>('#input')!;
    results['chat focus diagnostics'] = { model: A.S.model, dsh: A.dshState?.status, disabled: chatInput.disabled, active: document.activeElement?.id || document.activeElement?.tagName, state: A.top.state() };
    assert('chat input obtains focus', document.activeElement === chatInput);
    assert('opening chat from a notification keeps its text in the conversation', A.chat.cur.messages[0]?.text === opening && A.chat.cur.messages[0]?.proactive === true);
    assert('proactive conversation metadata survives serialization', A.chat.serialize()[0]?.messages[0]?.proactive === true);
    A.chat.clearAll();
    A.panel.close();
    assert('closed panel is inert', document.querySelector<HTMLElement>('#panel')?.inert);

    const until = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 50));
      if (!predicate()) throw new Error('UI flow timeout');
    };

    await until(() => A.top.state() === 'hidden');
    const focusedBeforeHover = await getCurrentWindow().isFocused();
    // 真实鼠标的采样会不停报告“不在感应区”，模拟停留期间先把它们挡掉
    const realCursor = A.top.cursor;
    A.top.cursor = () => {};
    try {
      const stage = document.querySelector('#stage')!.getBoundingClientRect();
      for (let i = 0; i < 20; i++) { realCursor(stage.left + 500, stage.top + 2); await new Promise(r => setTimeout(r, 33)); }
      await until(() => A.top.state() === 'peek');
    } finally { A.top.cursor = realCursor; }
    assert('resting the cursor at the top center peeks without taking focus', !A.panel.isOpen() && await getCurrentWindow().isFocused() === focusedBeforeHover);

    const bar = document.querySelector<HTMLElement>('#tBar')!;
    let toggles = true;
    for (let i = 0; i < 6; i++) {
      if (A.summon.isOpen()) A.summon.close(); else bar.click();
      toggles &&= A.summon.isOpen() === (i % 2 === 0) && !A.panel.isOpen();
      await new Promise(r => setTimeout(r, 60));
    }
    assert('the peek bar summons KBOT and closing returns to the top edge', toggles && !A.summon.isOpen() && A.top.state() === 'hidden');
    A.panel.open();
    await new Promise(r => setTimeout(r, 300));
    assert('panel stays usable after rapid open and close', A.panel.isOpen() && !document.querySelector<HTMLElement>('#panel')?.inert && !document.querySelector<HTMLElement>('#panel')?.hidden);
    A.panel.close();
    await until(() => A.top.state() === 'hidden');

    const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
    const sInput = document.querySelector<HTMLInputElement>('#sInput')!, input = document.querySelector<HTMLTextAreaElement>('#input')!;
    const esc = () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    A.top.hotkey();
    await wait(700);
    results['summon window focused'] = await getCurrentWindow().isFocused();
    assert('the hotkey summons the agent, not the window', A.top.state() === 'summon' && !A.panel.isOpen() && document.activeElement === sInput && !document.querySelector<HTMLElement>('#summon')?.inert);
    assert('standby centers the lifeform and input over a full-screen native backdrop', (() => {
      const r = document.querySelector('#topContent')!.getBoundingClientRect();
      const glass = document.querySelector('#halo')!.getBoundingClientRect();
      return r.width === Math.min(1100, innerWidth - 48) && r.height === 540 && !document.querySelector('#sReply')!.textContent
        && glass.x === 0 && glass.y === 0 && glass.width === innerWidth && glass.height === innerHeight;
    })());
    A.top.hotkey();
    await until(() => A.top.state() === 'hidden');
    assert('pressing the hotkey again puts the agent away', !A.summon.isOpen() && !A.panel.isOpen());

    A.top.hotkey();
    await wait(250);
    sInput.value = '冒烟测试草稿';
    document.querySelector<HTMLButtonElement>('#sBtn')!.click();
    await wait(300);
    // 隔离环境里 DSH 可能没连上，窗口输入框是禁用的，拿不到焦点，但草稿仍要带过去
    assert('the summon window button opens the window and carries the unsent draft', A.panel.isOpen() && !A.summon.isOpen()
      && input.value === '冒烟测试草稿' && !sInput.value && (input.disabled || document.activeElement === input));
    A.top.hotkey();
    await until(() => A.top.state() === 'hidden');
    assert('the hotkey closes the window back to the top edge', !A.panel.isOpen());
    input.value = '';

    A.top.hotkey();
    await wait(250);
    esc();
    await until(() => A.top.state() === 'hidden');
    assert('Esc puts the summoned agent away', !A.summon.isOpen());
    A.panel.open();
    await wait(250);
    esc();
    await until(() => A.top.state() === 'hidden');
    assert('Esc closes the window', !A.panel.isOpen());
    await wait(900);
    results['window focused after closing'] = await getCurrentWindow().isFocused();

    A.top.startAct({ kind: 'talk', label: '冒烟测试', source: 'voice' });
    await until(() => A.top.state() === 'compact');
    bar.click();
    await wait(250);
    assert('clicking the resident bar summons the agent', A.summon.isOpen() && !A.panel.isOpen() && document.activeElement === sInput);
    A.summon.close();
    await until(() => A.top.state() === 'compact');
    assert('putting the agent away keeps the resident bar while something is going on', A.top.state() === 'compact');
    A.top.endAct('talk');
    A.top.startAct({ kind: 'think', label: '正在回复…', source: 'agent', surface: 'chat' });
    await until(() => A.top.state() === 'compact');
    bar.click();
    await wait(250);
    assert('a resident bar for a reply from the window goes back to the window', A.panel.isOpen() && !A.summon.isOpen());
    A.panel.close();
    A.top.endAct();
    await until(() => A.top.state() === 'hidden');

    A.top.startAct({ kind: 'talk', label: '冒烟测试' });
    await until(() => A.top.state() === 'compact');
    const rect = bar.getBoundingClientRect();
    const menuAt = () => bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + 10 }));
    menuAt();
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('勿扰 30 分钟'))!.click();
    assert('right-click DND menu item activates DND without toggling chat', A.isDnd() && !A.panel.isOpen());
    menuAt();
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('结束勿扰'))!.click();
    assert('right-click DND menu item can be switched off', !A.isDnd() && !A.panel.isOpen());

    let ready!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const unready = await listen('settings-smoke-ready', ready);
    menuAt();
    await until(() => A.menu.isOpen());
    Array.from(document.querySelectorAll<HTMLButtonElement>('#menu .mi')).find(b => b.textContent?.includes('设置…'))!.click();
    await Promise.race([readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('settings window boot timeout')), 10_000))]);
    unready();
    assert('right-click settings action opens settings without toggling chat', A.settingsVisible && !A.panel.isOpen());
    A.top.endAct('talk');
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
