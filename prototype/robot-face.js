/* 赛博伙伴 · 脸：在屏幕里画眼睛、嘴、腮红和高光。坐标原点是屏幕中心 */
(function () {
  'use strict';
  const RB = window.RB;
  const rad = RB.rad;

  const EX = 21.5, EY = -5;   // 眼睛的静止位置
  const GX = 8, GY = 5.5;     // 视线能带动眼睛移动的最大距离

  // 看向一侧时靠外的那只眼睛略微变窄，像头转过去后的透视
  RB.eyeWiden = (M, side) => side < 0
    ? 1 - 0.1 * Math.max(0, -M.gx) + 0.05 * Math.max(0, M.gx)
    : 1 - 0.1 * Math.max(0, M.gx) + 0.05 * Math.max(0, -M.gx);

  // 屏幕在高度 y 处的半宽，和 robot-parts 里屏幕的超椭圆保持一致
  const edgeAt = (M, y) => {
    const sw = M.hw * (1 - 0.04 * Math.abs(M.yaw)) - 8.5, sh = M.hh * (1 - 0.03 * Math.abs(M.pitch)) - 8.5, n = M.n + 0.7;
    return sw * Math.pow(Math.max(0, 1 - Math.pow(Math.min(1, Math.abs(y) / sh), n)), 1 / n);
  };

  // 眼睛的最终位置：静止位置 + 表情偏移 + 视线 + 头部转动的视差。
  // 眼睛放大（惊讶、提醒）时，视线偏到一侧会撞上屏幕边缘，所以外侧要被边缘挡住，不能被切掉
  RB.eyeCenter = (M, e, side) => {
    let x = side * EX + e.ox + M.gx * GX + M.yaw * 7;
    const y = EY + e.oy + M.gy * GY + M.pitch * 5;
    const reach = e.a * (1 + 0.07 * e.close) * RB.eyeWiden(M, side);
    const lim = edgeAt(M, Math.abs(y) + e.b * 0.7) - reach - 2.5;
    if (side * x > lim) x = side * lim;
    return [x, y];
  };

  RB.drawFace = (ctx, M) => {
    const [r, g, b] = M.rgb, k = M.scale, t = M.t, bright = M.bright;
    const rgba = a => `rgba(${r},${g},${b},${a})`;
    const fx = M.yaw * 7, fy = M.pitch * 5;

    if (M.blush > 0.02) {
      ctx.fillStyle = `rgba(255,120,175,${0.42 * M.blush})`;
      ctx.beginPath();
      for (const s of [-1, 1]) ctx.ellipse(s * 31 + fx * 0.8 + M.gx * 4, 10.5 + fy * 0.5 + M.gy * 2, 7.5, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // 两只眼睛和嘴各自加进一条路径，只描一次发光
    const gr = ctx.createLinearGradient(0, EY - 20, 0, EY + 16);
    gr.addColorStop(0, `rgba(${Math.min(255, r + 70)},${Math.min(255, g + 70)},${Math.min(255, b + 70)},1)`);
    gr.addColorStop(1, rgba(1));
    ctx.save();
    ctx.globalAlpha = Math.min(1, bright);
    ctx.fillStyle = gr; ctx.shadowColor = rgba(0.9); ctx.shadowBlur = 13 * k;
    ctx.beginPath();
    for (const [side, e, dir] of [[-1, M.eL, 1], [1, M.eR, -1]]) {
      const [x, y] = RB.eyeCenter(M, e, side);
      ctx.save();
      ctx.translate(x, y); ctx.rotate(rad(e.rot) * dir);
      RB.eyePath(ctx, e, dir, e.close, RB.eyeWiden(M, side));
      ctx.restore();
    }
    ctx.fill();
    ctx.restore();

    // 眼睛里的高光：让眼睛看起来湿润、有神
    for (const [side, e] of [[-1, M.eL], [1, M.eR]]) {
      const hl = e.hl * (1 - e.close);
      if (hl < 0.03) continue;
      const [x, y] = RB.eyeCenter(M, e, side);
      ctx.fillStyle = `rgba(255,255,255,${0.92 * hl})`;
      ctx.beginPath();
      ctx.ellipse(x - e.a * 0.3, y - e.b * 0.42, e.a * 0.27, e.a * 0.27, 0, 0, Math.PI * 2);
      ctx.ellipse(x + e.a * 0.28, y + e.b * 0.38, e.a * 0.13, e.a * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (M.glint > 0) {
      const [x, y] = RB.eyeCenter(M, M.eL, -1), s = 6.5 * Math.sin(Math.PI * M.glint);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      ctx.beginPath(); RB.star(ctx, x - 3, y - 6, s); ctx.fill();
    }

    // 嘴
    const mo = M.mo, mAlpha = mo.mv * (1 - mo.md) * bright;
    if (mAlpha > 0.02) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, mAlpha);
      ctx.translate(fx * 0.55 + M.gx * 3.5, fy * 0.6 + M.gy * 2.5);
      ctx.fillStyle = rgba(1); ctx.shadowColor = rgba(0.9); ctx.shadowBlur = 9 * k;
      ctx.beginPath(); RB.mouthPath(ctx, mo, M.open, t); ctx.fill();
      ctx.restore();
    }
    if (mo.md > 0.02) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, mo.md * bright);
      ctx.translate(fx * 0.55 + M.gx * 3.5, fy * 0.6 + M.gy * 2.5);
      ctx.fillStyle = rgba(1); ctx.shadowColor = rgba(0.9); ctx.shadowBlur = 8 * k;
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const yy = mo.my + Math.sin(t * 7 - i * 0.9) * 2.4;
        ctx.moveTo(-7 + i * 7 + 2.1, yy); ctx.arc(-7 + i * 7, yy, 2.1, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.restore();
    }

    const st = M.st;
    if (st.moon) {
      ctx.fillStyle = rgba(0.85);
      ctx.beginPath(); ctx.arc(33, -26, 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#0d1328';
      ctx.beginPath(); ctx.arc(35.6, -28, 4.4, 0, Math.PI * 2); ctx.fill();
    }
    if (st.tear) {
      const ph = (M.age * 0.45) % 1;
      if (ph < 0.8) {
        const [x, y] = RB.eyeCenter(M, M.eL, -1), u = ph / 0.8;
        ctx.fillStyle = `rgba(170,225,255,${0.85 * Math.sin(Math.PI * Math.min(1, u * 1.15))})`;
        ctx.beginPath(); RB.drop(ctx, x - 2, y + 15 + u * 13, 2.1); ctx.fill();
      }
    }
  };
})();
