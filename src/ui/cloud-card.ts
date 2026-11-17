import { cloudSummary } from '../services/cloud';

export function cloudAccountCard(A: any, options: {
  modeKey?: 'llmMode' | 'voiceMode';
  compact?: boolean;
  onModeChange?: () => void;
} = {}) {
  const { h } = A;
  const st = A.cloudState || {};
  const hasEndpoint = Boolean(st.endpoint);
  const credits = Number(st.credits || 0);
  const modeKey = options.modeKey;
  const currentMode = modeKey ? (A.S?.cloud?.[modeKey] || 'managed') : 'managed';

  let badgeText = '未启用';
  let badgeCls = 'sx-status';
  if (!hasEndpoint) {
    badgeText = '未配置网关';
  } else if (st.status === 'connecting') {
    badgeText = '连接中…';
  } else if (st.status === 'exhausted' || (st.hasSession && credits <= 0)) {
    badgeText = '额度已用完';
    badgeCls = 'sx-status bad';
  } else if (st.hasSession) {
    badgeText = `剩余 ${credits} 点`;
    badgeCls = 'sx-status ok';
  }

  const heading = h('div', {
    class: 'account-heading',
    style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap',
  }, [
    h('span', {}, st.signedIn ? `KBOT 云托管 · ${st.account}` : 'KBOT 官方托管额度'),
    h('span', { class: badgeCls }, badgeText),
  ]);

  const desc = h('div', { class: 'account-description', role: 'status', 'aria-live': 'polite' }, cloudSummary(st));
  const nodes: any[] = [heading, desc];

  if (modeKey && !options.compact) {
    const modeRow = h('div', { style: 'display:flex;gap:6px;margin-top:12px;flex-wrap:wrap' }, [
      ['managed', '平台托管（默认额度）'],
      ['byok', '自带 API Key'],
    ].map(([val, label]) => h('button', {
      type: 'button',
      class: `btn sm${currentMode === val ? ' primary' : ''}`,
      disabled: !!st.busy || (val === 'managed' && !hasEndpoint),
      onclick: async () => {
        if (val === currentMode) return;
        if (modeKey === 'llmMode') await A.cloud?.setLlmMode?.(val);
        else await A.cloud?.setVoiceMode?.(val);
        options.onModeChange?.();
      },
    }, label)));
    nodes.push(modeRow);
  }

  if (hasEndpoint && !options.compact) {
    const actions = h('div', { class: 'account-actions' });
    const inlineSlot = h('div', { style: 'margin-top:10px;display:none' });

    const showInlineForm = (kind: 'login' | 'redeem') => {
      inlineSlot.style.display = 'flex';
      inlineSlot.style.gap = '6px';
      inlineSlot.style.flexWrap = 'wrap';
      if (kind === 'login') {
        const acctInput = h('input', { class: 'sx-in', placeholder: '邮箱或手机号', style: 'flex:1;min-width:140px' });
        const passInput = h('input', { class: 'sx-in', type: 'password', placeholder: '密码（新账号可选设置）', style: 'flex:1;min-width:130px' });
        const submit = h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: async () => {
            if (!acctInput.value.trim()) { A.toast('请先输入邮箱或手机号'); return; }
            submit.disabled = true;
            try {
              await A.cloud.login(acctInput.value.trim(), passInput.value);
              A.toast('已登录并同步账户点数');
            } catch (err: any) {
              A.toast(String(err?.message || err), 4500);
            } finally {
              submit.disabled = false;
            }
          },
        }, '确认登录');
        inlineSlot.replaceChildren(acctInput, passInput, submit);
        acctInput.focus();
      } else {
        const codeInput = h('input', { class: 'sx-in', placeholder: '输入充值兑换码（如 KBOT-XXXX）', style: 'flex:1;min-width:180px' });
        const submit = h('button', {
          type: 'button',
          class: 'btn sm primary',
          onclick: async () => {
            if (!codeInput.value.trim()) { A.toast('请输入充值兑换码'); return; }
            submit.disabled = true;
            try {
              const next = await A.cloud.redeem(codeInput.value.trim());
              A.toast(`兑换成功，当前可用 ${next.credits} 点`);
            } catch (err: any) {
              A.toast(String(err?.message || err), 4500);
            } finally {
              submit.disabled = false;
            }
          },
        }, '兑换点数');
        inlineSlot.replaceChildren(codeInput, submit);
        codeInput.focus();
      }
    };

    if (!st.hasSession) {
      actions.append(h('button', {
        type: 'button',
        class: 'btn sm primary',
        disabled: !!st.busy,
        onclick: () => A.cloud?.bootstrap?.(false).catch((e: any) => A.toast(String(e?.message || e), 4500)),
      }, '免费领取体验额度'));
    } else {
      actions.append(h('button', {
        type: 'button',
        class: `btn sm${credits <= 0 ? ' primary' : ''}`,
        disabled: !!st.busy,
        onclick: () => showInlineForm('redeem'),
      }, '充值 / 兑换点数'));
    }

    if (!st.signedIn) {
      actions.append(h('button', {
        type: 'button',
        class: 'btn sm',
        disabled: !!st.busy,
        onclick: () => showInlineForm('login'),
      }, '登录 / 绑定账号'));
    } else {
      actions.append(h('button', {
        type: 'button',
        class: 'btn sm',
        disabled: !!st.busy,
        onclick: () => A.cloud?.signOut?.(),
      }, '退出登录'));
    }

    if (st.hasSession) {
      actions.append(h('button', {
        type: 'button',
        class: 'btn sm',
        disabled: !!st.busy,
        onclick: () => A.cloud?.refresh?.(),
      }, '刷新'));
    }

    nodes.push(actions, inlineSlot);
  }

  return h('div', { class: `account-card${st.error || (st.hasSession && credits <= 0) ? ' has-error' : ''}` }, nodes);
}
