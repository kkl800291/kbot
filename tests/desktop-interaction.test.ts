import { afterEach, describe, expect, it, vi } from 'vitest';
import { installDesktop } from '../src/services/desktop';
import { command, listen } from '../src/services/runtime';

vi.mock('../src/services/runtime', () => ({ native: true, command: vi.fn(async () => false), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => {}) }) }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled: vi.fn(async () => false), enable: vi.fn(), disable: vi.fn() }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({ register: vi.fn(), unregister: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function setup() {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const pet = { classList: { toggle: vi.fn() }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 180 }) };
  vi.stubGlobal('document', { querySelector: (selector: string) => selector === '#pet' ? pet : null, querySelectorAll: () => [] });
  const callbacks = new Map<string, (event: any) => void>();
  vi.mocked(listen).mockImplementation(async (name, callback) => { callbacks.set(name, callback); return () => {}; });
  let init!: () => Promise<void>;
  const A: any = {
    S: { onboarding: true, hotkey: { code: 'Space' } }, on: vi.fn(), init: (fn: typeof init) => { init = fn; },
    panel: { isOpen: () => false }, robot: { shape: { regions: [] }, hitTest: () => true, lookAtPoint: vi.fn() },
    set: vi.fn(), petPointerActive: true, petPointerStartedAt: 10_000,
    cancelPetInteraction: vi.fn(() => { A.petPointerActive = false; }),
    updatePetHover: vi.fn(),
  };
  installDesktop(A); await init();
  const cursor = (sampledAt: number, buttonsDown = false) => callbacks.get('desktop-cursor')!({ payload: { x: 90, y: 90, sampledAt, buttonsDown } });
  return { A, cursor };
}

describe('native cursor gesture recovery', () => {
  it('does not cancel a new press with a delayed pre-press release sample', async () => {
    const { A, cursor } = await setup();
    vi.setSystemTime(15_000);
    cursor(9_990);
    cursor(10_050);
    cursor(14_000, true);
    expect(A.cancelPetInteraction).not.toHaveBeenCalled();
    expect(A.petPointerActive).toBe(true);
  });

  it('recovers a lost pointerup only from a release sampled after the current press', async () => {
    const { A, cursor } = await setup();
    cursor(10_101);
    expect(A.cancelPetInteraction).toHaveBeenCalledOnce();
    expect(A.petPointerActive).toBe(false);
  });

  it('updates quick-action hover from native samples without focusing or clicking', async () => {
    const { A, cursor } = await setup();
    A.petPointerActive = false;
    cursor(10_050);
    expect(A.updatePetHover).toHaveBeenCalledWith(90, 90);
    expect(command).not.toHaveBeenCalledWith('focus_companion');
    expect(A.cancelPetInteraction).not.toHaveBeenCalled();
  });
});
