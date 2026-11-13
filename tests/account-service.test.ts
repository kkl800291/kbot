import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ command: vi.fn(), listener: null as any }));
vi.mock('../src/services/runtime', () => ({
  native: true,
  command: mocks.command,
  listen: vi.fn(async (_name, handler) => { mocks.listener = handler; return () => {}; }),
}));
import { installAccount } from '../src/services/account';

const signedOut = { supported: true, status: 'signed-out', attempt: null };
const signedIn = { supported: true, status: 'credential-stored', attempt: { id: 'login-1', phase: 'succeeded' } };

async function app() {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('navigator', { language: 'zh-CN' });
  const events = new Map<string, Function[]>();
  const initializers: Function[] = [];
  const A: any = {
    dshState: { connected: true, pid: 1, port: 2 },
    agent: {
      reconnect: vi.fn(async () => true),
      listModels: vi.fn(async () => ({ providers: [{ id: 'deepseek-account', models: [{ id: 'deepseek-flash' }] }] })),
      selectModel: vi.fn(async () => {}),
    },
    on: (name: string, handler: Function) => events.set(name, [...(events.get(name) || []), handler]),
    emit: (name: string, payload: any) => events.get(name)?.forEach(handler => handler(payload)),
    init: (handler: Function) => initializers.push(handler),
  };
  installAccount(A);
  await Promise.all(initializers.map(handler => handler()));
  return A;
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('account lifecycle', () => {
  it('selects an account model after official authorization and refreshes wallet details', async () => {
    mocks.command.mockImplementation(async (_name, { action }) => ({ account: action === 'details' ? { ...signedIn, balance: { status: 'ready', value: [{ currency: 'CNY', balance: '5' }] } } : signedIn }));
    const A = await app();
    mocks.listener({ payload: { type: 'account/state', account: signedIn } });
    await vi.waitFor(() => expect(A.agent.selectModel).toHaveBeenCalledWith('deepseek-account', 'deepseek-flash'));
    expect(A.accountState.balance.value[0].balance).toBe('5');
    expect(A.accountState.error).toBeNull();
  });

  it('ignores a delayed sign-in response after the user cancels that attempt', async () => {
    let finishSignIn!: (result: any) => void;
    mocks.command.mockImplementation(async (_name, { action }) => {
      if (action === 'sign-in') return new Promise(resolve => { finishSignIn = resolve; });
      return { account: { ...signedOut, attempt: { id: 'login-1', phase: 'cancelled' } } };
    });
    const A = await app();
    const login = A.account.signIn();
    mocks.listener({ payload: { type: 'account/state', account: { ...signedOut, attempt: { id: 'login-1', phase: 'waiting-browser' } } } });
    await A.account.cancelSignIn();
    finishSignIn({ opened: true, account: { ...signedOut, attempt: { id: 'login-1', phase: 'waiting-browser' } } });
    await login;
    expect(A.accountState.attempt.phase).toBe('cancelled');
    expect(A.accountState.busy).toBe(false);
  });

  it('clears account details on sign-out while reconnecting the model selection', async () => {
    mocks.command.mockResolvedValue({ account: signedOut });
    const A = await app();
    A.accountState.status = 'credential-stored';
    A.accountState.profile = { status: 'ready', value: { name: '旧账号' } };
    A.accountState.balance = { status: 'ready', value: [{ currency: 'CNY', balance: '5' }] };
    await A.account.signOut();
    expect(A.accountState.status).toBe('signed-out');
    expect(A.accountState.profile).toBeNull();
    expect(A.accountState.balance).toBeNull();
    expect(A.agent.reconnect).toHaveBeenCalled();
  });
});
