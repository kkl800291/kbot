import { describe, expect, it } from 'vitest';
import * as POSE from '../src/ui/veil/pose.js';
import { createMesh } from '../src/ui/veil/mesh.js';
import { ACCENTS, createLife, STATES } from '../src/ui/veil/life.js';
import { PALETTES, withPalette } from '../src/ui/veil/palette.js';
import { MODE_STATE, orbFrame, REF } from '../src/ui/energy.js';
import { energyBox, energyMode, SUMMON } from '../src/ui/top-model.js';

const DT = 1 / 60;
const run = (life: any, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += DT) life.step(DT); };
/** 一个在场、已经落定的身体。 */
function settled(state = 'idle', opts: { reduced?: boolean } = {}) {
  const life: any = createLife();
  if (opts.reduced) life.setReduced(true);
  life.show(); life.snap(state);
  run(life, 1);
  return life;
}
/** 姿态里的一个点此刻在哪。 */
const at = (life: any, x = 700, y = 300) => { const out = [0, 0, 0]; life.dyn.warp(x, y, out, 1); return out; };
const finite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

describe('light orb · states', () => {
  it('stays a closed, finite orb in every resting state', () => {
    for (const name of Object.keys(STATES)) {
      const life = settled(name);
      run(life, 6);
      const sh = life.dyn.shell;
      expect(life.state, name).toBe(name);
      expect(sh.a, name).toBeGreaterThan(0.5);
      expect(Number.isFinite(sh.x + sh.y + sh.r), name).toBe(true);
      for (const [x, y] of [[300, 372], [765, 345], [1240, 450], [690, 205]]) {
        const p = at(life, x, y);
        expect(finite(p), name).toBe(true);
        // 球面上的点不会跑到玻璃泡外面太远
        expect(Math.hypot(p[0] - sh.x, p[1] - sh.y), name).toBeLessThan(sh.r * 1.15);
      }
    }
  });

  it('gives every mode the top bar can ask for a body state', () => {
    const modes = [
      energyMode('summon'), energyMode('summon', { chatMode: 'think' }), energyMode('chat', { chatMode: 'talk' }),
      energyMode('note', { note: { mode: 'remind' } }), energyMode('compact', { act: { kind: 'task' } }),
      energyMode('compact', { act: { kind: 'error' } }), energyMode('peek'), 'done',
    ];
    for (const m of modes) expect((STATES as Record<string, unknown>)[(MODE_STATE as Record<string, string>)[m]], m).toBeTruthy();
    // 召唤态平时是待命的样子，不是一直绷着在听
    expect(MODE_STATE.listen).toBe('idle');
  });

  it('turns steadily while thinking and stops turning to listen, without a jump', () => {
    const life = settled('think');
    const before = life.clock.spin;
    run(life, 2);
    expect(life.clock.spin - before).toBeCloseTo(STATES.think.spin * 2, 1);

    // 转了很多圈以后去听：每一帧都只挪一点点
    run(life, 40);
    life.setState('listen');
    let prev = at(life), worst = 0;
    for (let i = 0; i < 180; i++) {
      life.step(DT);
      const p = at(life);
      worst = Math.max(worst, Math.hypot(p[0] - prev[0], p[1] - prev[1]));
      prev = p;
    }
    expect(worst).toBeLessThan(12);
    expect(Math.abs(life.clock.spin)).toBeLessThan(0.05);
  });

  it('dims and reddens on errors, warms up for reminders, and returns to plain light', () => {
    const life = settled('error');
    run(life, 2);
    expect(life.dyn.gain).toBeLessThan(0.8);
    expect(life.dyn.tint[3]).toBeGreaterThan(0.4);
    expect(life.dyn.tint[0]).toBeGreaterThan(life.dyn.tint[1]);

    life.setState('remind');
    run(life, 2);
    expect(life.dyn.tint[3]).toBeGreaterThan(0.2);
    expect(life.dyn.tint[1]).toBeGreaterThan(life.dyn.tint[2]);   // 琥珀：绿比蓝多

    life.setState('idle');
    run(life, 2);
    expect(life.dyn.tint[3]).toBeLessThan(0.02);
    expect(life.dyn.gain).toBeCloseTo(1, 1);
  });

  it('pulses with speech while talking and knocks while reminding, but waits quietly while listening', () => {
    const count = (state: string) => {
      const life = settled(state);
      let seen = 0;
      for (let i = 0; i < 240; i++) { life.step(DT); seen = Math.max(seen, life.dyn.pulses.length); }
      return seen;
    };
    expect(count('talk')).toBeGreaterThan(1);
    expect(count('remind')).toBeGreaterThan(1);
    expect(count('listen')).toBe(0);
  });
});

describe('light orb · arriving and leaving', () => {
  it('fades in, settles, and is gone after leaving', () => {
    const life: any = createLife();
    life.arrive();
    expect(life.present).toBe(true);
    run(life, 0.3);
    expect(life.busy).toBe(true);
    run(life, 2);
    expect(life.busy).toBe(false);
    expect(life.S.alpha).toBe(1);
    expect(life.S.grow).toBe(1);

    life.depart('close');
    run(life, 1);
    expect(life.busy).toBe(false);
    expect(life.S.alpha).toBe(0);
    expect(life.present).toBe(false);
  });

  it('comes back from where it was when called again halfway out', () => {
    const life: any = createLife();
    life.arrive(); run(life, 2.2);
    life.depart('close'); run(life, 0.36);
    const mid = life.S.alpha;
    expect(mid).toBeGreaterThan(0.05);
    expect(mid).toBeLessThan(1);
    life.arrive(true);
    life.step(DT);
    expect(life.S.alpha).toBeGreaterThanOrEqual(mid - 0.01);
    run(life, 1);
    expect(life.S.alpha).toBe(1);
  });
});

describe('light orb · expressions and attention', () => {
  it('maps every expression tag the butler may use and ignores unknown ones', () => {
    const life = settled();
    for (const tag of ['happy', 'surprised', 'confused', 'sad', 'sleepy', 'annoyed', 'done']) expect(life.accent(tag), tag).toBe(true);
    for (const tag of ['angry', 'love', '', undefined]) expect(life.accent(tag), String(tag)).toBe(false);
    expect(Object.keys(ACCENTS).length).toBe(7);
  });

  it('brightens for happy, dims for sad, reddens for annoyed, and fades back', () => {
    const peak = (tag: string) => {
      const life = settled();
      life.accent(tag);
      let gain = [1, 1], shade = 0;
      for (let t = 0; t < ACCENTS[tag as keyof typeof ACCENTS].dur + 1; t += DT) {
        life.step(DT);
        gain = [Math.min(gain[0], life.dyn.gain), Math.max(gain[1], life.dyn.gain)];
        shade = Math.max(shade, life.dyn.tint[3]);
      }
      return { low: gain[0], high: gain[1], shade, end: life.dyn.gain, endShade: life.dyn.tint[3] };
    };
    const happy = peak('happy'), sad = peak('sad'), annoyed = peak('annoyed');
    expect(happy.high).toBeGreaterThan(1.15);
    expect(sad.low).toBeLessThan(0.8);
    expect(annoyed.shade).toBeGreaterThan(0.3);
    for (const r of [happy, sad, annoyed]) { expect(r.end).toBeCloseTo(1, 2); expect(r.endShade).toBeLessThan(0.01); }
  });

  it('glances at a nearby cursor only while idle', () => {
    const glance = (state: string, x: number, y: number) => {
      const a = settled(state), b = settled(state);
      b.attend(x, y);
      run(a, 2); run(b, 2);
      const pa = at(a), pb = at(b);
      return Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    };
    expect(glance('idle', 1000, 380)).toBeGreaterThan(1);
    expect(glance('idle', 1500, 900)).toBeLessThan(0.01);    // 离得远：不理会
    expect(glance('think', 1000, 380)).toBeLessThan(0.01);   // 思考时不分心
    expect(glance('listen', 1000, 380)).toBeLessThan(0.01);
  });

  it('keeps still with reduced motion: no pulses, no wobble, a much slower turn', () => {
    const calm = settled('idle', { reduced: true }), lively = settled('idle');
    const s0 = calm.clock.spin, l0 = lively.clock.spin;
    let pulses = 0;
    for (let i = 0; i < 600; i++) { calm.step(DT); lively.step(DT); pulses = Math.max(pulses, calm.dyn.pulses.length); }
    expect(pulses).toBe(0);
    expect(calm.dyn.shell.m).toEqual([expect.closeTo(Math.cos(STATES.idle.tilt), 5), expect.closeTo(-Math.sin(STATES.idle.tilt), 5), expect.closeTo(Math.sin(STATES.idle.tilt), 5), expect.closeTo(Math.cos(STATES.idle.tilt), 5)]);
    expect(Math.abs(calm.clock.spin - s0)).toBeLessThan(Math.abs(lively.clock.spin - l0) * 0.5);
    // 打字和表情仍然有回应，只是不弹不颤
    calm.poke(0.8);
    expect(calm.accent('happy')).toBe(true);
    expect(calm.dyn.pulses.length).toBe(0);
  });
});

describe('light orb · mesh, palettes and placement', () => {
  it('fills reusable, finite buffers, with far less work for small avatars', () => {
    const life = settled('think');
    const full = createMesh(POSE), lite = createMesh(POSE, { detail: 0.4 });
    const view = { scale: 0.7, ox: 100, oy: 20 };
    const a = full.update(view, life.dyn);
    run(life, 0.5);
    const b = full.update(view, life.dyn);
    expect(b.line.v).toBe(a.line.v);
    expect(b.fill.v).toBe(a.fill.v);
    for (const m of [b, lite.update(view, life.dyn)]) {
      expect(finite(m.line.v)).toBe(true);
      expect(finite(m.fill.v)).toBe(true);
      expect(finite(m.blob.v)).toBe(true);
    }
    expect(lite.stats.lineVerts).toBeLessThan(full.stats.lineVerts * 0.25);
    // 玻璃泡跟着画面的缩放和位移走
    const sh = life.dyn.shell;
    expect(b.shell.x).toBeCloseTo(view.ox + sh.x * view.scale, 3);
    expect(b.shell.r).toBeCloseTo(sh.r * view.scale, 3);
  });

  it('recolors only the warm knots per palette and falls back to the original for unknown names', () => {
    expect(PALETTES).toEqual(['molten', 'aurora', 'iri']);
    expect(withPalette(POSE, 'molten')).toBe(POSE);
    expect(withPalette(POSE, 'nope')).toBe(POSE);
    const aurora = withPalette(POSE, 'aurora');
    const warm = POSE.LIGHTS.findIndex(L => L.color[0] - L.color[2] > 0.4), cool = POSE.LIGHTS.findIndex(L => L.color[2] >= L.color[0]);
    expect(aurora.LIGHTS[warm].color).not.toEqual(POSE.LIGHTS[warm].color);
    expect(aurora.LIGHTS[warm].color[1]).toBeGreaterThan(aurora.LIGHTS[warm].color[0]);   // 青绿
    expect(aurora.LIGHTS[cool].color).toEqual(POSE.LIGHTS[cool].color);
    expect(aurora.SHEETS.length).toBe(POSE.SHEETS.length);
    expect(aurora.SHEETS[0].ca).toEqual(POSE.SHEETS[0].ca);
  });

  it('leads the summon space just above the input and fills an avatar box, staying inside both', () => {
    const content = { x: -50, y: 8, w: 1100, h: SUMMON.h };
    const big = energyBox('summon', content), orb = orbFrame(big);
    expect(orb.x).toBe(content.x + content.w / 2);
    expect(orb.r).toBeGreaterThan(150);
    // 球心就是布局用来把它摆到屏幕三分之一处的那个位置
    expect(orb.y - content.y).toBeCloseTo(SUMMON.orbY, 0);
    // 倾听时会凑近（变大、下沉）一点，仍然不压到输入框；字幕是从输入框的位置往下长的
    const listen = STATES.listen.size / STATES.idle.size;
    expect(orb.y + orb.r * listen + 14).toBeLessThan(content.y + SUMMON.inputY - 24);
    expect(orb.y - orb.r * listen).toBeGreaterThan(content.y);

    for (const state of ['chat', 'note', 'compact']) {
      const box = energyBox(state, { x: 0, y: 0, w: 440, h: 116 }), f = orbFrame(box);
      expect(f.x).toBe(box[0] + box[2] / 2);
      expect(f.y).toBe(box[1] + box[3] / 2);
      expect(f.r * 2).toBeLessThanOrEqual(box[2]);
      expect(f.r * 2).toBeGreaterThan(box[2] * 0.8);
    }
    expect(orbFrame([0, 0, 0, 0]).r).toBe(1);
    expect(REF.r).toBeGreaterThan(150);
  });
});
