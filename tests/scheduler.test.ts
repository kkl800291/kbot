import { describe, it, expect } from 'vitest';
import { ActivityClock, SpeechBudget, nextOccurrence, resolveAt, validateReminder } from '../src/services/scheduler';
import { birthdayMatches, isWorkday } from '../src/services/calendar';

const at = (s: string) => +new Date(s);
describe('local reminder scheduling', () => {
  it('does not re-fire a repeat at the same instant', () => {
    expect(nextOccurrence({ when: '每天 09:30', repeat: '每天' }, at('2026-11-10T09:30:00'))).toBe(at('2026-11-11T09:30:00'));
  });
  it('uses the last day of short months for monthly reminders', () => {
    expect(nextOccurrence({ when: '每月31号 15:00', repeat: '每月31号' }, at('2027-02-01T00:00:00'))).toBe(at('2027-02-28T15:00:00'));
    expect(nextOccurrence({ when: '每月31号 15:00', repeat: '每月31号' }, at('2028-02-01T00:00:00'))).toBe(at('2028-02-29T15:00:00'));
  });
  it('supports the current day of week and rolls into next week', () => {
    const r = { when: '每周三 15:00', repeat: '每周三' };
    expect(nextOccurrence(r, at('2026-11-11T14:59:00'))).toBe(at('2026-11-11T15:00:00'));
    expect(nextOccurrence(r, at('2026-11-11T15:00:01'))).toBe(at('2026-11-18T15:00:00'));
  });
  it('respects a supplied holiday and makeup-workday calendar', () => {
    const workday = (d: Date) => d.getDate() === 14;
    expect(nextOccurrence({ when: '工作日 09:00', repeat: '每个工作日' }, at('2026-11-10T00:00:00'), workday)).toBe(at('2026-11-14T09:00:00'));
  });
  it('keeps absolute years and seconds on confirmed reminders', () => {
    expect(resolveAt('2027-01-01 00:00:20', at('2026-12-31T23:59:00'))).toBe(at('2027-01-01T00:00:20'));
  });
  it('rejects invalid dates, hours and impossible repeat rules', () => {
    expect(resolveAt('2026-02-30 09:00', Date.now())).toBeNull();
    expect(resolveAt('明天 25:00', Date.now())).toBeNull();
    expect(nextOccurrence({ when: '每天 99:00', repeat: '每天' }, Date.now())).toBeNull();
    expect(nextOccurrence({ when: '每月0号 09:00', repeat: '每月0号' }, Date.now())).toBeNull();
    expect(() => validateReminder({ content: '打电话', repeat: '仅一次', when: '2020-01-01 09:00' }, Date.now())).toThrow();
  });
});

describe('actual computer activity', () => {
  it('does not count idle or sleep as work', () => {
    const clock = new ActivityClock();
    clock.update(2, 0, 5, false);
    clock.update(2, 90, 5, false);
    clock.update(7200, 0, 5, false);
    expect(clock.workSeconds).toBe(2);
    expect(clock.waterSeconds).toBe(2);
  });
  it('resets work after an adequate break without resetting water reminders', () => {
    const clock = new ActivityClock();
    clock.update(5, 0, 5, false);
    clock.update(2, 300, 5, false);
    expect(clock.workSeconds).toBe(0);
    expect(clock.waterSeconds).toBe(5);
  });
  it('continues activity tracking without adding work during explicit rest', () => {
    const clock = new ActivityClock(); clock.update(5, 0, 5, true);
    expect(clock.workSeconds).toBe(0); expect(clock.waterSeconds).toBe(5);
  });
  it('reports finished work minutes when an absence reaches the rest threshold', () => {
    const clock = new ActivityClock();
    clock.update(50, 0, 5, false);
    expect(clock.update(1, 300, 5, false)).toBe(0);
    expect(clock.workSeconds).toBe(0);
    for (let i = 0; i < 125; i++) clock.update(1, 0, 5, false);
    expect(clock.update(1, 300, 5, false)).toBe(2);
    expect(clock.update(1, 400, 5, false)).toBe(0);
    for (let i = 0; i < 30; i++) clock.update(1, 0, 5, false);
    expect(clock.update(11, 0, 5, false)).toBe(0);
    expect(clock.workSeconds).toBe(30);
  });
});

describe('companion speech budget', () => {
  it('exempts explicit reminders but separates other speech by five minutes', () => {
    const b = new SpeechBudget(), now = at('2026-11-10T09:30:00');
    b.record(now, 'mid', false);
    expect(b.allows(now + 299_999, 'mid', false, 'normal')).toBe(false);
    expect(b.allows(now + 300_000, 'mid', false, 'normal')).toBe(true);
    expect(b.allows(now + 1, 'high', false, 'normal')).toBe(true);
  });
  it('keeps companionship and reminder budgets separate over a rolling hour', () => {
    const b = new SpeechBudget(), now = at('2026-11-10T09:30:00');
    b.record(now, 'low', true);
    expect(b.allows(now + 240_000, 'low', true, 'normal')).toBe(true);
    for (let i = 1; i <= 4; i++) b.record(now + i * 300_000, 'mid', false);
    expect(b.allows(now + 1800_000, 'mid', false, 'normal')).toBe(false);
    expect(b.allows(now + 4_500_000, 'mid', false, 'normal')).toBe(true);
  });
  it('gets quieter when bubbles are ignored', () => {
    const b = new SpeechBudget(), now = at('2026-11-10T09:30:00'); b.ignored = 3;
    b.record(now, 'low', true);
    expect(b.allows(now + 180_000, 'low', true, 'normal')).toBe(false);
    expect(b.allows(now + 240_000, 'low', true, 'normal')).toBe(true);
    expect(b.allows(now + 60_000, 'mid', false, 'normal')).toBe(true);
  });
});

describe('offline calendar', () => {
  it('recognizes solar and lunar birthdays', () => {
    expect(birthdayMatches({ cal: 'solar', m: 11, d: 10 }, new Date('2026-11-10T12:00:00'))).toBe(true);
    expect(birthdayMatches({ cal: 'lunar', m: 1, d: 1 }, new Date('2026-02-17T12:00:00'))).toBe(true);
  });
  it('uses the built-in holiday table rather than treating Spring Festival as work', () => {
    expect(isWorkday(new Date('2026-02-17T12:00:00'), true)).toBe(false);
    expect(isWorkday(new Date('2026-11-10T12:00:00'), true)).toBe(true);
  });
});
