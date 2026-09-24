/**
 * The position plot: a plain SVG equirectangular graticule. No map SDK, no tiles, no
 * network (BRIEF "Interface").
 *
 * Colour never carries meaning on its own. Every circle of position gets its own dash
 * pattern as well as its own Okabe-Ito colour, and every marker is a distinct shape
 * with a text label.
 */

import { s } from '../dom.js';
import { degMin, formatLat, formatLon } from '../format.js';
import {
  fitProjection,
  graticuleStep,
  gridLines,
  projectAndClipRing,
  Projection,
  type Pt,
  type Rect,
} from '../projection.js';
import type { ErrorEllipse, LatLon } from '../types.js';

export const PLOT_WIDTH = 720;
export const PLOT_HEIGHT = 520;

export interface CircleLayer {
  id: string;
  body: string;
  points: LatLon[];
}

export interface PlotSpec {
  circles: CircleLayer[];
  /** The single accepted fix, when there is one. */
  fix: LatLon | null;
  ellipse: { centre: LatLon; ellipse: ErrorEllipse } | null;
  /** Ambiguous candidates. Drawn with EQUAL visual weight; none is promoted. */
  candidates: LatLon[];
  /** Assumed position, hollow, labelled "initializer". */
  assumed: { position: LatLon; role: string } | null;
  /** Simulator only. Never set on the Fix view. */
  truth: LatLon | null;
  /** Extra sentence printed under the plot. */
  caption: string | null;
}

export function emptyPlotSpec(): PlotSpec {
  return {
    circles: [],
    fix: null,
    ellipse: null,
    candidates: [],
    assumed: null,
    truth: null,
    caption: null,
  };
}

export interface PlotView {
  /** 1 = fit to content. Larger zooms in. */
  zoom: number;
  /** Pan offset in degrees (north, east) from the fitted centre. */
  offsetLat: number;
  offsetLon: number;
}

export function defaultPlotView(): PlotView {
  return { zoom: 1, offsetLat: 0, offsetLon: 0 };
}

function allPoints(spec: PlotSpec): Pt[] {
  const points: Pt[] = [];
  for (const circle of spec.circles) points.push(...circle.points);
  if (spec.fix) points.push(spec.fix);
  for (const candidate of spec.candidates) points.push(candidate);
  if (spec.assumed) points.push(spec.assumed.position);
  if (spec.truth) points.push(spec.truth);
  return points;
}

/** Sample the 95 % ellipse in the local tangent plane, then lift it to lat/lon. */
export function ellipsePoints(
  centre: LatLon,
  ellipse: ErrorEllipse,
  n = 72,
): LatLon[] {
  const majorDeg = ellipse.semi_major_m / 1852 / 60;
  const minorDeg = ellipse.semi_minor_m / 1852 / 60;
  const theta = (ellipse.orientation_deg * Math.PI) / 180;
  const cosLat = Math.max(Math.cos((centre.lat_deg * Math.PI) / 180), 1e-6);
  const out: LatLon[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const a = majorDeg * Math.cos(t);
    const b = minorDeg * Math.sin(t);
    // Major axis points along azimuth `theta`: (north, east) = (cos, sin).
    const north = a * Math.cos(theta) - b * Math.sin(theta);
    const east = a * Math.sin(theta) + b * Math.cos(theta);
    out.push({ lat_deg: centre.lat_deg + north, lon_deg: centre.lon_deg + east / cosLat });
  }
  return out;
}

function marker(
  kind: 'fix' | 'candidate' | 'assumed' | 'truth',
  x: number,
  y: number,
  label: string,
): SVGElement {
  const group = s('g', { class: `marker marker-${kind}` });
  if (kind === 'fix') {
    group.appendChild(s('circle', { cx: x, cy: y, r: 6, class: 'marker-shape' }));
    group.appendChild(s('line', { x1: x - 12, y1: y, x2: x + 12, y2: y, class: 'marker-cross' }));
    group.appendChild(s('line', { x1: x, y1: y - 12, x2: x, y2: y + 12, class: 'marker-cross' }));
  } else if (kind === 'candidate') {
    // A diamond, identical for every candidate: no candidate is visually preferred.
    group.appendChild(
      s('polygon', { points: `${x},${y - 8} ${x + 8},${y} ${x},${y + 8} ${x - 8},${y}`, class: 'marker-shape' }),
    );
  } else if (kind === 'assumed') {
    group.appendChild(
      s('rect', { x: x - 6, y: y - 6, width: 12, height: 12, class: 'marker-shape hollow' }),
    );
  } else {
    // Truth: an eight-point asterisk, used nowhere but the Simulator view.
    for (let i = 0; i < 4; i++) {
      const a = (Math.PI * i) / 4;
      group.appendChild(
        s('line', {
          x1: x - 9 * Math.cos(a),
          y1: y - 9 * Math.sin(a),
          x2: x + 9 * Math.cos(a),
          y2: y + 9 * Math.sin(a),
          class: 'marker-cross',
        }),
      );
    }
  }
  group.appendChild(s('text', { x: x + 11, y: y - 9, class: 'marker-label' }, label));
  return group;
}

export function renderPlot(spec: PlotSpec, view: PlotView): SVGSVGElement {
  const rect: Rect = { x: 48, y: 12, width: PLOT_WIDTH - 60, height: PLOT_HEIGHT - 44 };
  const base = fitProjection(allPoints(spec), rect, { padding: 28, minSpanDeg: 0.02 });
  const projection = new Projection(
    base.lat0 + view.offsetLat,
    base.lon0 + view.offsetLon,
    base.scale * view.zoom,
    rect,
  );

  const svg = s('svg', {
    viewBox: `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`,
    class: 'plot',
    role: 'img',
    'aria-label': plotDescription(spec),
  }) as SVGSVGElement;

  svg.appendChild(s('rect', { ...rect, class: 'plot-frame' }));

  // --- graticule -----------------------------------------------------------
  const bounds = projection.bounds();
  const latStep = graticuleStep(bounds.latMax - bounds.latMin);
  const lonStep = graticuleStep((bounds.lonMax - bounds.lonMin) * Math.max(Math.cos((projection.lat0 * Math.PI) / 180), 0.01));
  const grid = s('g', { class: 'graticule' });
  for (const lat of gridLines(bounds.latMin, bounds.latMax, latStep)) {
    const [, y] = projection.project(lat, projection.lon0);
    grid.appendChild(s('line', { x1: rect.x, y1: y, x2: rect.x + rect.width, y2: y }));
    grid.appendChild(
      s('text', { x: rect.x - 6, y: y + 4, class: 'grid-label grid-label-lat' }, degMin(lat, 1)),
    );
  }
  for (const lon of gridLines(bounds.lonMin, bounds.lonMax, lonStep)) {
    const [x] = projection.project(projection.lat0, lon);
    grid.appendChild(s('line', { x1: x, y1: rect.y, x2: x, y2: rect.y + rect.height }));
    grid.appendChild(
      s(
        'text',
        { x, y: rect.y + rect.height + 16, class: 'grid-label grid-label-lon' },
        degMin(lon, 1),
      ),
    );
  }
  svg.appendChild(grid);

  const clip = s('clipPath', { id: 'plot-clip' });
  clip.appendChild(s('rect', { ...rect }));
  svg.appendChild(clip);

  // --- circles of position -------------------------------------------------
  const circles = s('g', { class: 'circles', 'clip-path': 'url(#plot-clip)' });
  spec.circles.forEach((circle, index) => {
    const runs = projectAndClipRing(circle.points, projection, { closed: true });
    for (const run of runs) {
      circles.appendChild(
        s('polyline', {
          points: run.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' '),
          class: `cop cop-${index % 8}`,
        }),
      );
    }
    // Label the first visible piece so the circle is identifiable without the legend.
    const first = runs[0];
    if (first && first.length > 0) {
      const [x, y] = first[Math.floor(first.length / 2)]!;
      circles.appendChild(
        s('text', { x: x + 4, y: y - 4, class: `cop-label cop-${index % 8}` }, circle.body),
      );
    }
  });
  svg.appendChild(circles);

  // --- ellipse -------------------------------------------------------------
  if (spec.ellipse) {
    const runs = projectAndClipRing(
      ellipsePoints(spec.ellipse.centre, spec.ellipse.ellipse),
      projection,
      { closed: true },
    );
    const group = s('g', { class: 'ellipse', 'clip-path': 'url(#plot-clip)' });
    for (const run of runs) {
      group.appendChild(
        s('polyline', { points: run.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ') }),
      );
    }
    svg.appendChild(group);
  }

  // --- markers -------------------------------------------------------------
  const markers = s('g', { class: 'markers', 'clip-path': 'url(#plot-clip)' });
  if (spec.assumed) {
    const [x, y] = projection.projectPoint(spec.assumed.position);
    markers.appendChild(marker('assumed', x, y, spec.assumed.role));
  }
  spec.candidates.forEach((candidate, index) => {
    const [x, y] = projection.projectPoint(candidate);
    markers.appendChild(
      marker('candidate', x, y, `ambiguous ${String.fromCharCode(65 + index)}`),
    );
  });
  if (spec.fix) {
    const [x, y] = projection.projectPoint(spec.fix);
    markers.appendChild(marker('fix', x, y, 'fix'));
  }
  if (spec.truth) {
    const [x, y] = projection.projectPoint(spec.truth);
    markers.appendChild(marker('truth', x, y, 'truth (simulation only)'));
  }
  svg.appendChild(markers);

  return svg;
}

function plotDescription(spec: PlotSpec): string {
  const parts: string[] = [];
  parts.push(`${spec.circles.length} circle${spec.circles.length === 1 ? '' : 's'} of position`);
  if (spec.fix) parts.push(`a fix at ${formatLat(spec.fix.lat_deg)} ${formatLon(spec.fix.lon_deg)}`);
  if (spec.candidates.length > 0) parts.push(`${spec.candidates.length} ambiguous candidates`);
  if (spec.ellipse) parts.push('a 95 % nominal uncertainty ellipse');
  if (spec.truth) parts.push('the simulated truth position');
  return `Position plot showing ${parts.join(', ')}.`;
}
