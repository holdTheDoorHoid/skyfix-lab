/**
 * Colours for the residual heat map: a perceptually uniform ramp per theme, and the scale
 * from chi-square to a position on it. OWNER: misfit agent. Pure functions (the browser
 * helper `themeRamp` reads the design tokens).
 *
 * "Darker = worse fit" in every theme. Lightness is OKLab L, linear in the ramp position,
 * so equal steps along the ramp look like equal steps of darkness whatever the hue does.
 * The hue runs from the theme's accent (`--accent`, the best fit) to its night shading
 * (`--map-shade`, the worst) the long way round, through green and teal, as viridis does;
 * chroma is only ever reduced to stay inside sRGB, never L. The night theme is red only:
 * every colour is pure red (green and blue exactly 0), black at the worst fit.
 */

import type { ThemeName } from '../theme/theme.js';

export type Rgb = readonly [number, number, number];

/** The two colours a ramp is anchored on: the best fit and the worst. */
export interface RampAnchors {
  good: string;
  bad: string;
}

/**
 * The token values of tokens.css (`--accent`, `--map-shade`), for use where no document is
 * available (tests, workers). `themeRamp` reads the live tokens instead.
 */
export const TOKEN_ANCHORS: Record<ThemeName, RampAnchors> = {
  light: { good: '#f2b63c', bad: '#0e1d3a' },
  dark: { good: '#f5bd48', bad: '#000510' },
  night: { good: '#ff3d00', bad: '#000000' },
};

/** OKLab lightness at the two ends, per theme. Night stays dim: at most 0.58 of pure red's 0.628. */
export const RAMP_LIGHTNESS: Record<ThemeName, readonly [number, number]> = {
  light: [0.965, 0.27],
  dark: [0.93, 0.2],
  night: [0.58, 0.07],
};

export interface HeatRamp {
  readonly theme: ThemeName;
  /** Colour at `t` in [0, 1] (0 = best fit), 0-255 per channel. */
  rgb(t: number): Rgb;
  /** The same as a CSS colour. */
  css(t: number): string;
  /** 256 RGBA entries (alpha 255), for filling image data fast. */
  readonly lut: Uint8ClampedArray;
  /** OKLab lightness at `t` (for tests and legends). */
  lightness(t: number): number;
}

// ---------------------------------------------------------------------------------------
// OKLab (Björn Ottosson, 2020)

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** sRGB (0-255) to OKLab [L, a, b]. */
export function rgbToOklab(rgb: Rgb): [number, number, number] {
  const [r, g, b] = rgb.map((c) => toLinear(c / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** OKLab to linear sRGB (may fall outside [0, 1]). */
function oklabToLinear(L: number, a: number, b: number): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

const inGamut = (c: [number, number, number]): boolean => c.every((v) => v >= -1e-7 && v <= 1 + 1e-7);

/** OKLCH to sRGB 0-255, reducing chroma (never lightness or hue) until it fits. */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  let lo = 0;
  let hi = Math.max(C, 0);
  let lin = oklabToLinear(L, hi * Math.cos(h), hi * Math.sin(h));
  if (!inGamut(lin)) {
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklabToLinear(L, mid * Math.cos(h), mid * Math.sin(h)))) lo = mid;
      else hi = mid;
    }
    lin = oklabToLinear(L, lo * Math.cos(h), lo * Math.sin(h));
  }
  return lin.map((v) => Math.round(255 * toGamma(Math.min(1, Math.max(0, v))))) as unknown as Rgb;
}

/** `#rrggbb` (or `#rgb`, `rgb()`) to 0-255 channels; null if it is not a colour. */
export function parseRgb(text: string): Rgb | null {
  const s = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = Number.parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  return fn ? [Number(fn[1]), Number(fn[2]), Number(fn[3])] : null;
}

function hueOf(rgb: Rgb): number {
  const [, a, b] = rgbToOklab(rgb);
  return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
}

// ---------------------------------------------------------------------------------------
// Ramps

/** Pure red with OKLab lightness `L` (L of pure red is proportional to cbrt of its linear value). */
function redWithLightness(L: number): Rgb {
  const full = rgbToOklab([255, 0, 0])[0];
  const linear = Math.min(1, Math.max(0, L / full) ** 3);
  return [Math.round(255 * toGamma(linear)), 0, 0];
}

function build(theme: ThemeName, colourAt: (t: number) => Rgb, lightness: (t: number) => number): HeatRamp {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let k = 0; k < 256; k++) {
    const [r, g, b] = colourAt(k / 255);
    lut.set([r, g, b, 255], 4 * k);
  }
  const clamp = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1);
  return {
    theme,
    lut,
    rgb: (t) => colourAt(clamp(t)),
    css: (t) => {
      const [r, g, b] = colourAt(clamp(t));
      return `rgb(${r}, ${g}, ${b})`;
    },
    lightness: (t) => lightness(clamp(t)),
  };
}

/**
 * The heat ramp of a theme, anchored on `anchors` (default: the token values of
 * tokens.css). `t` = 0 is the best fit (lightest), 1 the worst (darkest).
 */
export function misfitRamp(theme: ThemeName, anchors: RampAnchors = TOKEN_ANCHORS[theme]): HeatRamp {
  const [L0, L1] = RAMP_LIGHTNESS[theme];
  const L = (t: number): number => L0 + (L1 - L0) * t;
  if (theme === 'night') return build(theme, (t) => redWithLightness(L(t)), L);
  const good = parseRgb(anchors.good) ?? parseRgb(TOKEN_ANCHORS[theme].good)!;
  const bad = parseRgb(anchors.bad) ?? parseRgb(TOKEN_ANCHORS[theme].bad)!;
  const h0 = hueOf(good);
  // The long way round from the accent to the shade: gold, green, teal, blue.
  const dh = (((hueOf(bad) - h0) % 360) + 360) % 360;
  const colourAt = (t: number): Rgb => {
    const chroma = 0.07 + 0.06 * Math.sin(Math.PI * t) - 0.02 * t;
    return oklchToRgb(L(t), chroma, h0 + dh * t);
  };
  return build(theme, colourAt, L);
}

/** The ramp of the document's current theme, from its live tokens (browser only). */
export function themeRamp(doc: Document = document): HeatRamp {
  const root = doc.documentElement;
  const theme: ThemeName = root.dataset.theme === 'dark' || root.dataset.theme === 'night' ? root.dataset.theme : 'light';
  const style = getComputedStyle(root);
  const good = style.getPropertyValue('--accent').trim();
  const bad = style.getPropertyValue('--map-shade').trim();
  return misfitRamp(theme, {
    good: parseRgb(good) ? good : TOKEN_ANCHORS[theme].good,
    bad: parseRgb(bad) ? bad : TOKEN_ANCHORS[theme].bad,
  });
}

// ---------------------------------------------------------------------------------------
// Scale

export interface HeatScale {
  /** The chi-square of the best point (t = 0). */
  readonly min: number;
  /** The delta chi-square at t = 1 (and beyond). */
  readonly maxDelta: number;
  /** Ramp position of a chi-square value: log(1 + delta) / log(1 + maxDelta), in [0, 1]. */
  t(chi2: number): number;
}

/** Below this the whole picture would be within a few sigma, and a full ramp would overstate it. */
export const MIN_SCALE_DELTA = 30;

/**
 * The scale of a grid: logarithmic in delta chi-square (linear near the best point, where
 * the levels are, and compressing the far field, which can reach millions), from the best
 * point to the grid's largest value (at least `MIN_SCALE_DELTA`), unless `maxDelta` is given.
 */
export function heatScale(
  grid: { readonly min: { readonly chi2: number }; readonly chi2: ArrayLike<number> },
  maxDelta?: number,
): HeatScale {
  const min = grid.min.chi2;
  let top = maxDelta;
  if (top === undefined) {
    top = 0;
    for (let k = 0; k < grid.chi2.length; k++) {
      const d = grid.chi2[k]! - min;
      if (d > top && Number.isFinite(d)) top = d;
    }
  }
  const D = Math.max(MIN_SCALE_DELTA, top);
  const denom = Math.log1p(D);
  return {
    min,
    maxDelta: D,
    t: (chi2) => {
      if (Number.isNaN(chi2)) return Number.NaN;
      const d = Math.max(0, chi2 - min);
      return Math.min(1, Math.log1p(d) / denom);
    },
  };
}

/** A CSS linear gradient of the ramp (for a legend bar), best fit on the left. */
export function rampGradient(ramp: HeatRamp, steps = 12): string {
  const stops = Array.from({ length: steps + 1 }, (_, k) => `${ramp.css(k / steps)} ${((100 * k) / steps).toFixed(1)}%`);
  return `linear-gradient(to right, ${stops.join(', ')})`;
}
