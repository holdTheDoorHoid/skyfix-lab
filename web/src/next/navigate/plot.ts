/**
 * The Navigate view's position plot: circles of position (at fix scale, lines of
 * position), the fix and its nominal 95 % ellipse, ambiguous candidates drawn identically,
 * rejected alternatives, the assumed position, and latitude lines for a noon or Polaris
 * sight. Plain SVG on the old workbench's projection (`src/projection.ts`: equirectangular
 * with east-west scaled by cos(latitude), antimeridian-safe clipping), drawn with the
 * design system's tokens. OWNER: navigate agent.
 *
 * Colour is never the only cue: each circle has its body's colour AND the dash-dot line
 * style AND a text label; markers differ in shape (fix: ringed cross, candidate: diamond,
 * alternative: small hollow circle, assumed position: hollow square) and every marker is
 * labelled.
 */

import { s } from '../../dom.js';
import { ellipsePoints } from '../../plot/graticule.js';
import {
  fitProjection,
  graticuleStep,
  gridLines,
  norm180,
  projectAndClipRing,
  Projection,
  type Pt,
  type Rect,
} from '../../projection.js';
import type { ErrorEllipse, LatLon } from '../../types.js';
import type { BodyKind } from '../engine/types.js';
import type { AngleFormat } from '../state.js';
import { glyphFor } from '../theme/glyphs.js';
import { fmtLatitude, fmtLongitude } from './format.js';

export interface PlotCircle {
  id: string;
  body: string;
  kind?: BodyKind;
  points: LatLon[];
}

export interface PlotSpec {
  circles: PlotCircle[];
  fix: LatLon | null;
  fixLabel: string;
  ellipse: { centre: LatLon; ellipse: ErrorEllipse } | null;
  /** Ambiguous candidates: equal visual weight, none promoted. */
  candidates: LatLon[];
  /** Rejected minima of a unique fix. */
  alternatives: { position: LatLon; delta_chi2: number }[];
  assumed: { position: LatLon; role: string } | null;
  /** Latitude lines with their 1-sigma band (arcminutes). */
  parallels: { lat_deg: number; sigma_arcmin: number; label: string; body: string }[];
  /** Longitude lines with their 1-sigma band (arcminutes of longitude). */
  meridians: { lon_deg: number; sigma_arcmin: number; label: string }[];
}

export function emptyPlotSpec(): PlotSpec {
  return { circles: [], fix: null, fixLabel: 'Fix', ellipse: null, candidates: [], alternatives: [], assumed: null, parallels: [], meridians: [] };
}

export interface PlotView {
  zoom: number;
  offsetLat: number;
  offsetLon: number;
}

export const defaultPlotView = (): PlotView => ({ zoom: 1, offsetLat: 0, offsetLon: 0 });

/** Rough distance in nautical miles between two nearby positions (for framing only). */
function roughNm(a: Pt, b: Pt): number {
  const dLat = a.lat_deg - b.lat_deg;
  const dLon = norm180(a.lon_deg - b.lon_deg) * Math.cos((((a.lat_deg + b.lat_deg) / 2) * Math.PI) / 180);
  return 60 * Math.hypot(dLat, dLon);
}

/**
 * What the default view frames. A unique fix is centred with its ellipse and the circles
 * crossing round it; the assumed position joins the frame only when it is close (within
 * max(8 NM, 4 semi-major axes)), otherwise an arrow at the edge points to it. Ambiguous
 * candidates are framed together, whatever the distance. With no point at all (an
 * underdetermined circle), the circles themselves.
 */
export function plotAnchors(spec: PlotSpec): Pt[] {
  const anchors: Pt[] = [];
  if (spec.fix) {
    anchors.push(spec.fix);
    if (spec.ellipse) {
      // The ellipse at twice its size, so it sits inside the frame with room round it.
      const e = spec.ellipse.ellipse;
      anchors.push(...ellipsePoints(spec.ellipse.centre, { ...e, semi_major_m: e.semi_major_m * 2, semi_minor_m: e.semi_minor_m * 2 }, 16));
    }
    if (spec.assumed && assumedIsNear(spec)) anchors.push(spec.assumed.position);
    return anchors;
  }
  anchors.push(...spec.candidates);
  if (spec.assumed) anchors.push(spec.assumed.position);
  const refLon = spec.assumed?.position.lon_deg ?? spec.meridians[0]?.lon_deg ?? 0;
  for (const p of spec.parallels) anchors.push({ lat_deg: p.lat_deg, lon_deg: refLon });
  if (anchors.length > 0) return anchors;
  return spec.circles.flatMap((c) => c.points);
}

/** True when the assumed position is close enough to the fix to share its frame. */
export function assumedIsNear(spec: PlotSpec): boolean {
  if (!spec.fix || !spec.assumed) return true;
  const semiMajorNm = spec.ellipse ? spec.ellipse.ellipse.semi_major_m / 1852 : 0;
  return roughNm(spec.fix, spec.assumed.position) <= Math.max(8, 4 * semiMajorNm);
}

/** A short text description of the plot for assistive technology. */
export function plotDescription(spec: PlotSpec, format: AngleFormat): string {
  const parts: string[] = [`${spec.circles.length} circle${spec.circles.length === 1 ? '' : 's'} of position`];
  if (spec.fix) parts.push(`the fix at ${fmtLatitude(spec.fix.lat_deg, format)} ${fmtLongitude(spec.fix.lon_deg, format)}`);
  if (spec.ellipse) parts.push('its nominal 95 % ellipse');
  if (spec.candidates.length) parts.push(`${spec.candidates.length} ambiguous candidates drawn alike`);
  if (spec.alternatives.length) parts.push(`${spec.alternatives.length} rejected alternatives`);
  if (spec.parallels.length) parts.push(`latitude ${fmtLatitude(spec.parallels[0]!.lat_deg, format)}`);
  if (spec.assumed) parts.push('the assumed position');
  return `Position plot: ${parts.join(', ')}.`;
}

const f2 = (v: number): string => v.toFixed(2);
const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const compass = (deg: number): string => POINTS[Math.round((((deg % 360) + 360) % 360) / 45) % 8]!;
const points = (run: [number, number][]): string => run.map(([x, y]) => `${f2(x)},${f2(y)}`).join(' ');

function label(x: number, y: number, text: string, cls: string, anchor: 'start' | 'end' | 'middle' = 'start'): SVGElement {
  const t = s('text', { x: f2(x), y: f2(y), class: cls, 'text-anchor': anchor });
  t.textContent = text;
  return t;
}

/** Render the plot into an SVG `width` × `height` pixels. */
export function renderPositionPlot(
  spec: PlotSpec,
  view: PlotView,
  size: { width: number; height: number },
  format: AngleFormat = 'dm',
): SVGSVGElement {
  const width = Math.max(260, Math.round(size.width));
  const height = Math.max(220, Math.round(size.height));
  const left = width < 420 ? 62 : 76;
  const rect: Rect = { x: left, y: 10, width: width - left - 10, height: height - 36 };
  const base = fitProjection(plotAnchors(spec), rect, { padding: 40, minSpanDeg: 0.15 });
  const projection = new Projection(base.lat0 + view.offsetLat, base.lon0 + view.offsetLon, base.scale * view.zoom, rect);

  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'sfn-plot',
    role: 'img',
    'aria-label': plotDescription(spec, format),
  }) as SVGSVGElement;
  // Pixels per degree, for panning by pointer and keyboard.
  svg.dataset.scale = String(projection.scale);
  svg.dataset.scaleLon = String(projection.scaleLon);
  const clipId = `sfn-clip-${Math.random().toString(36).slice(2, 9)}`;
  const clip = s('clipPath', { id: clipId });
  clip.appendChild(s('rect', { ...rect }));
  svg.appendChild(clip);
  svg.appendChild(s('rect', { ...rect, class: 'sfn-plot__frame' }));

  // Graticule, labelled like a chart's border: whole degrees as 39° N, 075° W; finer steps
  // in degrees and minutes. Steps widen until the labels fit.
  const b = projection.bounds();
  const STEPS = [0.5 / 60, 1 / 60, 2 / 60, 5 / 60, 10 / 60, 0.25, 0.5, 1, 2, 5, 10, 20, 30];
  const wider = (step: number, pxPerDeg: number, minPx: number): number => {
    let out = step;
    for (const st of STEPS) if (st >= out && st * pxPerDeg >= minPx) return st;
    while (out * pxPerDeg < minPx && out < 90) out *= 2;
    return out;
  };
  const latStep = wider(graticuleStep(b.latMax - b.latMin, width < 420 ? 2 : 3), projection.scale, 34);
  const lonStep = wider(graticuleStep((b.lonMax - b.lonMin) * Math.max(Math.cos((projection.lat0 * Math.PI) / 180), 0.01), width < 420 ? 2 : 3), projection.scaleLon, width < 420 ? 74 : 90);
  const tick = (value: number, kind: 'lat' | 'lon', step: number): string => {
    if (format === 'decimal') {
      const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
      return kind === 'lat' ? fmtLatitude(value, 'decimal', digits) : fmtLongitude(value, 'decimal', digits);
    }
    if (step >= 1 - 1e-9) {
      const a = Math.round(Math.abs(value));
      const hemi = kind === 'lat' ? (value < 0 ? 'S' : 'N') : value < 0 && a !== 180 ? 'W' : a === 0 || a === 180 ? '' : 'E';
      return `${kind === 'lon' ? String(a).padStart(3, '0') : a}° ${hemi}`.trim();
    }
    const digits = step < 1 / 60 - 1e-12 ? 1 : 0;
    return kind === 'lat' ? fmtLatitude(value, 'dm', digits) : fmtLongitude(value, 'dm', digits);
  };
  const grid = s('g', { class: 'sfn-plot__grid' });
  for (const lat of gridLines(b.latMin, b.latMax, latStep)) {
    if (lat < -90 || lat > 90) continue;
    const [, y] = projection.project(lat, projection.lon0);
    grid.appendChild(s('line', { x1: rect.x, y1: f2(y), x2: rect.x + rect.width, y2: f2(y) }));
    grid.appendChild(label(rect.x - 5, y + 4, tick(lat, 'lat', latStep), 'sfn-plot__tick', 'end'));
  }
  for (const lon of gridLines(b.lonMin, b.lonMax, lonStep)) {
    const [x] = projection.project(projection.lat0, lon);
    grid.appendChild(s('line', { x1: f2(x), y1: rect.y, x2: f2(x), y2: rect.y + rect.height }));
    grid.appendChild(label(x, rect.y + rect.height + 16, tick(norm180(lon), 'lon', lonStep), 'sfn-plot__tick', 'middle'));
  }
  svg.appendChild(grid);

  /** A marker's label, on whichever side keeps it inside the frame. */
  const side = (x: number, y: number, text: string, cls: string, dy = -9): SVGElement => {
    const w = text.length * 6.6;
    const roomRight = rect.x + rect.width - 4 - (x + 12);
    const roomLeft = x - 12 - (rect.x + 4);
    const right = w <= roomRight || (w > roomLeft && roomRight >= roomLeft);
    const yy = Math.min(Math.max(y + dy, rect.y + 12), rect.y + rect.height - 4);
    return label(right ? x + 12 : x - 12, yy, text, cls, right ? 'start' : 'end');
  };

  const layer = s('g', { 'clip-path': `url(#${clipId})` });
  svg.appendChild(layer);

  // Latitude and longitude lines with their 1-sigma bands (noon, Polaris).
  for (const p of spec.parallels) {
    const cls = `sfn-plot__line sfn-b-${glyphFor(p.body)}`;
    const [, y] = projection.project(p.lat_deg, projection.lon0);
    const band = (p.sigma_arcmin / 60) * projection.scale;
    if (band >= 1) {
      layer.appendChild(s('rect', { x: rect.x, y: f2(y - band), width: rect.width, height: f2(2 * band), class: `${cls} sfn-plot__band` }));
    }
    layer.appendChild(s('line', { x1: rect.x, y1: f2(y), x2: rect.x + rect.width, y2: f2(y), class: `${cls} sfn-plot__parallel` }));
    layer.appendChild(label(rect.x + 6, y - 6, p.label, `sfn-plot__label ${cls}`));
  }
  for (const m of spec.meridians) {
    const [x] = projection.project(projection.lat0, m.lon_deg);
    const band = (m.sigma_arcmin / 60) * projection.scaleLon;
    if (band >= 1) layer.appendChild(s('rect', { x: f2(x - band), y: rect.y, width: f2(2 * band), height: rect.height, class: 'sfn-plot__band sfn-plot__band--lon' }));
    layer.appendChild(s('line', { x1: f2(x), y1: rect.y, x2: f2(x), y2: rect.y + rect.height, class: 'sfn-plot__meridian' }));
    layer.appendChild(label(x + 6, rect.y + 14, m.label, 'sfn-plot__label'));
  }

  // Circles of position: body colour, dash-dot, labelled.
  spec.circles.forEach((c) => {
    const cls = `sfn-b-${glyphFor(c.body, c.kind)}`;
    const runs = projectAndClipRing(c.points, projection, { closed: true });
    for (const run of runs) {
      layer.appendChild(s('polyline', { points: points(run), class: `sfn-plot__cop-halo` }));
      layer.appendChild(s('polyline', { points: points(run), class: `sfn-plot__cop ${cls}` }));
    }
    const first = runs.find((r) => r.length > 4) ?? runs[0];
    if (first && first.length) {
      const [x, y] = first[Math.floor(first.length * 0.35)]!;
      layer.appendChild(label(x + 5, y - 5, c.body, `sfn-plot__label sfn-plot__cop-label ${cls}`));
    }
  });

  if (spec.ellipse) {
    for (const run of projectAndClipRing(ellipsePoints(spec.ellipse.centre, spec.ellipse.ellipse, 96), projection, { closed: true })) {
      layer.appendChild(s('polygon', { points: points(run), class: 'sfn-plot__ellipse' }));
    }
  }

  const marks = s('g', { class: 'sfn-plot__marks' });
  layer.appendChild(marks);
  if (spec.assumed) {
    const [x, y] = projection.projectPoint(spec.assumed.position);
    const inside = x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height;
    if (inside) {
      marks.appendChild(s('rect', { x: f2(x - 6), y: f2(y - 6), width: 12, height: 12, class: 'sfn-plot__assumed' }));
      marks.appendChild(side(x, y, spec.assumed.role, 'sfn-plot__label sfn-plot__label--muted', 18));
    } else {
      // Off the chart: an arrow at the edge, pointing to it, with its distance.
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      const k = Math.min((rect.width / 2 - 18) / Math.max(Math.abs(dx), 1e-9), (rect.height / 2 - 18) / Math.max(Math.abs(dy), 1e-9));
      const ex = cx + dx * k;
      const ey = cy + dy * k;
      const a = Math.atan2(dy, dx);
      const tip = (r: number, da: number) => `${f2(ex + r * Math.cos(a + da))},${f2(ey + r * Math.sin(a + da))}`;
      marks.appendChild(s('polygon', { points: `${tip(9, 0)} ${tip(9, 2.5)} ${tip(9, -2.5)}`, class: 'sfn-plot__pointer' }));
      const ref = spec.fix ?? projection.unproject(cx, cy);
      const nm = roughNm(ref, spec.assumed.position);
      const bearing = (Math.atan2(dx, -dy) * 180) / Math.PI;
      const text = `${spec.assumed.role}: ${nm < 10 ? nm.toFixed(1) : nm.toFixed(0)} NM ${compass(bearing)}`;
      const anchor = ex > cx + rect.width / 4 ? 'end' : ex < cx - rect.width / 4 ? 'start' : 'middle';
      marks.appendChild(label(ex + (anchor === 'end' ? -14 : anchor === 'start' ? 14 : 0), ey + (ey > cy ? -14 : 22), text, 'sfn-plot__label sfn-plot__label--muted', anchor));
    }
  }
  for (const a of spec.alternatives) {
    const [x, y] = projection.projectPoint(a.position);
    marks.appendChild(s('circle', { cx: f2(x), cy: f2(y), r: 5, class: 'sfn-plot__alternative' }));
    marks.appendChild(side(x, y, `rejected (Δχ² ${a.delta_chi2.toFixed(1)})`, 'sfn-plot__label sfn-plot__label--muted', 4));
  }
  spec.candidates.forEach((c, i) => {
    const [x, y] = projection.projectPoint(c);
    marks.appendChild(s('polygon', { points: `${f2(x)},${f2(y - 9)} ${f2(x + 9)},${f2(y)} ${f2(x)},${f2(y + 9)} ${f2(x - 9)},${f2(y)}`, class: 'sfn-plot__candidate' }));
    marks.appendChild(side(x, y, `Candidate ${String.fromCharCode(65 + i)}`, 'sfn-plot__label sfn-plot__label--strong', -10));
  });
  if (spec.fix) {
    const [x, y] = projection.projectPoint(spec.fix);
    marks.appendChild(s('circle', { cx: f2(x), cy: f2(y), r: 7, class: 'sfn-plot__fix' }));
    marks.appendChild(s('path', { d: `M${f2(x - 13)} ${f2(y)}H${f2(x + 13)}M${f2(x)} ${f2(y - 13)}V${f2(y + 13)}`, class: 'sfn-plot__fix-cross' }));
    marks.appendChild(side(x, y, spec.fixLabel, 'sfn-plot__label sfn-plot__label--strong', -11));
  }

  // Scale bar in nautical miles (1′ of latitude = 1 NM), when it fits.
  const nmPerPx = 60 / projection.scale;
  const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];
  const target = rect.width * 0.22 * nmPerPx;
  const bar = [...nice].reverse().find((v) => v <= target);
  if (bar && nmPerPx < 200) {
    const px = bar / nmPerPx;
    const x0 = rect.x + rect.width - px - 12;
    const y0 = rect.y + rect.height - 12;
    const g = s('g', { class: 'sfn-plot__scale' });
    g.appendChild(s('path', { d: `M${f2(x0)} ${f2(y0 - 4)}V${f2(y0)}H${f2(x0 + px)}V${f2(y0 - 4)}` }));
    g.appendChild(label(x0 + px / 2, y0 - 7, `${bar} NM`, 'sfn-plot__tick', 'middle'));
    svg.appendChild(g);
  }
  return svg;
}
