/* KBOT · 生命感：视线扫视、眨眼、说话口型，以及待机小动作和动作片段的调度。
   不碰画布，每帧只算出一组“这一刻该有的偏移”交给 Robot 去驱动弹簧和绘制 */
(function () {
  'use strict';
  const RB = window.RB, { clamp, lerp } = RB;

  const CH = ['sq', 'ox', 'oy', 'roll', 'yaw', 'pitch', 'ears', 'earL', 'earR', 'ant', 'pod', 'es', 'blush', 'open', 'smile', 'glint',
    'ga', 'gx', 'gy', 'close', 'cl', 'cr'];
  const SOFT = { sq: 1, ox: 1, oy: 1, roll: 1, yaw: 1, pitch: 1, ears: 1, earL: 1, earR: 1, ant: 1, pod: 1, es: 1 };
  const FIDGETS = [['curious', 3], ['lookAround', 3], ['sway', 2], ['stretch', 1], ['hop', 2], ['earWiggle', 2], ['glint', 3],
    ['shy', 1], ['winkBlink', 1.5], ['lookDown', 2], ['perk', 1.5]];

  const smooth = x => x * x * (3 - 2 * x);
  // 眨眼曲线：闭得快、睁得慢；hold 是闭着停留的比例（犯困时的慢眨眼）
  const blinkShape = (u, hold) => {
    const c = 0.36 * (1 - hold), o = c + hold;
    if (u < c) return smooth(u / c);
    if (u < o) return 1;
    return 1 - RB.easeOut((u - o) / (1 - o));
  };

  class Life {
    constructor(seed) {
      this.rnd = RB.rng(seed || 1);
      this.t = 0;
      this.gx = 0; this.gy = 0; this.wx = 0; this.wy = 0; this.nextGaze = 1; this.following = false;
      this.blinkAt = 1.6; this.blinkT = -1; this.blinkLen = 0.17; this.blinkHold = 0;
      this.clips = [];
      this.fidgetAt = 3.5; this.loopAt = 1e9; this.sleepAt = 6; this.lastFidget = '';
      this.speech = 0; this.sayAt = -9; this.open = 0; this.sylT = 0; this.sylV = 0; this.nodAt = -9;
      this.L = { ex: 0, ey: 0, closeL: 0, closeR: 0, speech: 0, busy: false };
      for (const k of CH) this.L[k] = 0;
    }

    // 同一段动作正在播放时从头再来，不叠加
    trigger(name, amp = 1) {
      const d = RB.CLIPS[name];
      if (!d) return;
      const c = this.clips.find(x => x.d === d);
      if (c) { c.t = 0; c.amp = amp; } else this.clips.push({ d, t: 0, amp });
    }

    speak() {
      this.speech = 1; this.sayAt = this.t;
      if (this.t - this.nodAt > 0.32) { this.nodAt = this.t; this.trigger('bob'); }
    }

    onState(prev, st, first) {
      const t = this.t;
      this.fidgetAt = t + 2.5 + this.rnd() * 3;
      this.loopAt = st.loop ? t + st.loop[1] : 1e9;
      this.sleepAt = t + 5 + this.rnd() * 4;
      if (first) return;
      const was = RB.STATES[prev] || {};
      const wasAsleep = was.sleeping || was.sleepy;
      if (wasAsleep && !(st.sleeping || st.sleepy)) this.trigger('wake', st.enter ? 0.6 : 1);
      if (st.enter) this.trigger(st.enter);
      if (st.held) this.trigger('lift');
    }

    fidget() {
      let sum = 0;
      for (const [n, w] of FIDGETS) if (n !== this.lastFidget) sum += w;
      let r = this.rnd() * sum, pick = FIDGETS[0][0];
      for (const [n, w] of FIDGETS) {
        if (n === this.lastFidget) continue;
        r -= w;
        if (r <= 0) { pick = n; break; }
      }
      this.lastFidget = pick;
      this.trigger(pick);
    }

    // 自己东张西望：一会儿回到正前方，一会儿往旁边瞥，偶尔抬头低头，或者看向鼠标最后出现的方向
    pickGaze(st, env) {
      const r = this.rnd(), rnd = this.rnd, k = st.gz ?? 1;
      let x, y;
      if (r < 0.36) { x = (rnd() - 0.5) * 0.35; y = (rnd() - 0.5) * 0.25; }
      else if (r < 0.68) { x = (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.4); y = (rnd() - 0.5) * 0.5; }
      else if (r < 0.84) { x = (rnd() - 0.5) * 0.6; y = (rnd() < 0.5 ? -1 : 1) * (0.45 + rnd() * 0.3); }
      else if (env.lastLook) { x = env.lastLook[0] * 0.8; y = env.lastLook[1] * 0.8; }
      else { x = 0; y = 0; }
      x *= k; y *= k;
      const far = Math.hypot(x - this.wx, y - this.wy);
      this.wx = x; this.wy = y;
      this.nextGaze = this.t + (0.6 + rnd() * 2.4) / Math.max(0.35, k);
      if (far > 0.7 && this.blinkT < 0 && rnd() < 0.5 && !st.sleeping) this.blinkAt = this.t + 0.05;
    }

    update(dt, env) {
      const t = (this.t += dt), L = this.L, st = env.st, rnd = this.rnd;
      const amp = env.reduced ? 0.3 : 1;
      for (const k of CH) L[k] = 0;

      for (let i = this.clips.length - 1; i >= 0; i--) {
        const c = this.clips[i], d = c.d;
        c.t += dt;
        const lt = Math.min(c.t, d.dur);
        if (d.fn) d.fn(lt, L, amp * c.amp);
        else for (const k in d.ch) L[k] += d.ch[k](lt) * (SOFT[k] ? amp : 1) * c.amp;
        if (c.t >= d.dur) this.clips.splice(i, 1);
      }

      if (st.loop && t >= this.loopAt) { this.trigger(st.loop[0]); this.loopAt = t + st.loop[1]; }
      if (st.idle && !this.clips.length && t >= this.fidgetAt) {
        if (env.reduced) this.trigger('glint'); else this.fidget();
        this.fidgetAt = t + 4 + rnd() * 6;
      }
      if (st.sleepy && !this.clips.length && t >= this.sleepAt) {
        this.trigger(rnd() < 0.3 ? 'yawn' : 'nodOff');
        this.sleepAt = t + 7 + rnd() * 5;
      }

      // 视线：状态指定 > 跟着鼠标 > 自己东张西望。眼睛很快，头慢半拍
      let tx, ty, rate = 22;
      if (st.look) { tx = st.look[0]; ty = st.look[1]; rate = 16; }
      else if (env.look) { tx = env.look[0]; ty = env.look[1]; rate = 14; this.following = true; }
      else {
        if (this.following) { this.following = false; this.nextGaze = t + 0.5 + rnd(); }
        if (t >= this.nextGaze) this.pickGaze(st, env);
        tx = this.wx; ty = this.wy;
      }
      const ga = clamp(L.ga, 0, 1);
      if (ga > 0) { tx = lerp(tx, L.gx, ga); ty = lerp(ty, L.gy, ga); }
      const f = 1 - Math.exp(-rate * dt);
      this.gx += (tx - this.gx) * f; this.gy += (ty - this.gy) * f;
      const jit = env.reduced ? 0 : 0.03;
      L.ex = clamp(this.gx + jit * RB.noise(t * 1.9, 1.3), -1.05, 1.05);
      L.ey = clamp(this.gy + jit * RB.noise(t * 1.6, 4.1), -1.05, 1.05);
      L.yaw += tx * 0.5 * amp; L.pitch += ty * 0.42 * amp;
      if (env.look) L.roll += tx * 2.5 * amp;

      // 眨眼
      if (this.blinkT < 0 && !st.sleeping && !st.held && t >= this.blinkAt) {
        this.blinkT = 0; this.blinkLen = st.sleepy ? 0.55 : 0.17; this.blinkHold = st.sleepy ? 0.35 : 0;
      }
      let blink = 0;
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const u = this.blinkT / this.blinkLen;
        if (u >= 1) {
          this.blinkT = -1;
          this.blinkAt = t + (rnd() < 0.18 && !st.sleepy ? 0.14 : (st.sleepy ? 1.5 + rnd() * 2 : 2 + rnd() * 3.8));
        } else blink = blinkShape(u, this.blinkHold);
      }
      L.closeL = clamp(Math.max(blink, L.close, L.cl), 0, 1);
      L.closeR = clamp(Math.max(blink, L.close, L.cr), 0, 1);

      // 说话口型：每个音节随机一个张口幅度，嘴跟着快速开合
      this.speech = Math.max(0, this.speech - dt * 3.2);
      if (st.talk && t - this.sayAt > 0.26) this.speech = Math.max(this.speech, 0.55 + 0.45 * Math.abs(Math.sin(t * 9)));
      let want = 0;
      if (this.speech > 0.05) {
        this.sylT -= dt;
        if (this.sylT <= 0) { this.sylV = 0.3 + 0.7 * rnd(); this.sylT = 0.09 + 0.1 * rnd(); }
        want = this.sylV * Math.min(1, this.speech * 1.4);
      }
      this.open += (want - this.open) * (1 - Math.exp(-30 * dt));
      L.open = clamp(L.open + this.open, 0, 1);
      L.speech = this.speech;
      const flutter = this.speech * 4 * Math.sin(t * 15) * amp;
      L.earL += flutter; L.earR -= flutter;

      if (env.near) { L.es += env.near * 0.05 * amp; L.ears += env.near * 6 * amp; }
      if (env.held) {
        L.roll += Math.sin(t * 5.5) * 6 * amp; L.pod += Math.sin(t * 5.5 + 1.2) * 9 * amp;
        L.earL += Math.sin(t * 9) * 9 * amp; L.earR += Math.sin(t * 9 + 1.5) * 9 * amp;
      }

      L.busy = this.clips.length > 0 || this.blinkT >= 0 || this.speech > 0.02 || this.open > 0.02 ||
        Math.abs(tx - this.gx) + Math.abs(ty - this.gy) > 0.01;
      return L;
    }
  }

  RB.Life = Life;
})();

export {};
