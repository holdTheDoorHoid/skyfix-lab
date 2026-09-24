/**
 * The altitude-against-time chart for a noon run and for averaging a run: each sight's
 * observed altitude Ho with its ±1 sigma bar, the engine's model curve, and the instants
 * that matter (meridian passage, the peak, the averaged sight). Plain SVG, design tokens.
 * OWNER: navigate agent.
 *
 * A sight left out of a fit is drawn hollow AND labelled "left out"; colour is never the
 * only cue.
 */

import { s } from '../../dom.js';
import type { AngleFormat } from '../state.js';
import { glyphFor } from '../theme/glyphs.js';
import { fmtAngle } from './format.js';

export interface CurvePointSpec {
  minutes: number;
  altitude_deg: number;
  sigma_arcmin: number;
  used: boolean;
  label: string;
}

export interface CurveSpec {
  body: string;
  /** What minute zero is ("meridian passage", "the averaged sight's time"). */
  zeroLabel: string;
  points: CurvePointSpec[];
  model: { minutes: number; altitude_deg: number }[];
  /** Vertical marks. */
  marks: { minutes: number; label: string }[];
  /** Horizontal marks. */
  levels: { altitude_deg: number; label: string }[];
  /** A result drawn as a diamond with its sigma (the averaged sight). */
  result: { minutes: number; altitude_deg: number; sigma_arcmin: number; label: string } | null;
}

const f2 = (v: number): string => v.toFixed(2);

function text(x: number, y: number, content: string, cls: string, anchor: 'start' | 'middle' | 'end' = 'start'): SVGElement {
  const t = s('text', { x: f2(x), y: f2(y), class: cls, 'text-anchor': anchor });
  t.textContent = content;
  return t;
}

function niceStep(span: number, lines: number): number {
  const raw = span / Math.max(lines, 1);
  const pow = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 5, 10]) if (m * pow >= raw) return m * pow;
  return 10 * pow;
}

export function renderCurve(spec: CurveSpec, size: { width: number; height: number }, format: AngleFormat = 'dm'): SVGSVGElement {
  const width = Math.max(260, Math.round(size.width));
  const height = Math.max(200, Math.round(size.height));
  const left = width < 420 ? 62 : 76;
  const plot = { x: left, y: 12, w: width - left - 14, h: height - 48 };
  const xs = [...spec.points.map((p) => p.minutes), ...spec.model.map((p) => p.minutes), ...spec.marks.map((m) => m.minutes), ...(spec.result ? [spec.result.minutes] : [])];
  const ysArc = [
    ...spec.points.flatMap((p) => [p.altitude_deg * 60 - p.sigma_arcmin, p.altitude_deg * 60 + p.sigma_arcmin]),
    ...spec.model.map((p) => p.altitude_deg * 60),
    ...spec.levels.map((l) => l.altitude_deg * 60),
    ...(spec.result ? [spec.result.altitude_deg * 60] : []),
  ];
  let x0 = Math.min(...xs, 0);
  let x1 = Math.max(...xs, 0);
  if (!(x1 > x0)) {
    x0 -= 1;
    x1 += 1;
  }
  const xpad = (x1 - x0) * 0.04;
  x0 -= xpad;
  x1 += xpad;
  let y0 = Math.min(...ysArc);
  let y1 = Math.max(...ysArc);
  if (!(y1 - y0 > 0.5)) {
    const mid = (y0 + y1) / 2;
    y0 = mid - 0.5;
    y1 = mid + 0.5;
  }
  const ypad = (y1 - y0) * 0.08;
  y0 -= ypad;
  y1 += ypad;
  const X = (m: number) => plot.x + ((m - x0) / (x1 - x0)) * plot.w;
  const Y = (arcmin: number) => plot.y + plot.h - ((arcmin - y0) / (y1 - y0)) * plot.h;

  const svg = s('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'sfn-curve',
    role: 'img',
    'aria-label': `Height of the ${spec.body} against time, minutes from ${spec.zeroLabel}: ${spec.points.length} sights and the model curve.`,
  }) as SVGSVGElement;
  svg.appendChild(s('rect', { x: plot.x, y: plot.y, width: plot.w, height: plot.h, class: 'sfn-plot__frame' }));

  const grid = s('g', { class: 'sfn-plot__grid' });
  const xStep = niceStep(x1 - x0, width < 420 ? 4 : 8);
  for (let m = Math.ceil(x0 / xStep) * xStep; m <= x1 + 1e-9; m += xStep) {
    grid.appendChild(s('line', { x1: f2(X(m)), y1: plot.y, x2: f2(X(m)), y2: plot.y + plot.h }));
    const v = Math.abs(m) < 1e-9 ? 0 : m;
    grid.appendChild(text(X(m), plot.y + plot.h + 15, `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(xStep < 1 ? 1 : 0)}`, 'sfn-plot__tick', 'middle'));
  }
  const yStep = niceStep(y1 - y0, 5);
  for (let a = Math.ceil(y0 / yStep) * yStep; a <= y1 + 1e-9; a += yStep) {
    grid.appendChild(s('line', { x1: plot.x, y1: f2(Y(a)), x2: plot.x + plot.w, y2: f2(Y(a)) }));
    grid.appendChild(text(plot.x - 5, Y(a) + 4, fmtAngle(a / 60, format === 'decimal' ? 'decimal' : 'dm', format === 'decimal' ? 3 : yStep < 1 ? 1 : 0), 'sfn-plot__tick', 'end'));
  }
  svg.appendChild(grid);
  svg.appendChild(text(plot.x + plot.w / 2, height - 6, `minutes from ${spec.zeroLabel}`, 'sfn-plot__axis', 'middle'));

  const bodyCls = `sfn-b-${glyphFor(spec.body)}`;
  for (const l of spec.levels) {
    svg.appendChild(s('line', { x1: plot.x, y1: f2(Y(l.altitude_deg * 60)), x2: plot.x + plot.w, y2: f2(Y(l.altitude_deg * 60)), class: 'sfn-curve__level' }));
    svg.appendChild(text(plot.x + 6, Y(l.altitude_deg * 60) - 5, l.label, 'sfn-plot__label sfn-plot__label--muted'));
  }
  spec.marks.forEach((m, i) => {
    svg.appendChild(s('line', { x1: f2(X(m.minutes)), y1: plot.y, x2: f2(X(m.minutes)), y2: plot.y + plot.h, class: 'sfn-curve__mark' }));
    svg.appendChild(text(X(m.minutes) + 5, plot.y + 14 + i * 14, m.label, 'sfn-plot__label sfn-plot__label--muted'));
  });
  if (spec.model.length > 1) {
    const d = spec.model.map((p, i) => `${i ? 'L' : 'M'}${f2(X(p.minutes))} ${f2(Y(p.altitude_deg * 60))}`).join('');
    svg.appendChild(s('path', { d, class: `sfn-curve__model ${bodyCls}` }));
  }
  const pts = s('g', { class: 'sfn-curve__points' });
  for (const p of spec.points) {
    const x = X(p.minutes);
    const y = Y(p.altitude_deg * 60);
    const e = Math.max((p.sigma_arcmin / (y1 - y0)) * plot.h, 0.5);
    pts.appendChild(s('path', { d: `M${f2(x)} ${f2(y - e)}V${f2(y + e)}M${f2(x - 3)} ${f2(y - e)}h6M${f2(x - 3)} ${f2(y + e)}h6`, class: 'sfn-curve__bar' }));
    pts.appendChild(s('circle', { cx: f2(x), cy: f2(y), r: 4, class: p.used ? `sfn-curve__pt ${bodyCls}` : 'sfn-curve__pt sfn-curve__pt--out' }));
    if (!p.used) pts.appendChild(text(x + 7, y - 7, `${p.label} left out`, 'sfn-plot__label sfn-plot__label--strong'));
  }
  svg.appendChild(pts);
  if (spec.result) {
    const x = X(spec.result.minutes);
    const y = Y(spec.result.altitude_deg * 60);
    const e = (spec.result.sigma_arcmin / (y1 - y0)) * plot.h;
    svg.appendChild(s('path', { d: `M${f2(x)} ${f2(y - e)}V${f2(y + e)}`, class: 'sfn-curve__bar sfn-curve__bar--result' }));
    svg.appendChild(s('polygon', { points: `${f2(x)},${f2(y - 8)} ${f2(x + 8)},${f2(y)} ${f2(x)},${f2(y + 8)} ${f2(x - 8)},${f2(y)}`, class: 'sfn-curve__result' }));
    svg.appendChild(text(x + 11, y + 18, spec.result.label, 'sfn-plot__label sfn-plot__label--strong'));
  }
  return svg;
}
