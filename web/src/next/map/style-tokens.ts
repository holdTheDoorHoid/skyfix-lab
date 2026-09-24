/**
 * THE ONE PLACE THE MAP READS THE THEME AS VALUES. OWNER: map agent.
 *
 * MapLibre draws with WebGL, so its paint needs the design tokens as values, not as
 * `var(--…)`. This module reads them through the design system (theme/tokens.ts,
 * theme/theme.ts) for the theme now on `<html data-theme>` and derives the few colours
 * the basemap needs that the design system does not name (ice, built-up areas, rivers,
 * label halos). The map's DOM parts (dial, markers, controls) use `var(--…)` directly in
 * map.css. Nothing else in map/ names a colour.
 */

import type { BodyKind } from '../engine/types.js';
import { glyphFor as themeGlyphFor, type GlyphName } from '../theme/glyphs.js';
import { currentTheme as themeCurrent, onThemeChange as themeOnChange, type ThemeName } from '../theme/theme.js';
import { parseColor as themeParseColor, tokenValue as themeTokenValue, type Rgba } from '../theme/tokens.js';

export type { GlyphName, Rgba, ThemeName };

/** The theme on the document. */
export function currentTheme(): ThemeName {
  return typeof document === 'undefined' ? 'light' : themeCurrent();
}

/** A token's value on the document ('' when unset or outside a browser). */
export function tokenValue(name: string): string {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return '';
  return themeTokenValue(name);
}

export function parseColor(text: string): Rgba | null {
  return themeParseColor(text);
}

/** Notify when the theme changes. Returns the function that stops. */
export function onThemeChange(listener: (theme: ThemeName) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
  return themeOnChange(listener);
}

/** The glyph (and colour token) of a body; every star shares one. */
export function glyphFor(body: string, kind?: BodyKind): GlyphName {
  return themeGlyphFor(body, kind);
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
  stageInk: string;
  stageInk2: string;
  accent: string;
  lineHalo: string;
  body: Record<GlyphName, string>;
  rise: string;
  transit: string;
  set: string;
  /** Dash patterns in pixels (as for SVG); [] is solid. */
  dash: DashSet;
}

/** Colours the page could not provide (no stylesheet, or a test): a neutral grey, never a guess at a theme. */
const MISSING = '#808080';

function color(name: string): string {
  const v = tokenValue(name);
  return parseColor(v) ? v : MISSING;
}

function num(name: string, fallback: number): number {
  const v = Number.parseFloat(tokenValue(name));
  return Number.isFinite(v) ? v : fallback;
}

function dash(name: string): number[] {
  const v = tokenValue(name);
  if (!v || v === 'none') return [];
  return v
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
}

/** Read every value the map paints with, for the theme now on the document. */
export function readTokens(): MapTokens {
  const theme = currentTheme();
  const land = color('--map-land');
  const water = color('--map-water');
  const coast = color('--map-coast');
  const border = color('--map-border');
  const stageInk = color('--stage-ink');
  const stageInk2 = color('--stage-ink-2');
  const white = '#ffffff';
  return {
    theme,
    water,
    land,
    coast,
    border,
    graticule: color('--map-graticule'),
    shade: color('--map-shade'),
    shadeTargets: [num('--shade-civil', 0.1), num('--shade-nautical', 0.2), num('--shade-astronomical', 0.3), num('--shade-night', 0.4)],
    // Night keeps to reds: no white is ever mixed in.
    ice: theme === 'night' ? mixColor(land, coast, 0.3) : mixColor(land, white, theme === 'light' ? 0.6 : 0.07),
    urban: mixColor(land, border, theme === 'light' ? 0.4 : 0.45),
    river: mixColor(water, coast, theme === 'night' ? 0.7 : 0.45),
    labelInk: stageInk2,
    labelHalo: withAlpha(land, 0.9),
    waterInk: mixColor(coast, stageInk2, theme === 'light' ? 0.55 : 0.45),
    waterHalo: withAlpha(water, 0.75),
    stageInk,
    stageInk2,
    accent: color('--accent'),
    lineHalo: color('--line-halo'),
    body: {
      sun: color('--body-sun'),
      moon: color('--body-moon'),
      mercury: color('--body-mercury'),
      venus: color('--body-venus'),
      mars: color('--body-mars'),
      jupiter: color('--body-jupiter'),
      saturn: color('--body-saturn'),
      uranus: color('--body-uranus'),
      neptune: color('--body-neptune'),
      star: color('--body-star'),
    },
    rise: color('--event-rise'),
    transit: color('--event-transit'),
    set: color('--event-set'),
    dash: {
      now: dash('--dash-now'),
      path: dash('--dash-path'),
      rise: dash('--dash-rise'),
      set: dash('--dash-set'),
      below: dash('--dash-below'),
      circle: dash('--dash-circle'),
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
