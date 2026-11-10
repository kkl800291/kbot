/* 赛博伙伴 · 大脑：话术库、各类提醒、休息流程与倒计时、自定义提醒与记忆 */
(function () {
  'use strict';
  const A = window.App, robot = A.robot;
  const B = A.brain = {};
  A.muted = {};
  // 首次打开时放几条示例数据，方便看到列表的样子；之后以本机保存的为准
  const DAY_MS = 864e5;
  A.reminders = (A.stored.reminders || [
    { id: 'seed-r1', when: '每周三 15:00', repeat: '每周三', content: '交周报', at: null, fired: false },
    { id: 'seed-r2', when: '工作日 18:20', repeat: '每个工作日', content: '把今天的事收个尾', at: null, fired: false },
  ]).map(r => Object.assign({}, r));
  A.memories = (A.stored.memories || [
    { id: 'seed-m1', text: '喜欢热美式，不喝冰的', t: Date.now() - 3 * DAY_MS },
    { id: 'seed-m2', text: '周五下班后要去健身', t: Date.now() - DAY_MS },
  ]).slice();
  A.builtin = Object.assign({ rest: true, water: true, eye: false, lunch: true, offwork: true, night: true, morning: true }, A.stored.builtin || {});
  A.persisters.reminders = () => A.reminders;
  A.persisters.memories = () => A.memories;
  A.persisters.builtin = () => A.builtin;

  // param：设置页里可调的参数（路径、类型、单位）；desc 读取当前参数
  const P = () => A.S.params;
  A.BUILTINS = [
    { k: 'rest', name: '休息', desc: () => `每工作 ${A.S.work} 分钟，休息 ${A.S.rest} 分钟（在上方「休息规则」里改）` },
    { k: 'water', name: '喝水', desc: () => `工作时间内每 ${P().waterEvery} 分钟，离开期间不累计`, param: { path: 'params.waterEvery', type: 'num', min: 15, max: 180, unit: '分钟' } },
    { k: 'eye', name: '远眺护眼', desc: () => `每 ${P().eyeEvery} 分钟看远处 20 秒`, param: { path: 'params.eyeEvery', type: 'num', min: 10, max: 90, unit: '分钟' } },
    { k: 'lunch', name: '点外卖', desc: () => `工作日 ${P().lunchAt}，加班时 17:30 再提醒一次`, param: { path: 'params.lunchAt', type: 'time' } },
    { k: 'offwork', name: '下班', desc: () => `工作日下班前 ${P().offworkLead} 分钟（${A.S.workTo} 下班）`, param: { path: 'params.offworkLead', type: 'num', min: 5, max: 60, unit: '分钟前' } },
    { k: 'night', name: '深夜', desc: () => `${P().nightAt} 后仍在用电脑，每晚最多 2 次`, param: { path: 'params.nightAt', type: 'time' } },
    { k: 'morning', name: '早安', desc: () => '当天第一次使用电脑时，附日期、节气和天气' },
  ];

  // ---- 话术：默认“可爱淘气”，其余性格给出主要几条；正式版由大模型按人设生成，这里是本地兜底库 ----
  const LINES = {
    water: {
      cute: ['你已经 50 分钟没喝水啦，再不喝我就要干巴了。', '喝一口嘛，就一口～ 我看着你喝。'],
      gentle: ['该喝点水了，润润嗓子吧。'], lively: ['补水时间到！咕咚咕咚走起～'], quiet: ['喝水时间。'],
    },
    rest: {
      cute: ['站起来伸个懒腰嘛，我帮你看着屏幕，它跑不掉的。', '眼睛也要休息啦，去走两步，我在这儿等你。'],
      gentle: ['你已经工作很久了，起来活动一下吧。'], lively: ['起立起立！伸个大大的懒腰！'], quiet: ['该休息了。'],
    },
    lunch: {
      cute: ['11 点 15 啦！现在下单，饭能比别人先到哦。'],
      gentle: ['快到午饭时间了，可以先点餐啦。'], lively: ['干饭预备！现在下单最快！'], quiet: ['该点午饭了。'],
    },
    offwork: {
      cute: ['快下班啦～ 把手头的收个尾，今天的你也辛苦啦。'],
      gentle: ['马上下班了，今天辛苦了。'], lively: ['胜利在望！收尾收尾～'], quiet: ['10 分钟后下班。'],
    },
    night: {
      cute: ['已经很晚了……你不睡我也不敢睡，快去睡嘛。'],
      gentle: ['夜深了，早点休息吧，明天再继续。'], lively: ['月亮都出来打卡啦，该睡觉咯！'], quiet: ['已过 23:30，该睡了。'],
    },
    eye: { cute: ['看看远处吧，20 秒就好，眼睛会谢谢你的。'] },
    term: { cute: ['今天小雪～ 天气渐冷，晚上来碗热汤吧。', '小雪到啦，记得添衣服，别让我替你打喷嚏。'] },
    idle: {
      cute: ['这个点最容易犯困，我先替你打个哈欠……哈——欠——', '外面下雨啦，我们俩躲在屏幕里，谁也淋不着。', '你和这个编辑器已经对视两小时了，我要吃醋了哦。'],
    },
    back: { cute: ['你回来啦！刚才没人陪我，我数了 300 次像素。'] },
    lonely: { cute: ['你是不是把我忘了……没关系，我自己玩。'] },
  };
  const lastPick = {};
  B.line = kind => {
    const set = LINES[kind], arr = set[A.S.persona] || set.cute;
    let t = arr[Math.floor(Math.random() * arr.length)];
    if (arr.length > 1 && t === lastPick[kind]) t = arr[(arr.indexOf(t) + 1) % arr.length];
    return (lastPick[kind] = t);
  };
  const nick = () => (A.S.nickname && A.S.nickname !== '你' ? '，' + A.S.nickname : '');
  const morningText = () => {
    const d = new Date();
    return `早安呀${nick()}！今天 ${d.getMonth() + 1} 月 ${d.getDate()} 日，周${'日一二三四五六'[d.getDay()]}。多云，12~19°C，傍晚可能有小雨，出门带把伞～`;
  };
  const birthdayText = () => {
    const b = (A.birthdays || [])[0];
    return b ? `${b.lead ? '明天' : '今天'}是${b.name}的生日哦！要不要我提醒你准备礼物？` : '你还没有添加生日，可以在 设置 → 日期 里加上，我会提前提醒你。';
  };

  const META = {
    rest: { kind: 'rest', pri: 'mid', title: '休息一下吧', label: '休息' },
    water: { kind: 'remind', pri: 'mid', title: '喝水提醒', label: '喝水' },
    eye: { kind: 'remind', pri: 'mid', title: '远眺护眼', label: '护眼' },
    lunch: { kind: 'remind', pri: 'mid', title: '点外卖啦', label: '点外卖' },
    offwork: { kind: 'remind', pri: 'mid', title: '快下班了', label: '下班' },
    night: { kind: 'remind', pri: 'mid', title: '该睡觉啦', label: '睡觉' },
    morning: { kind: 'speech', pri: 'mid', expr: 'happy', label: '早安' },
    term: { kind: 'speech', pri: 'mid', expr: 'happy', label: '节气' },
    birthday: { kind: 'remind', pri: 'mid', title: '生日提醒', label: '生日' },
    idle: { kind: 'speech', pri: 'low', expr: 'wink', label: '自言自语' },
    back: { kind: 'speech', pri: 'mid', expr: 'happy', label: '欢迎回来' },
    lonely: { kind: 'speech', pri: 'low', expr: 'sad', label: '被冷落' },
  };

  function snooze(key, again) {
    const ms = 600000 / A.S.speed;
    A.toast(A.S.speed > 1 ? `好的，10 分钟后再提醒你（演示加速，${Math.round(ms / 1000)} 秒后）` : '好的，10 分钟后再提醒你', 3000);
    setTimeout(again, ms);
  }
  const std = (key, label, again) => [
    { label: '好的', primary: true, fn: () => A.toast('收到～') },
    { label: '过 10 分钟再说', fn: () => snooze(key, again), quiet: true },
    { label: '今天别提醒了', fn: () => { A.muted[key] = true; A.toast(`好的，今天不再提醒「${label}」了`); }, expr: 'wink' },
  ];

  // ---- 休息：提醒 → 开始休息（倒计时）→ 结束；工作计时随之清零 ----
  let workStart = Date.now() - 42 * 60000;
  A.workInfo = () => {
    const minutes = Math.floor((Date.now() - workStart) / 60000);
    return { minutes, nextIn: Math.max(0, A.S.work - minutes) };
  };
  function startRest() {
    const R = A.rest;
    R.phase = 'resting'; R.left = R.total; R.warned = false;
    A.setBase('sleepy');
    A.speak({
      kind: 'rest', pri: 'high', title: '休息中', text: '放松肩膀，看看远处～ 我在这儿陪你。', ring: true, sticky: true,
      actions: [{ label: '提前结束', fn: () => endRest(true), quiet: true }],
    });
  }
  function endRest(early) {
    const R = A.rest;
    if (R.phase !== 'resting') return;
    R.phase = 'idle'; workStart = Date.now();
    A.bubble.hide(true);
    A.setBase(A.isDnd() ? 'dnd' : 'idle');
    robot.flash('happy', 2600);
    A.say(early ? '好吧，那我们继续～ 累了再叫我。' : '休息结束啦！精神一点了吗？继续加油～', { pri: 'high', expr: 'happy' });
    A.emit('rest:end');
  }
  setInterval(() => {
    const R = A.rest;
    if (R.phase === 'resting') {
      R.left -= A.S.speed;
      if (R.left <= 0) { R.left = 0; A.emit('rest:tick'); endRest(false); return; }
    }
    A.emit('rest:tick');
  }, 1000);

  B.restTouch = () => {
    const R = A.rest;
    if (R.phase !== 'resting') { A.toast('先触发「休息提醒」并点「好的，去休息」，休息中才会有这条轻声提醒', 3200); return; }
    if (R.warned) { A.toast('休息中的轻声提醒只会出现一次'); return; }
    R.warned = true; robot.flash('coy', 3000);
    const t = '还在休息时间哦～ 再歇一会儿嘛，我帮你盯着。';
    if (A.panel.isOpen()) A.chat.pushPro({ kind: 'speech', text: t });
    else if (!A.bubble.flashText(t, 5000)) A.say(t, { pri: 'high', expr: 'coy' });
  };

  // ---- 触发各类提醒（演示控制台、定时器共用）----
  B.fire = kind => {
    const meta = META[kind]; if (!meta) return;
    if (A.builtin[kind] === false) { A.toast(`「${meta.label}」提醒在设置里被关闭了`); return; }
    if (A.muted[kind]) { A.toast(`你说过今天不再提醒「${meta.label}」，这次已跳过`); return; }
    // 勿扰中被攒下的提醒，结束后重新走一遍 fire（休息提醒要重新进入“提示中”状态）；日期类当天有效，健康类默认 30 分钟
    const ev = { kind: meta.kind, pri: meta.pri, title: meta.title, expr: meta.expr, again: () => B.fire(kind), ttl: ['birthday', 'term', 'morning'].includes(kind) ? 12 * 3600000 : 0 };
    ev.text = kind === 'morning' ? morningText() : kind === 'birthday' ? birthdayText() : B.line(kind);
    if (kind === 'rest') {
      const R = A.rest;
      R.total = A.S.rest * 60; R.left = R.total;
      Object.assign(ev, {
        ring: true, title: `休息一下吧 · ${A.S.rest} 分钟`,
        actions: [
          { label: '好的，去休息', primary: true, fn: startRest, quiet: true },
          { label: '过 10 分钟再说', fn: () => { R.phase = 'idle'; snooze('rest', () => B.fire('rest')); }, quiet: true },
          { label: '跳过这次', fn: () => { R.phase = 'idle'; workStart = Date.now(); A.toast('好的，这次先跳过，工作计时从现在重新算'); }, expr: 'wink' },
        ],
        onExpire: () => { if (R.phase === 'prompt') R.phase = 'idle'; },
      });
    } else if (kind === 'birthday') {
      ev.actions = [
        { label: '知道啦', primary: true, fn: () => A.toast('收到～') },
        { label: '明天当天再提醒我', fn: () => A.toast('好的，明天早上再提醒你'), quiet: true },
      ];
    } else if (meta.kind === 'remind') ev.actions = std(kind, meta.label, () => B.fire(kind));
    const ok = A.speak(ev);
    if (kind === 'rest' && ok) A.rest.phase = 'prompt';
  };

  // ---- 自定义提醒（聊天里或设置里创建）----
  // repeat 取值：仅一次 / 每天 / 每个工作日 / 每周X / 每月N号；重复提醒的 at 始终指向“下一次”
  const timers = {}, WD = '日一二三四五六';
  const repeating = r => !!r.repeat && r.repeat !== '仅一次';
  B.nextOccurrence = (r, from = Date.now()) => {
    const m = /(\d{1,2}):(\d{2})/.exec(r.when || '');
    if (!m || !repeating(r)) return null;
    const wk = /^每周([日一二三四五六])$/.exec(r.repeat), dom = /^每月(\d+)号$/.exec(r.repeat);
    for (let i = 0; i < 400; i++) {
      const d = new Date(from); d.setDate(d.getDate() + i); d.setHours(+m[1], +m[2], 0, 0);
      if (d.getTime() <= from) continue;
      const dow = d.getDay(), dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      // 每月 31 号遇到只有 30 天的月份，改在当月最后一天
      if (r.repeat === '每天' || (r.repeat === '每个工作日' && dow >= 1 && dow <= 5) || (wk && WD[dow] === wk[1]) || (dom && d.getDate() === Math.min(+dom[1], dim))) return d.getTime();
    }
    return null;
  };
  // 一次性提醒被改过时间文字后，按“今天/明天/后天/M 月 D 日 + 时:分”重新算出触发时刻；认不出来就返回 null
  B.resolveAt = (when, now = Date.now()) => {
    const t = /(\d{1,2}):(\d{2})/.exec(when || ''); if (!t) return null;
    const d = new Date(now); d.setHours(+t[1], +t[2], 0, 0);
    const rel = /^(今天|明天|后天)/.exec(when), md = /^(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(when);
    if (rel) d.setDate(d.getDate() + { 今天: 0, 明天: 1, 后天: 2 }[rel[1]]);
    else if (md) { d.setMonth(+md[1] - 1, +md[2]); if (d.getTime() < now) d.setFullYear(d.getFullYear() + 1); }
    else return null;
    return d.getTime();
  };
  const settle = rem => { rem.at = repeating(rem) ? B.nextOccurrence(rem) : (rem.at || B.resolveAt(rem.when)); };
  function schedule(r) {
    clearTimeout(timers[r.id]);
    if (!r.at || r.fired) return;
    const d = r.at - Date.now();
    if (d < 0 || d > 2147483000) return;
    timers[r.id] = setTimeout(() => B.fireReminder(r), d);
  }
  B.addReminder = r => {
    const rem = { id: A.uid(), when: r.when, repeat: r.repeat, content: r.content, at: r.at || null, fired: false };
    settle(rem);
    A.reminders.push(rem); schedule(rem); A.save(); A.emit('reminders');
    return rem;
  };
  B.updateReminder = (id, r) => {
    const rem = A.reminders.find(x => x.id === id); if (!rem) return;
    Object.assign(rem, { when: r.when, repeat: r.repeat, content: r.content, at: r.at || null, fired: false });
    settle(rem);
    schedule(rem); A.save(); A.emit('reminders');
  };
  B.removeReminder = id => {
    clearTimeout(timers[id]);
    A.reminders = A.reminders.filter(r => r.id !== id); A.save(); A.emit('reminders');
  };
  // o.again：稍后再提醒（不推进计划）；o.demo：演示触发（不改变任何计划）
  B.fireReminder = (r, o = {}) => {
    const key = 'custom:' + r.id;
    if (A.muted[key]) { A.toast('这条提醒今天已设为不再提醒'); return; }
    if (!o.again && !o.demo && r.at) {
      if (repeating(r)) { r.at = B.nextOccurrence(r, Math.max(Date.now(), r.at)); schedule(r); } else r.fired = true;
      A.save(); A.emit('reminders');
    }
    A.speak({
      kind: 'remind', pri: 'high', title: '你设的提醒', text: `叮咚～ 时间到啦：${r.content}`,
      actions: [
        { label: '好的', primary: true, fn: () => A.toast('收到～') },
        { label: '过 10 分钟再说', fn: () => snooze(key, () => B.fireReminder(r, { again: true })), quiet: true },
        { label: '今天别提醒了', fn: () => { A.muted[key] = true; A.toast('好的，今天不再提醒这一条了'); }, expr: 'wink' },
      ],
    });
  };
  B.fireDemoReminder = () => {
    const last = A.reminders.filter(r => !r.fired).pop() || A.reminders[A.reminders.length - 1];
    B.fireReminder(last || { id: 'demo', content: '给老王回电话' }, { demo: true });
  };

  // ---- 记忆（聊天里确认后保存）----
  B.addMemory = text => { A.memories.push({ id: A.uid(), text, t: Date.now() }); A.save(); A.emit('memories'); };
  B.updateMemory = (id, text) => { const m = A.memories.find(x => x.id === id); if (m) { m.text = text; A.save(); A.emit('memories'); } };
  B.removeMemory = id => { A.memories = A.memories.filter(m => m.id !== id); A.save(); A.emit('memories'); };
  B.clearMemories = () => { A.memories = []; A.save(); A.emit('memories'); };

  A.init(() => {
    const now = Date.now(), missed = [];
    A.reminders.forEach(r => {
      if (r.fired) return;
      if (!r.at && repeating(r)) r.at = B.nextOccurrence(r, now);
      if (!r.at) return;
      if (r.at > now) { schedule(r); return; }
      missed.push(r);
      if (repeating(r)) { r.at = B.nextOccurrence(r, now); schedule(r); } else r.fired = true;
    });
    if (missed.length) {
      setTimeout(() => A.speak({
        kind: 'remind', pri: 'high', title: '错过的提醒', text: `你不在的时候错过了 ${missed.length} 个提醒：${missed.map(r => r.content).join('、')}。`,
        actions: [{ label: '知道啦', primary: true }],
      }), 1500);
    }
  });
})();
