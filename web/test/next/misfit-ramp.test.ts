/**
 * The heat map's colours: darker is worse in every theme, lightness falls evenly along the
 * ramp (perceptually uniform in OKLab L), the anchors are the theme's tokens, and the night
 * theme is red only. Also the chi-square scale and the caption.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MISFIT_CAPTION, misfitCaption } from '../../src/next/misfit/caption.js';
import {
  heatScale,
  MIN_SCALE_DELTA,
  misfitRamp,
  oklchToRgb,
  RAMP_LIGHTNESS,
  rampGradient,
  rgbToOklab,
  TOKEN_ANCHORS,
  type Rgb,
} from '../../src/next/misfit/ramp.js';
import type { ThemeName } from '../../src/next/theme/theme.js';

const THEMES: ThemeName[] = ['light', 'dark', 'night'];

const hue = (rgb: Rgb): number => {
  const [, a, b] = rgbToOklab(rgb);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
};

/** WCAG relative luminance: what a greyscale print or a colour-blind eye mostly keeps. */
const luminance = ([r, g, b]: Rgb): number => {
  const lin = (c: number): number => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

describe('the heat ramp', () => {
  for (const theme of THEMES) {
    it(`${theme}: darker is worse, and lightness falls evenly`, () => {
      const ramp = misfitRamp(theme);
      const [L0, L1] = RAMP_LIGHTNESS[theme];
      let prevL = Infinity;
      let prevY = Infinity;
      for (let k = 0; k <= 50; k++) {
        const t = k / 50;
        const rgb = ramp.rgb(t);
        const L = rgbToOklab(rgb)[0];
        // Uniform: the colour's own OKLab lightness is on the straight line (rounding to
        // 8-bit channels moves it by well under 0.01).
        expect(Math.abs(L - (L0 + (L1 - L0) * t))).toBeLessThan(0.008);
        expect(L).toBeLessThan(prevL);
        expect(luminance(rgb)).toBeLessThan(prevY);
        prevL = L;
        prevY = luminance(rgb);
      }
      // The lookup table is the same ramp.
      expect([...ramp.lut.slice(0, 3)]).toEqual([...ramp.rgb(0)]);
      expect([...ramp.lut.slice(255 * 4, 255 * 4 + 3)]).toEqual([...ramp.rgb(1)]);
      expect(ramp.lut[3]).toBe(255);
    });
  }

  it('night: every colour is pure red, black at the worst fit', () => {
    const ramp = misfitRamp('night');
    for (let k = 0; k < 256; k++) {
      expect(ramp.lut[4 * k + 1]).toBe(0);
      expect(ramp.lut[4 * k + 2]).toBe(0);
    }
    expect(ramp.rgb(1)[0]).toBeLessThan(15);
    expect(ramp.rgb(0)[0]).toBeGreaterThan(200);
    expect(ramp.css(0.5)).toMatch(/^rgb\(\d+, 0, 0\)$/);
  });

  it('light and dark run from the accent to the night shading, through green and teal', () => {
    for (const theme of ['light', 'dark'] as const) {
      const ramp = misfitRamp(theme);
      const accent = hue([0xf2, 0xb6, 0x3c]);
      expect(Math.abs(hue(ramp.rgb(0)) - accent)).toBeLessThan(15);
      const mid = hue(ramp.rgb(0.45));
      expect(mid).toBeGreaterThan(120);
      expect(mid).toBeLessThan(230);
    }
  });

  it('reads its anchors from the theme tokens (tokens.css)', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../src/next/theme/tokens.css'), 'utf8');
    const block = (selector: string): string => {
      const start = css.indexOf(selector);
      return css.slice(start, css.indexOf('}', start));
    };
    const value = (text: string, name: string): string => new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'i').exec(text)![1]!;
    const blocks: Record<ThemeName, string> = {
      light: block(":root[data-theme='light']"),
      dark: block(":root[data-theme='dark']"),
      night: block(":root[data-theme='night']"),
    };
    for (const theme of THEMES) {
      expect(TOKEN_ANCHORS[theme].good.toLowerCase()).toBe(value(blocks[theme], '--accent').toLowerCase());
      expect(TOKEN_ANCHORS[theme].bad.toLowerCase()).toBe(value(blocks[theme], '--map-shade').toLowerCase());
    }
    // Other anchors move the hue, never the lightness.
    const teal = misfitRamp('light', { good: '#40c0a0', bad: '#301050' });
    expect(Math.abs(rgbToOklab(teal.rgb(0.5))[0] - rgbToOklab(misfitRamp('light').rgb(0.5))[0])).toBeLessThan(0.01);
  });

  it('keeps colours inside sRGB by giving up chroma, not lightness', () => {
    const rgb = oklchToRgb(0.95, 0.4, 145); // far too saturated for sRGB at that lightness
    expect(rgb.every((c) => c >= 0 && c <= 255)).toBe(true);
    expect(rgbToOklab(rgb)[0]).toBeCloseTo(0.95, 2);
    expect(rampGradient(misfitRamp('dark'), 4).match(/rgb\(/g)).toHaveLength(5);
  });
});

describe('the chi-square scale', () => {
  it('runs from the best point to the largest value, logarithmically', () => {
    const chi2 = Float64Array.from([3, 5, 103, 1003]);
    const s = heatScale({ min: { chi2: 3 }, chi2 });
    expect(s.maxDelta).toBe(1000);
    expect(s.t(3)).toBe(0);
    expect(s.t(1003)).toBe(1);
    expect(s.t(2000)).toBe(1);
    expect(s.t(1)).toBe(0);
    expect(s.t(103)).toBeCloseTo(Math.log1p(100) / Math.log1p(1000), 12);
    expect(Number.isNaN(s.t(Number.NaN))).toBe(true);
    // A grid that is all within a few sigma does not get the whole ramp.
    const flat = heatScale({ min: { chi2: 0 }, chi2: Float64Array.from([0, 1, 2]) });
    expect(flat.maxDelta).toBe(MIN_SCALE_DELTA);
    expect(flat.t(5.99)).toBeLessThan(0.6);
    expect(heatScale({ min: { chi2: 0 }, chi2 }, 50).maxDelta).toBe(50);
  });
});

describe('the caption', () => {
  it('is the agreed sentence for the default drawing', () => {
    expect(misfitCaption()).toBe(MISFIT_CAPTION);
    expect(MISFIT_CAPTION).toBe(
      'Darker = worse fit. The inner line is where the fit is within the 95 % level of the best point, under the ' +
        'independent-noise model; shared errors (a biased sextant, a wrong clock) move the whole picture without widening it.',
    );
  });

  it('names the line by what else is drawn, and says what changes the picture', () => {
    const plain = { bias_profiled: false, weighted: false, min: { inside_grid: true } } as const;
    expect(misfitCaption(plain as never)).toBe(MISFIT_CAPTION);
    expect(misfitCaption(plain as never, { levels: ['p95'] })).toMatch(/^Darker = worse fit\. The line is where/);
    expect(misfitCaption(plain as never, { levels: ['one_sigma', 'p95', 'three_sigma'] })).toMatch(/The solid line \(dotted: 68 %, dashed: 99\.7 %\)/);
    const bias = misfitCaption({ ...plain, bias_profiled: true } as never);
    expect(bias).toMatch(/bias that suits it best/);
    expect(bias).toMatch(/a wrong clock still moves the whole picture/);
    expect(bias).not.toMatch(/a biased sextant, a wrong clock/);
    expect(misfitCaption({ ...plain, weighted: true } as never)).toMatch(/approximate\.$/);
    expect(misfitCaption({ ...plain, min: { inside_grid: false } } as never)).toMatch(/outside this view\.$/);
  });
});
