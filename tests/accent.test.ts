import { describe, expect, it } from 'vitest';
import { UI_ACCENTS, uiAccent } from '../src/ui/accent.js';

const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]: number[]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WHITE = [255, 255, 255], INK = [28, 28, 30];
const PANEL = { light: [244, 244, 246], dark: [30, 30, 32] };

describe('ui accent', () => {
  it('picks a hand-tuned color per palette and appearance, falling back to molten', () => {
    expect(uiAccent('iri', false)).toEqual(UI_ACCENTS.iri.light);
    expect(uiAccent('aurora', true)).toEqual(UI_ACCENTS.aurora.dark);
    expect(uiAccent('blue', false)).toEqual(UI_ACCENTS.molten.light);
    uiAccent('molten', false)[0] = 0;
    expect(UI_ACCENTS.molten.light[0]).not.toBe(0);
  });

  it('keeps links and primary buttons at WCAG AA on both panels', () => {
    for (const name of Object.keys(UI_ACCENTS)) {
      const light = uiAccent(name, false), dark = uiAccent(name, true);
      expect(contrast(light, PANEL.light), `${name} link on light`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(light, WHITE), `${name} white on button`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark, PANEL.dark), `${name} link on dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(dark, INK), `${name} ink on button`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
