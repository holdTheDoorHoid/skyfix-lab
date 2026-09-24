/**
 * Reading design tokens from script, for views that draw with WebGL or a canvas (the map,
 * the sky, the charts) and cannot use `var(--…)`. OWNER: shell-design agent.
 *
 * The values live only in tokens.css; this module never duplicates them. Read them after
 * the theme is applied, and again when it changes (`onThemeChange` in theme.ts).
 */

/** The value of a custom property on the root element, trimmed ("" when unset). */
export function tokenValue(name: string, root: Element = document.documentElement): string {
  const key = name.startsWith('--') ? name : `--${name}`;
  return getComputedStyle(root).getPropertyValue(key).trim();
}

/** A token as a number (`--shade-night: 0.37`), or `fallback`. */
export function tokenNumber(name: string, fallback = 0, root?: Element): number {
  const value = Number.parseFloat(tokenValue(name, root));
  return Number.isFinite(value) ? value : fallback;
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
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(s);
  if (fn) {
    const alpha = fn[4] === undefined ? 1 : fn[4].endsWith('%') ? Number.parseFloat(fn[4]) / 100 : Number(fn[4]);
    return [Number(fn[1]), Number(fn[2]), Number(fn[3]), alpha];
  }
  return null;
}

/** A colour token, as a string MapLibre and canvas accept. */
export function tokenColor(name: string, fallback = '#ff00ff', root?: Element): string {
  const value = tokenValue(name, root);
  return parseColor(value) ? value : fallback;
}

/** A dash token (`7 4`) as numbers for canvas `setLineDash`, or [] for a solid line. */
export function tokenDash(name: string, root?: Element): number[] {
  const value = tokenValue(name, root);
  if (!value || value === 'none') return [];
  return value
    .split(/[\s,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n));
}

/** Body colour tokens, one per body; every star shares `--body-star` (tokens.css). */
export const BODY_TOKENS = [
  '--body-sun',
  '--body-moon',
  '--body-mercury',
  '--body-venus',
  '--body-mars',
  '--body-jupiter',
  '--body-saturn',
  '--body-uranus',
  '--body-neptune',
  '--body-star',
] as const;

/** Event colour tokens: rise and dawn, transit, set and dusk. */
export const EVENT_TOKENS = { rise: '--event-rise', transit: '--event-transit', set: '--event-set' } as const;

/** Line dash tokens shared by every view (tokens.css): colour never works alone. */
export const DASH_TOKENS = {
  now: '--dash-now',
  path: '--dash-path',
  rise: '--dash-rise',
  set: '--dash-set',
  below: '--dash-below',
  circle: '--dash-circle',
} as const;

/** Sky-phase fills and their label colours, night to day (CONVENTIONS 13.4). */
export const PHASE_TOKENS = {
  night: ['--phase-night', '--phase-night-ink'],
  astronomical: ['--phase-astronomical', '--phase-astronomical-ink'],
  nautical: ['--phase-nautical', '--phase-nautical-ink'],
  civil: ['--phase-civil', '--phase-civil-ink'],
  day: ['--phase-day', '--phase-day-ink'],
} as const;
