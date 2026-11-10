export function onboarding(A: any) {
  if (A.S.onboarding) return;
  const { h } = A;
  const toggles: Record<string, HTMLInputElement> = {};
  const option = (key: string, title: string, desc: string, checked = true) => {
    const input = h('input', { type: 'checkbox', 'aria-label': title }); input.checked = checked; toggles[key] = input;
    return h('label', { class: 'welcome-option' }, [input, h('span', {}, [h('b', {}, title), h('small', {}, desc)])]);
  };
  let busy = false;
  const finish = async (ai: boolean) => {
    if (busy) return; busy = true;
    for (const key of ['senseIdle', 'senseApp', 'senseWeather']) A.sput(key, toggles[key].checked);
    if (toggles.notifications.checked) await A.requestNotifications().catch(() => {});
    A.S.onboarding = true;
    try { await A.flush(); }
    catch { A.toast('无法保存设置，请检查磁盘空间'); busy = false; return; }
    overlay.remove(); A.emit('onboarded');
    if (ai) A.openSettings('ai');
    else { A.releaseWindow(); A.say('你好呀，我是 KBOT，以后就在这里陪你啦。', { pri: 'mid', expr: 'happy' }); }
  };
  const overlay = h('div', { id: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'welcome-card' }, [
      h('div', { class: 'welcome-mark', html: A.icon('robot', 28) }),
      h('div', { class: 'welcome-eyebrow' }, '很高兴，住进你的桌面'),
      h('h1', { id: 'welcome-title' }, '你好，我是 KBOT。'),
      h('p', {}, '我会安静陪着你，提醒你喝水、休息。你需要的时候，点我就能聊。'),
      h('div', { class: 'welcome-options' }, [
        option('senseIdle', '知道你有没有离开', '只读取键鼠空闲时长，离开时我也休息。'),
        option('senseApp', '开会时保持安静', '只读取前台应用名称，不看窗口标题和屏幕内容。'),
        option('senseWeather', '偶尔说说天气', '使用你填写的城市，不获取设备定位。'),
        option('notifications', '隐藏后也能收到提醒', '允许 macOS 系统通知；也可以稍后开启。', false),
      ]),
      h('p', { class: 'welcome-privacy' }, '记录保存在本机。聊天需自行配置模型，发送内容可在设置中管理。'),
      h('div', { class: 'welcome-actions' }, [
        h('button', { class: 'btn secondary', onclick: () => finish(false) }, '先陪着我吧'),
        h('button', { class: 'btn primary', onclick: () => finish(true) }, '配置聊天模型'),
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
