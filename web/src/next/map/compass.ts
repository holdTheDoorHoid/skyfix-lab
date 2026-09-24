/**
 * The compass dial drawn at the observer (the look approved in docs/design/map-light.png):
 * horizon ring with compass points, faint altitude rings, the selected body's path for the
 * day with hourly dots, its rise and set directions with local times, where it is now, the
 * band the Sun's paths sweep between the solstices, and the place's name under it. OWNER:
 * map agent.
 *
 * Screen space: a fixed size whatever the map zoom, centred exactly on the observer by
 * `place()` and turned so its north follows the local meridian on the globe. Geometry from
 * skyproj.ts; colours, dashes and glyphs from the design system (`var(--…)`, theme/glyphs),
 * so a theme change needs no redraw. Decorative for assistive technology: the map view
 * publishes the same facts as text.
 *
 * Colour is never the only cue (EXPLORER_PLAN 3.6): rise is dashed, set dotted, "now"
 * solid, and each end of the day carries a word, an icon and a time.
 */

import type { BodyKind } from '../engine/types.js';
import { drawGlyph } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';
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
import { glyphFor } from './style-tokens.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
/** Room around the ring inside the SVG (north mark, glyph near the horizon). */
const PAD = 24;

export interface DialEvent {
  kind: 'rise' | 'set' | 'transit';
  alt: number;
  az: number;
  /** Words and time shown beside the ring end, e.g. "Sunrise 06:52". */
  label: string;
  /** The time alone, for the compact dial (phones): "06:52". */
  time: string;
}

export interface DialDay {
  body: string;
  kind: BodyKind;
  /** Parts of today's path above the horizon (apparent altitude). */
  path: AltAz[][];
  /** Points on the path on each whole hour (above the horizon). */
  hours: AltAz[];
  events: DialEvent[];
  /** "Sun up all day (midnight Sun)" and the like, or ''. */
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

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

function div(cls: string, parent?: Element): HTMLElement {
  const node = document.createElement('div');
  node.className = cls;
  parent?.appendChild(node);
  return node;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A line drawn twice: a dark casing, then the colour on top. */
function casedLine(parent: Element, d: string, cls: string): void {
  svg('path', { d, class: `sfm-dial__casing ${cls}` }, parent);
  svg('path', { d, class: cls }, parent);
}

export class CompassDial {
  /** Positioned at the observer; everything else is laid out around its (0, 0). */
  readonly root: HTMLElement;
  private readonly blur: HTMLElement;
  private readonly svgRoot: SVGSVGElement;
  private readonly staticG: SVGGElement;
  private readonly dayG: SVGGElement;
  private readonly nowG: SVGGElement;
  private readonly topG: SVGGElement;
  private readonly labels: HTMLElement;
  private readonly placeEl: HTMLElement;
  private readonly placeText: HTMLElement;
  private radius = 0;
  private rotation = 0;
  private day: DialDay | null = null;
  private now: DialNow | null = null;
  private showDial = true;
  private compact = false;
  private lastPlace = '';

  constructor(parent: HTMLElement) {
    this.root = div('sfm-dial', parent);
    this.blur = div('sfm-dial__blur', this.root);
    this.svgRoot = svg('svg', { class: 'sfm-dial__svg', 'aria-hidden': 'true', focusable: 'false' }, this.root);
    this.staticG = svg('g', {}, this.svgRoot);
    this.dayG = svg('g', {}, this.svgRoot);
    this.nowG = svg('g', {}, this.svgRoot);
    this.topG = svg('g', {}, this.svgRoot);
    this.labels = div('sfm-dial__labels', this.root);
    this.placeEl = div('sfm-dial__place', this.root);
    this.placeEl.appendChild(icon('pin'));
    this.placeText = document.createElement('span');
    this.placeEl.appendChild(this.placeText);
  }

  /** Size the dial; redraws when the radius changes. */
  setRadius(R: number): void {
    const r = Math.round(R);
    if (r === this.radius) return;
    this.radius = r;
    const s = r + PAD;
    this.svgRoot.setAttribute('viewBox', `${-s} ${-s} ${2 * s} ${2 * s}`);
    this.svgRoot.setAttribute('width', String(2 * s));
    this.svgRoot.setAttribute('height', String(2 * s));
    this.svgRoot.style.left = `${-s}px`;
    this.svgRoot.style.top = `${-s}px`;
    this.blur.style.width = this.blur.style.height = `${2 * r}px`;
    this.blur.style.left = this.blur.style.top = `${-r}px`;
    this.lastPlace = '';
    this.drawStatic();
    this.drawDay();
    this.drawNow();
    this.layoutPlace();
  }

  /** The dial (true) or only the place's name beside the marker (false). */
  setDialVisible(show: boolean): void {
    if (show === this.showDial) return;
    this.showDial = show;
    this.root.classList.toggle('sfm-dial--bare', !show);
    this.layoutPlace();
  }

  /** Compact (phones): times without words beside the ring, no place label. */
  setCompact(compact: boolean): void {
    if (compact === this.compact) return;
    this.compact = compact;
    this.root.classList.toggle('sfm-dial--compact', compact);
    this.layoutLabels();
  }

  setPlaceLabel(text: string): void {
    if (this.placeText.textContent !== text) this.placeText.textContent = text;
    this.placeEl.hidden = !text;
  }

  /**
   * Put the dial's centre at screen point (x, y), with its north turned `rotationDeg`
   * clockwise from up.
   */
  place(x: number, y: number, rotationDeg: number, visible: boolean): void {
    const key = visible ? `${r1(x)},${r1(y)},${r1(rotationDeg)}` : 'hidden';
    if (key === this.lastPlace) return;
    this.lastPlace = key;
    this.root.style.display = visible ? '' : 'none';
    if (!visible) return;
    this.root.style.transform = `translate(${r1(x)}px, ${r1(y)}px)`;
    const rot = r1(rotationDeg);
    if (rot !== this.rotation) {
      this.rotation = rot;
      this.svgRoot.style.transform = rot ? `rotate(${rot}deg)` : '';
      this.layoutLabels();
    }
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

  private layoutPlace(): void {
    // Under the ring with the dial; beside the marker without it.
    if (this.showDial) {
      this.placeEl.style.left = '0px';
      this.placeEl.style.top = `${this.radius + 12}px`;
      this.placeEl.style.transform = 'translateX(-50%)';
    } else {
      this.placeEl.style.left = '18px';
      this.placeEl.style.top = '0px';
      this.placeEl.style.transform = 'translateY(-50%)';
    }
  }

  private drawStatic(): void {
    const R = this.radius;
    this.staticG.replaceChildren();
    this.topG.replaceChildren();
    svg('circle', { r: R, class: 'sfm-dial__disc' }, this.staticG);
    // Faint altitude rings at 30 and 60 degrees (orthographic: R cos h).
    for (const h of [30, 60]) svg('circle', { r: r1(R * Math.cos((h * Math.PI) / 180)), class: 'sfm-dial__alt' }, this.staticG);
    for (let az = 0; az < 360; az += 5) {
      const len = az % 90 === 0 ? 11 : az % 30 === 0 ? 8 : az % 10 === 0 ? 5 : 3;
      const [x1, y1] = ringXY(az, R);
      const [x2, y2] = ringXY(az, R - len);
      svg(
        'line',
        { x1: r1(x1), y1: r1(y1), x2: r1(x2), y2: r1(y2), class: az % 30 === 0 ? 'sfm-dial__tick sfm-dial__tick--major' : 'sfm-dial__tick' },
        this.staticG,
      );
    }
    svg('circle', { r: R, class: 'sfm-dial__ring' }, this.staticG);
    // Compass points and the north mark on top of everything, so lines never hide them.
    for (const [label, az] of [
      ['N', 0],
      ['E', 90],
      ['S', 180],
      ['W', 270],
    ] as const) {
      const [x, y] = ringXY(az, R - 22);
      const t = svg('text', { x: r1(x), y: r1(y), dy: '0.35em', class: `sfm-dial__cardinal${az === 0 ? ' sfm-dial__cardinal--n' : ''}` }, this.topG);
      t.textContent = label;
    }
    svg('path', { d: `M0 ${-R - 12}l5 8h-10Z`, class: 'sfm-dial__north' }, this.topG);
  }

  private drawDay(): void {
    const g = this.dayG;
    g.replaceChildren();
    const day = this.day;
    const R = this.radius;
    if (!day || R <= 0) {
      this.labels.replaceChildren();
      return;
    }
    const name = glyphFor(day.body, day.kind);
    const color = `var(--body-${name})`;

    if (day.band) {
      const d = regionPath(day.band, R);
      if (d) svg('path', { d, class: 'sfm-dial__band', 'fill-rule': 'evenodd' }, g);
    }
    for (const runs of day.solstices ?? []) {
      for (const run of runs) svg('path', { d: pathData(run.map((p) => skyXY(p.alt, p.az, R))), class: 'sfm-dial__solstice' }, g);
    }
    for (const e of day.events) {
      if (e.kind === 'transit') continue;
      const [x, y] = ringXY(e.az, R);
      casedLine(g, `M0 0L${r1(x)} ${r1(y)}`, e.kind === 'rise' ? 'sfm-dial__rise' : 'sfm-dial__set');
    }
    const pathG = svg('g', { style: `color:${color}` }, g);
    for (const run of day.path) casedLine(pathG, pathData(run.map((p) => skyXY(p.alt, p.az, R))), 'sfm-dial__path');
    for (const p of day.hours) {
      const [x, y] = skyXY(p.alt, p.az, R);
      svg('circle', { cx: r1(x), cy: r1(y), r: 2.4, class: 'sfm-dial__hour' }, pathG);
    }
    for (const e of day.events) {
      if (e.kind !== 'transit' || e.alt < 0) continue;
      const [x, y] = skyXY(e.alt, e.az, R);
      svg('path', { d: `M${r1(x)} ${r1(y - 5.5)}l5.5 5.5-5.5 5.5-5.5-5.5Z`, class: 'sfm-dial__transit' }, g);
    }
    if (day.note) {
      const t = svg('text', { x: 0, y: r1(R * 0.55), dy: '0.35em', class: 'sfm-dial__note' }, g);
      t.textContent = day.note;
    }
    this.layoutLabels();
  }

  /** The rise and set labels: HTML, outside the ring, upright whatever the dial's turn. */
  private layoutLabels(): void {
    this.labels.replaceChildren();
    const day = this.day;
    if (!day) return;
    const R = this.radius;
    for (const e of day.events) {
      if (e.kind === 'transit') continue;
      const p = labelPlacement(e.az + this.rotation, R, 12);
      const label = div(`sfm-dial__label sfm-dial__label--${e.kind}`, this.labels);
      label.style.left = `${r1(p.x)}px`;
      label.style.top = `${r1(p.y)}px`;
      label.style.transform = `translate(${p.tx}, ${p.ty})`;
      label.append(icon(e.kind), document.createTextNode(this.compact ? e.time : e.label));
    }
  }

  private drawNow(): void {
    const g = this.nowG;
    g.replaceChildren();
    const day = this.day;
    const now = this.now;
    const R = this.radius;
    if (!day || !now || R <= 0) {
      svg('circle', { r: 4, class: 'sfm-dial__centre' }, g);
      return;
    }
    const name = glyphFor(day.body, day.kind);
    const up = now.alt >= 0;
    const [rx, ry] = ringXY(now.az, R);
    const [x, y] = up ? skyXY(now.alt, now.az, R) : [rx, ry];
    const ray = svg('g', { class: up ? 'sfm-dial__now' : 'sfm-dial__now sfm-dial__now--below', style: `color:var(--body-${name})` }, g);
    // Up: from the observer to the body. Below the horizon: a dimmed ray to the ring.
    casedLine(ray, `M0 0L${r1(up ? rx : rx)} ${r1(up ? ry : ry)}`, 'sfm-dial__ray');
    const glyph = svg('g', { class: up ? 'sfm-dial__body' : 'sfm-dial__body sfm-dial__body--below', transform: `translate(${r1(x)} ${r1(y)})` }, g);
    if (up) svg('circle', { r: 15, class: 'sfm-dial__glow', style: `fill:var(--body-${name})` }, glyph);
    if (name === 'moon') {
      const r = 10;
      svg('circle', { r: r + 1.8, class: 'sfm-dial__moon-halo' }, glyph);
      svg('circle', { r, class: 'sfm-dial__moon-dark' }, glyph);
      const lit = moonLitPath(now.phase?.fraction ?? 1, r);
      if (lit) {
        const limb = now.phase?.limbFromZenithDeg;
        const angle = limb === null || limb === undefined ? -Math.PI / 2 : brightLimbScreenAngle(Math.max(0, now.alt), now.az, limb);
        svg('path', { d: lit, class: 'sfm-dial__moon-lit', transform: `rotate(${r1((angle * 180) / Math.PI)})` }, glyph);
      }
    } else {
      drawGlyph(glyph, name, 0, 0, name === 'sun' ? 26 : 20, { halo: true, color: `var(--body-${name})` });
    }
    svg('circle', { r: 4, class: 'sfm-dial__centre' }, g);
  }
}
