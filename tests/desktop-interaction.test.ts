import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from '@tauri-apps/plugin-global-shortcut';
import { installDesktop } from '../src/services/desktop';
import { command, listen } from '../src/services/runtime';

vi.mock('../src/services/runtime', () => ({ native: true, command: vi.fn(async () => false), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ onFocusChanged: vi.fn(async () => {}) }) }));
vi.mock('@tauri-apps/plugin-autostart', () => ({ isEnabled: vi.fn(async () => false), enable: vi.fn(), disable: vi.fn() }));
vi.mock('@tauri-apps/plugin-global-shortcut', () => ({ register: vi.fn(), unregister: vi.fn() }));

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function setup() {
  vi.useFakeTimers();
  const overlays: any[] = [];
  vi.stubGlobal('document', { querySelector: () => null, querySelectorAll: () => overlays });
  const callbacks = new Map<string, (event: any) => void>();
  vi.mocked(listen).mockImplementation(async (name, callback) => { callbacks.set(name, callback); return () => {}; });
  let init!: () => Promise<void>;
  let content: any = null;
  const A: any = {
    S: { onboarding: true, hotkey: { code: 'Space', alt: true } }, on: vi.fn(), init: (fn: typeof init) => { init = fn; },
    panel: { isOpen: () => false, open: vi.fn() }, summon: { isOpen: () => false, open: vi.fn() }, set: vi.fn(),
    top: { cursor: vi.fn(), contentRect: () => content, relayout: vi.fn(), hotkey: vi.fn(), outside: vi.fn() },
  };
  installDesktop(A); await init();
  const regions = () => vi.mocked(command).mock.calls.filter(([name]) => name === 'set_regions').at(-1)?.[1] as any;
  return { A, callbacks, overlays, regions, setContent: (r: any) => { content = r; } };
}

describe('native top-edge interaction', () => {
  it('only the visible content area takes clicks; the feathered backdrop and hot zone pass through', async () => {
    const { A, regions, setContent, overlays } = await setup();
    await vi.advanceTimersByTimeAsync(100);
    expect(regions()).toMatchObject({ regions: [], interactive: false });

    setContent({ x: 360, y: 8, width: 280, height: 40 });
    await vi.advanceTimersByTimeAsync(100);
    expect(regions()).toMatchObject({ regions: [{ x: 360, y: 8, w: 280, h: 40, radius: 14 }], interactive: false });

    A.panel.isOpen = () => true;
    setContent({ x: 230, y: 8, width: 540, height: 440 });
    overlays.push({ getBoundingClientRect: () => ({ x: 600, y: 60, width: 220, height: 160 }) });
    await vi.advanceTimersByTimeAsync(100);
    expect(regions()).toMatchObject({
      regions: [{ x: 230, y: 8, w: 540, h: 440 }, { x: 600, y: 60, w: 220, h: 160, radius: 10 }],
      interactive: true,
    });

    A.hidden = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(regions().regions).toEqual([]);
  });

  it('treats the summoned agent as interactive and reports only its content area', async () => {
    const { A, regions, setContent } = await setup();
    A.summon.isOpen = () => true;
    setContent({ x: 260, y: 8, width: 480, height: 276 });
    await vi.advanceTimersByTimeAsync(100);
    expect(regions()).toMatchObject({ regions: [{ x: 260, y: 8, w: 480, h: 276, radius: 14 }], interactive: true });
  });

  it('keeps receiving pointer events throughout a panel drag and releases them at the new position', async () => {
    const { A, regions, setContent } = await setup();
    A.panel.isOpen = () => true;
    let dragging = false;
    A.panel.isDragging = () => dragging;
    const emit = (event: string) => A.on.mock.calls.filter(([name]: [string]) => name === event).forEach(([, fn]: [string, () => void]) => fn());
    setContent({ x: 230, y: 8, width: 540, height: 440 });
    await vi.advanceTimersByTimeAsync(100);
    dragging = true;
    emit('paneldrag');
    await vi.advanceTimersByTimeAsync(0);
    expect(regions()).toMatchObject({ dragging: true, interactive: true });
    setContent({ x: 650, y: 280, width: 540, height: 440 });
    emit('panelmove');
    await vi.advanceTimersByTimeAsync(0);
    expect(regions()).toMatchObject({ dragging: true, regions: [{ x: 650, y: 280, w: 540, h: 440 }] });
    dragging = false;
    emit('paneldrag');
    await vi.advanceTimersByTimeAsync(0);
    expect(regions()).toMatchObject({ dragging: false, regions: [{ x: 650, y: 280, w: 540, h: 440 }] });
  });

  it('keeps focus while summoned and gives it back once both summon and the window are closed', async () => {
    const { A } = await setup();
    A.summon.isOpen = () => true;
    A.releaseWindow();
    await vi.advanceTimersByTimeAsync(100);
    expect(command).not.toHaveBeenCalledWith('release_focus');
    A.summon.isOpen = () => false;
    A.releaseWindow();
    await vi.advanceTimersByTimeAsync(100);
    expect(command).toHaveBeenCalledWith('release_focus');
  });

  it('routes the global hotkey through the top edge, and the tray can summon or open the window', async () => {
    const { A, callbacks } = await setup();
    const onKey = vi.mocked(register).mock.calls.at(-1)![1] as (e: any) => void;
    onKey({ state: 'Released' });
    expect(A.top.hotkey).not.toHaveBeenCalled();
    onKey({ state: 'Pressed' });
    expect(A.top.hotkey).toHaveBeenCalledOnce();
    expect(A.panel.open).not.toHaveBeenCalled();
    await callbacks.get('desktop-action')!({ payload: 'summon' });
    expect(A.summon.open).toHaveBeenCalledOnce();
    expect(A.panel.open).not.toHaveBeenCalled();
    await callbacks.get('desktop-action')!({ payload: 'chat' });
    expect(A.panel.open).toHaveBeenCalledOnce();
    await callbacks.get('desktop-outside')!({});
    expect(A.top.outside).toHaveBeenCalledOnce();
  });

  it('forwards native cursor samples to the top edge without focusing the window', async () => {
    const { A, callbacks } = await setup();
    callbacks.get('desktop-cursor')!({ payload: { x: 500, y: 3, buttonsDown: false, sampledAt: 1 } });
    expect(A.top.cursor).toHaveBeenCalledWith(500, 3);
    expect(command).not.toHaveBeenCalledWith('focus_companion');
  });

  it('re-lays out the top edge when the display changes, and the tray can bring KBOT back', async () => {
    const { A, callbacks } = await setup();
    A.hidden = true;
    A.setHidden = vi.fn(() => { A.hidden = false; });
    await callbacks.get('desktop-action')!({ payload: 'relayout' });
    expect(A.top.relayout).toHaveBeenCalledOnce();
    expect(A.setHidden).not.toHaveBeenCalled();
    await callbacks.get('desktop-action')!({ payload: 'reposition' });
    expect(A.setHidden).toHaveBeenCalledWith(false);
    expect(A.top.relayout).toHaveBeenCalledTimes(2);
  });
});
