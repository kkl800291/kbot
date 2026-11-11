export function onboarding(A: any) {
  if (A.S.onboarding) return;
  const { h } = A;
  const toggles: Record<string, HTMLInputElement> = {};
  const option = (key: string, title: string, desc: string, checked = true) => {
    const input = h('input', { type: 'checkbox', 'aria-label': title }); input.checked = checked; toggles[key] = input;
    return h('label', { class: 'welcome-option' }, [input, h('span', {}, [h('b', {}, title), h('small', {}, desc)])]);
  };
  let busy = false;
  const finish = async (openAgentSettings: boolean) => {
    if (busy) return; busy = true;
    for (const key of ['senseIdle', 'senseApp', 'senseWeather']) A.sput(key, toggles[key].checked);
    if (toggles.notifications.checked) await A.requestNotifications().catch(() => {});
    A.S.onboarding = true;
    try { await A.flush(); }
    catch { A.toast('无法保存设置，请检查磁盘空间'); busy = false; return; }
    overlay.remove(); A.emit('onboarded');
    if (openAgentSettings) A.openSettings('agent');
    else { A.releaseWindow(); A.say('你好呀，我是 KBOT，以后就在这里陪你啦。', { pri: 'mid', expr: 'happy' }); }
  };
  const overlay = h('div', { id: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'welcome-card' }, [
      h('div', { class: 'welcome-mark', 'aria-hidden': 'true' }, [h('i'), h('i')]),
      h('div', { class: 'welcome-eyebrow' }, '很高兴，住进你的桌面'),
      h('h1', { id: 'welcome-title' }, '你好，我是 KBOT。'),
      h('p', {}, '我是你的桌面分身，所有思考、记忆与定时行动都交由 DeepSeek Harness 驱动。点我就能聊。'),
      h('div', { class: 'welcome-options' }, [
        option('senseIdle', '知道你有没有离开', '只读取键鼠空闲时长，离开时我也休息。'),
        option('senseApp', '开会时保持安静', '只读取前台应用名称，不看窗口标题和屏幕内容。'),
        option('senseWeather', '感知所在城市天气', '使用你填写的城市，不获取设备定位。'),
        option('notifications', '隐藏后也能收到提醒', '允许 macOS 系统通知；也可以稍后开启。', false),
      ]),
      h('p', { class: 'welcome-privacy' }, '养成记忆默认保存在本机 ~/KBOT 目录，语音与感知发送范围可在设置中随时管理。'),
      h('div', { class: 'welcome-actions' }, [
        h('button', { class: 'btn secondary', onclick: () => finish(false) }, '先陪着我吧'),
        h('button', { class: 'btn primary', onclick: () => finish(true) }, '查看智能核心'),
      ]),
    ]));
  document.body.append(overlay);
  const focusable = () => Array.from(overlay.querySelectorAll('button, input')) as HTMLElement[];
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = focusable(), index = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && index <= 0) { e.preventDefault(); items.at(-1)!.focus(); }
    else if (!e.shiftKey && index === items.length - 1) { e.preventDefault(); items[0].focus(); }
  });
  focusable()[0].focus();
}
