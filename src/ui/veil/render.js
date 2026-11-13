/* KBOT · 光纹生命体 · 绘制
 * 三层叠起来：远处的雾、近处的光晕和失焦的翼（都是离屏画了再模糊），最上面是清晰的纱面和细丝。
 * 输出始终是合法的预乘颜色（各通道不超过不透明度），WebKit 合成“颜色大于不透明度”的像素会出错。
 */
import { LINE_STRIDE, FILL_STRIDE, BLOB_STRIDE } from './mesh.js';

// uFw：清晰度怎么换算成权重。(1,0) 只画对上焦的部分，(0,1) 只画失焦的部分。
const LINE_VS = `
attribute vec2 aPos, aNrm;
attribute float aSide, aHalf, aFocus;
attribute vec4 aCol;
uniform vec2 uRes;
uniform mediump float uWide, uSoft;
uniform mediump vec2 uFw;
varying float vD, vHalf;
varying vec4 vCol;
void main() {
  float h = aHalf + uWide, e = h + uSoft;
  vec2 p = (aPos + aNrm * aSide * e) / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vD = aSide * e; vHalf = h;
  vCol = vec4(aCol.rgb, aCol.a * (uFw.x * aFocus + uFw.y * (1.0 - aFocus)));
}`;
const LINE_FS = `
precision mediump float;
uniform float uSoft, uGain;
uniform vec4 uTint;
varying float vD, vHalf;
varying vec4 vCol;
void main() {
  float cov = clamp((vHalf + uSoft - abs(vD)) / (2.0 * uSoft), 0.0, 1.0);
  cov = cov * cov * (3.0 - 2.0 * cov);
  float i = min(1.0, vCol.a * cov * uGain);
  vec3 c = mix(vCol.rgb, uTint.rgb * max(vCol.r, max(vCol.g, vCol.b)), uTint.a);
  gl_FragColor = vec4(c * i, i * max(c.r, max(c.g, c.b)));
}`;

const FILL_VS = `
attribute vec2 aPos, aTV, aIF;
attribute vec4 aCol;
attribute vec3 aWR;
uniform vec2 uRes;
varying vec2 vTV, vIF;
varying vec4 vCol;
varying vec3 vWR;
void main() {
  vec2 p = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vTV = aTV; vIF = aIF; vCol = aCol; vWR = aWR;
}`;
// 纱面：半透明的薄膜，两条边是有宽度的柔光带（像丝绸的折边）；虹彩是沿着丝的方向拉开的彩色条纹
const FILL_FS = `
precision mediump float;
uniform float uGain, uIri, uRim, uRimWidth, uTime;
uniform vec2 uFw;
uniform vec4 uTint;
varying vec2 vTV, vIF;
varying vec4 vCol;
varying vec3 vWR;
vec3 rainbow(float h) { return 0.76 + 0.24 * cos(6.2831853 * (h - vec3(0.0, 0.3333, 0.6667))); }
void main() {
  float t = vTV.x, v = vTV.y;
  float w = uFw.x * vIF.y + uFw.y * (1.0 - vIF.y);
  float dA = v * vWR.x, dB = (1.0 - v) * vWR.x;
  // 折边的光带：有宽度，往里柔和地淡掉；纱面窄的地方光带也跟着收窄
  float rw = min(uRimWidth, vWR.x * 0.3) + 0.6;
  float rim = vWR.y * exp(-dA / rw) + vWR.z * exp(-dB / rw);
  float body = 0.8 + 0.3 * pow(abs(v * 2.0 - 1.0), 2.0);
  // 虹彩：很淡。一是顺着丝拉开的细彩条（橙、青相间），二是纱边上的一圈彩边，纱面中间基本还是本色
  float streak = smoothstep(0.45, 1.0, 0.5 + 0.5 * sin(v * 58.0 + 3.0 * sin(t * 7.0 + v * 4.0 + uTime * 0.35)));
  streak *= 0.6 + 0.4 * sin(t * 23.0 + v * 11.0 - uTime * 0.8);
  float edge = pow(abs(v * 2.0 - 1.0), 3.0);
  float h = 0.3 + 0.3 * sin(v * 21.0 + t * 5.0 + uTime * 0.22) + 0.2 * edge;
  float k = vIF.x * uIri;
  vec3 c = mix(vCol.rgb, rainbow(h), k * (0.08 + 0.55 * streak + 0.4 * edge));
  c = mix(c, uTint.rgb * max(c.r, max(c.g, c.b)), uTint.a);
  // 薄膜：正常覆盖；亮边：叠在上面的白光
  float a = min(0.95, vCol.a * body * (1.0 + k * 0.55 * streak) * w * uGain);
  float r = min(1.0, rim * uRim * w * uGain);
  gl_FragColor = vec4(c * a + mix(vec3(1.0), uTint.rgb, uTint.a) * r, min(1.0, a + r));
}`;

const BLOB_VS = `
attribute vec2 aPos, aUv;
attribute vec4 aCol;
uniform vec2 uRes;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec2 p = aPos / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  vUv = aUv; vCol = aCol;
}`;
const BLOB_FS = `
precision mediump float;
uniform float uGain;
uniform vec4 uTint;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  float d2 = dot(vUv, vUv);
  float g = max(0.0, exp(-d2 * 5.0) - 0.0067) + 0.6 * exp(-d2 * 60.0);
  float i = min(1.0, g * vCol.a * uGain);
  vec3 c = mix(vCol.rgb, uTint.rgb * max(vCol.r, max(vCol.g, vCol.b)), uTint.a);
  gl_FragColor = vec4(c * i, i * max(c.r, max(c.g, c.b)));
}`;

// 卷成球时外面那层玻璃泡：一个被轻轻压扁的圆。uM 是变形（2×2），vUv 是变形前的位置，所以边线跟着一起变
const SHELL_VS = `
attribute vec2 aPos;
uniform vec2 uRes, uCenter;
uniform float uR;
uniform vec4 uM;
varying vec2 vUv;
void main() {
  vUv = aPos * 1.06;
  vec2 q = vUv * uR;
  vec2 p = (uCenter + vec2(uM.x * q.x + uM.y * q.y, uM.z * q.x + uM.w * q.y)) / uRes * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
}`;
// 像一个肥皂泡：中间几乎是空的，越靠边越亮，最外面一圈细线；朝光的一侧亮，背光的一侧淡；左上一道月牙形的高光
const SHELL_FS = `
precision mediump float;
uniform float uAlpha, uTime, uPx, uRim, uBody;
uniform vec4 uTint;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float edge = clamp((1.0 - d) / (1.5 * uPx), 0.0, 1.0);
  float z = sqrt(max(0.0, 1.0 - d * d));
  vec2 n = vUv / max(d, 1e-4);
  float ang = atan(vUv.y, vUv.x);
  // 薄膜上的虹彩，沿着边慢慢流
  float h = 0.56 + 0.2 * sin(ang * 2.0 + uTime * 0.21) + 0.1 * sin(ang * 3.0 - uTime * 0.13 + 1.7) + 0.45 * z;
  vec3 film = 0.8 + 0.2 * cos(6.2831853 * (h - vec3(0.0, 0.3333, 0.6667)));
  float lit = 0.55 + 0.45 * dot(n, vec2(-0.6, -0.8));
  float rim = (0.5 * pow(1.0 - z, 2.6) + 0.55 * pow(d, 30.0)) * (0.35 + 0.65 * lit) * uRim;
  // 月牙高光：贴着左上的边，两头收尖；右下还有一点很淡的反光
  float arc = pow(max(0.0, dot(n, vec2(-0.66, -0.75))), 9.0);
  float q = (d - 0.84) / 0.045;
  float spec = 0.5 * arc * exp(-q * q);
  vec2 b = vUv - vec2(0.48, 0.58);
  float bounce = 0.07 * exp(-dot(b, b) * 9.0);
  vec3 c = film * rim + vec3(spec) + vec3(0.84, 0.88, 1.0) * (bounce + uBody * (0.4 + 0.6 * (1.0 - z)));
  c = mix(c, uTint.rgb * max(c.r, max(c.g, c.b)), uTint.a);
  c = min(c * edge * uAlpha, 1.0);
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
}`;
// 浅色外观下垫在球后面的深色圆片：光是叠加上去的，落在浅色底板上看不见，得有一小块夜色托着
const PLATE_FS = `
precision mediump float;
uniform float uAlpha, uPx;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float a = uAlpha * clamp((1.0 - d) / (1.5 * uPx), 0.0, 1.0);
  vec3 c = mix(vec3(0.15, 0.16, 0.31), vec3(0.06, 0.07, 0.16), smoothstep(0.0, 1.0, d));
  gl_FragColor = vec4(c * a, a);
}`;

const QUAD_VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;
// 9 抽头高斯，借线性采样合成 5 次取样
const BLUR_FS = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uStep;
uniform float uGain;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(uTex, vUv) * 0.2270270270;
  c += (texture2D(uTex, vUv + uStep * 1.3846153846) + texture2D(uTex, vUv - uStep * 1.3846153846)) * 0.3162162162;
  c += (texture2D(uTex, vUv + uStep * 3.2307692308) + texture2D(uTex, vUv - uStep * 3.2307692308)) * 0.0702702703;
  gl_FragColor = c * uGain;
}`;
const MIX_FS = `
precision mediump float;
uniform sampler2D uNear, uMid, uFar;
uniform vec3 uGains;
varying vec2 vUv;
void main() {
  vec4 c = min(texture2D(uNear, vUv) * uGains.x + texture2D(uMid, vUv) * uGains.y + texture2D(uFar, vUv) * uGains.z, 1.0);
  gl_FragColor = vec4(c.rgb, max(c.a, max(c.r, max(c.g, c.b))));
}`;

const NO_TINT = [1, 1, 1, 0];

export const LOOK = {
  line: 1, fill: 1, iri: 1, time: 0,
  rim: 0.5, rimWidth: 6,                        // 折边柔光带的强度和宽度（CSS 像素）
  lineSoft: 0.36,                               // 细丝边缘的柔化（CSS 像素）
  near: 0.55, mid: 1, far: 0.3,                 // 三层各自的强度：光晕、失焦的翼、远处的雾
  glowLine: 0.4, glowFill: 0.25, glowBlob: 0.5, // 画进光晕底图的量
  shell: 1, shellBody: 0.022, glowShell: 0.4,   // 玻璃泡外壳：边线的强度、泡身的一点乳白、画进光晕底图的量
  gain: 1, tint: null,                          // 整体亮度；染色 [r, g, b, 程度]
  plate: null,                                  // 垫在后面的深色圆片 { x, y, r, a }（CSS 像素），浅色外观下用
  fogLine: 0.5, fogFill: 1,                     // 失焦部分画进雾里的量
};

export function createRenderer(canvas, { preserve = false } = {}) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: preserve });
  if (!gl || !gl.getExtension('OES_element_index_uint')) return null;

  function program(vsSrc, fsSrc, uniforms, attribs) {
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader');
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link');
    return { p, u: Object.fromEntries(uniforms.map(n => [n, gl.getUniformLocation(p, n)])) };
  }

  const line = program(LINE_VS, LINE_FS, ['uRes', 'uWide', 'uSoft', 'uFw', 'uGain', 'uTint'], ['aPos', 'aNrm', 'aSide', 'aHalf', 'aCol', 'aFocus']);
  const fill = program(FILL_VS, FILL_FS, ['uRes', 'uGain', 'uIri', 'uFw', 'uRim', 'uRimWidth', 'uTime', 'uTint'], ['aPos', 'aTV', 'aCol', 'aIF', 'aWR']);
  const blob = program(BLOB_VS, BLOB_FS, ['uRes', 'uGain', 'uTint'], ['aPos', 'aUv', 'aCol']);
  const blur = program(QUAD_VS, BLUR_FS, ['uTex', 'uStep', 'uGain'], ['aPos']);
  const mix = program(QUAD_VS, MIX_FS, ['uNear', 'uMid', 'uFar', 'uGains'], ['aPos']);
  const shell = program(SHELL_VS, SHELL_FS, ['uRes', 'uCenter', 'uR', 'uM', 'uAlpha', 'uTime', 'uPx', 'uRim', 'uBody', 'uTint'], ['aPos']);
  const plate = program(SHELL_VS, PLATE_FS, ['uRes', 'uCenter', 'uR', 'uM', 'uAlpha', 'uPx'], ['aPos']);
  const LAYOUT = {
    line: { stride: LINE_STRIDE, attribs: [[2, 0], [2, 2], [1, 4], [1, 5], [4, 6], [1, 10]] },
    fill: { stride: FILL_STRIDE, attribs: [[2, 0], [2, 2], [4, 4], [2, 8], [3, 10]] },
    blob: { stride: BLOB_STRIDE, attribs: [[2, 0], [2, 2], [4, 4]] },
  };
  const buffers = {};
  for (const k of ['line', 'fill', 'blob']) buffers[k] = { v: gl.createBuffer(), i: gl.createBuffer(), n: 0 };
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.disable(gl.DEPTH_TEST);

  let targets = null, targetKey = '';
  function target(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { w, h, tex, fbo };
  }
  function ensureTargets() {
    const key = canvas.width + 'x' + canvas.height;
    if (key === targetKey) return;
    if (targets) for (const t of Object.values(targets)) { gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fbo); }
    const size = shift => [Math.max(2, canvas.width >> shift), Math.max(2, canvas.height >> shift)];
    targets = { near: target(...size(1)), nearT: target(...size(1)), mid: target(...size(2)), midT: target(...size(2)), far: target(...size(3)), farT: target(...size(3)) };
    targetKey = key;
  }
  function bind(t, clear = false) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : canvas.width, t ? t.h : canvas.height);
    if (clear) { gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); }
  }

  function upload(mesh) {
    for (const k of ['line', 'fill', 'blob']) {
      const b = buffers[k];
      gl.bindBuffer(gl.ARRAY_BUFFER, b.v); gl.bufferData(gl.ARRAY_BUFFER, mesh[k].v, gl.DYNAMIC_DRAW);
      // 三角形的连法不变，只在换了网格时重传
      if (b.src !== mesh[k].i) { gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh[k].i, gl.STATIC_DRAW); b.src = mesh[k].i; }
      b.n = mesh[k].i.length;
    }
  }
  function use(kind, prog) {
    const b = buffers[kind], L = LAYOUT[kind];
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, b.v); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.i);
    for (let i = 0; i < 6; i++) {
      if (i < L.attribs.length) { gl.enableVertexAttribArray(i); gl.vertexAttribPointer(i, L.attribs[i][0], gl.FLOAT, false, L.stride * 4, L.attribs[i][1] * 4); }
      else gl.disableVertexAttribArray(i);
    }
    return b.n;
  }
  function useQuad(prog) {
    gl.useProgram(prog.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    for (let i = 1; i < 6; i++) gl.disableVertexAttribArray(i);
  }

  function draw(mesh, view, look = LOOK) {
    upload(mesh);
    ensureTargets();
    const T = targets, px = 1 / view.dpr, G = look.gain ?? 1, tint = look.tint || NO_TINT;
    const lines = (wide, soft, fx, fy, gain) => {
      gain *= G;
      if (gain <= 0) return;
      gl.blendFunc(gl.ONE, gl.ONE);
      const n = use('line', line);
      gl.uniform2f(line.u.uRes, view.w, view.h);
      gl.uniform1f(line.u.uWide, wide); gl.uniform1f(line.u.uSoft, soft); gl.uniform2f(line.u.uFw, fx, fy); gl.uniform1f(line.u.uGain, gain);
      gl.uniform4f(line.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, 0);
    };
    const fills = (fx, fy, gain) => {
      gain *= G;
      if (gain <= 0) return;
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const n = use('fill', fill);
      gl.uniform2f(fill.u.uRes, view.w, view.h);
      gl.uniform1f(fill.u.uGain, gain); gl.uniform1f(fill.u.uIri, look.iri); gl.uniform2f(fill.u.uFw, fx, fy);
      gl.uniform1f(fill.u.uRim, look.rim); gl.uniform1f(fill.u.uRimWidth, look.rimWidth); gl.uniform1f(fill.u.uTime, look.time || 0);
      gl.uniform4f(fill.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, 0);
    };
    const blobs = gain => {
      gain *= G;
      if (gain <= 0) return;
      gl.blendFunc(gl.ONE, gl.ONE);
      const n = use('blob', blob);
      gl.uniform2f(blob.u.uRes, view.w, view.h); gl.uniform1f(blob.u.uGain, gain);
      gl.uniform4f(blob.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawElements(gl.TRIANGLES, n, gl.UNSIGNED_INT, 0);
    };
    const sh = mesh.shell;
    const shells = gain => {
      gain *= G;
      if (!sh || sh.a * gain <= 0.004 || sh.r < 2) return;
      gl.blendFunc(gl.ONE, gl.ONE);
      useQuad(shell);
      gl.uniform2f(shell.u.uRes, view.w, view.h); gl.uniform2f(shell.u.uCenter, sh.x, sh.y); gl.uniform1f(shell.u.uR, sh.r);
      gl.uniform4f(shell.u.uM, sh.m[0], sh.m[1], sh.m[2], sh.m[3]);
      gl.uniform1f(shell.u.uAlpha, sh.a * gain); gl.uniform1f(shell.u.uTime, look.time || 0); gl.uniform1f(shell.u.uPx, px / sh.r);
      gl.uniform1f(shell.u.uRim, look.shell); gl.uniform1f(shell.u.uBody, look.shellBody);
      gl.uniform4f(shell.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const pass = (src, dst, sx, sy, gain = 1) => {
      bind(dst);
      gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.uniform2f(blur.u.uStep, sx / src.w, sy / src.h); gl.uniform1f(blur.u.uGain, gain);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    const soften = (a, b, steps) => { for (const s of steps) { pass(a, b, s, 0); pass(b, a, 0, s); } };

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    // 对上焦的部分：光晕的底图
    bind(T.near, true);
    fills(1, 0, look.glowFill);
    lines(0.5, 1.2, 1, 0, look.glowLine);
    blobs(look.glowBlob);
    shells(look.glowShell);
    // 失焦的部分：整个画进去再模糊
    bind(T.mid, true);
    fills(0, 1, look.fogFill);
    lines(1.4, 2.4, 0, 1, look.fogLine);

    useQuad(blur);
    gl.activeTexture(gl.TEXTURE0); gl.uniform1i(blur.u.uTex, 0);
    // 远处的雾 = 两张底图加在一起，缩到八分之一再模糊
    bind(T.far, true);
    gl.blendFunc(gl.ONE, gl.ONE);
    pass(T.near, T.far, 2, 2, 1); pass(T.mid, T.far, 1.5, 1.5, 1);
    gl.disable(gl.BLEND);
    soften(T.far, T.farT, [1, 2, 3]);
    soften(T.near, T.nearT, [1, 2]);
    soften(T.mid, T.midT, [1, 2, 3]);

    bind(null, true);
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const pl = look.plate;
    if (pl && pl.a > 0.004 && pl.r > 1) {
      useQuad(plate);
      gl.uniform2f(plate.u.uRes, view.w, view.h); gl.uniform2f(plate.u.uCenter, pl.x, pl.y); gl.uniform1f(plate.u.uR, pl.r);
      gl.uniform4f(plate.u.uM, 1, 0, 0, 1); gl.uniform1f(plate.u.uAlpha, pl.a); gl.uniform1f(plate.u.uPx, px / pl.r);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    useQuad(mix);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, T.far.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.mid.tex);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.near.tex);
    gl.uniform1i(mix.u.uNear, 0); gl.uniform1i(mix.u.uMid, 1); gl.uniform1i(mix.u.uFar, 2);
    gl.uniform3f(mix.u.uGains, look.near, look.mid, look.far);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    shells(1);
    fills(1, 0, look.fill);
    lines(0, Math.max(px * 0.5, look.lineSoft), 1, 0, look.line);
  }

  return { draw, clear: () => bind(null, true), finish: () => gl.finish() };
}
