/* KBOT · 光纹生命体 · 让它活着
 * 形体只有一个（pose.js 描下来的那一个）。它不是一张会晃的图，是一条浸在水流里的绸带：
 *   波   —— 从左翼传到右翼，一直在走。翼尖比身体慢半拍，会甩过头再回来。
 *   光   —— 一道一道从身上流过去，经过的地方亮起来、鼓一下。思考时光在环上循环。
 *   丝   —— 在纱面上各走各的，纹理一直在重新织。
 *   意愿 —— 待命时自己会微调呼吸、流过光波；只有待命且指针靠近时才微微侧目致意，倾听和思考时不分心。
 * 中间那个空洞只是绸带绕出来的环，不是器官，不开合。
 * 它平时把自己卷成一个球住着。同一条绸带，卷起来是球，松开是概念图上那条舒展的带子，中间的样子都是它。
 *   待命 —— 凝练、沉稳的球：缓慢而有节奏地自转，内部纹理如呼吸般微微流动，不轻浮晃动。
 *   倾听 —— 朝说话的人敞开，两端扬起来，目光稳稳对着下方输入框，不被指针带偏。
 *   思考 —— 收紧成一个规整的球，匀速自转，一丝不乱，完全屏蔽外界干扰。
 *   说话 —— 像待命那样松着；光随着话音从中间一圈圈荡出去，球跟着微微鼓一下。
 *   提醒 —— 凑近、亮起来、带一点琥珀色，隔一阵轻轻叩两下。
 *   出错 —— 暗下来、沉一点、带一点红，几乎不转。
 * 回复里的表情（开心、惊讶、困惑、难过、困、不耐烦）是叠在当前状态上的一小段，过了就退。
 * 进出场也不是开合：入场是绸带从左甩到右，先是雾、再对上焦，稳稳落定。
 */

const TAU = 6.2831853;
const CX = 765, CY = 345;            // 身体的中心（姿态坐标）
const HALF = 470;                    // 身体半长：卷成球时，它绕球一周
const WRAP = 3.33, AXIS = 0.34;      // 卷满时绕过的角度（略多于半圈，两端在背面叠上）；球的轴朝观看者倾过来的角度
const FACE = 0.7;                    // 球平时朝外的那一面：转过这么多，正对着的是绸带拧出来的那道 S 形；0 是中间敞着的那一面
const X0 = 290, SPAN = 980;          // 身体从左到右的范围，流光的位置用 0..1 表示
const PIVOT_R = [950, 338], PIVOT_L = [510, 343];  // 两翼各自绕着转的点
const FLY_FROM = [1090, 392];        // 领命时最后收拢的地方（右翼）
const YAWN = 5.6;                    // 伸一个懒腰多少秒

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

/**
 * 三个状态。
 * spread 横向舒展；size 整体大小；curl 卷成球的程度（0 平铺，1 是球）；arch 两端下垂（正）或扬起（负）；spin 球自转的速度（弧度每秒）；
 * sway 自转快一阵慢一阵的程度（0 是匀速）；face 球的哪一面朝外（弧度）；nod 朝观看者低头的角度；drift 样子自己游移的幅度：球的轴在晃、球面像水泡一样微微变形；liftR/liftL 右翼、左翼抬起的角度（弧度，负数是往上）；reachR 右翼伸出去多长；
 * tilt 整体倾斜；rise 整体上浮（像素，负数是往上）；twist 上下两半拧紧；think 思考专属的丝束；
 * wave 身体里波的大小；waveRate 波走多快；wander 丝在纱面上游走的幅度；flow 丝游走的速度；billow 纱面宽窄的起伏；
 * pulseEvery 每隔几秒一道流光（0 是不自己发）；pulseSpeed 流光走多快；pulseGain 多亮；pulseWidth 多宽；steady 间隔和速度是否分毫不差；
 * glow 结点的光；thread 丝的亮度；dofR 右翼的对焦范围往外推多少；acts 会不会自己做小动作。
 * 只有个别状态用到的：lum 整体亮度；shade 染色的程度，hue 染成什么颜色；speak 随话音起伏；knock 隔一阵叩两下。
 */
const AMBER = [1.0, 0.76, 0.42], RED = [1.0, 0.38, 0.42];
export const STATES = {
  // 待命：松松地卷成一个软球，慢悠悠地转；纱在球面上缓缓起伏，隔一阵有一道光流过；偶尔伸个懒腰
  idle: { spread: 1, size: 1.24, curl: 1, arch: 0, spin: 0.15, sway: 1, face: FACE, nod: 0, drift: 1, liftR: 0, liftL: 0, reachR: 0, tilt: -0.1, rise: 50, twist: 0, think: 0, wave: 0.95, waveRate: 0.85, wander: 1, flow: 0.55, billow: 0.08, pulseEvery: 5, pulseSpeed: 0.3, pulseGain: 0.7, pulseWidth: 125, steady: 0, glow: 1, thread: 0.9, dofR: 0, acts: 1 },
  // 倾听：不转了，把敞着的那一面转过来对着说话的人，凑近一点、朝输入框低一点头；身体静下来，等着对方的声音在身上激起涟漪
  listen: { spread: 1, size: 1.31, curl: 1, arch: 0, spin: 0, sway: 0, face: -0.15, nod: 0.13, drift: 0.22, liftR: 0, liftL: 0, reachR: 0, tilt: -0.03, rise: 64, twist: 0, think: 0, wave: 0.36, waveRate: 0.7, wander: 0.55, flow: 0.35, billow: 0.05, pulseEvery: 0, pulseSpeed: 0.9, pulseGain: 0.7, pulseWidth: 85, steady: 0, glow: 1.14, thread: 1.06, dofR: 0, acts: 0 },
  // 思考：把自己卷成一个球，匀速、缓慢地自转；光沿着球面一圈一圈地走，间隔分毫不差。慢，稳，不慌
  think: { spread: 1, size: 1.16, curl: 1, arch: 0, spin: 0.3, sway: 0, face: FACE, nod: 0, drift: 0, liftR: 0, liftL: 0, reachR: 0, tilt: -0.2, rise: 46, twist: 0, think: 0.7, wave: 0.26, waveRate: 0.45, wander: 0.5, flow: 0.28, billow: 0.04, pulseEvery: 2.8, pulseSpeed: 0.19, pulseGain: 0.75, pulseWidth: 95, steady: 1, glow: 0.9, thread: 0.86, dofR: 0, acts: 0 },
  // 说话：和待命是同一个松着的球，转得稍快一点；自己不定时发光，光跟着话音走
  talk: { spread: 1, size: 1.27, curl: 1, arch: 0, spin: 0.2, sway: 0.5, face: FACE, nod: 0, drift: 0.6, liftR: 0, liftL: 0, reachR: 0, tilt: -0.06, rise: 54, twist: 0, think: 0, wave: 0.8, waveRate: 1.05, wander: 1, flow: 0.7, billow: 0.1, pulseEvery: 0, pulseSpeed: 0.3, pulseGain: 0.7, pulseWidth: 125, steady: 0, glow: 1.1, thread: 1, dofR: 0, acts: 0, speak: 1 },
  // 提醒：不转，凑近、亮起来，染一点琥珀色；隔一阵轻轻叩两下
  remind: { spread: 1, size: 1.3, curl: 1, arch: 0, spin: 0, sway: 0, face: 0.3, nod: 0.1, drift: 0.3, liftR: 0, liftL: 0, reachR: 0, tilt: 0, rise: 58, twist: 0, think: 0, wave: 0.5, waveRate: 0.8, wander: 0.7, flow: 0.45, billow: 0.06, pulseEvery: 0, pulseSpeed: 0.9, pulseGain: 0.7, pulseWidth: 85, steady: 0, glow: 1.22, thread: 1.08, dofR: 0, acts: 0, knock: 1, shade: 0.34, hue: AMBER },
  // 出错：暗下来、缩一点、沉一点，染一点红；几乎不转，身上的波也快停了
  error: { spread: 1, size: 1.1, curl: 1, arch: 0, spin: 0.05, sway: 0, face: FACE, nod: -0.06, drift: 0.25, liftR: 0, liftL: 0, reachR: 0, tilt: -0.16, rise: 66, twist: 0, think: 0, wave: 0.3, waveRate: 0.5, wander: 0.4, flow: 0.22, billow: 0.03, pulseEvery: 0, pulseSpeed: 0.3, pulseGain: 0.5, pulseWidth: 110, steady: 0, glow: 0.7, thread: 0.72, dofR: 0, acts: 0, lum: 0.7, shade: 0.6, hue: RED },
};
const EXTRA = { lum: 1, shade: 0, hue: null, speak: 0, knock: 0 };
for (const k in STATES) STATES[k] = { ...EXTRA, ...STATES[k] };

/**
 * 回复里的表情。dur 秒数；lum 亮度增减；shade、hue 染色；rise 往下沉多少；nod 低头；slow 身上的流动放慢到几成。
 * 开头那一下的动作（鼓一下、歪一下）写在 accent() 里。
 */
export const ACCENTS = {
  happy: { dur: 1.6, lum: 0.22 },
  surprised: { dur: 1.2, lum: 0.12 },
  confused: { dur: 2.2 },
  sad: { dur: 3, lum: -0.3, rise: 14, nod: 0.08 },
  sleepy: { dur: 3, lum: -0.24, rise: 8, nod: 0.12, slow: 0.55 },
  annoyed: { dur: 1.8, shade: 0.4, hue: RED },
  done: { dur: 1.1, lum: 0.3 },
};
const SPRUNG = ['spread', 'size', 'curl', 'arch', 'spin', 'sway', 'face', 'nod', 'drift', 'liftR', 'liftL', 'reachR', 'tilt', 'rise', 'twist', 'think', 'wave', 'waveRate', 'wander', 'flow', 'billow', 'glow', 'thread', 'dofR', 'lum', 'shade'];
const TIPS = ['liftR', 'liftL', 'reachR', 'twist'];   // 这几个量在翼尖上另有一套更慢、更松的弹簧
const STEADY = { curl: [2.7, 1], arch: [3, 0.85], spin: [1.6, 1], sway: [1.6, 1], face: [3.4, 1], nod: [3.4, 0.8], size: [3.4, 0.82], rise: [3.4, 0.82], tilt: [3, 1] };   // 这几个量慢慢来，不回弹：卷起来是件郑重的事

const ease = {
  linear: u => u,
  outCubic: u => 1 - (1 - u) ** 3,
  outSine: u => Math.sin(u * Math.PI / 2),
  inCubic: u => u * u * u,
  inOut: u => (u < 0.5 ? 4 * u * u * u : 1 - ((-2 * u + 2) ** 3) / 2),
  inOutSine: u => 0.5 - 0.5 * Math.cos(Math.PI * u),
  outBack: u => 1 + 1.25 * (u - 1) ** 3 + 0.25 * (u - 1) ** 2,   // 克制地微微胀开一点即落定，不做弹跳
};

const GONE = { alpha: 0, focus: 1, veil: 0, flash: 0, fly: 0, headX: 1e9, focusX: 1e9, hideX: -1e9, sweep: 0, whip: 0, tip: 0, slack: 0, grow: 1 };
const HERE = { ...GONE, alpha: 1, veil: 1 };

/**
 * 进出场的编排。每个量是一串 [目标值, 开始秒, 结束秒, 缓动]；pre 是开演前先摆好的值；cue 是到点触发的事。
 * alpha 在场；veil 桌面静下来的程度；flash 漫开的柔光；
 * headX 绸带甩出去的前端；tip 前端收成一束的程度；focusX 对焦的前沿；whip 刚甩出来时的抖动；sweep 前端上的那道亮；
 * slack 松开、被水流带走；hideX 从左往右收走的前沿；fly 最后那一缕飞向顶部栏；grow 整体大小（像吹起一个泡）。
 */
export const SCRIPTS = {
  // 入场：像吹起一个泡。一缕光绕着圈长出来，身后先是雾、跟着对上焦；泡鼓到稍微过头再收回来，颤两下落定，一道光绕着球走一圈
  arrive: {
    dur: 1.7, fresh: true,
    pre: { alpha: 0, headX: 200, focusX: 60, whip: 1, tip: 1, sweep: 0.5, flash: 0, fly: 0, hideX: -1e9, slack: 0, grow: 0.42 },
    grow: [[1, 0.02, 0.95, ease.outBack]],
    veil: [[1, 0, 0.5, ease.outCubic]],
    alpha: [[1, 0, 0.1, ease.linear]],
    headX: [[1600, 0.02, 0.8, ease.outSine]],
    tip: [[0, 0.5, 1.15, ease.inOutSine]],
    focusX: [[1900, 0.2, 1.15, ease.inOutSine]],
    sweep: [[0, 0.6, 0.95, ease.linear]],
    whip: [[0, 0.3, 1.6, ease.outCubic]],
    flash: [[1, 0.3, 0.62, ease.outCubic], [0, 0.62, 1.7, ease.outCubic]],
    cue: [[0.86, 'settle']],
  },
  // 短时间内再次召唤：同一个动作，快一倍多
  arriveShort: {
    dur: 0.75, fresh: true,
    pre: { alpha: 0, headX: 250, focusX: 220, whip: 0.5, tip: 1, sweep: 0.4, flash: 0, fly: 0, hideX: -1e9, slack: 0, grow: 0.66 },
    grow: [[1, 0, 0.5, ease.outBack]],
    cue: [[0.4, 'settleShort']],
    veil: [[1, 0, 0.26, ease.outCubic]],
    alpha: [[1, 0, 0.06, ease.linear]],
    headX: [[1600, 0, 0.36, ease.outSine]],
    tip: [[0, 0.2, 0.5, ease.inOutSine]],
    focusX: [[1900, 0.05, 0.5, ease.inOutSine]],
    sweep: [[0, 0.28, 0.45, ease.linear]],
    whip: [[0, 0.1, 0.7, ease.outCubic]],
    flash: [[0.45, 0.1, 0.3, ease.outCubic], [0, 0.3, 0.75, ease.outCubic]],
  },
  // 小头像的入场和退场：常驻条、通知一出现它就在，一收回它就走，不演雾和对焦那一套（那么小也看不清，只会显得拖沓）
  arriveTiny: {
    dur: 0.42, fresh: true,
    pre: { alpha: 0, headX: 1e9, focusX: 1e9, whip: 0, tip: 0, sweep: 0, flash: 0, fly: 0, hideX: -1e9, slack: 0, grow: 0.74 },
    alpha: [[1, 0, 0.24, ease.outCubic]],
    grow: [[1, 0, 0.42, ease.outCubic]],
    veil: [[1, 0, 0.24, ease.outCubic]],
  },
  closeTiny: {
    dur: 0.26,
    pre: { headX: 1e9, focusX: 1e9 },
    alpha: [[0, 0, 0.24, ease.inOutSine]],
    grow: [[0.86, 0, 0.26, ease.inOutSine]],
    veil: [[0, 0, 0.24, ease.inOut]],
  },
  // 安静退场：从右到左松开、失焦，化回雾，被水流带走
  close: {
    dur: 0.58,
    pre: { focusX: 1700, headX: 1e9 },
    focusX: [[-300, 0, 0.4, ease.inOutSine]],
    slack: [[1, 0, 0.58, ease.outCubic]],
    grow: [[0.9, 0, 0.58, ease.inOutSine]],
    alpha: [[0, 0.2, 0.56, ease.inOutSine]],
    veil: [[0, 0.1, 0.58, ease.inOut]],
    flash: [[0, 0, 0.1, ease.linear]],
  },
  // 领命：先往下一沉、压扁一点蓄力，再拉长、收成一点光飞向顶部栏。（平铺时是光从左翼一路收向右翼，剩下的一缕飞走）
  go: {
    dur: 0.82,
    pre: { hideX: 120, sweep: 0, headX: 1e9, focusX: 1e9 },
    sweep: [[1.8, 0, 0.16, ease.outCubic]],
    hideX: [[1010, 0, 0.44, ease.inOutSine]],
    flash: [[0.5, 0.12, 0.4, ease.outCubic], [0, 0.4, 0.8, ease.outCubic]],
    fly: [[1, 0.3, 0.72, ease.inCubic]],
    alpha: [[0, 0.64, 0.76, ease.linear]],
    veil: [[0, 0.22, 0.78, ease.inOut]],
    cue: [[0, 'crouch']],
  },
};

/** flyTo：领命时飞去的位置（姿态坐标），正式界面里是顶部栏。seed：小动作的随机种子。 */
export function createLife({ flyTo = [765, -24], seed = 7 } = {}) {
  const P = {}, V = {}, Q = {}, U = {};   // P/V 身体的量和速度；Q/U 翼尖的量和速度
  for (const k of SPRUNG) { P[k] = STATES.idle[k]; V[k] = 0; }
  for (const k of TIPS) { Q[k] = STATES.idle[k]; U[k] = 0; }
  let target = STATES.idle, state = 'idle';
  const S = { ...GONE };
  let script = null, from = null, at = 0, cues = 0, present = false;
  const clock = { t: 0, wave: 0, flow: 0, billow: 0, breath: 0, glint: 0, spin: 0 };
  let curlNow = 0, archNow = 0, tiltNow = 0, spinNow = 0, spinRate = 0, axisSin = 0, axisCos = 1, breathAmp = 0.011, floatX = 0, floatY = 0, yawnSize = 1;
  const soft = [1, 0, 0, 1];         // 球面这一帧的变形（2×2）：软的，不是刚的
  const jelly = { e: 0, v: 0, a: 0 };   // 被碰了一下之后像果冻那样颤几下：e 幅度，v 速度，a 方向
  const look = { x: 0, y: 0 };       // 朝鼠标那边转过去一点
  const yawn = { t: -1, arch: 1 };   // 伸懒腰进行到第几秒（-1 是没在伸）
  let calm = false;                  // 减弱动态：不游移、不颤、不做小动作，转得很慢
  let acc = null;                    // 正叠着的表情：{ kind, def, t }
  let riseAdd = 0, spinKick = 0, nextSyl = 0.2, nextKnock = 0.5, knocked = 0;
  const hueNow = [1, 1, 1], tint = [1, 1, 1, 0];
  const pulses = [];                 // { u, v, g, w, loop }
  let nextPulse = 2, nextAct = 3.5, rnd = seed;
  const random = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const ptr = { x: CX, y: CY, tx: CX, ty: CY, a: 0, on: false };
  const touch = { x: 0, y: 0, r: 105, g: 0 };
  let breathNow = 0;

  /** 发一道光。u 起点（0 左翼 → 1 右翼），v 速度（每秒走多少，负数往左），g 亮度，w 宽度（像素）。 */
  function emit(u, v, g, w = 120) {
    if (pulses.length >= 8) pulses.shift();
    pulses.push({ u, v, g, w, loop: false, x: 0, xl: 0, life: 0 });
  }

  /** 把姿态里的一个点挪到这一帧的位置。 */
  function warp(x0, y0, out, group) {
    let x = x0, y = y0;
    const win = smooth(520, 640, x0) * (1 - smooth(840, 930, x0));   // 只在环上、不碰结点
    // 拧：上下两半朝相反方向各走半个波
    const wr = smooth(940, 1070, x0), wl = 1 - smooth(380, 505, x0);
    if (group && x0 > 515 && x0 < 925) {
      const tw = P.twist + (Q.twist - P.twist) * 0.5;
      if (tw > 0.001 || tw < -0.001) y += group * tw * 92 * Math.sin(TAU * (x0 - 515) / 410);
    }
    // 波：位置的函数，所以挨在一起的点一起动，结不会散。从左往右走，越往两翼越大
    const far = Math.min(1, Math.abs(x0 - CX) / 470), tw = clock.wave;
    const amp = (P.wave + 1.3 * S.slack) * (0.3 + 0.7 * far * Math.sqrt(far));
    y += amp * (15 * Math.sin(0.0098 * x0 - 1.55 * tw) + 6.5 * Math.sin(0.0185 * x0 + 0.006 * y0 - 2.5 * tw + 2.1));
    x += amp * 6.5 * Math.sin(0.0085 * y0 + 0.0035 * x0 - 0.9 * tw + 0.7);
    // 环上有一个鼓包顺着走过去：这一段宽了，那一段就窄，不是整体一张一合
    if (group) y += group * win * P.wave * 5 * Math.sin(0.0153 * x0 - 1.2 * tw + 0.9);
    // 两端下垂或扬起
    if (archNow) { const sx = (x0 - CX) / HALF; y += archNow * 90 * (sx * sx - 0.3); }
    // 流光是有分量的：经过的地方起一道细细的涟漪
    for (let n = 0; n < pulses.length; n++) {
      const p = pulses[n], d = (x0 - p.x) / p.w;
      if (d > -2.4 && d < 2.4) y += p.g * 5 * Math.sin(d * 3.1) * Math.exp(-d * d);
    }
    // 两翼：绕着结点转。翼根跟着身体，翼尖用自己那套更松的弹簧，所以慢半拍、会甩过头；平时也在缓缓扇动
    if (wr > 0) {
      const a = P.liftR + (Q.liftR - P.liftR) * wr + P.wave * 0.075 * wr * Math.sin(0.83 * tw - 2.4 * wr);
      const k = 1 + (P.reachR + (Q.reachR - P.reachR) * wr) * wr, c = Math.cos(a * wr), s = Math.sin(a * wr);
      const dx = (x - PIVOT_R[0]) * k, dy = (y - PIVOT_R[1]) * k;
      x = PIVOT_R[0] + dx * c - dy * s; y = PIVOT_R[1] + dx * s + dy * c;
    }
    if (wl > 0) {
      const a = (P.liftL + (Q.liftL - P.liftL) * wl + P.wave * 0.06 * wl * Math.sin(0.66 * tw + 1.4 - 2.2 * wl)) * wl, c = Math.cos(a), s = Math.sin(a);
      const dx = x - PIVOT_L[0], dy = y - PIVOT_L[1];
      x = PIVOT_L[0] + dx * c - dy * s; y = PIVOT_L[1] + dx * s + dy * c;
    }
    // 入场：前端收成细细一束，往后才展开成纱；刚甩出来的那一段还在抖
    if (S.headX < 1e8) {
      const back = Math.max(0, S.headX - x0);
      y = CY + 12 + (y - CY - 12) * (1 - 0.82 * S.tip * Math.exp(-back / 190));
      y += S.whip * 34 * Math.exp(-back / 460) * Math.sin(0.0105 * x0 - 9.5 * at);
    } else if (S.whip > 0.001) y += S.whip * 34 * Math.sin(0.0105 * x0 - 9.5 * at) * Math.exp(-Math.max(0, 1500 - x0) / 460);
    // 卷：身体的长度方向绕到球的经线上，上下方向落到纬线上。卷得越紧球越小，两端绕到背面去；平铺是半径无穷大的球
    const size = P.size * (1 + breathAmp * breathNow) * S.grow * yawnSize;
    let dx = (x - CX) * P.spread * size, dy = (y - CY) * size;
    if (curlNow > 0.015) {
      const m = curlNow, R = HALF * size / (WRAP * m), phi = (x - CX) / HALF * WRAP * m + spinNow, lam = (y - CY) * size * (1 - 0.19 * m) / R;
      const cl = Math.cos(lam), zc = cl * Math.cos(phi), st = axisSin, ct = axisCos, Y = R * Math.sin(lam);
      dx = R * cl * Math.sin(phi) * P.spread; dy = Y * ct + R * (zc - 1) * st;
      out[2] = zc * ct - Y / R * st;
      // 球是软的：绕着球心被轻轻压扁、拉长
      const oy = -R * st, ey = dy - oy, ex = dx;
      dx = soft[0] * ex + soft[1] * ey; dy = oy + soft[2] * ex + soft[3] * ey;
    }
    place(dx, dy, out);
  }

  /** 整体：倾斜、上浮；退场时被水流带着往右漂；领命时收拢、朝顶部栏去。dx、dy 是相对身体中心的位置。 */
  function place(dx, dy, out) {
    if (tiltNow) { const c = Math.cos(tiltNow), s = Math.sin(tiltNow), ex = dx * c - dy * s; dy = dx * s + dy * c; dx = ex; }
    let x = CX + dx + 46 * S.slack + floatX, y = CY + dy + P.rise + riseAdd - 8 * S.slack + floatY;
    if (S.fly > 0) {
      // 平铺时从右翼走，卷成球时整个球收成一点走
      const o = smooth(0.3, 0.8, curlNow), ax = FLY_FROM[0] + (CX - FLY_FROM[0]) * o, ay = FLY_FROM[1] + (CY + P.rise + riseAdd - 40 - FLY_FROM[1]) * o;
      const k = 1 - 0.9 * S.fly, f = S.fly * S.fly; x = ax + (flyTo[0] - ax) * f + (x - ax) * k; y = ay + (flyTo[1] - ay) * S.fly + (y - ay) * k;
    }
    out[0] = x; out[1] = y;
  }

  const shell = { x: CX, y: CY, r: 0, a: 0, m: [1, 0, 0, 1] }, spot = [0, 0];
  const dyn = {
    warp, shell, tint, gain: 1, orb: 0, alpha: 0, focus: 1, when: { think: 0 }, flow: 0, wander: 0, billow: 0, billowPhase: 0, glint: 0.35, glintPhase: 0,
    pulses, touch, revealX: 1e9, hideX: -1e9, focusX: 1e9, sweep: 0, glow: 1, thread: 1, hem: 1, film: 1, dofL: 0, dofR: 0,
  };

  // 待命时自己做的小动作：克制、从容的内部呼吸和光流，不轻浮晃动
  function act() {
    if (calm) return;
    const r = random();
    if (target.curl > 0.5) {
      // 卷成球的时候
      if (r < 0.25) { yawn.t = 0; yawn.arch = random() < 0.5 ? -1 : 1; nextAct += YAWN; }                    // 极克制地略微松展再收束
      else if (r < 0.55) { emit(0.5, 0.45, 0.55, 115); emit(0.5, -0.45, 0.55, 115); }                      // 光波从中心温柔散开
      else if (r < 0.8) { V.rise -= 55; V.tilt += 0.16 * (random() < 0.5 ? -1 : 1); }                      // 极轻微地上浮调整姿态
      else { emit(-0.08, 0.85, 0.9, 85); emit(-0.2, 0.85, 0.55, 85); }                                     // 一道平缓的环绕流光
      return;
    }
    if (r < 0.26) { U.liftR -= 0.7; U.reachR += 0.35; V.liftR -= 0.25; emit(0.5, 0.55, 0.6, 110); }
    else if (r < 0.46) { U.liftL += 0.6; V.liftL += 0.2; emit(0.42, -0.5, 0.5, 110); }
    else if (r < 0.66) { emit(-0.08, 1.25, 0.95, 75); emit(-0.2, 1.25, 0.6, 75); }
    else if (r < 0.84) { V.curl += 2.0; V.arch += 1.2 * (random() < 0.5 ? -1 : 1); }
    else { V.rise -= 70; V.tilt += 0.22 * (random() < 0.5 ? -1 : 1); V.wave += 2.5; }
  }

  const cueDo = {
    settle: () => emit(-0.1, 1.05, 0.9, 130),
    settleShort: () => emit(-0.1, 1.15, 0.7, 120),
    crouch: () => { jelly.v = 0.28; jelly.a = 0; V.rise += 65; },   // 沉稳地微沉蓄力，不夸张压扁
  };

  function run(name) {
    const sc = SCRIPTS[name];
    // 还没完全退场又被召唤：从当前的亮度接着来
    if (sc.pre) { const a = S.alpha; Object.assign(S, sc.pre); if (sc.fresh) S.alpha = a; }
    if (sc.fresh) {
      // 两翼先收着，由弹簧带开：甩出来之后还要再荡两下
      Q.liftR = target.liftR + 0.55; Q.liftL = target.liftL - 0.4; Q.reachR = target.reachR - 0.22; U.liftR = U.liftL = U.reachR = 0;
      pulses.length = 0; nextPulse = 2.6; nextAct = 5;
    }
    script = sc; from = { ...S }; at = 0; cues = 0;
  }

  function step(dt) {
    dt = Math.min(dt, 0.05);
    // 身体的量：阻尼足的弹簧，利落地到位。翼尖的量：又慢又松的弹簧，拖在后面、会过头
    const W = 6.2, Z = 0.9, W2 = 3.3, Z2 = 0.42;
    for (const k of SPRUNG) { const c = STEADY[k], w = c ? c[0] : W, z = c ? c[1] : Z; V[k] += (w * w * (target[k] - P[k]) - 2 * z * w * V[k]) * dt; P[k] += V[k] * dt; }
    for (const k of TIPS) { U[k] += (W2 * W2 * (target[k] - Q[k]) - 2 * Z2 * W2 * U[k]) * dt; Q[k] += U[k] * dt; }
    // 叠着的表情：缓缓进、缓缓退
    let accLum = 0, accShade = 0, accNod = 0, accFace = 0, accTilt = 0, slow = 1;
    riseAdd = 0;
    if (acc) {
      acc.t += dt;
      const d = acc.def, u = acc.t / d.dur, e = smooth(0, 0.14, u) * (1 - smooth(0.62, 1, u));
      accLum = e * (d.lum || 0); accShade = e * (d.shade || 0); accNod = e * (d.nod || 0); riseAdd = e * (d.rise || 0); slow = 1 - e * (1 - (d.slow || 1));
      if (!calm && acc.kind === 'confused') accFace = e * 0.3 * Math.sin(6.9 * acc.t);                       // 左右转着看，拿不准
      if (!calm && acc.kind === 'annoyed') accTilt = 0.045 * Math.sin(40 * acc.t) * (1 - smooth(0, 0.5, acc.t));   // 开头抖一下
      if (u >= 1) acc = null;
    }
    clock.t += dt; clock.wave += dt * P.waveRate * slow; clock.flow += dt * P.flow * slow; clock.billow += dt * (0.7 + 0.5 * P.waveRate) * slow;
    clock.breath += dt * TAU / 5.2; clock.glint += dt * (0.06 + 0.1 * P.flow);
    // 样子自己在游移：有时拢一点，有时两端垂一点、扬一点，有时歪一点。周期互不相干，所以不重复
    const t = clock.t, dr = calm ? 0 : P.drift;
    // 样子自己在游移：收敛幅度，保持高级流体张力而不显散漫
    const rolled = smooth(0.45, 0.9, P.curl);
    curlNow = clamp(P.curl + dr * ((1 - rolled) * (0.09 + 0.06 * Math.sin(0.13 * t + 0.4) + 0.03 * Math.sin(0.071 * t + 2)) - rolled * 0.018 * (1 + Math.sin(0.19 * t + 0.4))), 0, 1.02);
    // 偶尔极微幅地舒展再收束，像深呼吸
    let loose = 0;
    if (yawn.t >= 0) { yawn.t += dt; const u = yawn.t / YAWN; loose = dr * smooth(0, 0.34, u) * (1 - smooth(0.5, 1, u)); if (u >= 1) yawn.t = -1; }
    curlNow -= 0.1 * loose * rolled;
    yawnSize = 1 - 0.07 * loose * rolled;
    const k2 = curlNow * curlNow;
    archNow = P.arch + dr * (0.18 * Math.sin(0.09 * t + 0.5) + 0.12 * Math.sin(0.17 * t + 3)) + 0.18 * yawn.arch * loose;
    tiltNow = P.tilt + dr * (0.025 + 0.055 * k2) * Math.sin(0.076 * t + 1.1) + accTilt;
    // 朝鼠标那边克制地微微侧目：只在「待命」且指针靠近球体/核心区域时才注意，倾听与思考时不分心
    const kl = 1 - Math.exp(-dt * 1.8);
    const pdx = ptr.tx - CX, pdy = ptr.ty - (CY + P.rise);
    const near = Math.hypot(pdx / 430, pdy / 340) < 1;
    const heed = state === 'idle' && ptr.on && near && present && !script && !calm;
    look.x += ((heed ? clamp(pdx / 430, -1, 1) : 0) - look.x) * kl;
    look.y += ((heed ? clamp(pdy / 340, -1, 1) : 0) - look.y) * kl;
    // 自转：思考时分毫不差地匀速；待命时温和微调；不转的状态平稳转回正面
    if (target.spin) spinRate = P.spin * (calm ? 0.3 : 1) * (1 + P.sway * (0.35 * Math.sin(0.23 * t + 0.6) + 0.2 * Math.sin(0.127 * t + 2.2)));
    else spinRate += (-17.6 * clock.spin - 8.4 * spinRate) * dt;   // 从正转着的速度接过来，缓缓转回正面，不是猛地一拧
    // 开心时多转一小段，很快就慢下来
    spinKick *= Math.exp(-dt * 2.2);
    clock.spin += (spinRate + spinKick) * dt;
    // 只要还卷着，转过的角度就原样算数；松到快平了才收回去。转了多少圈不重要，只记离正面最近的那个角度
    const turn = smooth(0.12, 0.62, curlNow);
    if (turn >= 1 && (clock.spin > Math.PI || clock.spin < -Math.PI)) clock.spin -= TAU * Math.round(clock.spin / TAU);
    spinNow = (clock.spin + P.face + 0.17 * look.x + accFace) * turn;
    // 球的轴朝观看者倾着；待命时轴的晃动极其沉稳收敛
    const axis = AXIS * k2 + k2 * (P.nod + accNod + dr * (0.065 * Math.sin(0.11 * t + 2) + 0.03 * Math.sin(0.057 * t)) + 0.075 * look.y);
    axisSin = Math.sin(axis); axisCos = Math.cos(axis);
    breathAmp = 0.008 + 0.006 * dr * k2;
    // 张力：接近临界阻尼的微弱呼吸变形，去掉果冻式的来回抖动
    if (calm) jelly.v = 0;
    jelly.v += (-120 * jelly.e - 12 * jelly.v) * dt; jelly.e = clamp(jelly.e + jelly.v * dt, -0.055, 0.055);
    const e1 = k2 * dr * (0.009 * Math.sin(0.61 * t + 1) + 0.005 * Math.sin(1.07 * t + 2.3)), a1 = 0.19 * t, e2 = k2 * jelly.e, a2 = jelly.a;
    const c2 = e1 * Math.cos(2 * a1) + e2 * Math.cos(2 * a2), s2 = e1 * Math.sin(2 * a1) + e2 * Math.sin(2 * a2);
    soft[0] = 1 + c2; soft[1] = s2; soft[2] = s2; soft[3] = 1 - c2;
    // 悬着：沉稳地微浮
    floatX = k2 * dr * (2.2 * Math.sin(0.37 * t + 0.8) + 1.2 * Math.sin(0.21 * t + 2.6));
    floatY = k2 * dr * (3.2 * Math.sin(0.52 * t) + 1.6 * Math.sin(0.29 * t + 1.3));
    // 呼吸：吸得快、呼得慢
    const bp = clock.breath % TAU / TAU;
    breathNow = bp < 0.38 ? Math.sin(bp / 0.38 * Math.PI / 2) : Math.cos((bp - 0.38) / 0.62 * Math.PI / 2);
    breathNow = breathNow * 2 - 1;

    // 进出场
    if (script) {
      at += dt;
      for (const key in script) {
        const track = script[key];
        if (!Array.isArray(track) || key === 'cue') continue;
        let v = from[key];
        for (const [to, t0, t1, fn] of track) {
          if (at >= t1) { v = to; continue; }
          if (at > t0) v += (to - v) * fn((at - t0) / (t1 - t0));
          break;
        }
        S[key] = v;
      }
      while (script.cue && cues < script.cue.length && at >= script.cue[cues][0]) cueDo[script.cue[cues++][1]]();
      if (at >= script.dur) { const gone = S.alpha < 0.01; script = null; Object.assign(S, gone ? GONE : HERE); if (gone) pulses.length = 0; }
    }

    // 流光：按状态自己发，再往前走
    const settled = present && !script;
    if (settled && target.pulseEvery > 0 && !calm) {
      nextPulse -= dt;
      if (nextPulse <= 0) {
        const j = target.steady ? 0 : 1;
        emit(-0.12, target.pulseSpeed * (1 + j * (0.2 * random() - 0.1)), target.pulseGain * (1 + j * (0.4 * random() - 0.2)), target.pulseWidth);
        nextPulse = target.pulseEvery * (1 + j * (0.5 * random() - 0.25));
      }
    }
    for (let n = pulses.length - 1; n >= 0; n--) {
      const p = pulses[n];
      p.u += p.v * dt; p.life += dt;
      p.x = p.xl = X0 + p.u * SPAN;
      if (p.u < -0.35 || p.u > 1.35 || p.g < 0.02) pulses.splice(n, 1);
    }
    // 说话：一个音节一道光，从中间荡向两边，球跟着微微鼓一下；偶尔换口气
    if (settled && target.speak && !calm) {
      nextSyl -= dt;
      if (nextSyl <= 0) {
        const g = 0.3 + 0.5 * random();
        emit(0.5, 0.85, g, 70); emit(0.5, -0.85, g, 70);
        V.size += 0.16 * g; V.glow += 1.6 * g;
        nextSyl = random() < 0.14 ? 0.55 + 0.3 * random() : 0.15 + 0.3 * random();
      }
    }
    // 提醒：隔一阵轻轻叩两下
    if (settled && target.knock && !calm) {
      nextKnock -= dt;
      if (nextKnock <= 0) {
        emit(0.5, 1.1, 0.9, 80); emit(0.5, -1.1, 0.9, 80);
        V.size += 0.3; V.glow += 3; jelly.v += 0.1; jelly.a = Math.PI / 2;
        knocked = 1 - knocked; nextKnock = knocked ? 0.22 : 2.4;
      }
    }
    // 小动作
    if (settled && target.acts) { nextAct -= dt; if (nextAct <= 0) { act(); nextAct = 4 + 5 * random(); } }
    // 鼠标（不做手电筒光斑和拨丝，只保留克制的近场注视）
    const pa = ptr.on && settled ? 1 : 0, kf = 1 - Math.exp(-dt * 9);
    ptr.a += (pa - ptr.a) * (1 - Math.exp(-dt * 5)); ptr.x += (ptr.tx - ptr.x) * kf; ptr.y += (ptr.ty - ptr.y) * kf;
    touch.x = ptr.x; touch.y = ptr.y; touch.g = 0;

    // 玻璃泡外壳：卷着就有，真松开了（不到八成）才化掉，深呼吸那一点松动不算；位置、大小、变形都跟着球
    {
      const sizeNow = P.size * (1 + breathAmp * breathNow) * S.grow * yawnSize, R = HALF * sizeNow / (WRAP * Math.max(curlNow, 0.3)), shrink = 1 - 0.9 * S.fly;
      const c = Math.cos(tiltNow), s = Math.sin(tiltNow);
      place(0, -R * axisSin, spot);
      shell.x = spot[0]; shell.y = spot[1]; shell.r = R * shrink * 1.03;
      shell.m[0] = c * soft[0] - s * soft[2]; shell.m[1] = c * soft[1] - s * soft[3]; shell.m[2] = s * soft[0] + c * soft[2]; shell.m[3] = s * soft[1] + c * soft[3];
      const born = S.focusX < 1e8 ? smooth(900, 1900, S.focusX) : 1;
      shell.a = smooth(0.62, 0.84, curlNow) * S.focus * born * (1 - S.slack) * (1 + 0.6 * S.fly) * P.glow;
    }
    // 染色和整体亮度：颜色缓缓换过去，免得一跳
    const hue = (acc && acc.def.hue) || target.hue, kh = 1 - Math.exp(-dt * 6);
    if (hue) for (let i = 0; i < 3; i++) hueNow[i] += (hue[i] - hueNow[i]) * kh;
    tint[0] = hueNow[0]; tint[1] = hueNow[1]; tint[2] = hueNow[2]; tint[3] = clamp(P.shade + accShade, 0, 1);
    dyn.gain = Math.max(0, P.lum + accLum);
    dyn.orb = smooth(0.25, 0.9, curlNow); dyn.alpha = S.alpha; dyn.focus = S.focus; dyn.when.think = clamp(P.think, 0, 1);
    dyn.flow = clock.flow; dyn.wander = P.wander; dyn.billow = P.billow * (1 + 0.35 * breathNow) + 0.2 * S.slack; dyn.billowPhase = clock.billow;
    dyn.glintPhase = clock.glint;
    dyn.revealX = S.headX; dyn.focusX = S.focusX; dyn.hideX = curlNow > 0.55 ? -1e9 : S.hideX; dyn.sweep = S.sweep;
    // 还是雾的时候，结点的光收着，对上焦才亮起来
    const lit = S.focusX < 1e8 ? 0.35 + 0.65 * smooth(700, 1900, S.focusX) : 1;
    dyn.glow = P.glow * (1 + 0.08 * breathNow) * (1 + 0.35 * S.flash + 1.6 * S.fly) * lit;
    dyn.thread = P.thread * (0.55 + 0.45 * lit); dyn.hem = (1 + 0.3 * S.flash + 1.3 * S.fly) * (0.55 + 0.45 * lit); dyn.film = 0.6 + 0.4 * lit; dyn.dofR = P.dofR;
  }

  const api = {
    dyn, S, P, Q, clock, step,
    get state() { return state; },
    get present() { return present; },
    get busy() { return !!script; },
    setState(name) {
      if (!STATES[name]) return;
      state = name; target = STATES[name]; nextPulse = Math.min(nextPulse, 0.6); nextAct = Math.max(nextAct, 4);
    },
    /** 立刻摆到某个状态，不走过渡。 */
    snap(name) { api.setState(name); for (const k of SPRUNG) { P[k] = target[k]; V[k] = 0; } for (const k of TIPS) { Q[k] = target[k]; U[k] = 0; } },
    /** 召唤。短时间内再次召唤用 short（传 true）；小头像用 'tiny'。 */
    arrive(short = false) { present = true; run(short === 'tiny' ? 'arriveTiny' : short ? 'arriveShort' : 'arrive'); },
    /** 退场。how：'close' 安静散去；'go' 领了任务去办；'tiny' 小头像随底板一起淡出。 */
    depart(how = 'close') { present = false; run(how === 'go' ? 'go' : how === 'tiny' ? 'closeTiny' : 'close'); },
    /** 有人说了点什么（打了一个字、声音响了一下）：一圈涟漪从中间荡向两翼。k 是轻重，0..1。 */
    poke(k = 0.6) {
      if (!present) return;
      if (calm) { V.glow += 1.2 * k; return; }
      const g = 0.45 + 0.55 * k;
      emit(0.5, 0.95, g, 85); emit(0.5, -0.95, g, 85);
      V.billow += 0.9 * k; V.glow += 2.2 * k;
      // 打字时只做极其轻微的收沉响应，不弹跳
      jelly.v = clamp(jelly.v + 0.09 * k, -0.4, 0.4); jelly.a = Math.PI / 2;
    },
    /** 回复里的表情，叠在当前状态上放一小段。不认识的名字返回 false。 */
    accent(name) {
      const def = ACCENTS[name];
      if (!def) return false;
      acc = { kind: name, def, t: 0 };
      if (!present || calm) return true;
      const both = (v, g, w) => { emit(0.5, v, g, w); emit(0.5, -v, g, w); };
      if (name === 'happy') { V.size += 0.42; V.glow += 3.5; spinKick = 1.1; jelly.v += 0.12; jelly.a = Math.PI / 2; both(0.9, 0.8, 90); }   // 亮一下、鼓一下，多转一小段
      else if (name === 'surprised') { V.size += 0.75; V.rise -= 70; jelly.v += 0.2; jelly.a = Math.PI / 2; }                         // 猛地鼓起来、往上一蹿
      else if (name === 'confused') V.tilt += 0.7;                                                                                    // 歪一下头
      else if (name === 'annoyed') V.tilt += 0.5;
      else if (name === 'done') { V.size += 0.9; V.glow += 5; spinKick = 1.6; both(1.0, 1.0, 90); both(0.6, 0.7, 120); }                // 事情办完：绽开一下
      return true;
    },
    /** 减弱动态效果：不游移、不颤、不做小动作，只留很慢的转动和呼吸。 */
    setReduced(on) { calm = !!on; if (calm) { yawn.t = -1; spinKick = 0; jelly.e = jelly.v = 0; pulses.length = 0; } },
    /** 鼠标在哪（姿态坐标）；离开时传 null。 */
    attend(x, y) { if (x == null) { ptr.on = false; return; } ptr.tx = x; ptr.ty = y; if (!ptr.on && ptr.a < 0.02) { ptr.x = x; ptr.y = y; } ptr.on = true; },
    /** 直接在场，不演入场。 */
    show() { present = true; script = null; Object.assign(S, HERE); },
    hide() { present = false; script = null; acc = null; Object.assign(S, GONE); pulses.length = 0; },
    /** 回到初始：时钟、随机数、流光都清零（给可重复的截图用）。 */
    reset() { for (const k in clock) clock[k] = 0; rnd = seed; pulses.length = 0; nextPulse = 2; nextAct = 3.5; ptr.on = false; ptr.a = 0; jelly.e = jelly.v = 0; look.x = look.y = 0; yawn.t = -1; yawnSize = 1; spinRate = 0; spinKick = 0; nextSyl = 0.2; nextKnock = 0.5; knocked = 0; api.hide(); api.snap('idle'); },
  };
  return api;
}
