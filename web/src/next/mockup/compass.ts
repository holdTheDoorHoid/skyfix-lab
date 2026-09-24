/**
 * DESIGN MOCKUP: the compass overlay drawn at the observer on the map — a reference for
 * the map agent (EXPLORER_PLAN §2, Map view). Built from plain data; every colour, dash
 * and halo comes from the theme tokens.
 *
 * Geometry: an azimuthal "dome" over the place. Azimuth is measured clockwise from north
 * (up); the horizon is the ring and the zenith the centre, so a body at altitude `h` is
 * drawn at `R·(90 − h)/90` from the centre. Lines from the centre point along the ground
 * toward sunrise, sunset and the Sun now; today's path and the band swept by the Sun's
 * paths over the year (June to December solstice) are drawn in the dome.
 *
 * Colour is never alone: sunrise is dashed, sunset dotted, "now" solid; each end is
 * labelled with words and a time.
 */

import { h } from '../../dom.js';
import { drawGlyph, type GlyphName } from '../theme/glyphs.js';
import { icon } from '../theme/icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export interface CompassModel {
  /** Horizon ring radius, px. */
  radius: number;
  /** The body's colour token, e.g. `--body-sun`. */
  colorToken: string;
  glyph: GlyphName;
  /** Today's path: apparent altitude and azimuth samples, degrees. */
  path: { alt: readonly number[]; az: readonly number[] };
  /** Samples on the hour along the path (small dots). */
  hourMarks?: readonly { alt: number; az: number }[];
  /** The year's band: the paths on the two solstices, [alt, az] pairs. */
  band?: { summer: readonly (readonly [number, number])[]; winter: readonly (readonly [number, number])[] };
  rise?: { az: number; label: string };
  set?: { az: number; label: string };
  transit?: { alt: number; az: number; label: string };
  now: { alt: number; az: number; label: string };
  /** Show the labels of the directions (hidden on small screens). */
  labels?: boolean;
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

/** Dome projection: altitude and azimuth to x, y (y down) around the centre. */
function dome(alt: number, az: number, r: number): [number, number] {
  const d = (r * (90 - Math.max(-2, alt))) / 90;
  return [d * Math.sin(rad(az)), -d * Math.cos(rad(az))];
}

function ringPoint(az: number, r: number): [number, number] {
  return [r * Math.sin(rad(az)), -r * Math.cos(rad(az))];
}

function pathD(points: readonly [number, number][]): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
}

/** The part of a sampled path above the horizon, with its end points put on the horizon. */
function abovePath(alt: readonly number[], az: readonly number[], r: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < alt.length; i += 1) {
    const a = alt[i]!;
    const prev = i > 0 ? alt[i - 1]! : null;
    if (prev !== null && (prev < 0) !== (a < 0)) {
      const f = prev / (prev - a);
      let z0 = az[i - 1]!;
      let z1 = az[i]!;
      if (Math.abs(z1 - z0) > 180) z1 += z1 < z0 ? 360 : -360;
      out.push(dome(0, z0 + f * (z1 - z0), r));
    }
    if (a >= 0) out.push(dome(a, az[i]!, r));
  }
  return out;
}

/** A line with a dark casing under it, so it reads on any map colour. */
function casedLine(parent: SVGElement, d: string, stroke: string, width: number, dash: string, casing = 3): void {
  parent.appendChild(
    svg('path', {
      d,
      fill: 'none',
      stroke: 'var(--line-halo)',
      'stroke-width': width + casing,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      style: dash === 'none' ? '' : `stroke-dasharray:${dash}`,
      class: 'mk-compass__halo',
    }),
  );
  parent.appendChild(
    svg('path', {
      d,
      fill: 'none',
      stroke,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      style: dash === 'none' ? '' : `stroke-dasharray:${dash}`,
    }),
  );
}

export function drawCompass(model: CompassModel): HTMLElement {
  const R = model.radius;
  const pad = 110;
  const size = 2 * (R + pad);
  const color = `var(${model.colorToken})`;

  const root = svg('svg', {
    class: 'mk-compass__svg',
    width: size,
    height: size,
    viewBox: `${-R - pad} ${-R - pad} ${size} ${size}`,
    'aria-hidden': 'true',
  });

  // Dome
  root.appendChild(svg('circle', { r: R, class: 'mk-compass__disc' }));

  // The year's band between the solstice paths
  if (model.band) {
    const summer = model.band.summer.map(([a, z]) => dome(a, z, R));
    const winter = model.band.winter.map(([a, z]) => dome(a, z, R));
    const arc = (from: number, to: number): [number, number][] => {
      const pts: [number, number][] = [];
      const steps = 12;
      for (let i = 0; i <= steps; i += 1) pts.push(ringPoint(from + ((to - from) * i) / steps, R));
      return pts;
    };
    const sEnd = model.band.summer[model.band.summer.length - 1]![1];
    const wEnd = model.band.winter[model.band.winter.length - 1]![1];
    const sStart = model.band.summer[0]![1];
    const wStart = model.band.winter[0]![1];
    const outline = [...summer, ...arc(sEnd, wEnd), ...[...winter].reverse(), ...arc(wStart, sStart)];
    root.appendChild(svg('path', { d: `${pathD(outline)}Z`, class: 'mk-compass__band' }));
    root.appendChild(svg('path', { d: pathD(summer), class: 'mk-compass__solstice' }));
    root.appendChild(svg('path', { d: pathD(winter), class: 'mk-compass__solstice' }));
  }

  // Altitude rings (30°, 60°) and degree ticks
  for (const alt of [30, 60]) root.appendChild(svg('circle', { r: (R * (90 - alt)) / 90, class: 'mk-compass__alt' }));
  for (let az = 0; az < 360; az += 5) {
    const major = az % 90 === 0;
    const mid = az % 30 === 0;
    const tenth = az % 10 === 0;
    const len = major ? 11 : mid ? 8 : tenth ? 5 : 3;
    const [x1, y1] = ringPoint(az, R);
    const [x2, y2] = ringPoint(az, R - len);
    root.appendChild(
      svg('line', {
        x1: x1.toFixed(1),
        y1: y1.toFixed(1),
        x2: x2.toFixed(1),
        y2: y2.toFixed(1),
        class: major || mid ? 'mk-compass__tick mk-compass__tick--major' : 'mk-compass__tick',
      }),
    );
  }
  root.appendChild(svg('circle', { r: R, class: 'mk-compass__ring' }));

  // Directions along the ground: sunrise (dashed), sunset (dotted), now (solid)
  if (model.rise) {
    const [x, y] = ringPoint(model.rise.az, R);
    casedLine(root, `M0 0L${x.toFixed(1)} ${y.toFixed(1)}`, 'var(--event-rise)', 2.2, 'var(--dash-rise)', 2);
  }
  if (model.set) {
    const [x, y] = ringPoint(model.set.az, R);
    casedLine(root, `M0 0L${x.toFixed(1)} ${y.toFixed(1)}`, 'var(--event-set)', 2.6, 'var(--dash-set)', 2);
  }

  // Today's path
  const path = abovePath(model.path.alt, model.path.az, R);
  casedLine(root, pathD(path), color, 2.6, 'none');
  for (const m of model.hourMarks ?? []) {
    if (m.alt < 0.5) continue;
    const [x, y] = dome(m.alt, m.az, R);
    root.appendChild(svg('circle', { cx: x.toFixed(1), cy: y.toFixed(1), r: 2.4, class: 'mk-compass__hour' }));
  }
  if (model.transit) {
    const [x, y] = dome(model.transit.alt, model.transit.az, R);
    root.appendChild(svg('path', { d: `M${x} ${y - 5.5}l5.5 5.5-5.5 5.5-5.5-5.5Z`, class: 'mk-compass__transit' }));
  }

  const [nx, ny] = ringPoint(model.now.az, R);
  casedLine(root, `M0 0L${nx.toFixed(1)} ${ny.toFixed(1)}`, color, 3, 'none');

  // The body now, in the dome
  const [bx, by] = dome(model.now.alt, model.now.az, R);
  root.appendChild(svg('circle', { cx: bx.toFixed(1), cy: by.toFixed(1), r: 15, class: 'mk-compass__glow', style: `fill:${color}` }));
  drawGlyph(root, model.glyph, bx, by, 26, { halo: true, color });

  // Cardinal points
  for (const [label, az] of [
    ['N', 0],
    ['E', 90],
    ['S', 180],
    ['W', 270],
  ] as const) {
    const [x, y] = ringPoint(az, R - 22);
    const t = svg('text', { x: x.toFixed(1), y: (y + 4.5).toFixed(1), class: `mk-compass__cardinal${az === 0 ? ' mk-compass__cardinal--n' : ''}`, 'paint-order': 'stroke' });
    t.textContent = label;
    root.appendChild(t);
  }
  root.appendChild(svg('path', { d: `M0 ${-R - 11}l5 8h-10Z`, class: 'mk-compass__north' }));

  // The observer
  root.appendChild(svg('circle', { r: 5, class: 'mk-compass__observer' }));

  const el = h('div', { class: 'mk-compass', style: `width:${size}px;height:${size}px` });
  el.appendChild(h('div', { class: 'mk-compass__blur', style: `width:${2 * R}px;height:${2 * R}px` }));
  el.appendChild(root);

  // Labels outside the ring (HTML, so they use the UI font and stay crisp)
  const label = (az: number, kind: string, text: string, iconName: 'rise' | 'set' | 'transit'): void => {
    const [x, y] = ringPoint(az, R + 14);
    const s = Math.sin(rad(az));
    const c = -Math.cos(rad(az));
    const tx = s > 0.3 ? '0%' : s < -0.3 ? '-100%' : '-50%';
    const ty = c > 0.3 ? '0%' : c < -0.3 ? '-100%' : '-50%';
    el.appendChild(
      h(
        'span',
        {
          class: 'mk-compass__label',
          'data-kind': kind,
          style: `left:${(x + R + pad).toFixed(1)}px;top:${(y + R + pad).toFixed(1)}px;transform:translate(${tx},${ty})`,
        },
        icon(iconName),
        text,
      ),
    );
  };
  if (model.labels !== false) {
    if (model.rise) label(model.rise.az, 'rise', model.rise.label, 'rise');
    if (model.set) label(model.set.az, 'set', model.set.label, 'set');
  }
  return el;
}
