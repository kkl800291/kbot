import { describe, expect, it } from 'vitest';
import { applySettingsChanges, diffSettings, type SettingsChange, type SettingsSnapshot } from '../src/services/settings-patch';

const snapshot = (): SettingsSnapshot => ({
  S: {
    theme: 'dark', nickname: '你', screenPerm: false,
    model: 'text', webAvailable: false, onboarding: true, pos: { x: 10, y: 20 }, panelW: 360, panelH: 480, expanded: false,
    params: { waterEvery: 45, eyeEvery: 20 }, apps: { dev: ['Xcode'], meeting: ['Zoom'] },
    ai: { chat: { model: 'deepseek-chat', visionSupported: false }, calls: { day: '2026-11-10', n: 3 } },
    dsh: { mode: 'auto', workspace: '~/KBOT', binary: '', desktopPatch: false },
    updater: { autoCheck: true, endpoint: '', skippedVersion: '' },
    voice: { enabled: false, autoReply: false, autoProactive: true, provider: 'mimo', base: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.5-tts', mimoVoice: '冰糖', style: '', hasKey: false, sayVoice: '', rate: 190 },
  },
  builtin: { water: true, rest: true },
  birthdays: [{ id: 'a', name: '妈妈', m: 2, d: 3 }],
  reminders: [{ id: 'r1', fired: false }],
  conversations: [{ id: 'c1', messages: [] }],
});

describe('settings window state patches', () => {
  it('merges user changes without overwriting concurrent main-window activity', () => {
    const initial = snapshot(), edited = snapshot(), current = snapshot();
    edited.S.nickname = '老大'; edited.S.params.waterEvery = 60;
    current.S.ai.calls.n = 4; current.S.params.eyeEvery = 30;
    current.reminders[0].fired = true; current.conversations[0].messages.push({ text: '刚收到的回复' });
    const result = applySettingsChanges(current, diffSettings(initial, edited));
    expect(result.S.nickname).toBe('老大');
    expect(result.S.params).toEqual({ waterEvery: 60, eyeEvery: 30 });
    expect(result.S.ai.calls.n).toBe(4);
    expect(result.reminders[0].fired).toBe(true);
    expect(result.conversations[0].messages).toHaveLength(1);
    expect(current.S.nickname).toBe('你');
  });

  it('syncs DSH and MiMo voice settings at field granularity', () => {
    const before = snapshot(), after = snapshot(), current = snapshot();
    after.S.dsh.mode = 'managed';
    after.S.dsh.workspace = '~/MyKBOT';
    after.S.voice.enabled = true;
    after.S.voice.mimoVoice = '小团子';
    after.S.updater.endpoint = 'https://schathub.xyz/kbot/releases/latest.json';
    current.S.voice.hasKey = true; // updated concurrently in main window
    current.S.updater.skippedVersion = '0.1.7';
    const changes = diffSettings(before, after);
    const result = applySettingsChanges(current, changes);
    expect(result.S.dsh).toEqual({ mode: 'managed', workspace: '~/MyKBOT', binary: '', desktopPatch: false });
    expect(result.S.voice.enabled).toBe(true);
    expect(result.S.voice.mimoVoice).toBe('小团子');
    expect(result.S.voice.hasKey).toBe(true);
    expect(result.S.updater).toEqual({ autoCheck: true, endpoint: 'https://schathub.xyz/kbot/releases/latest.json', skippedVersion: '0.1.7' });
  });

  it('syncs the companion rewrite switch without treating it as derived state', () => {
    const before = snapshot(), after = snapshot();
    before.S.aiCompanion = false;
    after.S.aiCompanion = true;
    const changes = diffSettings(before, after);
    expect(changes).toEqual([{ kind: 'field', path: ['S', 'aiCompanion'], before: { exists: true, value: false }, after: { exists: true, value: true } }]);
    expect(applySettingsChanges(before, changes).S.aiCompanion).toBe(true);
  });

  it('filters runtime and derived state from old settings snapshots', () => {
    const before = snapshot(), after = snapshot();
    Object.assign(after.S, { model: 'none', webAvailable: true, onboarding: false, pos: null, panelW: 600, panelH: 700, expanded: true });
    after.S.ai.calls.n = 0;
    expect(diffSettings(before, after)).toEqual([]);
    const malicious: SettingsChange = { kind: 'field', path: ['S', 'ai'], before: { exists: true, value: before.S.ai }, after: { exists: true, value: after.S.ai } };
    expect(() => applySettingsChanges(before, [malicious])).toThrow(/不可修改/);
    const replaceDsh: SettingsChange = { kind: 'field', path: ['S', 'dsh'], before: { exists: true, value: before.S.dsh }, after: { exists: true, value: 'bad' } };
    expect(() => applySettingsChanges(before, [replaceDsh])).toThrow(/不可修改/);
  });

  it('transports optional-property deletion through JSON and supports idempotent retries', () => {
    const before = snapshot(), after = snapshot(); delete after.S.ai.chat.visionSupported;
    after.S.screenPerm = true;
    const changes = JSON.parse(JSON.stringify(diffSettings(before, after)));
    const result = applySettingsChanges(before, changes);
    expect(Object.hasOwn(result.S.ai.chat, 'visionSupported')).toBe(false);
    expect(result.S.screenPerm).toBe(true);
    expect(applySettingsChanges(result, changes)).toEqual(result);
  });

  it('merges birthday additions and deletions by id, retaining new main-window birthdays', () => {
    const before = snapshot(), after = snapshot(), current = snapshot();
    after.birthdays = [{ id: 'b', name: '朋友', m: 4, d: 5 }];
    current.birthdays.push({ id: 'from-main', name: '家人', m: 6, d: 7 });
    const result = applySettingsChanges(current, diffSettings(before, after));
    expect(result.birthdays.map(b => b.id)).toEqual(['from-main', 'b']);
    expect(current.birthdays.map(b => b.id)).toEqual(['a', 'from-main']);
  });

  it('rejects same-field and birthday conflicts without partially mutating the input', () => {
    const before = snapshot(), after = snapshot(), current = snapshot();
    after.S.theme = 'light'; after.S.nickname = '老大'; current.S.nickname = '同事';
    const unchanged = structuredClone(current);
    expect(() => applySettingsChanges(current, diffSettings(before, after))).toThrow(/另一个窗口更新/);
    expect(current).toEqual(unchanged);
    after.S.nickname = '你'; after.birthdays[0].name = '母亲'; current.birthdays[0].name = '妈妈的新称呼';
    expect(() => applySettingsChanges(current, diffSettings(before, after))).toThrow(/生日已/);
    expect(current.S.theme).toBe('dark');
  });

  it('treats application-category arrays as user-edited leaves, retaining other categories', () => {
    const before = snapshot(), after = snapshot(), current = snapshot();
    after.S.apps.dev.push('Terminal'); current.S.apps.meeting.push('腾讯会议'); after.builtin.water = false;
    const result = applySettingsChanges(current, diffSettings(before, after));
    expect(result.S.apps.dev).toEqual(['Xcode', 'Terminal']);
    expect(result.S.apps.meeting).toEqual(['Zoom', '腾讯会议']);
    expect(result.builtin.water).toBe(false);
  });

  it('rejects prototype-pollution paths and payload keys', () => {
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const change: SettingsChange = { kind: 'field', path: ['S', 'ai', 'chat', key], before: { exists: false }, after: { exists: true, value: { polluted: true } } };
      expect(() => applySettingsChanges(snapshot(), [change])).toThrow();
    }
    const before = snapshot(), after = snapshot();
    after.S.apps.dev = JSON.parse('[{"__proto__":{"polluted":true}}]');
    expect(() => diffSettings(before, after)).toThrow(/无效/);
    expect(({} as any).polluted).toBeUndefined();
  });
});
