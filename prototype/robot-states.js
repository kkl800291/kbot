/* 赛博伙伴 · 表情与状态：每个表情都是一组连续参数，状态切换时整组参数一起缓动，而不是淡入淡出 */
(function () {
  'use strict';
  const RB = window.RB;

  // 眼睛以“左眼、内侧为正”为基准，右眼由绘制时镜像。
  // a/b 半宽半高，r 圆角，rot 倾斜（内侧向下为正），hl 高光；
  // t*/b* 是上/下眼睑曲线 y = k0 + kS·x + kQ·x² + kA·|x|（x 归一到 -1~1，内侧为 +1，单位像素）
  const eye = (o = {}) => {
    const a = o.a ?? 9.5, b = o.b ?? 15;
    return Object.assign({
      a, b, r: Math.min(o.r ?? 99, a, b), rot: 0, ox: 0, oy: 0, hl: 0,
      t0: -b - 4, tS: 0, tQ: 0, tA: 0,
      b0: b + 4, bS: 0, bQ: 0, bA: 0,
    }, o, { a, b, r: Math.min(o.r ?? 99, a, b) });
  };
  // 笑眼 ^：apex 顶点高度，drop 两端下落，th 厚度
  const arch = (a, apex, drop, th, o) => ({ a, b: apex + 4, t0: -apex, tQ: drop, b0: -apex + th, bQ: drop, ...o });
  // 闭眼弧线：k>0 为 ∪（睡觉），k<0 为 ∩
  const closed = (a, y, k, th, o) => ({ a, b: 9, t0: y + k - th / 2, tQ: -k, b0: y + k + th / 2, bQ: -k, ...o });
  // 挤眼 > <：左眼转 90° 成 >，右眼镜像成 <
  const chev = (a, apex, drop, th, o) => ({ a, b: 12, r: 3, rot: 90, t0: -apex, tA: drop, b0: -apex + th, bA: drop, ...o });

  // 嘴：ma 半宽，mt/mb 上/下半厚，mk 弯曲（正为笑），mc 猫嘴 ω，mw 波浪，ms 左右斜度，my 纵向位置，mv 可见度，md 省略号
  const mouth = (o = {}) => Object.assign({ ma: 5, mt: 1.3, mb: 1.3, mk: 0, mc: 0, mw: 0, ms: 0, mx: 0, my: 22, mv: 1, md: 0 }, o);

  const pose = (o = {}) => ({
    head: Object.assign({ hw: 54, hh: 46, n: 3.4 }, o.head),
    eL: eye(o.eye),
    eR: eye(o.eyeR || o.eye),
    mo: mouth(o.mouth),
    // blush 腮红；bright 亮度；ears 耳朵外展角；tilt 头部倾斜；fl/fs 悬浮幅度与速度；sq0 静态压扁；ant 天线偏角；core 底座亮度
    m: Object.assign({ blush: 0, bright: 1, ears: 0, tilt: 0, fl: 2.2, fs: 1.9, sq0: 0, ant: 0, core: 0.6 }, o.misc),
  });
  const S = (label, o, flags) => Object.assign({ label, pose: pose(o) }, flags);

  const STATES = {
    idle: S('待机', { mouth: { ma: 4.6, mk: 2.2 } }, { idle: true }),
    talk: S('说话', { eye: { b: 14.5 }, mouth: { ma: 6, mt: 1.6, mb: 1.6, mk: 1.5 }, misc: { ears: 6, core: 0.8 } }, { enter: 'nod', talk: true }),
    think: S('思考', { eye: { a: 9, b: 13.5 }, mouth: { mv: 0, md: 1 }, misc: { ears: 10, ant: 6, tilt: 4, core: 0.9 } },
      { color: 'think', look: [0.6, -0.7], enter: 'ponder', pulse: 6 }),
    remind: S('提醒', { eye: { a: 10.5, b: 17 }, mouth: { ma: 3, mt: 2.8, mb: 2.8, my: 23 }, misc: { ears: 16, fl: 3, fs: 2.6, core: 1 } },
      { color: 'remind', enter: 'alert', loop: ['alert', 1.9], pulse: 6 }),
    happy: S('开心', { eye: arch(12, 12.5, 17, 10, { oy: 2 }), mouth: { ma: 7.5, mt: 1.4, mb: 4.5, mk: 2.5 }, head: { n: 3 }, misc: { blush: 0.8, ears: 12, fl: 3.5, fs: 3, core: 0.9 } },
      { enter: 'bounce', sparkle: true, speed: 1.2 }),
    surprised: S('惊讶', { eye: { a: 11.5, b: 16.5, hl: 0.7 }, mouth: { ma: 4, mt: 5.2, mb: 5.2, my: 23 }, head: { hh: 48, n: 3.2 }, misc: { ears: 24, fl: 1.2, core: 1 } },
      { enter: 'pop', speed: 1.8 }),
    coy: S('撒娇', { eye: { a: 11, b: 16.5, hl: 1, rot: -6 }, mouth: { ma: 7, mk: 3.6, mc: 1 }, misc: { blush: 1, ears: 4, tilt: -7, fl: 2.6, core: 0.8 } },
      { enter: 'shy', hearts: true, speed: 0.9 }),
    wink: S('淘气', { eye: { a: 9.5, b: 15 }, eyeR: arch(11, 9, 13, 6.5, { oy: 2 }), mouth: { ma: 6, mk: 2, ms: -3.2 }, misc: { blush: 0.4, ears: 8, tilt: 8, core: 0.8 } },
      { enter: 'wink' }),
    confused: S('疑惑', { eye: { a: 9.5, b: 15 }, eyeR: { a: 8, b: 9.5, oy: -4, rot: 10 }, mouth: { ma: 7.5, mw: 2, my: 23 }, misc: { ears: 4, tilt: -9, core: 0.6 } },
      { enter: 'tilt', question: true }),
    sad: S('委屈', { eye: { a: 9.5, b: 14.5, hl: 0.8, t0: -8, tS: -5 }, mouth: { ma: 6, mk: -4, my: 24 }, head: { hh: 44 },
      misc: { bright: 0.85, ears: -22, fl: 1.6, fs: 1.3, sq0: 0.05, core: 0.4 } }, { enter: 'slump', tear: true, speed: 0.6 }),
    annoyed: S('被戳', { eye: { a: 10, b: 13, t0: -9, tS: 9, oy: 1 }, mouth: { ma: 3.5, mk: -2.6, my: 23 }, head: { n: 4.2 }, misc: { ears: 18, fl: 1, sq0: 0.04, core: 1 } },
      { color: 'annoyed', enter: 'shake', speed: 1.5 }),
    sleepy: S('困倦', { eye: { a: 10, b: 14, t0: -2, tS: -2 }, mouth: { ma: 4, mk: 0.6 }, misc: { bright: 0.8, ears: -8, fl: 1.6, fs: 1.1, core: 0.35 } },
      { sleepy: true, speed: 0.7 }),
    sleep: S('睡觉', { eye: closed(10, 2, 3.2, 3, { oy: 3 }), mouth: { mv: 0 }, head: { n: 2.7 }, misc: { bright: 0.5, ears: -16, fl: 1.8, fs: 1.0, sq0: 0.03, core: 0.25 } },
      { color: 'sleep', zzz: true, sleeping: true, speed: 0.5 }),
    lifted: S('被拎起', { eye: chev(8.5, 6, 8, 4.6), mouth: { ma: 2.8, mt: 2.8, mb: 2.8, my: 23 }, misc: { ears: 32, fl: 0, sq0: -0.06, core: 1 } },
      { look: [0, 0.6], held: true }),
    hover: S('可以点我', { eye: { a: 10.5, b: 16.5, hl: 0.55 }, mouth: { ma: 6.5, mk: 4 }, misc: { blush: 0.35, ears: 14, tilt: 4, core: 0.85 } },
      { enter: 'perk' }),
    dnd: S('勿扰', { eye: { a: 10, b: 14, t0: 0, tS: -1 }, mouth: { ma: 4, mk: 0 }, misc: { bright: 0.6, ears: -10, fl: 1.4, fs: 1.1, core: 0.3 } },
      { color: 'dnd', moon: true, speed: 0.7 }),
  };

  RB.STATES = STATES;
  RB.eyeDefault = eye;
})();
