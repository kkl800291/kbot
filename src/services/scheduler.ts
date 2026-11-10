export interface Reminder {
  id: string;
  when: string;
  repeat: string;
  content: string;
  at: number | null;
  fired: boolean;
  snoozedUntil?: number;
}

export const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
export const isRepeating = (r: Pick<Reminder, 'repeat'>) => !!r.repeat && r.repeat !== '仅一次';

export function nextOccurrence(r: Pick<Reminder, 'when' | 'repeat'>, from: number, workday = (d: Date) => d.getDay() > 0 && d.getDay() < 6): number | null {
  const m = /(?:^|\s)(\d{1,2}):(\d{2})(?:$|\s)/.exec(r.when);
  if (!m || +m[1] > 23 || +m[2] > 59 || !isRepeating(r)) return null;
  const wk = /^每周([日一二三四五六])$/.exec(r.repeat);
  const dom = /^每月(\d{1,2})号$/.exec(r.repeat);
  if (dom && (+dom[1] < 1 || +dom[1] > 31)) return null;
  for (let i = 0; i < 400; i++) {
    const date = new Date(from);
    date.setDate(date.getDate() + i);
    date.setHours(+m[1], +m[2], 0, 0);
    if (date.getTime() <= from) continue;
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    if (r.repeat === '每天' || (r.repeat === '每个工作日' && workday(date)) ||
      (wk && '日一二三四五六'[date.getDay()] === wk[1]) ||
      (dom && date.getDate() === Math.min(+dom[1], lastDay))) return date.getTime();
  }
  return null;
}

export function resolveAt(when: string, now: number): number | null {
  // A confirmed absolute date must retain its year across app restarts.
  const iso = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(when);
  if (iso) {
    const d = new Date(+iso[1], +iso[2] - 1, +iso[3], +iso[4], +iso[5], +(iso[6] || 0));
    return d.getFullYear() === +iso[1] && d.getMonth() === +iso[2] - 1 && d.getDate() === +iso[3] && +iso[4] < 24 && +iso[5] < 60 && +(iso[6] || 0) < 60 ? +d : null;
  }
  const time = /(\d{1,2}):(\d{2})/.exec(when);
  if (!time || +time[1] > 23 || +time[2] > 59) return null;
  const d = new Date(now); d.setHours(+time[1], +time[2], 0, 0);
  const relative = /^(今天|明天|后天)/.exec(when);
  const md = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(when);
  if (relative) d.setDate(d.getDate() + ({ 今天: 0, 明天: 1, 后天: 2 }[relative[1]] || 0));
  else if (md) {
    const month = +md[1], day = +md[2];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    d.setMonth(month - 1, day);
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    if (+d < now) d.setFullYear(d.getFullYear() + 1);
  } else return null;
  return +d;
}

export function validateReminder(r: Pick<Reminder, 'when' | 'repeat' | 'content'>, now: number, workday?: (d: Date) => boolean): number {
  if (!r.content.trim() || r.content.length > 500) throw new Error('请填写 1–500 字的提醒内容');
  const at = isRepeating(r) ? nextOccurrence(r, now, workday) : resolveAt(r.when, now);
  if (!at || at <= now) throw new Error('提醒时间无效或已经过去，请修改后再保存');
  return at;
}

export class SpeechBudget {
  private history: { at: number; idle: boolean }[] = [];
  ignored = 0;
  allows(now: number, priority: string, idle: boolean, frequency: string): boolean {
    if (priority === 'high') return true;
    this.history = this.history.filter(h => now - h.at < 3600_000);
    const limits = frequency === 'low' ? [2, 2] : frequency === 'high' ? [8, 36] : [4, 18];
    const last = this.history.at(-1);
    if (last && now - last.at < 45_000) return false;
    const same = this.history.filter(h => h.idle === idle);
    if (same.length >= limits[idle ? 1 : 0]) return false;
    const gap = idle ? (frequency === 'low' ? 900_000 : frequency === 'high' ? 60_000 : 120_000) * (1 + Math.min(this.ignored, 3) * .25) : 300_000;
    if (same.length && now - same.at(-1)!.at < gap) return false;
    return true;
  }
  record(now: number, priority: string, idle: boolean) {
    if (priority === 'high') return;
    this.history.push({ at: now, idle });
  }
}

export class ActivityClock {
  workSeconds = 0;
  waterSeconds = 0;
  eyeSeconds = 0;
  awaySeconds = 0;
  update(elapsed: number, idleSeconds: number, restMinutes: number, resting: boolean): number {
    // Long gaps are suspension, never retroactive work or a burst of reminders.
    if (elapsed < 0 || elapsed > 10) return 0;
    if (idleSeconds >= 60) {
      this.awaySeconds = idleSeconds;
      if (idleSeconds >= restMinutes * 60) {
        const minutes = Math.floor(this.workSeconds / 60);
        this.workSeconds = 0;
        return minutes;
      }
      return 0;
    }
    this.awaySeconds = 0;
    if (!resting) this.workSeconds += elapsed;
    this.waterSeconds += elapsed;
    this.eyeSeconds += elapsed;
    return 0;
  }
  resetWork() { this.workSeconds = 0; }
}
