export const HABIT_IDS = ['work-stretch', 'reminder-tolerance', 'night-presence', 'companion-reception'] as const;
export type HabitId = typeof HABIT_IDS[number];
export type RatioSide = 'yes' | 'no' | null;
export type ReminderAction = 'accepted' | 'snoozed' | 'skipped' | 'muted' | 'ignored';

export interface JournalEntry {
  id: string;
  t: number;
  type: 'work' | 'reminder' | 'companion' | 'presence';
  minutes?: number;
  end?: 'rest' | 'away';
  kind?: string;
  action?: ReminderAction | 'opened' | 'expired';
  day?: string;
  night?: boolean;
  hour?: number;
}

export interface WorkStretch { minutes: number; samples: number }
export interface RatioHabit { yes: number; no: number; samples: number; side: RatioSide }
export interface NightPresence { nightDays: number; activeDays: number; samples: number; on: boolean }
export interface Habits {
  'work-stretch': WorkStretch;
  'reminder-tolerance': RatioHabit;
  'night-presence': NightPresence;
  'companion-reception': RatioHabit;
  updatedAt: number | null;
}
export interface Drift { talkativeness: number; nightQuiet: 0 | 1 }
export interface FoldInput { habits: Habits; drift: Drift; journal: JournalEntry[]; foldedAt: number | null }
export interface FoldResult { habits: Habits; drift: Drift; foldedAt: number; journal: JournalEntry[] }
export interface HabitProgress { id: HabitId; samples: number; pending: number; need: number }
export interface VisibleHabit { id: HabitId; text: string; samples: number; updatedAt: number | null }
export interface SettingsHabitsView { habits: VisibleHabit[]; drift: Drift; habitProgress: HabitProgress[] }

export const HABIT_LABELS: Record<HabitId, string> = {
  'work-stretch': '连续工作多久会停',
  'reminder-tolerance': '提醒之后的回应',
  'night-presence': '夜里是否还在',
  'companion-reception': '主动陪伴被点开还是放过',
};

const REMINDER_ACTIONS = new Set<ReminderAction>(['accepted', 'snoozed', 'skipped', 'muted', 'ignored']);
const NO_ACTIONS = new Set<ReminderAction>(['snoozed', 'skipped', 'muted', 'ignored']);

export function emptyHabits(): Habits {
  return {
    'work-stretch': { minutes: 0, samples: 0 },
    'reminder-tolerance': { yes: 0, no: 0, samples: 0, side: null },
    'night-presence': { nightDays: 0, activeDays: 0, samples: 0, on: false },
    'companion-reception': { yes: 0, no: 0, samples: 0, side: null },
    updatedAt: null,
  };
}

export function emptyDrift(): Drift {
  return { talkativeness: 0, nightQuiet: 0 };
}

export function startOfLocalDay(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function nextLocalDay(time: number): number {
  const date = new Date(startOfLocalDay(time));
  date.setDate(date.getDate() + 1);
  return date.getTime();
}

function finite(value: unknown, min = 0): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
}

function whole(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return finite(value, min) && Number.isInteger(value) && value <= max;
}

function cloneHabits(habits: Habits): Habits {
  return {
    'work-stretch': { ...habits['work-stretch'] },
    'reminder-tolerance': { ...habits['reminder-tolerance'] },
    'night-presence': { ...habits['night-presence'] },
    'companion-reception': { ...habits['companion-reception'] },
    updatedAt: habits.updatedAt,
  };
}

export function clearHabit(habits: Habits, id: string): Habits {
  if (!HABIT_IDS.includes(id as HabitId)) throw new Error('不支持的习惯');
  const next = cloneHabits(habits);
  const empty = emptyHabits();
  if (id === 'work-stretch') next['work-stretch'] = empty['work-stretch'];
  else if (id === 'reminder-tolerance') next['reminder-tolerance'] = empty['reminder-tolerance'];
  else if (id === 'night-presence') next['night-presence'] = empty['night-presence'];
  else next['companion-reception'] = empty['companion-reception'];
  return next;
}

export function prune(journal: JournalEntry[], now: number): JournalEntry[] {
  const cutoff = new Date(startOfLocalDay(now));
  cutoff.setDate(cutoff.getDate() - 13);
  const min = cutoff.getTime();
  return journal.filter(item => item.t >= min);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function nextSide(habit: RatioHabit): RatioSide {
  if (habit.samples < 8 || habit.yes + habit.no <= 0) return null;
  const ratio = habit.yes / (habit.yes + habit.no);
  if (habit.side === 'yes') return ratio <= 0.4 ? 'no' : 'yes';
  if (habit.side === 'no') return ratio >= 0.6 ? 'yes' : 'no';
  if (ratio >= 0.6) return 'yes';
  if (ratio <= 0.4) return 'no';
  return null;
}

function applyRatio(habit: RatioHabit, yes: number, no: number, count: number) {
  habit.yes = 0.9 * habit.yes + yes;
  habit.no = 0.9 * habit.no + no;
  habit.samples += count;
  habit.side = nextSide(habit);
}

function applyDay(habits: Habits, entries: JournalEntry[]): boolean {
  let changed = false;
  const work = entries.filter(item => item.type === 'work' && typeof item.minutes === 'number' && item.minutes >= 1);
  if (work.length) {
    const middle = median(work.map(item => item.minutes || 0));
    const habit = habits['work-stretch'];
    habit.minutes = habit.samples === 0 ? middle : Math.round(0.7 * habit.minutes + 0.3 * middle);
    habit.samples += work.length;
    changed = true;
  }
  const reminders = entries.filter(item => item.type === 'reminder' && item.action && REMINDER_ACTIONS.has(item.action as ReminderAction));
  if (reminders.length) {
    const yes = reminders.filter(item => item.action === 'accepted').length;
    const no = reminders.filter(item => NO_ACTIONS.has(item.action as ReminderAction)).length;
    applyRatio(habits['reminder-tolerance'], yes, no, reminders.length);
    changed = true;
  }
  const companions = entries.filter(item => item.type === 'companion' && (item.action === 'opened' || item.action === 'expired'));
  if (companions.length) {
    const yes = companions.filter(item => item.action === 'opened').length;
    const no = companions.filter(item => item.action === 'expired').length;
    applyRatio(habits['companion-reception'], yes, no, companions.length);
    changed = true;
  }
  const presence = entries.filter(item => item.type === 'presence');
  if (presence.length) {
    const habit = habits['night-presence'];
    habit.activeDays = 0.9 * habit.activeDays + 1;
    if (presence.some(item => item.night)) {
      habit.nightDays = 0.9 * habit.nightDays + 1;
      habit.samples += 1;
    } else habit.nightDays = 0.9 * habit.nightDays;
    const ratio = habit.activeDays > 0 ? habit.nightDays / habit.activeDays : 0;
    habit.on = habit.on ? ratio >= 0.2 : habit.samples >= 5 && ratio >= 0.4;
    changed = true;
  }
  return changed;
}

function talkTarget(habits: Habits): number {
  let more = 0;
  let less = 0;
  for (const id of ['reminder-tolerance', 'companion-reception'] as const) {
    const habit = habits[id];
    if (habit.samples < 8) continue;
    if (habit.side === 'yes') more += 1;
    else if (habit.side === 'no') less += 1;
  }
  if (more && !less) return Math.min(2, more);
  if (less && !more) return Math.max(-2, -less);
  return 0;
}

export function stepDrift(drift: Drift, habits: Habits): Drift {
  const next: Drift = {
    talkativeness: Math.max(-2, Math.min(2, Math.trunc(drift.talkativeness) || 0)),
    nightQuiet: drift.nightQuiet === 1 ? 1 : 0,
  };
  const nightTarget = habits['night-presence'].on ? 1 : 0;
  if (next.nightQuiet !== nightTarget) {
    next.nightQuiet = nightTarget;
    return next;
  }
  const target = talkTarget(habits);
  if (next.talkativeness !== target) next.talkativeness += Math.sign(target - next.talkativeness);
  return next;
}

export function fold(input: FoldInput, now: number): FoldResult {
  const todayStart = startOfLocalDay(now);
  const habits = cloneHabits(input.habits);
  let drift: Drift = { ...input.drift };
  const journal = input.journal;
  // A clock rollback is not a new day of companionship.
  if (input.foldedAt != null && input.foldedAt > now) return { habits, drift, foldedAt: todayStart, journal };
  if (input.foldedAt != null && input.foldedAt >= todayStart) return { habits, drift, foldedAt: input.foldedAt, journal };
  const lower = input.foldedAt ?? Number.NEGATIVE_INFINITY;
  const groups = new Map<number, JournalEntry[]>();
  for (const item of input.journal) {
    // t >= foldedAt keeps a record stamped exactly at local midnight.
    if (!(item.t >= lower && item.t < todayStart)) continue;
    const day = startOfLocalDay(item.t);
    const list = groups.get(day);
    if (list) list.push(item);
    else groups.set(day, [item]);
  }
  let changed = false;
  for (const day of [...groups.keys()].sort((a, b) => a - b)) {
    if (applyDay(habits, groups.get(day) || [])) changed = true;
    drift = stepDrift(drift, habits);
  }
  if (changed) habits.updatedAt = now;
  return { habits, drift, foldedAt: todayStart, journal };
}

export function habitText(id: HabitId, habits: Habits, nightAt: string): string | null {
  if (id === 'work-stretch') {
    const habit = habits['work-stretch'];
    return habit.samples >= 5 ? `连续工作大约 ${habit.minutes} 分钟后会停一下` : null;
  }
  if (id === 'reminder-tolerance') {
    const habit = habits['reminder-tolerance'];
    if (habit.samples < 8 || !habit.side) return null;
    return habit.side === 'yes' ? '提醒大多会照做' : '提醒经常被延后或放过';
  }
  if (id === 'companion-reception') {
    const habit = habits['companion-reception'];
    if (habit.samples < 8 || !habit.side) return null;
    return habit.side === 'yes' ? '主动陪伴经常被点开' : '主动陪伴经常被放过';
  }
  return habits['night-presence'].on ? `夜里 ${nightAt} 后仍常在` : null;
}

export function visibleHabits(habits: Habits, nightAt: string): VisibleHabit[] {
  return HABIT_IDS.flatMap(id => {
    const text = habitText(id, habits, nightAt);
    return text ? [{ id, text, samples: habits[id].samples, updatedAt: habits.updatedAt }] : [];
  });
}

export function driftSummary(drift: Drift): string {
  const parts: string[] = [];
  if (drift.talkativeness >= 2) parts.push('最近话多一些');
  else if (drift.talkativeness === 1) parts.push('最近话多一点');
  else if (drift.talkativeness === -1) parts.push('最近话少一点');
  else if (drift.talkativeness <= -2) parts.push('最近话少一些');
  if (drift.nightQuiet) parts.push('夜里更安静');
  return parts.length ? parts.join('，') : '语气还和你选的性格一致';
}

export function memoryAddon(habits?: Habits | null, drift?: Drift | null, nightAt = '23:30'): string | null {
  if (!habits || !drift) return null;
  const lines = visibleHabits(habits, nightAt).map(item => item.text);
  const moved = drift.talkativeness !== 0 || drift.nightQuiet !== 0;
  if (!lines.length && !moved) return null;
  const parts = ['相处习惯和语气偏移只是参考，不能据此声称又记住了新内容，也不能调用工具去写习惯。'];
  if (lines.length) parts.push(`可见习惯：${lines.join('；')}。`);
  if (moved) parts.push(`语气偏移：${driftSummary(drift)}。`);
  return parts.join('');
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match || +match[1] > 23 || +match[2] > 59) return null;
  return +match[1] * 60 + +match[2];
}

export function isNight(when: number | Date, nightAt: string): boolean {
  const date = new Date(when);
  const minutes = date.getHours() * 60 + date.getMinutes();
  if (minutes < 5 * 60) return true;
  const start = clockMinutes(nightAt);
  return start != null && minutes >= start;
}

export function companionBias(drift: Drift, when: number | Date, nightAt: string): { quiet: boolean; length: 'long' | 'short' | null } {
  if (drift.nightQuiet === 1 && isNight(when, nightAt)) return { quiet: true, length: null };
  return { quiet: false, length: drift.talkativeness > 0 ? 'long' : drift.talkativeness < 0 ? 'short' : null };
}

export function preferLines(lines: string[], length: 'long' | 'short' | null | undefined): string[] {
  if (!length || lines.length < 2) return lines;
  const ranked = lines.map((text, index) => ({ text, index }));
  ranked.sort((a, b) => a.text.length - b.text.length || a.index - b.index);
  const count = Math.ceil(lines.length / 2);
  const chosen = new Set((length === 'short' ? ranked.slice(0, count) : ranked.slice(-count)).map(item => item.text));
  const picked = lines.filter(text => chosen.has(text));
  return picked.length ? picked : lines;
}

export function extraDelay(drift: Drift, base: number, ignored = 0): number {
  const quieter = drift.talkativeness < 0 ? -drift.talkativeness : 0;
  const backoff = Math.min(Math.max(ignored, 0), 3) * 0.25;
  return base * Math.min(3, 1 + quieter + backoff);
}

export function habitProgress(habits: Habits, journal: JournalEntry[], now: number): HabitProgress[] {
  const today = startOfLocalDay(now);
  const tomorrow = nextLocalDay(now);
  const pending = journal.filter(item => item.t >= today && item.t < tomorrow);
  const night = pending.some(item => item.type === 'presence' && item.night) ? 1 : 0;
  return [
    { id: 'work-stretch', samples: habits['work-stretch'].samples, pending: pending.filter(item => item.type === 'work').length, need: 5 },
    { id: 'reminder-tolerance', samples: habits['reminder-tolerance'].samples, pending: pending.filter(item => item.type === 'reminder').length, need: 8 },
    { id: 'night-presence', samples: habits['night-presence'].samples, pending: night, need: 5 },
    { id: 'companion-reception', samples: habits['companion-reception'].samples, pending: pending.filter(item => item.type === 'companion').length, need: 8 },
  ];
}

export function settingsView(habits: Habits, drift: Drift, journal: JournalEntry[], nightAt: string, now: number): SettingsHabitsView {
  return {
    habits: visibleHabits(habits, nightAt),
    drift: { talkativeness: drift.talkativeness, nightQuiet: drift.nightQuiet },
    habitProgress: habitProgress(habits, journal, now),
  };
}

function readEntry(raw: any): JournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id || raw.id === '__proto__') return null;
  if (!finite(raw.t)) return null;
  if (raw.type === 'work' && (raw.end === 'rest' || raw.end === 'away') && whole(raw.minutes, 1, 24 * 60)) {
    return { id: raw.id, t: raw.t, type: 'work', minutes: raw.minutes, end: raw.end };
  }
  if (raw.type === 'reminder' && typeof raw.kind === 'string' && raw.kind && REMINDER_ACTIONS.has(raw.action)) {
    return { id: raw.id, t: raw.t, type: 'reminder', kind: raw.kind.slice(0, 40), action: raw.action };
  }
  if (raw.type === 'companion' && (raw.action === 'opened' || raw.action === 'expired')) {
    return { id: raw.id, t: raw.t, type: 'companion', action: raw.action };
  }
  if (raw.type === 'presence' && typeof raw.day === 'string' && raw.day && typeof raw.night === 'boolean') {
    const hour = whole(raw.hour, 0, 23) ? raw.hour : new Date(raw.t).getHours();
    return { id: raw.id, t: raw.t, type: 'presence', day: raw.day, night: raw.night, hour };
  }
  return null;
}

function readWork(raw: any): WorkStretch | null {
  if (!raw || typeof raw !== 'object' || !whole(raw.minutes, 0, 24 * 60) || !whole(raw.samples)) return null;
  return { minutes: raw.minutes, samples: raw.samples };
}

function readRatio(raw: any): RatioHabit | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.yes) || !finite(raw.no) || !whole(raw.samples)) return null;
  if (raw.side != null && raw.side !== 'yes' && raw.side !== 'no') return null;
  return { yes: raw.yes, no: raw.no, samples: raw.samples, side: raw.side === 'yes' || raw.side === 'no' ? raw.side : null };
}

function readNight(raw: any): NightPresence | null {
  if (!raw || typeof raw !== 'object' || !finite(raw.nightDays) || !finite(raw.activeDays) || !whole(raw.samples) || typeof raw.on !== 'boolean') return null;
  return { nightDays: raw.nightDays, activeDays: raw.activeDays, samples: raw.samples, on: raw.on };
}

export function sanitize(raw: any, now = Date.now()): FoldInput {
  const source = raw && typeof raw === 'object' ? raw : {};
  const habits = emptyHabits();
  const stored = source.habits && typeof source.habits === 'object' ? source.habits : {};
  habits['work-stretch'] = readWork(stored['work-stretch']) || habits['work-stretch'];
  habits['reminder-tolerance'] = readRatio(stored['reminder-tolerance']) || habits['reminder-tolerance'];
  habits['night-presence'] = readNight(stored['night-presence']) || habits['night-presence'];
  habits['companion-reception'] = readRatio(stored['companion-reception']) || habits['companion-reception'];
  habits.updatedAt = finite(stored.updatedAt) ? stored.updatedAt : null;
  const talk = source.drift?.talkativeness;
  const night = source.drift?.nightQuiet;
  const drift: Drift = {
    talkativeness: typeof talk === 'number' && Number.isInteger(talk) && talk >= -2 && talk <= 2 ? talk : 0,
    nightQuiet: night === 0 || night === 1 ? night : 0,
  };
  let foldedAt = finite(source.foldedAt) ? source.foldedAt : null;
  if (foldedAt != null && foldedAt > now) foldedAt = startOfLocalDay(now);
  const journal = Array.isArray(source.journal) ? source.journal.map(readEntry).filter((item: JournalEntry | null): item is JournalEntry => !!item) : [];
  return { habits, drift, journal, foldedAt };
}
