import { describe, expect, it } from 'vitest';
import {
  clearHabit,
  companionBias,
  driftSummary,
  emptyDrift,
  emptyHabits,
  extraDelay,
  fold,
  habitText,
  memoryAddon,
  preferLines,
  prune,
  sanitize,
  settingsView,
  stepDrift,
  type FoldInput,
  type JournalEntry,
} from '../src/services/habits';

const NOW = new Date(2026, 10, 10, 10, 0, 0).getTime();
let seq = 0;
const at = (dayOffset: number, hour = 12, minute = 0) => new Date(2026, 10, 10 + dayOffset, hour, minute, 0, 0).getTime();

function entry(partial: Omit<JournalEntry, 'id'> & { id?: string }): JournalEntry {
  return { id: partial.id || `j${++seq}`, ...partial };
}
const work = (t: number, minutes: number, end: 'rest' | 'away' = 'rest') => entry({ t, type: 'work', minutes, end });
const reminder = (t: number, action: 'accepted' | 'snoozed' | 'skipped' | 'muted' | 'ignored') => entry({ t, type: 'reminder', kind: 'water', action });
const companion = (t: number, action: 'opened' | 'expired') => entry({ t, type: 'companion', action });
const presence = (t: number, night: boolean) => entry({ t, type: 'presence', day: '2026-11-10', night, hour: new Date(t).getHours() });

function blank(journal: JournalEntry[] = [], foldedAt: number | null = null): FoldInput {
  return { habits: emptyHabits(), drift: emptyDrift(), journal, foldedAt };
}

describe('habit folding', () => {
  it('keeps four work stretches invisible and uses the median on the day the fifth arrives', () => {
    const first = fold(blank([10, 40, 20, 30].map(minutes => work(at(-2, 9), minutes))), at(-1, 8));
    expect(first.habits['work-stretch'].samples).toBe(4);
    expect(first.habits['work-stretch'].minutes).toBe(25);
    expect(habitText('work-stretch', first.habits, '23:30')).toBeNull();

    const formed = fold(blank([10, 50, 20, 40, 30].map(minutes => work(at(-2, 9), minutes))), at(-1, 8));
    expect(formed.habits['work-stretch']).toMatchObject({ minutes: 30, samples: 5 });
    expect(habitText('work-stretch', formed.habits, '23:30')).toBe('连续工作大约 30 分钟后会停一下');

    const next = fold({
      ...formed,
      journal: [...formed.journal, work(at(-1, 11), 10), work(at(-1, 16), 20)],
    }, NOW);
    expect(next.habits['work-stretch'].samples).toBe(7);
    expect(next.habits['work-stretch'].minutes).toBe(26);
    expect(habitText('work-stretch', next.habits, '23:30')).toBe('连续工作大约 26 分钟后会停一下');
  });

  it('withholds a reminder habit inside the middle band, then uses hysteresis', () => {
    const mixed = fold(blank([
      ...Array.from({ length: 4 }, () => reminder(at(-1, 9), 'accepted')),
      ...Array.from({ length: 4 }, () => reminder(at(-1, 10), 'snoozed')),
    ]), NOW);
    expect(mixed.habits['reminder-tolerance'].samples).toBe(8);
    expect(mixed.habits['reminder-tolerance'].side).toBeNull();
    expect(habitText('reminder-tolerance', mixed.habits, '23:30')).toBeNull();

    const letGo = fold(blank([
      ...Array.from({ length: 2 }, () => reminder(at(-3, 9), 'accepted')),
      ...Array.from({ length: 6 }, () => reminder(at(-3, 10), 'snoozed')),
    ]), at(-2, 8));
    expect(habitText('reminder-tolerance', letGo.habits, '23:30')).toBe('提醒经常被延后或放过');

    const held = fold({
      ...letGo,
      journal: [...letGo.journal, ...Array.from({ length: 4 }, () => reminder(at(-2, 12), 'accepted'))],
    }, at(-1, 8));
    expect(held.habits['reminder-tolerance'].side).toBe('no');
    expect(habitText('reminder-tolerance', held.habits, '23:30')).toBe('提醒经常被延后或放过');

    const flipped = fold({
      ...held,
      journal: [...held.journal, ...Array.from({ length: 3 }, () => reminder(at(-1, 12), 'accepted'))],
    }, NOW);
    expect(flipped.habits['reminder-tolerance'].side).toBe('yes');
    expect(habitText('reminder-tolerance', flipped.habits, '23:30')).toBe('提醒大多会照做');

    const opened = fold(blank(Array.from({ length: 8 }, () => companion(at(-1, 15), 'opened'))), NOW);
    expect(habitText('companion-reception', opened.habits, '23:30')).toBe('主动陪伴经常被点开');
    const passed = fold(blank([
      ...Array.from({ length: 2 }, () => companion(at(-1, 15), 'opened')),
      ...Array.from({ length: 6 }, () => companion(at(-1, 16), 'expired')),
    ]), NOW);
    expect(habitText('companion-reception', passed.habits, '23:30')).toBe('主动陪伴经常被放过');
  });

  it('does not decay or move drift across days that have no records', () => {
    const habits = emptyHabits();
    habits['work-stretch'] = { minutes: 40, samples: 6 };
    habits['reminder-tolerance'] = { yes: 4, no: 6, samples: 10, side: 'no' };
    habits['night-presence'] = { nightDays: 2.5, activeDays: 4, samples: 6, on: true };
    habits.updatedAt = 111;
    const drift = { talkativeness: -1 as const, nightQuiet: 1 as const };
    const input = { habits, drift, journal: [] as JournalEntry[], foldedAt: at(-30, 0) };
    const next = fold(input, NOW);
    expect(next.habits).toEqual(habits);
    expect(next.drift).toEqual(drift);
    expect(next.foldedAt).toBe(at(0, 0));
    expect(input.habits['reminder-tolerance'].yes).toBe(4);
  });

  it('needs a fresh run of samples after a habit is cleared', () => {
    const formed = fold(blank([30, 40, 50, 60, 70].map(minutes => work(at(-2, 9), minutes))), at(-1, 8));
    const cleared = { ...formed, habits: clearHabit(formed.habits, 'work-stretch'), journal: formed.journal };
    expect(fold(cleared, NOW).habits['work-stretch'].samples).toBe(0);

    const four = fold({
      ...cleared,
      journal: [10, 20, 30, 40].map(minutes => work(at(-1, 9), minutes)),
    }, NOW);
    expect(habitText('work-stretch', four.habits, '23:30')).toBeNull();
    const five = fold({
      ...four,
      journal: [...four.journal, work(at(0, 9), 80)],
    }, at(1, 8));
    expect(five.habits['work-stretch'].samples).toBe(5);
    expect(habitText('work-stretch', five.habits, '23:30')).toBeTruthy();

    const reminders = emptyHabits();
    reminders['reminder-tolerance'] = { yes: 8, no: 1, samples: 9, side: 'yes' };
    const removed = clearHabit(reminders, 'reminder-tolerance');
    const seven = fold({
      habits: removed,
      drift: emptyDrift(),
      journal: Array.from({ length: 7 }, () => reminder(at(-1, 9), 'accepted')),
      foldedAt: at(-2, 0),
    }, NOW);
    expect(habitText('reminder-tolerance', seven.habits, '23:30')).toBeNull();
    const eight = fold({
      ...seven,
      journal: [...seven.journal, reminder(at(0, 9), 'accepted')],
    }, at(1, 8));
    expect(habitText('reminder-tolerance', eight.habits, '23:30')).toBe('提醒大多会照做');
  });

  it('folds each missed day once, including a record exactly at local midnight', () => {
    const midnight = at(-1, 0);
    const todayMidnight = at(0, 0);
    const once = fold(blank([
      work(midnight, 30),
      work(todayMidnight, 99),
      work(at(-1, 18), 50),
    ], midnight), NOW);
    expect(once.habits['work-stretch'].samples).toBe(2);
    expect(once.habits['work-stretch'].minutes).toBe(40);
    expect(fold(once, NOW).habits['work-stretch'].samples).toBe(2);

    const days = fold(blank([
      work(at(-3, 12), 10),
      work(at(-2, 12), 20),
      work(at(-1, 12), 30),
    ]), NOW);
    expect(days.habits['work-stretch'].samples).toBe(3);
    expect(days.foldedAt).toBe(at(0, 0));

    const noon = at(-1, 12);
    const bounded = fold(blank([work(noon - 1, 10), work(noon, 20)], noon), NOW);
    expect(bounded.habits['work-stretch'].samples).toBe(1);
    expect(bounded.habits['work-stretch'].minutes).toBe(20);
  });

  it('does not fold when the clock moves backward', () => {
    const next = fold(blank([work(at(-1, 12), 45)], NOW + 86_400_000), NOW);
    expect(next.habits['work-stretch'].samples).toBe(0);
    expect(next.drift).toEqual(emptyDrift());
    expect(next.foldedAt).toBe(at(0, 0));
  });

  it('steps at most one drift value per recorded day and moves night quiet first', () => {
    const habits = emptyHabits();
    habits['night-presence'] = { nightDays: 4, activeDays: 5, samples: 5, on: true };
    habits['reminder-tolerance'] = { yes: 8, no: 1, samples: 9, side: 'yes' };
    habits['companion-reception'] = { yes: 8, no: 1, samples: 9, side: 'yes' };
    expect(stepDrift(emptyDrift(), habits)).toEqual({ talkativeness: 0, nightQuiet: 1 });
    expect(stepDrift({ talkativeness: 0, nightQuiet: 1 }, habits)).toEqual({ talkativeness: 1, nightQuiet: 1 });

    const caughtUp = fold({
      habits,
      drift: emptyDrift(),
      journal: [presence(at(-3, 23), true), presence(at(-1, 23), true)],
      foldedAt: at(-4, 0),
    }, NOW);
    expect(caughtUp.drift).toEqual({ talkativeness: 1, nightQuiet: 1 });

    const reset = fold({ ...caughtUp, drift: emptyDrift() }, NOW);
    expect(reset.drift).toEqual(emptyDrift());
  });

  it('shows night presence with hysteresis and ignores empty days', () => {
    const nights = Array.from({ length: 5 }, (_, index) => presence(at(-6 + index, 23), true));
    const shown = fold(blank(nights), at(0, 8));
    expect(shown.habits['night-presence'].samples).toBe(5);
    expect(habitText('night-presence', shown.habits, '23:30')).toBe('夜里 23:30 后仍常在');

    const almost = fold(blank(nights.slice(0, 4)), NOW);
    expect(habitText('night-presence', almost.habits, '23:30')).toBeNull();

    const staying = emptyHabits();
    staying['night-presence'] = { nightDays: 3, activeDays: 10, samples: 5, on: true };
    const stillOn = fold({ habits: staying, drift: emptyDrift(), journal: [presence(at(-1, 11), false)], foldedAt: at(-2, 0) }, NOW);
    expect(stillOn.habits['night-presence'].on).toBe(true);

    const fading = emptyHabits();
    fading['night-presence'] = { nightDays: 1, activeDays: 10, samples: 5, on: true };
    const hidden = fold({ habits: fading, drift: emptyDrift(), journal: [presence(at(-1, 11), false)], foldedAt: at(-2, 0) }, NOW);
    expect(hidden.habits['night-presence'].on).toBe(false);
    expect(habitText('night-presence', hidden.habits, '00:30')).toBeNull();
  });

  it('drops raw records older than 14 local days without undoing a folded habit', () => {
    const now = new Date(2026, 10, 10, 15).getTime();
    const oldest = new Date(2026, 10, 10);
    oldest.setHours(0, 0, 0, 0);
    oldest.setDate(oldest.getDate() - 13);
    const kept = entry({ id: 'kept', t: oldest.getTime(), type: 'work', minutes: 15, end: 'away' });
    const dropped = entry({ id: 'old', t: oldest.getTime() - 1, type: 'work', minutes: 90, end: 'rest' });
    expect(prune([dropped, kept], now).map(item => item.id)).toEqual(['kept']);

    const old = Array.from({ length: 5 }, (_, index) => work(at(-20, 12), 30 + index));
    const folded = fold(blank(old), NOW);
    const pruned = prune(old, NOW);
    expect(pruned).toHaveLength(0);
    expect(fold({ ...folded, journal: pruned }, NOW).habits['work-stretch'].samples).toBe(5);
  });
});

describe('drift wording, bias, and delay', () => {
  it('describes only talkativeness and night quiet', () => {
    expect(driftSummary(emptyDrift())).toBe('语气还和你选的性格一致');
    expect(driftSummary({ talkativeness: -1, nightQuiet: 1 })).toBe('最近话少一点，夜里更安静');
    expect(driftSummary({ talkativeness: 2, nightQuiet: 0 })).toBe('最近话多一些');
    expect(driftSummary({ talkativeness: -2, nightQuiet: 0 })).toBe('最近话少一些');
  });

  it('adds one base interval per quiet step and caps the stacked wait at three intervals', () => {
    expect(extraDelay({ talkativeness: -1, nightQuiet: 0 }, 1000, 0)).toBe(2000);
    expect(extraDelay({ talkativeness: 2, nightQuiet: 1 }, 1000, 0)).toBe(1000);
    expect(extraDelay({ talkativeness: -2, nightQuiet: 0 }, 1000, 3)).toBe(3000);
    expect(extraDelay({ talkativeness: 2, nightQuiet: 0 }, 1000, 4)).toBe(1750);
    expect(extraDelay({ talkativeness: 0, nightQuiet: 0 }, 180_000, 1)).toBe(225_000);
  });

  it('treats the time before 05:00 and after nightAt as night', () => {
    expect(companionBias({ talkativeness: 2, nightQuiet: 1 }, at(0, 23, 40), '23:30')).toEqual({ quiet: true, length: null });
    expect(companionBias({ talkativeness: -1, nightQuiet: 1 }, at(0, 4, 59), '23:30').quiet).toBe(true);
    expect(companionBias({ talkativeness: -1, nightQuiet: 1 }, at(0, 5, 0), '23:30')).toEqual({ quiet: false, length: 'short' });
    expect(companionBias({ talkativeness: 1, nightQuiet: 0 }, at(0, 23, 40), '23:30')).toEqual({ quiet: false, length: 'long' });
    expect(companionBias({ talkativeness: 0, nightQuiet: 1 }, at(0, 16, 0), '23:30')).toEqual({ quiet: false, length: null });
    expect(preferLines(['aa', 'b', 'cccc', 'ddd'], 'short')).toEqual(['aa', 'b']);
    expect(preferLines(['aa', 'b', 'cccc', 'ddd'], 'long')).toEqual(['cccc', 'ddd']);
  });

  it('ignores corrupt fields and still folds a valid journal into an empty accumulator', () => {
    const cleaned = sanitize({
      habits: {
        'work-stretch': { minutes: 'bad', samples: 9 },
        'reminder-tolerance': { yes: 2, no: 6, samples: 8, side: 'no' },
        'night-presence': { nightDays: -1, activeDays: 2, samples: 2, on: true },
      },
      drift: { talkativeness: 9, nightQuiet: 2 },
      journal: [work(at(-1, 12), 18), { id: 'bad', t: 'yesterday', type: 'work' }],
      foldedAt: 'later',
    }, NOW);
    expect(cleaned.drift).toEqual(emptyDrift());
    expect(cleaned.habits['work-stretch']).toEqual({ minutes: 0, samples: 0 });
    expect(cleaned.habits['reminder-tolerance'].side).toBe('no');
    expect(cleaned.habits['night-presence'].on).toBe(false);
    expect(cleaned.journal).toHaveLength(1);
    expect(cleaned.foldedAt).toBeNull();
    const folded = fold(cleaned, NOW);
    expect(folded.habits['work-stretch']).toMatchObject({ minutes: 18, samples: 1 });
    expect(folded.habits['reminder-tolerance'].side).toBe('no');
  });

  it('publishes visible habits, drift, and progress without the raw journal', () => {
    const habits = emptyHabits();
    habits['work-stretch'] = { minutes: 42, samples: 3 };
    habits.updatedAt = at(-1, 8);
    const journal = [work(at(0, 9), 30), reminder(at(0, 9), 'accepted'), presence(at(0, 23), true), presence(at(0, 23, 30), true)];
    const view = settingsView(habits, { talkativeness: -1, nightQuiet: 0 }, journal, '23:30', NOW);
    expect(view.habits).toEqual([]);
    expect(view.drift).toEqual({ talkativeness: -1, nightQuiet: 0 });
    expect(view.habitProgress).toEqual([
      { id: 'work-stretch', samples: 3, pending: 1, need: 5 },
      { id: 'reminder-tolerance', samples: 0, pending: 1, need: 8 },
      { id: 'night-presence', samples: 0, pending: 1, need: 5 },
      { id: 'companion-reception', samples: 0, pending: 0, need: 8 },
    ]);
    expect(JSON.stringify(view)).not.toContain('journal');
    expect(memoryAddon(habits, emptyDrift(), '23:30')).toBeNull();
    habits['work-stretch'].samples = 5;
    const addon = memoryAddon(habits, { talkativeness: -1, nightQuiet: 1 }, '23:30');
    expect(addon).toContain('连续工作大约 42 分钟后会停一下');
    expect(addon).toContain('最近话少一点，夜里更安静');
    expect(addon).toContain('不能据此声称又记住了新内容');
    expect(addon).toContain('也不能调用工具');
  });
});
