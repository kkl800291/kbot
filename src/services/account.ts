import { command, listen, native } from './runtime';

export interface AccountState {
  status: 'loading' | 'signed-out' | 'credential-stored' | 'unsupported' | 'unavailable';
  attempt: { id: string; phase: string; errorCode?: string } | null;
  profile: any;
  balance: any;
  busy: boolean;
  checking: boolean;
  error: string | null;
}

export const loginPending = (state?: Partial<AccountState>) =>
  ['initializing', 'waiting-browser', 'exchanging', 'committing'].includes(state?.attempt?.phase || '');

export function balanceSummary(balance: any): { text: string; funded: boolean | null } {
  if (!balance || balance.status !== 'ready') return { text: '额度暂时无法查询，可前往官方平台查看', funded: null };
  const wallets = [...(balance.value || []), ...(balance.bonusWallets || [])];
  const usable = wallets.filter(wallet => ['CNY', 'USD'].includes(wallet.currency) && Number.isFinite(Number(wallet.balance)));
  if (!usable.length) return { text: '暂无可用额度', funded: false };
  return {
    text: usable.map(wallet => `${wallet.currency === 'CNY' ? '¥' : '$'}${Number(wallet.balance).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`).join(' ＋ '),
    funded: usable.some(wallet => Number(wallet.balance) > 0),
  };
}

export function accountDescription(state?: Partial<AccountState>): string {
  if (!state || state.status === 'loading') return '正在准备智能核心…';
  if (state.error) return state.error;
  if (loginPending(state)) return state.attempt?.phase === 'waiting-browser'
    ? '请在浏览器完成 DeepSeek 官方授权，完成后会自动连接。'
    : '正在处理官方授权，请稍候…';
  if (state.status === 'credential-stored') return state.checking ? '已登录，正在检查账号额度…' : `账号额度：${balanceSummary(state.balance).text}`;
  if (state.status === 'unsupported') return '当前外部核心不支持账号登录，可切换为 KBOT 内置核心。';
  if (state.status === 'unavailable') return '智能核心尚未就绪，请重新连接。';
  if (state.attempt?.phase === 'expired') return '登录链接已过期，请重新登录。';
  if (state.attempt?.phase === 'failed') return '官方授权未完成，请检查网络后重试。';
  return '使用 DeepSeek 账号登录，无需另外安装软件或填写 API Key。模型使用消耗您账号的额度。';
}

export function installAccount(A: any) {
  const state: AccountState = {
    status: native ? 'loading' : 'unavailable', attempt: null, profile: null, balance: null,
    busy: false, checking: false, error: null,
  };
  A.accountState = state;
  const publish = () => A.emit('account:state', { ...state });
  const metadata = () => ({ locale: navigator.language || 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
  let refreshJob: Promise<void> | null = null;
  let loginJob: Promise<void> | null = null;
  let connectionKey = '';
  let loginGeneration = 0;

  function accept(raw: any) {
    if (!raw) return;
    const previous = state.status;
    state.status = raw.supported === false ? 'unsupported' : raw.status || 'unavailable';
    state.attempt = raw.attempt || null;
    if (state.status !== 'credential-stored') {
      state.profile = state.balance = null;
    } else {
      if ('profile' in raw) state.profile = raw.profile;
      if ('balance' in raw) state.balance = raw.balance;
    }
    publish();
    return previous !== state.status;
  }

  async function call(action: string, body = {}) {
    return command<any>('dsh_account_action', { action, body: { ...metadata(), ...body } });
  }

  async function refresh(details = true): Promise<void> {
    if (!native || !A.dshState?.connected) return;
    if (refreshJob) return refreshJob;
    refreshJob = (async () => {
      state.checking = details; publish();
      try {
        const response = await call(details ? 'details' : 'state');
        state.error = null;
        accept(response.account);
      } catch (error) {
        state.error = '账号状态暂时无法查询，请检查网络后重试。';
        if (state.status === 'loading') state.status = 'unavailable';
      } finally {
        state.checking = false; refreshJob = null; publish();
      }
    })();
    return refreshJob;
  }

  async function activateAccountModel() {
    const catalog = await A.agent.listModels();
    const account = catalog.providers.find((provider: any) => provider.id === 'deepseek-account');
    const model = account?.models?.find((model: any) => model.id === 'deepseek-flash') || account?.models?.[0];
    if (model) await A.agent.selectModel(account.id, model.id);
    else state.error = '账号暂未提供可用模型，请检查账号资格或在高级设置中配置其他模型。';
    publish();
  }

  A.account = {
    refresh,
    signIn: () => {
      if (loginJob) return loginJob;
      const generation = ++loginGeneration;
      loginJob = (async () => {
        state.busy = true; state.error = null; publish();
        try {
          if (!A.dshState?.connected && !await A.agent.reconnect()) throw new Error('智能核心未就绪，请重新连接后再登录。');
          for (let attempt = 0; attempt < 5 && generation === loginGeneration; attempt++) {
            const response = await call('sign-in');
            if (generation !== loginGeneration) return;
            accept(response.account);
            if (response.account?.supported === false) throw new Error('当前核心不支持账号登录，请切换为内置核心。');
            if (response.opened || state.status === 'credential-stored') return;
            if (['failed', 'expired', 'cancelled'].includes(state.attempt?.phase || '')) throw new Error('官方授权未完成，请检查网络后重新登录。');
          }
          if (generation === loginGeneration) throw new Error('官方登录服务响应较慢，请稍后重试。');
        } catch (error) {
          state.error = error instanceof Error ? error.message : String(error);
        } finally {
          state.busy = false; loginJob = null; publish();
        }
      })();
      return loginJob;
    },
    cancelSignIn: async () => {
      loginGeneration++;
      const id = state.attempt?.id;
      if (!id) return;
      try { accept((await call('cancel', { attemptId: id })).account); }
      catch { state.error = '取消登录失败，请重试。'; }
      publish();
    },
    openTopUp: async () => {
      try { await call('top-up'); }
      catch { state.error = '无法打开官方充值页面，请稍后重试。'; publish(); }
    },
    openUsage: async () => {
      try { await call('usage'); }
      catch { state.error = '无法打开官方用量页面，请稍后重试。'; publish(); }
    },
    signOut: async () => {
      loginGeneration++;
      try {
        accept((await call('sign-out')).account);
        state.error = null;
        await A.agent.reconnect();
      } catch { state.error = '退出登录失败，请重试。'; }
      publish();
    },
  };

  A.on('dsh:state', (runtime: any) => {
    const key = runtime.connected ? `${runtime.pid}:${runtime.port}` : '';
    if (key && key !== connectionKey) { connectionKey = key; void refresh(); }
    else if (!key) {
      connectionKey = '';
      state.status = runtime.status === 'connecting' ? 'loading' : 'unavailable';
      state.attempt = null; state.profile = state.balance = null; publish();
    }
  });
  A.init(async () => {
    if (!native) return;
    await listen<any>('dsh-event', ({ payload }) => {
      if (payload.type !== 'account/state') return;
      const wasSignedIn = state.status === 'credential-stored';
      const changed = accept(payload.account);
      if (changed && state.status === 'credential-stored') {
        state.error = null;
        void refresh().then(activateAccountModel).catch(() => { state.error = '账号已登录，模型连接失败，请重试。'; publish(); });
      } else if (changed && wasSignedIn) {
        void A.agent.reconnect();
      }
    });
    window.addEventListener('focus', () => {
      if (A.dshState?.connected) void refresh();
    });
  });
}
