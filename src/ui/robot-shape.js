/* KBOT · 几何：头部超椭圆、眼睛与嘴的连续形变路径 */
(function () {
  'use strict';
  const RB = window.RB;

  // 超椭圆：n=2 是正圆，n 越大越接近圆角方块。头部形状靠这一个参数连续变形
  RB.superellipse = (ctx, a, b, n, steps = 96) => {
    const e = 2 / n;
    ctx.beginPath();
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const x = a * Math.sign(c) * Math.pow(Math.abs(c), e), y = b * Math.sign(s) * Math.pow(Math.abs(s), e);
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  };

  const COLS = 20;
  const XS = [];
  for (let i = 0; i <= COLS * 2; i++) XS.push(Math.sin(-Math.PI / 2 + (Math.PI * i) / (COLS * 2)));

  // 眼睛路径：圆角矩形被上下眼睑曲线裁切，按列采样成多边形，所以任何表情之间都能连续过渡。
  // dir=+1 为左眼（内侧在 +x），dir=-1 为右眼。close 为闭合度，闭到极限是一条发光细线。
  // 路径坐标在调用时就按当前变换固定下来，所以两只眼可以先后加到同一条路径里，只描一次发光。
  RB.eyePath = (ctx, e, dir, close, widen) => {
    const a = e.a * (1 + 0.07 * close) * widen, b = e.b, r = Math.min(e.r, a, b);
    const top = [], bot = [];
    for (let i = 0; i < XS.length; i++) {
      const u = XS[i], au = Math.abs(u);
      const dx = au * a - (a - r);
      const hb = dx > 0 ? b - r + Math.sqrt(Math.max(0, r * r - dx * dx)) : b;
      let t = Math.max(e.t0 + e.tS * u + e.tQ * u * u + e.tA * au, -hb);
      let d = Math.min(e.b0 + e.bS * u + e.bQ * u * u + e.bA * au, hb);
      const mid = (t + d) / 2;
      t += (mid - t) * close; d += (mid - d) * close;
      const tm = 2.6 * Math.sqrt(Math.max(0, 1 - Math.pow(au, 6)));
      if (d - t < tm) { t = mid - tm / 2; d = mid + tm / 2; }
      const x = u * a * dir;
      top.push(x, t); bot.push(x, d);
    }
    ctx.moveTo(top[0], top[1]);
    for (let i = 2; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
    for (let i = bot.length - 2; i >= 0; i -= 2) ctx.lineTo(bot[i], bot[i + 1]);
    ctx.closePath();
  };

  // 嘴路径：一条中心曲线加上两头收尖的上下厚度。弯曲、猫嘴、波浪、张开都是同一套参数
  RB.mouthPath = (ctx, m, open, t) => {
    const a = m.ma * (1 + 0.16 * open), mt = m.mt + open * 1, mb = m.mb + open * 8.5;
    const n = 28;
    const top = [], bot = [];
    for (let i = 0; i <= n; i++) {
      const u = -1 + (2 * i) / n, au = Math.abs(u);
      const bowl = 1 - u * u, cat = 1 - Math.pow(2 * au - 1, 2);
      const yc = m.my + m.mk * (bowl + (cat - bowl) * m.mc) + m.ms * u + m.mw * Math.sin(u * 4.6 + t * 6);
      const prof = Math.pow(Math.max(0, 1 - Math.pow(au, 3)), 1 / 3);
      const x = m.mx + u * a;
      top.push(x, yc - Math.max(0.5, mt) * prof); bot.push(x, yc + Math.max(0.5, mb) * prof);
    }
    ctx.moveTo(top[0], top[1]);
    for (let i = 2; i < top.length; i += 2) ctx.lineTo(top[i], top[i + 1]);
    for (let i = bot.length - 2; i >= 0; i -= 2) ctx.lineTo(bot[i], bot[i + 1]);
    ctx.closePath();
  };

  // 小图形：心形、四角星、水滴
  RB.heart = (ctx, x, y, s) => {
    ctx.moveTo(x, y + s * 0.9);
    ctx.bezierCurveTo(x - s * 1.5, y - s * 0.1, x - s * 0.7, y - s * 1.1, x, y - s * 0.4);
    ctx.bezierCurveTo(x + s * 0.7, y - s * 1.1, x + s * 1.5, y - s * 0.1, x, y + s * 0.9);
  };
  RB.star = (ctx, x, y, s) => {
    ctx.moveTo(x, y - s);
    ctx.quadraticCurveTo(x, y, x + s, y); ctx.quadraticCurveTo(x, y, x, y + s);
    ctx.quadraticCurveTo(x, y, x - s, y); ctx.quadraticCurveTo(x, y, x, y - s);
  };
  RB.drop = (ctx, x, y, s) => {
    ctx.moveTo(x, y - s * 1.5);
    ctx.bezierCurveTo(x + s * 0.2, y - s * 0.6, x + s, y - s * 0.2, x + s, y + s * 0.5);
    ctx.arc(x, y + s * 0.5, s, 0, Math.PI);
    ctx.bezierCurveTo(x - s, y - s * 0.2, x - s * 0.2, y - s * 0.6, x, y - s * 1.5);
  };
})();

export {};
