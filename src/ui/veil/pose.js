/* KBOT · 活体光场 · 流光拓扑骨架
 * 不再使用对称双翼的平面带轮廓，改用 6 股独立的三维光学丝流（stream）：
 * 每片纱在静态表里记录顺流参数 x0（对应环角 u ∈ [-1, 1]）与横向丝带偏置 y0（对应带边 A/B），
 * 由 life.js 的三维投影把它们编织成无硬壳、有前后景深与自然折叠焦散的悬浮光场；
 * 说话或完全展开时，再平滑舒展为多股三维声波丝流。
 */

export const SPACE = { w: 1536, h: 1024, cx: 765, cy: 350 };
const CX = 765, CY = 345, HALF = 470;

const C = {
  white: [0.95, 0.96, 1.0],
  lav: [0.80, 0.82, 1.0],
  blue: [0.60, 0.74, 1.0],
  cyan: [0.68, 0.91, 1.0],
  warm: [1.0, 0.88, 0.70],
  orange: [1.0, 0.72, 0.44],
};

/** 每股流光在静态姿态下的基准纵弯曲线 [archY, skewY]，供 life.js 三维展开时精准剥离，确保丝带完全居中对称。 */
export const STREAM_CURVE = {
  1: [-18, -32],
  '-1': [22, 34],
  2: [-46, 18],
  '-2': [48, -16],
  3: [0, 26],
  '-3': [0, -26],
};

/** 返回第 group 股流光在横坐标 x0 处相对 CY 的静态中线偏移。 */
export function streamMid(group, x0) {
  const c = STREAM_CURVE[group];
  if (!c) return 0;
  const u = (x0 - CX) / HALF;
  return c[1] * Math.sin(u * Math.PI * 0.85) + c[0] * (u * u - 0.35);
}

/** 生成一条顺流参数采样点（x0 沿 [-HALF, HALF]，y0 编码在三维姿态里呈现的丝带偏置和静态轮廓）。 */
function streamEdges(group, n, halfW) {
  const a = [], b = [];
  for (let i = 0; i < n; i++) {
    const u = (i / (n - 1)) * 2 - 1;
    const x = CX + u * HALF;
    // 静态预览下呈现优雅的流线斜弧，而非对称双翼
    const taper = 0.35 + 0.65 * Math.cos(u * Math.PI * 0.46);
    const mid = CY + streamMid(group, x);
    const hw = halfW * taper;
    a.push([Math.round(x), Math.round(mid - hw)]);
    b.push([Math.round(x), Math.round(mid + hw)]);
  }
  return { a, b };
}

const S1 = streamEdges(1, 21, 34);
const S2 = streamEdges(-1, 21, 30);
const S3 = streamEdges(2, 19, 22);
const S4 = streamEdges(-2, 19, 22);
const S5 = streamEdges(3, 17, 18);
const S6 = streamEdges(-3, 17, 16);

export const SHEETS = [
  // 1 · 主斜扫流光：从左下斜掠向右上，正面清晰明亮、绕至背面柔化
  {
    id: 'sweep-main', group: 1, k: 220,
    ...S1,
    lines: 34, cross: 8, bias: 1, gain: 0.3, edgeA: 2.3, edgeB: 2.5, fill: 0.34, rimA: 0.65, rimB: 0.9,
    ca: C.white, cb: C.cyan,
    fade: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
    focus: [[0, 0.95], [1, 0.95]],
    iri: [[0, 0.4], [0.25, 0.8], [0.5, 0.2], [0.75, 0.85], [1, 0.4]],
    veil: [[0, 0.5], [0.2, 1.15], [0.5, 0.85], [0.8, 1.1], [1, 0.5]],
    milk: [[0, 0.25], [0.3, 0.9], [0.7, 0.85], [1, 0.25]],
  },
  // 2 · 对偶斜弧：与主斜扫呈空间反角交汇，在交错处自然生成焦散亮点
  {
    id: 'sweep-counter', group: -1, k: 210,
    ...S2,
    lines: 32, cross: 7, bias: 1, gain: 0.28, edgeA: 2.2, edgeB: 2.2, fill: 0.26, rimA: 0.55, rimB: 0.7,
    ca: C.white, cb: C.lav,
    fade: [[0, 0], [0.1, 1], [0.9, 1], [1, 0]],
    focus: [[0, 0.95], [1, 0.95]],
    iri: [[0, 0.35], [0.3, 0.75], [0.55, 0.15], [0.8, 0.8], [1, 0.35]],
    veil: [[0, 0.45], [0.25, 0.95], [0.75, 0.95], [1, 0.45]],
    milk: [[0, 0.2], [0.35, 0.85], [0.7, 0.8], [1, 0.2]],
  },
  // 3 · 上冠轻纱：撑起上半球空灵轮廓
  {
    id: 'crown-arc', group: 2, k: 160,
    ...S3,
    lines: 20, cross: 4, bias: 0.95, gain: 0.24, edgeA: 1.8, edgeB: 1.2, fill: 0.16, rimA: 0.6, rimB: 0.2,
    ca: C.white, cb: C.blue,
    fade: [[0, 0], [0.12, 1], [0.88, 1], [1, 0]],
    focus: [[0, 0.9], [1, 0.9]],
    iri: [[0, 0.2], [0.5, 0.65], [1, 0.2]],
    veil: [[0, 0.35], [0.5, 0.8], [1, 0.35]],
  },
  // 4 · 下托弧流：从底部承托光场，保持不对称呼吸留白
  {
    id: 'cradle-arc', group: -2, k: 160,
    ...S4,
    lines: 20, cross: 4, bias: 1, gain: 0.24, edgeA: 1.5, edgeB: 1.8, fill: 0.16, rimA: 0.3, rimB: 0.55,
    ca: C.lav, cb: C.white,
    fade: [[0, 0], [0.12, 1], [0.88, 1], [1, 0]],
    focus: [[0, 0.9], [1, 0.9]],
    iri: [[0, 0.2], [0.5, 0.6], [1, 0.2]],
    veil: [[0, 0.35], [0.5, 0.75], [1, 0.35]],
  },
  // 5 · 深处内环焦散：较窄的 8 字内流，穿行于中空核心之内，赋予生命体内在结构感
  {
    id: 'inner-core', group: 3, k: 140,
    ...S5,
    lines: 16, cross: 4, bias: 1, gain: 0.26, edgeA: 1.7, edgeB: 1.4, fill: 0.14, rimA: 0.45, rimB: 0.35,
    ca: C.white, cb: C.warm, pure: true,
    fade: [[0, 0], [0.14, 1], [0.86, 1], [1, 0]],
    focus: [[0, 1], [1, 1]],
    iri: [[0, 0.15], [0.5, 0.4], [1, 0.15]],
  },
  // 6 · 思考编织丝束：仅思考态浮现的穿织光丝，呈现多股试探与收束的推理质感
  {
    id: 'think-braid', when: 'think', group: -3, k: 140,
    ...S6,
    lines: 14, cross: 5, bias: 1, gain: 0.3, edgeA: 1.6, edgeB: 1.6, fill: 0.12, rimA: 0.4, rimB: 0.4,
    ca: C.cyan, cb: C.white,
    fade: [[0, 0], [0.14, 1], [0.86, 1], [1, 0]],
    focus: [[0, 1], [1, 1]],
    iri: [[0, 0.3], [0.5, 0.1], [1, 0.3]],
  },
];

/** 横向景深边界：展开为声波流光时，两端自然消散进空气薄雾。 */
export const DOF = { left: [350, 535], right: [995, 1180] };

function lightOn(group, x, dv = 0) {
  return [x, Math.round(CY + streamMid(group, x) + dv)];
}

/** 交汇光点：绑定到各流光环上的关键位置，只在折叠处透出极其克制的香槟暖光与冰蓝微光。 */
export const LIGHTS = [
  { at: lightOn(1, 640, -6), group: 1, r: 44, color: C.orange, tint: 0.72, boost: 0.55, glow: 0.48, size: 54 },
  { at: lightOn(-1, 885, 6), group: -1, r: 42, color: C.warm, tint: 0.7, boost: 0.45, glow: 0.42, size: 48 },
  { at: lightOn(3, 765, 0), group: 3, r: 48, color: [1, 0.96, 0.92], tint: 0.65, boost: 0.35, glow: 0.36, size: 56 },
  { at: lightOn(-1, 580, 4), group: -1, r: 52, color: C.cyan, tint: 0.45, boost: 0.2, glow: 0.24, size: 62 },
  { at: lightOn(2, 930, -4), group: 2, r: 50, color: C.blue, tint: 0.45, boost: 0.2, glow: 0.22, size: 60 },
  { at: lightOn(-2, 710, 4), group: -2, r: 46, color: C.warm, tint: 0.6, boost: 0.3, glow: 0.28, size: 50 },
];

export { C as COLORS };
