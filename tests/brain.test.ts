import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { installBrain } from '../src/services/brain';

function companion(settings: Record<string, any> = {}, stored: Record<string, any> = {}) {
  const listeners = new Map<string, ((...args: any[]) => void)[]>(), inits: (() => void)[] = [], events: any[] = [];
  const A: any = {
    stored, native: false, persisters: {}, missed: [], hidden: false, away: false,
    S: {
      onboarding: true, senseIdle: true, senseApp: false, holidays: false, rest: 1, work: 60,
      workFrom: '09:30', workTo: '18:30', params: { waterEvery: 45, eyeEvery: 20, lunchAt: '11:15', offworkLead: 10, nightAt: '23:30' },
      freq: 'normal', persona: 'cute', apps: {}, term: true, festival: true,
      ...settings,
    },
    on: (name: string, fn: (...args: any[]) => void) => listeners.set(name, [...(listeners.get(name) || []), fn]),
    emit: (name: string, ...args: any[]) => listeners.get(name)?.forEach(fn => fn(...args)),
    init: (fn: () => void) => inits.push(fn),
    isDnd: () => false, setMeeting: vi.fn(), setAway: (away: boolean) => { A.away = away; },
    setBase: vi.fn(), save: vi.fn(), toast: vi.fn(), blip: vi.fn(), uid: () => String(Math.random()),
    panel: { isOpen: () => false }, chat: { prune: vi.fn(), pushPro: vi.fn(), generating: false },
    robot: { flash: vi.fn() }, rest: { phase: 'idle', total: 60, left: 60 },
    bubble: { show: (ev: any) => { events.push(ev); return true; }, hide: vi.fn(), flashText: vi.fn() },
    sysNotify: (ev: any) => events.push(ev), hm: (t: number) => new Date(t).toTimeString().slice(0, 5),
  };
  A.say = (text: string, o: any) => A.speak({ kind: 'speech', text, ...o });
  installBrain(A);
  for (const key in A.builtin) A.builtin[key] = false;
  inits.forEach(fn => fn());
  return { A, events };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-10T10:00:00'));
  vi.stubGlobal('addEventListener', vi.fn());
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('finishes an explicit break while the user is away', () => {
  const { A, events } = companion();
  A.builtin.rest = true;
  A.brain.fire('rest');
  events[0].actions[0].fn();
  expect(A.rest.phase).toBe('resting');
  A.emit('sensors', { idleSeconds: 600 });
  vi.advanceTimersByTime(61_000);
  expect(A.away).toBe(true);
  expect(A.rest.phase).toBe('idle');
  expect(A.activity.workSeconds).toBe(0);
});

it('keeps snoozed explicit reminders scheduled after their first firing', () => {
  const { A, events } = companion();
  const reminder = A.brain.addReminder({ when: '2026-11-10 10:00:02', repeat: '仅一次', content: '回电话' });
  vi.advanceTimersByTime(3000);
  expect(reminder.fired).toBe(true);
  expect(events[0].text).toBe('回电话');
  events[0].actions[1].fn();
  expect(reminder.snoozedUntil).toBe(Date.now() + 600_000);
  // Simulate continued computer use without going idle in the browser harness.
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(600_000);
  expect(events.filter(e => e.text === '回电话')).toHaveLength(2);
  expect(reminder.snoozedUntil).toBeUndefined();
});

it('merges overdue reminders when waking instead of replaying each event', () => {
  const { A, events } = companion();
  A.brain.addReminder({ when: '2026-11-10 10:01:00', repeat: '仅一次', content: '回电话' });
  A.brain.addReminder({ when: '2026-11-10 10:02:00', repeat: '仅一次', content: '开会' });
  vi.setSystemTime(new Date('2026-11-10T11:00:00'));
  A.emit('sensors', { idleSeconds: 0, resumed: true });
  vi.advanceTimersByTime(1000);
  expect(events).toHaveLength(1);
  expect(events[0].title).toBe('错过的提醒');
  expect(events[0].text).toContain('2 条提醒');
  expect(A.reminders.every((r: any) => r.fired)).toBe(true);
});

it('starts companionship within 75 seconds and keeps talking without a 30-minute work requirement', () => {
  const { A, events } = companion();
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(76_000);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ kind: 'speech', pri: 'low' });
  expect(A.activity.workSeconds).toBeLessThan(1800);
  vi.advanceTimersByTime(900_000);
  expect(events.length).toBeGreaterThanOrEqual(4);
  expect(new Set(events.slice(0, 3).map(ev => ev.text)).size).toBe(3);
});

it('offers companionship on a weekend evening outside working hours', () => {
  vi.setSystemTime(new Date('2026-11-15T20:00:00'));
  const { A, events } = companion({ freq: 'high' });
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(46_000);
  expect(events).toHaveLength(1);
  expect(events[0].pri).toBe('low');
});

it('keeps company during a short reading pause and sleeps after five minutes away', () => {
  const { A, events } = companion({ freq: 'high' });
  A.emit('sensors', { idleSeconds: 120 });
  vi.advanceTimersByTime(46_000);
  expect(A.away).toBe(false);
  expect(events).toHaveLength(1);
  A.emit('sensors', { idleSeconds: 301 });
  vi.advanceTimersByTime(300_000);
  expect(A.away).toBe(true);
  expect(events).toHaveLength(1);
});

it.each(['chat', 'settings', 'dnd', 'hidden', 'drag', 'bubble', 'rest'])('defers companionship during %s and resumes without replaying a backlog', reason => {
  const { A, events } = companion({ freq: 'high' });
  let blocked = true;
  A.emit('sensors', { idleSeconds: 0 });
  if (reason === 'chat') A.panel.isOpen = () => blocked;
  if (reason === 'settings') A.settingsVisible = true;
  if (reason === 'dnd') A.isDnd = () => blocked;
  if (reason === 'hidden') A.hidden = true;
  if (reason === 'drag') A.petPointerActive = true;
  if (reason === 'bubble') A.bubble.current = () => blocked ? {} : null;
  if (reason === 'rest') A.rest.phase = 'prompt';
  vi.advanceTimersByTime(600_000);
  expect(events).toHaveLength(0);
  blocked = false; A.settingsVisible = false; A.hidden = false; A.petPointerActive = false; A.rest.phase = 'idle';
  vi.advanceTimersByTime(29_000);
  expect(events).toHaveLength(0);
  vi.advanceTimersByTime(2000);
  expect(events).toHaveLength(1);
});

it('does not stop companionship permanently after three bubbles expire', () => {
  const { A, events } = companion({ freq: 'high' });
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(46_000);
  for (let i = 0; i < 3; i++) A.emit('bubble:dismiss', 'expire');
  vi.advanceTimersByTime(160_000);
  expect(events.length).toBeGreaterThanOrEqual(2);
});

it('waits an extra interval when talkativeness is negative and does not start sooner when it is positive', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    const quiet = companion({ freq: 'normal' }, { drift: { talkativeness: -1, nightQuiet: 0 } });
    quiet.A.emit('sensors', { idleSeconds: 0 });
    vi.advanceTimersByTime(76_000);
    expect(quiet.events).toHaveLength(0);
    vi.advanceTimersByTime(20_000);
    expect(quiet.events).toHaveLength(1);

    const talkative = companion({ freq: 'normal' }, { drift: { talkativeness: 2, nightQuiet: 0 } });
    talkative.A.emit('sensors', { idleSeconds: 0 });
    vi.advanceTimersByTime(44_000);
    expect(talkative.events).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(talkative.events).toHaveLength(1);
  } finally { random.mockRestore(); }
});

it('picks a quiet companion line late at night and keeps the reminder sentence', () => {
  const random = vi.spyOn(Math, 'random').mockReturnValue(0);
  try {
    vi.setSystemTime(new Date(2026, 10, 10, 4, 30, 0));
    const { A, events } = companion({ freq: 'high' }, { drift: { talkativeness: 0, nightQuiet: 1 } });
    A.emit('sensors', { idleSeconds: 0 });
    vi.advanceTimersByTime(31_000);
    expect(events[0].text).toBe('不用赶，我在。');
    expect(events[0].track).toEqual({ type: 'companion' });
    vi.advanceTimersByTime(50_000);
    A.builtin.water = true;
    A.brain.fire('water');
    const water = events.find(event => event.kind === 'remind');
    expect(['喝一口水嘛，就一口～', '补水时间到，润润嗓子吧。']).toContain(water.text);
  } finally { random.mockRestore(); }
});

it('records companion and reminder outcomes without inferring an ignore', () => {
  const opened = companion({ freq: 'high' });
  opened.A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(46_000);
  opened.A.emit('bubble:dismiss', 'open', opened.events[0]);
  opened.A.emit('bubble:dismiss', 'preempt', opened.events[0]);
  opened.A.emit('bubble:dismiss', 'hide', opened.events[0]);
  expect(opened.A.journal.filter((item: any) => item.type === 'companion')).toEqual([
    expect.objectContaining({ action: 'opened' }),
  ]);
  opened.A.emit('bubble:dismiss', 'expire', { track: { type: 'companion' } });
  expect(opened.A.journal.filter((item: any) => item.action === 'expired')).toHaveLength(1);

  const { A, events } = companion();
  A.builtin.water = true;
  A.brain.fire('water');
  events[0].actions[0].fn();
  events[0].actions[1].fn();
  events[0].actions[2].fn();
  expect(A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'water', action: 'accepted' }));
  expect(A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'water', action: 'snoozed' }));
  expect(A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'water', action: 'muted' }));

  const ignoredCase = companion();
  ignoredCase.A.builtin.eye = true;
  ignoredCase.A.brain.fire('eye');
  ignoredCase.A.emit('bubble:dismiss', 'expire', ignoredCase.events[0]);
  expect(ignoredCase.A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'eye', action: 'ignored' }));
  ignoredCase.A.emit('bubble:dismiss', 'preempt', ignoredCase.events[0]);
  ignoredCase.A.emit('bubble:dismiss', 'hide', ignoredCase.events[0]);
  expect(ignoredCase.A.journal.filter((item: any) => item.action === 'ignored')).toHaveLength(1);

  const panel = companion();
  panel.A.panel.isOpen = () => true;
  panel.A.builtin.water = true;
  panel.A.brain.fire('water');
  expect(panel.A.chat.pushPro).toHaveBeenCalled();
  expect(panel.A.journal.filter((item: any) => item.type === 'reminder')).toHaveLength(0);
  panel.A.chat.pushPro.mock.calls[0][0].actions[0].fn();
  expect(panel.A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'water', action: 'accepted' }));
});

it('records a custom acknowledgement and does not record a hidden or away reminder', () => {
  const { A, events } = companion();
  A.brain.addReminder({ when: '2026-11-10 10:00:02', repeat: '仅一次', content: '回电话' });
  vi.advanceTimersByTime(3000);
  expect(typeof events[0].actions[0].fn).toBe('function');
  events[0].actions[0].fn();
  expect(A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'custom', action: 'accepted' }));

  const hidden = companion();
  hidden.A.hidden = true;
  hidden.A.builtin.water = true;
  hidden.A.brain.fire('water');
  expect(hidden.A.journal.filter((item: any) => item.type === 'reminder')).toHaveLength(0);

  const away = companion();
  away.A.away = true;
  away.A.builtin.water = true;
  away.A.brain.fire('water');
  expect(away.A.journal.filter((item: any) => item.type === 'reminder')).toHaveLength(0);
});

it('records a finished work stretch on rest or a long absence, not on skip or a short stretch', () => {
  const skipped = companion();
  skipped.A.builtin.rest = true;
  skipped.A.activity.workSeconds = 180;
  skipped.A.brain.fire('rest');
  skipped.events[0].actions[2].fn();
  expect(skipped.A.journal.filter((item: any) => item.type === 'work')).toHaveLength(0);
  expect(skipped.A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'rest', action: 'skipped' }));

  const resting = companion();
  resting.A.builtin.rest = true;
  resting.A.activity.workSeconds = 180;
  resting.A.brain.fire('rest');
  resting.events[0].actions[0].fn();
  expect(resting.A.journal).toContainEqual(expect.objectContaining({ type: 'work', minutes: 3, end: 'rest' }));
  expect(resting.A.journal).toContainEqual(expect.objectContaining({ type: 'reminder', kind: 'rest', action: 'accepted' }));

  const { A } = companion();
  A.activity.workSeconds = 125;
  A.emit('sensors', { idleSeconds: 60 });
  vi.advanceTimersByTime(1000);
  expect(A.journal).toContainEqual(expect.objectContaining({ type: 'work', minutes: 2, end: 'away' }));
  A.activity.workSeconds = 40;
  vi.advanceTimersByTime(1000);
  expect(A.journal.filter((item: any) => item.type === 'work')).toHaveLength(1);
});

it('records at most one presence per hour and uses nightAt plus the hours before 05:00', () => {
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  const { A } = companion();
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(3000);
  expect(A.journal.filter((item: any) => item.type === 'presence')).toEqual([
    expect.objectContaining({ day: '2026-11-10', hour: 10, night: false }),
  ]);
  vi.advanceTimersByTime(3_600_000);
  expect(A.journal.filter((item: any) => item.type === 'presence').map((item: any) => item.hour)).toEqual([10, 11]);

  const night = (hour: number, minute: number) => {
    vi.setSystemTime(new Date(2026, 10, 10, hour, minute, 0));
    const started = companion();
    started.A.emit('sensors', { idleSeconds: 0 });
    vi.advanceTimersByTime(1000);
    return started.A.journal.find((item: any) => item.type === 'presence');
  };
  expect(night(23, 40).night).toBe(true);
  expect(night(23, 29).night).toBe(false);
  expect(night(4, 59).night).toBe(true);
  expect(night(5, 0).night).toBe(false);
});

it('folds stored history once, keeps habits after raw records age out, and steps drift on the next recorded day', () => {
  const old = new Date(2026, 10, 10);
  old.setDate(old.getDate() - 20);
  old.setHours(12, 0, 0, 0);
  const journal = Array.from({ length: 5 }, (_, index) => ({ id: `old${index}`, t: old.getTime(), type: 'work', minutes: 15, end: 'away' }));
  const first = companion({}, { journal, habits: { 'work-stretch': { minutes: 'bad', samples: 9 } } });
  expect(first.A.habits['work-stretch']).toMatchObject({ minutes: 15, samples: 5 });
  expect(first.A.journal.some((item: any) => item.t === old.getTime())).toBe(false);
  expect(first.A.persisters.journal()).toBe(first.A.journal);
  expect(first.A.persisters.foldedAt()).toBe(first.A.foldedAt);
  const second = companion({}, { journal: first.A.journal, habits: first.A.habits, drift: first.A.drift, foldedAt: first.A.foldedAt });
  expect(second.A.habits['work-stretch'].samples).toBe(5);

  const { A, events } = companion({}, {
    habits: {
      'work-stretch': { minutes: 0, samples: 0 },
      'reminder-tolerance': { yes: 8, no: 1, samples: 9, side: 'yes' },
      'night-presence': { nightDays: 4, activeDays: 5, samples: 5, on: true },
      'companion-reception': { yes: 8, no: 1, samples: 9, side: 'yes' },
      updatedAt: null,
    },
  });
  A.builtin.rest = true;
  A.activity.workSeconds = 120;
  A.brain.fire('rest');
  events[0].actions[0].fn();
  expect(A.habits['work-stretch'].samples).toBe(0);
  A.brain.resetDrift();
  expect(A.drift).toEqual({ talkativeness: 0, nightQuiet: 0 });
  expect(A.habits['night-presence'].on).toBe(true);
  vi.advanceTimersByTime(5000);
  expect(A.drift).toEqual({ talkativeness: 0, nightQuiet: 0 });
  vi.setSystemTime(new Date(2026, 10, 11, 0, 5, 0));
  A.emit('sensors', { idleSeconds: 0 });
  vi.advanceTimersByTime(1000);
  expect(A.habits['work-stretch'].samples).toBe(1);
  expect(A.drift).toEqual({ talkativeness: 0, nightQuiet: 1 });
});

it('speaks a rewritten companion line only while the user is still available', async () => {
  const spoken = companion({ aiCompanion: true, model: 'text', freq: 'high' });
  spoken.A.rewriteCompanion = async () => '改好啦';
  spoken.A.emit('sensors', { idleSeconds: 0 });
  await vi.advanceTimersByTimeAsync(46_000);
  expect(spoken.events[0].text).toBe('改好啦');
  expect(spoken.events[0].track).toEqual({ type: 'companion' });

  const dropped = companion({ aiCompanion: true, model: 'text', freq: 'high' });
  let release: (text: string) => void = () => {};
  let rewriteCalls = 0;
  dropped.A.rewriteCompanion = () => {
    rewriteCalls += 1;
    if (rewriteCalls === 1) return new Promise<string>(done => { release = done; });
    return Promise.resolve('下一句');
  };
  dropped.A.emit('sensors', { idleSeconds: 0 });
  await vi.advanceTimersByTimeAsync(46_000);
  expect(dropped.events).toHaveLength(0);
  expect(rewriteCalls).toBe(1);
  dropped.A.panel.isOpen = () => true;
  release('不该说出来');
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(dropped.events).toHaveLength(0);
  dropped.A.panel.isOpen = () => false;
  await vi.advanceTimersByTimeAsync(29_000);
  expect(dropped.events).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(dropped.events.map(event => event.text)).toEqual(['下一句']);

  const away = companion({ aiCompanion: true, model: 'text', freq: 'high' });
  let finish: (text: string) => void = () => {};
  away.A.rewriteCompanion = () => new Promise<string>(done => { finish = done; });
  away.A.emit('sensors', { idleSeconds: 0 });
  await vi.advanceTimersByTimeAsync(46_000);
  away.A.away = true;
  finish('改好啦');
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(away.events).toHaveLength(0);
});

it('uses the local companion line without a rewrite while a reply is generating', async () => {
  const { A, events } = companion({ aiCompanion: true, model: 'text', freq: 'high' });
  const rewrite = vi.fn(async () => '模型句');
  A.rewriteCompanion = rewrite;
  A.chat.generating = true;
  A.emit('sensors', { idleSeconds: 0 });
  await vi.advanceTimersByTimeAsync(46_000);
  expect(rewrite).not.toHaveBeenCalled();
  expect(events).toHaveLength(1);
  expect(events[0].track).toEqual({ type: 'companion' });
});

it('labels bubble dismissal as action, open, expire, preempt, or hide', () => {
  class El extends EventTarget {
    children: any[] = [];
    style: any = { setProperty() {} };
    classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
    offsetWidth = 220;
    offsetHeight = 80;
    append(...nodes: any[]) { this.children.push(...nodes.filter(Boolean)); }
    closest() { return null; }
    remove() {}
    setAttribute() {}
  }
  const emits: any[] = [];
  const buttons: El[] = [];
  const h = (tag: string, props?: any, kids?: any) => {
    const el = new El();
    if (props?.onclick) el.addEventListener('click', props.onclick);
    if (tag === 'button') buttons.push(el);
    [].concat(kids == null ? [] : kids).forEach((kid: any) => { if (kid?.append) el.append(kid); });
    return el;
  };
  const A: any = {
    h, clamp: (value: number, lo: number, hi: number) => Math.min(Math.max(value, lo), hi),
    rest: { phase: 'idle', total: 300, left: 300 }, mmss: () => '00:00',
    robot: { clearFlash() {}, flash() {}, talkPulse() {} },
    petBody: () => ({ cx: 120, top: 240, bottom: 360 }),
    emit: (...args: any[]) => emits.push(args), on() {},
    $: () => new El(), S: { sound: false }, isDnd: () => false, icon: () => '',
    panel: { open: () => {}, isOpen: () => false }, chat: {}, away: false, hidden: false, missed: [], toast() {},
  };
  const context = {
    window: { App: A }, document: { body: new El() },
    requestAnimationFrame: (fn: () => void) => fn(),
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {},
    addEventListener() {}, innerWidth: 1200, innerHeight: 800, MD: { esc: (value: string) => value },
  };
  const source = readFileSync(new URL('../src/ui/bubble.js', import.meta.url), 'utf8').replace(/\nexport \{\};\s*$/, '');
  runInNewContext(source, context);
  const speech = { kind: 'speech', text: '陪你一会儿', pri: 'low' };
  A.bubble.show(speech);
  A.bubble.current().el.dispatchEvent(new Event('click'));
  let clicked = false;
  A.bubble.show({ kind: 'remind', text: '喝水', actions: [{ label: '好的', fn: () => { clicked = true; } }] });
  buttons.at(-1)!.dispatchEvent(new Event('click'));
  A.bubble.show({ kind: 'speech', text: '先收起' });
  A.bubble.hide(true);
  A.bubble.show({ kind: 'speech', text: '只收这句话' });
  A.bubble.hideSpeech();
  A.bubble.show({ kind: 'speech', text: '交到面板' });
  A.bubble.takeover();
  A.bubble.show({ kind: 'speech', text: '会被顶掉' });
  A.bubble.show({ kind: 'remind', pri: 'high', text: '更高优先级' });
  const reasons = emits.filter(item => item[0] === 'bubble:dismiss').map(item => item[1]);
  expect(reasons).toEqual(['open', 'action', 'hide', 'hide', 'hide', 'preempt']);
  expect(emits.find(item => item[1] === 'open')[2]).toBe(speech);
  expect(clicked).toBe(true);
});
