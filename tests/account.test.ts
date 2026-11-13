import { describe, expect, it } from 'vitest';
import { accountDescription, balanceSummary, loginPending } from '../src/services/account';
import { normalizeDshError } from '../src/services/agent';

describe('DeepSeek account onboarding', () => {
  it('distinguishes a failed balance lookup from a confirmed empty account', () => {
    expect(balanceSummary({ status: 'failed' }).funded).toBeNull();
    expect(balanceSummary(null).funded).toBeNull();
    expect(balanceSummary({ status: 'ready', value: [{ currency: 'CNY', balance: '0E-16' }], bonusWallets: [] }).funded).toBe(false);
  });

  it('allows a positive bonus wallet even when recharge balance is zero', () => {
    const balance = { status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets: [{ currency: 'CNY', balance: '0.005' }] };
    expect(balanceSummary(balance).funded).toBe(true);
    expect(balanceSummary(balance).text).toContain('0.005');
  });

  it('keeps authorization waiting distinct from expired or failed attempts', () => {
    expect(loginPending({ attempt: { id: 'one', phase: 'waiting-browser' } })).toBe(true);
    expect(loginPending({ attempt: { id: 'one', phase: 'cancelled' } })).toBe(false);
    expect(accountDescription({ status: 'signed-out', attempt: { id: 'one', phase: 'expired' } })).toContain('过期');
    expect(accountDescription({ status: 'credential-stored', balance: { status: 'failed' } })).toContain('暂时无法查询');
  });

  it('sends account-specific errors to login or official top-up, keeping API key errors separate', () => {
    expect(normalizeDshError('ACCOUNT_SIGN_IN_REQUIRED').accountAction).toBe('sign-in');
    expect(normalizeDshError('ACCOUNT_TOKEN_INVALID').accountAction).toBe('sign-in');
    expect(normalizeDshError('ACCOUNT_QUOTA').accountAction).toBe('top-up');
    expect(normalizeDshError('No API key for provider route "deepseek-official"').needModelConfig).toBe(true);
    expect(normalizeDshError('A temporary network error').accountAction).toBeUndefined();
  });
});
