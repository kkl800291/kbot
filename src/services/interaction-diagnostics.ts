import { command, listen } from './runtime';

// Opt-in local diagnostics for native input failures. No text, keys, images,
// conversation contents, or credentials are recorded.
export async function installInteractionDiagnostics(A: any) {
  if (!await command<boolean>('interaction_trace_enabled')) return;
  const events: { type: string; target: string; tag: string; at: number; x?: number; y?: number }[] = [];
  let cursorEvents = 0, lastCursorAt = 0, failures = 0, writing = false;
  let lastCursor: unknown;
  await listen('desktop-cursor', ({ payload }) => { cursorEvents++; lastCursorAt = Date.now(); lastCursor = payload; });
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'lostpointercapture', 'click', 'focus', 'blur']) {
    window.addEventListener(type, event => {
      const element = event.target instanceof Element ? event.target : null;
      events.push({ type, target: element?.closest('[id]')?.id || '', tag: element?.tagName || '', at: Date.now(),
        ...(event instanceof MouseEvent ? { x: event.clientX, y: event.clientY } : {}) });
      if (events.length > 30) events.shift();
    }, true);
  }
  window.addEventListener('error', () => { failures++; });
  window.addEventListener('unhandledrejection', () => { failures++; });
  const report = () => {
    if (writing) return;
    const top = document.querySelector<HTMLElement>('#topContent')!, panel = document.querySelector<HTMLElement>('#panel')!;
    writing = true;
    command('write_interaction_trace', { snapshot: {
      cursorEvents, lastCursor, lastCursorAge: lastCursorAt ? Date.now() - lastCursorAt : null, failures, events,
      topState: A.top?.state?.(), topBounds: top.getBoundingClientRect().toJSON(), topPointerEvents: getComputedStyle(top).pointerEvents,
      panelOpen: A.panel.isOpen(), panelHidden: panel.hidden, panelInert: panel.inert,
      energy: A.energy?.stats?.(), appearance: A.energy?.sim?.S?.appearance, departure: A.energy?.sim?.S?.departure,
      blurBounds: document.querySelector('#halo')!.getBoundingClientRect().toJSON(),
      menuOpen: !!A.menu?.isOpen?.(),
      documentFocused: document.hasFocus(), documentVisible: !document.hidden,
    } }).catch(() => {}).finally(() => { writing = false; });
  };
  A.init(() => { report(); setInterval(report, 500); });
}
