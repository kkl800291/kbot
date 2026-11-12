import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelMorph } from '../src/ui/panel-morph.js';

afterEach(() => vi.unstubAllGlobals());

class AnimationTrack {
  currentTime = 0;
  playbackRate = 1;
  startTime: number | null = null;
  onfinish: (() => void) | null = null;
  cancel = vi.fn();
  pause = vi.fn();
  play = vi.fn();
  constructor(public frames: any[], public options: any) {}
  end() { this.currentTime = this.playbackRate > 0 ? this.options.duration : 0; this.onfinish?.(); }
}

class Element {
  hidden = true;
  inert = false;
  width = 360;
  height = 384;
  className = '';
  style = {};
  attributes = new Map<string, string>();
  tokens = new Set<string>();
  children: Element[] = [];
  parent: Element | null = null;
  get parentElement() { return this.parent; }
  tracks: AnimationTrack[] = [];
  classList = {
    add: (token: string) => this.tokens.add(token),
    remove: (token: string) => this.tokens.delete(token),
    contains: (token: string) => this.tokens.has(token),
    toggle: (token: string, on: boolean) => on ? this.tokens.add(token) : this.tokens.delete(token),
  };
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  append(child: Element) { child.parent = this; this.children.push(child); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  getContext() { return { drawImage: vi.fn() }; }
  getBoundingClientRect() { return { left: 800, top: 150, width: 360, height: 480 }; }
  querySelectorAll() { return this.children.filter(child => child.className !== 'panel-morph-image'); }
  querySelector() { const avatar = new Element(); avatar.getBoundingClientRect = () => ({ left: 814, top: 163, width: 26, height: 26 }); return avatar; }
  animate(frames: any[], options: any) { const track = new AnimationTrack(frames, options); this.tracks.push(track); return track; }
}

function setup({ reduced = false } = {}) {
  const panel = new Element(), pet = new Element(), canvas = new Element(), layerRoot = new Element(), stage = new Element();
  stage.append(pet); pet.append(canvas);
  panel.children = [new Element(), new Element(), new Element()];
  let hidden = false;
  vi.stubGlobal('document', { body: layerRoot, createElement: () => new Element(), timeline: { currentTime: 100 } });
  vi.stubGlobal('window', { devicePixelRatio: 2, matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  vi.stubGlobal('getComputedStyle', () => ({ borderRadius: '18px', backgroundColor: 'rgba(252,252,253,.97)', boxShadow: 'none' }));
  const onChange = vi.fn();
  const robot = { canvas, render: vi.fn(), docked: false };
  const motion = new PanelMorph({
    panel, pet, robot,
    body: () => ({ left: 1040, right: 1140, top: 643, bottom: 743 }),
    reduced: () => reduced, hidden: () => hidden, onChange,
  });
  const master = () => motion.master as unknown as AnimationTrack;
  return { motion, panel, pet, robot, stage, layerRoot, master, onChange, hide: () => { hidden = true; } };
}

describe('robot / panel morph lifecycle', () => {
  it('hands off to the original panel styles and keeps the robot out of focus while open', () => {
    const { motion, panel, pet, robot, stage, layerRoot, master, onChange } = setup();
    motion.set(true);
    expect(motion.isActive()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(pet.inert).toBe(true);
    expect(layerRoot.children).toHaveLength(0);
    expect(robot.canvas.parent).toBe(pet);
    expect(robot.docked).toBe(true);
    expect(robot.render).not.toHaveBeenCalled();
    expect(stage.classList.contains('panel-morphing')).toBe(true);
    master().end();
    expect(motion.isActive()).toBe(false);
    expect(panel.classList.contains('open')).toBe(true);
    expect(panel.classList.contains('morphing')).toBe(false);
    expect(panel.children).toHaveLength(3);
    expect(layerRoot.children).toHaveLength(0);
    expect(pet.classList.contains('panel-docked')).toBe(true);
    expect(stage.classList.contains('panel-morphing')).toBe(false);
    expect(robot.docked).toBe(true);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps the closing surface visible until it reaches the robot, then restores accessibility', () => {
    const { motion, panel, pet, robot, master } = setup();
    motion.set(true); master().end();
    motion.set(false);
    expect(panel.hidden).toBe(false);
    expect(master().playbackRate).toBe(-1);
    expect(master().currentTime).toBe(360);
    expect(robot.docked).toBe(true);
    const tracks = motion.animations as unknown as AnimationTrack[];
    expect(new Set(tracks.map(track => track.startTime))).toEqual(new Set([460]));
    // WebKit 清理动画层时，原尺寸的面板必须已经退出绘制树。
    for (const track of tracks) track.cancel.mockImplementation(() => { expect(panel.hidden).toBe(true); });
    master().end();
    expect(panel.hidden).toBe(true);
    expect(panel.classList.contains('morph-hidden')).toBe(true);
    expect(pet.inert).toBe(false);
    expect(pet.attributes.get('aria-hidden')).toBe('false');
    expect(pet.classList.contains('panel-docked')).toBe(false);
    expect(robot.docked).toBe(false);
    for (const track of tracks) expect(track.cancel).toHaveBeenCalledOnce();
    expect(panel.children).toHaveLength(3);
  });

  it('reverses interrupted gestures from the same frame and ignores an old completion', () => {
    const { motion, panel, master } = setup();
    motion.set(true);
    const opening = master(), staleCompletion = opening.onfinish!;
    opening.currentTime = 171;
    motion.set(false);
    expect(master()).toBe(opening);
    expect(master().currentTime).toBe(171);
    expect(master().playbackRate).toBe(-1);
    expect(motion.animations.every(track => track.currentTime === 171 && track.startTime === 271)).toBe(true);
    staleCompletion();
    expect(motion.isActive()).toBe(true);
    motion.set(true);
    expect(master()).toBe(opening);
    expect(master().currentTime).toBe(171);
    expect(master().playbackRate).toBe(1);
    opening.end();
    motion.set(false);
    staleCompletion();
    expect(motion.isActive()).toBe(true);
    expect(panel.hidden).toBe(false);
    master().end();
    expect(panel.hidden).toBe(true);
    expect(panel.classList.contains('morph-hidden')).toBe(true);
  });

  it('uses only short opacity fades for reduced motion', () => {
    const { motion, panel, master } = setup({ reduced: true });
    motion.set(true);
    expect(master().options.duration).toBe(130);
    expect(master().frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(panel.children).toHaveLength(3);
    master().end();
  });

  it('moves the original canvas and uses only transform/opacity without repainting panel shadows or radii', () => {
    const { motion, robot } = setup();
    motion.set(true);
    expect(robot.canvas.tracks).toHaveLength(1);
    for (const animation of motion.animations as unknown as AnimationTrack[]) {
      for (const frame of animation.frames) {
        expect(Object.keys(frame).every(key => ['transform', 'opacity', 'offset'].includes(key))).toBe(true);
      }
    }
  });

  it('finishes an immediate open/close pair without rewinding playback to the open endpoint', () => {
    const { motion, panel, master } = setup();
    motion.set(true);
    expect(master().currentTime).toBe(0);
    motion.set(false);
    expect(motion.isActive()).toBe(false);
    expect(panel.hidden).toBe(true);
    expect(panel.classList.contains('morph-hidden')).toBe(true);
  });

  it('immediately cancels transient layers when the whole companion is hidden', () => {
    const { motion, panel, pet, master, hide } = setup();
    motion.set(true);
    const running = master();
    hide(); motion.set(false);
    expect(motion.isActive()).toBe(false);
    expect(running.cancel).toHaveBeenCalledOnce();
    expect(panel.hidden).toBe(true);
    expect(panel.children).toHaveLength(3);
    expect(pet.inert).toBe(true);
    expect(pet.attributes.get('aria-hidden')).toBe('true');
  });
});
