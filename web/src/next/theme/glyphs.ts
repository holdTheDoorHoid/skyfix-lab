/**
 * Body glyphs and the drawn Moon phase disc. OWNER: shell-design agent.
 *
 * Every body has one colour token (`--body-*`, tokens.css) and one glyph, used the same
 * way in the panel, the time bar, the map, the sky view and the charts. Colour is never
 * the only cue: the glyph shape and the body's name always go with it.
 *
 * Glyphs are drawn for this project on a 24-unit grid: the Sun as a rayed disc, the Moon
 * as a crescent, the planets as their classical symbols, stars as a five-point star.
 */

import type { BodyKind } from '../engine/types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export type GlyphName =
  | 'sun'
  | 'moon'
  | 'mercury'
  | 'venus'
  | 'mars'
  | 'jupiter'
  | 'saturn'
  | 'uranus'
  | 'neptune'
  | 'star';

interface GlyphShape {
  /** Filled shapes. */
  fill?: string[];
  /** Stroked shapes (1.9 units). */
  stroke?: string[];
  circles?: [number, number, number][];
}

const RAYS = Array.from({ length: 8 }, (_, i) => {
  const a = (i * Math.PI) / 4;
  const x1 = 12 + 7.3 * Math.cos(a);
  const y1 = 12 + 7.3 * Math.sin(a);
  const x2 = 12 + 10 * Math.cos(a);
  const y2 = 12 + 10 * Math.sin(a);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}L${x2.toFixed(2)} ${y2.toFixed(2)}`;
}).join('');

const GLYPHS: Record<GlyphName, GlyphShape> = {
  sun: { fill: ['M12 7.2a4.8 4.8 0 1 1 0 9.6 4.8 4.8 0 0 1 0-9.6Z'], stroke: [RAYS] },
  moon: { fill: ['M14.6 3.9A8.4 8.4 0 1 0 20.4 15.2 6.9 6.9 0 0 1 14.6 3.9Z'] },
  mercury: {
    stroke: ['M8.6 3.9c.6 1.6 1.9 2.6 3.4 2.6s2.8-1 3.4-2.6', 'M12 14.6v6.6M9.1 18.1h5.8'],
    circles: [[12, 11.2, 3.5]],
  },
  venus: { stroke: ['M12 13.7v7.5M8.7 17.8h6.6'], circles: [[12, 8.9, 4.7]] },
  mars: { stroke: ['M13.4 10.6 19.5 4.5M14.6 4.5h4.9v4.9'], circles: [[9.8, 14.2, 5]] },
  jupiter: {
    stroke: ['M5.8 7.9c.3-2.3 2-3.7 4.2-3.7 2.2 0 3.8 1.5 3.8 3.7 0 3.1-3.4 5.5-7.6 8.6h13.2', 'M15.9 3.8v16.9'],
  },
  saturn: {
    stroke: [
      'M8.3 3.4v13.8',
      'M5.6 6.1h5.4',
      'M8.3 12.6c1.1-2 3-3.1 5-3.1 2.4 0 4 1.8 4 4 0 3.2-3.5 4.7-3.5 6.8 0 .8.6 1.3 1.4 1.3',
    ],
  },
  uranus: { stroke: ['M12 10.9V3.3M9.2 6.1 12 3.3l2.8 2.8'], circles: [[12, 15.6, 4.7]], fill: ['M12 14.4a1.2 1.2 0 1 1 0 2.4 1.2 1.2 0 0 1 0-2.4Z'] },
  neptune: {
    stroke: [
      'M12 6.2v15M8.6 18.1h6.8',
      'M5.8 5.2V8c0 3.4 2.8 6.2 6.2 6.2s6.2-2.8 6.2-6.2V5.2',
      'M4.4 6.8l1.4-1.6 1.4 1.6M16.8 6.8l1.4-1.6 1.4 1.6M10.6 7.8 12 6.2l1.4 1.6',
    ],
  },
  star: {
    fill: [
      'M12 3.8 14.17 9.61 20.37 9.88 15.52 13.74 17.17 19.72 12 16.3 6.83 19.72 8.48 13.74 3.63 9.88 9.83 9.61Z',
    ],
  },
};

const PLANETS: Record<string, GlyphName> = {
  mercury: 'mercury',
  venus: 'venus',
  mars: 'mars',
  jupiter: 'jupiter',
  saturn: 'saturn',
  uranus: 'uranus',
  neptune: 'neptune',
};

/** The glyph for a canonical body name (and its kind, for stars). */
export function glyphFor(body: string, kind?: BodyKind): GlyphName {
  const key = body.trim().toLowerCase();
  if (key === 'sun') return 'sun';
  if (key === 'moon') return 'moon';
  return PLANETS[key] ?? (kind === 'planet' ? 'jupiter' : 'star');
}

/** The colour token for a body: `--body-sun`, `--body-venus`, … and `--body-star` for every star. */
export function bodyToken(body: string, kind?: BodyKind): string {
  return `--body-${glyphFor(body, kind)}`;
}

/** `var(--body-…)` for use in a style attribute. */
export function bodyColor(body: string, kind?: BodyKind): string {
  return `var(${bodyToken(body, kind)})`;
}

export interface GlyphOptions {
  size?: number;
  /** Accessible name; decorative otherwise. */
  label?: string;
  /** Colour; default the body's token. */
  color?: string;
  class?: string;
  /** Draw a dark casing under the glyph (for the map and the sky). */
  halo?: boolean;
}

function glyphParts(shape: GlyphShape, halo: boolean): SVGElement[] {
  const out: SVGElement[] = [];
  const strokeW = halo ? 1.9 + 3.2 : 1.9;
  for (const d of shape.fill ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    if (halo) {
      p.setAttribute('fill', 'var(--line-halo)');
      p.setAttribute('stroke', 'var(--line-halo)');
      p.setAttribute('stroke-width', '3.2');
      p.setAttribute('stroke-linejoin', 'round');
    } else {
      p.setAttribute('fill', 'currentColor');
    }
    out.push(p);
  }
  for (const d of shape.stroke ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', halo ? 'var(--line-halo)' : 'currentColor');
    p.setAttribute('stroke-width', String(strokeW));
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    out.push(p);
  }
  for (const [cx, cy, r] of shape.circles ?? []) {
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', String(cx));
    c.setAttribute('cy', String(cy));
    c.setAttribute('r', String(r));
    c.setAttribute('fill', 'none');
    c.setAttribute('stroke', halo ? 'var(--line-halo)' : 'currentColor');
    c.setAttribute('stroke-width', String(strokeW));
    out.push(c);
  }
  return out;
}

/** Append a glyph's shapes into an existing SVG group (used by map and sky overlays). */
export function drawGlyph(
  parent: SVGElement,
  name: GlyphName,
  x: number,
  y: number,
  size: number,
  options: { halo?: boolean; color?: string } = {},
): SVGGElement {
  const g = document.createElementNS(SVG_NS, 'g');
  const scale = size / 24;
  g.setAttribute('transform', `translate(${x - size / 2} ${y - size / 2}) scale(${scale})`);
  g.setAttribute('class', `sf-glyph sf-glyph--${name}`);
  if (options.color) g.setAttribute('color', options.color);
  if (options.halo) for (const el of glyphParts(GLYPHS[name], true)) g.appendChild(el);
  for (const el of glyphParts(GLYPHS[name], false)) g.appendChild(el);
  parent.appendChild(g);
  return g;
}

/** A standalone `<svg>` glyph for a body. */
export function bodyGlyph(body: string, options: GlyphOptions & { kind?: BodyKind } = {}): SVGSVGElement {
  const name = glyphFor(body, options.kind);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', options.halo ? '-2 -2 28 28' : '0 0 24 24');
  svg.setAttribute('class', `sf-glyph sf-glyph--${name}${options.class ? ` ${options.class}` : ''}`);
  svg.style.color = options.color ?? bodyColor(body, options.kind);
  if (options.size) {
    svg.setAttribute('width', String(options.size));
    svg.setAttribute('height', String(options.size));
  }
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
  }
  if (options.halo) for (const el of glyphParts(GLYPHS[name], true)) svg.appendChild(el);
  for (const el of glyphParts(GLYPHS[name], false)) svg.appendChild(el);
  return svg;
}

export interface PhaseDiscOptions {
  /** Illuminated fraction, 0 (new) to 1 (full). */
  illuminated: number;
  /**
   * Direction of the bright limb on screen, degrees counter-clockwise from "up". For the
   * horizon frame (zenith up) that is `bright_limb_angle_deg − parallactic_angle_deg`
   * (EXPLORER_API, BodyState). Default 270 (lit on the right, as a waxing Moon in the
   * northern hemisphere).
   */
  limbFromUpDeg?: number;
  size?: number;
  label?: string;
  class?: string;
}

/**
 * The Moon's phase, drawn: the lit part in `--body-moon`, the dark part in a dim
 * neutral with a rim so the whole disc stays visible.
 */
export function phaseDisc(options: PhaseDiscOptions): SVGSVGElement {
  const size = options.size ?? 24;
  const k = Math.min(1, Math.max(0, options.illuminated));
  const r = 10;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '-12 -12 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('class', `sf-phase${options.class ? ` ${options.class}` : ''}`);
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  const dark = document.createElementNS(SVG_NS, 'circle');
  dark.setAttribute('r', String(r));
  dark.setAttribute('class', 'sf-phase__dark');
  svg.appendChild(dark);

  const lit = document.createElementNS(SVG_NS, 'path');
  const rx = r * Math.abs(2 * k - 1);
  const gibbous = k > 0.5 ? 1 : 0;
  // Bright side toward +x: the lit half-disc, then back along the terminator ellipse.
  lit.setAttribute(
    'd',
    k >= 0.999
      ? `M0 ${-r}A${r} ${r} 0 1 1 0 ${r}A${r} ${r} 0 1 1 0 ${-r}Z`
      : `M0 ${-r}A${r} ${r} 0 0 1 0 ${r}A${rx.toFixed(3)} ${r} 0 0 ${gibbous} 0 ${-r}Z`,
  );
  // +x must point at the bright limb: "up" is -90 deg in SVG, and SVG rotates clockwise.
  const theta = options.limbFromUpDeg ?? 270;
  lit.setAttribute('transform', `rotate(${(-90 - theta).toFixed(2)})`);
  lit.setAttribute('class', 'sf-phase__lit');
  if (k > 0.001) svg.appendChild(lit);

  const rim = document.createElementNS(SVG_NS, 'circle');
  rim.setAttribute('r', String(r));
  rim.setAttribute('class', 'sf-phase__rim');
  svg.appendChild(rim);
  return svg;
}

/** Plain-words name of a Moon phase from the illuminated fraction and whether it is waxing. */
export function moonPhaseName(illuminated: number, waxing: boolean): string {
  if (illuminated < 0.02) return 'New Moon';
  if (illuminated > 0.98) return 'Full Moon';
  if (Math.abs(illuminated - 0.5) < 0.04) return waxing ? 'First quarter' : 'Last quarter';
  if (illuminated < 0.5) return waxing ? 'Waxing crescent' : 'Waning crescent';
  return waxing ? 'Waxing gibbous' : 'Waning gibbous';
}
