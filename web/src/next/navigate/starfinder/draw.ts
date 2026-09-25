/**
 * Drawing the star finder (a 2102-D equivalent) from the engine's geometry
 * (`star_finder_geometry`, docs/NAVIGATION_METHODS.md section 11): the base plate (the 58
 * stars on a polar azimuthal-equidistant disc, the Aries index round the rim) and the
 * altitude-azimuth template for the latitude band, set by turning it anticlockwise through
 * `rotation_sign × LHA ♈`. OWNER: navigate2 agent (expansion programme).
 *
 * Coordinates: the geometry's unit disc (x right, y up) to SVG (y down): `(cx + R x, cy − R y)`.
 * A turn anticlockwise on the sheet by θ is SVG `rotate(−θ)`. `templateToBase` does the same
 * turn on numbers, so the test can check that every star sits where the set template reads
 * its altitude and azimuth.
 */

import { s } from '../../../dom.js';
import type { StarFinderGeometry, StarFinderPoint } from '../../engine/types.js';

const D = Math.PI / 180;

/** Local hour angle of Aries from its GHA and an east-positive longitude, [0, 360). */
export function lhaAries(ghaAriesDeg: number, lonDeg: number): number {
  const x = (((ghaAriesDeg + lonDeg) % 360) + 360) % 360;
  return x >= 360 - 1e-12 ? 0 : x;
}

/** The turn that sets the template: degrees anticlockwise on the sheet. */
export function templateTurnDeg(g: Pick<StarFinderGeometry, 'rotation_sign'>, lhaAriesDeg: number): number {
  return g.rotation_sign * lhaAriesDeg;
}

/** A template point, turned as the set template carries it, in the base's frame. */
export function templateToBase(p: StarFinderPoint, turnDeg: number): StarFinderPoint {
  const a = turnDeg * D;
  return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
}

/** The template's point for an altitude and azimuth, by the altitude–azimuth relations (section 11). */
export function templatePoint(g: Pick<StarFinderGeometry, 'template_latitude_deg' | 'side'>, altDeg: number, azDeg: number): StarFinderPoint {
  const phi = g.template_latitude_deg * D;
  const h = altDeg * D;
  const A = azDeg * D;
  const sinDec = Math.sin(phi) * Math.sin(h) + Math.cos(phi) * Math.cos(h) * Math.cos(A);
  const dec = Math.asin(Math.max(-1, Math.min(1, sinDec)));
  const t = Math.atan2(-Math.cos(h) * Math.sin(A), Math.cos(phi) * Math.sin(h) - Math.sin(phi) * Math.cos(h) * Math.cos(A));
  const r = g.side === 'north' ? (90 - dec / D) / 180 : (90 + dec / D) / 180;
  return g.side === 'north' ? [r * Math.cos(t), -r * Math.sin(t)] : [r * Math.cos(t), r * Math.sin(t)];
}

const n2 = (v: number): string => v.toFixed(2);

interface Frame {
  cx: number;
  cy: number;
  R: number;
}

const X = (f: Frame, p: StarFinderPoint): number => f.cx + f.R * p[0];
const Y = (f: Frame, p: StarFinderPoint): number => f.cy - f.R * p[1];

function poly(f: Frame, pts: readonly StarFinderPoint[], cls: string, closed = false): SVGElement {
  const d = pts.map((p) => `${n2(X(f, p))},${n2(Y(f, p))}`).join(' ');
  return s(closed ? 'polygon' : 'polyline', { points: d, class: cls });
}

function text(x: number, y: number, t: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'middle'): SVGElement {
  const el = s('text', { x: n2(x), y: n2(y), class: cls, 'text-anchor': anchor });
  el.textContent = t;
  return el;
}

/** The dot's radius for a star's magnitude, in drawing units. */
export function starRadius(magnitude: number, R: number): number {
  return Math.max(1.3, Math.min(4.4, 3.6 - 0.95 * magnitude)) * (R / 260);
}

/** The base plate: rim and Aries index, declination circles, the stars with their names. */
export function drawBase(g: StarFinderGeometry, f: Frame, options: { names?: boolean } = {}): SVGElement {
  const side = g.side;
  const group = s('g', { class: 'sfn-sf__base' });
  group.append(s('circle', { cx: f.cx, cy: f.cy, r: n2(f.R), class: 'sfn-sf__plate' }));
  // Declination circles every 30° (the equator stronger), and their labels on the 270° line.
  for (const dec of [60, 30, 0, -30, -60]) {
    const r = side === 'north' ? (90 - dec) / 180 : (90 + dec) / 180;
    group.append(s('circle', { cx: f.cx, cy: f.cy, r: n2(f.R * r), class: dec === 0 ? 'sfn-sf__equator' : 'sfn-sf__dec' }));
    group.append(text(f.cx + 3, f.cy + f.R * r - 3, dec === 0 ? 'equator' : `${dec > 0 ? '+' : '−'}${Math.abs(dec)}°`, 'sfn-sf__declabel', 'start'));
  }
  // The Aries index: graduations outward from the rim; figures every 10°.
  for (const tick of g.aries_index) {
    const p = side === 'north' ? tick.north : tick.south;
    const len = tick.kind === 'label' ? 0.06 : tick.kind === 'major' ? 0.04 : 0.022;
    group.append(s('line', { x1: n2(X(f, p)), y1: n2(Y(f, p)), x2: n2(X(f, [p[0] * (1 + len), p[1] * (1 + len)])), y2: n2(Y(f, [p[0] * (1 + len), p[1] * (1 + len)])), class: `sfn-sf__tick sfn-sf__tick--${tick.kind}` }));
    if (tick.kind === 'label') {
      const q: StarFinderPoint = [p[0] * 1.115, p[1] * 1.115];
      group.append(text(X(f, q), Y(f, q) + 3.5, String(Math.round(tick.lha_aries_deg)), 'sfn-sf__index'));
    }
  }
  // The pole, and the pin's hole.
  group.append(s('circle', { cx: f.cx, cy: f.cy, r: 2, class: 'sfn-sf__pole' }));
  group.append(text(f.cx, f.cy - 7, side === 'north' ? 'N pole' : 'S pole', 'sfn-sf__declabel'));
  // The stars.
  const stars = s('g', { class: 'sfn-sf__stars' });
  for (const star of g.stars) {
    const p = side === 'north' ? star.north : star.south;
    const x = X(f, p);
    const y = Y(f, p);
    stars.append(s('circle', { cx: n2(x), cy: n2(y), r: n2(starRadius(star.magnitude, f.R)), class: 'sfn-sf__star' }));
    if (options.names !== false) stars.append(text(x + 4.5, y + 3, star.name, 'sfn-sf__name', 'start'));
  }
  group.append(stars);
  return group;
}

/** The template for the band: horizon, altitude circles, azimuth lines, zenith, the arrow. */
export function drawTemplate(g: StarFinderGeometry, f: Frame): SVGElement {
  const t = g.template;
  const group = s('g', { class: 'sfn-sf__template' });
  for (const line of t.azimuth_lines) {
    group.append(poly(f, line.points, `sfn-sf__az${line.value_deg % 30 === 0 ? ' sfn-sf__az--major' : ''}`));
    if (line.value_deg % 30 === 0 && line.points[0]) {
      const p = line.points[0];
      group.append(text(X(f, p), Y(f, p) + 3, String(Math.round(line.value_deg)).padStart(3, '0'), 'sfn-sf__tlabel'));
    }
  }
  for (const circle of t.altitude_circles) {
    group.append(poly(f, circle.points, `sfn-sf__alt${circle.value_deg % 10 === 0 ? ' sfn-sf__alt--major' : ''}`, true));
    // Labelled every 10° where the circle crosses the meridian beyond the zenith (azimuth 180° north, 0° south).
    const at = circle.points[g.side === 'north' ? 36 : 0];
    if (circle.value_deg % 10 === 0 && at) group.append(text(X(f, at), Y(f, at) - 2, `${circle.value_deg}°`, 'sfn-sf__tlabel'));
  }
  group.append(poly(f, t.horizon, 'sfn-sf__horizon', true));
  const z = t.zenith;
  group.append(s('path', { d: `M${n2(X(f, z) - 5)} ${n2(Y(f, z))}H${n2(X(f, z) + 5)}M${n2(X(f, z))} ${n2(Y(f, z) - 5)}V${n2(Y(f, z) + 5)}`, class: 'sfn-sf__zenith' }));
  // The arrow, the template's +x axis: it points at LHA ♈ on the base's index.
  group.append(s('line', { x1: f.cx, y1: f.cy, x2: n2(f.cx + f.R * 1.0), y2: f.cy, class: 'sfn-sf__arrow' }));
  group.append(s('path', { d: `M${n2(f.cx + f.R)} ${f.cy}l-10 -5v10z`, class: 'sfn-sf__arrowhead' }));
  group.append(s('circle', { cx: f.cx, cy: f.cy, r: 2, class: 'sfn-sf__pole' }));
  return group;
}

/**
 * The finder on screen: the base, and the template over it turned for `lhaAriesDeg`
 * (`setTurn` turns it again; one attribute, cheap enough for every frame).
 */
export function starFinderSvg(g: StarFinderGeometry, size = 600, lhaAriesDeg = 0): { svg: SVGSVGElement; setLha(lha: number): void } {
  const f: Frame = { cx: size / 2, cy: size / 2, R: size / 2 - 40 };
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: 'sfn-starfinder', role: 'img' }) as SVGSVGElement;
  svg.append(drawBase(g, f));
  const template = drawTemplate(g, f);
  const holder = s('g', { class: 'sfn-sf__turn' });
  holder.append(template);
  svg.append(holder);
  const setLha = (lha: number): void => {
    holder.setAttribute('transform', `rotate(${n2(-templateTurnDeg(g, lha))} ${f.cx} ${f.cy})`);
    svg.setAttribute('aria-label', `Star finder for ${Math.abs(g.template_latitude_deg)}° ${g.side === 'north' ? 'N' : 'S'}, set to LHA of Aries ${lha.toFixed(1)}°: the template’s altitude circles and azimuth lines over the 58 navigational stars.`);
  };
  setLha(lhaAriesDeg);
  return { svg, setLha };
}

/** One printed disc (the base, or the template alone), `size` drawing units across. */
export function printedDisc(g: StarFinderGeometry, which: 'base' | 'template', size = 600): SVGSVGElement {
  const f: Frame = { cx: size / 2, cy: size / 2, R: size / 2 - 40 };
  const svg = s('svg', { viewBox: `0 0 ${size} ${size}`, class: `sfn-starfinder sfn-starfinder--print sfn-starfinder--${which}`, role: 'img' }) as SVGSVGElement;
  if (which === 'base') {
    svg.append(drawBase(g, f));
    svg.setAttribute('aria-label', `Star finder base plate, ${g.side} side: the 58 navigational stars and the Aries index.`);
  } else {
    // The rim and the centre, to lay it on the base; then the template itself.
    svg.append(s('circle', { cx: f.cx, cy: f.cy, r: n2(f.R), class: 'sfn-sf__rim' }), drawTemplate(g, f));
    svg.setAttribute('aria-label', `Star finder template for latitude ${Math.abs(g.template_latitude_deg)}° ${g.side === 'north' ? 'N' : 'S'}.`);
  }
  return svg;
}
