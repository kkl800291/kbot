import { ActivityClock, SpeechBudget, dayKey, isRepeating, nextOccurrence, resolveAt, validateReminder, type Reminder } from './scheduler';
import { birthdayMatches, dateInfo, isWorkday } from './calendar';
import { companionDelay, CompanionVoice } from './companionship';
import { clearHabit, companionBias, extraDelay, fold, isNight, prune, sanitize, type JournalEntry, type ReminderAction } from './habits';

export function installBrain(A: any) {
  const robot = A.robot;
  const B = A.brain = {} as any;
  A.reminders = A.stored.reminders || [];
  A.memories = A.stored.memories || [];
  A.builtin = { rest: true, water: true, eye: false, lunch: true, offwork: true, night: true, morning: true, ...A.stored.builtin };
  const persisted = A.stored.scheduler || {};
  let today = dayKey(new Date());
  let sent: Record<string, boolean> = persisted.day === today ? (persisted.sent || {}) : {};
  A.muted = persisted.day === today ? (persisted.muted || {}) : {};
  const snoozes = new Map<string, { at: number; run: () => void }>();
  const activity = A.activity = new ActivityClock();
  const budget = new SpeechBudget();
  const voice = new CompanionVoice();
  const clean = sanitize(A.stored, Date.now());
  A.journal = clean.journal;
  A.habits = clean.habits;
  A.drift = clean.drift;
  A.foldedAt = clean.foldedAt;
  let companionPending = false;
  let nextCompanionAt = 0;
  const delayFor = (base: number, ignored = 0) => extraDelay(A.drift, base, ignored);
  let deferred: { ev: any; until: number } | null = null;
  let idleSeconds = 0, nativeSeen = false, browserInput = performance.now();
  let lastMono = performance.now(), lastWall = Date.now(), restLeft = 0, returned = false;
  let lastRestPrompt = -Infinity;
  let wakePending = false;
  let restStarted = 0;
  for (const key of ['reminders', 'memories', 'builtin']) A.persisters[key] = () => A[key];
  A.persisters.scheduler = () => ({ day: today, sent, muted: A.muted });
  A.persisters.journal = () => A.journal;
  A.persisters.habits = () => A.habits;
  A.persisters.drift = () => A.drift;
  A.persisters.foldedAt = () => A.foldedAt;
  function applyFold(now = Date.now()) {
    const result = fold({ habits: A.habits, drift: A.drift, journal: A.journal, foldedAt: A.foldedAt }, now);
    const journal = prune(A.journal, now);
    const habitsChanged = JSON.stringify(result.habits) !== JSON.stringify(A.habits);
    const driftChanged = JSON.stringify(result.drift) !== JSON.stringify(A.drift);
    const changed = habitsChanged || driftChanged || result.foldedAt !== A.foldedAt || journal.length !== A.journal.length;
    A.habits = result.habits;
    A.drift = result.drift;
    A.foldedAt = result.foldedAt;
    A.journal = journal;
    if (changed) A.save();
    if (habitsChanged) A.emit('habits');
    if (driftChanged) A.emit('drift');
  }
  function pushJournal(entry: Omit<JournalEntry, 'id' | 't'>) {
    A.journal.push({ id: A.uid(), t: Date.now(), ...entry });
    A.journal = prune(A.journal, Date.now());
    A.save();
  }
  function rememberReminder(kind: string, action: ReminderAction) {
    pushJournal({ type: 'reminder', kind, action });
  }
  function rememberWork(minutes: number, end: 'rest' | 'away') {
    if (minutes < 1) return;
    pushJournal({ type: 'work', minutes, end });
  }
  function rememberPresence(now: number, idleSeconds: number, suspended: boolean) {
    if (suspended || idleSeconds >= 60) return;
    const date = new Date(now);
    const day = dayKey(date);
    const hour = date.getHours();
    if (A.journal.some((item: JournalEntry) => item.type === 'presence' && item.day === day && item.hour === hour)) return;
    pushJournal({ type: 'presence', day, night: isNight(date, A.S.params.nightAt), hour });
  }
  applyFold();
  nextCompanionAt = Date.now() + delayFor(companionDelay(A.S.freq, true));
  A.workInfo = () => ({ minutes: Math.floor(activity.workSeconds / 60), nextIn: Math.max(0, Math.ceil(A.S.work - activity.workSeconds / 60)) });
  const workday = (d: Date) => isWorkday(d, A.S.holidays);
  const withinWork = (d: Date) => workday(d) && A.hm(+d) >= A.S.workFrom && A.hm(+d) < A.S.workTo;
  B.nextOccurrence = (r: Reminder, from = Date.now()) => nextOccurrence(r, from, workday);
  B.resolveAt = (when: string, now = Date.now()) => resolveAt(when, now);

  const phrases: Record<string, string[]> = {
    rest: ['站起来伸个懒腰嘛，我帮你看着屏幕。', '眼睛也要休息啦，去走两步，我等你。'],
    water: ['喝一口水嘛，就一口～', '补水时间到，润润嗓子吧。'],
    eye: ['看看远处吧，20 秒就好。'],
    lunch: ['快到饭点啦，先给自己安排点好吃的吧。'],
    offwork: ['快下班啦～ 收个尾，今天的你也辛苦啦。'],
    night: ['已经很晚了，早点休息嘛，明天再继续。'],
    idle: ['我在这儿陪你，慢慢来就好。', '偷偷伸个懒腰，再继续也不迟呀。', '今天也有在认真努力呢。'],
    back: ['你回来啦！刚才我在数像素呢。'],
  };
  const quiet: Record<string, string> = { rest: '该休息了。', water: '喝水时间。', eye: '看看远处，休息 20 秒。', lunch: '快到用餐时间了。', offwork: '准备下班收尾。', night: '夜深了，早点休息。', idle: '慢慢来。', back: '欢迎回来。' };
  B.line = (kind: string) => A.S.persona === 'quiet' ? quiet[kind] : (phrases[kind] || phrases.idle)[Math.floor(Math.random() * (phrases[kind] || phrases.idle).length)];
  A.BUILTINS = [
    { k: 'rest', name: '休息', desc: () => `每工作 ${A.S.work} 分钟，休息 ${A.S.rest} 分钟` },
    { k: 'water', name: '喝水', desc: () => `工作时间内每 ${A.S.params.waterEvery} 分钟，离开期间不累计`, param: { path: 'params.waterEvery', type: 'num', min: 15, max: 180, unit: '分钟' } },
    { k: 'eye', name: '远眺护眼', desc: () => `每 ${A.S.params.eyeEvery} 分钟看远处 20 秒`, param: { path: 'params.eyeEvery', type: 'num', min: 10, max: 90, unit: '分钟' } },
    { k: 'lunch', name: '点外卖', desc: () => `工作日 ${A.S.params.lunchAt}，17:30 仍工作时再提醒`, param: { path: 'params.lunchAt', type: 'time' } },
    { k: 'offwork', name: '下班', desc: () => `下班前 ${A.S.params.offworkLead} 分钟`, param: { path: 'params.offworkLead', type: 'num', min: 5, max: 60, unit: '分钟前' } },
    { k: 'night', name: '深夜', desc: () => `${A.S.params.nightAt} 后仍在使用电脑，每晚最多 2 次`, param: { path: 'params.nightAt', type: 'time' } },
    { k: 'morning', name: '早安', desc: () => '当天首次使用时，附日期、节气和可用的天气' },
  ];

  function deliver(ev: any) {
    const dnd = A.isDnd();
    if (A.hidden) { A.sysNotify(ev); return true; }
    ev.silent = dnd;
    if (!dnd) A.blip();
    if (A.panel.isOpen()) { A.chat.pushPro(ev); return true; }
    return A.bubble.show(ev);
  }
  A.speak = (ev: any) => {
    ev = { kind: 'speech', pri: 'low', ...ev };
    const now = Date.now();
    if (A.away) {
      if (ev.pri === 'high') A.missed.push(ev);
      return false;
    }
    if (ev.pri !== 'high' && (A.isDnd() || !budget.allows(now, ev.pri, ev.pri === 'low', A.S.freq))) {
      if (ev.pri === 'mid') deferred = { ev, until: now + (ev.ttl || 1800_000) };
      return false;
    }
    if (!deliver(ev)) return false;
    budget.record(now, ev.pri, ev.pri === 'low');
    return true;
  };
  A.on('bubble:dismiss', (why: string, ev?: { track?: { type?: string; kind?: string } }) => {
    if (why === 'expire') budget.ignored++;
    else budget.ignored = 0;
    const track = ev?.track;
    if (!track) return;
    if (track.type === 'reminder' && why === 'expire') rememberReminder(track.kind || 'reminder', 'ignored');
    else if (track.type === 'companion' && why === 'open') pushJournal({ type: 'companion', action: 'opened' });
    else if (track.type === 'companion' && why === 'expire') pushJournal({ type: 'companion', action: 'expired' });
  });
  A.on('set:freq', () => { budget.ignored = 0; nextCompanionAt = Date.now() + delayFor(companionDelay(A.S.freq, true)); });
  A.on('onboarded', () => { nextCompanionAt = Date.now() + delayFor(companionDelay(A.S.freq, true)); });

  const snooze = (key: string, run: () => void) => { snoozes.set(key, { at: Date.now() + 600_000, run }); A.toast('好的，10 分钟后再提醒你'); };
  const standard = (key: string, run: () => void) => [
    { label: '好的', primary: true, fn: () => rememberReminder(key, 'accepted') },
    { label: '过 10 分钟再说', quiet: true, fn: () => { rememberReminder(key, 'snoozed'); snooze(key, run); } },
    { label: '今天别提醒了', fn: () => { rememberReminder(key, 'muted'); A.muted[key] = true; A.save(); } },
  ];
  const endRest = (early = false) => {
    A.rest.phase = 'idle'; restLeft = 0; activity.resetWork(); A.bubble.hide(true);
    A.setBase(A.isDnd() ? 'dnd' : 'idle');
    A.say(early ? '好吧，累了再叫我～' : '休息结束啦，慢慢找回状态吧。', { pri: 'mid', expr: 'happy' });
  };
  const startRest = () => {
    rememberWork(Math.floor(activity.workSeconds / 60), 'rest');
    activity.resetWork();
    A.rest.phase = 'resting'; restLeft = A.rest.total; A.rest.left = restLeft; A.rest.warned = false;
    restStarted = Date.now();
    A.setBase('sleepy'); A.bubble.hide(true);
    deliver({ kind: 'rest', pri: 'mid', title: '休息中', text: '放松肩膀，看看远处～ 我陪着你。', ring: true, sticky: true,
      actions: [{ label: '提前结束', quiet: true, fn: () => endRest(true) }] });
  };
  B.restTouch = () => {
    if (A.rest.phase !== 'resting' || A.rest.warned || A.isDnd() || Date.now() - restStarted < 10_000) return;
    A.rest.warned = true;
    if (A.panel.isOpen()) A.chat.pushPro({ kind: 'speech', text: '还在休息时间哦～ 再歇一会儿嘛。' });
    else A.bubble.flashText('还在休息时间哦～ 再歇一会儿嘛。', 5000);
  };
  B.fire = (kind: string, text?: string) => {
    if (A.builtin[kind] === false || A.muted[kind]) return;
    const ev: any = { kind: 'remind', pri: 'mid', text: text || B.line(kind), title: ({ rest: '休息一下吧', water: '喝水提醒', eye: '看看远处', lunch: '吃点东西吧', offwork: '准备收尾啦', night: '该睡觉啦', birthday: '生日提醒' } as Record<string, string>)[kind] };
    if (kind === 'morning' || kind === 'idle' || kind === 'term') {
      ev.kind = 'speech'; ev.pri = kind === 'idle' ? 'low' : 'mid'; ev.expr = 'happy';
    } else if (kind === 'rest') {
      A.rest.total = A.S.rest * 60; A.rest.left = A.rest.total;
      ev.ring = true;
      ev.track = { type: 'reminder', kind: 'rest' };
      ev.actions = [
        { label: '好的，去休息', primary: true, quiet: true, fn: () => { rememberReminder('rest', 'accepted'); startRest(); } },
        { label: '过 10 分钟再说', quiet: true, fn: () => { rememberReminder('rest', 'snoozed'); A.rest.phase = 'idle'; lastRestPrompt = Date.now() + 600_000; snooze('rest', () => B.fire('rest')); } },
        { label: '跳过这次', fn: () => { rememberReminder('rest', 'skipped'); A.rest.phase = 'idle'; activity.resetWork(); } },
      ];
      ev.onExpire = () => { if (A.rest.phase === 'prompt') A.rest.phase = 'idle'; };
      lastRestPrompt = Date.now();
    } else if (kind !== 'birthday') {
      ev.track = { type: 'reminder', kind };
      ev.actions = standard(kind, () => B.fire(kind, text));
    } else ev.actions = [
      { label: '好的', primary: true },
      { label: '过 10 分钟再说', quiet: true, fn: () => snooze(kind, () => B.fire(kind, text)) },
      { label: '今天别提醒了', fn: () => { A.muted[kind] = true; A.save(); } },
    ];
    if (['morning', 'term', 'birthday'].includes(kind)) ev.ttl = +new Date(new Date().setHours(24, 0, 0, 0)) - Date.now();
    if (A.speak(ev) && kind === 'rest') A.rest.phase = 'prompt';
  };

  const settle = (r: Reminder) => {
    // Validate from displayed text; never trust a stale hidden timestamp on an edited confirmation card.
    r.at = validateReminder(r, Date.now(), workday);
  };
  B.addReminder = (data: Partial<Reminder>) => {
    const r: Reminder = { id: A.uid(), when: data.when || '', repeat: data.repeat || '仅一次', content: (data.content || '').trim(), at: null, fired: false };
    settle(r); A.reminders.push(r); A.save(); A.emit('reminders'); return r;
  };
  B.updateReminder = (id: string, data: Partial<Reminder>) => {
    const r = A.reminders.find((r: Reminder) => r.id === id); if (!r) return;
    const replacement = { ...r, ...data, fired: false }; settle(replacement);
    Object.assign(r, replacement); A.save(); A.emit('reminders');
  };
  B.removeReminder = (id: string) => { snoozes.delete('custom:' + id); A.reminders = A.reminders.filter((r: Reminder) => r.id !== id); A.save(); A.emit('reminders'); };
  B.fireReminder = (r: Reminder) => {
    if (A.muted['custom:' + r.id]) return;
    A.speak({ kind: 'remind', pri: 'high', title: '你设的提醒', text: r.content, track: { type: 'reminder', kind: 'custom' },
      actions: [
        { label: '好的', primary: true, fn: () => rememberReminder('custom', 'accepted') },
        { label: '过 10 分钟再说', quiet: true, fn: () => { rememberReminder('custom', 'snoozed'); r.snoozedUntil = Date.now() + 600_000; A.save(); A.toast('好的，10 分钟后再提醒你'); } },
        { label: '今天别提醒了', fn: () => { rememberReminder('custom', 'muted'); A.muted['custom:' + r.id] = true; delete r.snoozedUntil; A.save(); } },
      ] });
  };
  B.addMemory = (text: string) => { if (!text.trim()) return; A.memories.push({ id: A.uid(), text: text.trim().slice(0, 500), t: Date.now() }); A.save(); A.emit('memories'); };
  B.updateMemory = (id: string, text: string) => { const m = A.memories.find((m: any) => m.id === id); if (m) { m.text = text.slice(0, 500); A.save(); A.emit('memories'); } };
  B.removeMemory = (id: string) => { A.memories = A.memories.filter((m: any) => m.id !== id); A.save(); A.emit('memories'); };
  B.clearMemories = () => { A.memories = []; A.save(); A.emit('memories'); };
  B.removeHabit = (id: string) => { A.habits = clearHabit(A.habits, id); A.save(); A.emit('habits'); };
  B.resetDrift = () => { A.drift = { talkativeness: 0, nightQuiet: 0 }; A.save(); A.emit('drift'); };

  A.on('sensors', (s: any) => {
    nativeSeen = true;
    idleSeconds = s.idleSeconds ?? 0;
    if (s.resumed) wakePending = true;
    if (A.S.senseApp && s.appName && s.appId !== 'com.cybercompanion.desktop') {
      A.frontmost = s.appName;
      const cat = Object.entries(A.S.apps).find(([, names]) => (names as string[]).some(n => s.appName.toLowerCase().includes(n.toLowerCase())));
      A.frontmostCategory = cat?.[0] || 'other';
      A.setMeeting(A.frontmostCategory === 'meeting' || !!s.meeting);
    } else if (!A.S.senseApp) { A.frontmost = null; A.frontmostCategory = null; A.setMeeting(false); }
  });
  ['pointerdown', 'keydown'].forEach(event => addEventListener(event, () => {
    browserInput = performance.now(); budget.ignored = 0;
    nextCompanionAt = Math.max(nextCompanionAt, Date.now() + 45_000);
  }));

  function scanReminders(now: number, recovering: boolean) {
    const missed: string[] = [];
    let changed = false;
    A.reminders.forEach((r: Reminder) => {
      if (r.snoozedUntil && r.snoozedUntil <= now) {
        if (recovering || now - r.snoozedUntil > 10_000) missed.push(r.content);
        else B.fireReminder(r);
        delete r.snoozedUntil; changed = true;
      }
      if (r.fired) return;
      if (!r.at && isRepeating(r)) { r.at = B.nextOccurrence(r, now); changed = true; }
      if (!r.at || r.at > now) return;
      if (recovering || now - r.at > 10_000) missed.push(r.content);
      else B.fireReminder(r);
      if (isRepeating(r)) r.at = B.nextOccurrence(r, now);
      else r.fired = true;
      changed = true;
    });
    if (changed) { A.save(); A.emit('reminders'); }
    if (missed.length) A.speak({ kind: 'remind', pri: 'high', title: '错过的提醒', text: `你不在时有 ${missed.length} 条提醒到点：${missed.slice(0, 4).join('；')}${missed.length > 4 ? '等。完整内容可在提醒列表查看。' : '。'}`, actions: [{ label: '知道啦', primary: true }] });
  }
  const daily = (key: string, run: () => void) => { if (sent[key]) return; sent[key] = true; run(); A.save(); };
  function tick() {
    const mono = performance.now(), now = Date.now(), d = new Date(now);
    const elapsed = (mono - lastMono) / 1000;
    const suspended = elapsed > 10 || Math.abs(now - lastWall - (mono - lastMono)) > 10_000 || wakePending;
    wakePending = false; lastMono = mono; lastWall = now;
    if (!A.S.onboarding) return;
    if (dayKey(d) !== today) { today = dayKey(d); sent = {}; A.muted = {}; A.chat.prune(); applyFold(now); A.save(); }
    const idle = A.S.senseIdle ? (nativeSeen ? idleSeconds : (mono - browserInput) / 1000) : 0;
    const wasAway = A.away;
    // A short reading pause is companionship time; work accounting is separate.
    A.setAway(idle >= 300);
    if (!suspended) {
      const ended = activity.update(elapsed, idle, A.S.rest, A.rest.phase === 'resting');
      if (ended >= 1) rememberWork(ended, 'away');
    }
    scanReminders(now, suspended);
    if (suspended) {
      snoozes.clear(); A.missed = A.missed.filter((ev: any) => ev.pri === 'high');
      nextCompanionAt = now + delayFor(companionDelay(A.S.freq, true));
    }
    if (wasAway && !A.away) {
      returned = true;
      nextCompanionAt = now + 15_000;
      const missed = A.missed.splice(0);
      if (missed.length) A.speak({ kind: 'remind', pri: 'high', title: '离开期间的提醒', text: missed.map((e: any) => e.text).slice(0, 4).join('；'), actions: [{ label: '知道啦', primary: true }] });
    }
    if (A.rest.phase === 'resting') {
      if (!suspended) restLeft -= elapsed;
      A.rest.left = Math.max(0, restLeft); A.emit('rest:tick');
      if (restLeft <= 0) endRest();
      else if (!A.away && idle < 2) B.restTouch();
    }
    rememberPresence(now, idle, suspended);
    if (A.away) return;
    for (const [key, item] of snoozes) if (item.at <= now) { snoozes.delete(key); item.run(); }
    if (deferred && !A.isDnd()) {
      const item = deferred;
      if (now > item.until) deferred = null;
      else if (budget.allows(now, item.ev.pri, false, A.S.freq)) {
        deferred = null;
        if (A.speak(item.ev) && item.ev.ring && A.rest.phase === 'idle') A.rest.phase = 'prompt';
      }
    }
    const work = withinWork(d);
    if (work) {
      daily('morning', () => {
        if (!A.builtin.morning) return;
        const info = dateInfo(d), date = `${d.getMonth() + 1} 月 ${d.getDate()} 日，周${'日一二三四五六'[d.getDay()]}`;
        B.fire('morning', `早安呀！今天 ${date}${info.term && A.S.term ? '，' + info.term : ''}${info.festivals.length && A.S.festival ? '，' + info.festivals.join('、') : ''}。${A.weatherSummary?.() || ''}`);
      });
      if (A.rest.phase === 'idle' && activity.workSeconds >= A.S.work * 60 && now - lastRestPrompt >= 600_000) B.fire('rest');
      for (const [key, field, minutes] of [['water', 'waterSeconds', A.S.params.waterEvery], ['eye', 'eyeSeconds', A.S.params.eyeEvery]] as const) {
        if (A.builtin[key] && activity[field] >= minutes * 60) { activity[field] = 0; B.fire(key); }
      }
      const near = (time: string) => { const [h, m] = time.split(':').map(Number); const minutes = d.getHours() * 60 + d.getMinutes() - h * 60 - m; return minutes >= 0 && minutes < 5; };
      if (near(A.S.params.lunchAt)) daily('lunch', () => B.fire('lunch'));
      if (near('17:30')) daily('dinner', () => B.fire('lunch', '还在忙呀？给自己安排点晚饭吧。'));
      const end = new Date(d); const [h, m] = A.S.workTo.split(':').map(Number); end.setHours(h, m, 0, 0);
      if (now >= +end - A.S.params.offworkLead * 60_000) daily('offwork', () => B.fire('offwork'));
    }
    if (workday(d) && A.hm(now) >= A.S.workTo) {
      const [h, m] = A.S.workTo.split(':').map(Number); const end = new Date(d); end.setHours(h, m, 0, 0);
      if (now >= +end + 3600_000) daily('overtime', () => B.fire('offwork', '下班已经一小时啦，今天也辛苦了，早点收工嘛。'));
    }
    if (A.hm(now) >= A.S.params.nightAt) {
      daily('night1', () => B.fire('night'));
      const [h, m] = A.S.params.nightAt.split(':').map(Number);
      if (d.getHours() * 60 + d.getMinutes() >= h * 60 + m + 20) daily('night2', () => B.fire('night'));
    }
    for (const b of A.birthdays || []) {
      for (const lead of [...new Set([0, b.lead || 0])]) {
        const future = new Date(d); future.setDate(future.getDate() + Number(lead));
        if (birthdayMatches(b, future)) daily(`birthday:${b.id}:${lead}`, () => B.fire('birthday', `${lead ? `${lead} 天后` : '今天'}是${b.name}的生日，记得送上祝福呀。`));
      }
    }
    const unavailable = A.hidden || A.isDnd() || A.panel.isOpen() || A.settingsVisible || A.petPointerActive || A.rest.phase !== 'idle' || A.bubble.current?.();
    if (unavailable || companionPending) {
      if (unavailable) nextCompanionAt = Math.max(nextCompanionAt, now + 30_000);
      return;
    }
    if (now >= nextCompanionAt && budget.allows(now, 'low', true, A.S.freq)) {
      const bias = companionBias(A.drift, d, A.S.params.nightAt);
      const picked = returned
        ? { text: B.line('back'), expr: 'happy' }
        : voice.next(A.S.persona, d.getHours(), A.S.senseApp ? A.frontmostCategory : undefined, Math.random, bias);
      const finish = (text: string, fromRewrite = false) => {
        const at = Date.now();
        const blocked = A.hidden || A.isDnd() || A.panel.isOpen() || A.settingsVisible || A.petPointerActive || A.rest.phase !== 'idle' || !!A.bubble.current?.() || A.away || (fromRewrite && !!A.chat.generating);
        if (blocked || !budget.allows(at, 'low', true, A.S.freq)) {
          nextCompanionAt = at + 30_000;
          return;
        }
        const cleaned = (text || '').trim();
        const finalText = cleaned && (cleaned === picked.text.trim() || cleaned.length <= 60) ? cleaned : picked.text;
        if (A.speak({ kind: 'speech', pri: 'low', text: finalText, expr: picked.expr, track: { type: 'companion' } })) {
          returned = false;
          nextCompanionAt = at + delayFor(companionDelay(A.S.freq), budget.ignored);
        } else nextCompanionAt = at + 30_000;
      };
      const canRewrite = !!A.S.aiCompanion && !!A.S.model && A.S.model !== 'none' && !A.chat.generating && typeof A.rewriteCompanion === 'function';
      if (!canRewrite) finish(picked.text);
      else {
        companionPending = true;
        nextCompanionAt = now + 8_000;
        void (async () => {
          let text = picked.text;
          try {
            const rewritten = await A.rewriteCompanion(picked.text);
            if (typeof rewritten === 'string') text = rewritten;
          } catch { text = picked.text; }
          companionPending = false;
          finish(text, true);
        })();
      }
    }
  }
  A.init(() => { if (A.S.onboarding) scanReminders(Date.now(), true); if (A.native) A.on('tick', tick); else setInterval(tick, 1000); });
}
