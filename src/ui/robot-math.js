/* KBOT · 角色动画基础：缓动、弹簧、噪声、随机 */
(function () {
  'use strict';
  const RB = window.RB = {};

  RB.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  RB.lerp = (a, b, t) => a + (b - a) * t;
  RB.rad = d => (d * Math.PI) / 180;

  // 指数缓动：起步快、收尾软、不过冲。状态之间的形变用它，切换才利落
  RB.follow = (x, target, rate, dt) => x + (target - x) * (1 - Math.exp(-rate * dt));

  // 弹簧：会过冲、带余震。挤压拉伸、耳朵、天线这些“软”的部分用它
  class Spring {
    constructor(k = 240, damp = 0.5, x = 0) { this.k = k; this.z = damp; this.x = x; this.v = 0; this.t = x; }
    step(dt) {
      const n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n, c = 2 * this.z * Math.sqrt(this.k);
      for (let i = 0; i < n; i++) {
        this.v += (this.k * (this.t - this.x) - c * this.v) * h;
        this.x += this.v * h;
      }
      return this.x;
    }
    kick(v) { this.v += v; }
    snap(x) { this.x = this.t = x; this.v = 0; }
  }
  RB.Spring = Spring;

  // 几个不同频率的正弦叠加，返回约 -1~1 的不重复起伏，用于视线漂移和呼吸
  RB.noise = (t, seed = 0) => 0.5 * Math.sin(t * 1.31 + seed) + 0.3 * Math.sin(t * 2.17 + seed * 1.7 + 1.7) + 0.2 * Math.sin(t * 3.93 + seed * 2.3 + 4.1);

  // 颜色在 HSL 里过渡，青色变粉红时不会经过一片发灰的中间色
  RB.rgb2hsl = ([r, g, b]) => {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (d > 1e-6) {
      s = d / (1 - Math.abs(2 * l - 1));
      h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    }
    return [h * 60, s, l];
  };
  RB.hsl2rgb = ([h, s, l], out) => {
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255; };
    out[0] = Math.round(f(0)); out[1] = Math.round(f(8)); out[2] = Math.round(f(4));
    return out;
  };

  // 带种子的随机数，实验页里可以复现同一段动画
  RB.rng = seed => {
    let s = (seed >>> 0) || 1;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  };

  // 关键帧曲线：frames 是 [[秒, 值], …]，相邻关键帧之间平滑过渡，首尾之外保持端点值
  RB.kf = frames => t => {
    const n = frames.length;
    if (t <= frames[0][0]) return frames[0][1];
    for (let i = 1; i < n; i++) {
      const t1 = frames[i][0];
      if (t <= t1) {
        const t0 = frames[i - 1][0], v0 = frames[i - 1][1], u = (t - t0) / (t1 - t0);
        return v0 + (frames[i][1] - v0) * u * u * (3 - 2 * u);
      }
    }
    return frames[n - 1][1];
  };

  // 0→1 的缓动曲线
  RB.easeOut = u => 1 - (1 - u) * (1 - u) * (1 - u);
  RB.easeInOut = u => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
  // 0→1→0 的钟形包络，动作的起止都平滑归零
  RB.bell = u => Math.sin(Math.PI * RB.clamp(u, 0, 1));
})();

export {};
