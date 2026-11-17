/* KBOT · 光纹生命体 · 让它活着
 * 形体只有一个（pose.js 描下来的那一个）。它不是一张会晃的图，是一条浸在水流里的绸带：
 *   波   —— 从左翼传到右翼，一直在走。翼尖比身体慢半拍，会甩过头再回来。
 *   光   —— 一道一道从身上流过去，经过的地方亮起来、鼓一下。思考时光在环上循环。
 *   丝   —— 在纱面上各走各的，纹理一直在重新织。
 *   意愿 —— 待命时自己会微调呼吸、流过光波；只有待命且指针靠近时才微微侧目致意，倾听和思考时不分心。
 * 中间那个空洞只是绸带绕出来的环，不是器官，不开合。
 * 它平时把自己卷成一个球住着。同一条绸带，卷起来是球，松开是概念图上那条舒展的带子，中间的样子都是它。
 *   待命 —— 缩回去的安静球：小一点、暗一点，缓慢自转，隔很久才有一道光；是“在，但没事做”。
 *   倾听 —— 召唤着等你开口：凑近、放大、敞开正对着你，不转，亮一点，身上很静。
 *   思考 —— 向内收成更小更紧的球，染一点冷色；匀速地转，光沿球面规律地走；每隔几秒缓缓换一种形态（舒展、编织、转面、收拢、伸出）。
 *          画得够大时还会跳出球形：整条展成流动的光带、松成敞开的笼、拧成螺旋塔、弯成拱、两翼伸开，停几秒再合回球里。
 *   说话 —— 撑开放大，身上的波明显、丝游得快，染一点暖色；光随着话音一道一道荡出去。
 *   提醒 —— 凑近、前倾、整个染成琥珀色、更亮，隔一阵叩两下。
 *   出错 —— 缩小、沉下去、歪着，暗，染红，几乎不动。
 * 所有变化都走阻尼足的弹簧和平滑的起落曲线，不过冲、不来回荡：沉稳，不是Q弹。
 * 回复里的表情（开心、惊讶、困惑、难过、困、不耐烦）是叠在当前状态上的一小段，过了就退。
 * 进出场也不是开合：入场是绸带从左甩到右，先是雾、再对上焦，稳稳落定。
 */

import { streamMid } from './pose.js';

const TAU = 6.2831853;
const CX = 765, CY = 345;            // 身体的中心（姿态坐标）
const HALF = 470;                    // 身体半长
const WRAP = 3.33, AXIS = 0.34;      // 基准包裹尺度与轴倾角
const FACE = 0.7;                    // 基准正面相位
const X0 = 290, SPAN = 980;          // 身体从左到右的范围，流光的位置用 0..1 表示
const FLY_FROM = [1090, 392];        // 领命时最后收拢的地方
const YAWN = 5.6;                    // 伸一个懒腰多少秒

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };

/** 6 股独立三维光学丝流的空间倾角、相角、轨道半径比、丝带扭转及声波层参数（按 group 索引）。 */
const STREAMS = {
  1:    { rx: 0.56,  ry: -0.42, rz: 0.28,  ph: 0.25, rs: 0.96, ws: 0.96, dir: 1.00,  tw0: 0.4,  twC: 1.0,  twG: 0.85,  buc: 0.14, bucPh: 0.3, wY: -16, wZ: 14,  wF: 1.45, wPh: 0.2 },
  '-1': { rx: -0.50, ry: 0.46,  rz: -0.34, ph: 2.35, rs: 0.91, ws: 0.90, dir: -0.78, tw0: -0.5, twC: -1.0, twG: -0.80, buc: 0.16, bucPh: 1.9, wY: 17,  wZ: -12, wF: 1.65, wPh: 1.8 },
  2:    { rx: 1.02,  ry: 0.30,  rz: -0.18, ph: 1.25, rs: 0.85, ws: 0.80, dir: 0.65,  tw0: 0.8,  twC: 0.5,  twG: 0.65,  buc: 0.12, bucPh: 3.1, wY: -32, wZ: -18, wF: 1.15, wPh: 3.0 },
  '-2': { rx: -0.98, ry: -0.34, rz: 0.22,  ph: 4.15, rs: 0.83, ws: 0.80, dir: -0.62, tw0: -0.7, twC: -0.5, twG: -0.65, buc: 0.13, bucPh: 4.7, wY: 32,  wZ: 18,  wF: 1.25, wPh: 4.5 },
  3:    { rx: 0.72,  ry: 0.86,  rz: 0.52,  ph: 3.10, rs: 0.65, ws: 0.72, dir: 1.15,  tw0: 1.1,  twC: 1.5,  twG: 1.10,  buc: 0.18, bucPh: 0.9, wY: 0,   wZ: 24,  wF: 2.05, wPh: 0.9 },
  '-3': { rx: -0.76, ry: -0.84, rz: -0.46, ph: 5.20, rs: 0.74, ws: 0.70, dir: -1.10, tw0: -1.0, twC: -1.5, twG: -1.05, buc: 0.20, bucPh: 2.4, wY: -6,  wZ: -22, wF: 2.15, wPh: 2.7 },
};

/**
 * 状态参数表。
 * curl 控制空间形态：1 为立体交叉光环星座，0 为平缓舒展的 3D 多股声波光丝；
 * rise 负值向上（默认置中于 REF.y ≈ 338）。
 */
const AMBER = [1.0, 0.78, 0.42], RED = [0.96, 0.40, 0.44], SAPPHIRE = [0.54, 0.72, 1.0], SOLAR = [1.0, 0.86, 0.64], CYAN = [0.62, 0.88, 1.0], GOLD = [1.0, 0.88, 0.66];
export const STATES = {
  // 待命：三维非对称交错光丝围绕中空核心缓缓旋息，无硬球壳、无双翼
  idle: { spread: 1.02, size: 1.16, curl: 0.95, slim: 1, swoop: 0, arch: 0, spin: 0.1, sway: 1, face: FACE, nod: 0, drift: 0.88, liftR: 0, liftL: 0, reachR: 0, tilt: -0.07, rise: -6, twist: 0, think: 0, focus: 0.88, wave: 0.64, waveRate: 0.68, wander: 0.85, flow: 0.44, billow: 0.06, pulseEvery: 5.4, pulseSpeed: 0.28, pulseGain: 0.64, pulseWidth: 135, steady: 0, glow: 0.92, thread: 0.92, dofR: 0, acts: 1, lum: 0.94, iri: 0.82, halo: 0.88, glint: 0.65, edge: 0.14 },
  // 倾听：光环微倾开启如光学光圈面向对话者，清晰锐焦，保留细腻丝纹不刺眼
  listen: { spread: 1.04, size: 1.02, curl: 0.72, slim: 0.84, swoop: 0.16, arch: -0.04, spin: 0, sway: 0, face: -0.26, nod: 0.08, drift: 0.42, liftR: -0.05, liftL: 0.05, reachR: 0.04, tilt: -0.08, rise: -4, twist: 0.08, think: 0, focus: 1.08, wave: 0.68, waveRate: 0.95, wander: 0.95, flow: 0.72, billow: 0.1, pulseEvery: 0, pulseSpeed: 0.9, pulseGain: 0.8, pulseWidth: 105, steady: 0, glow: 0.88, thread: 0.96, dofR: 0, acts: 0, lum: 0.90, shade: 0.26, hue: CYAN, iri: 0.95, halo: 0.94, glint: 1.10, edge: 0.2 },
  // 思考：多股光丝异步反旋穿织，通透不溢白，沉静暮蓝微温
  think: { spread: 1.02, size: 0.94, curl: 0.68, slim: 0.82, swoop: 0.14, arch: 0, spin: 0.48, sway: 0, face: FACE, nod: 0, drift: 0.28, liftR: 0, liftL: 0, reachR: 0, tilt: -0.14, rise: -4, twist: 0.62, think: 1, focus: 1.02, wave: 0.42, waveRate: 0.85, wander: 0.9, flow: 1.35, billow: 0.07, pulseEvery: 0.95, pulseSpeed: 0.42, pulseGain: 0.95, pulseWidth: 100, steady: 1, glow: 0.82, thread: 0.92, dofR: 0, acts: 0, lum: 0.84, shade: 0.34, hue: SAPPHIRE, iri: 1.08, halo: 0.90, glint: 1.15, edge: 0.3 },
  // 说话：轻盈透亮的 5 股三维声波丝束，丝丝分明地浮在文字上方
  talk: { spread: 1.08, size: 0.74, curl: 0.14, slim: 0.46, swoop: 0.78, arch: 0.06, spin: 0.08, sway: 0.35, face: 0.16, nod: 0.03, drift: 0.5, liftR: 0, liftL: 0, reachR: 0, tilt: -0.06, rise: -16, twist: 0.1, think: 0, focus: 1.0, wave: 1.38, waveRate: 1.35, wander: 1.25, flow: 1.3, billow: 0.16, pulseEvery: 0, pulseSpeed: 0.44, pulseGain: 0.84, pulseWidth: 135, steady: 0, glow: 0.70, thread: 0.80, dofR: 0, acts: 0, speak: 1, lum: 0.72, shade: 0.26, hue: SOLAR, iri: 1.08, halo: 0.82, glint: 0.90, edge: 0.36 },
  // 提醒：香槟暖意轻叩——内部暖核明晰，两次温柔脉冲唤醒
  remind: { spread: 1.04, size: 1.02, curl: 0.78, slim: 0.76, swoop: 0.22, arch: -0.06, spin: 0.08, sway: 0, face: 0.2, nod: 0.1, drift: 0.35, liftR: -0.06, liftL: 0.06, reachR: 0.03, tilt: 0.05, rise: -4, twist: -0.28, think: 0, focus: 1.06, wave: 0.72, waveRate: 1.0, wander: 0.9, flow: 0.78, billow: 0.1, pulseEvery: 0, pulseSpeed: 1.05, pulseGain: 0.92, pulseWidth: 95, steady: 0, glow: 0.92, thread: 0.98, dofR: 0, acts: 0, knock: 1, lum: 0.92, shade: 0.46, hue: AMBER, iri: 0.98, halo: 1.02, glint: 1.40, edge: 0.46 },
  // 出错：失焦沉静——对焦柔化散开，流速放缓，带着一丝克制的暗红余烬
  error: { spread: 0.96, size: 0.88, curl: 0.88, slim: 0.92, swoop: 0, arch: 0.2, spin: 0.015, sway: 0, face: FACE, nod: -0.14, drift: 0.14, liftR: 0.12, liftL: -0.12, reachR: 0, tilt: -0.26, rise: 16, twist: 0.12, think: 0, focus: 0.58, wave: 0.18, waveRate: 0.35, wander: 0.25, flow: 0.12, billow: 0.02, pulseEvery: 0, pulseSpeed: 0.3, pulseGain: 0.45, pulseWidth: 110, steady: 0, glow: 0.64, thread: 0.62, dofR: 0, acts: 0, lum: 0.62, shade: 0.44, hue: RED, iri: 0.35, halo: 0.68, glint: 0.2, edge: 0.24 },
};
const EXTRA = { lum: 1, shade: 0, hue: null, speak: 0, knock: 0, iri: 1, halo: 1, glint: 0.5, edge: 0.2, slim: 1, swoop: 0, focus: 1 };
for (const k in STATES) STATES[k] = { ...EXTRA, ...STATES[k] };

/**
 * 回复里的表情。dur 秒数；attack 多快到顶（占 dur 的比例）；lum 亮度增减；shade、hue 染色；rise 往下沉多少（负数是往上）；nod 低头；
 * size 球变大变小；glow 光亮增减；wander 丝游得多乱；slow 身上的流动放慢到几成；spin 多转一小段；sway 左右转着看；jitter 轻抖；iri、halo、focus 虹彩、光晕与对焦变化。
 * 全都是一条平滑的起落曲线叠在状态上，不用冲量，所以不会弹。
 */
export const ACCENTS = {
  happy: { dur: 2.2, lum: 0.24, shade: 0.2, hue: GOLD, rise: -16, size: 0.1, glow: 0.3, spin: 1.6, iri: 0.3, halo: 0.25, focus: 0.1 },
  surprised: { dur: 1.6, attack: 0.07, lum: 0.28, shade: 0.14, hue: [1, 1, 1], rise: -20, size: 0.14, glow: 0.34, nod: -0.05, iri: 0.32, halo: 0.28, focus: 0.16 },
  confused: { dur: 2.8, shade: 0.19, hue: [0.84, 0.82, 1.0], wander: 0.85, sway: 1, iri: 0.2, halo: 0.12, focus: -0.16 },
  sad: { dur: 3.8, lum: -0.34, shade: 0.32, hue: SAPPHIRE, rise: 24, size: -0.06, nod: 0.16, slow: 0.38, iri: -0.3, halo: -0.22, focus: -0.28 },
  sleepy: { dur: 3.8, lum: -0.28, rise: 14, size: -0.04, nod: 0.2, slow: 0.3, iri: -0.25, halo: -0.18, focus: -0.22 },
  annoyed: { dur: 2.2, lum: 0.06, shade: 0.42, hue: RED, size: -0.08, jitter: 1, iri: -0.3, halo: 0.12, focus: 0.1 },
  done: { dur: 1.6, lum: 0.26, shade: 0.18, hue: GOLD, size: 0.12, glow: 0.35, spin: 2.0, iri: 0.35, halo: 0.3, focus: 0.14 },
};
const SPRUNG = ['spread', 'size', 'curl', 'slim', 'swoop', 'arch', 'spin', 'sway', 'face', 'nod', 'drift', 'liftR', 'liftL', 'reachR', 'tilt', 'rise', 'twist', 'think', 'focus', 'wave', 'waveRate', 'wander', 'flow', 'billow', 'glow', 'thread', 'dofR', 'lum', 'shade', 'iri', 'halo', 'glint', 'edge'];
const TIPS = ['liftR', 'liftL', 'reachR', 'twist'];   // 这几个量在翼尖上另有一套更慢、更松的弹簧
const STEADY = { curl: [2.7, 1], slim: [2.8, 1], swoop: [2.8, 1], focus: [2.8, 1], arch: [3, 0.85], spin: [1.6, 1], sway: [1.6, 1], face: [3.4, 1], nod: [3.4, 0.8], size: [3.4, 0.82], rise: [3.4, 0.82], tilt: [3, 1] };   // 这几个量慢慢来，不回弹：卷起来是件郑重的事

const ease = {
  linear: u => u,
  outCubic: u => 1 - (1 - u) ** 3,
  outSine: u => Math.sin(u * Math.PI / 2),
  inCubic: u => u * u * u,
  inOut: u => (u < 0.5 ? 4 * u * u * u : 1 - ((-2 * u + 2) ** 3) / 2),
  inOutSine: u => 0.5 - 0.5 * Math.cos(Math.PI * u),
  outQuart: u => 1 - (1 - u) ** 4,   // 利落地到位，不过冲
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
    pre: { alpha: 0, headX: 200, focusX: 60, whip: 1.25, tip: 1, sweep: 0.65, flash: 0, fly: 0, hideX: -1e9, slack: 0, grow: 0.42 },
    grow: [[1, 0.02, 0.95, ease.outQuart]],
    veil: [[1, 0, 0.5, ease.outCubic]],
    alpha: [[1, 0, 0.1, ease.linear]],
    headX: [[1600, 0.02, 0.8, ease.outSine]],
    tip: [[0, 0.5, 1.15, ease.inOutSine]],
    focusX: [[1900, 0.2, 1.15, ease.inOutSine]],
    sweep: [[0, 0.6, 0.95, ease.linear]],
    whip: [[0, 0.3, 1.6, ease.outCubic]],
    flash: [[1.25, 0.28, 0.58, ease.outCubic], [0, 0.58, 1.7, ease.outCubic]],
    cue: [[0.86, 'settle']],
  },
  // 短时间内再次召唤：同一个动作，快一倍多
  arriveShort: {
    dur: 0.75, fresh: true,
    pre: { alpha: 0, headX: 250, focusX: 220, whip: 0.5, tip: 1, sweep: 0.4, flash: 0, fly: 0, hideX: -1e9, slack: 0, grow: 0.66 },
    grow: [[1, 0, 0.5, ease.outQuart]],
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
  const bumps = [], off = {};        // 一次性的动作：一条平滑的起落曲线加在目标上，弹簧再把它抹顺，不会来回荡
  const kick = (k, a, d = 0.5, o) => { bumps.push({ k, a, t: 0, d, hold: !!o?.hold, big: !!o?.big }); };
  let room = true;                   // 画得够大、周围放得下，才允许出球形：小头像和常驻条里它只在球里变化
  let sizeAdd = 0, glowAdd = 0, wanderAdd = 0, iriAdd = 0, haloAdd = 0, voiceEnergy = 0, edgeBurst = 0, edgePhase = 0;
  let riseAdd = 0, spinKick = 0, nextSyl = 0.2, nextKnock = 0.5, knocked = 0;
  const hueNow = [1, 1, 1], tint = [1, 1, 1, 0];
  const pulses = [];                 // { u, v, g, w, loop }
  let nextPulse = 2, nextAct = 3.5, nextPonder = 1.2, lastPhase = -1, rnd = seed;
  const random = () => { rnd = (rnd * 16807) % 2147483647; return rnd / 2147483647; };
  const ptr = { x: CX, y: CY, tx: CX, ty: CY, a: 0, on: false };
  const touch = { x: 0, y: 0, r: 105, g: 0 };
  let breathNow = 0;

  /** 发一道光。u 起点（0 左翼 → 1 右翼），v 速度（每秒走多少，负数往左），g 亮度，w 宽度（像素）。 */
  function emit(u, v, g, w = 120) {
    if (pulses.length >= 8) pulses.shift();
    pulses.push({ u, v, g, w, loop: false, x: 0, xl: 0, life: 0 });
  }

  /** 把姿态参数 (x0, y0, group) 映射为该帧的三维流光坐标：在立体交叉环光场与三维声波丝束间无缝演化。 */
  function warp(x0, y0, out, group) {
    const st = STREAMS[group] || STREAMS[1];
    const u = clamp((x0 - CX) / HALF, -1, 1);
    const v0 = y0 - CY - streamMid(group, x0);

    // 入场前端收成锐利光束，再渐展成纱
    const back = S.headX < 1e8 ? Math.max(0, S.headX - x0) : 0;
    const tipScale = S.headX < 1e8 ? 1 - 0.82 * S.tip * Math.exp(-back / 190) : 1;
    const whipDy = S.headX < 1e8
      ? S.whip * 28 * Math.exp(-back / 460) * Math.sin(0.0105 * x0 - 9.5 * at)
      : S.whip > 0.001
        ? S.whip * 28 * Math.sin(0.0105 * x0 - 9.5 * at) * Math.exp(-Math.max(0, 1500 - x0) / 460)
        : 0;
    const vEff = v0 * tipScale;

    const size = (P.size + sizeAdd + 0.04 * voiceEnergy) * (1 + breathAmp * breathNow) * S.grow * yawnSize;
    const R = HALF * size / (WRAP * (0.48 + 0.52 * curlNow));
    const twWave = clock.wave;
    const amp = P.wave + 1.1 * S.slack + 0.75 * voiceEnergy;

    let pulseY = 0;
    for (let n = 0; n < pulses.length; n++) {
      const p = pulses[n], d = (x0 - p.x) / p.w;
      if (d > -2.4 && d < 2.4) pulseY += p.g * Math.sin(d * 3.1) * Math.exp(-d * d);
    }

    const orbMix = smooth(0.14, 0.62, curlNow);
    const openPhase = smooth(0.05, 0.88, orbMix);
    const phMix = smooth(0.45, 0.92, orbMix);
    let ox = 0, oy = 0, oz = 0;
    if (orbMix > 0.002) {
      const twNow = P.twist + (Q.twist - P.twist) * 0.5;
      const thSpan = 0.28 + 0.78 * orbMix;
      const phShift = (st.ph + spinNow * st.dir + clock.flow * 0.09 * st.dir) * phMix;
      const th = u * Math.PI * thSpan + phShift;
      const bucAmt = (st.buc + 0.22 * twNow) * openPhase;
      const b = bucAmt * Math.sin(2 * th + st.bucPh), db = 2 * bucAmt * Math.cos(2 * th + st.bucPh);
      const cb = Math.cos(b), sb = Math.sin(b), snt = Math.sin(th), ct = Math.cos(th);
      // 基准平面以底端 (+x 切向) 对齐：闭合时等效旋转相位，展开时所有丝束顺流自左向右平稳铺开
      const px = cb * snt, py = -cb * ct, pz = sb;

      let tx = -sb * db * snt + cb * ct, ty = sb * db * ct + cb * snt, tz = cb * db;
      const tLen = Math.hypot(tx, ty, tz) || 1;
      tx /= tLen; ty /= tLen; tz /= tLen;

      // T 与 P 正交，故 N = T × P 自然构成标准正交标架
      const nx = ty * pz - tz * py, ny = tz * px - tx * pz, nz = tx * py - ty * px;
      const twA = (st.tw0 + st.twC * th + twNow * st.twG * Math.sin(th + st.ph) + clock.flow * 0.25 * st.dir) * (0.25 + 0.75 * openPhase);
      const ctw = Math.cos(twA), stw = Math.sin(twA);
      const bx = ctw * nx + stw * px, by = ctw * ny + stw * py, bz = ctw * nz + stw * pz;

      const rMod = 1 + 0.03 * breathNow + 0.024 * pulseY + 0.016 * amp * Math.sin(u * Math.PI * st.wF - 1.5 * twWave + st.ph);
      const r = R * st.rs * rMod;
      const lam = Math.atan((vEff * size * st.ws) / Math.max(r * 0.78, 30));
      const cl = Math.cos(lam), sl = Math.sin(lam) * 0.86;
      let vx = cl * px + sl * bx, vy = cl * py + sl * by, vz = cl * pz + sl * bz;
      const vLen = Math.hypot(vx, vy, vz);
      if (vLen > 1.04) { const k = 1.04 / vLen; vx *= k; vy *= k; vz *= k; }
      vx *= r; vy *= r; vz *= r;

      // 各流光环自身的三维空间倾角（随展开同步转正朝前，避免交叉折角）
      const incl = (0.62 + 0.38 * smooth(0.45, 0.95, curlNow)) * (0.18 + 0.82 * openPhase);
      const rx = st.rx * incl, ry = st.ry * incl, rz = st.rz * openPhase;
      const cx1 = Math.cos(rx), sx1 = Math.sin(rx);
      let x1 = vx, y1 = vy * cx1 - vz * sx1, z1 = vy * sx1 + vz * cx1;
      const cy1 = Math.cos(ry), sy1 = Math.sin(ry);
      const x2 = x1 * cy1 + z1 * sy1; z1 = -x1 * sy1 + z1 * cy1;
      const cz1 = Math.cos(rz), sz1 = Math.sin(rz);
      ox = x2 * cz1 - y1 * sz1; oy = x2 * sz1 + y1 * cz1 + r * 0.82 * (1 - orbMix); oz = z1;

      // 全局注视、点头微倾与软光场形变
      const yaw = 0.24 * look.x + 0.16 * (P.face - FACE);
      const pitch = 0.14 * look.y + 0.25 * (AXIS - axisSin);
      const cyG = Math.cos(yaw), syG = Math.sin(yaw);
      const gx = ox * cyG + oz * syG; oz = -ox * syG + oz * cyG;
      const cpG = Math.cos(pitch), spG = Math.sin(pitch);
      const gy = oy * cpG - oz * spG; oz = oy * spG + oz * cpG;
      ox = soft[0] * gx + soft[1] * gy + 9 * look.x;
      oy = soft[2] * gx + soft[3] * gy + 6 * look.y + archNow * 16 + whipDy * 0.45;
    }

    let wx = 0, wy = 0, wz = 0;
    if (orbMix < 0.998) {
      const env = Math.pow(Math.max(0, Math.cos(u * Math.PI * 0.485)), 0.85);
      const slimF = 0.55 + 0.45 * P.slim;
      wx = u * HALF * P.spread * size * 0.85 + amp * 4.5 * Math.sin(0.0085 * y0 + 0.0035 * x0 - 0.9 * twWave + 0.7);
      const swoopY = -P.swoop * 28 * env * Math.sin(u * Math.PI * 0.85 + 0.25);
      const waveH = ((11 * amp + 14 * voiceEnergy) * Math.sin(u * Math.PI * st.wF - 1.55 * twWave + st.wPh)
        + (4.5 * amp + 6 * voiceEnergy) * Math.sin(u * Math.PI * st.wF * 1.9 - 2.6 * twWave + 1.3)) * (0.25 + 0.75 * env);
      const spineY = st.wY * env * slimF + swoopY + waveH + archNow * 52 * (u * u - 0.32) * env + pulseY * 9 * env + whipDy;
      const vw = vEff * size * st.ws * (0.42 + 0.36 * P.slim) * (0.3 + 0.7 * env);
      const wtw = u * 1.25 * st.dir + twWave * 0.45 * st.dir + st.ph * 0.3;
      wy = spineY + vw * Math.cos(wtw);
      wz = st.wZ * env * Math.cos(u * Math.PI * 1.2 + st.wPh) + vw * Math.sin(wtw);
    }

    const dx = wx + (ox - wx) * orbMix;
    const dy = wy + (oy - wy) * orbMix;
    const dz = wz + (oz - wz) * orbMix;
    out[2] = clamp(dz / Math.max(R, 45), -1, 1);
    place(dx, dy, out);
  }

  /** 整体：倾斜、上浮；退场时被水流带着往右漂；领命时收拢、朝顶部栏去。dx、dy 是相对身体中心的位置。 */
  function place(dx, dy, out) {
    if (tiltNow) { const c = Math.cos(tiltNow), s = Math.sin(tiltNow), ex = dx * c - dy * s; dy = dx * s + dy * c; dx = ex; }
    let x = CX + dx + 46 * S.slack + floatX, y = CY + dy + P.rise + riseAdd - 8 * S.slack + floatY;
    if (S.fly > 0) {
      const o = smooth(0.3, 0.8, curlNow), ax = FLY_FROM[0] + (CX - FLY_FROM[0]) * o, ay = FLY_FROM[1] + (CY + P.rise + riseAdd - 40 - FLY_FROM[1]) * o;
      const k = 1 - 0.9 * S.fly, f = S.fly * S.fly; x = ax + (flyTo[0] - ax) * f + (x - ax) * k; y = ay + (flyTo[1] - ay) * S.fly + (y - ay) * k;
    }
    out[0] = x; out[1] = y;
  }

  const shell = { x: CX, y: CY, r: 0, a: 0, m: [1, 0, 0, 1] }, spot = [0, 0];
  const dyn = {
    warp, shell, tint, gain: 1, orb: 0, alpha: 0, focus: 1, when: { think: 0 }, flow: 0, wander: 0, billow: 0, billowPhase: 0, glint: 0.35, glintPhase: 0,
    pulses, touch, revealX: 1e9, hideX: -1e9, focusX: 1e9, sweep: 0, glow: 1, thread: 1, hem: 1, film: 1, dofL: 0, dofR: 0, iri: 1, halo: 1,
    edge: 0.2, edgeBurst: 0, edgePhase: 0,
  };

  // 待命时自己做的小动作：克制、从容的内部呼吸和光流，偶有轻翼微张，不轻浮晃动
  function act() {
    if (calm) return;
    const r = random(), s = random() < 0.5 ? -1 : 1;
    if (target.curl > 0.5) {
      if (r < 0.22) { yawn.t = 0; yawn.arch = s; nextAct += YAWN; kick('iri', 0.25, 3.2); }                      // 极克制地伸个懒腰，泛起微虹
      else if (r < 0.48) { emit(0.5, 0.52, 0.62, 120); emit(0.5, -0.52, 0.62, 120); kick('halo', 0.18, 2.4); }  // 双极光波从中心温柔散开
      else if (r < 0.72) { kick('rise', -16, 3.2); kick('tilt', 0.06 * s, 3.2); kick('curl', -0.04, 3.2); }    // 缓慢浮息调姿
      else if (r < 0.90) { emit(-0.08, 0.95, 0.95, 90); emit(-0.22, 0.95, 0.6, 90); }                           // 一前一后两道环绕流光
      else { kick('liftR', -0.18, 2.8); kick('liftL', 0.15, 2.8); kick('iri', 0.3, 2.8); }                      // 两翼微启复拢
      return;
    }
    if (r < 0.26) { kick('liftR', -0.5, 2); kick('reachR', 0.25, 2); emit(0.5, 0.55, 0.6, 110); }
    else if (r < 0.46) { kick('liftL', 0.45, 2); emit(0.42, -0.5, 0.5, 110); }
    else if (r < 0.66) { emit(-0.08, 1.25, 0.95, 75); emit(-0.2, 1.25, 0.6, 75); }
    else if (r < 0.84) { kick('curl', -0.07, 2.4); kick('arch', 0.25 * s, 2.4); }
    else { kick('rise', -16, 3); kick('tilt', 0.07 * s, 3); kick('wave', 0.3, 2.4); }
  }

  // 思考时慢慢演化形态：在涡旋中异步试探、编织、收敛，体现多线程推理的呼吸感
  const PONDER = [
    // 微舒试探：略微松开旋幅并拉升波浪，像拨开一点思绪
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.14, 3.8); kick('slim', -0.10, 3.8); kick('swoop', 0.22, 3.8); kick('arch', 0.2 * s, 3.8); kick('wave', 0.45, 3.8); kick('focus', -0.12, 3.8); kick('iri', 0.22, 3.8); emit(0.5, 0.38, 0.72, 150); emit(0.5, -0.38, 0.72, 150); },
    // 交叉编织：上下丝层反向拧转、多股穿行加速
    () => { const s = random() < 0.5 ? -1 : 1; kick('twist', 0.36 * s, 3.6); kick('wander', 0.85, 3.6); kick('flow', 0.55, 3.6); kick('size', -0.05, 3.6); kick('focus', 0.12, 3.6); kick('halo', 0.16, 3.6); emit(-0.1, 0.6, 0.82, 105); },
    // 侧转审视：缓缓转到另一面观察
    () => { const s = random() < 0.5 ? -1 : 1; kick('face', s * 0.95, 4.2); kick('nod', 0.14, 4.2); kick('tilt', 0.12 * s, 4.2); },
    // 凝核聚光：收紧并提高锐度，像锁定一个答案线索
    () => { kick('size', -0.09, 3.2); kick('curl', 0.14, 3.2); kick('spin', 0.45, 3.2); kick('focus', 0.18, 3.2); kick('glow', 0.24, 3.2); kick('halo', -0.12, 3.2); kick('rise', -4, 3.2); emit(0.5, 0.65, 0.88, 85); emit(0.5, -0.65, 0.88, 85); },
    // 单翼伸展：一侧向外探出又收回
    () => { kick('reachR', 0.16, 3.6); kick('liftR', -0.22, 3.6); kick('tilt', 0.1, 3.6); kick('curl', -0.1, 3.6); kick('iri', 0.22, 3.6); emit(0.2, 0.75, 0.8, 110); },
    // 对流共振：双向焦散浪穿过中心交汇
    () => { kick('wave', 0.7, 3.4); kick('billow', 0.08, 3.4); kick('halo', 0.22, 3.4); kick('iri', 0.26, 3.4); emit(0.0, 0.95, 0.85, 95); emit(1.0, -0.95, 0.85, 95); },
  ];
  // 七大流线光学蜕变：保持空间居中与边界安全，在舒展光幕与凝核编织之间流动切换
  const big = { hold: true, big: true };
  const FREE = [
    // 0 · 天际声波：平稳展开成澄澈的多股声波丝流
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.48, 6.0, big); kick('slim', -0.32, 6.0, big); kick('swoop', 0.58, 6.0, big); kick('size', -0.14, 6.0, big); kick('rise', 8, 6.0, big); kick('tilt', 0.1 * s, 6.0, big); kick('wave', 0.72, 6.0, big); kick('focus', 0.08, 6.0, big); kick('iri', 0.28, 6.0, big); kick('halo', 0.22, 6.0, big); emit(-0.1, 0.85, 0.9, 110); },
    // 1 · 光环倾侧：转开另一维侧角，展示内部细丝编织
    () => { kick('curl', -0.22, 5.4, big); kick('slim', -0.14, 5.4, big); kick('swoop', 0.26, 5.4, big); kick('face', -0.95, 5.4, big); kick('arch', -0.18, 5.4, big); kick('size', -0.06, 5.4, big); kick('rise', 6, 5.4, big); kick('tilt', 0.24, 5.4, big); kick('focus', 0.1, 5.4, big); kick('iri', 0.25, 5.4, big); emit(0.5, 0.65, 0.82, 100); emit(0.5, -0.65, 0.82, 100); },
    // 2 · 螺旋升腾：倾斜立体旋环加速旋升
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.34, 5.8, big); kick('slim', -0.24, 5.8, big); kick('swoop', 0.36, 5.8, big); kick('tilt', 0.32 * s, 5.8, big); kick('size', -0.16, 5.8, big); kick('rise', 10, 5.8, big); kick('twist', 0.28 * s, 5.8, big); kick('spin', 0.32, 5.8, big); emit(0, 0.85, 0.85, 95); },
    // 3 · 星海波澜：立体丝流展开为大起伏焦散浪
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.44, 5.8, big); kick('slim', -0.32, 5.8, big); kick('swoop', 0.60 * s, 5.8, big); kick('wave', 0.95, 5.8, big); kick('size', -0.14, 5.8, big); kick('rise', 8, 5.8, big); kick('halo', 0.26, 5.8, big); emit(0.5, 0.6, 0.82, 120); emit(0.5, -0.6, 0.82, 120); },
    // 4 · 舒展双弧：丝束斜掠滑过天际
    () => { kick('curl', -0.36, 5.8, big); kick('slim', -0.24, 5.8, big); kick('swoop', 0.42, 5.8, big); kick('size', -0.15, 5.8, big); kick('rise', 8, 5.8, big); kick('tilt', -0.12, 5.8, big); kick('iri', 0.28, 5.8, big); emit(0.5, 0.75, 0.85, 100); emit(0.5, -0.75, 0.85, 100); },
    // 5 · 莫比乌斯涡：强化反向编织与内部扭转张力
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.24, 5.6, big); kick('slim', -0.18, 5.6, big); kick('swoop', 0.26, 5.6, big); kick('twist', 0.52 * s, 5.6, big); kick('tilt', 0.24 * s, 5.6, big); kick('size', -0.10, 5.6, big); kick('rise', 6, 5.6, big); kick('flow', 0.80, 5.6, big); kick('focus', 0.12, 5.6, big); kick('iri', 0.35, 5.6, big); emit(0, 0.95, 0.9, 90); emit(1, -0.95, 0.9, 90); },
    // 6 · 雾散重聚：短暂化入轻雾后凝回焦点
    () => { kick('curl', -0.42, 5.6, big); kick('slim', -0.26, 5.6, big); kick('swoop', 0.48, 5.6, big); kick('spread', 0.05, 5.6, big); kick('wave', 0.78, 5.6, big); kick('size', -0.16, 5.6, big); kick('rise', 8, 5.6, big); kick('glow', 0.22, 5.6, big); kick('focus', -0.22, 5.6, big); kick('iri', 0.35, 5.6, big); kick('halo', 0.28, 5.6, big); emit(0.5, 0.85, 0.9, 120); emit(0.5, -0.85, 0.9, 120); },
  ];
  let lastFree = -1, sinceFree = 0;
  function ponder() {
    if (bumps.some(b => b.big)) { nextPonder = 1.5; return; }   // 舒展着的时候不再叠别的变化，免得超出放得下的范围
    if (room && sinceFree >= 3) {
      for (const b of bumps) if (!b.big && b.t > 0) b.t = Math.max(b.t, b.d * 0.65);
      let n = Math.floor(random() * FREE.length);
      if (n === lastFree) n = (n + 1 + Math.floor(random() * (FREE.length - 1))) % FREE.length;
      lastFree = n; sinceFree = 0;
      FREE[n]();
      nextPonder = 4.0;
      return;
    }
    sinceFree++;
    let n = Math.floor(random() * PONDER.length);
    if (n === lastPhase) n = (n + 1 + Math.floor(random() * (PONDER.length - 1))) % PONDER.length;
    lastPhase = n;
    PONDER[n]();
  }

  const cueDo = {
    settle: () => { emit(-0.1, 1.15, 1.0, 130); emit(0.5, -0.7, 0.65, 100); },
    settleShort: () => emit(-0.1, 1.15, 0.75, 120),
    crouch: () => { jelly.v = 0.2; jelly.a = 0; kick('rise', 16, 0.7); },   // 沉稳地微沉蓄力，不夸张压扁
  };

  function run(name) {
    const sc = SCRIPTS[name];
    // 还没完全退场又被召唤：从当前的亮度接着来
    if (sc.pre) { const a = S.alpha; Object.assign(S, sc.pre); if (sc.fresh) S.alpha = a; }
    if (sc.fresh) {
      // 两翼先收着，由弹簧带开：甩出来之后还要再荡两下
      Q.liftR = target.liftR + 0.2; Q.liftL = target.liftL - 0.15; Q.reachR = target.reachR - 0.08; U.liftR = U.liftL = U.reachR = 0;
      pulses.length = 0; nextPulse = 2.6; nextAct = 5;
    }
    script = sc; from = { ...S }; at = 0; cues = 0;
  }

  function step(dt) {
    dt = Math.min(dt, 0.05);
    // 身体的量：阻尼足的弹簧，利落地到位。翼尖的量：又慢又松的弹簧，拖在后面、会过头
    const W = 6.2, Z = 1.05, W2 = 3.0, Z2 = 0.9;
    for (const k in off) off[k] = 0;
    if (!room || state !== 'think' || !present) {
      for (let n = bumps.length - 1; n >= 0; n--) {
        const b = bumps[n];
        if (b.big && b.t > 0) b.t = Math.max(b.t, b.d * 0.62);
        else if (state !== 'think' && !b.hold && b.d >= 3 && b.t > 0) b.t = Math.max(b.t, b.d * 0.35);
      }
    }
    for (let n = bumps.length - 1; n >= 0; n--) {
      const b = bumps[n]; b.t += dt;
      const u = b.t / b.d;
      if (u >= 1) { bumps.splice(n, 1); continue; }
      off[b.k] = (off[b.k] || 0) + b.a * (b.hold ? smooth(0, 0.26, u) * (1 - smooth(0.62, 1, u)) : smooth(0, 0.3, u) * (1 - smooth(0.3, 1, u)));
    }
    for (const k of SPRUNG) {
      const c = STEADY[k], w = c ? c[0] : W, z = c ? c[1] : Z;
      let g = target[k] + (off[k] || 0);
      if (!room) {
        if (k === 'curl') g = Math.max(g, 0.92);
        else if (k === 'slim') g = 1;
        else if (k === 'swoop') g = 0;
        else if (k === 'liftR' || k === 'liftL' || k === 'reachR') g *= 0.25;
      }
      V[k] += (w * w * (g - P[k]) - 2 * z * w * V[k]) * dt; P[k] += V[k] * dt;
    }
    for (const k of TIPS) {
      let g = target[k] + (off[k] || 0);
      if (!room && k !== 'twist') g *= 0.25;
      U[k] += (W2 * W2 * (g - Q[k]) - 2 * Z2 * W2 * U[k]) * dt; Q[k] += U[k] * dt;
    }
    // 叠着的表情：缓缓进、缓缓退，一条平滑的曲线，不弹
    let accLum = 0, accShade = 0, accNod = 0, accFace = 0, accTilt = 0, accFocus = 0, slow = 1;
    riseAdd = sizeAdd = glowAdd = wanderAdd = iriAdd = haloAdd = 0;
    voiceEnergy *= Math.exp(-dt * 7.5);
    edgeBurst *= Math.exp(-dt * 3.2);
    edgePhase += dt * (1.15 + 2.4 * edgeBurst + (state === 'think' ? 0.85 : state === 'talk' ? 1.15 : 0));
    if (acc) {
      acc.t += dt;
      const d = acc.def, u = acc.t / d.dur, e = smooth(0, d.attack || 0.14, u) * (1 - smooth(0.6, 1, u));
      accLum = e * (d.lum || 0); accShade = e * (d.shade || 0); accNod = e * (d.nod || 0); riseAdd = e * (d.rise || 0); slow = 1 - e * (1 - (d.slow || 1));
      sizeAdd = e * (d.size || 0); glowAdd = e * (d.glow || 0); wanderAdd = e * (d.wander || 0); iriAdd = e * (d.iri || 0); haloAdd = e * (d.halo || 0); accFocus = e * (d.focus || 0);
      if (!calm && d.sway) { accFace = e * 0.42 * Math.sin(3.4 * acc.t); accTilt = e * 0.13 * Math.sin(3.4 * acc.t + 1.2); }   // 左右转着看，拿不准
      if (!calm && d.jitter) accTilt = 0.04 * Math.sin(38 * acc.t) * (1 - smooth(0, 0.45, acc.t));                          // 开头抖一下
      if (u >= 1) acc = null;
    }
    clock.t += dt; clock.wave += dt * P.waveRate * slow; clock.flow += dt * P.flow * slow; clock.billow += dt * (0.7 + 0.5 * P.waveRate) * slow;
    clock.breath += dt * TAU / 5.2; clock.glint += dt * (0.28 + 0.55 * P.flow * slow);
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
    // 朝鼠标那边克制地微微侧目：待命时明显一点，倾听敞开等你说话时只极轻地回应，思考、说话、提醒和出错时不分心
    const kl = 1 - Math.exp(-dt * 1.8);
    const pdx = ptr.tx - CX, pdy = ptr.ty - (CY + P.rise);
    const near = Math.hypot(pdx / 430, pdy / 340) < 1;
    const heedWeight = state === 'idle' ? 1 : state === 'listen' ? 0.55 : 0;
    const heed = heedWeight > 0 && ptr.on && near && present && !script && !calm;
    look.x += ((heed ? clamp(pdx / 430, -1, 1) * heedWeight : 0) - look.x) * kl;
    look.y += ((heed ? clamp(pdy / 340, -1, 1) * heedWeight : 0) - look.y) * kl;
    // 自转：思考时分毫不差地匀速；待命时温和微调；不转的状态平稳转回正面
    if (target.spin) spinRate = P.spin * (calm ? 0.3 : 1) * (1 + P.sway * (0.35 * Math.sin(0.23 * t + 0.6) + 0.2 * Math.sin(0.127 * t + 2.2)));
    else spinRate += (-17.6 * clock.spin - 8.4 * spinRate) * dt;   // 从正转着的速度接过来，缓缓转回正面，不是猛地一拧
    // 开心时多转一小段，很快就慢下来
    spinKick *= Math.exp(-dt * 2.2);
    clock.spin += (spinRate + spinKick) * dt;
    // 只要还卷着，转过的角度就原样算数；松到快平了才收回去。转了多少圈不重要，只记离正面最近的那个角度
    const turn = smooth(0.12, 0.62, curlNow), orbitTurn = smooth(0.45, 0.78, curlNow);
    if (turn >= 1 && (clock.spin > Math.PI || clock.spin < -Math.PI)) clock.spin -= TAU * Math.round(clock.spin / TAU);
    spinNow = clock.spin * orbitTurn + (P.face + 0.17 * look.x + accFace) * turn;
    // 球的轴朝观看者倾着；待命时轴的晃动极其沉稳收敛
    const axis = AXIS * k2 + k2 * (P.nod + accNod + dr * (0.065 * Math.sin(0.11 * t + 2) + 0.03 * Math.sin(0.057 * t)) + 0.075 * look.y);
    axisSin = Math.sin(axis); axisCos = Math.cos(axis);
    breathAmp = 0.008 + 0.006 * dr * k2;
    // 张力：接近临界阻尼的微弱呼吸变形，去掉果冻式的来回抖动
    if (calm) jelly.v = 0;
    jelly.v += (-120 * jelly.e - 22 * jelly.v) * dt; jelly.e = clamp(jelly.e + jelly.v * dt, -0.055, 0.055);
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
    // 说话：一个音节一道强光浪，伴随两翼轻展与球面鼓动、虹彩流动，同时轻推边缘波浪
    if (settled && target.speak && !calm) {
      nextSyl -= dt;
      if (nextSyl <= 0) {
        const g = 0.38 + 0.58 * random();
        emit(0.5, 1.05, g, 85); emit(0.5, -1.05, g, 85);
        edgeBurst = clamp(edgeBurst + 0.36 * g, 0, 1.45);
        kick('arch', -0.22 * g, 0.45); kick('liftR', -0.22 * g, 0.45); kick('liftL', 0.22 * g, 0.45);
        kick('size', 0.055 * g, 0.36); kick('glow', 0.55 * g, 0.36); kick('halo', 0.35 * g, 0.38); kick('iri', 0.4 * g, 0.38);
        nextSyl = random() < 0.16 ? 0.62 + 0.32 * random() : 0.22 + 0.26 * random();
      }
    }
    // 提醒：隔一阵轻轻叩两下，双脉冲携光晕与边缘波浪同时亮起
    if (settled && target.knock && !calm) {
      nextKnock -= dt;
      if (nextKnock <= 0) {
        emit(0.5, 1.25, 1.0, 90); emit(0.5, -1.25, 1.0, 90);
        edgeBurst = clamp(Math.max(edgeBurst, 0.92), 0, 1.45);
        kick('size', 0.075, 0.45); kick('glow', 0.85, 0.45); kick('halo', 0.48, 0.45); jelly.v += 0.08; jelly.a = Math.PI / 2;
        knocked = 1 - knocked; nextKnock = knocked ? 0.22 : 2.2;
      }
    }
    // 小动作
    if (settled && target.acts) { nextAct -= dt; if (nextAct <= 0) { act(); nextAct = 3.2 + 4.0 * random(); } }
    if (settled && target.think > 0.5 && !calm) { nextPonder -= dt; if (nextPonder <= 0) { ponder(); nextPonder = 2.4 + 2.0 * random(); } }
    // 鼠标（不做手电筒光斑和拨丝，只保留克制的近场注视）
    const pa = ptr.on && settled ? 1 : 0, kf = 1 - Math.exp(-dt * 9);
    ptr.a += (pa - ptr.a) * (1 - Math.exp(-dt * 5)); ptr.x += (ptr.tx - ptr.x) * kf; ptr.y += (ptr.ty - ptr.y) * kf;
    touch.x = ptr.x; touch.y = ptr.y; touch.g = 0;

    // 大气包络：待命、报错与紧凑小头像保有柔和气场；完全舒展时化散，绝无硬球壳感
    {
      const sizeNow = (P.size + sizeAdd + 0.04 * voiceEnergy) * (1 + breathAmp * breathNow) * S.grow * yawnSize;
      const R = HALF * sizeNow / (WRAP * (0.48 + 0.52 * curlNow)), shrink = 1 - 0.9 * S.fly;
      const c = Math.cos(tiltNow), s = Math.sin(tiltNow);
      place(0, 0, spot);
      shell.x = spot[0]; shell.y = spot[1]; shell.r = R * shrink * 1.03;
      shell.m[0] = c * soft[0] - s * soft[2]; shell.m[1] = c * soft[1] - s * soft[3]; shell.m[2] = s * soft[0] + c * soft[2]; shell.m[3] = s * soft[1] + c * soft[3];
      const born = S.focusX < 1e8 ? smooth(900, 1900, S.focusX) : 1;
      shell.a = smooth(0.68, 0.86, curlNow) * S.focus * born * (1 - S.slack) * (1 + 0.6 * S.fly) * P.glow;
    }
    // 染色和整体亮度：颜色缓缓换过去，免得一跳
    const hue = (acc && acc.def.hue) || target.hue, kh = 1 - Math.exp(-dt * 6);
    if (hue) for (let i = 0; i < 3; i++) hueNow[i] += (hue[i] - hueNow[i]) * kh;
    tint[0] = hueNow[0]; tint[1] = hueNow[1]; tint[2] = hueNow[2]; tint[3] = clamp(P.shade + accShade, 0, 1);
    dyn.gain = Math.max(0, P.lum + accLum);
    dyn.orb = smooth(0.25, 0.9, curlNow); dyn.alpha = S.alpha; dyn.focus = S.focus * clamp(P.focus + accFocus, 0.35, 1.25); dyn.when.think = clamp(P.think, 0, 1);
    dyn.flow = clock.flow; dyn.wander = P.wander + wanderAdd + 0.65 * voiceEnergy; dyn.billow = P.billow * (1 + 0.35 * breathNow) + 0.2 * S.slack; dyn.billowPhase = clock.billow;
    dyn.glint = Math.max(0.1, P.glint + 1.4 * voiceEnergy); dyn.glintPhase = clock.glint;
    dyn.revealX = S.headX; dyn.focusX = S.focusX; dyn.hideX = curlNow > 0.55 ? -1e9 : S.hideX; dyn.sweep = S.sweep;
    // 还是雾的时候，结点的光收着，对上焦才亮起来
    const lit = S.focusX < 1e8 ? 0.35 + 0.65 * smooth(700, 1900, S.focusX) : 1;
    dyn.glow = (P.glow + glowAdd + 0.38 * voiceEnergy) * (1 + 0.08 * breathNow) * (1 + 0.35 * S.flash + 1.6 * S.fly) * lit;
    dyn.thread = P.thread * (0.55 + 0.45 * lit); dyn.hem = (1 + 0.3 * S.flash + 1.3 * S.fly) * (0.55 + 0.45 * lit); dyn.film = 0.6 + 0.4 * lit; dyn.dofR = P.dofR;
    dyn.iri = clamp(P.iri + iriAdd + 0.45 * voiceEnergy, 0.2, 2.2);
    dyn.halo = clamp(P.halo + haloAdd + 0.38 * voiceEnergy, 0.4, 2.2);
    dyn.edge = clamp((P.edge + (calm ? 0 : edgeBurst)) * S.alpha, 0, 1.6);
    dyn.edgeBurst = calm ? 0 : clamp(edgeBurst * S.alpha, 0, 1.5);
    dyn.edgePhase = edgePhase;
  }

  const api = {
    dyn, S, P, Q, clock, step,
    get state() { return state; },
    get present() { return present; },
    get busy() { return !!script; },
    setState(name) {
      if (!STATES[name]) return;
      state = name; target = STATES[name]; nextPulse = Math.min(nextPulse, 0.6); nextAct = Math.max(nextAct, 4);
      if (name === 'think') { nextPonder = 0.05; sinceFree = Math.max(sinceFree, 3); }   // 进入思考瞬间触发立体变形
    },
    /** 立刻摆到某个状态，不走过渡。 */
    snap(name) {
      api.setState(name);
      for (const k of SPRUNG) {
        let g = target[k];
        if (!room) { if (k === 'curl') g = Math.max(g, 0.92); else if (k === 'slim') g = 1; else if (k === 'swoop') g = 0; }
        P[k] = g; V[k] = 0;
      }
      for (const k of TIPS) { Q[k] = target[k]; U[k] = 0; }
      if (name === 'think') { sinceFree = 0; nextPonder = 1.6; }
    },
    /** 召唤。短时间内再次召唤用 short（传 true）；小头像用 'tiny'。 */
    arrive(short = false) { present = true; run(short === 'tiny' ? 'arriveTiny' : short ? 'arriveShort' : 'arrive'); },
    /** 退场。how：'close' 安静散去；'go' 领了任务去办；'tiny' 小头像随底板一起淡出。 */
    depart(how = 'close') { present = false; run(how === 'go' ? 'go' : how === 'tiny' ? 'closeTiny' : 'close'); },
    /** 有人说了点什么（打了一个字、声音响了一下）：一圈涟漪从中间荡向两翼并推动边缘波浪。k 是轻重，0..1。 */
    poke(k = 0.6) {
      if (!present) return;
      if (calm) { kick('glow', 0.3 * k, 0.5); return; }
      const g = 0.5 + 0.6 * k;
      voiceEnergy = clamp(Math.max(voiceEnergy, k * 1.15), 0, 1.5);
      edgeBurst = clamp(edgeBurst * 0.5 + k * 0.95, 0, 1.5);
      emit(0.5, 1.15, g, 95); emit(0.5, -1.15, g, 95);
      kick('size', 0.038 * k, 0.4); kick('arch', -0.15 * k, 0.45); kick('focus', 0.14 * k, 0.42);
      kick('billow', 0.14 * k, 0.45); kick('glow', 0.58 * k, 0.45); kick('iri', 0.4 * k, 0.45); kick('halo', 0.42 * k, 0.45);
      // 打字/声音响应保持柔和沉稳，不生硬弹跳
      jelly.v = clamp(jelly.v + 0.09 * k, -0.4, 0.4); jelly.a = Math.PI / 2;
    },
    /** 回复里的表情，叠在当前状态上放一小段。不认识的名字返回 false。 */
    accent(name) {
      const def = ACCENTS[name];
      if (!def) return false;
      acc = { kind: name, def, t: 0 };
      if (!present || calm) return true;
      const both = (v, g, w) => { emit(0.5, v, g, w); emit(0.5, -v, g, w); };
      if (name === 'happy') { spinKick = ACCENTS.happy.spin; both(0.8, 0.7, 100); }                     // 亮起来、微微上浮、多转一小段，光从中间散开
      else if (name === 'surprised') { jelly.v += 0.1; jelly.a = Math.PI / 2; both(1.3, 0.8, 80); }   // 一下子胀起来、往上提
      else if (name === 'confused') kick('tilt', 0.1, 2.4);
      else if (name === 'done') { spinKick = ACCENTS.done.spin; both(1.0, 1.0, 100); both(0.6, 0.7, 130); }   // 事情办完：舒展一下，两道光接连荡出去
      return true;
    },
    /** 思考时会出的球形，按序号立刻演一遍（给实验页和测试用）。 */
    free(n) { FREE[n]?.(); return FREE.length; },
    /** 周围放不放得下一个舒展开的形态（球画得够大才放）。 */
    setRoom(on) { room = !!on; },
    /** 减弱动态效果：不游移、不颤、不做小动作，只留很慢的转动和呼吸。 */
    setReduced(on) { calm = !!on; if (calm) { yawn.t = -1; spinKick = 0; voiceEnergy = 0; edgeBurst = 0; jelly.e = jelly.v = 0; pulses.length = 0; } },
    /** 鼠标在哪（姿态坐标）；离开时传 null。 */
    attend(x, y) { if (x == null) { ptr.on = false; return; } ptr.tx = x; ptr.ty = y; if (!ptr.on && ptr.a < 0.02) { ptr.x = x; ptr.y = y; } ptr.on = true; },
    /** 直接在场，不演入场。 */
    show() { present = true; script = null; Object.assign(S, HERE); },
    hide() { present = false; script = null; acc = null; Object.assign(S, GONE); pulses.length = 0; edgeBurst = 0; },
    /** 回到初始：时钟、随机数、流光都清零（给可重复的截图用）。 */
    reset() { for (const k in clock) clock[k] = 0; rnd = seed; pulses.length = 0; nextPulse = 2; nextAct = 3.5; ptr.on = false; ptr.a = 0; jelly.e = jelly.v = 0; look.x = look.y = 0; yawn.t = -1; yawnSize = 1; spinRate = 0; spinKick = 0; voiceEnergy = 0; edgeBurst = 0; edgePhase = 0; nextSyl = 0.2; nextKnock = 0.5; knocked = 0; nextPonder = 1.2; lastPhase = -1; lastFree = -1; sinceFree = 0; bumps.length = 0; api.hide(); api.snap('idle'); },
  };
  return api;
}
