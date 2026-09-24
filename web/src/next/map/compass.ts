/**
 * The compass dial drawn at the observer: horizon ring, compass points, altitude rings, the
 * selected body's path for the day, its rise and set directions with local times, where it
 * is now, and for the Sun the band its paths sweep between the solstices. OWNER: map agent.
 *
 * It is an SVG in screen space (a fixed size whatever the map zoom), placed over the map at
 * the observer by `place()`. Geometry comes from skyproj.ts; colours and dashes from the
 * `--sfm-*` properties (style-tokens.ts), so a theme change needs no redraw. The dial is
 * decorative for assistive technology: the map view publishes the same facts as text.
 *
 * Colour is never the only cue (EXPLORER_PLAN 3.6): rise is dashed, set dotted, "now" solid,
 * and each end carries a word and a time.
 */

import type { BodyKind } from '../engine/types.js';
import {
  brightLimbScreenAngle,
  labelPlacement,
  moonLitPath,
  pathData,
  regionPath,
  ringXY,
  skyXY,
  type AltAz,
  type SkyRegion,
} from './skyproj.js';
import { glyphFor, type GlyphName } from './style-tokens.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Room around the ring for the rise and set labels. */
const PAD = 78;

export interface DialEvent {
  kind: 'rise' | 'set' | 'transit';
  alt: number;
  az: number;
  /** Shown beside the ring end, e.g. "Rise 06:52". */
  label: string;
}

export interface DialDay {
  body: string;
  kind: BodyKind;
  /** Parts of today's path above the horizon (apparent altitude). */
  path: AltAz[][];
  events: DialEvent[];
  /** "Up all day" / "Down all day" and similar, or ''. */
  note: string;
  /** The Sun only: the band between the solstice paths, and the two paths. */
  band?: SkyRegion | null;
  solstices?: AltAz[][][];
}

export interface DialNow {
  /** Apparent altitude and azimuth now. */
  alt: number;
  az: number;
  /** The Moon: illuminated fraction and bright limb from the zenith (degrees). */
  phase?: { fraction: number; limbFromZenithDeg: number | null } | null;
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A line from the centre to a point, drawn twice: a dark casing, then the colour. */
function casedLine(parent: Element, x: number, y: number, cls: string): void {
  el('line', { x1: 0, y1: 0, x2: r1(x), y2: r1(y), class: `sfm-dial-casing ${cls}` }, parent);
  el('line', { x1: 0, y1: 0, x2: r1(x), y2: r1(y), class: cls }, parent);
}

/** Draw a body's glyph centred at (0, 0) into `g`. */
export function drawGlyph(g: SVGGElement, name: GlyphName, size: number, phase?: DialNow['phase'], limbAngle?: number): void {
  const r = size / 2;
  const color = `var(--sfm-body-${name})`;
  if (name === 'sun') {
    const rays = el('g', { class: 'sfm-glyph-rays', stroke: color }, g);
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      el('line', { x1: r1(Math.cos(a) * r * 0.78), y1: r1(Math.sin(a) * r * 0.78), x2: r1(Math.cos(a) * r * 1.2), y2: r1(Math.sin(a) * r * 1.2) }, rays);
    }
    el('circle', { r: r1(r * 0.58), class: 'sfm-glyph-disc', fill: color }, g);
    return;
  }
  if (name === 'moon') {
    el('circle', { r: r1(r), class: 'sfm-glyph-moon-dark' }, g);
    const lit = moonLitPath(phase?.fraction ?? 1, r);
    if (lit) {
      const deg = ((limbAngle ?? -Math.PI / 2) * 180) / Math.PI;
      el('path', { d: lit, class: 'sfm-glyph-moon-lit', fill: color, transform: `rotate(${r1(deg)})` }, g);
    }
    el('circle', { r: r1(r), class: 'sfm-glyph-outline' }, g);
    return;
  }
  if (name === 'star') {
    const s = r * 1.15;
    const k = s * 0.32;
    el('path', { d: `M0 ${-s}L${k} ${-k}L${s} 0L${k} ${k}L0 ${s}L${-k} ${k}L${-s} 0L${-k} ${-k}Z`, class: 'sfm-glyph-disc', fill: color }, g);
    return;
  }
  el('circle', { r: r1(r * 0.62), class: 'sfm-glyph-disc', fill: color }, g);
  if (name === 'saturn') {
    el('ellipse', { rx: r1(r * 1.1), ry: r1(r * 0.36), class: 'sfm-glyph-ring', stroke: color, transform: 'rotate(-20)' }, g);
  }
}

export class CompassDial {
  readonly root: SVGSVGElement;
  private readonly staticG: SVGGElement;
  private readonly dayG: SVGGElement;
  private readonly nowG: SVGGElement;
  private radius = 0;
  private day: DialDay | null = null;
  private now: DialNow | null = null;
  private lastPlace = '';

  constructor(parent: HTMLElement) {
    this.root = el('svg', { class: 'sfm-dial', 'aria-hidden': 'true', focusable: 'false' });
    this.staticG = el('g', { class: 'sfm-dial-static' }, this.root);
    this.dayG = el('g', { class: 'sfm-dial-day' }, this.root);
    this.nowG = el('g', { class: 'sfm-dial-now' }, this.root);
    parent.appendChild(this.root);
  }

  /** Size the dial; redraws when the radius changes. */
  setRadius(R: number): void {
    const r = Math.round(R);
    if (r === this.radius) return;
    this.radius = r;
    const size = 2 * (r + PAD);
    this.root.setAttribute('viewBox', `${-(r + PAD)} ${-(r + PAD)} ${size} ${size}`);
    this.root.setAttribute('width', String(size));
    this.root.setAttribute('height', String(size));
    this.drawStatic();
    this.drawDay();
    this.drawNow();
  }

  /** Put the dial's centre at screen point (x, y), with north rotated `rotationDeg` from up. */
  place(x: number, y: number, rotationDeg: number, visible: boolean): void {
    const key = visible ? `${r1(x)},${r1(y)},${r1(rotationDeg)}` : 'hidden';
    if (key === this.lastPlace) return;
    this.lastPlace = key;
    this.root.style.display = visible ? '' : 'none';
    if (!visible) return;
    const half = this.radius + PAD;
    this.root.style.transform = `translate(${r1(x - half)}px, ${r1(y - half)}px) rotate(${r1(rotationDeg)}deg)`;
  }

  setDay(day: DialDay | null): void {
    this.day = day;
    this.drawDay();
    this.drawNow();
  }

  setNow(now: DialNow | null): void {
    this.now = now;
    this.drawNow();
  }

  destroy(): void {
    this.root.remove();
  }

  private drawStatic(): void {
    const R = this.radius;
    const g = this.staticG;
    g.replaceChildren();
    el('circle', { r: R, class: 'sfm-dial-disc' }, g);
    // Faint altitude rings at 30 and 60 degrees (orthographic: R cos h).
    for (const h of [30, 60]) el('circle', { r: r1(R * Math.cos((h * Math.PI) / 180)), class: 'sfm-dial-alt' }, g);
    const ticks = el('g', { class: 'sfm-dial-ticks' }, g);
    for (let az = 0; az < 360; az += 10) {
      const major = az % 90 === 0;
      const mid = az % 30 === 0;
      const len = major ? 10 : mid ? 7 : 4;
      const [x1, y1] = ringXY(az, R);
      const [x2, y2] = ringXY(az, R - len);
      el('line', { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), class: major || mid ? 'sfm-dial-tick sfm-dial-tick--major' : 'sfm-dial-tick' }, ticks);
    }
    el('circle', { r: R, class: 'sfm-dial-ring' }, g);
    for (const [label, az] of [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ] as const) {
      const [x, y] = ringXY(az, R - 21);
      const t = el('text', { x: r1(x), y: r1(y), class: `sfm-dial-cardinal${az === 0 ? ' sfm-dial-cardinal--n' : ''}`, 'dominant-baseline': 'central', 'text-anchor': 'middle' }, g);
      t.textContent = label;
    }
  }

  private drawDay(): void {
    const g = this.dayG;
    g.replaceChildren();
    const day = this.day;
    const R = this.radius;
    if (!day || R <= 0) return;
    const name = glyphFor(day.body, day.kind);
    const color = `var(--sfm-body-${name})`;

    if (day.band) {
      const d = regionPath(day.band, R);
      if (d) el('path', { d, class: 'sfm-dial-band', 'fill-rule': 'evenodd' }, g);
    }
    for (const runs of day.solstices ?? []) {
      for (const run of runs) el('path', { d: pathData(run.map((p) => skyXY(p.alt, p.az, R))), class: 'sfm-dial-solstice' }, g);
    }
    for (const e of day.events) {
      if (e.kind === 'transit') continue;
      const [x, y] = ringXY(e.az, R);
      casedLine(g, x, y, e.kind === 'rise' ? 'sfm-dial-rise' : 'sfm-dial-set');
    }
    for (const run of day.path) {
      const d = pathData(run.map((p) => skyXY(p.alt, p.az, R)));
      el('path', { d, class: 'sfm-dial-casing sfm-dial-path' }, g);
      el('path', { d, class: 'sfm-dial-path', style: `stroke:${color}` }, g);
    }
    for (const e of day.events) {
      if (e.kind !== 'transit' || e.alt < 0) continue;
      const [x, y] = skyXY(e.alt, e.az, R);
      el('path', { d: `M${r1(x)} ${r1(y - 5)}l5 5-5 5-5-5Z`, class: 'sfm-dial-transit' }, g);
    }
    for (const e of day.events) {
      if (e.kind === 'transit') continue;
      const p = labelPlacement(e.az, R, 9);
      const t = el(
        'text',
        {
          x: r1(p.x),
          y: r1(p.y),
          'text-anchor': p.anchor,
          'dominant-baseline': p.baseline === 'hanging' ? 'hanging' : p.baseline === 'middle' ? 'central' : 'auto',
          class: `sfm-dial-label sfm-dial-label--${e.kind}`,
        },
        g,
      );
      t.textContent = e.label;
    }
    if (day.note) {
      const t = el('text', { x: 0, y: R + 22, 'text-anchor': 'middle', 'dominant-baseline': 'hanging', class: 'sfm-dial-note' }, g);
      t.textContent = day.note;
    }
  }

  private drawNow(): void {
    const g = this.nowG;
    g.replaceChildren();
    const day = this.day;
    const now = this.now;
    const R = this.radius;
    if (!day || !now || R <= 0) return;
    const name = glyphFor(day.body, day.kind);
    const up = now.alt >= 0;
    const [rx, ry] = ringXY(now.az, R);
    const ray = el('g', { class: up ? 'sfm-dial-now-ray' : 'sfm-dial-now-ray sfm-dial-now-ray--below', style: `--sfm-now:var(--sfm-body-${name})` }, g);
    casedLine(ray, rx, ry, 'sfm-dial-now-line');
    const [x, y] = up ? skyXY(now.alt, now.az, R) : [rx, ry];
    const glyph = el('g', { class: up ? 'sfm-dial-glyph' : 'sfm-dial-glyph sfm-dial-glyph--below', transform: `translate(${r1(x)} ${r1(y)})` }, g);
    const limb =
      name === 'moon' && now.phase?.limbFromZenithDeg !== null && now.phase?.limbFromZenithDeg !== undefined
        ? brightLimbScreenAngle(Math.max(0, now.alt), now.az, now.phase.limbFromZenithDeg)
        : undefined;
    drawGlyph(glyph, name, name === 'sun' ? 26 : name === 'moon' ? 22 : 16, now.phase, limb);
    el('circle', { r: 3.2, class: 'sfm-dial-centre' }, g);
  }
}
