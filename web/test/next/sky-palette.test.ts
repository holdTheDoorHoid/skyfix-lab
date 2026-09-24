/**
 * The Sky view's colours (src/next/sky/palette.ts), read from the real design tokens:
 * star tints from B−V, the sky's colour through the twilights, and the night theme's
 * promise — nothing the sky draws emits blue light, and green stays low (the rule
 * theme-contrast.test.ts holds the tokens to).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BODY_KEYS,
  blackbodyRgb,
  contrast,
  luminance,
  mix,
  nightRed,
  PHASE_KEYS,
  readPalette,
  skyColours,
  starRgbFromBv,
  temperatureFromBv,
  type Rgb,
  type SkyTheme,
} from '../../src/next/sky/palette.js';

const CSS = readFileSync(resolve(import.meta.dirname, '../../src/next/theme/tokens.css'), 'utf8');

/** The custom properties of a theme, as the browser would resolve them on <html>. */
function tokensFor(theme: SkyTheme): Map<string, string> {
  const shared = new Map<string, string>();
  const own = new Map<string, string>();
  const text = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const selector = m[1]!.trim();
    const t = /data-theme='(\w+)'/.exec(selector)?.[1] ?? (selector.startsWith(':root') ? 'shared' : null);
    const target = t === 'shared' ? shared : t === theme ? own : null;
    if (!target) continue;
    for (const d of m[2]!.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) target.set(d[1]!, d[2]!.trim().replace(/\s+/g, ' '));
  }
  return new Map([...shared, ...own]);
}

const readVarFor = (theme: SkyTheme) => {
  const tokens = tokensFor(theme);
  return (name: string): string => tokens.get(name) ?? '';
};

const nightSafe = (c: Rgb): boolean => {
  const r = Math.round(c.r);
  const g = Math.round(c.g);
  const b = Math.round(c.b);
  return b === 0 && g <= 0x50 && g <= r;
};

describe('star colours from B−V', () => {
  it('uses the Ballesteros temperature', () => {
    expect(temperatureFromBv(0.65)).toBeCloseTo(5779, -1); // the Sun
    expect(temperatureFromBv(-0.4)).toBeGreaterThan(20_000);
    expect(temperatureFromBv(2.0)).toBeLessThan(3200);
  });

  it('tints hot stars blue, cool stars orange, and the Sun nearly white', () => {
    const hot = starRgbFromBv(-0.3)!;
    const cool = starRgbFromBv(1.6)!;
    const sun = starRgbFromBv(0.65)!;
    expect(hot.b).toBeGreaterThan(hot.r);
    expect(cool.r).toBeGreaterThan(cool.b + 60);
    expect(Math.min(sun.r, sun.g, sun.b)).toBeGreaterThan(200);
    // Brightest channel is full scale, all channels in range.
    for (const t of [1800, 3000, 5800, 10_000, 25_000]) {
      const c = blackbodyRgb(t);
      expect(Math.max(c.r, c.g, c.b)).toBeCloseTo(255, 6);
      for (const v of [c.r, c.g, c.b]) expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  it('gives an unknown colour index no tint (neutral)', () => {
    expect(starRgbFromBv(Number.NaN)).toBeNull();
  });
});

describe('palette from the design tokens', () => {
  for (const theme of ['light', 'dark', 'night'] as const) {
    it(`${theme}: every token the sky uses is defined`, () => {
      const read = readVarFor(theme);
      const names = [
        ...BODY_KEYS.map((k) => `--body-${k}`),
        ...PHASE_KEYS.map((k) => `--phase-${k}`),
        '--phase-night-ink',
        '--phase-day-ink',
        '--moon-disc',
        '--accent',
        '--focus',
        '--stage-focus',
        '--event-set',
        '--line-halo',
        '--stage-bg',
        '--stage-ink',
        '--stage-ink-2',
        '--stage-ink-3',
        '--stage-line',
        '--stage-line-strong',
        '--font-ui',
        '--font-num',
        '--dash-path',
        '--dash-below',
      ];
      expect(names.filter((n) => !read(n))).toEqual([]);
      const p = readPalette(theme, read);
      expect(p.body.sun).not.toEqual({ r: 128, g: 128, b: 128 });
      expect(p.dashBelow.length).toBeGreaterThan(0);
    });
  }

  it('shows a missing design system at a glance instead of guessing', () => {
    const p = readPalette('light', () => '');
    expect(p.body.venus).toEqual({ r: 128, g: 128, b: 128 });
    expect(p.fontUi).toMatch(/Inter/);
  });
});

describe('night vision: red only', () => {
  const p = readPalette('night', readVarFor('night'));

  it('the night tokens pass through unchanged', () => {
    for (const k of BODY_KEYS) expect(nightSafe(p.body[k])).toBe(true);
    expect(nightSafe(p.moonDisc)).toBe(true);
    expect(nightSafe(p.accent)).toBe(true);
  });

  it('every derived colour is red only: sky, ground, glow, ink, through day and night', () => {
    for (let h = -30; h <= 40; h += 0.5) {
      const c = skyColours(h, p);
      for (const col of [c.zenith, c.horizon, c.ground, c.glow, c.ink]) expect(nightSafe(col)).toBe(true);
      // Mixes the renderer makes (the Moon's dark side, halos, glows).
      expect(nightSafe(p.filter(mix(c.horizon, { r: 255, g: 255, b: 255 }, 0.65)))).toBe(true);
    }
  });

  it('turns any colour, even white and blue, into red of the same brightness order', () => {
    const white = nightRed({ r: 255, g: 255, b: 255 });
    const blue = nightRed({ r: 40, g: 80, b: 255 });
    expect(nightSafe(white) && nightSafe(blue)).toBe(true);
    expect(white.r).toBeGreaterThan(blue.r);
    for (let bv = -0.4; bv <= 2.0; bv += 0.1) expect(nightSafe(nightRed(starRgbFromBv(bv)!))).toBe(true);
  });
});

describe('sky colour through the day', () => {
  for (const theme of ['light', 'dark', 'night'] as const) {
    it(`${theme}: darkens monotonically as the Sun sinks, light only by day`, () => {
      const p = readPalette(theme, readVarFor(theme));
      let last = Infinity;
      for (let h = 20; h >= -30; h -= 1) {
        const c = skyColours(h, p);
        const l = luminance(c.zenith) + luminance(c.horizon);
        expect(l).toBeLessThanOrEqual(last + 1e-12);
        last = l;
        // The horizon is never darker than the zenith (twilight glows low).
        expect(luminance(c.horizon)).toBeGreaterThanOrEqual(luminance(c.zenith) - 1e-12);
      }
      expect(skyColours(-30, p).light).toBe(false);
      if (theme !== 'night') expect(skyColours(30, p).light).toBe(true);
      // Whatever the Sun's height, the ink chosen reads on the sky: at least 3:1
      // against the colour halfway up (large labels and lines, WCAG 1.4.11).
      for (let h = -30; h <= 40; h += 1) {
        const c = skyColours(h, p);
        expect(contrast(c.ink, mix(c.zenith, c.horizon, 0.5))).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it('glows most with the Sun just below the horizon, not at all at night or high noon', () => {
    const p = readPalette('light', readVarFor('light'));
    expect(skyColours(-2, p).glowAlpha).toBeGreaterThan(skyColours(-10, p).glowAlpha);
    expect(skyColours(-20, p).glowAlpha).toBe(0);
    expect(skyColours(40, p).glowAlpha).toBe(0);
  });
});
