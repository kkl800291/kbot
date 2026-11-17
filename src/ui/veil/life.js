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
const AMBER = [1.0, 0.74, 0.22], RED = [1.0, 0.22, 0.26], SAPPHIRE = [0.22, 0.58, 1.0], SOLAR = [1.0, 0.64, 0.22], CYAN = [0.24, 0.94, 1.0], GOLD = [1.0, 0.82, 0.42];
export const STATES = {
  // 待命：沉静珠光球（唯一收拢的休眠居所），柔和玻璃泡包裹，缓慢自转深呼吸
  idle: { spread: 1, size: 1.16, curl: 0.98, slim: 1, swoop: 0, arch: 0, spin: 0.14, sway: 1, face: FACE, nod: 0, drift: 1, liftR: 0, liftL: 0, reachR: 0, tilt: -0.09, rise: 50, twist: 0, think: 0, wave: 0.74, waveRate: 0.82, wander: 0.95, flow: 0.52, billow: 0.08, pulseEvery: 4.8, pulseSpeed: 0.32, pulseGain: 0.72, pulseWidth: 125, steady: 0, glow: 0.92, thread: 0.9, dofR: 0, acts: 1, lum: 0.94, iri: 1.0, halo: 0.95, glint: 0.75, edge: 0.18 },
  // 倾听：凌波青蓝新月纱（融解硬球壳、收纤腰腹），斜悬在空中面向你轻柔波动，等待声音与打字激起声波
  listen: { spread: 1.04, size: 0.96, curl: 0.62, slim: 0.6, swoop: 0.45, arch: -0.06, spin: 0, sway: 0, face: -0.45, nod: 0.14, drift: 0.55, liftR: -0.08, liftL: 0.08, reachR: 0.05, tilt: -0.22, rise: 54, twist: 0.16, think: 0, wave: 0.85, waveRate: 1.25, wander: 1.15, flow: 0.95, billow: 0.14, pulseEvery: 0, pulseSpeed: 0.95, pulseGain: 0.85, pulseWidth: 95, steady: 0, glow: 1.05, thread: 1.08, dofR: 0, acts: 0, lum: 1.04, shade: 0.58, hue: CYAN, iri: 1.5, halo: 1.22, glint: 1.8, edge: 0.26 },
  // 思考：深钴蓝旋转莫比乌斯涡旋纱，丝流急旋穿织，并随时绽放七种极光天幕立体蜕变
  think: { spread: 1.02, size: 0.88, curl: 0.72, slim: 0.74, swoop: 0.25, arch: 0, spin: 0.95, sway: 0, face: FACE, nod: 0, drift: 0.3, liftR: 0, liftL: 0, reachR: 0, tilt: -0.22, rise: 52, twist: 0.56, think: 1, wave: 0.45, waveRate: 0.95, wander: 0.8, flow: 1.55, billow: 0.07, pulseEvery: 0.85, pulseSpeed: 0.45, pulseGain: 1.05, pulseWidth: 95, steady: 1, glow: 1.0, thread: 1.16, dofR: 0, acts: 0, lum: 1.0, shade: 0.68, hue: SAPPHIRE, iri: 1.55, halo: 1.15, glint: 2.2, edge: 0.38 },
  // 说话：炽金天际极光绸带（收窄腰腹、彻底舒展平铺成修长光幕），随音节掀起流动 S 形浪涌
  talk: { spread: 1.08, size: 0.68, curl: 0.1, slim: 0.36, swoop: 1, arch: 0.08, spin: 0.12, sway: 0.4, face: 0.2, nod: 0.04, drift: 0.6, liftR: 0, liftL: 0, reachR: 0, tilt: -0.1, rise: 50, twist: 0.12, think: 0, wave: 1.85, waveRate: 1.55, wander: 1.5, flow: 1.65, billow: 0.22, pulseEvery: 0, pulseSpeed: 0.44, pulseGain: 0.92, pulseWidth: 135, steady: 0, glow: 1.1, thread: 1.12, dofR: 0, acts: 0, speak: 1, lum: 1.06, shade: 0.64, hue: SOLAR, iri: 1.65, halo: 1.32, glint: 2.4, edge: 0.44 },
  // 提醒：液态琥珀流光耀冠，微展亮弧伴随双重脉冲唤醒
  remind: { spread: 1.04, size: 1.0, curl: 0.72, slim: 0.66, swoop: 0.35, arch: -0.08, spin: 0.1, sway: 0, face: 0.24, nod: 0.14, drift: 0.4, liftR: -0.08, liftL: 0.08, reachR: 0.04, tilt: 0.08, rise: 52, twist: -0.35, think: 0, wave: 0.8, waveRate: 1.1, wander: 1.0, flow: 0.85, billow: 0.12, pulseEvery: 0, pulseSpeed: 1.1, pulseGain: 0.95, pulseWidth: 95, steady: 0, glow: 1.24, thread: 1.15, dofR: 0, acts: 0, knock: 1, lum: 1.12, shade: 0.74, hue: AMBER, iri: 1.35, halo: 1.42, glint: 2.6, edge: 0.56 },
  // 出错：坍缩暗红残翼余烬，收拢下沉倾斜，黯淡失色
  error: { spread: 0.94, size: 0.8, curl: 0.96, slim: 0.9, swoop: 0, arch: 0.25, spin: 0.015, sway: 0, face: FACE, nod: -0.18, drift: 0.18, liftR: 0.16, liftL: -0.16, reachR: 0, tilt: -0.34, rise: 88, twist: 0.15, think: 0, wave: 0.16, waveRate: 0.35, wander: 0.28, flow: 0.1, billow: 0.015, pulseEvery: 0, pulseSpeed: 0.3, pulseGain: 0.5, pulseWidth: 110, steady: 0, glow: 0.56, thread: 0.52, dofR: 0, acts: 0, lum: 0.52, shade: 0.88, hue: RED, iri: 0.35, halo: 0.55, glint: 0.2, edge: 0.32 },
};
const EXTRA = { lum: 1, shade: 0, hue: null, speak: 0, knock: 0, iri: 1, halo: 1, glint: 0.5, edge: 0.2, slim: 1, swoop: 0 };
for (const k in STATES) STATES[k] = { ...EXTRA, ...STATES[k] };

/**
 * 回复里的表情。dur 秒数；attack 多快到顶（占 dur 的比例）；lum 亮度增减；shade、hue 染色；rise 往下沉多少（负数是往上）；nod 低头；
 * size 球变大变小；glow 光亮增减；wander 丝游得多乱；slow 身上的流动放慢到几成；spin 多转一小段；sway 左右转着看；jitter 轻抖；iri、halo 虹彩与光晕变化。
 * 全都是一条平滑的起落曲线叠在状态上，不用冲量，所以不会弹。
 */
export const ACCENTS = {
  happy: { dur: 2.2, lum: 0.3, shade: 0.34, hue: GOLD, rise: -20, size: 0.12, glow: 0.35, spin: 2.0, iri: 0.45, halo: 0.35 },
  surprised: { dur: 1.6, attack: 0.07, lum: 0.38, shade: 0.26, hue: [1, 1, 1], rise: -24, size: 0.17, glow: 0.42, nod: -0.06, iri: 0.5, halo: 0.4 },
  confused: { dur: 2.8, shade: 0.26, hue: [0.84, 0.8, 1.0], wander: 0.95, sway: 1, iri: 0.3, halo: 0.15 },
  sad: { dur: 3.8, lum: -0.4, shade: 0.56, hue: SAPPHIRE, rise: 28, size: -0.07, nod: 0.18, slow: 0.38, iri: -0.35, halo: -0.25 },
  sleepy: { dur: 3.8, lum: -0.32, rise: 16, size: -0.04, nod: 0.22, slow: 0.3, iri: -0.28, halo: -0.2 },
  annoyed: { dur: 2.2, lum: 0.1, shade: 0.58, hue: RED, size: -0.09, jitter: 1, iri: -0.35, halo: 0.18 },
  done: { dur: 1.6, lum: 0.34, shade: 0.28, hue: GOLD, size: 0.14, glow: 0.45, spin: 2.4, iri: 0.55, halo: 0.42 },
};
const SPRUNG = ['spread', 'size', 'curl', 'slim', 'swoop', 'arch', 'spin', 'sway', 'face', 'nod', 'drift', 'liftR', 'liftL', 'reachR', 'tilt', 'rise', 'twist', 'think', 'wave', 'waveRate', 'wander', 'flow', 'billow', 'glow', 'thread', 'dofR', 'lum', 'shade', 'iri', 'halo', 'glint', 'edge'];
const TIPS = ['liftR', 'liftL', 'reachR', 'twist'];   // 这几个量在翼尖上另有一套更慢、更松的弹簧
const STEADY = { curl: [2.7, 1], slim: [2.8, 1], swoop: [2.8, 1], arch: [3, 0.85], spin: [1.6, 1], sway: [1.6, 1], face: [3.4, 1], nod: [3.4, 0.8], size: [3.4, 0.82], rise: [3.4, 0.82], tilt: [3, 1] };   // 这几个量慢慢来，不回弹：卷起来是件郑重的事

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

  /** 把姿态里的一个点挪到这一帧的位置：平滑丝滑的多相光纱演化（无生硬分段拼缝）。 */
  function warp(x0, y0, out, group) {
    let x = x0, y = y0;
    const win = smooth(520, 640, x0) * (1 - smooth(840, 930, x0));   // 只在环上、不碰结点
    // 拧：上下两半朝相反方向各走半个波
    const wr = smooth(940, 1070, x0), wl = 1 - smooth(380, 505, x0);
    if (group && x0 > 515 && x0 < 925) {
      const tw = P.twist + (Q.twist - P.twist) * 0.5;
      if (tw > 0.001 || tw < -0.001) y += group * tw * 92 * Math.sin(TAU * (x0 - 515) / 410);
    }
    // 波与收纤：位置的函数，所以挨在一起的点一起动。展开态自然收窄腰腹并掠出天际 S 形极光曲线
    const far = Math.min(1, Math.abs(x0 - CX) / 470), tw = clock.wave;
    if (P.slim < 0.999) {
      const slimScale = (P.slim + (1 - P.slim) * 0.22 * (1 - far)) * (1 - 0.34 * (1 - P.slim) * Math.pow(far, 1.7));
      y = CY + (y - CY) * slimScale;
    }
    if (P.swoop > 0.001 || P.swoop < -0.001) {
      const sNorm = clamp((x0 - CX) / HALF, -1, 1);
      y -= P.swoop * 52 * Math.sin(Math.PI * sNorm * 0.85 + 0.3);
    }
    const amp = (P.wave + 1.3 * S.slack + 0.8 * voiceEnergy) * (0.3 + 0.7 * far * Math.sqrt(far));
    y += amp * (15 * Math.sin(0.0098 * x0 - 1.55 * tw) + 6.5 * Math.sin(0.0185 * x0 + 0.006 * y0 - 2.5 * tw + 2.1));
    if (voiceEnergy > 0.002) y += voiceEnergy * 10 * (0.35 + 0.65 * far) * Math.sin(0.023 * x0 - 6.2 * tw);
    x += amp * 6.5 * Math.sin(0.0085 * y0 + 0.0035 * x0 - 0.9 * tw + 0.7);
    // 环上有一个鼓包顺着走过去：这一段宽了，那一段就窄，不是整体一张一合
    if (group) y += group * win * P.wave * 5 * Math.sin(0.0153 * x0 - 1.2 * tw + 0.9);
    // 两端下垂或扬起
    if (archNow) { const sx = (x0 - CX) / HALF; y += archNow * 90 * (sx * sx - 0.3); }
    // 流光是有分量的：经过的地方起一道清晰的涟漪
    for (let n = 0; n < pulses.length; n++) {
      const p = pulses[n], d = (x0 - p.x) / p.w;
      if (d > -2.4 && d < 2.4) y += p.g * 8.5 * Math.sin(d * 3.1) * Math.exp(-d * d);
    }
    // 两翼：绕着结点转
    if (wr > 0) {
      const a = P.liftR + (Q.liftR - P.liftR) * wr + 0.025 * look.y + P.wave * 0.075 * wr * Math.sin(0.83 * tw - 2.4 * wr);
      const k = 1 + (P.reachR + (Q.reachR - P.reachR) * wr) * wr, c = Math.cos(a * wr), s = Math.sin(a * wr);
      const dx = (x - PIVOT_R[0]) * k, dy = (y - PIVOT_R[1]) * k;
      x = PIVOT_R[0] + dx * c - dy * s; y = PIVOT_R[1] + dx * s + dy * c;
    }
    if (wl > 0) {
      const a = (P.liftL + (Q.liftL - P.liftL) * wl - 0.025 * look.y + P.wave * 0.06 * wl * Math.sin(0.66 * tw + 1.4 - 2.2 * wl)) * wl, c = Math.cos(a), s = Math.sin(a);
      const dx = x - PIVOT_L[0], dy = y - PIVOT_L[1];
      x = PIVOT_L[0] + dx * c - dy * s; y = PIVOT_L[1] + dx * s + dy * c;
    }
    // 入场：前端收成细细一束，往后才展开成纱；刚甩出来的那一段还在抖
    if (S.headX < 1e8) {
      const back = Math.max(0, S.headX - x0);
      y = CY + 12 + (y - CY - 12) * (1 - 0.82 * S.tip * Math.exp(-back / 190));
      y += S.whip * 34 * Math.exp(-back / 460) * Math.sin(0.0105 * x0 - 9.5 * at);
    } else if (S.whip > 0.001) y += S.whip * 34 * Math.sin(0.0105 * x0 - 9.5 * at) * Math.exp(-Math.max(0, 1500 - x0) / 460);
    // 卷：身体的长度方向绕到球的经线上，上下方向落到纬线上。卷得越紧球越小，展开则化为天际流动极光
    const size = (P.size + sizeAdd + 0.04 * voiceEnergy) * (1 + breathAmp * breathNow) * S.grow * yawnSize;
    let dx = (x - CX) * P.spread * size, dy = (y - CY) * size;
    if (curlNow > 0.015) {
      const m = curlNow, R = HALF * size / (WRAP * m), phi = (x - CX) / HALF * WRAP * m + spinNow, lam = (y - CY) * size * (1 - 0.19 * m) / R;
      const cl = Math.cos(lam), zc = cl * Math.cos(phi), st = axisSin, ct = axisCos, Y = R * Math.sin(lam);
      dx = R * cl * Math.sin(phi) * P.spread; dy = Y * ct + R * (zc - 1) * st;
      out[2] = zc * ct - Y / R * st;
      // 球是软的：绕着球心被轻轻压扁、拉长
      const oy = -R * st, ey = dy - oy, ex = dx;
      dx = soft[0] * ex + soft[1] * ey; dy = oy + soft[2] * ex + soft[3] * ey;
    } else out[2] = 0;
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

  // 思考时慢慢演化形态：在涡旋中柔和舒张、偏转与加速，随时流化为天际极光长绸
  const PONDER = [
    // 微舒：略微松开旋幅并拉升波浪，像拨开一点思绪
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.14, 3.8); kick('slim', -0.12, 3.8); kick('swoop', 0.25, 3.8); kick('arch', 0.22 * s, 3.8); kick('wave', 0.5, 3.8); kick('iri', 0.35, 3.8); emit(0.5, 0.38, 0.78, 150); emit(0.5, -0.38, 0.78, 150); },
    // 编织：上下丝层反向拧转、流丝加速
    () => { const s = random() < 0.5 ? -1 : 1; kick('twist', 0.32 * s, 3.6); kick('wander', 0.85, 3.6); kick('flow', 0.55, 3.6); kick('size', -0.06, 3.6); kick('halo', 0.2, 3.6); emit(-0.1, 0.6, 0.85, 105); },
    // 转面：慢慢转到涡旋的另一侧观察
    () => { const s = random() < 0.5 ? -1 : 1; kick('face', s * 1.15, 4.2); kick('nod', 0.16, 4.2); kick('tilt', 0.14 * s, 4.2); },
    // 聚核：收紧并提速聚焦
    () => { kick('size', -0.1, 3.2); kick('curl', 0.12, 3.2); kick('spin', 0.55, 3.2); kick('glow', 0.26, 3.2); kick('halo', -0.15, 3.2); kick('rise', -4, 3.2); emit(0.5, 0.7, 0.9, 85); emit(0.5, -0.7, 0.9, 85); },
    // 斜掠：轻轻舒展一翼并微微侧倾
    () => { kick('reachR', 0.18, 3.6); kick('liftR', -0.24, 3.6); kick('tilt', 0.12, 3.6); kick('curl', -0.1, 3.6); kick('iri', 0.3, 3.6); emit(0.2, 0.8, 0.85, 110); },
    // 共振：双向光浪穿过窄腰光幕
    () => { kick('wave', 0.8, 3.4); kick('billow', 0.09, 3.4); kick('halo', 0.28, 3.4); kick('iri', 0.4, 3.4); emit(0.0, 1.0, 0.9, 95); emit(1.0, -1.0, 0.9, 95); },
  ];
  // 七大流线天际极光蜕变：统一由连续光纱收纤扭转而成，全程零拼缝
  const big = { hold: true, big: true };
  const FREE = [
    // 0 · 天际极光：舒展为修长柔和的横向S形流光幕
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.6, 6.0, big); kick('slim', -0.38, 6.0, big); kick('swoop', 0.75, 6.0, big); kick('size', -0.26, 6.0, big); kick('rise', 22, 6.0, big); kick('tilt', 0.12 * s, 6.0, big); kick('wave', 0.8, 6.0, big); kick('iri', 0.45, 6.0, big); kick('halo', 0.3, 6.0, big); emit(-0.1, 0.9, 0.95, 110); },
    // 1 · 凌空新月：侧偏敞开成一道优雅悬空新月光弧
    () => { kick('curl', -0.18, 5.4, big); kick('slim', -0.16, 5.4, big); kick('swoop', 0.35, 5.4, big); kick('face', -0.8, 5.4, big); kick('arch', -0.22, 5.4, big); kick('size', -0.04, 5.4, big); kick('rise', 12, 5.4, big); kick('tilt', 0.28, 5.4, big); kick('iri', 0.4, 5.4, big); emit(0.5, 0.7, 0.85, 100); emit(0.5, -0.7, 0.85, 100); },
    // 2 · 垂天羽流：大角度斜竖起身，如北极光柱凌空螺旋升腾
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.44, 5.8, big); kick('slim', -0.34, 5.8, big); kick('swoop', 0.55, 5.8, big); kick('tilt', 0.82, 5.8, big); kick('size', -0.36, 5.8, big); kick('rise', 14, 5.8, big); kick('twist', 0.15 * s, 5.8, big); kick('spin', 0.35, 5.8, big); emit(0, 0.9, 0.9, 95); },
    // 3 · 星海波涛：大起伏极光浪带翻涌游走
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.56, 5.8, big); kick('slim', -0.38, 5.8, big); kick('swoop', 0.75 * s, 5.8, big); kick('wave', 1.25, 5.8, big); kick('size', -0.26, 5.8, big); kick('rise', 16, 5.8, big); kick('halo', 0.35, 5.8, big); emit(0.5, 0.6, 0.85, 120); emit(0.5, -0.6, 0.85, 120); },
    // 4 · 舒展天翼：修长双翼随流体斜角掠过
    () => { kick('curl', -0.4, 5.8, big); kick('slim', -0.3, 5.8, big); kick('swoop', 0.55, 5.8, big); kick('liftR', -0.24, 5.8, big); kick('liftL', 0.24, 5.8, big); kick('reachR', 0.14, 5.8, big); kick('size', -0.26, 5.8, big); kick('rise', 18, 5.8, big); kick('tilt', -0.14, 5.8, big); kick('iri', 0.45, 5.8, big); emit(0.5, 0.8, 0.9, 100); emit(0.5, -0.8, 0.9, 100); },
    // 5 · 莫比乌斯：半卷拧折成一道立体斜倾的无穷丝环
    () => { const s = random() < 0.5 ? -1 : 1; kick('curl', -0.24, 5.6, big); kick('slim', -0.22, 5.6, big); kick('swoop', 0.35, 5.6, big); kick('twist', 0.36 * s, 5.6, big); kick('tilt', 0.38 * s, 5.6, big); kick('size', -0.18, 5.6, big); kick('rise', 14, 5.6, big); kick('flow', 0.65, 5.6, big); kick('iri', 0.55, 5.6, big); emit(0, 1.0, 0.95, 90); emit(1, -1.0, 0.95, 90); },
    // 6 · 霓虹涟漪：半透虹彩天幕全面荡开微光
    () => { kick('curl', -0.5, 5.6, big); kick('slim', -0.34, 5.6, big); kick('swoop', 0.6, 5.6, big); kick('spread', 0.08, 5.6, big); kick('wave', 0.9, 5.6, big); kick('size', -0.24, 5.6, big); kick('rise', 18, 5.6, big); kick('glow', 0.28, 5.6, big); kick('iri', 0.65, 5.6, big); kick('halo', 0.35, 5.6, big); emit(0.5, 0.9, 0.95, 120); emit(0.5, -0.9, 0.95, 120); },
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
    let accLum = 0, accShade = 0, accNod = 0, accFace = 0, accTilt = 0, slow = 1;
    riseAdd = sizeAdd = glowAdd = wanderAdd = iriAdd = haloAdd = 0;
    voiceEnergy *= Math.exp(-dt * 7.5);
    edgeBurst *= Math.exp(-dt * 3.2);
    edgePhase += dt * (1.15 + 2.4 * edgeBurst + (state === 'think' ? 0.85 : state === 'talk' ? 1.15 : 0));
    if (acc) {
      acc.t += dt;
      const d = acc.def, u = acc.t / d.dur, e = smooth(0, d.attack || 0.14, u) * (1 - smooth(0.6, 1, u));
      accLum = e * (d.lum || 0); accShade = e * (d.shade || 0); accNod = e * (d.nod || 0); riseAdd = e * (d.rise || 0); slow = 1 - e * (1 - (d.slow || 1));
      sizeAdd = e * (d.size || 0); glowAdd = e * (d.glow || 0); wanderAdd = e * (d.wander || 0); iriAdd = e * (d.iri || 0); haloAdd = e * (d.halo || 0);
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
    const turn = smooth(0.12, 0.62, curlNow);
    if (turn >= 1 && (clock.spin > Math.PI || clock.spin < -Math.PI)) clock.spin -= TAU * Math.round(clock.spin / TAU);
    spinNow = (clock.spin + P.face + 0.17 * look.x + accFace) * turn;
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

    // 玻璃泡外壳：待命、报错与紧凑小头像保有球壳；倾听新月、思考涡旋与说话极光带时自然褪去圆泡外壳，只留流动光纱
    {
      const sizeNow = (P.size + sizeAdd + 0.04 * voiceEnergy) * (1 + breathAmp * breathNow) * S.grow * yawnSize, R = HALF * sizeNow / (WRAP * Math.max(curlNow, 0.3)), shrink = 1 - 0.9 * S.fly;
      const c = Math.cos(tiltNow), s = Math.sin(tiltNow);
      place(0, -R * axisSin, spot);
      shell.x = spot[0]; shell.y = spot[1]; shell.r = R * shrink * 1.03;
      shell.m[0] = c * soft[0] - s * soft[2]; shell.m[1] = c * soft[1] - s * soft[3]; shell.m[2] = s * soft[0] + c * soft[2]; shell.m[3] = s * soft[1] + c * soft[3];
      const born = S.focusX < 1e8 ? smooth(900, 1900, S.focusX) : 1;
      shell.a = smooth(0.74, 0.9, curlNow) * S.focus * born * (1 - S.slack) * (1 + 0.6 * S.fly) * P.glow;
    }
    // 染色和整体亮度：颜色缓缓换过去，免得一跳
    const hue = (acc && acc.def.hue) || target.hue, kh = 1 - Math.exp(-dt * 6);
    if (hue) for (let i = 0; i < 3; i++) hueNow[i] += (hue[i] - hueNow[i]) * kh;
    tint[0] = hueNow[0]; tint[1] = hueNow[1]; tint[2] = hueNow[2]; tint[3] = clamp(P.shade + accShade, 0, 1);
    dyn.gain = Math.max(0, P.lum + accLum);
    dyn.orb = smooth(0.25, 0.9, curlNow); dyn.alpha = S.alpha; dyn.focus = S.focus; dyn.when.think = clamp(P.think, 0, 1);
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
      kick('size', 0.045 * k, 0.4); kick('arch', -0.18 * k, 0.45);
      kick('billow', 0.16 * k, 0.45); kick('glow', 0.65 * k, 0.45); kick('iri', 0.55 * k, 0.45); kick('halo', 0.45 * k, 0.45);
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
