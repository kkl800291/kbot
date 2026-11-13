/* KBOT · 光纹生命体对外接口：在宿主元素里铺一块画布，调用方按屏幕顶部的状态设模式和能量框。
 * 身体是 veil/ 里那颗由光纱卷成的球；这里只管它在哪、多大、此刻是什么状态，以及画不出来时的兜底。
 */
import * as POSE from './veil/pose.js';
import { createMesh } from './veil/mesh.js';
import { createRenderer, LOOK } from './veil/render.js';
import { createLife } from './veil/life.js';
import { PALETTES, withPalette } from './veil/palette.js';

/** 待命时球心的位置和玻璃泡的半径（姿态坐标）。能量框按这个基准换算，所以倾听时凑近、出错时下沉都看得出来。 */
export const REF = { x: 759, y: 338, r: 184 };
/** 调用方的模式对应身体的哪个状态。倾听平时就是待命的样子，有人打字的那一会儿才转过来听。 */
export const MODE_STATE = { idle: 'idle', listen: 'idle', think: 'think', progress: 'think', talk: 'talk', remind: 'remind', done: 'idle', error: 'error' };

const LITE_BELOW = 56;      // 球的半径小于这么多（CSS 像素）而且停稳了：换省事的网格，降到每秒 30 帧
const REMIND_HOLD = 3000;   // 表情触发的提醒形态放多久（毫秒）
const ATTEND_MS = 1600;     // 停止打字多久后，从倾听回到待命
const RESUMMON_MS = 8000;   // 刚走不久又被叫回来：用短的入场
const PLATE_FULL = 50, PLATE_NONE = 90;   // 深色圆片只垫在小头像后面：半径 50 以内才全有，90 以上完全没有
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * 能量框 [x, y, w, h] → 球心和半径。
 * 召唤态的大框：球是主角，占框高的九成，球心略偏上，下面紧跟着输入框；头像那样的小框：居中，尽量撑满。
 */
export function orbFrame(rect) {
  const x = Number(rect?.[0]) || 0, y = Number(rect?.[1]) || 0, w = Math.max(0, Number(rect?.[2]) || 0), h = Math.max(0, Number(rect?.[3]) || 0);
  const m = Math.min(w, h);
  if (m > 140) return { x: x + w / 2, y: y + h * 0.47, r: m * 0.45 };
  return { x: x + w / 2, y: y + h / 2, r: Math.max(1, m * 0.45) };
}

/** 画得越小，丝越挤在一起、光晕相对越大，都要按大小收一收。 */
function tune(look, r) {
  const sc = r / REF.r;
  const thin = clamp(Math.pow(sc / 0.8, 0.85), 0.07, 1), halo = clamp(sc / 0.5, 0.22, 1);
  look.line = LOOK.line * thin; look.glowLine = LOOK.glowLine * thin; look.fogLine = LOOK.fogLine * thin;
  look.near = LOOK.near * halo; look.far = LOOK.far * halo;
}

/** WebGL 用不了时的样子：一颗不动的玻璃球。 */
function paintFlat(ctx, view, x, y, r, alpha, light) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  ctx.clearRect(0, 0, view.w, view.h);
  if (alpha <= 0.004 || r < 1) return;
  ctx.globalAlpha = alpha;
  if (light) { ctx.fillStyle = 'rgb(22, 24, 48)'; ctx.beginPath(); ctx.arc(x, y, r * 1.12, 0, 6.2832); ctx.fill(); }
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.05, x, y, r);
  g.addColorStop(0, 'rgba(255, 255, 255, .5)'); g.addColorStop(0.45, 'rgba(196, 200, 255, .2)');
  g.addColorStop(0.86, 'rgba(170, 180, 255, .12)'); g.addColorStop(1, 'rgba(236, 238, 255, .55)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  ctx.strokeStyle = 'rgba(240, 242, 255, .7)'; ctx.lineWidth = Math.max(0.75, r * 0.02); ctx.stroke();
  ctx.globalAlpha = 1;
}

/** 把球摆进画面：身体的动态、位置大小、深浅外观 → 这一帧的画法。 */
function compose(look, life, frame, plateAlpha) {
  const sc = frame.r / REF.r, ox = frame.x - REF.x * sc, oy = frame.y - REF.y * sc, sh = life.dyn.shell;
  tune(look, frame.r);
  look.time = life.clock.t; look.tint = life.dyn.tint; look.gain = life.dyn.gain;
  const pl = look.plate;
  pl.x = ox + sh.x * sc; pl.y = oy + sh.y * sc; pl.r = Math.max(frame.r, sh.r * sc) * 1.1; pl.a = plateAlpha * life.S.alpha;
  return { scale: sc, ox, oy };
}

/**
 * host 是能量体所在的元素，画布铺满它；能量框 setBox([x, y, w, h])、进度带 setBand、目光 lookAt 都用 host 内的 CSS 像素。
 * 只在 start() 和 stop() 之间模拟和绘制；stop() 先播离场，结束后画布清空，不再占用 CPU。
 * gpuTiming 只给实验页测性能用：每帧等 GPU 画完再计时。
 */
export function createEnergy(host, { palette = 'molten', reduced = false, gpuTiming = false } = {}) {
  const life = createLife();
  let calm = !!reduced;
  life.setReduced(calm);
  const view = { w: 0, h: 0, dpr: 1 };
  const look = { ...LOOK, plate: { x: 0, y: 0, r: 0, a: 0 } };
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const layer = () => {
    const c = document.createElement('canvas');
    c.setAttribute('aria-hidden', 'true');
    c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;transition:opacity .15s ease';
    host.append(c);
    return c;
  };
  const glCanvas = layer();
  let gl = createRenderer(glCanvas), flatCanvas = null, flat = null, fallback = false;

  // 任务进度带：一条细线，前沿带一点光。颜色跟界面强调色
  const band = document.createElement('div'), bandFill = document.createElement('div');
  band.className = 'e-band'; bandFill.className = 'e-band-fill'; band.hidden = true;
  band.append(bandFill); host.append(band);

  let pal = PALETTES.includes(palette) ? palette : 'molten', pose = withPalette(POSE, pal), full = null, lite = null;
  const meshFor = small => (small ? (lite ||= createMesh(pose, { detail: 0.4 })) : (full ||= createMesh(pose)));

  // 球此刻的位置和半径、要去的位置和半径（host 内的 CSS 像素）
  const cur = { x: 0, y: 0, r: 1 }, tgt = { x: 0, y: 0, r: 1 }, vel = { x: 0, y: 0, r: 0 };
  let origin = null, plate = 0, tone = 'dark', small = false;
  let running = false, leaving = false, raf = 0, last = 0, goneAt = -1e9, haltTimer = 0;
  let base = 'idle', hold = null, holdUntil = 0, attendUntil = 0, mode = 'idle';
  const perf = { sim: 0, draw: 0 };

  function measure() {
    view.w = host.clientWidth; view.h = host.clientHeight;
    view.dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [glCanvas, flatCanvas]) {
      if (!c) continue;
      c.width = Math.max(1, Math.round(view.w * view.dpr));
      c.height = Math.max(1, Math.round(view.h * view.dpr));
    }
  }

  function useFlat(on) {
    fallback = on;
    if (on && !flatCanvas) {
      flatCanvas = layer();
      flat = flatCanvas.getContext('2d');
      measure();
    }
    glCanvas.style.display = on ? 'none' : '';
    if (flatCanvas) flatCanvas.style.display = on ? '' : 'none';
  }
  const opacity = v => { for (const c of [glCanvas, flatCanvas]) if (c) c.style.opacity = String(v); };

  /** 此刻该是什么状态：表情触发的思考、提醒盖在基础模式上；刚有人打字就转过来听。 */
  function sync(now = performance.now()) {
    if (hold === 'remind' && now >= holdUntil) hold = null;
    if (attendUntil && now >= attendUntil) attendUntil = 0;
    mode = hold || base;
    const st = mode === 'listen' && attendUntil ? 'listen' : MODE_STATE[mode] || 'idle';
    if (st !== life.state) life.setState(st);
  }

  /** 球朝目标框走过去：召唤态收成常驻条时，它是飞过去的，不是跳过去的。 */
  function follow(dt) {
    const o = host.getBoundingClientRect();
    origin = { x: o.left, y: o.top };
    if (calm) { Object.assign(cur, tgt); vel.x = vel.y = vel.r = 0; return; }
    const w = 11;
    for (const k of ['x', 'y', 'r']) { vel[k] += (w * w * (tgt[k] - cur[k]) - 2 * w * vel[k]) * dt; cur[k] += vel[k] * dt; }
    if (cur.r < 1) cur.r = 1;
  }

  const plateFor = r => (tone === 'light' ? 0.94 * clamp((PLATE_NONE - r) / (PLATE_NONE - PLATE_FULL), 0, 1) : 0);

  /** 省事的画法只给停稳的小头像。还在飞、还在入场离场的时候照常画满 60 帧，不然看着就是掉帧。 */
  function settledSmall() {
    if (cur.r >= LITE_BELOW || tgt.r >= LITE_BELOW || life.busy) return false;
    return Math.abs(tgt.x - cur.x) + Math.abs(tgt.y - cur.y) + Math.abs(tgt.r - cur.r) < 0.4 && Math.abs(vel.x) + Math.abs(vel.y) + Math.abs(vel.r) < 2;
  }

  function paint() {
    const at = compose(look, life, cur, plate);
    if (fallback) { if (flat) paintFlat(flat, view, look.plate.x, look.plate.y, cur.r, life.S.alpha, plate > 0.5); return; }
    gl.draw(meshFor(small).update(at, life.dyn), view, look);
  }

  function advance(dt, now) {
    const t0 = performance.now();
    if ((hold === 'remind' && now >= holdUntil) || (attendUntil && now >= attendUntil)) sync(now);
    follow(dt);
    // 浅色外观下垫在小头像后面的深色圆片。大球不垫（它浮在暮色上）；正在离场时保持原样，不临走冒出一块来
    if (!leaving) plate += (plateFor(cur.r) - plate) * (calm ? 1 : 1 - Math.exp(-dt * 9));
    life.step(dt);
    if (leaving && !calm && !life.busy) { halt(); return; }
    small = settledSmall();
    const t1 = performance.now();
    paint();
    if (gpuTiming) gl?.finish();
    const t2 = performance.now();
    perf.sim += (t1 - t0 - perf.sim) * 0.05;
    perf.draw += (t2 - t1 - perf.draw) * 0.05;
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    // 停稳的小头像上看不出 60 帧和 30 帧的差别
    if (small && now - last < 30) return;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    advance(dt, now);
  }

  function loop(on) {
    cancelAnimationFrame(raf);
    raf = 0;
    if (on) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  function halt() {
    running = false; leaving = false;
    loop(false);
    clearTimeout(haltTimer);
    band.hidden = true;
    life.hide();
    goneAt = performance.now();
    gl?.clear();
    if (flat) { flat.setTransform(1, 0, 0, 1, 0, 0); flat.clearRect(0, 0, flatCanvas.width, flatCanvas.height); }
    opacity(1);
  }

  glCanvas.addEventListener('webglcontextlost', e => {
    e.preventDefault();
    console.warn('[energy] WebGL 上下文丢失，暂时改用静止画面');
    useFlat(true);
  });
  glCanvas.addEventListener('webglcontextrestored', () => {
    const again = createRenderer(glCanvas);
    if (!again) return;
    gl = again;
    useFlat(false);
  });

  // 两套网格趁空闲先建好，免得第一次召唤、第一次缩成头像的那一帧卡一下
  setTimeout(() => { if (gl) { meshFor(false); meshFor(true); } }, 400);

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  ro?.observe(host);
  measure();
  if (!gl) {
    console.warn('[energy] WebGL 不可用，改用静止画面');
    useFlat(true);
  }

  const api = {
    /** 入场。离场途中再次唤起，就从当前的样子接着回来。 */
    start() {
      if (running && !leaving) return;
      const now = performance.now(), again = leaving || now - goneAt < RESUMMON_MS;
      clearTimeout(haltTimer);
      if (!running) { Object.assign(cur, tgt); vel.x = vel.y = vel.r = 0; plate = plateFor(cur.r); small = false; }
      running = true; leaving = false;
      measure();
      sync(now);
      if (calm) { life.show(); opacity(1); }
      else life.arrive(tgt.r < LITE_BELOW ? 'tiny' : again);
      loop(true);
    },
    /** 离场：化成雾散掉，结束后停止绘制。now 为真时立刻停。 */
    stop({ now = false } = {}) {
      if (!running) return;
      if (now) { halt(); return; }
      if (leaving) return;
      leaving = true;
      band.hidden = true;
      if (calm) { opacity(0); clearTimeout(haltTimer); haltTimer = setTimeout(halt, 170); }
      else life.depart(cur.r < LITE_BELOW ? 'tiny' : 'close');
    },
    /** idle、listen、think、talk、remind、progress、done、error。未知模式返回 false。 */
    setMode(name) {
      if (!(name in MODE_STATE)) return false;
      if (name === 'done') { life.accent('done'); base = 'idle'; } else base = name;
      if (hold === 'think') hold = null;
      sync();
      return true;
    },
    /** 回复里的表情标签。未知标签返回 false。 */
    accent(expr) {
      if (expr === 'think') { hold = 'think'; sync(); return true; }
      if (expr === 'remind') { hold = 'remind'; holdUntil = performance.now() + REMIND_HOLD; sync(); return true; }
      return life.accent(expr);
    },
    /** 能量框。状态切换时飞过去；拖动窗口时用 immediate 让头像直接跟手。 */
    setBox(rect, { immediate = false } = {}) {
      Object.assign(tgt, orbFrame(rect));
      small = false;   // 要动了：从这一帧起就画满
      const o = host.getBoundingClientRect();
      if (!running || calm || immediate) { Object.assign(cur, tgt); vel.x = vel.y = vel.r = 0; }
      // 画布层自己换了位置（对话窗口和召唤态不在同一处）：球在屏幕上不跟着跳
      else if (origin) { cur.x += origin.x - o.left; cur.y += origin.y - o.top; }
      origin = { x: o.left, y: o.top };
    },
    /** 进度带的矩形；null 时不画。 */
    setBand(rect) {
      const ok = rect && rect.length >= 4 && Number(rect[2]) > 0;
      band.hidden = !ok;
      if (ok) Object.assign(band.style, { left: rect[0] + 'px', top: rect[1] + (rect[3] - 3) / 2 + 'px', width: rect[2] + 'px', height: '3px' });
    },
    setProgress(p) { bandFill.style.width = clamp(Number(p) || 0, 0, 1) * 100 + '%'; },
    /** 目光看向一点（host 内的 CSS 像素）；null 是没在看。只有待命时、离得近才会微微侧过来。 */
    lookAt(x, y) {
      if (x == null || y == null || !Number.isFinite(+x) || !Number.isFinite(+y)) { life.attend(null); return; }
      const sc = cur.r / REF.r;
      life.attend((x - cur.x) / sc + REF.x, (y - cur.y) / sc + REF.y);
    },
    /** 有人打了一个字：身上起一圈涟漪，转过来听一会儿。 */
    kick(k = 0.6) {
      if (!running) return;
      life.poke(k);
      attendUntil = performance.now() + ATTEND_MS;
      sync();
    },
    setPalette(name) {
      const next = PALETTES.includes(name) ? name : 'molten';
      if (next === pal) return;
      pal = next; pose = withPalette(POSE, pal); full = lite = null;
    },
    /** 衬底是深色（光直接叠上去）还是浅色（先垫一小块夜色，再叠光）。 */
    setTone(t) { tone = t === 'light' ? 'light' : 'dark'; },
    setReduced(on) { calm = !!on; life.setReduced(calm); },
    stats() {
      return {
        running, leaving, fallback, mode, state: life.state, palette: pal, tone, x: cur.x, y: cur.y, R: cur.r, lite: small,
        alpha: life.S.alpha, simMs: perf.sim, drawMs: perf.draw,
      };
    },
    destroy() {
      api.stop({ now: true });
      ro?.disconnect();
      glCanvas.remove();
      flatCanvas?.remove();
      band.remove();
    },
    life,
  };
  return api;
}

// 静止图标共用一块离屏 WebGL 画布，画完拷到调用方的 2D 画布上
let stillGl;
const stillMesh = {};
function stillRenderer() {
  if (stillGl === undefined) {
    const c = document.createElement('canvas');
    const r = createRenderer(c, { preserve: true });
    stillGl = r ? { c, r } : null;
  }
  return stillGl;
}

/** 在一块 2D 画布上画一帧静止的球，给小图标用。画布不能已经拿过 WebGL 上下文。 */
export function renderStill(canvas, { mode = 'idle', palette = 'molten', tone = 'dark', size } = {}) {
  const w = size || canvas.clientWidth || canvas.width, h = size || canvas.clientHeight || canvas.height;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const view = { w, h, dpr }, light = tone === 'light';
  // 图标上没有底板托着，球画得比头像稍小，给光晕和深色圆片留边
  const frame = { x: w / 2, y: h / 2, r: Math.min(w, h) * (light ? 0.4 : 0.44) };
  const life = createLife();
  life.show(); life.snap(MODE_STATE[mode] || 'idle');
  for (let i = 0; i < 96; i++) life.step(1 / 30);
  const ctx = canvas.getContext('2d'), g = stillRenderer();
  if (!ctx) return;
  const look = { ...LOOK, plate: { x: 0, y: 0, r: 0, a: 0 } };
  const at = compose(look, life, frame, light ? 0.94 : 0);
  if (!g) { paintFlat(ctx, view, frame.x, frame.y, frame.r, 1, light); return; }
  const pal = PALETTES.includes(palette) ? palette : 'molten';
  const mesh = stillMesh[pal] ||= createMesh(withPalette(POSE, pal), { detail: 0.6 });
  g.c.width = canvas.width; g.c.height = canvas.height;
  g.r.draw(mesh.update(at, life.dyn), view, look);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(g.c, 0, 0);
}

/** 品牌标记：一枚静止的小光球。 */
export function energyMark(size, opts = {}) {
  const c = document.createElement('canvas');
  c.className = 'e-mark';
  c.setAttribute('aria-hidden', 'true');
  c.style.width = c.style.height = size + 'px';
  const tone = opts.tone || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  renderStill(c, { ...opts, tone, size });
  return c;
}
