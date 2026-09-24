/**
 * THE ONE PLACE THE MAP READS THE THEME. OWNER: map agent.
 *
 * The map draws with WebGL (MapLibre) and SVG, so it needs the design tokens as values, not
 * as `var(--…)`. Every colour, dash and shade the map uses is read here from the CSS custom
 * properties on `<html data-theme="light|dark|night">` (the design system's tokens.css),
 * with per-theme fallbacks for any token that is not defined. The rest of `map/` never names
 * a literal colour: MapLibre paint comes from `readTokens()`, and the DOM parts (dial,
 * controls) use `--sfm-*` properties that `applyCssTokens` writes onto the map's root.
 *
 * AFTER THE DESIGN SYSTEM MERGES (web/src/next/theme/): replace the bodies of `tokenValue`,
 * `parseColor`, `currentTheme` and `onThemeChange` with the ones exported from
 * `../theme/tokens.js` and `../theme/theme.js`, and delete FALLBACKS. Nothing else changes.
 */

import type { BodyKind } from '../engine/types.js';

export type ThemeName = 'light' | 'dark' | 'night';

/**
 * Values used only when a token is missing (the design system not loaded). They follow the
 * design agent's draft tokens.css of 2026-09-24 so the look does not jump at the merge.
 * Night: blue channel 0 everywhere, green kept low (EXPLORER_PLAN: red night vision).
 */
const FALLBACKS: Record<ThemeName, Readonly<Record<string, string>>> = {
  light: {
    '--map-water': '#c9dce6',
    '--map-land': '#f6f3ec',
    '--map-coast': '#9bb1bf',
    '--map-border': '#c3c9cd',
    '--map-graticule': 'rgba(58, 84, 108, 0.2)',
    '--map-shade': '#0e1d3a',
    '--shade-civil': '0.1',
    '--shade-nautical': '0.19',
    '--shade-astronomical': '0.28',
    '--shade-night': '0.37',
    '--line-halo': 'rgba(22, 16, 4, 0.86)',
    '--compass-fill': 'rgba(255, 255, 255, 0.72)',
    '--compass-ring': '#2b3846',
    '--compass-tick': '#56636f',
    '--compass-label': '#1a232d',
    '--compass-band': 'rgba(245, 180, 0, 0.22)',
    '--observer': '#17202a',
    '--observer-ring': '#ffffff',
    '--stage-bg': '#eef1f3',
    '--stage-surface': '#ffffff',
    '--stage-surface-2': '#f2f5f7',
    '--stage-line': '#d4dbe1',
    '--stage-line-strong': '#7c8894',
    '--stage-ink': '#17202a',
    '--stage-ink-2': '#45525f',
    '--stage-ink-3': '#5c6874',
    '--stage-accent-ink': '#875900',
    '--stage-focus': '#9a6500',
    '--accent': '#f2b63c',
    '--on-accent': '#1e1502',
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
    '--event-rise': '#ff9f43',
    '--event-transit': '#ffd878',
    '--event-set': '#ff6b5e',
  },
  dark: {
    '--map-water': '#0a1628',
    '--map-land': '#1a2a40',
    '--map-coast': '#36527a',
    '--map-border': '#2b3e5a',
    '--map-graticule': 'rgba(160, 190, 230, 0.13)',
    '--map-shade': '#000510',
    '--shade-civil': '0.16',
    '--shade-nautical': '0.3',
    '--shade-astronomical': '0.43',
    '--shade-night': '0.55',
    '--line-halo': 'rgba(0, 4, 12, 0.78)',
    '--compass-fill': 'rgba(9, 18, 33, 0.66)',
    '--compass-ring': '#b4c5da',
    '--compass-tick': '#8699b2',
    '--compass-label': '#e9eff7',
    '--compass-band': 'rgba(245, 180, 0, 0.18)',
    '--observer': '#0b1424',
    '--observer-ring': '#e9eff7',
    '--stage-bg': '#08111f',
    '--stage-surface': '#0f1b2f',
    '--stage-surface-2': '#16253d',
    '--stage-line': '#22334e',
    '--stage-line-strong': '#5d7294',
    '--stage-ink': '#e9eff7',
    '--stage-ink-2': '#a9b9cd',
    '--stage-ink-3': '#8698b0',
    '--stage-accent-ink': '#f7c866',
    '--stage-focus': '#ffd47e',
    '--accent': '#f5bd48',
    '--on-accent': '#1e1502',
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
    '--event-rise': '#ffa24d',
    '--event-transit': '#ffdb82',
    '--event-set': '#ff7063',
  },
  night: {
    '--map-water': '#000000',
    '--map-land': '#1a0300',
    '--map-coast': '#5c0e00',
    '--map-border': '#300600',
    '--map-graticule': 'rgba(255, 40, 0, 0.16)',
    '--map-shade': '#000000',
    '--shade-civil': '0.22',
    '--shade-nautical': '0.38',
    '--shade-astronomical': '0.52',
    '--shade-night': '0.64',
    '--line-halo': 'rgba(0, 0, 0, 0.9)',
    '--compass-fill': 'rgba(0, 0, 0, 0.68)',
    '--compass-ring': '#d42000',
    '--compass-tick': '#a81400',
    '--compass-label': '#ff2e00',
    '--compass-band': 'rgba(255, 50, 0, 0.18)',
    '--observer': '#000000',
    '--observer-ring': '#ff2e00',
    '--stage-bg': '#000000',
    '--stage-surface': '#080000',
    '--stage-surface-2': '#140200',
    '--stage-line': '#2a0500',
    '--stage-line-strong': '#c01800',
    '--stage-ink': '#ff2e00',
    '--stage-ink-2': '#f21a00',
    '--stage-ink-3': '#ee1600',
    '--stage-accent-ink': '#ff4400',
    '--stage-focus': '#ff4400',
    '--accent': '#ff3d00',
    '--on-accent': '#000000',
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
    '--event-rise': '#ff4000',
    '--event-transit': '#d82800',
    '--event-set': '#bc1400',
  },
};

/** Shared by every theme (tokens.css `:root`). */
const SHARED_FALLBACKS: Readonly<Record<string, string>> = {
  '--dash-now': 'none',
  '--dash-path': 'none',
  '--dash-rise': '7 4',
  '--dash-set': '0.5 4.5',
  '--dash-below': '2 4',
  '--dash-circle': '10 4 2 4',
  '--line-w': '2px',
  '--font-ui': "'Inter Variable', Inter, system-ui, sans-serif",
};

function rootElement(): Element | null {
  return typeof document === 'undefined' ? null : document.documentElement;
}

/** The theme on the document (`data-theme`); light when unset. */
export function currentTheme(root: Element | null = rootElement()): ThemeName {
  const t = root?.getAttribute('data-theme');
  return t === 'dark' || t === 'night' ? t : 'light';
}

/** A token's value on the document, or its fallback for the current theme ("" if neither). */
export function tokenValue(name: string, root: Element | null = rootElement()): string {
  const key = name.startsWith('--') ? name : `--${name}`;
  let value = '';
  if (root && typeof getComputedStyle === 'function') {
    try {
      value = getComputedStyle(root).getPropertyValue(key).trim();
    } catch {
      value = '';
    }
  }
  return value || FALLBACKS[currentTheme(root)][key] || SHARED_FALLBACKS[key] || '';
}

export type Rgba = [number, number, number, number];

/** Parse `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()` or `rgba()`; null otherwise. */
export function parseColor(text: string): Rgba | null {
  const s = text.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (hex) {
    let h = hex[1]!;
    if (h.length === 3) h = [...h].map((c) => c + c).join('');
    const n = Number.parseInt(h.slice(0, 6), 16);
    const a = h.length === 8 ? Number.parseInt(h.slice(6), 16) / 255 : 1;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number.parseFloat(fn[4]) / 100 : Number(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
  }
  return null;
}

/** `rgba(r, g, b, a)` for MapLibre and canvas. */
export function formatColor([r, g, b, a]: Rgba): string {
  const c = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${Math.round(Math.max(0, Math.min(1, a)) * 1000) / 1000})`;
}

/** Mix two colours in sRGB: t = 0 gives `a`, 1 gives `b`. */
export function mixColor(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  return formatColor([0, 1, 2, 3].map((i) => x[i]! + (y[i]! - x[i]!) * t) as Rgba);
}

/** The colour with its alpha multiplied by `alpha`. */
export function withAlpha(color: string, alpha: number): string {
  const c = parseColor(color);
  return c ? formatColor([c[0], c[1], c[2], c[3] * alpha]) : color;
}

/** Notify when `data-theme` changes on the document. Returns the function that stops. */
export function onThemeChange(listener: (theme: ThemeName) => void, root: Element | null = rootElement()): () => void {
  if (!root || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(() => listener(currentTheme(root)));
  observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}

// ---------------------------------------------------------------------------------------
// The map's palette

export type GlyphName = 'sun' | 'moon' | 'mercury' | 'venus' | 'mars' | 'jupiter' | 'saturn' | 'uranus' | 'neptune' | 'star';

const PLANETS = new Set(['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/** The glyph (and colour token) for a canonical body name; every star shares one. */
export function glyphFor(body: string, kind?: BodyKind): GlyphName {
  const key = body.trim().toLowerCase();
  if (key === 'sun' || key === 'moon') return key;
  if (PLANETS.has(key)) return key as GlyphName;
  return kind === 'planet' ? 'jupiter' : 'star';
}

export interface DashSet {
  now: number[];
  path: number[];
  rise: number[];
  set: number[];
  below: number[];
  circle: number[];
}

export interface MapTokens {
  theme: ThemeName;
  water: string;
  land: string;
  coast: string;
  border: string;
  graticule: string;
  shade: string;
  /** Cumulative darkness of the civil, nautical, astronomical and night bands. */
  shadeTargets: [number, number, number, number];
  ice: string;
  urban: string;
  river: string;
  labelInk: string;
  labelHalo: string;
  waterInk: string;
  waterHalo: string;
  stageBg: string;
  stageSurface: string;
  stageLine: string;
  stageInk: string;
  stageInk2: string;
  accent: string;
  focus: string;
  lineHalo: string;
  compassFill: string;
  compassRing: string;
  compassTick: string;
  compassLabel: string;
  compassBand: string;
  observer: string;
  observerRing: string;
  body: Record<GlyphName, string>;
  rise: string;
  transit: string;
  set: string;
  /** Dash patterns in pixels (SVG); [] is solid. */
  dash: DashSet;
}

function num(name: string, fallback: number, root: Element | null): number {
  const v = Number.parseFloat(tokenValue(name, root));
  return Number.isFinite(v) ? v : fallback;
}

function color(name: string, root: Element | null): string {
  const v = tokenValue(name, root);
  if (parseColor(v)) return v;
  return FALLBACKS[currentTheme(root)][name] ?? '#808080';
}

function dash(name: string, root: Element | null): number[] {
  const v = tokenValue(name, root);
  if (!v || v === 'none') return [];
  return v
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/** Read every value the map draws with, for the theme now on the document. */
export function readTokens(root: Element | null = rootElement()): MapTokens {
  const theme = currentTheme(root);
  const c = (name: string) => color(name, root);
  const land = c('--map-land');
  const water = c('--map-water');
  const coast = c('--map-coast');
  const border = c('--map-border');
  const stageInk = c('--stage-ink');
  const stageInk2 = c('--stage-ink-2');
  const white = '#ffffff';
  return {
    theme,
    water,
    land,
    coast,
    border,
    graticule: c('--map-graticule'),
    shade: c('--map-shade'),
    shadeTargets: [
      num('--shade-civil', 0.1, root),
      num('--shade-nautical', 0.19, root),
      num('--shade-astronomical', 0.28, root),
      num('--shade-night', 0.37, root),
    ],
    ice: theme === 'night' ? mixColor(land, coast, 0.3) : mixColor(land, white, theme === 'light' ? 0.6 : 0.07),
    urban: mixColor(land, border, theme === 'light' ? 0.4 : 0.45),
    river: mixColor(water, coast, theme === 'night' ? 0.7 : 0.45),
    labelInk: stageInk2,
    labelHalo: withAlpha(land, 0.9),
    waterInk: mixColor(coast, stageInk2, theme === 'light' ? 0.55 : 0.45),
    waterHalo: withAlpha(water, 0.75),
    stageBg: c('--stage-bg'),
    stageSurface: c('--stage-surface'),
    stageLine: c('--stage-line'),
    stageInk,
    stageInk2,
    accent: c('--accent'),
    focus: c('--stage-focus'),
    lineHalo: c('--line-halo'),
    compassFill: c('--compass-fill'),
    compassRing: c('--compass-ring'),
    compassTick: c('--compass-tick'),
    compassLabel: c('--compass-label'),
    compassBand: c('--compass-band'),
    observer: c('--observer'),
    observerRing: c('--observer-ring'),
    body: {
      sun: c('--body-sun'),
      moon: c('--body-moon'),
      mercury: c('--body-mercury'),
      venus: c('--body-venus'),
      mars: c('--body-mars'),
      jupiter: c('--body-jupiter'),
      saturn: c('--body-saturn'),
      uranus: c('--body-uranus'),
      neptune: c('--body-neptune'),
      star: c('--body-star'),
    },
    rise: c('--event-rise'),
    transit: c('--event-transit'),
    set: c('--event-set'),
    dash: {
      now: dash('--dash-now', root),
      path: dash('--dash-path', root),
      rise: dash('--dash-rise', root),
      set: dash('--dash-set', root),
      below: dash('--dash-below', root),
      circle: dash('--dash-circle', root),
    },
  };
}

/** The colour of a body on this theme. */
export function bodyColor(tokens: MapTokens, body: string, kind?: BodyKind): string {
  return tokens.body[glyphFor(body, kind)];
}

/** A pixel dash pattern as MapLibre `line-dasharray` (units of line width); undefined for solid. */
export function lineDash(pattern: readonly number[], lineWidth: number): number[] | undefined {
  if (!pattern.length) return undefined;
  const w = Math.max(0.5, lineWidth);
  // MapLibre needs positive dash lengths; a 0 "dot" becomes a short dash.
  return pattern.map((v, i) => Math.max(i % 2 === 0 ? 0.1 : 0, v / w));
}

/**
 * Write the palette onto the map's root element as `--sfm-*` custom properties, for the parts
 * of the map drawn with DOM and SVG (dial, marker, controls, read-outs).
 */
export function applyCssTokens(el: HTMLElement, t: MapTokens): void {
  const set = (name: string, value: string) => el.style.setProperty(name, value);
  set('--sfm-bg', t.stageBg);
  set('--sfm-surface', t.stageSurface);
  set('--sfm-line', t.stageLine);
  set('--sfm-ink', t.stageInk);
  set('--sfm-ink-2', t.stageInk2);
  set('--sfm-accent', t.accent);
  set('--sfm-focus', t.focus);
  set('--sfm-halo', t.lineHalo);
  set('--sfm-compass-fill', t.compassFill);
  set('--sfm-compass-ring', t.compassRing);
  set('--sfm-compass-tick', t.compassTick);
  set('--sfm-compass-label', t.compassLabel);
  set('--sfm-compass-band', t.compassBand);
  set('--sfm-observer', t.observer);
  set('--sfm-observer-ring', t.observerRing);
  set('--sfm-rise', t.rise);
  set('--sfm-set', t.set);
  set('--sfm-transit', t.transit);
  for (const [name, value] of Object.entries(t.body)) set(`--sfm-body-${name}`, value);
  const dashCss = (d: number[]) => (d.length ? d.join(' ') : 'none');
  set('--sfm-dash-rise', dashCss(t.dash.rise));
  set('--sfm-dash-set', dashCss(t.dash.set));
  set('--sfm-dash-now', dashCss(t.dash.now));
  set('--sfm-dash-path', dashCss(t.dash.path));
  set('--sfm-dash-below', dashCss(t.dash.below));
  set('--sfm-dash-circle', dashCss(t.dash.circle));
  set('--sfm-font', tokenValue('--font-ui') || SHARED_FALLBACKS['--font-ui']!);
}
