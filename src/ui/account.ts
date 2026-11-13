import { accountDescription, balanceSummary, loginPending } from '../services/account';

export function accountPanel(A: any, controls = true) {
  const state = A.accountState;
  const signedIn = state?.status === 'credential-stored';
  const name = state?.profile?.status === 'ready' ? state.profile.value?.name || state.profile.value?.contact : null;
  const h = A.h;
  const description = h('div', { class: 'account-description', role: 'status', 'aria-live': 'polite' }, accountDescription(state));
  const content = [
    h('div', { class: 'account-heading' }, signedIn ? name || '已登录 DeepSeek' : '连接 DeepSeek 账号'),
    description,
  ];
  const button = (label: string, action: () => any, primary = false) => h('button', {
    class: `btn sm${primary ? ' primary' : ''}`, type: 'button', onclick: action,
    disabled: label !== '取消登录' && !!state?.busy,
  }, label);
  if (controls) {
    const actions = [];
    if (signedIn) {
      actions.push(button('充值额度', () => A.account.openTopUp(), balanceSummary(state.balance).funded === false));
      actions.push(button('用量详情', () => A.account.openUsage()));
      actions.push(button('刷新', () => A.account.refresh()));
      actions.push(button('退出登录', () => A.account.signOut()));
    } else if (state?.status === 'unsupported') {
      actions.push(button('使用内置核心', () => { A.S.dsh.mode = 'managed'; A.S.dsh.binary = ''; A.save(); A.agent.restart(); }, true));
    } else if (state?.status !== 'loading') {
      actions.push(button(loginPending(state) ? '重新打开授权页' : '登录 DeepSeek', () => A.account.signIn(), true));
    }
    if (loginPending(state)) actions.push(button('取消登录', () => A.account.cancelSignIn()));
    if (actions.length) content.push(h('div', { class: 'account-actions' }, actions));
  }
  return h('div', { class: `account-card${state?.error ? ' has-error' : ''}` }, content);
}
