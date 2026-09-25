/**
 * Small SVG builders shared by the charts2 agent's charts (expansion programme Q5): the root
 * element, a year's date axis (month grid and labels, the app's date), polylines that break
 * where data is missing, value axes, and a clip rectangle. OWNER: charts2 agent.
 *
 * Styling is by class only (charts.css, design tokens), so the three themes and pictures
 * (export/png.ts) work unchanged.
 */

import { s } from '../../dom.js';
import { MONTHS_SHORT } from './format.js';
import { pill, round, svgText, uid } from './frame.js';
import { clamp, linearScale, type LinearScale } from './scale.js';
import { daysInYear, monthStarts } from './sun-data.js';

/** The chart's `<svg>`: `role="img"` with a summary for screen readers, or a `group` when it holds controls. */
export function svgRoot(width: number, height: number, label: string, role: 'img' | 'group' = 'img'): SVGSVGElement {
  return s('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role, 'aria-label': label }) as SVGSVGElement;
}

/** A clip path for a rectangle; returns its `<defs>` and the `url(#…)` to use. */
export function clipRect(x: number, y: number, w: number, hgt: number): { defs: SVGElement; url: string } {
  const id = uid('sfc-clip');
  const defs = s('defs');
  const cp = s('clipPath', { id });
  cp.append(s('rect', { x: round(x), y: round(y), width: round(Math.max(0, w)), height: round(Math.max(0, hgt)) }));
  defs.append(cp);
  return { defs, url: `url(#${id})` };
}

/** A path through points; a `null` breaks the line. Empty string when there is nothing to draw. */
export function linePath(points: readonly ([number, number] | null)[]): string {
  let d = '';
  let open = false;
  for (const p of points) {
    if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
      open = false;
      continue;
    }
    d += `${open ? 'L' : 'M'}${round(p[0])} ${round(p[1])}`;
    open = true;
  }
  return d;
}

// ---------------------------------------------------------------------------------------
// A year on the x axis

export interface YearAxis {
  readonly year: number;
  /** Days in the year. */
  readonly n: number;
  /** Day index (0 = the start of 1 January) to x; `xs(i + 0.5)` is the middle of day i. */
  readonly xs: LinearScale;
  readonly x0: number;
  readonly x1: number;
  /** Day indices of the first of each month. */
  readonly months: readonly number[];
}

export function yearAxis(year: number, x0: number, x1: number): YearAxis {
  const n = daysInYear(year);
  return { year, n, xs: linearScale([0, n], [x0, x1]), x0, x1, months: monthStarts(year) };
}

/** Faint vertical lines at the start of each month, from y0 to y1. */
export function monthGrid(axis: YearAxis, y0: number, y1: number): SVGGElement {
  const g = s('g', { class: 'sfc-grid' }) as SVGGElement;
  for (const i of axis.months) {
    if (i === 0) continue;
    const x = round(axis.xs(i)) + 0.5;
    g.append(s('line', { x1: x, x2: x, y1: round(y0), y2: round(y1), class: 'sfc-grid--faint' }));
  }
  return g;
}

export interface MonthLabel {
  readonly el: SVGTextElement;
  readonly x: number;
}

/** Month names centred in each month at `y` (initials when narrow). */
export function monthLabels(axis: YearAxis, y: number, narrow: boolean): { g: SVGGElement; labels: MonthLabel[] } {
  const g = s('g', { class: 'sfc-axis' }) as SVGGElement;
  const labels: MonthLabel[] = [];
  axis.months.forEach((start, m) => {
    const end = axis.months[m + 1] ?? axis.n;
    const x = axis.xs((start + end) / 2);
    const name = MONTHS_SHORT[m]!;
    const t = svgText(x, y, narrow ? name.charAt(0) : name, { 'text-anchor': 'middle' });
    labels.push({ el: t, x });
    g.append(t);
  });
  return { g, labels };
}

/**
 * The app's date on a year axis: a line through the plots and a pill with the date under
 * the axis (month labels under the pill are hidden). Returns the layer.
 */
export function todayOnAxis(
  axis: YearAxis,
  index: number,
  spans: readonly [number, number][],
  labelY: number,
  text: string,
  labels: readonly MonthLabel[],
): SVGGElement {
  const g = s('g', { class: 'sfc-today', 'pointer-events': 'none' }) as SVGGElement;
  if (!(index >= 0 && index < axis.n)) {
    for (const m of labels) m.el.style.visibility = '';
    return g;
  }
  const x = round(axis.xs(index + 0.5));
  for (const [a, b] of spans) g.append(s('line', { x1: x, x2: x, y1: round(a), y2: round(b) }));
  const lp = pill(x, labelY, text, { size: 11, cls: 'sfc-pill--accent' });
  const shift = clamp(x, axis.x0 + lp.box.w / 2, axis.x1 - lp.box.w / 2) - x;
  if (shift) lp.el.setAttribute('transform', `translate(${round(shift)} 0)`);
  g.append(lp.el);
  for (const m of labels) m.el.style.visibility = Math.abs(m.x - (x + shift)) < lp.box.w / 2 + 14 ? 'hidden' : '';
  return g;
}

/** Horizontal grid lines and their labels on the left at the given values. */
export function valueAxis(
  ys: LinearScale,
  values: readonly number[],
  x0: number,
  x1: number,
  format: (v: number) => string,
  options: { strong?: (v: number) => boolean; right?: boolean } = {},
): SVGGElement {
  const g = s('g', {}) as SVGGElement;
  const grid = s('g', { class: 'sfc-grid' });
  const axis = s('g', { class: 'sfc-axis' });
  for (const v of values) {
    const y = round(ys(v)) + 0.5;
    grid.append(s('line', { x1: x0, x2: x1, y1: y, y2: y, class: options.strong?.(v) ? '' : 'sfc-grid--faint' }));
    axis.append(
      options.right
        ? svgText(x1 + 6, y + 3.5, format(v), { 'text-anchor': 'start' })
        : svgText(x0 - 6, y + 3.5, format(v), { 'text-anchor': 'end' }),
    );
  }
  g.append(grid, axis);
  return g;
}

/** A frame rectangle round a plot area. */
export function frameRect(x0: number, y0: number, x1: number, y1: number): SVGElement {
  return s('rect', { class: 'sfc-frame', x: round(x0) + 0.5, y: round(y0) + 0.5, width: round(x1 - x0 - 1), height: round(y1 - y0 - 1) });
}

/** A small panel title inside a chart (above a plot area). */
export function panelTitle(x: number, y: number, text: string, extra?: string): SVGTextElement {
  const t = svgText(x, y, text, { class: 'sfc-panel-title' });
  if (extra) {
    const span = s('tspan', { class: 'sfc-panel-sub', dx: 6 });
    span.textContent = extra;
    t.append(span);
  }
  return t;
}

/** Nice round steps for an axis spanning `span` units with at most `maxTicks` intervals. */
export function niceStep(span: number, maxTicks: number): number {
  const raw = span / Math.max(1, maxTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}
