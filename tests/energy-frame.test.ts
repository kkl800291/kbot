import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnergy } from '../src/ui/energy.js';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function setup(reduced = false) {
  vi.useFakeTimers();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const context = { setTransform: vi.fn(), clearRect: vi.fn() };
  const element = () => ({
    style: {}, hidden: false, width: 0, height: 0,
    setAttribute: vi.fn(), addEventListener: vi.fn(), append: vi.fn(), remove: vi.fn(),
    // Force the 2D fallback so placement is checked without a GPU or a DOM renderer.
    getContext: (kind: string) => kind === '2d' ? context : null,
  });
  vi.stubGlobal('document', { createElement: element });
  vi.stubGlobal('window', { devicePixelRatio: 1 });
  vi.stubGlobal('getComputedStyle', () => ({ position: 'fixed' }));
  vi.stubGlobal('ResizeObserver', undefined);
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  return createEnergy({
    clientWidth: 2048, clientHeight: 953, style: {}, append: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  }, { reduced });
}

describe('energy frame placement', () => {
  it('keeps a surface change animated and places a dragged avatar immediately', () => {
    const energy = setup();
    try {
      energy.setBox([620, 140, 360, 360]);
      energy.start();
      const before = energy.stats();

      energy.setBox([1200, 400, 40, 40]);
      expect(energy.stats()).toMatchObject({ x: before.x, y: before.y, R: before.R });

      energy.setBox([1240, 430, 40, 40], { immediate: true });
      expect(energy.stats()).toMatchObject({ x: 1260, y: 450, R: 18, running: true });
    } finally { energy.destroy(); }
  });

  it('places the avatar without flight when reduced motion is enabled', () => {
    const energy = setup(true);
    try {
      energy.setBox([620, 140, 360, 360]);
      energy.start();
      energy.setBox([1200, 400, 40, 40]);
      expect(energy.stats()).toMatchObject({ x: 1220, y: 420, R: 18, running: true });
    } finally { energy.destroy(); }
  });
});
