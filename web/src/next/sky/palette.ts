/**
 * Every colour and font the Sky view draws with, read from the design tokens (CSS custom
 * properties on `<html>`, EXPLORER_PLAN §4: `theme/tokens.css`), and every colour it
 * derives from them. OWNER: sky agent.
 *
 * This is the ONE place the Sky view reads colour. Until the design system is merged
 * into this branch the tokens may be missing, so each read has a per-theme fallback
 * close to the design agent's values; once `theme/tokens.ts` is here, `readVar` can be
 * swapped for its `tokenValue` without touching the renderer.
 *
 * The red night-vision theme draws in reds only: every colour this module hands out
 * in that theme — tokens, star tints, glows, mixes — goes through `nightRed`, which
 * keeps the blue channel at 0 and the green channel small.
 */

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

type TokenTable = Record<string, string>;

/**
 * Fallbacks per theme, used only when a token is not defined on the page. Values follow
 * the design agent's draft (`theme/tokens.css`) so the view looks the same before and
 * after the merge.
 */
const FALLBACK: Record<SkyTheme, TokenTable> = {
  light: {
    '--body-sun': '#f5b400',
    '--body-moon': '#a9bcd6',
    '--body-mercury': '#a7a7a7',
    '--body-venus': '#efdcb0',
    '--body-mars': '#d9683f',
    '--body-jupiter': '#d7a874',
    '--body-saturn': '#cebd7e',
    '--body-uranus': '#5cc2bf',
    '--body-neptune': '#6e93ee',
    '--body-star': '#ffffff',
    '--phase-night': '#0c1430',
    '--phase-astronomical': '#1c2b5c',
    '--phase-nautical': '#34528f',
    '--phase-civil': '#7ea2d8',
    '--phase-day': '#b3d8f4',
    '--phase-night-ink': '#c4d0ea',
    '--phase-day-ink': '#0d2138',
    '--accent': '#f2b63c',
    '--focus': '#ffd47e',
    '--event-set': '#ff6b5e',
    '--stage-bg': '#eef1f3',
    '--stage-ink': '#17202a',
    '--stage-ink-2': '#45525f',
    '--stage-line': '#d4dbe1',
    '--stage-line-strong': '#7c8894',
  },
  dark: {
    '--body-sun': '#f7b800',
    '--body-moon': '#b9cae0',
    '--body-mercury': '#ababab',
    '--body-venus': '#f1dfb4',
    '--body-mars': '#e0714a',
    '--body-jupiter': '#dbae7c',
    '--body-saturn': '#d3c386',
    '--body-uranus': '#62c7c4',
    '--body-neptune': '#7a9df2',
    '--body-star': '#ffffff',
    '--phase-night': '#0a1226',
    '--phase-astronomical': '#172748',
    '--phase-nautical': '#27416f',
    '--phase-civil': '#3e6298',
    '--phase-day': '#6594cb',
    '--phase-night-ink': '#aebfdc',
    '--phase-day-ink': '#06101f',
    '--accent': '#f5bd48',
    '--focus': '#ffd47e',
    '--event-set': '#ff7063',
    '--stage-bg': '#08111f',
    '--stage-ink': '#e9eff7',
    '--stage-ink-2': '#a9b9cd',
    '--stage-line': '#22334e',
    '--stage-line-strong': '#5d7294',
  },
  night: {
    '--body-sun': '#ff4a00',
    '--body-moon': '#f03600',
    '--body-mercury': '#c02000',
    '--body-venus': '#ff2400',
    '--body-mars': '#d01800',
    '--body-jupiter': '#e83000',
    '--body-saturn': '#d82a00',
    '--body-uranus': '#c82400',
    '--body-neptune': '#c01c00',
    '--body-star': '#ff3000',
    '--phase-night': '#000000',
    '--phase-astronomical': '#0e0100',
    '--phase-nautical': '#1a0200',
    '--phase-civil': '#2a0400',
    '--phase-day': '#3d0600',
    '--phase-night-ink': '#f21a00',
    '--phase-day-ink': '#ff3300',
    '--accent': '#ff3d00',
    '--focus': '#ff4400',
    '--event-set': '#bc1400',
    '--stage-bg': '#000000',
    '--stage-ink': '#ff2e00',
    '--stage-ink-2': '#f21a00',
    '--stage-line': '#2a0500',
    '--stage-line-strong': '#c01800',
  },
};

const FONT_FALLBACK = {
  ui: "'Inter Variable', Inter, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  num: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
};

// ---------------------------------------------------------------------------
// Colour arithmetic
// ---------------------------------------------------------------------------

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()` (alpha dropped); null otherwise. */
export function parseRgb(text: string): Rgb | null {
  const s = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = Number.parseInt(h.slice(0, 6), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(s);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]) };
  return null;
}

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
 * Night vision: the same perceived brightness in red only (green at most 16 % of red,
 * blue 0). Colours that are already red (the night tokens) keep their hue.
 */
export function nightRed(c: Rgb): Rgb {
  const y = Math.min(1, Math.max(0, (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255));
  const already = c.b === 0 && c.g <= c.r * 0.2;
  if (already) return { r: c.r, g: c.g, b: 0 };
  const r = 255 * Math.min(1, y * 1.25);
  return { r, g: r * 0.12, b: 0 };
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
  let r = 3.2406 * X - 1.5372 - 0.4986 * Z;
  let g = -0.9689 * X + 1.8758 + 0.0415 * Z;
  let b = 0.0557 * X - 0.204 + 1.057 * Z;
  r = Math.max(0, r);
  g = Math.max(0, g);
  b = Math.max(0, b);
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
  accent: Rgb;
  focus: Rgb;
  /** Warm twilight glow near the Sun. */
  glow: Rgb;
  stageBg: Rgb;
  stageInk: Rgb;
  stageInk2: Rgb;
  stageLine: Rgb;
  stageLineStrong: Rgb;
  /** Applied to every derived colour: identity, or `nightRed` in the night theme. */
  filter(c: Rgb): Rgb;
}

export type ReadVar = (name: string) => string;

/** Read a custom property from `<html>` (the design tokens live there). */
export function documentReadVar(root: Element | null = globalThis.document?.documentElement ?? null): ReadVar {
  if (!root || typeof getComputedStyle !== 'function') return () => '';
  const style = getComputedStyle(root);
  return (name) => style.getPropertyValue(name).trim();
}

/** The theme on the document (`data-theme`), or `fallback`. */
export function documentTheme(fallback: SkyTheme): SkyTheme {
  const t = globalThis.document?.documentElement?.dataset?.theme;
  return t === 'light' || t === 'dark' || t === 'night' ? t : fallback;
}

export function readPalette(theme: SkyTheme, readVar: ReadVar = () => ''): SkyPalette {
  const fallback = FALLBACK[theme];
  const filter = theme === 'night' ? nightRed : (c: Rgb): Rgb => c;
  const color = (name: string): Rgb => {
    const parsed = parseRgb(readVar(name)) ?? parseRgb(fallback[name] ?? '') ?? { r: 255, g: 0, b: 255 };
    return filter(parsed);
  };
  const body = Object.fromEntries(BODY_KEYS.map((k) => [k, color(`--body-${k}`)])) as Record<BodyKey, Rgb>;
  const phase = Object.fromEntries(PHASE_KEYS.map((k) => [k, color(`--phase-${k}`)])) as Record<PhaseKey, Rgb>;
  const font = (name: string, fb: string): string => readVar(name) || fb;
  return {
    theme,
    fontUi: font('--font-ui', FONT_FALLBACK.ui),
    fontNum: font('--font-num', FONT_FALLBACK.num),
    body,
    phase,
    inkOnDark: color('--phase-night-ink'),
    inkOnLight: color('--phase-day-ink'),
    accent: color('--accent'),
    focus: color('--focus'),
    glow: filter(mix(body.sun, color('--event-set'), 0.45)),
    stageBg: color('--stage-bg'),
    stageInk: color('--stage-ink'),
    stageInk2: color('--stage-ink-2'),
    stageLine: color('--stage-line'),
    stageLineStrong: color('--stage-line-strong'),
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
