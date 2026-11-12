/* KBOT · 光之球：WebGL 画的磨砂玻璃球，里面是缓慢流动的光。眼睛先画在一张 2D 贴图上，再按球面贴到正面。
   只管绘制：位置、挤压、视线、眨眼仍由 Robot 和 Life 算好放进 M */
import ORB_URL from './orb.jpg';

(function () {
  'use strict';
  const RB = window.RB, { clamp } = RB, TAU = Math.PI * 2;
  const R = 50, GROUND = 1.3;   // 球半径（逻辑单位）；地面在球心下方 1.3 个半径处，球悬在半空
  const TEX_R = 0.9615;         // 贴图里球体半径占半边长的比例
  const SQUASH = 0.7;           // 球比气泡“硬”，Robot 的挤压拉伸只取七成

  // 球体贴图只加载一次，所有角色共用；加载失败时 Robot 退回 2D 气泡
  const img = new Image();
  RB.orbReady = new Promise(res => { img.onload = () => res(true); img.onerror = () => res(false); });
  img.src = ORB_URL;

  // 每个状态的脸和光。eyes 左右两只眼：k 眼型（cap 胶囊、arc 笑眼、shut 闭眼、ring 圆眼），w/h 宽高，
  // top/tS 上眼睑压低的比例与斜度（左眼正值外侧低），dy 上下偏移；mouth：eq 说话的声波、dots 思考的省略号；
  // pal 内部光的色调，flow 流速，swirl 打旋，bright 亮度，pulse/voice/breathe 亮度起伏，blush 腮红，moon 勿扰月牙
  const E = (o = {}) => ({ k: 'cap', w: 15, h: 31, top: 0, tS: 0, dy: 0, ...o });
  const FACES = {
    idle: { eyes: [E(), E()] },
    hover: { eyes: [E({ w: 16, h: 35 }), E({ w: 16, h: 35 })], bright: 1.12 },
    talk: { eyes: [E({ h: 30 }), E({ h: 30 })], mouth: 'eq', flow: 1.6, voice: 1 },
    think: { eyes: [E({ w: 13, h: 24, top: 0.12 }), E({ w: 13, h: 24, top: 0.12 })], mouth: 'dots', flow: 3.2, swirl: 1 },
    remind: { eyes: [E({ h: 36 }), E({ h: 36 })], pal: 'amber', pulse: 2, bright: 1.15 },
    happy: { eyes: [E({ k: 'arc', w: 17 }), E({ k: 'arc', w: 17 })], pal: 'warm', flow: 1.4, bright: 1.1 },
    surprised: { eyes: [E({ k: 'ring', w: 26 }), E({ k: 'ring', w: 26 })], bright: 1.25 },
    coy: { eyes: [E({ k: 'arc', w: 16, h: 28 }), E({ k: 'arc', w: 16, h: 28 })], pal: 'rose', blush: 1 },
    wink: { eyes: [E(), E({ k: 'arc', w: 17 })], pal: 'warm' },
    confused: { eyes: [E(), E({ w: 13, h: 20, dy: -5 })], flow: 0.9, swirl: 0.35 },
    sad: { eyes: [E({ top: 0.3, tS: -0.5, h: 29 }), E({ top: 0.3, tS: 0.5, h: 29 })], pal: 'cool', bright: 0.8, flow: 0.6 },
    annoyed: { eyes: [E({ top: 0.34, tS: 0.55, h: 30 }), E({ top: 0.34, tS: -0.55, h: 30 })], pal: 'ember', flow: 2.2 },
    sleepy: { eyes: [E({ top: 0.48, h: 28 }), E({ top: 0.48, h: 28 })], pal: 'dusk', bright: 0.85, flow: 0.45 },
    sleep: { eyes: [E({ k: 'shut', w: 17 }), E({ k: 'shut', w: 17 })], pal: 'night', bright: 0.8, flow: 0.25, breathe: 1 },
    lifted: { eyes: [E({ h: 24 }), E({ h: 24 })], flow: 2, swirl: 0.6, bright: 1.05 },
    dnd: { eyes: [E({ top: 0.4, h: 28 }), E({ top: 0.4, h: 28 })], pal: 'night', bright: 0.7, flow: 0.4, moon: true },
  };
  // 色调：[目标色, 强度]，按亮度把内部的光染向目标色；球边的高光和磨砂边不染
  const TINT = {
    none: [[1, 1, 1], 0],
    warm: [[1.0, 0.66, 0.8], 0.3], cool: [[0.42, 0.6, 1.0], 0.45], dusk: [[0.56, 0.6, 0.98], 0.22], night: [[0.5, 0.56, 0.98], 0.4],
    ember: [[1.0, 0.42, 0.32], 0.62], rose: [[1.0, 0.5, 0.78], 0.55], amber: [[1.0, 0.72, 0.28], 0.62],
  };
  // 强调色对应的光：[色相旋转（YIQ 弧度，正值是蓝→青→绿的方向）, 染色目标, 染色强度]；带情绪色调的状态不受影响
  const PAL = { blue: [0], indigo: [-0.4], orange: [-1.2, [1.0, 0.62, 0.36], 0.45], green: [0.7, [0.5, 1.0, 0.75], 0.3] };
  const AURORA = [[0.30, 0.66, 1.00], [0.62, 0.44, 1.00]];   // 外发光的两种颜色
  const WHITE = [255, 255, 255];

  function capsule(ctx, x, y, w, h) {
    const r = Math.min(w, h) / 2, dx = w / 2 - r, dy = h / 2 - r;
    ctx.beginPath();
    if (h >= w) { ctx.arc(x, y - dy, r, Math.PI, 0); ctx.arc(x, y + dy, r, 0, Math.PI); }
    else { ctx.arc(x + dx, y, r, -Math.PI / 2, Math.PI / 2); ctx.arc(x - dx, y, r, Math.PI / 2, Math.PI * 1.5); }
    ctx.closePath();
  }

  function drawEye(ctx, e, x, y, s, open) {
    const w = e.w * s, h = e.h * s;
    y += e.dy * s;
    ctx.save();
    if (e.k === 'cap') {
      const hh = Math.max(h * open, w * 0.36);
      if (e.top) {
        const yt = y - hh / 2 + e.top * hh, k = e.tS * w * 0.9;
        ctx.beginPath(); ctx.moveTo(x - w, yt - k); ctx.lineTo(x + w, yt + k); ctx.lineTo(x + w, y + hh); ctx.lineTo(x - w, y + hh);
        ctx.closePath(); ctx.clip();
      }
      capsule(ctx, x, y, w, hh); ctx.fill();
    } else if (e.k === 'arc') {
      ctx.lineWidth = w * 0.72;
      ctx.beginPath(); ctx.ellipse(x, y + h * 0.2, w * 0.95, h * 0.32, 0, Math.PI * 1.08, Math.PI * 1.92); ctx.stroke();
    } else if (e.k === 'shut') {
      ctx.lineWidth = w * 0.5;
      ctx.beginPath(); ctx.ellipse(x, y - h * 0.05, w * 0.85, h * 0.18, 0, Math.PI * 0.12, Math.PI * 0.88); ctx.stroke();
    } else if (e.k === 'ring') {
      ctx.beginPath(); ctx.arc(x, y, w / 2 * (0.9 + 0.1 * open), 0, TAU); ctx.fill();
    }
    ctx.restore();
  }

  // 脸贴图：球面正面的展开平面，覆盖 ±0.75 个半径；两眼相距半个半径。头部倾斜时整张脸跟着转
  function drawFace(fx, size, f, M, col) {
    const s = size / 1.5 * 0.25 / 24, cx = size / 2, cy = size / 2 - 0.02 * size / 1.5, t = M.t;
    const rgba = a => `rgba(${col[0]},${col[1]},${col[2]},${a})`;
    fx.setTransform(1, 0, 0, 1, 0, 0); fx.clearRect(0, 0, size, size);
    fx.translate(cx, cy); fx.rotate(RB.rad(M.roll)); fx.translate(-cx, -cy);
    const blush = Math.min(1, Math.max(f.blush || 0, M.blush || 0));
    if (blush > 0.02) for (const side of [-1, 1]) {
      const bx = cx + side * 36 * s, by = cy + 22 * s, g = fx.createRadialGradient(bx, by, 0, bx, by, 13 * s);
      g.addColorStop(0, `rgba(255,150,190,${0.55 * blush})`); g.addColorStop(1, 'rgba(255,150,190,0)');
      fx.fillStyle = g; fx.fillRect(bx - 13 * s, by - 13 * s, 26 * s, 26 * s);
    }
    const open = [1 - (M.eL.close || 0), 1 - (M.eR.close || 0)], es = M.es || 1;
    const amp = 0.35 + 0.65 * clamp(Math.max(M.open || 0, (M.speech || 0) * 0.6), 0, 1);
    // 先画一层柔和的辉光，再画清晰的本体
    for (const pass of [0, 1]) {
      fx.save();
      fx.fillStyle = fx.strokeStyle = rgba(1); fx.lineCap = 'round';
      if (pass) { fx.shadowColor = rgba(0.7); fx.shadowBlur = 2.5 * s; }
      else { fx.shadowColor = rgba(0.95); fx.shadowBlur = 10 * s; fx.globalAlpha = 0.75; }
      const base = fx.globalAlpha;
      f.eyes.forEach((e, i) => drawEye(fx, e, cx + (i ? 24 : -24) * s, cy, s * es, open[i]));
      if (f.mouth === 'eq') for (let i = 0; i < 5; i++) {
        const hh = (2.6 + 6.5 * amp * Math.abs(Math.sin(t * 9 + i * 1.3) * Math.sin(t * 3.7 + i))) * s;
        capsule(fx, cx + (i - 2) * 5.6 * s, cy + 26 * s, 2.8 * s, hh); fx.fill();
      }
      if (f.mouth === 'dots') for (let i = 0; i < 3; i++) {
        fx.globalAlpha = base * (0.25 + 0.75 * Math.max(0, Math.sin(t * 5 - i * 0.9)));
        fx.beginPath(); fx.arc(cx + (i - 1) * 7.5 * s, cy + 26 * s, 2.1 * s, 0, TAU); fx.fill();
      }
      if (f.moon && pass) {
        const mx = cx + 40 * s, my = cy - 36 * s, mr = 8 * s;
        fx.beginPath(); fx.arc(mx, my, mr, 0, TAU); fx.fill();
        fx.globalCompositeOperation = 'destination-out'; fx.shadowBlur = 0;
        fx.beginPath(); fx.arc(mx + mr * 0.55, my - mr * 0.4, mr * 0.85, 0, TAU); fx.fill();
      }
      fx.restore();
    }
  }

  const VS = 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }';
  // 坐标：u 是画布逻辑坐标（y 向下），q 以球心为原点、半径为 1（y 向上）
  const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes, uC, uSq, uLook;
uniform float uPx, uR, uGround, uLift, uT, uFt, uDark, uBright, uSwirl, uTintK, uHue, uSmoke, uRTex;
uniform vec3 uTint, uC1, uC2;
uniform sampler2D uFace, uOrb;
mat3 rotY(float a){ float c = cos(a), s = sin(a); return mat3(c,0.,-s, 0.,1.,0., s,0.,c); }
mat3 rotX(float a){ float c = cos(a), s = sin(a); return mat3(1.,0.,0., 0.,c,s, 0.,-s,c); }
vec3 hueRot(vec3 c, float a){
  if (abs(a) < 0.001) return c;
  mat3 toYIQ = mat3(0.299,0.596,0.211, 0.587,-0.274,-0.523, 0.114,-0.322,0.312);
  mat3 toRGB = mat3(1.0,1.0,1.0, 0.956,-0.272,-1.106, 0.621,-0.647,1.703);
  vec3 y = toYIQ * c; float h = atan(y.z, y.y) + a, ch = length(y.yz);
  return clamp(toRGB * vec3(y.x, ch*cos(h), ch*sin(h)), 0.0, 1.0);
}
vec3 grade(vec3 c, float k){
  c = hueRot(c, uHue);
  float l = dot(c, vec3(0.299, 0.587, 0.114));
  return mix(c, clamp(uTint * l / dot(uTint, vec3(0.299, 0.587, 0.114)), 0.0, 1.0), k);
}
vec3 orb(vec2 q){ return texture2D(uOrb, 0.5 + vec2(q.x, -q.y) * 0.5 * uRTex).rgb; }
void main(){
  vec2 u = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uPx;
  vec2 q = vec2(u.x - uC.x, uC.y - u.y) / (uR * uSq);
  float d = length(q), px = 1.0 / (uPx * uR * min(uSq.x, uSq.y)), t = uT;
  // 地面：一小团接触阴影 + 光穿过玻璃后投下的彩色光斑，球离地越高越淡
  vec2 g = vec2(u.x - uC.x, u.y - uGround) / uR;
  float b = uLift * 0.66;
  vec2 sp = g / vec2(0.606 * (1.0 + b*1.5), 0.076);
  float sh = max(exp(-dot(sp,sp)*1.6) * (0.26 - b) * mix(1.0, 1.3, uDark), 0.0);
  vec2 cp = (g - vec2(0.09, 0.0)) / vec2(0.94, 0.136);
  float caus = exp(-dot(cp,cp)*1.3) * 0.24 * uBright * max(1.0 - b*3.0, 0.0) * (1.0 - 0.6*uSmoke);
  vec3 causC = grade(mix(vec3(1.0,0.64,0.52), vec3(0.6,0.52,1.0), 0.5 + 0.5*sin(t*0.3)), uTintK);
  vec4 col = vec4(causC * caus, clamp(sh + caus*0.6, 0.0, 1.0));
  // 外发光
  vec3 haloC = grade(mix(uC1, uC2, 0.5 + 0.5*sin(t*0.4 + atan(q.y, q.x))), uTintK);
  float halo = exp(-max(d - 1.0, 0.0) * mix(11.0, 6.5, uDark)) * smoothstep(1.0 - px, 1.0 + px, d)
    * mix(0.16, 0.4, uDark) * uBright * (1.0 - 0.5*uSmoke);
  col.rgb += haloC * halo; col.a = clamp(col.a + halo*0.85, 0.0, 1.0);
  if (d < 1.0 + 2.0*px) {
    float z = sqrt(max(1.0 - d*d, 0.0));
    vec3 n = vec3(q, z);
    vec2 base = q * 0.995;
    // 高光和磨砂边缘固定不动，只让里面的光流动
    float lum0 = dot(orb(base), vec3(0.299, 0.587, 0.114));
    float inner = (1.0 - smoothstep(0.80, 0.93, lum0)) * (1.0 - smoothstep(0.78, 0.96, d));
    float ang = (sin(uFt*0.17)*0.2 + uSwirl*0.42*sin(t*1.1)) * inner * (1.0 - d*0.4);
    vec2 w = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * base;
    w += inner * 0.05 * vec2(sin(w.y*3.2 + uFt*0.55) + 0.5*sin(w.x*5.1 - uFt*0.4), cos(w.x*2.9 - uFt*0.5) + 0.5*cos(w.y*4.7 + uFt*0.35));
    w -= inner * uLook * vec2(0.05, 0.04);
    vec3 s1 = orb(w);
    s1.g = min(s1.g, max(s1.r, s1.b)*1.02 + 0.02);
    vec3 lit = mix(s1, grade(s1, uTintK), inner);
    lit *= mix(1.0, uBright, inner * (uBright < 1.0 ? 1.0 : 0.6));
    // 石墨：里面的光压暗成烟熏玻璃，边缘高光保留
    lit = mix(lit, lit * vec3(0.30, 0.32, 0.40) + vec3(0.012, 0.014, 0.024), uSmoke * inner);
    vec3 nr = rotX(uLook.y*0.38) * rotY(-uLook.x*0.42) * n;
    vec2 fuv = nr.xy / 1.5 + 0.5;
    vec4 face = texture2D(uFace, vec2(fuv.x, 1.0 - fuv.y)) * smoothstep(0.05, 0.35, nr.z);
    vec3 body = face.rgb + lit * (1.0 - face.a);
    float a = 1.0 - smoothstep(0.99 - px, 0.99 + px, d);
    col = vec4(body * a, a) + col * (1.0 - a);
  }
  gl_FragColor = col;
}`;
  const NAMES = ['uRes', 'uPx', 'uC', 'uR', 'uSq', 'uGround', 'uLift', 'uT', 'uFt', 'uDark', 'uBright', 'uSwirl', 'uTint', 'uTintK', 'uHue',
    'uSmoke', 'uRTex', 'uC1', 'uC2', 'uLook', 'uFace', 'uOrb'];

  class Orb {
    // 拿不到 WebGL 或初始化失败时返回 null，由 Robot 退回 2D 气泡；之后贴图加载失败、上下文无法恢复时调用 onfail
    static create(canvas, onfail) {
      let gl = null;
      try { gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false }); } catch (_) { /* 不支持 WebGL */ }
      if (!gl) return null;
      const orb = new Orb(canvas, gl, onfail);
      return orb.init() ? orb : null;
    }

    constructor(canvas, gl, onfail) {
      this.canvas = canvas; this.gl = gl; this.onfail = onfail;
      this.face = document.createElement('canvas'); this.fx = this.face.getContext('2d');
      this.ready = false; this.lost = false; this.dead = false; this.s = null; this.t0 = 0;
      canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.lost = true; this.ready = false; });
      canvas.addEventListener('webglcontextrestored', () => { this.lost = false; if (!this.init()) this.fail(); });
    }

    fail() {
      if (this.dead) return;
      this.dead = true; this.ready = false;
      if (this.onfail) this.onfail();
    }

    init() {
      const gl = this.gl;
      try {
        const sh = (type, src) => {
          const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
          if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
          return s;
        };
        const pr = gl.createProgram();
        gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS)); gl.linkProgram(pr);
        if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr) || 'link');
        gl.useProgram(pr);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(pr, 'a');
        gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        this.tex = [0, 1].map(unit => {
          gl.activeTexture(gl.TEXTURE0 + unit);
          const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return tex;
        });
        const U = this.U = {};
        for (const n of NAMES) U[n] = gl.getUniformLocation(pr, n);
        gl.uniform1i(U.uFace, 0); gl.uniform1i(U.uOrb, 1);
        gl.uniform1f(U.uR, R); gl.uniform1f(U.uRTex, TEX_R);
        gl.uniform3fv(U.uC1, AURORA[0]); gl.uniform3fv(U.uC2, AURORA[1]);
      } catch (err) {
        console.warn('光之球初始化失败，改用 2D 气泡', err);
        return false;
      }
      RB.orbReady.then(ok => {
        if (!ok) { this.fail(); return; }
        if (this.lost || this.dead) return;
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[1]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        this.ready = true;
      });
      return true;
    }

    // 状态切换时色调、流速、亮度一起缓动；流速累加成相位，变速时光不会跳
    follow(M, f, r) {
      const first = !this.s, dt = first ? 0 : clamp(M.t - this.t0, 0, 0.1), a = first ? 1 : 1 - Math.exp(-dt * 4);
      this.t0 = M.t;
      const S = this.s || (this.s = { flow: 1, swirl: 0, bright: 1, k: 0, tint: [1, 1, 1], hue: 0, smoke: 0, dark: 0, ft: 0 });
      const pal = PAL[r.palette] || PAL.blue, tn = f.pal ? TINT[f.pal] : pal[1] ? [pal[1], pal[2]] : TINT.none;
      const go = (k, v) => { S[k] += (v - S[k]) * a; };
      go('flow', f.flow || 1); go('swirl', (f.swirl || 0) * (r.reduced ? 0.3 : 1)); go('bright', f.bright || 1);
      go('k', tn[1]); go('hue', f.pal ? 0 : pal[0]);
      go('smoke', r.shell === 'graphite' ? 1 : 0); go('dark', r.theme === 'dark' ? 1 : 0);
      for (let i = 0; i < 3; i++) S.tint[i] += (tn[0][i] - S.tint[i]) * a;
      S.ft += dt * S.flow * (r.reduced ? 0.4 : 1);
      return S;
    }

    // r 是 Robot：用它的画布缩放、强调色、机身、主题和“减少动态效果”
    render(M, r) {
      const gl = this.gl, cv = this.canvas;
      if (this.lost) return;
      gl.viewport(0, 0, cv.width, cv.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.ready) return;
      const f = FACES[M.name] || FACES.idle, S = this.follow(M, f, r), t = M.t, U = this.U, mot = r.reduced ? 0.3 : 1;
      const size = clamp(Math.ceil(R * r.scale * 1.5 / 32) * 32, 128, 512);
      if (this.face.width !== size) this.face.width = this.face.height = size;
      drawFace(this.fx, size, f, M, r.shell === 'graphite' ? M.rgb.map(c => Math.round(c + (255 - c) * 0.45)) : WHITE);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[0]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.face);

      const mod = (f.breathe ? 0.92 + 0.08 * mot * Math.sin(t * 1.3) : 1)
        * (f.pulse ? 0.9 + 0.18 * mot * Math.sin(t * (f.pulse > 1 ? 7 : 4)) : 1)
        * (f.voice ? 0.95 + 0.12 * (M.open || 0) : 1);
      // 眼睛扫视加上头部转动，一起带着整张脸在球面上转
      const lx = clamp(M.gx * 0.55 + M.yaw * 0.3, -0.9, 0.9), ly = clamp(M.gy * 0.55 + M.pitch * 0.3, -0.9, 0.9);
      gl.uniform2f(U.uRes, cv.width, cv.height); gl.uniform1f(U.uPx, r.scale);
      gl.uniform2f(U.uC, M.cx, M.cy);
      gl.uniform2f(U.uSq, 1 + (M.sx - 1) * SQUASH, 1 + (M.sy - 1) * SQUASH);
      gl.uniform1f(U.uGround, RB.CY + R * GROUND); gl.uniform1f(U.uLift, (RB.CY - M.cy) / R);
      gl.uniform1f(U.uT, t); gl.uniform1f(U.uFt, S.ft);
      gl.uniform1f(U.uDark, S.dark); gl.uniform1f(U.uSmoke, S.smoke);
      gl.uniform1f(U.uBright, S.bright * mod); gl.uniform1f(U.uSwirl, S.swirl);
      gl.uniform3fv(U.uTint, S.tint); gl.uniform1f(U.uTintK, S.k); gl.uniform1f(U.uHue, S.hue);
      gl.uniform2f(U.uLook, lx, -ly);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  RB.Orb = Orb;
  RB.ORB = { R, FACES, PAL };
  // 强调色换算成 CSS：hue-rotate 角度（YIQ 正向是 HSL 反向）和 color 混合的染色层；品牌标记用它和桌面角色同色
  RB.orbStyle = name => {
    const p = PAL[name] || PAL.blue, c = p[1] || WHITE.map(v => v / 255);
    return { hue: (-p[0] * 180 / Math.PI).toFixed(1) + 'deg', tint: `rgba(${c.map(v => Math.round(v * 255)).join(',')},${p[2] || 0})` };
  };
})();

export {};
