/* KBOT · 部件：外壳、屏幕、耳朵、天线、底座、阴影和装饰，以及总渲染入口 */
(function () {
  'use strict';
  const RB = window.RB;
  const rad = RB.rad, TAU = Math.PI * 2;

  RB.CX = 90; RB.CY = 93;
  RB.SHELLS = {
    light: { top: '#f7f9fd', bottom: '#c2cbd9', line: 'rgba(60,72,96,0.35)', edge: '#a9b3c3', hl: 0.85, dark: false },
    graphite: { top: '#4d5568', bottom: '#222733', line: 'rgba(0,0,0,0.55)', edge: '#5b6377', hl: 0.2, dark: true },
  };
  // 各机身对头部的缩放：[宽, 高, 超椭圆指数增量]。表情里的头型变化在此基础上叠加
  RB.BODY_SHAPE = {
    classic: [1, 1, 0], pro: [1, 1, 0],
    visor: [1.17, 0.8, -0.5], pebble: [1, 1.24, -1], retro: [1, 0.92, 2.2], bubble: [1.1, 0.78, 0.6],
  };
  // 除了最初的机身，其余都用精工材质（体积阴影、玻璃面罩、细天线）
  const fine = M => M.body !== 'classic';
  const RETRO_ACCENT = '#ff7a3d';

  function rr(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  const shellGrad = (ctx, shell, y0, y1) => {
    const g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, shell.top); g.addColorStop(1, shell.bottom);
    return g;
  };

  function antenna(ctx, M, hh, rgba, k) {
    const a1 = rad(M.ant1), a2 = rad(M.ant2), x0 = M.yaw * 3, y0 = -hh + 5;
    const x1 = x0 + Math.sin(a1) * 10, y1 = y0 - Math.cos(a1) * 10;
    const x2 = x1 + Math.sin(a2) * 9, y2 = y1 - Math.cos(a2) * 9;
    const pro = fine(M);
    ctx.strokeStyle = M.shell.edge; ctx.lineWidth = pro ? 1.8 : 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x1, y1, x2, y2); ctx.stroke();
    ctx.save();
    ctx.shadowColor = rgba(1); ctx.shadowBlur = (pro ? 7 : 11) * k;
    ctx.fillStyle = rgba(Math.min(1, M.antGlow * Math.max(0.55, M.bright)));
    ctx.beginPath(); ctx.arc(x2 + Math.sin(a2) * 3, y2 - Math.cos(a2) * 3, pro ? 2.6 : 4.8, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 复古方屏的提手：跟着天线的弹簧轻轻晃
  function handle(ctx, M, hw, hh) {
    ctx.save();
    ctx.translate(M.yaw * 3, -hh + 2); ctx.rotate(rad(M.ant1 * 0.35));
    ctx.strokeStyle = M.shell.edge; ctx.lineWidth = 3.2; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-hw * 0.42, 0); ctx.lineTo(-hw * 0.32, -11); ctx.lineTo(hw * 0.32, -11); ctx.lineTo(hw * 0.42, 0); ctx.stroke();
    ctx.restore();
  }
  // 复古方屏侧面的橙色旋钮，刻线跟着耳朵的弹簧转
  function knob(ctx, M, hw) {
    ctx.save();
    ctx.translate(hw + 1.5, 6); ctx.rotate(rad(M.earR * 2));
    ctx.fillStyle = RETRO_ACCENT;
    ctx.beginPath(); ctx.arc(0, 0, 6.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.6; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, -1.5); ctx.lineTo(0, -5); ctx.stroke();
    ctx.restore();
  }
  function feet(ctx, M, hw, hh) {
    ctx.save();
    ctx.translate(0, hh - 3); ctx.rotate(rad(M.podA * 0.5));
    ctx.fillStyle = shellGrad(ctx, M.shell, 0, 14);
    for (const s of [-1, 1]) { rr(ctx, s * hw * 0.5 - 6, 0, 12, 13, 4); ctx.fill(); ctx.strokeStyle = M.shell.line; ctx.lineWidth = 1; ctx.stroke(); }
    ctx.restore();
  }
  // 面罩形下方悬浮的光环
  function halo(ctx, M, hh, rgba, k) {
    ctx.save();
    ctx.translate(0, hh + 17); ctx.rotate(rad(M.podA * 0.4));
    ctx.shadowColor = rgba(1); ctx.shadowBlur = 10 * k;
    ctx.strokeStyle = rgba(Math.min(1, 0.35 + M.core * M.bright * 0.6)); ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(0, 0, 26, 5.5, 0, 0, TAU); ctx.stroke();
    ctx.restore();
  }
  // 鹅卵石机身底部的状态灯带
  function strip(ctx, M, hh, rgba, k) {
    ctx.save();
    ctx.shadowColor = rgba(1); ctx.shadowBlur = 8 * k;
    ctx.fillStyle = rgba(Math.min(1, 0.4 + M.core * M.bright));
    rr(ctx, -11, hh * 0.66, 22, 2, 1); ctx.fill();
    ctx.restore();
  }

  function pod(ctx, M, hh, rgba, k) {
    const shell = M.shell;
    ctx.save();
    ctx.translate(0, hh - 12); ctx.rotate(rad(M.podA));
    if (M.body === 'pro') {
      // 扁平圆台，正面一条灯带
      ctx.fillStyle = shellGrad(ctx, shell, 12, 32);
      ctx.beginPath(); ctx.ellipse(0, 22, 21, 10, 0, 0, TAU); ctx.fill();
      ctx.strokeStyle = shell.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.shadowColor = rgba(1); ctx.shadowBlur = 8 * k;
      ctx.fillStyle = rgba(Math.min(1, 0.4 + M.core * M.bright));
      rr(ctx, -8, 24.5, 16, 1.8, 0.9); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.fillStyle = shellGrad(ctx, shell, 6, 38);
    ctx.beginPath(); ctx.ellipse(0, 22, 27, 16, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = shell.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.shadowColor = rgba(1); ctx.shadowBlur = 10 * k;
    ctx.fillStyle = rgba(Math.min(1, M.core * M.bright));
    ctx.beginPath(); ctx.arc(0, 23, 3.6, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 耳朵绕内侧中点转动，正角度是顶端向外
  function ear(ctx, M, s, ang, hw, rgba, k) {
    const shell = M.shell;
    ctx.save();
    if (M.body === 'pro') {
      // 纤薄的侧边模块，中间一道指示灯缝
      ctx.translate(s * (hw - 2), 4);
      ctx.rotate(rad(s * ang * 0.6));
      ctx.scale(1 - 0.25 * M.yaw * s, 1);
      ctx.fillStyle = shellGrad(ctx, shell, -13, 13);
      rr(ctx, s > 0 ? 0 : -6.5, -13, 6.5, 26, 3.25); ctx.fill();
      ctx.strokeStyle = shell.line; ctx.lineWidth = 1; ctx.stroke();
      ctx.shadowColor = rgba(1); ctx.shadowBlur = 6 * k;
      ctx.fillStyle = rgba(0.8 * M.bright);
      rr(ctx, s > 0 ? 2.6 : -3.9, -6, 1.3, 12, 0.65); ctx.fill();
      ctx.restore();
      return;
    }
    ctx.translate(s * (hw - 4), 4);
    ctx.rotate(rad(s * ang));
    ctx.scale(1 - 0.25 * M.yaw * s, 1);
    ctx.fillStyle = shellGrad(ctx, shell, -16, 16);
    rr(ctx, s > 0 ? 0 : -11, -16, 11, 32, 5.5); ctx.fill();
    ctx.strokeStyle = shell.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.shadowColor = rgba(1); ctx.shadowBlur = 8 * k;
    ctx.fillStyle = rgba(0.85 * M.bright);
    rr(ctx, s > 0 ? 4 : -7, -8, 3, 16, 1.5); ctx.fill();
    ctx.restore();
  }

  function screen(ctx, M, hw, hh, rgba) {
    const pro = fine(M), { sw, sh, oy, n: sn } = RB.screenBox(M, hw, hh);
    ctx.save();
    ctx.translate(M.yaw * 2.4, 0.6 + M.pitch * 1.6 + oy);
    RB.superellipse(ctx, sw, sh, sn);
    const gr = ctx.createLinearGradient(0, -sh, 0, sh);
    gr.addColorStop(0, pro ? '#0b0f1c' : '#111830'); gr.addColorStop(1, pro ? '#020308' : '#060914');
    ctx.fillStyle = gr; ctx.fill();
    ctx.save();
    ctx.clip();
    const rg = ctx.createRadialGradient(0, 2, 4, 0, 2, 60);
    rg.addColorStop(0, rgba((pro ? 0.1 : 0.16) * M.bright)); rg.addColorStop(1, rgba(0));
    ctx.fillStyle = rg; ctx.fillRect(-sw, -sh, sw * 2, sh * 2);
    if (M.face === 'matrix') {
      RB.dotGrid(ctx, -sw, -sh, sw, sh);
      ctx.fillStyle = 'rgba(255,255,255,0.045)'; ctx.fill();
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (let y = -sh + 2; y < sh; y += 3) { ctx.moveTo(-sw, y); ctx.lineTo(sw, y); }
      ctx.stroke();
    }
    RB.drawFace(ctx, M);
    if (pro) {
      // 玻璃面罩：一道斜向反光
      const ox = -M.yaw * 6;
      ctx.fillStyle = 'rgba(255,255,255,0.045)';
      ctx.beginPath();
      ctx.moveTo(ox + sw * 0.05, -sh); ctx.lineTo(ox + sw * 0.5, -sh); ctx.lineTo(ox - sw * 0.2, sh); ctx.lineTo(ox - sw * 0.65, sh);
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.ellipse(-16 - M.yaw * 4, -sh + 9, 26, 7, -0.15, 0, TAU); ctx.fill();
    }
    ctx.restore();
    RB.superellipse(ctx, sw, sh, sn);
    ctx.strokeStyle = pro ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();
    if (pro) {
      // 屏幕外沿一圈倒角高光
      RB.superellipse(ctx, sw + 1.3, sh + 1.3, sn);
      const bg = ctx.createLinearGradient(0, -sh, 0, sh);
      bg.addColorStop(0, `rgba(255,255,255,${0.15 + 0.5 * M.shell.hl})`); bg.addColorStop(1, 'rgba(255,255,255,0.05)');
      ctx.strokeStyle = bg; ctx.lineWidth = 1; ctx.stroke();
    }
    ctx.restore();
  }

  // 精工外壳：两侧收暗出体积，顶部一条柔光箱反光，底部一圈轮廓光
  function proShell(ctx, M, hw, hh) {
    const hl = M.shell.hl;
    const sg = ctx.createLinearGradient(-hw, 0, hw, 0);
    sg.addColorStop(0, 'rgba(0,0,0,0.14)'); sg.addColorStop(0.22, 'rgba(0,0,0,0)');
    sg.addColorStop(0.78, 'rgba(0,0,0,0)'); sg.addColorStop(1, 'rgba(0,0,0,0.14)');
    ctx.fillStyle = sg; ctx.fillRect(-hw, -hh, hw * 2, hh * 2);
    const hg = ctx.createLinearGradient(0, -hh + 2, 0, -hh + 9);
    hg.addColorStop(0, `rgba(255,255,255,${0.15 + 0.7 * hl})`); hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    rr(ctx, -hw * 0.6 - M.yaw * 6, -hh + 2.2, hw * 1.2, 7, 3.5); ctx.fill();
    RB.superellipse(ctx, hw, hh, M.n);
    const rg = ctx.createLinearGradient(0, hh * 0.3, 0, hh);
    rg.addColorStop(0, 'rgba(255,255,255,0)'); rg.addColorStop(1, `rgba(255,255,255,${0.2 + 0.35 * hl})`);
    ctx.strokeStyle = rg; ctx.lineWidth = 2.4; ctx.stroke();
  }

  const mixc = (c, to, f) => Math.round(c + (to - c) * f);
  RB.tint = ([r, g, b], to, f, a = 1) => `rgba(${mixc(r, to, f)},${mixc(g, to, f)},${mixc(b, to, f)},${a})`;
  const tint = RB.tint;

  // 机身和尾巴是同一条闭合轮廓：沿超椭圆走到底边时绕出尾巴再接回去，描边和发光边才不会在接缝处多出一道线
  function bubblePath(ctx, M, hw, hh) {
    const n = M.n, steps = 180, w = hw, ang = rad(M.podA * 0.5), ca = Math.cos(ang), sa = Math.sin(ang);
    const tx = -hw * 0.4, ty = hh - 1;
    const T = (x, y) => [tx + x * ca - y * sa, ty + x * sa + y * ca];
    const xr = T(0.205 * w, 0)[0], xl = T(-0.19 * w, 0)[0];
    let tail = false;
    ctx.beginPath();
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
      const r = Math.pow(Math.pow(Math.abs(c / hw), n) + Math.pow(Math.abs(s / hh), n), -1 / n), x = r * c, y = r * s;
      if (s > 0 && x < xr && x > xl) {
        if (!tail) {
          tail = true;
          ctx.lineTo(...T(0.205 * w, 0));
          ctx.quadraticCurveTo(...T(0.06 * w, 0.6), ...T(-0.04 * w, 4.4));
          ctx.lineTo(...T(-0.15 * w, 10.4));
          ctx.quadraticCurveTo(...T(-0.235 * w, 14), ...T(-0.215 * w, 8.6));
          ctx.lineTo(...T(-0.19 * w, 0));
        }
        continue;
      }
      if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
    }
    ctx.closePath();
  }
  // 思考时沿轮廓缓慢流动的彩色光边；outer 画在机身后面做外发光，否则是机身边缘的一道细亮线
  const AURA = ['#ff6fb5', '#a56bff', '#4aa8ff', '#5fe0c8', '#ffb35c', '#ff6fb5'];
  function aura(ctx, M, hw, hh, k, outer) {
    const t = M.t, R = hw + 12, ang = t * 1.4;
    const g = ctx.createLinearGradient(Math.cos(ang) * R, Math.sin(ang) * R, -Math.cos(ang) * R, -Math.sin(ang) * R);
    AURA.forEach((col, i) => g.addColorStop(i / (AURA.length - 1), col));
    ctx.save();
    bubblePath(ctx, M, hw, hh);
    ctx.strokeStyle = g; ctx.lineJoin = 'round';
    if (outer) {
      ctx.globalAlpha = M.aura * (0.6 + 0.25 * Math.sin(t * 2.6));
      ctx.lineWidth = 5; ctx.shadowColor = 'rgba(150,110,255,0.9)'; ctx.shadowBlur = 16 * k;
    } else {
      ctx.globalAlpha = M.aura * 0.9; ctx.lineWidth = 1.6;
    }
    ctx.stroke();
    ctx.restore();
  }

  // 玻璃气泡：主色半透明机身，顶部柔光、底部汇聚的折射光、左上与右下的边缘高光；石墨外壳是深色烟熏玻璃
  function bubbleBody(ctx, M, hw, hh, k) {
    const c = M.rgb, dark = M.shell.dark;
    M.bodyFill = dark ? '#2c3038' : `rgb(${c[0]},${c[1]},${c[2]})`;
    if (M.aura > 0.01) aura(ctx, M, hw, hh, k, true);

    bubblePath(ctx, M, hw, hh);
    const base = ctx.createLinearGradient(0, -hh, 0, hh + 12);
    if (dark) {
      base.addColorStop(0, 'rgba(72,78,92,0.95)'); base.addColorStop(1, 'rgba(22,25,32,0.95)');
    } else {
      base.addColorStop(0, tint(c, 255, 0.24, 0.95)); base.addColorStop(0.55, tint(c, 255, 0, 0.93)); base.addColorStop(1, tint(c, 0, 0.16, 0.95));
    }
    ctx.save();
    ctx.fillStyle = base;
    ctx.shadowColor = dark ? 'rgba(0,0,0,0.42)' : 'rgba(0,20,60,0.24)';
    ctx.shadowBlur = 18 * k; ctx.shadowOffsetY = 8 * k;
    ctx.fill();
    ctx.restore();

    ctx.save();
    bubblePath(ctx, M, hw, hh);
    ctx.clip();
    const rf = ctx.createRadialGradient(0, hh * 1.05, 0, 0, hh * 1.05, hw * 1.15);
    rf.addColorStop(0, tint(c, 255, dark ? 0.2 : 0.6, dark ? 0.3 : 0.6));
    rf.addColorStop(1, tint(c, 255, dark ? 0.2 : 0.6, 0));
    ctx.fillStyle = rf; ctx.fillRect(-hw * 1.5, -hh, hw * 3, hh * 2 + 24);

    ctx.save();
    ctx.translate(-M.yaw * 4, -hh * 0.08);
    RB.superellipse(ctx, hw - 5, hh - 6, M.n, 180);
    const sp = ctx.createLinearGradient(0, -hh, 0, -hh * 0.1);
    sp.addColorStop(0, `rgba(255,255,255,${dark ? 0.16 : 0.36})`); sp.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = sp; ctx.fill();
    ctx.restore();

    bubblePath(ctx, M, hw, hh);
    const rim = ctx.createLinearGradient(-hw, -hh, hw, hh);
    rim.addColorStop(0, `rgba(255,255,255,${dark ? 0.5 : 0.9})`);
    rim.addColorStop(0.35, 'rgba(255,255,255,0.08)');
    rim.addColorStop(0.7, 'rgba(255,255,255,0.05)');
    rim.addColorStop(1, `rgba(255,255,255,${dark ? 0.3 : 0.55})`);
    ctx.strokeStyle = rim; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.stroke();
    ctx.translate(M.yaw * 2.4, M.pitch * 1.6);
    RB.drawFace(ctx, M);
    ctx.restore();

    // 一圈极细的轮廓线，浅色壁纸上也能看清玻璃的边
    bubblePath(ctx, M, hw, hh);
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,30,80,0.12)'; ctx.lineWidth = 0.6; ctx.stroke();
    if (M.aura > 0.01) aura(ctx, M, hw, hh, k, false);
  }

  // 柔和的接触阴影：离地越高越大越淡
  function contactShadow(ctx, M) {
    const lift = RB.clamp((RB.CY - M.cy) / 40, -0.3, 1), R = 46 * (1 + 0.25 * lift), a = 0.2 * (1 - 0.5 * lift);
    ctx.save();
    ctx.translate(90, 154); ctx.scale(1, 0.16);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(0.5, `rgba(0,0,0,${a * 0.45})`); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    ctx.restore();
  }
  function extras(ctx, M, rgba) {
    const st = M.st, t = M.t, x = M.cx, y = M.cy;
    if (st.zzz) {
      ctx.save(); ctx.fillStyle = rgba(0.95);
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.45 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(ph * Math.PI) * 0.9;
        ctx.font = `700 ${8 + ph * 7}px -apple-system, "PingFang SC", sans-serif`;
        ctx.fillText('z', x + 46 + ph * 16, y - 40 - ph * 30);
      }
      ctx.restore();
    }
    if (st.question) {
      const s = (1 - Math.exp(-M.age * 28)) * (1 + 0.35 * Math.exp(-M.age * 7) * Math.cos(M.age * 20));
      ctx.save();
      ctx.translate(x + 58, y - 46 + Math.sin(t * 3) * 2); ctx.scale(s, s);
      ctx.fillStyle = rgba(1); ctx.shadowColor = rgba(1); ctx.shadowBlur = 8 * M.scale;
      ctx.font = '700 18px -apple-system, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('?', 0, 0);
      ctx.restore();
    }
    if (st.hearts) {
      ctx.save();
      ctx.beginPath();
      for (let i = 0; i < 3; i++) {
        const ph = (t * 0.5 + i / 3) % 1;
        RB.heart(ctx, x + 40 + Math.sin(ph * 6 + i * 2) * 6, y - 24 - ph * 36, 2.6 + ph * 2.2);
      }
      ctx.globalAlpha = 0.85 * Math.min(1, M.age * 4);
      ctx.fillStyle = 'rgb(255,125,170)'; ctx.fill();
      ctx.restore();
    }
    if (st.sparkle) {
      ctx.save();
      ctx.beginPath();
      [[-58, -30], [60, -14], [46, -54]].forEach(([dx, dy], i) => {
        const ph = (t * 0.9 + i / 3) % 1;
        RB.star(ctx, x + dx, y + dy, 5 * Math.sin(Math.PI * ph));
      });
      ctx.fillStyle = rgba(0.95); ctx.fill();
      ctx.restore();
    }
  }

  RB.render = (ctx, M) => {
    const [r, g, b] = M.rgb, k = M.scale, rgba = a => `rgba(${r},${g},${b},${a})`;
    if (M.body === 'bubble') {
      contactShadow(ctx, M);
      ctx.save();
      ctx.translate(M.cx, M.cy); ctx.rotate(rad(M.roll)); ctx.scale(M.sx, M.sy);
      bubbleBody(ctx, M, M.hw * (1 - 0.04 * Math.abs(M.yaw)), M.hh * (1 - 0.03 * Math.abs(M.pitch)), k);
      ctx.restore();
      return;
    }
    const up = RB.CY - M.cy, sc = RB.clamp(1 - up / 80, 0.55, 1.2);
    const gy = 182;
    ctx.fillStyle = `rgba(0,0,0,${0.22 * Math.min(1, sc)})`;
    ctx.beginPath(); ctx.ellipse(90, gy, 30 * sc, 5 * sc, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(0.1 * M.bright * Math.min(1, sc));
    ctx.beginPath(); ctx.ellipse(90, gy, 42 * sc, 8 * sc, 0, 0, TAU); ctx.fill();

    ctx.save();
    ctx.translate(M.cx, M.cy); ctx.rotate(rad(M.roll)); ctx.scale(M.sx, M.sy);
    const hw = M.hw * (1 - 0.04 * Math.abs(M.yaw)), hh = M.hh * (1 - 0.03 * Math.abs(M.pitch));
    const body = M.body;
    if (body === 'classic' || body === 'pro') {
      antenna(ctx, M, hh, rgba, k);
      pod(ctx, M, hh, rgba, k);
      ear(ctx, M, -1, M.earL, hw, rgba, k);
      ear(ctx, M, 1, M.earR, hw, rgba, k);
    } else if (body === 'visor') halo(ctx, M, hh, rgba, k);
    else if (body === 'retro') { handle(ctx, M, hw, hh); feet(ctx, M, hw, hh); knob(ctx, M, hw); }

    RB.superellipse(ctx, hw, hh, M.n);
    ctx.fillStyle = shellGrad(ctx, M.shell, -hh, hh); ctx.fill();
    ctx.strokeStyle = M.shell.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.clip();
    if (fine(M)) proShell(ctx, M, hw, hh);
    else {
      const gl = ctx.createLinearGradient(0, -hh, 0, -hh * 0.1);
      gl.addColorStop(0, `rgba(255,255,255,${0.6 * M.shell.hl})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = gl; ctx.fillRect(-hw, -hh, hw * 2, hh);
    }
    if (body === 'pebble') strip(ctx, M, hh, rgba, k);
    ctx.restore();

    screen(ctx, M, hw, hh, rgba);
    ctx.restore();
    extras(ctx, M, rgba);
  };
})();

export {};
