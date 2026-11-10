import { Channel, command } from './services/runtime';
import { dayKey } from './services/scheduler';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

// Runs only in an isolated development profile, never in a release build.
export async function settingsViewSmoke(A: any) {
  await listen<string>('settings-smoke-step', async ({ payload }) => {
    try {
      let diagnostics: any;
      if (payload === 'edit') {
        A.openSettings('persona');
        const input = document.querySelector<HTMLInputElement>('.sh-page input[type=text]')!;
        input.value = '窗口同步验证'; input.dispatchEvent(new Event('change', { bubbles: true }));
        await A.flushSettings();
        A.openSettings('remind');
        A.brain.addReminder({ when: '2026-12-10 15:00:00', repeat: '仅一次', content: '独立设置创建的提醒' });
        await A.flushSettings();
      } else if (payload === 'close-edit') {
        A.openSettings('persona');
        const input = document.querySelector<HTMLInputElement>('.sh-page input[type=text]')!;
        input.focus(); input.value = '关闭前尚未失焦';
        diagnostics = { focused: document.activeElement === input, connected: input.isConnected };
        // Model real typing without assuming that native window transitions
        // cause WebKit to dispatch a DOM blur or change event.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        A.closeSettings();
        await A.flushSettings();
        diagnostics.nickname = A.S.nickname;
      } else if (payload === 'models') {
        A.openSettings('ai');
        const started = Date.now();
        while (!document.querySelector('select[aria-label="对话模型"] option[value="responses"]') && Date.now() - started < 5000) await new Promise(r => setTimeout(r, 50));
        const select = document.querySelector<HTMLSelectElement>('select[aria-label="对话模型"]')!;
        if (!select?.querySelector('option[value="responses"]')) throw new Error('模型下拉列表未读取 API 返回的模型');
        select.value = 'responses'; select.dispatchEvent(new Event('change', { bubbles: true }));
        await A.flushSettings();
      }
      await emitTo('main', 'settings-smoke-result', { step: payload, diagnostics });
    } catch(error) { await emitTo('main', 'settings-smoke-result', { step: payload, error: String(error) }); }
  });
  await emitTo('main', 'settings-smoke-ready', true);
}

export async function nativeSmoke(A: any) {
  const results: Record<string, unknown> = {};
  const assert = (name: string, value: unknown) => { if (!value) throw new Error(name); results[name] = true; };
  try {
    const keys = await command('key_status');
    assert('isolated keychain starts empty', !keys.chat);
    await command('save_key', { slot: 'chat', key: 'local-protocol-fixture-only' });
    const savedKeys = await command('key_status');
    assert('keychain metadata reports saved slots without returning secrets', savedKeys.chat === true && savedKeys.vision === false && savedKeys.search === false && Object.keys(savedKeys).length === 3);
    const config = { base: 'http://127.0.0.1:19420/v1', model: 'fixture', provider: 'custom' };
    const messages = [{ role: 'user', content: '你好' }];
    const base = { slot: 'chat', config, messages, tools: [], web: false };
    const models = await command<string[]>('list_models', { slot: 'chat', config });
    assert('provider model list', models.includes('fixture') && models.includes('responses'));
    let text = '';
    let textDone!: () => void; const textFinished = new Promise<void>(r => { textDone = r; });
    const channel = new Channel<any>(); channel.onmessage = ev => { if (ev.type === 'delta') text += ev.text; else if (ev.type === 'done') textDone(); };
    await command('chat_stream', { ...base, id: 'smoke-text', onEvent: channel });
    await textFinished;
    assert('fragmented UTF-8 stream', text === '你好，流式连接正常。');
    let args = '', tool = '';
    let toolDone!: () => void; const toolFinished = new Promise<void>(r => { toolDone = r; });
    const toolChannel = new Channel<any>(); toolChannel.onmessage = ev => { if (ev.type === 'tool') { args += ev.arguments || ''; tool += ev.name || ''; } else if (ev.type === 'done') toolDone(); };
    await command('chat_stream', { ...base, id: 'smoke-tool', config: { ...config, model: 'tools' }, onEvent: toolChannel });
    await toolFinished;
    assert('fragmented tool call', tool === 'create_reminder' && JSON.parse(args).content === '协议验证');
    const slow = command('chat_stream', { ...base, id: 'smoke-stop', config: { ...config, model: 'slow' }, onEvent: new Channel() });
    setTimeout(() => command('cancel_chat', { id: 'smoke-stop' }), 150);
    try { await slow; throw new Error('取消请求未终止连接'); }
    catch (error) { assert('request cancellation', String(error).includes('已停止生成')); }
    try { await command('chat_stream', { ...base, id: 'smoke-401', config: { ...config, model: 'unauthorized' }, onEvent: new Channel() }); throw new Error('401 not handled'); }
    catch (error) { assert('provider authentication error', String(error).includes('API Key 无效')); }
    const state = { smoke: '本地存储验证', S: { onboarding: false } };
    await command('save_state', { data: state });
    assert('native persistence', (await command('load_state')).smoke === state.smoke);
    await command('save_state', { data: {} });

    A.S.ai.chat = { ...config, hasKey: true, tools: true };
    A.deriveModel(); A.panel.open();
    await new Promise(r => setTimeout(r, 250));
    assert('chat input obtains focus', document.activeElement === document.querySelector('#input'));
    A.chat.send('本机协议验证');
    const until = async (predicate: () => boolean) => {
      const start = Date.now();
      while (!predicate() && Date.now() - start < 5000) await new Promise(r => setTimeout(r, 50));
      if (!predicate()) throw new Error('UI flow timeout');
    };
    await until(() => !A.chat.generating);
    assert('full chat UI streaming flow', A.chat.cur.messages.at(-1).text === '你好，流式连接正常。');
    A.panel.close();
    const opening = '今天的待办可以慢慢清空，我的陪伴电量倒是挺足的。';
    A.bubble.show({ kind: 'speech', pri: 'low', text: opening });
    A.panel.open();
    assert('opening chat from the robot preserves its visible speech', A.chat.cur.messages[0]?.text === opening && A.chat.cur.messages[0]?.proactive === true);
    assert('proactive conversation metadata survives serialization', A.chat.serialize()[0]?.messages[0]?.proactive === true);
    A.S.ai.chat.model = 'companion-context';
    A.S.ai.search = { provider: 'none', protocol: 'auto', hasKey: false };
    A.deriveWeb(); A.chat.cur.webOn = true;
    A.chat.send('没有代办');
    await until(() => !A.chat.generating);
    const companionReply = A.chat.cur.messages.at(-1);
    assert('proactive reply preserves context without an unrelated lookup', companionReply.status === 'done' && companionReply.text === '那今天就先轻松一点，我陪你聊点别的。' && !companionReply.sources && !companionReply.steps);
    A.chat.clearAll();
    A.S.ai.chat = { ...config, provider: 'grok', model: 'response-tools', hasKey: true, tools: true };
    A.S.ai.search = { provider: 'builtin', protocol: 'auto', hasKey: false };
    A.deriveWeb(); A.chat.cur.webOn = true;
    A.chat.send('请联网搜索并整理提醒');
    await until(() => !A.chat.generating);
    const webReply = A.chat.cur.messages.at(-1);
    assert('hosted web search streams with citations', webReply.text === '联网协议验证正常。' && webReply.sources?.[0].url === 'https://example.com/native-search');
    assert('hosted search keeps reminder confirmation tools', webReply.card?.state === 'pending' && A.reminders.length === 0);
    assert('hosted citations render as clickable inline links', !!document.querySelector('.msg.assistant .md a[href="https://example.com/native-search"]'));
    A.S.ai.chat = { ...config, hasKey: true, tools: true };
    A.S.ai.search = { provider: 'none', protocol: 'auto', hasKey: false };
    A.chat.cur.webOn = false; A.deriveWeb();
    A.S.ai.chat.model = 'tools'; A.chat.send('请创建一个提醒');
    await until(() => !A.chat.generating);
    assert('tool proposal requires confirmation', A.chat.cur.messages.at(-1).card?.state === 'pending' && A.reminders.length === 0);
    Array.from(document.querySelectorAll<HTMLButtonElement>('[data-a="card"][data-do="save"]')).at(-1)!.click();
    assert('confirmed proposal is scheduled', A.reminders.length === 1 && A.reminders[0].content === '协议验证');
    A.brain.removeReminder(A.reminders[0].id);
    A.S.ai.chat.hasKey = false; A.deriveModel(); A.chat.clearAll();

    A.S.onboarding = true; A.S.senseIdle = false;
    document.querySelector('#onboarding')?.remove();
    let fired = false;
    A.sysNotify = () => { fired = true; };
    const future = new Date(Date.now() + 4000);
    A.brain.addReminder({ when: `${dayKey(future)} ${future.toTimeString().slice(0, 8)}`, repeat: '仅一次', content: '隐藏后仍调度' });
    A.setHidden(true);
    const start = Date.now();
    while (!fired && Date.now() - start < 12_000) await new Promise(r => setTimeout(r, 200));
    assert('reminder fires while native window hidden', fired);
    A.setHidden(false);
    A.panel.open();
    await new Promise(r => setTimeout(r, 250));
    assert('unconfigured model guide', document.querySelector('#messages')?.textContent?.includes('还没配置 AI 服务'));
    A.panel.close();
    assert('closed panel is inert', document.querySelector<HTMLElement>('#panel')?.inert);

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
    await until(() => !!document.querySelector('#quick.show'));
    assert('native cursor sampling reveals actions without a DOM hover or click', !A.panel.isOpen() && !!document.querySelector('#quick.show'));
    assert('quick-action hover does not activate the window', await getCurrentWindow().isFocused() === focusedBeforeHover);
    document.querySelector<HTMLButtonElement>('#quick [data-q="dnd"]')!.click();
    assert('hover DND action does not toggle chat', A.isDnd() && !A.panel.isOpen());
    document.querySelector<HTMLButtonElement>('#quick [data-q="dnd"]')!.click();
    assert('hover DND action can be switched off', !A.isDnd() && !A.panel.isOpen());

    let ready!: () => void;
    const readyPromise = new Promise<void>(resolve => { ready = resolve; });
    const unready = await listen('settings-smoke-ready', ready);
    A.updatePetHover(rect.x + rect.width / 2, rect.y + rect.height / 2);
    document.querySelector<HTMLButtonElement>('#quick [data-q="settings"]')!.click();
    await Promise.race([readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('settings window boot timeout')), 10_000))]);
    unready();
    assert('hover settings action opens settings without toggling chat', A.settingsVisible && !A.panel.isOpen());
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
    assert('settings edits sync to main owner', A.S.nickname === '窗口同步验证' && A.reminders.some((r: any) => r.content === '独立设置创建的提醒'));
    A.S.ai.chat = { ...config, hasKey: true }; A.deriveModel(); A.save();
    await A.openSettings('ai');
    await new Promise(r => setTimeout(r, 150));
    await runSettings('models');
    assert('model dropdown selection syncs to chat configuration', A.S.ai.chat.model === 'responses');
    const unchanged = (s: any) => s.mainVisible && !s.mainMinimized && !s.mainFullscreen;
    let controls = await command('settings_window_action', { action: 'minimize' });
    assert('settings minimizes without minimizing companion', controls.minimized && unchanged(controls));
    await command('settings_window_action', { action: 'restore' });
    await command('settings_window_action', { action: 'fullscreen' });
    await new Promise(r => setTimeout(r, 1200));
    controls = await command('settings_window_action', { action: 'state' });
    assert('settings enters fullscreen independently', controls.fullscreen && unchanged(controls));
    await command('settings_window_action', { action: 'fullscreen' });
    await new Promise(r => setTimeout(r, 1200));
    await runSettings('close-edit');
    controls = await command('settings_window_action', { action: 'state' });
    const closingStarted = Date.now();
    while (controls.visible && Date.now() - closingStarted < 2000) {
      await new Promise(r => setTimeout(r, 50));
      controls = await command('settings_window_action', { action: 'state' });
    }
    results['settings close snapshot'] = { ...controls, nickname: A.S.nickname };
    assert('settings close saves focused field and leaves companion running', !controls.visible && unchanged(controls) && A.S.nickname === '关闭前尚未失焦');
    await A.openSettings('persona');
    await new Promise(r => setTimeout(r, 300));
    controls = await command('settings_window_action', { action: 'state' });
    assert('settings can be restored after closing', controls.visible && !controls.minimized && !controls.fullscreen);
    await command('settings_window_action', { action: 'close' });
    await command('delete_key', { slot: 'chat' });
    await command('delete_key', { slot: 'chat' });
    assert('keychain metadata clears after idempotent deletion', (await command('key_status')).chat === false);
  } catch (error) { results.error = String(error); }
  finally {
    await command('delete_key', { slot: 'chat' }).catch(() => {});
    // Do not leave developer reminders or settings in the development profile.
    A.save = () => {};
    await A.flush().catch(() => {});
    await command('save_state', { data: {} });
    await command('debug_smoke_report', { report: results });
    await command('quit_app');
  }
}
