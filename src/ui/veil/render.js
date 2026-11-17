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
  float core = smoothstep(0.24, 0.88, i);
  float lum = max(vCol.r, max(vCol.g, vCol.b));
  vec3 tinted = mix(vCol.rgb, uTint.rgb * lum, uTint.a * (1.0 - 0.62 * core));
  vec3 c = mix(tinted, vec3(0.98, 0.99, 1.0) * max(lum, 0.95), 0.45 * core * (1.0 - 0.35 * uTint.a));
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
// 纱面：极轻薄的光学丝膜，折叠边缘形成珍珠焦散亮带，色散克制如微光棱镜
const FILL_FS = `
precision mediump float;
uniform float uGain, uIri, uRim, uRimWidth, uTime;
uniform vec2 uFw;
uniform vec4 uTint;
varying vec2 vTV, vIF;
varying vec4 vCol;
varying vec3 vWR;
vec3 rainbow(float h) { return 0.84 + 0.16 * cos(6.2831853 * (h - vec3(0.0, 0.3333, 0.6667))); }
void main() {
  float t = vTV.x, v = vTV.y;
  float w = uFw.x * vIF.y + uFw.y * (1.0 - vIF.y);
  float dA = v * vWR.x, dB = (1.0 - v) * vWR.x;
  float rw = min(uRimWidth, vWR.x * 0.28) + 0.55;
  float rim = vWR.y * exp(-dA / rw) + vWR.z * exp(-dB / rw);
  float body = 0.72 + 0.26 * pow(abs(v * 2.0 - 1.0), 2.0);
  // 焦散波纹：平滑流动的光密度干涉，而非生硬的高频条纹
  float shimmer = 0.5 + 0.5 * sin(t * 10.5 - uTime * 1.1 + 1.8 * sin(v * 5.5 + uTime * 0.6));
  float caustic = pow(0.5 + 0.5 * sin(t * 17.5 - uTime * 1.6 + 2.2 * sin(v * 7.5 - uTime * 0.5)), 3.0);
  float edge = pow(abs(v * 2.0 - 1.0), 2.6);
  float h = 0.36 + 0.24 * sin(v * 14.0 + t * 4.5 + uTime * 0.2) + 0.16 * edge + 0.12 * shimmer + 0.08 * caustic;
  float k = max(vIF.x, 0.28) * uIri;
  vec3 c = mix(vCol.rgb, rainbow(h), clamp(k * (0.08 + 0.26 * edge + 0.18 * caustic + 0.08 * shimmer), 0.0, 0.68));
  float lum = max(c.r, max(c.g, c.b));
  c = mix(c, uTint.rgb * lum, uTint.a * 0.78);
  float a = min(0.86, vCol.a * body * (0.86 + k * (0.18 * shimmer + 0.28 * caustic)) * w * uGain);
  float r = min(1.0, rim * (0.94 + 0.32 * caustic) * uRim * w * uGain);
  vec3 rimCol = mix(vec3(0.97, 0.98, 1.0), uTint.rgb, 0.42 * uTint.a);
  gl_FragColor = vec4(c * a + rimCol * r, min(1.0, a + r));
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
// 无硬壳的大气包络场：大尺度下几乎化为空气薄雾，绝不框死内部光纱；仅在缩成极小头像时保留柔和聚光边
const SHELL_FS = `
precision mediump float;
uniform float uAlpha, uTime, uPx, uRim, uBody, uIri;
uniform vec4 uTint;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  if (d >= 1.0) discard;
  float fall = smoothstep(1.0, 0.16, d);
  float softRim = exp(-pow((d - 0.84) / 0.12, 2.0)) * smoothstep(1.0, 0.82, d);
  float corePool = exp(-d * d * 2.6);
  float ang = atan(vUv.y, vUv.x);
  float breath = 0.5 + 0.5 * sin(ang * 2.0 - uTime * 0.7 + d * 2.2);
  float smallness = clamp((uPx - 0.008) / 0.022, 0.0, 1.0);
  float rimAmt = mix(0.05, 0.28, smallness) * uRim * (0.72 + 0.28 * breath);
  float bodyAmt = (uBody * (0.65 + 0.6 * corePool) + mix(0.036, 0.08, smallness) * corePool * (0.72 + 0.28 * breath)) * fall;
  vec3 mistCol = mix(vec3(0.86, 0.90, 1.0), uTint.rgb, 0.45 * uTint.a);
  vec3 rimCol = mix(vec3(0.94, 0.96, 1.0), uTint.rgb, 0.35 * uTint.a);
  vec3 c = mistCol * bodyAmt + rimCol * softRim * rimAmt;
  c = min(c * uAlpha, 1.0);
  gl_FragColor = vec4(c, max(c.r, max(c.g, c.b)));
}`;
// 浅色外观下垫在球后面的深色圆片：保持柔和过渡，不显硬圆边
const PLATE_FS = `
precision mediump float;
uniform float uAlpha, uPx;
varying vec2 vUv;
void main() {
  float d = length(vUv);
  float a = uAlpha * clamp((1.0 - d) / (2.5 * uPx), 0.0, 1.0);
  vec3 c = mix(vec3(0.12, 0.14, 0.24), vec3(0.05, 0.06, 0.12), smoothstep(0.0, 1.0, d));
  gl_FragColor = vec4(c * a, a);
}`;

// 生命体背后的局部散射光池：让光体真正融进空间，照亮附近空气，而非贴在背景上的干贴图
const AURA_FS = `
precision mediump float;
uniform vec2 uRes, uCenter;
uniform float uRadius;
uniform vec4 uAura, uTint;
varying vec2 vUv;
void main() {
  if (uAura.z <= 0.004 || uRadius < 2.0) discard;
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 d = (p - uCenter) / vec2(uRadius * 2.55, uRadius * 1.9);
  float r2 = dot(d, d);
  if (r2 > 3.6) discard;
  float t = uAura.w;
  float ripple = 0.5 + 0.5 * sin(sqrt(r2) * 4.8 - t * 1.2 + 0.5 * atan(d.y, d.x));
  float pool = exp(-r2 * 1.35) * 0.62 + exp(-r2 * 3.8) * (0.38 + 0.22 * ripple * uAura.y);
  float a = clamp(pool * (0.08 + 0.06 * uAura.x + 0.075 * uAura.y) * uAura.z + (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0, 0.0, 0.26);
  vec3 baseCol = vec3(0.84, 0.87, 1.0);
  vec3 col = mix(baseCol, mix(baseCol, uTint.rgb, 0.65), clamp(uTint.a * 1.1, 0.0, 0.82));
  gl_FragColor = vec4(col * a, a);
}`;

// 全屏 / 浮层四边柔和光学微晕：低饱和珠光雾纱，无硬边、无跑马灯（严格预乘 Alpha 输出）
const EDGE_FS = `
precision highp float;
uniform vec2 uRes;
uniform vec4 uRect;    // x, y, w, h (CSS px)
uniform vec4 uParams;  // radius, mode (0=fullscreen, 1=panel), gain, burst
uniform vec4 uPhase;   // time, summonElapsed, summonOn, think
uniform vec4 uState;   // listen, talk, deliver, paletteIndex
uniform vec4 uMouse;   // mx, my, mouseOn, isLight
uniform vec4 uTint;
varying vec2 vUv;

float sdBoxR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - (b - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float gain = clamp(uParams.z, 0.0, 1.5);
  if (gain <= 0.003) discard;

  vec2 px = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 halfSize = max(uRect.zw * 0.5, vec2(1.0));
  vec2 center = uRect.xy + halfSize;
  vec2 q = px - center;
  float minDim = max(min(uRect.z, uRect.w), 1.0);
  float cornerR = clamp(uParams.x > 0.5 ? uParams.x : (uParams.y < 0.5 ? 24.0 : 18.0), 1.0, minDim * 0.48);
  float sd = sdBoxR(q, halfSize, cornerR);

  float mode = uParams.y;
  float burst = clamp(uParams.w, 0.0, 1.2);
  float t = uPhase.x;
  float uSummon = max(0.0, uPhase.y);
  float uSummonOn = clamp(uPhase.z, 0.0, 1.0);
  float uThink = clamp(uPhase.w, 0.0, 1.0);
  float uListen = clamp(uState.x, 0.0, 1.0);
  float uTalk = clamp(uState.y, 0.0, 1.0);
  float uDeliver = clamp(uState.z, 0.0, 1.0);

  float dEdge = mode < 0.5 ? max(0.0, -sd) : max(0.0, sd);
  float maxReach = mode < 0.5 ? 185.0 : 28.0;
  if (mode < 0.5) {
    if (sd > 1.0 || dEdge > maxReach) discard;
  } else {
    if (sd < -2.0 || dEdge > maxReach) discard;
  }

  vec2 normQ = q / max(halfSize, vec2(1.0));
  float theta = atan(normQ.y + 1e-6, normQ.x + 1e-6);

  // Deep organic breathing (~5.2s)
  float bp = fract(t / 5.2);
  float breath = bp < 0.40 ? sin((bp / 0.40) * 1.570796) : cos(((bp - 0.40) / 0.60) * 1.570796);

  // Uniform bloom on summon (no racing marquee wave)
  float summonBloom = mix(1.0, smoothstep(0.0, 0.55, uSummon), uSummonOn);

  // Tactile pointer gravity along the perimeter
  vec2 mQ = (uMouse.xy - center) / max(halfSize, vec2(1.0));
  vec2 pDir = normalize(normQ + 1e-5);
  vec2 mDir = normalize(mQ + 1e-5);
  float mouseBias = 0.5 + 0.5 * dot(pDir, mDir);
  float pointerAttract = clamp(uMouse.z, 0.0, 1.0) * pow(max(1e-4, mouseBias), 2.4) * (0.65 + 0.35 * uListen);

  float prosody = (0.35 * uListen + 0.85 * uTalk + burst * 0.95) * (0.5 + 0.5 * sin(t * 3.4) * sin(t * 2.1 + 0.6));
  float flowRate = 0.55 + 0.95 * uThink + 0.68 * uTalk + 0.25 * uListen + 0.45 * burst;

  // Multi-harmonic organic tidal rhythm (ebbs and swells smoothly without hard outlines or marquee comets)
  float tide1 = sin(2.0 * theta - t * (0.88 * flowRate) + dEdge * 0.015);
  float tide2 = cos(3.0 * theta + t * (0.62 * flowRate) - dEdge * 0.012);
  float tidalWave = 0.55 * tide1 + 0.45 * tide2;
  float rhythmMod = 0.68 + 0.32 * (0.5 + 0.5 * tidalWave);

  // Broad, ultra-soft radial reach that physically swells and breathes
  float depthScale = mode < 0.5
    ? (48.0 + 16.0 * breath + 20.0 * prosody + 26.0 * burst + 32.0 * pointerAttract + 10.0 * uDeliver + (12.0 + 10.0 * uThink + 14.0 * prosody) * tidalWave)
    : (9.0 + 3.0 * breath + 4.0 * prosody);

  // Curated desaturated pearlescent mineral palette (restrained, atmospheric)
  vec3 cPearl     = vec3(0.85, 0.90, 0.99);
  vec3 cSlate     = vec3(0.52, 0.66, 0.92);
  vec3 cChampagne = vec3(0.95, 0.83, 0.67);
  vec3 cSeaMist   = vec3(0.56, 0.85, 0.89);

  float drift1 = 0.5 + 0.5 * sin(theta - t * (0.48 * flowRate) + dEdge * 0.014);
  float drift2 = 0.5 + 0.5 * cos(2.0 * theta + t * (0.36 * flowRate) - dEdge * 0.011);
  vec3 coolWash = mix(cPearl, cSlate, drift1);
  vec3 mistWash = mix(cSeaMist, cChampagne, drift2);
  vec3 silkCol = mix(coolWash, mistWash, 0.40 + 0.28 * sin(theta + t * 0.34));

  // Expressive state & pointer feedback color shifts
  silkCol = mix(silkCol, mix(cPearl, cChampagne, 0.62), clamp(pointerAttract * 0.78, 0.0, 0.78));
  silkCol = mix(silkCol, mix(cSlate, cSeaMist, 0.48), clamp(uThink * 0.55 * (0.5 + 0.5 * cos(2.0 * theta - t * 0.75)), 0.0, 0.65));
  silkCol = mix(silkCol, mix(cChampagne, cPearl, 0.45), clamp((uTalk * 0.48 + burst * 0.55), 0.0, 0.65));

  if (uTint.a > 0.01) {
    float lum = max(silkCol.r, max(silkCol.g, silkCol.b));
    silkCol = mix(silkCol, uTint.rgb * max(lum, 0.84), clamp(uTint.a * 0.80, 0.0, 0.88));
  }

  // Smooth exponential falloff with guaranteed zero cutoff edge
  float reachFade = smoothstep(maxReach, 0.0, dEdge);
  reachFade = reachFade * reachFade;
  float outerMist = exp(-dEdge / (depthScale * 1.48)) * (0.40 + 0.16 * breath + 0.30 * pointerAttract + 0.24 * uThink + 0.24 * prosody + 0.30 * burst);
  float innerVeil = exp(-dEdge / (depthScale * 0.62)) * (0.34 + 0.14 * breath + 0.34 * pointerAttract + 0.26 * uThink + 0.28 * prosody + 0.36 * burst);
  float density = (outerMist + innerVeil) * reachFade * summonBloom * rhythmMod;

  float panelMask = mode < 0.5 ? 1.0 : smoothstep(-2.0, 2.0, sd);
  float alpha = clamp(density * gain * panelMask, 0.0, 0.82);
  vec3 outRGB = clamp(silkCol * alpha, 0.0, alpha);
  gl_FragColor = vec4(outRGB, alpha);
}`;

// 召唤态输入框外缘的柔光丝线包裹：3 股低饱和珠光丝线贴合胶囊外缘缓慢编织（严格预乘 Alpha 输出）
const FILAMENT_FS = `
precision highp float;
uniform vec2 uRes;
uniform vec4 uRect;    // x, y, w, h (CSS px)
uniform vec4 uParams;  // radius, gain, burst, vis
uniform vec4 uPhase;   // time, think, listen, talk
uniform vec4 uMouse;   // mx, my, mouseOn, unused
uniform vec4 uTint;
varying vec2 vUv;

float sdBoxR(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - (b - r);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float gain = clamp(uParams.y, 0.0, 1.5);
  float vis = clamp(uParams.w, 0.0, 1.0);
  if (gain * vis <= 0.003 || uRect.z <= 2.0 || uRect.w <= 2.0) discard;

  vec2 px = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 halfSize = max(uRect.zw * 0.5, vec2(1.0));
  vec2 center = uRect.xy + halfSize;
  vec2 q = px - center;
  float minDim = max(min(uRect.z, uRect.w), 1.0);
  float cornerR = clamp(uParams.x, 1.0, minDim * 0.5);
  float sd = sdBoxR(q, halfSize, cornerR);

  if (sd < -3.0 || sd > 24.0) discard;
  float dOut = max(0.0, sd);

  vec2 normQ = q / max(halfSize, vec2(1.0));
  float theta = atan(normQ.y + 1e-6, normQ.x + 1e-6);

  float t = uPhase.x;
  float uThink = clamp(uPhase.y, 0.0, 1.0);
  float uListen = clamp(uPhase.z, 0.0, 1.0);
  float uTalk = clamp(uPhase.w, 0.0, 1.0);
  float burst = clamp(uParams.z, 0.0, 1.2);

  vec2 mQ = (uMouse.xy - center) / max(halfSize, vec2(1.0));
  float mouseBias = 0.5 + 0.5 * dot(normalize(normQ + 1e-5), normalize(mQ + 1e-5));
  float pointerAttract = clamp(uMouse.z, 0.0, 1.0) * pow(max(1e-4, mouseBias), 2.5);

  float flowRate = 0.62 + 0.95 * uThink + 0.65 * uTalk + 0.25 * uListen;
  float prosody = 0.25 * uListen + 0.65 * uTalk + 0.70 * burst;

  vec3 cPearl     = vec3(0.86, 0.91, 0.99);
  vec3 cSlate     = vec3(0.56, 0.70, 0.94);
  vec3 cChampagne = vec3(0.95, 0.84, 0.70);
  vec3 cSeaMist   = vec3(0.60, 0.85, 0.89);

  float p1 = 0.5 + 0.5 * sin(theta - t * (0.45 * flowRate) + dOut * 0.06);
  float p2 = 0.5 + 0.5 * cos(2.0 * theta + t * (0.35 * flowRate));
  vec3 col = mix(mix(cPearl, cSlate, p1), mix(cSeaMist, cChampagne, p2), 0.36 + 0.24 * sin(theta + t * 0.28));
  col = mix(col, mix(cPearl, cChampagne, 0.55), clamp(pointerAttract * 0.55 + uTalk * 0.35, 0.0, 0.65));
  col = mix(col, mix(cSlate, cSeaMist, 0.45), clamp(uThink * 0.45, 0.0, 0.55));

  if (uTint.a > 0.01) {
    float lum = max(col.r, max(col.g, col.b));
    col = mix(col, uTint.rgb * max(lum, 0.85), clamp(uTint.a * 0.78, 0.0, 0.88));
  }

  float threads = 0.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float dir = mod(fi, 2.0) < 0.5 ? 1.0 : -1.0;
    float spd = (0.55 + fi * 0.22) * flowRate * dir;
    float baseD = 1.4 + fi * 1.9;
    float amp = 1.1 + 1.2 * uThink + 1.5 * prosody;
    float ribbonD = baseD + amp * sin((2.0 + fi) * theta + t * spd + fi * 1.4)
                        + amp * 0.45 * cos((3.0 + fi) * theta - t * spd * 0.7);
    float dt = dOut - max(0.2, ribbonD);
    float core = exp(-(dt * dt) / 1.35);
    float halo = exp(-(dt * dt) / 9.5) * 0.38;
    float wave = 0.52 + 0.48 * sin(2.0 * theta + t * (0.7 * dir) + fi * 1.7);
    threads += (core + halo) * wave;
  }

  float wrapMist = exp(-dOut / (6.5 + 3.0 * prosody)) * (0.24 + 0.16 * uThink + 0.18 * prosody + 0.14 * pointerAttract);
  float outerFade = smoothstep(24.0, 4.0, sd);
  float innerTuck = smoothstep(-3.0, 0.6, sd);
  float intensity = (threads * (0.44 + 0.26 * uThink + 0.28 * prosody + 0.18 * pointerAttract) + wrapMist)
                    * outerFade * innerTuck * gain * vis;

  vec3 coreCol = mix(col, vec3(0.97, 0.98, 1.0), clamp(threads * 0.28, 0.0, 0.42));
  float alpha = clamp(intensity, 0.0, 0.86);
  vec3 outRGB = clamp(coreCol * alpha, 0.0, alpha);
  gl_FragColor = vec4(outRGB, alpha);
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
  line: 1, fill: 1, iri: 0.72, time: 0,
  rim: 0.44, rimWidth: 5.5,                      // 折边柔光带的强度和宽度（CSS 像素）
  lineSoft: 0.38,                                // 细丝边缘的柔化（CSS 像素）
  near: 0.44, mid: 0.96, far: 0.38,              // 三层各自的强度：锐利焦散核、失焦柔翼、远处薄雾
  glowLine: 0.34, glowFill: 0.22, glowBlob: 0.44,// 画进光晕底图的量
  shell: 0.85, shellBody: 0.018, glowShell: 0.24,// 大气包络：极薄空间雾感，不框死内部光纱
  gain: 1, tint: null,                           // 整体亮度；染色 [r, g, b, 程度]
  plate: null,                                   // 垫在后面的深色圆片 { x, y, r, a }（CSS 像素），浅色外观下用
  aura: null,                                    // 生命体背后的局部散射光池 { x, y, r, strength, burst, alpha, time }
  edge: null,                                    // 全屏 / 浮层四边光学丝膜配置
  fieldEdge: null,                               // 召唤态输入框外缘的丝线包裹配置
  fogLine: 0.58, fogFill: 0.96,                  // 失焦部分画进雾里的量
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
  const shell = program(SHELL_VS, SHELL_FS, ['uRes', 'uCenter', 'uR', 'uM', 'uAlpha', 'uTime', 'uPx', 'uRim', 'uBody', 'uIri', 'uTint'], ['aPos']);
  const plate = program(SHELL_VS, PLATE_FS, ['uRes', 'uCenter', 'uR', 'uM', 'uAlpha', 'uPx'], ['aPos']);
  const aura = program(QUAD_VS, AURA_FS, ['uRes', 'uCenter', 'uRadius', 'uAura', 'uTint'], ['aPos']);
  const edge = program(QUAD_VS, EDGE_FS, ['uRes', 'uRect', 'uParams', 'uPhase', 'uState', 'uMouse', 'uTint'], ['aPos']);
  const filament = program(QUAD_VS, FILAMENT_FS, ['uRes', 'uRect', 'uParams', 'uPhase', 'uMouse', 'uTint'], ['aPos']);
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
      gl.uniform1f(shell.u.uRim, look.shell); gl.uniform1f(shell.u.uBody, look.shellBody); gl.uniform1f(shell.u.uIri, look.iri ?? 1);
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
    const au = look.aura;
    if (au && au.alpha > 0.004 && au.r > 42) {
      useQuad(aura);
      gl.uniform2f(aura.u.uRes, view.w, view.h);
      gl.uniform2f(aura.u.uCenter, au.x, au.y);
      gl.uniform1f(aura.u.uRadius, au.r);
      gl.uniform4f(aura.u.uAura, au.strength ?? 1, au.burst ?? 0, au.alpha, au.time ?? look.time ?? 0);
      gl.uniform4f(aura.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const ed = look.edge;
    if (ed && ed.enable > 0.004 && ed.w > 2 && ed.h > 2) {
      useQuad(edge);
      gl.uniform2f(edge.u.uRes, view.w, view.h);
      gl.uniform4f(edge.u.uRect, ed.x, ed.y, ed.w, ed.h);
      gl.uniform4f(edge.u.uParams, ed.r || 0, ed.mode || 0, (ed.gain ?? 1) * ed.enable * G, ed.burst ?? 0);
      gl.uniform4f(edge.u.uPhase, ed.time ?? look.time ?? 0, ed.summon ?? 0, ed.summonOn ?? 0, ed.think ?? 0);
      gl.uniform4f(edge.u.uState, ed.listen ?? 0, ed.talk ?? 0, ed.deliver ?? 0, ed.pal ?? 0);
      gl.uniform4f(edge.u.uMouse, ed.mx ?? 0, ed.my ?? 0, ed.mouseOn ?? 0, ed.light ?? 0);
      gl.uniform4f(edge.u.uTint, tint[0], tint[1], tint[2], tint[3]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    const fe = look.fieldEdge;
    if (fe && fe.enable > 0.004 && fe.w > 2 && fe.h > 2) {
      useQuad(filament);
      gl.uniform2f(filament.u.uRes, view.w, view.h);
      gl.uniform4f(filament.u.uRect, fe.x, fe.y, fe.w, fe.h);
      gl.uniform4f(filament.u.uParams, fe.r || 24, (fe.gain ?? 0.72) * fe.enable * G, fe.burst ?? 0, fe.vis ?? 1);
      gl.uniform4f(filament.u.uPhase, fe.time ?? look.time ?? 0, fe.think ?? 0, fe.listen ?? 0, fe.talk ?? 0);
      gl.uniform4f(filament.u.uMouse, fe.mx ?? 0, fe.my ?? 0, fe.mouseOn ?? 0, 0);
      gl.uniform4f(filament.u.uTint, tint[0], tint[1], tint[2], tint[3]);
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
