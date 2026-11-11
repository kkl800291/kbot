/* KBOT · 角色：把表情参数、弹簧、生命感和绘制串起来，对外接口保持不变。
   依赖 robot-math / states / shape / face / parts / clips / life（见 index.html 的加载顺序） */
(function () {
  'use strict';
  const RB = window.RB, { clamp, Spring } = RB;
  const W = 180, H = 192;   // 画布的逻辑尺寸，角色在其中按 180×192 绘制

  // 与 macOS 系统强调色一致；界面强调色也取自这里
  const PALETTES = {
    blue: [10, 132, 255],
    indigo: [94, 92, 230],
    orange: [255, 149, 0],
    green: [48, 199, 89],
  };
  const MOOD = {
    remind: [255, 149, 0],
    think: [120, 104, 245],
    annoyed: [255, 69, 110],
    sleep: [88, 104, 168],
    dnd: [104, 112, 176],
  };
  // 气泡机身的眼睛是窄长的药丸形：横向收窄，纵向参数（含眼睑曲线）略压扁
  const BUBBLE_EYE = [0.6, 0.8];
  const EYE_V = ['b', 'oy', 't0', 'tS', 'tQ', 'tA', 'b0', 'bS', 'bQ', 'bA'];
  const STATES = RB.STATES;

  // 各组参数向目标缓动的速度（越大越快）：眼睛最利落，头型和整体亮度更从容
  const RATE = { head: 9, eL: 15, eR: 15, mo: 13, m: 8 };
  // 弹簧速度低于这个值就算静止，用来决定待机时能不能降帧
  const REST = { sq: 0.05, ox: 3, oy: 3, roll: 2, yaw: 0.03, pitch: 0.03, earL: 6, earR: 6, ant1: 8, ant2: 8, pod: 4 };

  const clonePose = p => { const o = {}; for (const g in p) o[g] = Object.assign({}, p[g]); return o; };
  function followPose(cur, tgt, dt, speed) {
    for (const g in tgt) {
      const c = cur[g], t = tgt[g], f = 1 - Math.exp(-(RATE[g] || 8) * speed * dt);
      for (const k in t) c[k] += (t[k] - c[k]) * f;
    }
  }

  class Robot {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.palette = 'blue'; this.shell = 'light'; this.reduced = false;
      this.face = 'smooth'; this.body = 'bubble'; this.mouth = false;
      this.base = 'idle'; this.temp = null; this.tempUntil = 0;
      this.held = false; this.hover = false; this.paused = false; this.pressed = false;
      this.manual = !!opts.manual;
      this.clock = 0; this.age = 0; this.settle = 1; this.aura = 0;
      this.p = clonePose(STATES.idle.pose);
      this.color = PALETTES.blue.slice();
      this.hsl = RB.rgb2hsl(PALETTES.blue); this._ck = ''; this._th = this.hsl;
      this.life = new RB.Life(opts.seed);
      const S = (k, z) => new Spring(k, z);
      this.sp = {
        sq: S(380, 0.42), ox: S(260, 0.6), oy: S(300, 0.55), roll: S(220, 0.5), yaw: S(160, 0.7), pitch: S(160, 0.7),
        earL: S(520, 0.35), earR: S(520, 0.35), ant1: S(300, 0.3), ant2: S(220, 0.22), pod: S(140, 0.3),
      };
      this.mouse = null; this.mouseAt = 0; this.look = [0, 0]; this.lastLook = null; this.near = 0; this._c = null; this._cAt = -1e9;
      this.dragVx = 0; this.dragVy = 0; this.dragAt = 0;
      this.M = { rgb: [0, 0, 0], eL: {}, eR: {}, mo: {} };
      this._name = null;
      this.last = performance.now(); this.lastDraw = 0; this.busy = true;
      this.setSize(120);
      this.loop = this.loop.bind(this);
      if (!this.manual) requestAnimationFrame(this.loop);
    }

    now() { return this.manual ? this.clock * 1000 : performance.now(); }

    get state() {
      if (this.held) return 'lifted';
      if (this.temp && this.now() < this.tempUntil) return this.temp;
      if (this.hover && this.base === 'idle') return 'hover';
      return this.base;
    }
    setBase(s) { if (STATES[s]) this.base = s; }
    flash(s, ms = 2500) { if (!STATES[s]) return; this.temp = s; this.tempUntil = this.now() + ms; }
    clearFlash() { this.temp = null; }
    setHeld(v) { this.held = !!v; }
    talkPulse() { this.life.speak(); }
    lookAtPoint(x, y) { this.mouse = [x, y]; this.mouseAt = this.now(); }

    // 按下时身体被压扁，松手时弹回来；拖动时用位移速度带出头、天线、底座的惯性
    press() { this.pressed = true; }
    release(poke = true) {
      if (!this.pressed) return;
      this.pressed = false;
      if (poke) this.life.trigger('poke');
    }
    drag(dx, dy) {
      const now = performance.now(), dt = Math.max(0.008, (now - this.dragAt) / 1000);
      this.dragAt = now;
      this.dragVx += (clamp(dx / dt, -3000, 3000) - this.dragVx) * 0.45;
      this.dragVy += (clamp(dy / dt, -3000, 3000) - this.dragVy) * 0.45;
    }
    drop() { this.life.trigger('land'); }

    setSize(px) {
      this.size = px;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cssW = px * 1.5, cssH = px * 1.6;
      this.canvas.style.width = cssW + 'px';
      this.canvas.style.height = cssH + 'px';
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.scale = (cssW * dpr) / W;
    }

    get shape() { return Robot.SHAPES[this.body] || Robot.SHAPES.classic; }
    get box() { return this.shape.box; }

    hitTest(x, y) {
      const r = this.canvas.getBoundingClientRect();
      if (!r.width) return false;
      const ux = ((x - r.left) / r.width) * W, uy = ((y - r.top) / r.height) * H, B = this.box;
      return ux >= B.l && ux <= B.r && uy >= B.t && uy <= B.b;
    }

    center(now = this.now()) {
      if (!this._c || now - this._cAt > 150) {
        const r = this.canvas.getBoundingClientRect();
        this._c = [r.left + r.width / 2, r.top + r.height * this.box.cy / H]; this._cAt = now;
      }
      return this._c;
    }

    // 鼠标最近 4 秒动过，就朝它看；离得越近眼睛越大
    mouseLook(now) {
      this.near = 0;
      if (!this.mouse || now - this.mouseAt > 4000) return null;
      const c = this.center(now), dx = this.mouse[0] - c[0], dy = this.mouse[1] - c[1];
      const d = Math.hypot(dx, dy) || 1, f = Math.min(1, d / 260);
      this.look[0] = (dx / d) * f; this.look[1] = (dy / d) * f;
      this.near = clamp(1 - d / 240, 0, 1);
      if (!this.lastLook) this.lastLook = [0, 0];
      this.lastLook[0] = this.look[0]; this.lastLook[1] = this.look[1];
      return this.look;
    }

    enter(name, st) {
      const first = this._name === null;
      this.life.onState(this._name, st, first);
      this._name = name; this.age = 0; this.settle = 0.9;
      if (first) this.p = clonePose(this.poseOf(st));
    }

    poseOf(st) { return this.body === 'bubble' && st.gpose ? st.gpose : st.pose; }

    fillEye(dst, src, close, es) {
      for (const k in src) dst[k] = src[k];
      if (this.body === 'bubble') {
        dst.a *= BUBBLE_EYE[0]; dst.ox *= BUBBLE_EYE[0];
        for (const k of EYE_V) dst[k] *= BUBBLE_EYE[1];
      }
      dst.a *= es; dst.b *= es; dst.r *= es; dst.close = close;
    }

    step(dt) {
      const name = this.state, st = STATES[name] || STATES.idle, p = this.p, sp = this.sp, M = this.M;
      if (name !== this._name) this.enter(name, st);
      this.clock += dt; this.age += dt;
      const t = this.clock, mot = this.reduced ? 0.3 : 1;

      followPose(p, this.poseOf(st), dt, st.speed || 1);
      this.aura += ((st.aura && this.body === 'bubble' ? 1 : 0) - this.aura) * (1 - Math.exp(-dt * 5));
      const ck = st.color || this.palette;
      if (ck !== this._ck) { this._ck = ck; this._th = RB.rgb2hsl(st.color ? MOOD[st.color] : (PALETTES[this.palette] || PALETTES.blue)); }
      const h = this.hsl, th = this._th, kc = 1 - Math.exp(-dt * 6);
      let dh = th[0] - h[0]; dh -= 360 * Math.round(dh / 360);
      h[0] = (h[0] + dh * kc + 360) % 360; h[1] += (th[1] - h[1]) * kc; h[2] += (th[2] - h[2]) * kc;
      RB.hsl2rgb(h, this.color);

      const look = this.mouseLook(this.now());
      const L = this.life.update(dt, { st, look, lastLook: this.lastLook, near: this.near, held: this.held || !!st.held, reduced: this.reduced });

      const dd = Math.exp(-9 * dt);
      this.dragVx *= dd; this.dragVy *= dd;
      const dvx = this.dragVx, dvy = this.dragVy;

      sp.sq.t = p.m.sq0 + L.sq + (this.pressed ? 0.13 : 0);
      sp.ox.t = L.ox - dvx * 0.006 * mot + L.ex * 2.5 * mot;
      sp.oy.t = L.oy - dvy * 0.005 * mot + L.ey * 1.5 * mot;
      sp.roll.t = p.m.tilt + L.roll - dvx * 0.005 * mot;
      sp.yaw.t = L.yaw; sp.pitch.t = L.pitch;
      sp.earL.t = p.m.ears + L.ears + L.earL; sp.earR.t = p.m.ears + L.ears + L.earR;
      // 天线和底座像挂着的东西：头往哪边快速移动或转动，它们就向反方向甩，再带着余震回正
      const vx = dvx + sp.ox.v, sway = RB.noise(t * 0.8, 7) * 1.6 * mot;
      sp.ant1.t = p.m.ant + L.ant + sway - vx * 0.02 - sp.roll.v * 0.04;
      sp.ant2.t = sp.ant1.x + sway * 0.6 - vx * 0.015;
      sp.pod.t = L.pod - vx * 0.012;
      let busy = L.busy || this.pressed || this.held || this.settle > 0 || this.aura > 0.01;
      for (const k in sp) {
        sp[k].step(dt);
        if (Math.abs(sp[k].v) > REST[k]) busy = true;
      }
      this.settle = Math.max(0, this.settle - dt);
      this.busy = busy;

      const fl = p.m.fl * mot, bob = Math.sin(t * p.m.fs) * fl + RB.noise(t * 0.7, 2) * fl * 0.35;
      const breath = Math.sin(t * 1.55) * 0.012 * mot, q = clamp(sp.sq.x, -0.32, 0.32);
      M.t = t; M.age = this.age; M.scale = this.scale; M.st = st;
      M.rgb[0] = Math.round(this.color[0]); M.rgb[1] = Math.round(this.color[1]); M.rgb[2] = Math.round(this.color[2]);
      M.shell = RB.SHELLS[this.shell] || RB.SHELLS.light;
      M.face = this.face; M.body = this.body; M.mouth = this.mouth;
      M.bright = p.m.bright;
      M.cx = RB.CX + sp.ox.x; M.cy = RB.CY + sp.oy.x + bob;
      M.roll = clamp(sp.roll.x, -32, 32); M.sx = 1 + q - breath; M.sy = 1 - q * 0.9 + breath * 1.4;
      M.yaw = clamp(sp.yaw.x, -1, 1); M.pitch = clamp(sp.pitch.x, -1, 1);
      const bs = RB.BODY_SHAPE[this.body] || RB.BODY_SHAPE.classic;
      M.hw = p.head.hw * bs[0]; M.hh = p.head.hh * bs[1]; M.n = Math.max(2.4, p.head.n + bs[2]);
      M.gx = L.ex; M.gy = L.ey;
      const squint = this.pressed ? 0.4 : 0, es = 1 + L.es;
      this.fillEye(M.eL, p.eL, Math.max(L.closeL, squint), es);
      this.fillEye(M.eR, p.eR, Math.max(L.closeR, squint), es);
      for (const k in p.mo) M.mo[k] = p.mo[k];
      M.mo.mk += L.smile;
      M.open = L.open;
      M.blush = clamp(p.m.blush + L.blush, 0, 1.2);
      // 多个动作叠加时弹簧会冲得很远，限一下幅度，免得耳朵翻过头顶、天线折断
      M.earL = clamp(sp.earL.x, -45, 60); M.earR = clamp(sp.earR.x, -45, 60);
      M.ant1 = clamp(sp.ant1.x, -45, 45); M.ant2 = clamp(sp.ant2.x, -55, 55); M.podA = clamp(sp.pod.x, -40, 40);
      M.core = clamp(p.m.core + L.speech * 0.4, 0, 1);
      M.antGlow = st.pulse ? 0.6 + 0.4 * Math.sin(t * st.pulse) : 0.85 + 0.15 * Math.sin(t * 2);
      M.glint = L.glint;
      M.aura = this.aura;
    }

    render() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.scale, 0, 0, this.scale, 0, 0);
      RB.render(ctx, this.M);
    }

    // 手动推进模拟（实验页用：不依赖 requestAnimationFrame，结果可复现）
    advance(sec, h = 1 / 60) {
      for (let t = 0; t < sec - 1e-9; t += h) this.step(Math.min(h, sec - t));
      this.render();
    }

    loop(now) {
      requestAnimationFrame(this.loop);
      if (this.paused) { this.last = now; return; }
      if (!this.busy && now - this.lastDraw < 31) return;
      const dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now; this.lastDraw = now;
      this.step(dt);
      this.render();
    }
  }

  // 每种机身在逻辑画布里的范围，cy 是头部中心（各机身相同，换外观时位置不变）。
  // box：含天线、底座或光环，不含地面阴影，点击命中、气泡与面板定位、拖动边界都以它为准。
  // regions：桌面版窗口的可点击区域，[x, y, 宽, 高, 圆角]，贴着机身轮廓，四角留给下层窗口
  Robot.SHAPES = {
    classic: {
      box: { l: 26, r: 154, t: 14, b: 167, cy: RB.CY },
      regions: [[33, 43, 114, 98, 32], [24, 74, 132, 35, 12], [70, 138, 40, 28, 14], [84, 24, 12, 22, 6]],
    },
    // 气泡形：与应用图标同一轮廓，左下角一条小尾巴
    bubble: {
      box: { l: 26, r: 154, t: 50, b: 148, cy: RB.CY },
      regions: [[28, 53, 124, 82, 30], [46, 126, 34, 22, 8]],
    },
    // 面罩形：宽扁的头，没有天线和耳朵，下方悬浮一圈光环
    visor: {
      box: { l: 24, r: 156, t: 48, b: 158, cy: RB.CY },
      regions: [[26, 52, 128, 82, 28], [62, 139, 56, 17, 8]],
    },
  };
  Robot.W = W; Robot.H = H;
  Robot.STATES = STATES;
  Robot.PALETTES = PALETTES;
  window.Robot = Robot;
})();

export {};
