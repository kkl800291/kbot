import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

// Exercise the real gesture handlers, including their capture/cancel cleanup.
function setup({ native = false, timers = false } = {}) {
  class Element extends EventTarget {
    style = { width: '180px', height: '192px', transform: '' };
    classes = new Set<string>();
    classList = {
      add: vi.fn((...tokens: string[]) => tokens.forEach(t => this.classes.add(t))),
      remove: vi.fn((...tokens: string[]) => tokens.forEach(t => this.classes.delete(t))),
      contains: (token: string) => this.classes.has(token),
      toggle: vi.fn((token: string, force?: boolean) => { const on = force ?? !this.classes.has(token); if (on) this.classes.add(token); else this.classes.delete(token); return on; }),
    };
    captured = false;
    setPointerCapture = vi.fn(() => { this.captured = true; });
    releasePointerCapture = vi.fn(() => { this.captured = false; });
    hasPointerCapture = vi.fn(() => this.captured);
    setAttribute = vi.fn();
    closest: any = () => null;
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 180, bottom: 192, width: 180, height: 192 }; }
  }
  const pet = new Element(), canvas = new Element(), quick = new Element();
  quick.getBoundingClientRect = () => ({ x: 190, y: 45, left: 190, top: 45, right: 278, bottom: 107, width: 88, height: 62 });
  const document: any = new EventTarget();
  document.elementFromPoint = () => null;
  let opened = false, now = 0;
  const panel = { toggle: vi.fn(() => { opened = !opened; }), isOpen: () => opened };
  const A: any = {
    $: (selector: string) => selector === '#pet' ? pet : selector === 'canvas' ? canvas : quick,
    clamp: (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi),
    S: {}, native, panel, emit: vi.fn(), on: vi.fn(), init: vi.fn(), save: vi.fn(), say: vi.fn(), menu: { close: vi.fn() },
    openSettings: vi.fn(), toast: vi.fn(), hm: () => '12:00', bubble: { hideSpeech: vi.fn() },
  };
  class Robot {
    static W = 180; static H = 192;
    box = { l: 26, r: 154, t: 14, b: 167, cy: 90 };
    canvas = canvas; pressed = false; held = false;
    press() { this.pressed = true; }
    release() { this.pressed = false; }
    setHeld(value: boolean) { this.held = value; }
    flash = vi.fn(); drop = vi.fn(); drag = vi.fn();
    hitTest(x: number, y: number) { return x >= 26 && x <= 154 && y >= 14 && y <= 167; }
    setBase = vi.fn();
  }
  const window = new EventTarget();
  Object.assign(window, { App: A });
  const source = readFileSync(new URL('../src/ui/pet.js', import.meta.url), 'utf8').replace(/\nexport \{\};\s*$/, '');
  runInNewContext(source, { window, document, Robot, performance: { now: () => now },
    addEventListener: window.addEventListener.bind(window), innerWidth: 1200, innerHeight: 800, Date,
    setInterval: () => 0, setTimeout: timers ? setTimeout : () => 0, clearTimeout: timers ? clearTimeout : () => {},
  });
  function pointer(type: string, x = 90, y = 90) {
    const event = new Event(type);
    Object.assign(event, { pointerId: 1, button: 0, clientX: x, clientY: y });
    pet.dispatchEvent(event);
  }
  function activate(detail = 1) {
    const event = new Event('click'); Object.assign(event, { detail }); pet.dispatchEvent(event);
  }
  const click = () => { now += 80; pointer('pointerdown'); pointer('pointerup'); pointer('lostpointercapture'); activate(); };
  return { A, panel, pointer, activate, click, window, document, quick, opened: () => opened };
}

describe('robot panel activation', () => {
  it('opens and closes on every click even within the old 450ms poke window', () => {
    const { click, opened, panel } = setup();
    for (let i = 1; i <= 12; i++) { click(); expect(opened()).toBe(i % 2 === 1); }
    expect(panel.toggle).toHaveBeenCalledTimes(12);
  });

  it('keeps rapid-click feedback from inserting speech while closing the panel', () => {
    const { A, click, opened } = setup();
    for (let i = 0; i < 8; i++) click();
    expect(opened()).toBe(false);
    expect(A.robot.flash).toHaveBeenCalled();
    expect(A.say).not.toHaveBeenCalled();
  });

  it('does not toggle after cancellation or dragging, and accepts the next click', () => {
    const { A, pointer, activate, click, panel, opened } = setup();
    pointer('pointerdown'); pointer('pointercancel');
    activate();
    pointer('pointerdown'); pointer('pointermove', 120, 110); pointer('pointerup', 120, 110);
    activate();
    expect(panel.toggle).not.toHaveBeenCalled();
    expect(A.petPointerActive).toBe(false); expect(A.robot.held).toBe(false);
    click(); expect(opened()).toBe(true);
  });

  it('waits for click before changing the panel or native focus', () => {
    const { pointer, activate, panel, opened } = setup();
    pointer('pointerdown'); pointer('pointerup'); pointer('lostpointercapture');
    expect(panel.toggle).not.toHaveBeenCalled();
    activate(); expect(opened()).toBe(true);
    activate(0); expect(opened()).toBe(false);
  });

  it('ignores a stale capture loss while the next click has capture', () => {
    const { A, pointer, activate, click, opened } = setup();
    click();
    pointer('pointerdown'); pointer('lostpointercapture');
    expect(A.petPointerActive).toBe(true);
    pointer('pointerup'); activate();
    expect(opened()).toBe(false);
    expect(A.petPointerActive).toBe(false);
  });
});

describe('unfocused native quick actions', () => {
  it('shows actions on OS hover after blur and leave without toggling chat', () => {
    vi.useFakeTimers();
    const { A, window, document, quick, panel } = setup({ native: true, timers: true });
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('pointerleave'));
    A.updatePetHover(90, 90);
    expect(quick.classList.contains('show')).toBe(true);
    expect(A.robot.hover).toBe(true);
    document.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(250);
    expect(quick.classList.contains('show')).toBe(true);
    expect(panel.toggle).not.toHaveBeenCalled();
    A.updatePetHover(500, 500);
    for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(33); A.updatePetHover(500, 500); }
    expect(quick.classList.contains('show')).toBe(false);
    A.updatePetHover(90, 90);
    expect(quick.classList.contains('show')).toBe(true);
  });

  it('keeps actions accessible across the gap and activates DND and settings without chat', () => {
    vi.useFakeTimers();
    const { A, quick, panel } = setup({ native: true, timers: true });
    A.updatePetHover(90, 90);
    A.updatePetHover(170, 70);
    vi.advanceTimersByTime(100);
    A.updatePetHover(200, 70);
    vi.advanceTimersByTime(500);
    expect(quick.classList.contains('show')).toBe(true);
    quick.closest = () => ({ dataset: { q: 'dnd' } });
    quick.dispatchEvent(new Event('click'));
    expect(A.isDnd()).toBe(true);
    quick.closest = () => ({ dataset: { q: 'settings' } });
    quick.dispatchEvent(new Event('click'));
    expect(A.openSettings).toHaveBeenCalledOnce();
    expect(panel.toggle).not.toHaveBeenCalled();
  });

  it('does not retain actions when an overlay covers the character', () => {
    vi.useFakeTimers();
    const { A, quick, document } = setup({ native: true, timers: true });
    A.updatePetHover(90, 90);
    document.elementFromPoint = () => ({ closest: () => ({ id: 'panel' }) });
    A.updatePetHover(90, 90);
    vi.advanceTimersByTime(250);
    expect(quick.classList.contains('show')).toBe(false);
  });
});
