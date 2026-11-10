/* 赛博伙伴 · 部件：外壳、屏幕、耳朵、天线、底座、阴影和装饰，以及总渲染入口 */
(function () {
  'use strict';
  const RB = window.RB;
  const rad = RB.rad, TAU = Math.PI * 2;

  RB.CX = 90; RB.CY = 93;
  RB.SHELLS = {
    light: { top: '#f7f9fd', bottom: '#c2cbd9', line: 'rgba(60,72,96,0.35)', edge: '#a9b3c3', hl: 0.85 },
    graphite: { top: '#4d5568', bottom: '#222733', line: 'rgba(0,0,0,0.55)', edge: '#5b6377', hl: 0.2 },
  };

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
    ctx.strokeStyle = M.shell.edge; ctx.lineWidth = 3; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.quadraticCurveTo(x1, y1, x2, y2); ctx.stroke();
    ctx.save();
    ctx.shadowColor = rgba(1); ctx.shadowBlur = 11 * k;
    ctx.fillStyle = rgba(Math.min(1, M.antGlow * Math.max(0.55, M.bright)));
    ctx.beginPath(); ctx.arc(x2 + Math.sin(a2) * 3, y2 - Math.cos(a2) * 3, 4.8, 0, TAU); ctx.fill();
    ctx.restore();
  }

  function pod(ctx, M, hh, rgba, k) {
    const shell = M.shell;
    ctx.save();
    ctx.translate(0, hh - 12); ctx.rotate(rad(M.podA));
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

  function screen(ctx, M, hw, hh, n, rgba) {
    const sw = hw - 8.5, sh = hh - 8.5, sn = n + 0.7;
    ctx.save();
    ctx.translate(M.yaw * 2.4, 0.6 + M.pitch * 1.6);
    RB.superellipse(ctx, sw, sh, sn);
    const gr = ctx.createLinearGradient(0, -sh, 0, sh);
    gr.addColorStop(0, '#111830'); gr.addColorStop(1, '#060914');
    ctx.fillStyle = gr; ctx.fill();
    ctx.save();
    ctx.clip();
    const rg = ctx.createRadialGradient(0, 2, 4, 0, 2, 60);
    rg.addColorStop(0, rgba(0.16 * M.bright)); rg.addColorStop(1, rgba(0));
    ctx.fillStyle = rg; ctx.fillRect(-sw, -sh, sw * 2, sh * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'; ctx.lineWidth = 0.9;
    ctx.beginPath();
    for (let y = -sh + 2; y < sh; y += 3) { ctx.moveTo(-sw, y); ctx.lineTo(sw, y); }
    ctx.stroke();
    RB.drawFace(ctx, M);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath(); ctx.ellipse(-16 - M.yaw * 4, -sh + 9, 26, 7, -0.15, 0, TAU); ctx.fill();
    ctx.restore();
    RB.superellipse(ctx, sw, sh, sn);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.2; ctx.stroke();
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
    const up = RB.CY - M.cy, sc = RB.clamp(1 - up / 80, 0.55, 1.2);
    ctx.fillStyle = `rgba(0,0,0,${0.22 * Math.min(1, sc)})`;
    ctx.beginPath(); ctx.ellipse(90, 182, 30 * sc, 5 * sc, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = rgba(0.1 * M.bright * Math.min(1, sc));
    ctx.beginPath(); ctx.ellipse(90, 182, 42 * sc, 8 * sc, 0, 0, TAU); ctx.fill();

    ctx.save();
    ctx.translate(M.cx, M.cy); ctx.rotate(rad(M.roll)); ctx.scale(M.sx, M.sy);
    const hw = M.hw * (1 - 0.04 * Math.abs(M.yaw)), hh = M.hh * (1 - 0.03 * Math.abs(M.pitch));
    antenna(ctx, M, hh, rgba, k);
    pod(ctx, M, hh, rgba, k);
    ear(ctx, M, -1, M.earL, hw, rgba, k);
    ear(ctx, M, 1, M.earR, hw, rgba, k);

    RB.superellipse(ctx, hw, hh, M.n);
    ctx.fillStyle = shellGrad(ctx, M.shell, -hh, hh); ctx.fill();
    ctx.strokeStyle = M.shell.line; ctx.lineWidth = 1; ctx.stroke();
    ctx.save();
    ctx.clip();
    const gl = ctx.createLinearGradient(0, -hh, 0, -hh * 0.1);
    gl.addColorStop(0, `rgba(255,255,255,${0.6 * M.shell.hl})`); gl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gl; ctx.fillRect(-hw, -hh, hw * 2, hh);
    ctx.restore();

    screen(ctx, M, hw, hh, M.n, rgba);
    ctx.restore();
    extras(ctx, M, rgba);
  };
})();
