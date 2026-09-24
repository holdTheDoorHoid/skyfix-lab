/**
 * The Learn chart: a close-up plotting sheet or a globe, drawn in SVG from a `ChartModel`.
 * OWNER: learn agent.
 *
 * Colours come only from design tokens, through classes in learn.css, so the three themes
 * switch with no script; lines of position carry a dark casing (as map lines do) so any
 * colour reads on any paper. Meaning is never carried by colour alone: every mark has its
 * own shape, lines differ by label, and the legend names each symbol.
 */

import { h, s } from '../../dom.js';
import type { LatLon } from '../../types.js';
import { globeCenter, sheetFrame, type ChartModel, type ChartView } from './chart-model.js';
import { arcmin, candidateLetter, type Fmt } from './facts.js';
import { circleArcNear, distanceM, ellipseRing, fullCircle } from './geo.js';
import { Ortho, SheetProjection, clipPolyline, pathData, r2, ringOnGlobe, visibleRuns, type Rect, type XY } from './project.js';

/** Land outlines for the globe: rings of [lon, lat] (display only, Natural Earth). */
export type LandRings = readonly (readonly (readonly [number, number])[])[];

export interface ChartOptions {
  width: number;
  view: ChartView;
  fmt: Fmt;
  land: LandRings | null;
  /** Unique prefix for ids inside the SVG (clip paths). */
  uid: string;
  /** Emphasise one sight's line (a residual far outside the rest). */
  emphasis?: { id: string; text: string } | null;
}

export interface RenderedChart {
  svg: SVGSVGElement;
  /** One sentence for assistive technology, also used as the figure's accessible name. */
  description: string;
  /** Anything the picture leaves out and the reader should know. */
  note: string | null;
}

// ---------------------------------------------------------------------------------------
// Labels that avoid each other

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

function overlaps(a: Box, b: Box, pad = 2): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** Rough text width (Inter at `size` px) for layout before the text is in the page. */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[ilIj.,:;'’|!()′]/.test(ch) ? 0.3 : /[mwMW@]/.test(ch) ? 0.9 : /[0-9]/.test(ch) ? 0.6 : 0.58;
  return w * size;
}

type Side = 'e' | 'w' | 'n' | 's' | 'ne' | 'nw' | 'se' | 'sw';

class Labeler {
  constructor(
    private readonly layer: SVGElement,
    private readonly bounds: Box,
    /** Occupied areas; pass another labeler's `boxes` to share them across bounds. */
    readonly boxes: Box[] = [],
  ) {}

  /** Reserve an area (a marker) so labels keep off it. */
  block(x: number, y: number, radius: number): void {
    this.boxes.push({ x: x - radius, y: y - radius, w: 2 * radius, h: 2 * radius });
  }

  place(x: number, y: number, text: string, cls: string, sides: readonly Side[] = ['e', 'w', 'n', 's', 'ne', 'se', 'nw', 'sw'], gap = 10): void {
    const size = 11.5;
    const w = textWidth(text, size) + 12;
    const hgt = size + 8;
    const at = (side: Side): Box => {
      const dx = side.includes('e') ? gap : side.includes('w') ? -gap - w : -w / 2;
      const dy = side.startsWith('n') ? -gap - hgt : side.startsWith('s') ? gap : -hgt / 2;
      return { x: x + dx, y: y + dy, w, h: hgt };
    };
    const inside = (b: Box): boolean =>
      b.x >= this.bounds.x && b.y >= this.bounds.y && b.x + b.w <= this.bounds.x + this.bounds.w && b.y + b.h <= this.bounds.y + this.bounds.h;
    let chosen: Box | null = null;
    for (const side of sides) {
      const b = at(side);
      if (inside(b) && !this.boxes.some((o) => overlaps(o, b))) {
        chosen = b;
        break;
      }
    }
    if (!chosen) {
      // Nowhere free: the first side that fits the picture, overlapping if it must.
      chosen = sides.map(at).find(inside) ?? at(sides[0]!);
      chosen = {
        ...chosen,
        x: Math.min(Math.max(chosen.x, this.bounds.x), this.bounds.x + this.bounds.w - chosen.w),
        y: Math.min(Math.max(chosen.y, this.bounds.y), this.bounds.y + this.bounds.h - chosen.h),
      };
    }
    this.boxes.push(chosen);
    const g = s('g', { class: `sfl-ch-pill ${cls}` });
    g.append(s('rect', { x: r2(chosen.x), y: r2(chosen.y), width: r2(chosen.w), height: r2(chosen.h), rx: chosen.h / 2 }));
    const t = s('text', { x: r2(chosen.x + 6), y: r2(chosen.y + chosen.h / 2 + size * 0.36), style: `font-size:${size}px` });
    t.textContent = text;
    g.append(t);
    this.layer.append(g);
  }
}

// ---------------------------------------------------------------------------------------
// Marks

/** The fix: a dot in a circle, the navigator's symbol. */
export function fixMark(x: number, y: number): SVGElement {
  return s(
    'g',
    { class: 'sfl-ch-fix' },
    s('circle', { class: 'sfl-ch-halo', cx: r2(x), cy: r2(y), r: 9 }),
    s('circle', { class: 'sfl-ch-ring', cx: r2(x), cy: r2(y), r: 7 }),
    s('circle', { class: 'sfl-ch-dot', cx: r2(x), cy: r2(y), r: 2.4 }),
  );
}

/** The answer key: an eight-pointed asterisk, used for nothing else. */
export function truthMark(x: number, y: number): SVGElement {
  let d = '';
  for (let i = 0; i < 4; i++) {
    const a = (Math.PI * i) / 4;
    const dx = 8 * Math.cos(a);
    const dy = 8 * Math.sin(a);
    d += `M${r2(x - dx)} ${r2(y - dy)}L${r2(x + dx)} ${r2(y + dy)}`;
  }
  return s('g', { class: 'sfl-ch-truth' }, s('path', { class: 'sfl-ch-halo', d }), s('path', { class: 'sfl-ch-stroke', d }));
}

/** A candidate: a diamond, identical for every candidate (none is promoted). */
export function candidateMark(x: number, y: number): SVGElement {
  const d = `M${r2(x)} ${r2(y - 8)}L${r2(x + 8)} ${r2(y)}L${r2(x)} ${r2(y + 8)}L${r2(x - 8)} ${r2(y)}Z`;
  return s('g', { class: 'sfl-ch-cand' }, s('path', { class: 'sfl-ch-halo', d }), s('path', { class: 'sfl-ch-shape', d }));
}

/** A ground point: a small five-pointed star in the line's colour. */
export function gpMark(x: number, y: number, color: number): SVGElement {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 5;
    const r = i % 2 === 0 ? 7 : 3;
    pts.push(`${r2(x + r * Math.cos(a))},${r2(y + r * Math.sin(a))}`);
  }
  return s('polygon', { class: `sfl-ch-gp sfl-c${color}`, points: pts.join(' ') });
}

export function line(d: string, color: number, extra = ''): SVGElement {
  return s(
    'g',
    { class: `sfl-ch-cop sfl-c${color} ${extra}`.trim() },
    s('path', { class: 'sfl-ch-casing', d }),
    s('path', { class: 'sfl-ch-line', d }),
  );
}

// ---------------------------------------------------------------------------------------
// Close-up sheet

const GRID_STEPS_ARCMIN = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];

function pickStep(spanArcmin: number, maxLines: number): number {
  for (const step of GRID_STEPS_ARCMIN) if (spanArcmin / step <= maxLines) return step;
  return GRID_STEPS_ARCMIN[GRID_STEPS_ARCMIN.length - 1]!;
}

/** "39°57′N", "39°57.5′N", "75°10′W" for grid labels. */
export function gridLabel(value: number, kind: 'lat' | 'lon', stepArcmin: number): string {
  const hemi = kind === 'lat' ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E';
  const digits = stepArcmin < 1 ? 1 : 0;
  const total = Math.round(Math.abs(value) * 60 * 10 ** digits) / 10 ** digits;
  const deg = Math.floor(total / 60 + 1e-9);
  const min = total - deg * 60;
  if (stepArcmin >= 60 && Math.abs(min) < 1e-9) return `${deg}°${hemi}`;
  return `${deg}°${min.toFixed(digits).padStart(digits ? 4 : 2, '0')}′${hemi}`;
}

/**
 * Where a polyline crosses the line `axis = value` (axis 0: x, 1: y); returns the other
 * coordinate there, or null when it does not cross.
 */
function crossing(pts: readonly XY[], axis: 0 | 1, value: number): number | null {
  const other = axis === 0 ? 1 : 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    if ((a[axis] - value) * (b[axis] - value) <= 0 && a[axis] !== b[axis]) {
      const t = (value - a[axis]) / (b[axis] - a[axis]);
      return a[other] + (b[other] - a[other]) * t;
    }
  }
  return null;
}

function niceLength(target: number, units: Fmt['units']): { m: number; label: string } {
  const unit = units === 'nautical' ? 1852 : units === 'imperial' ? 1609.344 : 1;
  const t = target / unit;
  const pow = 10 ** Math.floor(Math.log10(t));
  const mult = [1, 2, 5, 10].find((m) => m * pow >= t * 0.75) ?? 10;
  const v = mult * pow;
  const label =
    units === 'nautical'
      ? `${Number(v.toPrecision(3))} NM`
      : units === 'imperial'
        ? `${Number(v.toPrecision(3))} mi`
        : v >= 1000
          ? `${Number((v / 1000).toPrecision(3))} km`
          : `${Number(v.toPrecision(3))} m`;
  return { m: v * unit, label };
}

function renderSheet(model: ChartModel, opts: ChartOptions): RenderedChart {
  const W = Math.max(300, Math.round(opts.width));
  const narrow = W < 560;
  const H = Math.round(Math.min(560, Math.max(300, W * (narrow ? 0.9 : 0.6))));
  const pad = { l: narrow ? 50 : 62, r: 12, t: 12, b: 26 };
  const rect: Rect = { x: pad.l, y: pad.t, w: W - pad.l - pad.r, h: H - pad.t - pad.b };
  const frame = sheetFrame(model)!;
  const proj = new SheetProjection(frame.origin, frame, rect);
  const svg = s('svg', {
    class: 'sfl-chart sfl-chart--sheet',
    width: W,
    height: H,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
  }) as SVGSVGElement;
  const clipId = `${opts.uid}-clip`;
  svg.append(s('defs', {}, s('clipPath', { id: clipId }, s('rect', { x: rect.x, y: rect.y, width: rect.w, height: rect.h }))));
  svg.append(s('rect', { class: 'sfl-ch-paper', x: rect.x, y: rect.y, width: rect.w, height: rect.h, rx: 4 }));

  // Graticule, in whole arcminutes as on a plotting sheet.
  const corners = [proj.unproject(rect.x, rect.y), proj.unproject(rect.x + rect.w, rect.y), proj.unproject(rect.x, rect.y + rect.h), proj.unproject(rect.x + rect.w, rect.y + rect.h)];
  const lats = corners.map((c) => c.lat_deg);
  const lon0 = frame.origin.lon_deg;
  const lons = corners.map((c) => lon0 + ((((c.lon_deg - lon0 + 540) % 360) + 360) % 360) - 180);
  const latMin = Math.min(...lats);
  const latMax = Math.max(...lats);
  const lonMin = Math.min(...lons);
  const lonMax = Math.max(...lons);
  const latStep = pickStep((latMax - latMin) * 60, narrow ? 5 : 6) / 60;
  const lonStep = pickStep((lonMax - lonMin) * 60, Math.max(3, Math.floor(rect.w / (narrow ? 70 : 88)))) / 60;
  const grid = s('g', { class: 'sfl-ch-grid', 'clip-path': `url(#${clipId})` });
  const labels = s('g', { class: 'sfl-ch-gridlabels' });
  const sample = (a: number, b: number, n: number): number[] => Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n);
  for (let lat = Math.ceil(latMin / latStep - 1e-9) * latStep; lat <= latMax + 1e-12; lat += latStep) {
    const pts = sample(lonMin, lonMax, 16).map((lon) => proj.project({ lat_deg: lat, lon_deg: lon }));
    grid.append(s('path', { d: pathData([pts]) }));
    const y = crossing(pts, 0, rect.x);
    if (y !== null && y > rect.y + 6 && y < rect.y + rect.h - 4) {
      const t = s('text', { x: rect.x - 6, y: r2(y + 4), 'text-anchor': 'end' });
      t.textContent = gridLabel(lat, 'lat', latStep * 60);
      labels.append(t);
    }
  }
  for (let lon = Math.ceil(lonMin / lonStep - 1e-9) * lonStep; lon <= lonMax + 1e-12; lon += lonStep) {
    const pts = sample(latMin, latMax, 16).map((lat) => proj.project({ lat_deg: lat, lon_deg: lon }));
    grid.append(s('path', { d: pathData([pts]) }));
    const x = crossing(pts, 1, rect.y + rect.h);
    if (x !== null && x > rect.x + 22 && x < rect.x + rect.w - 22) {
      const t = s('text', { x: r2(x), y: rect.y + rect.h + 17, 'text-anchor': 'middle' });
      t.textContent = gridLabel(((lon + 540) % 360) - 180, 'lon', lonStep * 60);
      labels.append(t);
    }
  }
  svg.append(grid, labels);

  const marks = s('g', { class: 'sfl-ch-marks' });
  const top = s('g', { class: 'sfl-ch-labels' });
  const labeler = new Labeler(top, { x: rect.x + 2, y: rect.y + 2, w: rect.w - 4, h: rect.h - 4 });

  // Ellipse first, under the lines.
  if (model.ellipse) {
    const ring = ellipseRing(model.ellipse.center, model.ellipse.ellipse, 120).map((p) => proj.project(p));
    marks.append(s('path', { class: 'sfl-ch-ellipse', d: pathData([ring], true), 'clip-path': `url(#${clipId})` }));
  }

  // Lines of position: the piece of each circle that crosses the picture.
  const centre = proj.unproject(rect.x + rect.w / 2, rect.y + rect.h / 2);
  const halfSpan = (Math.hypot(rect.w, rect.h) / proj.k) * 0.8;
  const lop = s('g', { class: 'sfl-ch-lops', 'clip-path': `url(#${clipId})` });
  const lopLabels: { x: number; y: number; text: string; color: number }[] = [];
  for (const c of model.circles) {
    const arc = circleArcNear(c.gp, c.zenithDeg, centre, halfSpan, 48).map((p) => proj.project(p));
    const pieces = clipPolyline(arc, rect);
    if (!pieces.length) continue;
    const emph = opts.emphasis?.id === c.id;
    lop.append(line(pathData(pieces), c.color, emph ? 'sfl-ch-cop--emph' : ''));
    if (c.labelled || emph) {
      // Label where the line leaves the picture on the right (or its end).
      const piece = pieces[0]!;
      const a = piece[0]!;
      const b = piece[piece.length - 1]!;
      const end = a[0] > b[0] ? a : b;
      const inner = a[0] > b[0] ? piece[1]! : piece[piece.length - 2]!;
      const t = 0.1;
      lopLabels.push({
        x: end[0] + (inner[0] - end[0]) * t * 3,
        y: end[1] + (inner[1] - end[1]) * t * 3,
        text: emph && opts.emphasis ? opts.emphasis.text : c.body,
        color: c.color,
      });
    }
  }
  marks.append(lop);

  // The answer key and the error between it and the fix.
  const fixXY = model.fix ? proj.project(model.fix) : null;
  const truthXY = model.truth ? proj.project(model.truth) : null;
  if (fixXY) labeler.block(fixXY[0], fixXY[1], 11);
  if (truthXY) labeler.block(truthXY[0], truthXY[1], 10);
  if (fixXY && truthXY && model.fix && model.truth) {
    const d = distanceM(model.fix, model.truth);
    if (Math.hypot(fixXY[0] - truthXY[0], fixXY[1] - truthXY[1]) > 22) {
      marks.append(s('path', { class: 'sfl-ch-error', d: `M${r2(truthXY[0])} ${r2(truthXY[1])}L${r2(fixXY[0])} ${r2(fixXY[1])}` }));
      labeler.place((fixXY[0] + truthXY[0]) / 2, (fixXY[1] + truthXY[1]) / 2, opts.fmt.dist(d), 'sfl-ch-pill--error', ['n', 's', 'e', 'w', 'ne', 'se']);
    }
  }
  if (truthXY) marks.append(truthMark(truthXY[0], truthXY[1]));
  if (fixXY) marks.append(fixMark(fixXY[0], fixXY[1]));
  svg.append(marks, top);

  if (fixXY) labeler.place(fixXY[0], fixXY[1], 'Fix', 'sfl-ch-pill--fix', ['ne', 'nw', 'se', 'sw', 'e', 'w']);
  if (truthXY) labeler.place(truthXY[0], truthXY[1], 'Truth · answer key', 'sfl-ch-pill--truth', ['se', 'sw', 'ne', 'nw', 's', 'n']);
  if (model.ellipse && fixXY) {
    // Label the ellipse at the end of its major axis.
    const ends = ellipseRing(model.ellipse.center, model.ellipse.ellipse, 4);
    const tip = proj.project(ends[0]!);
    const other = proj.project(ends[2]!);
    const [x, y] = tip[0] >= other[0] ? tip : other;
    labeler.place(x, y, '95 % ellipse', 'sfl-ch-pill--ellipse', ['e', 'ne', 'se', 'n', 's', 'w']);
  }
  for (const l of lopLabels) labeler.place(l.x, l.y, l.text, `sfl-ch-pill--line sfl-c${l.color}`, ['nw', 'sw', 'w', 'n', 's', 'ne', 'se']);

  // Scale bar and north.
  const target = (rect.w * 0.18) / proj.k;
  const nice = niceLength(target, opts.fmt.units);
  const barPx = nice.m * proj.k;
  const bx = rect.x + 14;
  const by = rect.y + rect.h - 16;
  svg.append(
    s(
      'g',
      { class: 'sfl-ch-scale' },
      s('rect', { class: 'sfl-ch-scale-bg', x: bx - 8, y: by - 18, width: r2(barPx + 16), height: 28, rx: 6 }),
      s('path', { d: `M${bx} ${by - 4}V${by}H${r2(bx + barPx)}V${by - 4}` }),
      (() => {
        const t = s('text', { x: r2(bx + barPx / 2), y: by - 7, 'text-anchor': 'middle' });
        t.textContent = nice.label;
        return t;
      })(),
    ),
  );
  const nx = rect.x + rect.w - 18;
  const ny = rect.y + 16;
  svg.append(
    s(
      'g',
      { class: 'sfl-ch-north', 'aria-hidden': 'true' },
      s('path', { d: `M${nx} ${ny - 9}L${nx + 5} ${ny + 5}L${nx} ${ny + 2}L${nx - 5} ${ny + 5}Z` }),
      (() => {
        const t = s('text', { x: nx, y: ny + 18, 'text-anchor': 'middle' });
        t.textContent = 'N';
        return t;
      })(),
    ),
  );

  const parts = [`${model.circles.length} line${model.circles.length === 1 ? '' : 's'} of position`, 'the fix'];
  if (model.ellipse) parts.push('its 95 % ellipse');
  if (model.truth && model.fix) parts.push(`the answer key ${opts.fmt.dist(distanceM(model.fix, model.truth))} away`);
  const description = `Close-up plotting sheet showing ${parts.join(', ')}. Scale bar ${nice.label}.`;
  svg.setAttribute('aria-label', description);
  const note = model.ellipse ? null : `No ellipse is drawn: ${model.suppressedReason ?? 'the core did not emit one'}.`;
  return { svg, description, note };
}

// ---------------------------------------------------------------------------------------
// Globe

function renderGlobe(model: ChartModel, opts: ChartOptions): RenderedChart {
  const W = Math.max(300, Math.round(opts.width));
  const narrow = W < 560;
  const H = Math.round(Math.min(560, Math.max(300, W * (narrow ? 0.95 : 0.6))));
  const r = Math.min(H / 2 - 14, W / 2 - 14);
  const cx = W / 2;
  const cy = H / 2;
  const o = new Ortho(globeCenter(model), r, cx, cy);
  const svg = s('svg', { class: 'sfl-chart sfl-chart--globe', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img' }) as SVGSVGElement;
  svg.append(s('circle', { class: 'sfl-ch-sea', cx: r2(cx), cy: r2(cy), r: r2(r) }));

  if (opts.land) {
    let d = '';
    for (const ring of opts.land) {
      const pts = ringOnGlobe(
        o,
        ring.map(([lon, lat]) => ({ lat_deg: lat, lon_deg: lon })),
      );
      if (pts) d += pathData([pts], true);
    }
    if (d) svg.append(s('path', { class: 'sfl-ch-land', d, 'fill-rule': 'evenodd' }));
  }

  // Graticule every 30 degrees.
  const grat: XY[][] = [];
  for (let lon = -180; lon < 180; lon += 30) {
    const pts: LatLon[] = [];
    for (let lat = -80; lat <= 80; lat += 2) pts.push({ lat_deg: lat, lon_deg: lon });
    grat.push(...visibleRuns(o, pts));
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const pts: LatLon[] = [];
    for (let lon = -180; lon < 180; lon += 3) pts.push({ lat_deg: lat, lon_deg: lon });
    grat.push(...visibleRuns(o, pts, true));
  }
  svg.append(s('path', { class: 'sfl-ch-grat', d: pathData(grat) }));
  svg.append(s('circle', { class: 'sfl-ch-rim', cx: r2(cx), cy: r2(cy), r: r2(r) }));

  const marks = s('g', { class: 'sfl-ch-marks' });
  const top = s('g', { class: 'sfl-ch-labels' });
  const labeler = new Labeler(top, { x: 2, y: 2, w: W - 4, h: H - 4 });

  // Circles, whole.
  const circleLabels: { x: number; y: number; text: string; color: number }[] = [];
  for (const c of model.circles) {
    const runs = visibleRuns(o, fullCircle(c.gp, c.zenithDeg, 360), true);
    if (!runs.length) continue;
    marks.append(line(pathData(runs), c.color, opts.emphasis?.id === c.id ? 'sfl-ch-cop--emph' : ''));
    if (c.labelled) {
      // A point on the longest visible piece, a third of the way along.
      const longest = runs.reduce((a, b) => (b.length > a.length ? b : a));
      const p = longest[Math.floor(longest.length * 0.3)]!;
      circleLabels.push({ x: p[0], y: p[1], text: `${c.body}`, color: c.color });
    }
  }

  // Ground points: where each star is straight overhead.
  const gpLabels: { x: number; y: number; text: string; color: number }[] = [];
  for (const b of model.bodies) {
    const g = o.project(b.gp);
    if (g.z <= 0) continue;
    marks.append(gpMark(g.x, g.y, b.color));
    labeler.block(g.x, g.y, 8);
    gpLabels.push({ x: g.x, y: g.y, text: `${b.body} overhead`, color: b.color });
  }

  const pointLabels: (() => void)[] = [];
  model.candidates.forEach((c, i) => {
    const g = o.project(c);
    if (g.z <= 0) return;
    marks.append(candidateMark(g.x, g.y));
    labeler.block(g.x, g.y, 10);
    pointLabels.push(() => labeler.place(g.x, g.y, `Candidate ${candidateLetter(i)}`, 'sfl-ch-pill--cand', ['e', 'w', 'ne', 'se', 'nw', 'sw']));
  });
  if (model.truth) {
    const g = o.project(model.truth);
    if (g.z > 0) {
      marks.append(truthMark(g.x, g.y));
      labeler.block(g.x, g.y, 9);
      pointLabels.push(() => labeler.place(g.x, g.y, 'Truth · answer key', 'sfl-ch-pill--truth', ['sw', 'se', 's', 'nw', 'ne', 'n']));
    }
  }
  if (model.fix) {
    const g = o.project(model.fix);
    if (g.z > 0) {
      marks.append(fixMark(g.x, g.y));
      labeler.block(g.x, g.y, 10);
      pointLabels.push(() => labeler.place(g.x, g.y, 'Fix', 'sfl-ch-pill--fix', ['ne', 'nw', 'e', 'w']));
    }
  }
  svg.append(marks, top);
  for (const place of pointLabels) place();
  for (const l of gpLabels) labeler.place(l.x, l.y, l.text, `sfl-ch-pill--gp sfl-c${l.color}`, ['e', 'w', 'n', 's', 'ne', 'nw', 'se', 'sw']);
  // Circle labels stay on the globe's disc, next to their line.
  const onDisc = new Labeler(top, { x: cx - r, y: cy - r, w: 2 * r, h: 2 * r }, labeler.boxes);
  for (const l of circleLabels) onDisc.place(l.x, l.y, l.text, `sfl-ch-pill--line sfl-c${l.color}`, ['ne', 'nw', 'se', 'sw', 'e', 'w', 'n', 's']);

  const parts: string[] = [];
  parts.push(`${model.circles.length} circle${model.circles.length === 1 ? '' : 's'} of position`);
  if (model.candidates.length) parts.push(`${model.candidates.length} candidate positions drawn alike`);
  if (model.fix) parts.push('the fix');
  if (model.truth) parts.push('the answer key');
  const description = `Globe showing ${parts.join(', ')}${model.kind === 'underdetermined' ? '; no position, because one sight gives a circle, not a point' : ''}.`;
  svg.setAttribute('aria-label', description);
  let note: string | null = null;
  if (model.kind === 'unique') {
    note = model.ellipse
      ? 'At this scale the 95 % ellipse is smaller than the fix symbol; the close-up shows it.'
      : `No ellipse is drawn: ${model.suppressedReason ?? 'the core did not emit one'}.`;
  } else if (model.kind === 'ambiguous') {
    note = 'No ellipse: there is no single fix to put one round.';
  } else if (model.kind === 'underdetermined') {
    note = 'No fix and no ellipse: one circle is the whole answer.';
  }
  return { svg, description, note };
}

export function renderChart(model: ChartModel, opts: ChartOptions): RenderedChart {
  return opts.view === 'sheet' && model.canSheet ? renderSheet(model, opts) : renderGlobe(model, opts);
}

/** The line to emphasise: the worst residual, when it is far outside the noise (>= 5 σ). */
export function emphasisFor(model: ChartModel, residuals: readonly { id: string; residual_arcmin: number; normalized: number }[]): { id: string; text: string } | null {
  let worst: (typeof residuals)[number] | null = null;
  for (const r of residuals) if (!worst || Math.abs(r.normalized) > Math.abs(worst.normalized)) worst = r;
  if (!worst || Math.abs(worst.normalized) < 5) return null;
  if (!model.circles.some((c) => c.id === worst.id)) return null;
  return { id: worst.id, text: `${worst.id}: ${arcmin(worst.residual_arcmin)} (${Math.abs(worst.normalized).toFixed(1)} σ)` };
}

// ---------------------------------------------------------------------------------------
// Legend

type LegendItem = { key: string; label: string; symbol: SVGElement };

function symbolSvg(...children: SVGElement[]): SVGElement {
  return s('svg', { class: 'sfl-legend__sym', viewBox: '0 0 28 20', width: 28, height: 20, 'aria-hidden': 'true' }, ...children);
}

/** The symbols in this picture, each named in words. */
export function chartLegend(model: ChartModel, view: ChartView): HTMLElement {
  const items: LegendItem[] = [];
  const sheet = view === 'sheet' && model.canSheet;
  items.push({
    key: 'line',
    label: sheet ? 'Line of position: one per sight (a short piece of a huge circle)' : 'Circle of position: one per sight',
    symbol: symbolSvg(line('M2 10H26', 0)),
  });
  if (!sheet && model.bodies.length) {
    items.push({ key: 'gp', label: 'Ground point: where that star is straight overhead', symbol: symbolSvg(gpMark(14, 10, 0)) });
  }
  if (model.fix) items.push({ key: 'fix', label: 'Fix: the solver’s answer', symbol: symbolSvg(fixMark(14, 10)) });
  if (model.ellipse && sheet) {
    items.push({
      key: 'ellipse',
      label: '95 % ellipse (nominal, independent-noise model)',
      symbol: symbolSvg(s('ellipse', { class: 'sfl-ch-ellipse', cx: 14, cy: 10, rx: 11, ry: 6 })),
    });
  }
  if (model.candidates.length) {
    items.push({ key: 'cand', label: 'Candidate: fits the sights as well as any other', symbol: symbolSvg(candidateMark(14, 10)) });
  }
  if (model.truth) {
    items.push({ key: 'truth', label: 'Truth: the simulation’s answer key, never shown to the solver', symbol: symbolSvg(truthMark(14, 10)) });
  }
  return h(
    'ul',
    { class: 'sfl-legend', 'aria-label': 'Key to the picture' },
    ...items.map((i) => h('li', { class: `sfl-legend__item sfl-legend__item--${i.key}` }, i.symbol, h('span', {}, i.label))),
  );
}
