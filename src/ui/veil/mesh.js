/* KBOT · 光纹生命体 · 把姿态（边线）变成可绘制的网格：纱面的填充、纱面上的细丝、结点上的柔光。
 * createMesh(pose) 先把不变的东西算好（边线采样、每根丝的性格），update() 每帧只做形变和上色。
 */

export const LINE_STRIDE = 11;  // x y nx ny side half r g b 强度 清晰度
export const FILL_STRIDE = 13;  // x y t v r g b 不透明度 虹彩 清晰度 纱宽 亮边A 亮边B
export const BLOB_STRIDE = 8;   // x y u v r g b 强度
const COLS = 5;                 // 填充面横向的列数
const THREAD = [0.78, 0.8, 1.0];  // 里面的丝偏淡紫，只有边线是白的
const FILM_DUSK = [0.5, 0.5, 0.7], FILM_MILK = [0.82, 0.87, 1.0];  // 薄膜的颜色：暗处是暮色的灰紫，亮处是乳白
const TAU = 6.2831853;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const u = clamp((x - a) / (b - a), 0, 1); return u * u * (3 - 2 * u); };
function hash(n) { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }

/** 分段线性的曲线 [[t, 值], ...]。 */
function profile(p, t) {
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++) {
    if (t <= p[i][0]) { const [t0, v0] = p[i - 1], [t1, v1] = p[i]; return v0 + (v1 - v0) * ((t - t0) / (t1 - t0 || 1)); }
  }
  return p[p.length - 1][1];
}

/** 过各点的 Catmull-Rom 曲线，按“对位”分段、段内按弧长均分，取 n 个点。 */
export function sampleEdge(points, n) {
  const SUB = 14, P = points, m = P.length;
  const dense = [], owner = [];
  for (let i = 0; i < m - 1; i++) {
    const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(m - 1, i + 2)];
    for (let s = 0; s < SUB; s++) {
      const u = s / SUB, u2 = u * u, u3 = u2 * u;
      const f = k => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * u3);
      dense.push([f(0), f(1)]); owner.push(s === 0 ? i : -1);
    }
  }
  dense.push([P[m - 1][0], P[m - 1][1]]); owner.push(m - 1);
  const len = [0];
  for (let i = 1; i < dense.length; i++) len.push(len[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
  // 对位点：[弧长, 参数]
  const knots = [[0, 0]];
  owner.forEach((o, i) => { if (o > 0 && o < m - 1 && P[o][2] != null) knots.push([len[i], P[o][2]]); });
  knots.push([len[len.length - 1], 1]);
  const out = new Float32Array(n * 2);
  let seg = 0, j = 0;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    while (seg < knots.length - 2 && t > knots[seg + 1][1]) seg++;
    const [l0, t0] = knots[seg], [l1, t1] = knots[seg + 1];
    const s = l0 + (l1 - l0) * ((t - t0) / (t1 - t0 || 1));
    while (j < len.length - 2 && len[j + 1] < s) j++;
    const f = clamp((s - len[j]) / (len[j + 1] - len[j] || 1), 0, 1);
    out[i * 2] = dense[j][0] + (dense[j + 1][0] - dense[j][0]) * f;
    out[i * 2 + 1] = dense[j][1] + (dense[j + 1][1] - dense[j][1]) * f;
  }
  return out;
}

/** 虹彩：柔和的彩虹色。 */
function rainbow(out, h) {
  const a = h * TAU;
  out[0] = 0.76 + 0.24 * Math.cos(a);
  out[1] = 0.76 + 0.24 * Math.cos(a - 2.094);
  out[2] = 0.76 + 0.24 * Math.cos(a - 4.189);
}

/**
 * 每帧的动态量。全是默认值时画出来的就是静帧。
 * warp(x, y, out, group)：把姿态里的一个点挪到这一帧的位置（out[0]、out[1]），out[2] 是它的前后；group 是这片纱属于上半（1）、下半（-1）还是两翼（0）。
 */
export const STILL = {
  warp: null,
  orb: 0,          // 卷成球的程度：这时 warp 还会给出每个点的前后（out[2]，朝向观看者为正），背面的丝更暗更虚
  alpha: 1,        // 整体在场程度
  focus: 1,        // 整体对焦程度：0 时全身化成雾
  when: {},        // 只在某个状态出现的纱：{ think: 0..1 }
  flow: 0,         // 丝在纱面上游移的相位
  wander: 0,       // 丝横向游走的幅度
  billow: 0, billowPhase: 0,   // 纱面宽窄的起伏
  glint: 0, glintPhase: 0,     // 沿着单根丝滑过去的细碎流光
  pulses: [],      // 流过全身的光：[{ x, xl, w, g, loop }]，loop 的光在下半身反向走（xl）
  touch: null,     // 被碰到的地方亮一下：{ x, y, r, g }
  revealX: 1e9,    // 显现前沿：它左边的看得见
  hideX: -1e9,     // 隐去前沿：它右边的看得见
  focusX: 1e9,     // 对焦前沿：它左边的对上了焦，右边还是雾
  sweep: 0,        // 前沿上的那一道亮
  glow: 1, thread: 1, hem: 1, film: 1,
  dofL: 0, dofR: 0,         // 景深边界的偏移
  shell: null,     // 卷成球时外面那层玻璃泡：{ x, y, r, m: [2×2 变形], a }，姿态坐标
};

/** detail：细致程度。1 是完整的；小头像上看不清一根根丝，用 0.4 左右，少采样、少画丝，省下大半计算。 */
export function createMesh(pose, { detail = 1 } = {}) {
  const { SHEETS, LIGHTS, DOF } = pose;
  const nL = LIGHTS.length, lx = new Float32Array(nL), ly = new Float32Array(nL);
  const reach = LIGHTS.map(L => 11.6 * L.r * L.r), inv = LIGHTS.map(L => 1 / (2 * L.r * L.r));
  let nLine = 0, nFill = 0, nLineI = 0, nFillI = 0;

  const sheets = SHEETS.map((S, si) => {
    const K = Math.max(20, Math.round((S.k || 112) * detail));
    const nIn = detail < 1 ? Math.max(2, Math.round(S.lines * detail)) : S.lines, nCross = Math.round((S.cross || 0) * detail);
    const thin = Math.sqrt(S.lines / nIn);   // 丝少了，每根亮一点，整体深浅不变
    const prof = (name, fallback) => { const a = new Float32Array(K); for (let k = 0; k < K; k++) a[k] = S[name] ? profile(S[name], k / (K - 1)) : fallback; return a; };
    const lines = [], total = nIn + nCross;
    for (let j = 0; j < total; j++) {
      const cross = j >= nIn;
      const u = nIn > 1 ? j / (nIn - 1) : 0.5;
      const edge = cross ? -1 : j === 0 ? S.edgeA : j === nIn - 1 ? S.edgeB : -1;
      if (edge === 0) continue;
      const rnd = hash(si * 31.7 + j * 7.3), rnd2 = hash(j * 3.1 + si * 5.9), rnd3 = hash(j * 11.3 + si * 2.7);
      // 前 S.lines 根顺着纱面走；后 S.cross 根斜着从一边漂到另一边，和前者交出细密的纹理
      const v0 = cross ? rnd : Math.pow(u, S.bias), v1 = cross ? clamp(rnd + (rnd2 - 0.5) * 1.1, 0.02, 0.98) : v0;
      // 边线亮而略粗；里面的丝细，深浅不一，隔几根有一根亮的
      const accent = rnd2 > 0.82 ? 1.7 : 1;
      lines.push({
        edge: edge > 0, v0, v1, rnd, rnd3,
        // 丝不是等距的：每根沿途有一点点游移，疏密才自然
        weave: edge > 0 ? 0 : (S.weave ?? 0.013), wf: 0.8 + 1.6 * rnd3, wp: rnd2 * TAU,
        gain: edge > 0 ? S.gain * edge : (cross ? S.gain * (0.3 + 0.4 * rnd) : S.gain * (0.4 + 0.7 * rnd) * accent) * thin,
        half: edge > 0 ? 0.7 : 0.4 + 0.18 * rnd2,
        tone: edge > 0 || S.pure ? 0 : 0.5,
        glint: edge > 0 || accent > 1,
      });
    }
    const P = {
      S, K, lines, group: S.group || 0, blank: false,
      A0: sampleEdge(S.a, K), B0: sampleEdge(S.b, K), A: new Float32Array(K * 2), B: new Float32Array(K * 2),
      fade: prof('fade', 1), focus: prof('focus', 1), iri: prof('iri', 0), veil: prof('veil', 1), milk: prof('milk', 0.6), thread: prof('thread', 1), hem: prof('hem', 1),
      dens: new Float32Array(K), wide: new Float32Array(K), px: new Float32Array(K), py: new Float32Array(K), vv: new Float32Array(K),
      pulse: new Float32Array(K), zA: new Float32Array(K), zB: new Float32Array(K), phase: si * 1.7,
      wand: lines.map((_, j) => ({ f: 0.5 + 0.9 * hash(j * 5.3 + si * 1.9), p: hash(j * 2.9 + si * 7.7) * TAU, a: 0.5 + hash(j * 9.1 + si * 3.3) })),
      lineAt: nLine, fillAt: nFill,
    };
    nLine += lines.length * K * 2; nLineI += lines.length * (K - 1) * 6;
    if (S.fill > 0) { nFill += K * COLS; nFillI += (K - 1) * (COLS - 1) * 6; }
    return P;
  });

  const lineV = new Float32Array(nLine * LINE_STRIDE), lineI = new Uint32Array(nLineI);
  const fillV = new Float32Array(nFill * FILL_STRIDE), fillI = new Uint32Array(nFillI);
  { // 顶点怎么连成三角形是不变的
    let li = 0, fi = 0;
    for (const P of sheets) {
      const K = P.K;
      for (let j = 0; j < P.lines.length; j++) for (let k = 0; k < K - 1; k++) {
        const a = P.lineAt + j * K * 2 + k * 2;
        lineI[li++] = a; lineI[li++] = a + 1; lineI[li++] = a + 2; lineI[li++] = a + 1; lineI[li++] = a + 3; lineI[li++] = a + 2;
      }
      if (P.S.fill > 0) for (let k = 0; k < K - 1; k++) for (let c = 0; c < COLS - 1; c++) {
        const a = P.fillAt + k * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
        fillI[fi++] = a; fillI[fi++] = b; fillI[fi++] = d; fillI[fi++] = b; fillI[fi++] = e; fillI[fi++] = d;
      }
    }
  }
  const glows = LIGHTS.map((L, i) => i).filter(i => LIGHTS[i].glow > 0);
  const blobV = new Float32Array(glows.length * 4 * BLOB_STRIDE), blobI = new Uint32Array(glows.length * 6);
  glows.forEach((_, i) => blobI.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6));

  const rb = [0, 0, 0], col = [0, 0, 0], base = [0, 0, 0], tmp = [0, 0, 0], lz = new Float32Array(nL);
  const act = new Int32Array(nL), reachR = LIGHTS.map((L, i) => Math.sqrt(reach[i]));
  let nAct = 0, hx = 0, hy = 0, tg = 0, tinv = 0;
  // 某一点上各盏灯的合计：染色后的颜色写进 col，返回提亮倍数。只看这片纱够得着的灯
  function lit(x, y) {
    let r = base[0], g = base[1], b = base[2], boost = 1;
    for (let n = 0; n < nAct; n++) {
      const i = act[n], dx = x - lx[i], dy = y - ly[i], d2 = dx * dx + dy * dy;
      if (d2 > reach[i]) continue;
      const L = LIGHTS[i], w = Math.exp(-d2 * inv[i]), k = Math.min(1, w * L.tint);
      r += (L.color[0] - r) * k; g += (L.color[1] - g) * k; b += (L.color[2] - b) * k;
      boost += L.boost * w;
    }
    if (tg > 0) { const dx = x - hx, dy = y - hy, q = (dx * dx + dy * dy) * tinv; if (q < 6) boost += tg * Math.exp(-q); }
    col[0] = r; col[1] = g; col[2] = b;
    return boost;
  }

  /** view：{ scale, ox, oy }，姿态坐标 → 画布 CSS 像素。 */
  function update(view = {}, D = STILL) {
    const sc = view.scale ?? 1, ox = view.ox ?? 0, oy = view.oy ?? 0, warp = D.warp;
    const lineScale = Math.max(0.7, Math.sqrt(sc));
    // 景深：只有中间一段对得上焦，往两翼越远越虚
    const dl0 = DOF ? DOF.left[0] + D.dofL : 0, dl1 = DOF ? DOF.left[1] + D.dofL : 0, dr0 = DOF ? DOF.right[0] + D.dofR : 0, dr1 = DOF ? DOF.right[1] + D.dofR : 0;
    const fronts = D.focusX < 1e8, orb = D.orb || 0;
    // 背面：0 是正面，1 是正背面
    const back = z => orb * smooth(0.2, -0.75, z);
    // 球的边缘上丝叠得最密，会亮成一圈白边，压一压
    const limb = z => 1 - 0.54 * orb * (1 - Math.min(1, Math.abs(z) * 2.2));
    // 清晰度：平铺时看左右位置（两翼是虚的），卷成球时看前后（背面是虚的）
    const dof = (x, z) => ((1 - orb) * (DOF ? smooth(dl0, dl1, x) * (1 - smooth(dr0, dr1, x)) : 1) + orb * (1 - 0.9 * smooth(0.25, -0.6, z)))
      * D.focus * (fronts ? smooth(0, 1, (D.focusX - x) / 420) : 1);
    const revealing = D.revealX < 1e8, hiding = D.hideX > -1e8;
    const tri = d => Math.max(0, 1 - Math.abs(d) / 190);
    const reveal = x => (revealing ? smooth(-0.3, 0.7, (D.revealX - x) / 260) * (1 + D.sweep * tri(D.revealX - 110 - x)) : 1)
      * (hiding ? smooth(-0.2, 0.8, (x - D.hideX) / 220) * (1 + D.sweep * tri(x - D.hideX - 110)) : 1);
    const pulses = D.pulses, nP = pulses.length, billow = D.billow, wander = D.wander;
    if (D.touch && D.touch.g > 0.002) { hx = D.touch.x; hy = D.touch.y; tg = D.touch.g; tinv = 1 / (2 * D.touch.r * D.touch.r); } else tg = 0;

    for (let i = 0; i < nL; i++) {
      if (warp) { tmp[2] = 0; warp(LIGHTS[i].at[0], LIGHTS[i].at[1], tmp, LIGHTS[i].group || 0); lx[i] = tmp[0]; ly[i] = tmp[1]; lz[i] = tmp[2]; }
      else { lx[i] = LIGHTS[i].at[0]; ly[i] = LIGHTS[i].at[1]; lz[i] = 0; }
    }

    for (const P of sheets) {
      const { S, K, A0, B0, A, B, zA, zB, fade, focus, iri, veil, milk, thread, hem, dens, wide, px, py, vv } = P;
      const gate = (S.when ? (D.when[S.when] || 0) : 1) * D.alpha;
      let lv = P.lineAt * LINE_STRIDE, fv = P.fillAt * FILL_STRIDE;
      if (gate < 0.002) {
        if (!P.blank) { lineV.fill(0, lv, lv + P.lines.length * K * 2 * LINE_STRIDE); if (S.fill > 0) fillV.fill(0, fv, fv + K * COLS * FILL_STRIDE); P.blank = true; }
        continue;
      }
      P.blank = false;
      const pulse = P.pulse;
      let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (let k = 0; k < K; k++) {
        const i = k * 2;
        if (warp) {
          tmp[2] = 0;
          warp(A0[i], A0[i + 1], tmp, P.group); A[i] = tmp[0]; A[i + 1] = tmp[1]; zA[k] = tmp[2];
          warp(B0[i], B0[i + 1], tmp, P.group); B[i] = tmp[0]; B[i + 1] = tmp[1]; zB[k] = tmp[2];
        } else { A[i] = A0[i]; A[i + 1] = A0[i + 1]; B[i] = B0[i]; B[i + 1] = B0[i + 1]; zA[k] = zB[k] = 0; }
        // 流过全身的光：经过的地方亮起来，纱面也跟着鼓一下
        let e = 0;
        if (nP) {
          const mx = (A0[i] + B0[i]) * 0.5;
          for (let n = 0; n < nP; n++) { const p = pulses[n], d = (mx - (p.loop && P.group < 0 ? p.xl : p.x)) / p.w; if (d > -2.6 && d < 2.6) e += p.g * Math.exp(-d * d); }
        }
        pulse[k] = e;
        // 纱面的宽窄在起伏，像被水流托着的布；结点上宽度是零，所以结不会散
        if (billow || e) {
          const m = 0.5 * (billow * Math.sin(TAU * 1.6 * (k / (K - 1)) - D.billowPhase + P.phase) + 0.22 * e);
          const ex = (A[i] - B[i]) * m, ey = (A[i + 1] - B[i + 1]) * m;
          A[i] += ex; A[i + 1] += ey; B[i] -= ex; B[i + 1] -= ey;
        }
        const wx = A[i] - B[i], wy = A[i + 1] - B[i + 1];
        wide[k] = Math.sqrt(wx * wx + wy * wy);
        // 纱面越窄，同样多的丝挤得越密，也就越亮
        dens[k] = clamp(Math.sqrt(70 / (wide[k] + 8)), 0.8, 2.0);
        if (A[i] < x0) x0 = A[i]; if (A[i] > x1) x1 = A[i]; if (B[i] < x0) x0 = B[i]; if (B[i] > x1) x1 = B[i];
        if (A[i + 1] < y0) y0 = A[i + 1]; if (A[i + 1] > y1) y1 = A[i + 1]; if (B[i + 1] < y0) y0 = B[i + 1]; if (B[i + 1] > y1) y1 = B[i + 1];
      }
      nAct = 0;
      for (let i = 0; i < nL; i++) if (lx[i] > x0 - reachR[i] && lx[i] < x1 + reachR[i] && ly[i] > y0 - reachR[i] && ly[i] < y1 + reachR[i]) act[nAct++] = i;

      // 纱面：一层半透明的薄膜，不是光。压在深色上发亮，压在浅色上发暗
      if (S.fill > 0) {
        const film = S.fill * D.film * gate;
        for (let k = 0; k < K; k++) {
          const t = k / (K - 1), sd = Math.sqrt(dens[k]);
          for (let c = 0; c < COLS; c++) {
            const v = c / (COLS - 1);
            const x = A[k * 2] + (B[k * 2] - A[k * 2]) * v, y = A[k * 2 + 1] + (B[k * 2 + 1] - A[k * 2 + 1]) * v;
            const x0 = A0[k * 2] + (B0[k * 2] - A0[k * 2]) * v;
            if (S.film) { base[0] = S.film[0]; base[1] = S.film[1]; base[2] = S.film[2]; }
            else for (let i = 0; i < 3; i++) base[i] = FILM_DUSK[i] + (FILM_MILK[i] - FILM_DUSK[i]) * milk[k];
            const z = zA[k] + (zB[k] - zA[k]) * v;
            const boost = lit(x, y), lift = fade[k] * (0.8 + 0.2 * boost) * (1 + 0.45 * pulse[k]) * reveal(x) * (1 - 0.5 * back(z));
            fillV[fv++] = ox + x * sc; fillV[fv++] = oy + y * sc; fillV[fv++] = t; fillV[fv++] = v;
            fillV[fv++] = col[0]; fillV[fv++] = col[1]; fillV[fv++] = col[2];
            fillV[fv++] = Math.min(0.9, film * veil[k] * sd * lift);
            fillV[fv++] = iri[k]; fillV[fv++] = focus[k] * dof(x0, z); fillV[fv++] = wide[k] * sc;
            fillV[fv++] = (S.rimA || 0) * lift * gate * D.hem; fillV[fv++] = (S.rimB || 0) * lift * gate * D.hem;
          }
        }
      }

      // 细丝
      for (let j = 0; j < P.lines.length; j++) {
        const Ln = P.lines[j], Wd = P.wand[j];
        const gain = Ln.gain * gate * (Ln.edge ? D.hem : D.thread), half = Ln.half * lineScale;
        const wph = Ln.wp - D.flow * (0.6 + 0.8 * Ln.rnd), gph = D.glintPhase * (0.7 + 0.6 * Ln.rnd) + Ln.rnd3;
        const glint = Ln.glint ? D.glint : 0;
        // 里面的丝在纱面上横向游走，各走各的，纹理一直在重新织
        const wa = Ln.edge ? 0 : wander * 0.05 * Wd.a, wf = TAU * Wd.f, wq = Wd.p - D.flow * (0.5 + Wd.f);
        for (let k = 0; k < K; k++) {
          const t = k / (K - 1), e = t * t * (3 - 2 * t);
          let v = Ln.v0 + (Ln.v1 - Ln.v0) * e + Ln.weave * Math.sin(TAU * Ln.wf * t + wph);
          if (wa) v += wa * Math.sin(wf * t + wq);
          v = vv[k] = v < 0 ? 0 : v > 1 ? 1 : v;
          px[k] = A[k * 2] + (B[k * 2] - A[k * 2]) * v; py[k] = A[k * 2 + 1] + (B[k * 2 + 1] - A[k * 2 + 1]) * v;
        }
        const pk = Ln.edge ? 1 : 1.2;
        for (let k = 0; k < K; k++) {
          const t = k / (K - 1), v = vv[k];
          const k0 = k > 0 ? k - 1 : 0, k1 = k < K - 1 ? k + 1 : K - 1;
          let tx = px[k1] - px[k0], ty = py[k1] - py[k0];
          const tl = Math.sqrt(tx * tx + ty * ty) || 1; tx /= tl; ty /= tl;
          for (let i = 0; i < 3; i++) { const c = S.ca[i] + (S.cb[i] - S.ca[i]) * v; base[i] = c + (THREAD[i] - c) * Ln.tone; }
          const boost = lit(px[k], py[k]);
          let r = col[0], g = col[1], b = col[2];
          if (iri[k] > 0.01) {
            rainbow(rb, 0.58 + 0.3 * Math.sin(t * 9 + v * 3) + 0.3 * Math.abs(v * 2 - 1));
            const w = iri[k] * 0.5;
            r += (rb[0] - r) * w; g += (rb[1] - g) * w; b += (rb[2] - b) * w;
          }
          const z = zA[k] + (zB[k] - zA[k]) * v;
          let inten = gain * fade[k] * boost * (Ln.edge ? hem[k] : thread[k]) * (1 + pk * pulse[k]) * reveal(px[k]) * (1 - 0.6 * back(z)) * limb(z);
          if (glint > 0) { const d = (t - gph - Math.floor(t - gph) - 0.5) / 0.09, q = 1 - d * d; if (q > 0) inten *= 1 + glint * q * q; }
          const fk = focus[k] * dof(A0[k * 2] + (B0[k * 2] - A0[k * 2]) * v, z), X = ox + px[k] * sc, Y = oy + py[k] * sc;
          lineV[lv++] = X; lineV[lv++] = Y; lineV[lv++] = -ty; lineV[lv++] = tx; lineV[lv++] = -1; lineV[lv++] = half;
          lineV[lv++] = r; lineV[lv++] = g; lineV[lv++] = b; lineV[lv++] = inten; lineV[lv++] = fk;
          lineV[lv++] = X; lineV[lv++] = Y; lineV[lv++] = -ty; lineV[lv++] = tx; lineV[lv++] = 1; lineV[lv++] = half;
          lineV[lv++] = r; lineV[lv++] = g; lineV[lv++] = b; lineV[lv++] = inten; lineV[lv++] = fk;
        }
      }
    }

    // 结点柔光
    glows.forEach((li, i) => {
      const L = LIGHTS[li], s = L.size * 2.2, a = L.glow * D.glow * D.alpha * D.focus * reveal(lx[li]) * (1 - 0.75 * back(lz[li]));
      for (let q = 0; q < 4; q++) {
        const u = q & 1 ? 1 : -1, v = q & 2 ? 1 : -1, o = (i * 4 + q) * BLOB_STRIDE;
        blobV[o] = ox + (lx[li] + u * s) * sc; blobV[o + 1] = oy + (ly[li] + v * s) * sc; blobV[o + 2] = u; blobV[o + 3] = v;
        blobV[o + 4] = L.color[0]; blobV[o + 5] = L.color[1]; blobV[o + 6] = L.color[2]; blobV[o + 7] = a;
      }
    });
    const sh = D.shell;
    if (sh && sh.a > 0.004) { shell.x = ox + sh.x * sc; shell.y = oy + sh.y * sc; shell.r = sh.r * sc; shell.a = sh.a * D.alpha; for (let i = 0; i < 4; i++) shell.m[i] = sh.m[i]; }
    else shell.a = 0;
    return out;
  }

  const shell = { x: 0, y: 0, r: 0, a: 0, m: [1, 0, 0, 1] };
  const out = { line: { v: lineV, i: lineI }, fill: { v: fillV, i: fillI }, blob: { v: blobV, i: blobI }, shell };
  return { update, stats: { lineVerts: nLine, fillVerts: nFill } };
}
