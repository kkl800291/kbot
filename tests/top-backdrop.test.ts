import { describe, expect, it } from 'vitest';
import { BAR_R, layout, PANEL_R, SUMMON, WIN } from '../src/ui/top-model.js';

const CASES: [string, Record<string, unknown>][] = [
  ['peek', {}], ['compact', { act: { kind: 'talk' } }], ['compact', { act: { kind: 'task' } }], ['note', {}],
  ['summon', {}], ['summon', { caption: 140 }], ['summon', { caption: 999 }],
  ['chat', {}], ['chat', { expanded: true }],
];

describe('top backdrop', () => {
  it('never reaches past the window, with or without a notch', () => {
    for (const safeTop of [0, 38, 74]) {
      for (const [state, opts] of CASES) {
        const { halo } = layout(state, { ...opts, safeTop });
        const where = `${state} ${JSON.stringify(opts)} safeTop=${safeTop}`;
        expect(halo.x, where).toBeGreaterThanOrEqual(0);
        expect(halo.y, where).toBeGreaterThanOrEqual(0);
        expect(halo.x + halo.w, where).toBeLessThanOrEqual(WIN.w);
        expect(halo.y + halo.h, where).toBeLessThanOrEqual(WIN.h);
        expect(halo.feather, where).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('is a crisp rounded plate exactly over the content for bars, notes and the chat window', () => {
    for (const [state, opts] of CASES.filter(([s]) => s !== 'summon')) {
      const { content, halo } = layout(state, { ...opts, safeTop: 32 });
      expect(halo).toEqual({ ...content, feather: 0, radius: state === 'chat' || state === 'note' ? PANEL_R : BAR_R });
    }
  });

  it('blurs the entire real desktop in standby regardless of caption height', () => {
    const bare = layout('summon', { safeTop: 32 }), said = layout('summon', { caption: 96, safeTop: 32 });
    expect(bare.halo).toMatchObject({ x: 0, y: 0, w: WIN.w, h: WIN.h, feather: 0, radius: 0, standby: true });
    expect(said.halo).toMatchObject({ x: 0, y: 0, w: WIN.w, h: WIN.h });
    expect(layout('summon', { caption: 999 }).halo).toMatchObject({ x: 0, y: 0, w: WIN.w, h: WIN.h });
  });

  it('collapses to nothing when hidden', () => {
    expect(layout('hidden').halo.h).toBe(0);
  });
});
