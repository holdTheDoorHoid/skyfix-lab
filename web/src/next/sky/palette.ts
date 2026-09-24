/**
 * Every colour, dash and font the Sky view draws with, read from the design tokens
 * (`theme/tokens.css`, through `theme/tokens.ts`), and every colour it derives from them.
 * OWNER: sky agent. This is the ONE place the Sky view reads colour; the values live
 * only in tokens.css.
 *
 * The red night-vision theme draws in reds only: every colour this module hands out in
 * that theme — tokens, star tints, glows, mixes — goes through `nightRed`, which keeps
 * the blue channel at 0 and the green channel at most 12 % of the red (the rule
 * `theme-contrast.test.ts` holds the tokens to).
 */

import { parseColor, tokenValue } from '../theme/tokens.js';

export type SkyTheme = 'light' | 'dark' | 'night';

/** 0–255 channels. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export const BODY_KEYS = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'star',
] as const;
export type BodyKey = (typeof BODY_KEYS)[number];

export const PHASE_KEYS = ['day', 'civil', 'nautical', 'astronomical', 'night'] as const;
export type PhaseKey = (typeof PHASE_KEYS)[number];

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

export function scale(c: Rgb, k: number): Rgb {
  return { r: c.r * k, g: c.g * k, b: c.b * k };
}

/** WCAG relative luminance, 0–1. */
export function luminance(c: Rgb): number {
  const lin = (v: number): number => {
    const x = Math.min(255, Math.max(0, v)) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/**
 * Night vision: the same perceived brightness in red only (green 12 % of red, blue 0).
 * Colours that already obey the rule (the night tokens) keep their hue.
 */
export function nightRed(c: Rgb): Rgb {
  if (c.b <= 0 && c.g <= c.r * 0.31 && c.g <= 80) return { r: c.r, g: c.g, b: 0 };
  const y = Math.min(1, Math.max(0, (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255));
  const r = 255 * Math.min(1, y * 1.25);
  return { r, g: Math.min(80, r * 0.12), b: 0 };
}

export function css(c: Rgb, alpha = 1): string {
  const r = Math.round(Math.min(255, Math.max(0, c.r)));
  const g = Math.round(Math.min(255, Math.max(0, c.g)));
  const b = Math.round(Math.min(255, Math.max(0, c.b)));
  return alpha >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${Math.max(0, alpha).toFixed(3)})`;
}

// ---------------------------------------------------------------------------
// Star colour from B−V
// ---------------------------------------------------------------------------

/**
 * Effective temperature from B−V (Ballesteros 2012, EPL 97, 34008):
 * `T = 4600 K · (1 / (0.92 (B−V) + 1.7) + 1 / (0.92 (B−V) + 0.62))`, for B−V clamped to
 * [−0.4, 2.0].
 */
export function temperatureFromBv(bv: number): number {
  const x = Math.min(2.0, Math.max(-0.4, bv));
  return 4600 * (1 / (0.92 * x + 1.7) + 1 / (0.92 * x + 0.62));
}

/**
 * The sRGB colour (D65 white, brightest channel 255) of a black body at `kelvin`, from
 * the CIE 1931 chromaticity of the Planckian locus (Kim et al. 2002 cubic fits, 1667 K
 * to 25 000 K). The usual way planetarium software tints stars.
 */
export function blackbodyRgb(kelvin: number): Rgb {
  const t = Math.min(25_000, Math.max(1667, kelvin));
  const t2 = t * t;
  const t3 = t2 * t;
  const x =
    t <= 4000
      ? -0.2661239e9 / t3 - 0.2343589e6 / t2 + 0.8776956e3 / t + 0.17991
      : -3.0258469e9 / t3 + 2.1070379e6 / t2 + 0.2226347e3 / t + 0.24039;
  const x2 = x * x;
  const x3 = x2 * x;
  const y =
    t <= 2222
      ? -1.1063814 * x3 - 1.3481102 * x2 + 2.18555832 * x - 0.20219683
      : t <= 4000
        ? -0.9549476 * x3 - 1.37418593 * x2 + 2.09137015 * x - 0.16748867
        : 3.081758 * x3 - 5.8733867 * x2 + 3.75112997 * x - 0.37001483;
  // xyY (Y = 1) -> XYZ -> linear sRGB (IEC 61966-2-1).
  const X = x / y;
  const Z = (1 - x - y) / y;
  const r = Math.max(0, 3.2406 * X - 1.5372 - 0.4986 * Z);
  const g = Math.max(0, -0.9689 * X + 1.8758 + 0.0415 * Z);
  const b = Math.max(0, 0.0557 * X - 0.204 + 1.057 * Z);
  const m = Math.max(r, g, b) || 1;
  const enc = (v: number): number => {
    const c = v / m;
    return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  };
  return { r: enc(r), g: enc(g), b: enc(b) };
}

/** A star's display colour from B−V; `null` (neutral) for an unknown index. */
export function starRgbFromBv(bv: number): Rgb | null {
  return Number.isFinite(bv) ? blackbodyRgb(temperatureFromBv(bv)) : null;
}

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

export interface SkyPalette {
  theme: SkyTheme;
  fontUi: string;
  fontNum: string;
  body: Record<BodyKey, Rgb>;
  phase: Record<PhaseKey, Rgb>;
  /** Text on a dark sky, and on a light (day) sky. */
  inkOnDark: Rgb;
  inkOnLight: Rgb;
  /** The lit part of the drawn Moon (large areas). */
  moonDisc: Rgb;
  accent: Rgb;
  /** Focus ring on a dark sky, and on a light one. */
  focus: Rgb;
  stageFocus: Rgb;
  /** Warm twilight glow near the Sun. */
  glow: Rgb;
  /** The casing drawn under glyphs and body lines, with its opacity. */
  halo: Rgb;
  haloAlpha: number;
  stageBg: Rgb;
  stageInk: Rgb;
  stageInk2: Rgb;
  stageInk3: Rgb;
  stageLine: Rgb;
  stageLineStrong: Rgb;
  /** Canvas dash patterns (`setLineDash`), from the shared line styles. */
  dashPath: number[];
  dashBelow: number[];
  /** Applied to every derived colour: identity, or `nightRed` in the night theme. */
  filter(c: Rgb): Rgb;
}

/** Reads one custom property (default: the document's, through the design system). */
export type ReadVar = (name: string) => string;

export const documentReadVar: ReadVar = (name) => {
  try {
    return tokenValue(name);
  } catch {
    return '';
  }
};

/** The theme on the document (`data-theme`), or `fallback`. */
export function documentTheme(fallback: SkyTheme): SkyTheme {
  const t = globalThis.document?.documentElement?.dataset?.theme;
  return t === 'light' || t === 'dark' || t === 'night' ? t : fallback;
}

const FONT_UI = "'Inter Variable', Inter, system-ui, sans-serif";
const FONT_NUM = "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace";

function dashes(text: string): number[] {
  if (!text || text === 'none') return [];
  return text
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/**
 * Read the palette for `theme`. A token missing from the page (a stylesheet not loaded)
 * becomes a neutral grey — dim red in the night theme — rather than a guess at the
 * design's value, so a missing design system shows up at a glance.
 */
export function readPalette(theme: SkyTheme, readVar: ReadVar = documentReadVar): SkyPalette {
  const filter = theme === 'night' ? nightRed : (c: Rgb): Rgb => c;
  const missing: Rgb = theme === 'night' ? { r: 120, g: 10, b: 0 } : { r: 128, g: 128, b: 128 };
  const rgba = (name: string): [Rgb, number] => {
    const parsed = parseColor(readVar(name));
    if (!parsed) return [missing, 1];
    return [filter({ r: parsed[0], g: parsed[1], b: parsed[2] }), parsed[3]];
  };
  const color = (name: string): Rgb => rgba(name)[0];
  const body = Object.fromEntries(BODY_KEYS.map((k) => [k, color(`--body-${k}`)])) as Record<BodyKey, Rgb>;
  const phase = Object.fromEntries(PHASE_KEYS.map((k) => [k, color(`--phase-${k}`)])) as Record<PhaseKey, Rgb>;
  const [halo, haloAlpha] = rgba('--line-halo');
  return {
    theme,
    fontUi: readVar('--font-ui') || FONT_UI,
    fontNum: readVar('--font-num') || FONT_NUM,
    body,
    phase,
    inkOnDark: color('--phase-night-ink'),
    inkOnLight: color('--phase-day-ink'),
    moonDisc: color('--moon-disc'),
    accent: color('--accent'),
    focus: color('--focus'),
    stageFocus: color('--stage-focus'),
    glow: filter(mix(body.sun, color('--event-set'), 0.45)),
    halo,
    haloAlpha,
    stageBg: color('--stage-bg'),
    stageInk: color('--stage-ink'),
    stageInk2: color('--stage-ink-2'),
    stageInk3: color('--stage-ink-3'),
    stageLine: color('--stage-line'),
    stageLineStrong: color('--stage-line-strong'),
    dashPath: dashes(readVar('--dash-path')),
    dashBelow: dashes(readVar('--dash-below')),
    filter,
  };
}

// ---------------------------------------------------------------------------
// Sky colour from the Sun's altitude
// ---------------------------------------------------------------------------

export interface SkyColours {
  zenith: Rgb;
  horizon: Rgb;
  /** Ground below the horizon (panorama). */
  ground: Rgb;
  /** Warm light near the Sun's azimuth, and its strength 0–1. */
  glow: Rgb;
  glowAlpha: number;
  /** Text and line colour that reads on this sky. */
  ink: Rgb;
  /** True when the sky is light enough to need dark ink. */
  light: boolean;
}

/**
 * The sky's colours for the Sun's topocentric altitude (degrees), anchored on the
 * sky-phase tokens so the view matches the time bar: day blue, the civil and nautical
 * twilight gradients, then night (CONVENTIONS 13.4 bands). Linear in between.
 */
export function skyColours(sunAltDeg: number, p: SkyPalette): SkyColours {
  const P = p.phase;
  const black: Rgb = { r: 0, g: 0, b: 0 };
  const anchors: readonly (readonly [number, Rgb, Rgb])[] = [
    [-24, scale(P.night, 0.7), P.night],
    [-18, P.night, mix(P.astronomical, P.night, 0.45)],
    [-12, mix(P.astronomical, P.night, 0.45), mix(P.nautical, P.astronomical, 0.5)],
    [-6, mix(P.nautical, P.astronomical, 0.55), mix(P.civil, P.nautical, 0.35)],
    [-0.83, mix(P.civil, P.nautical, 0.55), mix(P.day, P.civil, 0.45)],
    [8, mix(P.day, P.nautical, 0.42), P.day],
  ];
  const h = Number.isFinite(sunAltDeg) ? sunAltDeg : -90;
  let zenith = anchors[0]![1];
  let horizon = anchors[0]![2];
  if (h >= anchors[anchors.length - 1]![0]) {
    zenith = anchors[anchors.length - 1]![1];
    horizon = anchors[anchors.length - 1]![2];
  } else {
    for (let i = 1; i < anchors.length; i += 1) {
      const [a1, z1, h1] = anchors[i]!;
      if (h <= a1) {
        const [a0, z0, h0] = anchors[i - 1]!;
        const t = h <= a0 ? 0 : (h - a0) / (a1 - a0);
        zenith = mix(z0, z1, t);
        horizon = mix(h0, h1, t);
        break;
      }
    }
  }
  // Glow: strongest with the Sun just below the horizon, gone by nautical dusk and
  // soon after sunrise.
  const glowAlpha =
    h > 12 ? 0 : h > -1 ? 0.5 * (1 - (h + 1) / 13) + 0.1 : h > -14 ? 0.6 * (1 - (-1 - h) / 13) : 0;
  const light = (luminance(zenith) + luminance(horizon)) / 2 > 0.3;
  return {
    zenith: p.filter(zenith),
    horizon: p.filter(horizon),
    ground: p.filter(mix(horizon, black, 0.78)),
    glow: p.glow,
    glowAlpha,
    ink: light ? p.inkOnLight : p.inkOnDark,
    light,
  };
}
