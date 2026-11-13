export type ProactiveEvent = {
  key: string;
  kind: 'speech' | 'remind';
  pri: 'low' | 'mid' | 'high';
  text: string;
  expr: string;
};

export type ProactiveSettings = {
  aiCompanion?: boolean;
  freq?: string;
  workFrom?: string;
  workTo?: string;
  params?: {
    waterEvery?: number;
    eyeEvery?: number;
    lunchAt?: string;
    offworkLead?: number;
    nightAt?: string;
  };
};

export function parseClock(value: unknown): number | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function dayKey(time: number | Date = Date.now()): string {
  const date = time instanceof Date ? time : new Date(time);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function minuteOfDay(time: number): number {
  const date = new Date(time);
  return date.getHours() * 60 + date.getMinutes();
}

function nearMinute(now: number, target: number | null, window = 3): boolean {
  if (target == null) return false;
  const delta = Math.abs(minuteOfDay(now) - target);
  return Math.min(delta, 1440 - delta) <= window;
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

function intervalFactor(freq: unknown): number {
  if (freq === 'quiet') return 1.35;
  if (freq === 'frequent') return 0.75;
  return 1;
}

export function buildDueProactiveEvents({
  now = Date.now(),
  settings = {},
  activeMinutes = 0,
  fired = {},
  active = true,
}: {
  now?: number;
  settings?: ProactiveSettings;
  activeMinutes?: number;
  fired?: Record<string, boolean>;
  active?: boolean;
}): ProactiveEvent[] {
  if (!active || settings.aiCompanion === false) return [];

  const params = settings.params || {};
  const factor = intervalFactor(settings.freq);
  const waterEvery = positiveInt(params.waterEvery, 45) * factor;
  const eyeEvery = positiveInt(params.eyeEvery, 20) * factor;
  const routine = () => {
    if (activeMinutes >= waterEvery && !fired.water) {
      return {
        key: 'water',
        kind: 'remind',
        pri: 'mid',
        text: `您已经连续工作约 ${Math.round(activeMinutes)} 分钟了，喝口水再继续吧。`,
        expr: 'remind',
      } satisfies ProactiveEvent;
    }
    if (activeMinutes >= eyeEvery && !fired.eye) {
      return {
        key: 'eye',
        kind: 'remind',
        pri: 'mid',
        text: '您看屏幕有一阵了，不妨望向远处，歇 20 秒眼睛。',
        expr: 'remind',
      } satisfies ProactiveEvent;
    }
    return null;
  };

  const lunch = parseClock(params.lunchAt);
  if (nearMinute(now, lunch) && !fired.lunch) {
    return [{ key: 'lunch', kind: 'remind', pri: 'mid', text: '午饭时间到了，先去用餐吧，回来再继续。', expr: 'happy' }];
  }

  const workTo = parseClock(settings.workTo);
  const offworkLead = Math.max(0, Number(params.offworkLead) || 0);
  const offwork = workTo == null ? null : (workTo - offworkLead + 1440) % 1440;
  if (nearMinute(now, offwork) && !fired.offwork) {
    return [{ key: 'offwork', kind: 'remind', pri: 'mid', text: '快到收工时间了。要不要先记下明天的第一件事？', expr: 'happy' }];
  }

  const night = parseClock(params.nightAt);
  if (nearMinute(now, night) && !fired.night) {
    return [{ key: 'night', kind: 'remind', pri: 'mid', text: '时候不早了，今天辛苦了。需要我帮您收个尾吗？', expr: 'sleepy' }];
  }

  const workFrom = parseClock(settings.workFrom);
  if (nearMinute(now, workFrom) && !fired.start) {
    return [{ key: 'start', kind: 'speech', pri: 'low', text: '到上班时间了。有什么需要，随时吩咐。', expr: 'happy' }];
  }
  const nextRoutine = routine();
  return nextRoutine ? [nextRoutine] : [];
}

type ProactiveRuntimeState = {
  day: string;
  activeMs: number;
  lastTickAt: number;
  lastIdleSeconds: number | null;
  awayAt: number | null;
  fired: Record<string, boolean>;
};

export function installProactive(A: any) {
  const saved = A.stored?.proactive;
  const today = dayKey();
  const state: ProactiveRuntimeState = {
    day: saved?.day === today ? today : today,
    activeMs: 0,
    lastTickAt: 0,
    lastIdleSeconds: null,
    awayAt: null,
    fired: saved?.day === today && saved?.fired && typeof saved.fired === 'object' ? { ...saved.fired } : {},
  };

  A.persisters.proactive = () => ({
    day: state.day,
    fired: state.fired,
  });

  const enabled = () => A.S.aiCompanion !== false;
  const quiet = () => Boolean(A.away || A.isDnd?.() || A.meeting);
  const resetDay = (now: number) => {
    const next = dayKey(now);
    if (next === state.day) return;
    state.day = next;
    state.activeMs = 0;
    state.fired = {};
    A.save?.();
  };

  const speak = (event: ProactiveEvent) => {
    if (!enabled()) return;
    state.fired[event.key] = true;
    A.speak?.({
      kind: event.kind,
      pri: event.pri,
      text: event.text,
      expr: event.expr,
      title: event.kind === 'remind' ? 'KBOT 提醒' : undefined,
      dur: event.kind === 'remind' ? 12000 : 8500,
    });
    A.save?.();
  };

  const isActive = () => {
    if (!enabled() || quiet()) return false;
    return state.lastIdleSeconds == null || state.lastIdleSeconds < 90;
  };

  const tick = (now = Date.now()) => {
    resetDay(now);
    if (state.lastTickAt > 0 && isActive()) {
      state.activeMs += Math.min(5000, Math.max(0, now - state.lastTickAt));
    }
    state.lastTickAt = now;
    const events = buildDueProactiveEvents({
      now,
      settings: A.S,
      activeMinutes: state.activeMs / 60000,
      fired: state.fired,
      active: isActive(),
    });
    events.forEach(speak);
  };

  A.proactive = {
    state: () => ({ day: state.day, activeMinutes: state.activeMs / 60000, fired: { ...state.fired } }),
    tick,
    reset: () => { state.activeMs = 0; state.lastTickAt = 0; state.fired = {}; A.save?.(); },
  };

  A.on('tick', () => tick());
  A.on('sensors', (payload: any) => {
    if (typeof payload?.idleSeconds === 'number') state.lastIdleSeconds = payload.idleSeconds;
  });
  A.on('away', (away: boolean) => {
    const now = Date.now();
    if (away) {
      state.awayAt = now;
      state.lastTickAt = now;
      return;
    }
    const awayFor = state.awayAt ? now - state.awayAt : 0;
    state.awayAt = null;
    state.lastTickAt = now;
    if (enabled() && awayFor >= 5 * 60_000 && !A.isDnd?.() && !A.meeting) {
      A.speak?.({ kind: 'speech', pri: 'low', text: '欢迎回来。刚才进行到哪儿了？', expr: 'happy', dur: 8500 });
    }
  });
  A.on('set:aiCompanion', () => { if (!enabled()) A.bubble?.hideSpeech?.(); });
  ['set:params', 'set:workFrom', 'set:workTo', 'set:freq'].forEach(event => A.on(event, () => {
    state.fired = {};
    A.save?.();
  }));

  // Browser preview has no native desktop tick, so it still exercises the same loop.
  if (!A.native) setInterval(() => tick(), 1000);
}
