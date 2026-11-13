import { energyMark } from './ui/energy.js';
import { accountPanel } from './ui/account';
import { balanceSummary, loginPending } from './services/account';

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
    A.off('account:state', redraw); A.off('dsh:state', redraw);
    overlay.remove(); A.emit('onboarded');
    if (openAgentSettings) A.openSettings('agent');
    else { A.releaseWindow(); A.say('您好，我是 KBOT。从现在起，随时为您效劳。', { pri: 'mid', expr: 'happy' }); }
  };
  const accountSlot = h('div', { class: 'welcome-account' });
  const skip = h('button', { class: 'btn secondary', onclick: () => finish(false) }, '稍后登录');
  const primary = h('button', { class: 'btn primary', onclick: async () => {
    if (!A.native) return finish(false);
    if (!A.dshState?.connected) return A.agent.reconnect();
    if (A.accountState?.status === 'unsupported') return finish(true);
    if (A.dshState?.model) {
      if (A.dshState.provider === 'deepseek-account' && balanceSummary(A.accountState?.balance).funded === false) return A.account.openTopUp();
      return finish(false);
    }
    if (A.accountState?.status === 'credential-stored') { await A.account.refresh(); return A.agent.reconnect(); }
    return A.account.signIn();
  } }, '登录 DeepSeek');
  function redraw() {
    if (!overlay.isConnected) return;
    accountSlot.replaceChildren(accountPanel(A, false));
    const state = A.accountState;
    const pending = loginPending(state);
    const preparing = A.dshState?.status === 'connecting' || state?.status === 'loading';
    const ready = A.dshState?.connected && A.dshState?.model;
    const topUp = ready && A.dshState.provider === 'deepseek-account' && balanceSummary(state?.balance).funded === false;
    primary.textContent = !A.native ? '开始预览' : preparing ? '正在准备…' : pending ? '等待浏览器授权…'
      : !A.dshState?.connected ? '重新连接' : state?.status === 'unsupported' ? '打开连接设置'
      : topUp ? '充值额度' : ready ? '开始使用' : state?.status === 'credential-stored' ? '检查模型连接' : '登录 DeepSeek';
    primary.disabled = !!A.native && (preparing || pending || !!state?.busy);
    skip.textContent = ready ? '稍后设置' : '稍后登录';
    if (pending) accountSlot.append(h('button', { class: 'btn sm', onclick: () => A.account.cancelSignIn() }, '取消登录'));
  }
  const overlay = h('div', { id: 'onboarding', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'welcome-title' },
    h('div', { class: 'welcome-card' }, [
      h('div', { class: 'welcome-mark' }, energyMark(72, { palette: A.S.palette, tone: 'dark' })),
      h('div', { class: 'welcome-eyebrow' }, '很荣幸为您效劳'),
      h('h1', { id: 'welcome-title' }, '您好，我是 KBOT。'),
      h('p', {}, `我是您的 AI 管家。登录后就能聊天、记住您的偏好和设置提醒。需要我时，按 ${A.S.hotkey.label} 召唤即可。`),
      accountSlot,
      h('details', { class: 'welcome-preferences' }, [h('summary', {}, '陪伴设置（可选）'), h('div', { class: 'welcome-options' }, [
        option('senseIdle', '知道您是否离开', '只读取键鼠空闲时长，您离开时我不打扰。'),
        option('senseApp', '开会时保持安静', '只读取前台应用名称，不看窗口标题和屏幕内容。'),
        option('senseWeather', '感知所在城市天气', '使用您填写的城市，不获取设备定位。'),
        option('notifications', '隐藏后也能收到提醒', '允许 macOS 系统通知；也可以稍后开启。', false),
      ])]),
      h('p', { class: 'welcome-privacy' }, '养成记忆默认保存在本机 ~/KBOT 目录，语音与感知发送范围可在设置中随时管理。'),
      h('div', { class: 'welcome-actions' }, [
        skip, primary,
      ]),
      h('button', { class: 'welcome-advanced', onclick: () => finish(true) }, '已有 API Key？打开高级设置'),
    ]));
  document.body.append(overlay);
  A.on('account:state', redraw); A.on('dsh:state', redraw); redraw();
  const focusable = () => Array.from(overlay.querySelectorAll('button, input')) as HTMLElement[];
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const items = focusable(), index = items.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && index <= 0) { e.preventDefault(); items.at(-1)!.focus(); }
    else if (!e.shiftKey && index === items.length - 1) { e.preventDefault(); items[0].focus(); }
  });
  focusable()[0].focus();
}
