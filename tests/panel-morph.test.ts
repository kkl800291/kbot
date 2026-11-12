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
  const panel = new Element(), pet = new Element(), canvas = new Element(), layerRoot = new Element();
  panel.children = [new Element(), new Element(), new Element()];
  let hidden = false;
  vi.stubGlobal('document', { body: layerRoot, createElement: () => new Element(), timeline: { currentTime: 100 } });
  vi.stubGlobal('window', { devicePixelRatio: 2, matchMedia: () => ({ matches: false, addEventListener: vi.fn() }) });
  vi.stubGlobal('getComputedStyle', () => ({ borderRadius: '18px', backgroundColor: 'rgba(252,252,253,.97)', boxShadow: 'none' }));
  const onChange = vi.fn();
  const motion = new PanelMorph({
    panel, pet, robot: { canvas, render: vi.fn() },
    body: () => ({ left: 1040, right: 1140, top: 643, bottom: 743 }),
    reduced: () => reduced, hidden: () => hidden, onChange,
  });
  const master = () => motion.master as unknown as AnimationTrack;
  return { motion, panel, pet, layerRoot, master, onChange, hide: () => { hidden = true; } };
}

describe('robot / panel morph lifecycle', () => {
  it('hands off to the original panel styles and keeps the robot out of focus while open', () => {
    const { motion, panel, pet, layerRoot, master, onChange } = setup();
    motion.set(true);
    expect(motion.isActive()).toBe(true);
    expect(panel.hidden).toBe(false);
    expect(pet.inert).toBe(true);
    expect(layerRoot.children).toHaveLength(1);
    master().end();
    expect(motion.isActive()).toBe(false);
    expect(panel.classList.contains('open')).toBe(true);
    expect(panel.classList.contains('morphing')).toBe(false);
    expect(panel.children).toHaveLength(3);
    expect(layerRoot.children).toHaveLength(0);
    expect(pet.classList.contains('panel-docked')).toBe(true);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
  });

  it('keeps the closing surface visible until it reaches the robot, then restores accessibility', () => {
    const { motion, panel, pet, master } = setup();
    motion.set(true); master().end();
    motion.set(false);
    expect(panel.hidden).toBe(false);
    expect(master().playbackRate).toBe(-1);
    expect(master().currentTime).toBe(480);
    master().end();
    expect(panel.hidden).toBe(true);
    expect(pet.inert).toBe(false);
    expect(pet.attributes.get('aria-hidden')).toBe('false');
    expect(pet.classList.contains('panel-docked')).toBe(false);
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
  });

  it('uses only short opacity fades for reduced motion', () => {
    const { motion, panel, master } = setup({ reduced: true });
    motion.set(true);
    expect(master().options.duration).toBe(130);
    expect(master().frames).toEqual([{ opacity: 0 }, { opacity: 1 }]);
    expect(panel.children).toHaveLength(3);
    master().end();
  });

  it('finishes an immediate open/close pair without rewinding playback to the open endpoint', () => {
    const { motion, panel, master } = setup();
    motion.set(true);
    expect(master().currentTime).toBe(0);
    motion.set(false);
    expect(motion.isActive()).toBe(false);
    expect(panel.hidden).toBe(true);
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
