/**
 * The universal plotting sheet: the assumed position (the DR) at the centre, and for each
 * sight the azimuth line, the intercept toward or away and the line of position at right
 * angles to it (Marcq Saint-Hilaire, as a navigator plots it), with the least-squares fix
 * from the core. Latitude lines every so many minutes; meridians drawn for the DR's
 * latitude (1′ of longitude = cos φ NM), as on a universal plotting sheet; a compass rose.
 * OWNER: navigate2 agent (expansion programme).
 *
 * The plot is the plane of the sheet (north up, east right, 1′ of latitude = 1 NM), as on
 * paper: over the few tens of miles a plot spans, its departure from the sphere is far below
 * a pencil line. Every intercept, azimuth and the fix are the core's; the geometry here is
 * pure and tested (navigate-print.test.ts).
 */

import { h, s } from '../../../dom.js';
import type { LatLon, ReducedSight, Session } from '../../../types.js';
import type { AngleFormat } from '../../state.js';
import { fmtBearing, fmtLatitude, fmtLongitude, fmtNm, fmtPosition, utcInputText } from '../format.js';
import { sheet } from './preview.js';

const D = Math.PI / 180;

/** A point on the sheet, nautical miles east (x) and north (y) of the assumed position. */
export interface SheetPoint {
  x: number;
  y: number;
}

export interface PlotLop {
  id: string;
  body: string;
  utc: string;
  znDeg: number;
  /** Signed intercept, NM: positive toward the body. */
  aNm: number;
  /** The intercept's foot: where the line of position crosses the azimuth line. */
  foot: SheetPoint;
  /** Unit vector along the line of position. */
  along: SheetPoint;
}

/** A sight's line of position on the sheet (the assumed position at the origin). */
export function lopOf(sight: ReducedSight): PlotLop | null {
  if (sight.zn_deg === null || sight.intercept_nm === null) return null;
  const z = sight.zn_deg * D;
  const a = sight.intercept_nm;
  return {
    id: sight.id,
    body: sight.body,
    utc: sight.utc,
    znDeg: sight.zn_deg,
    aNm: a,
    foot: { x: a * Math.sin(z), y: a * Math.cos(z) },
    along: { x: Math.cos(z), y: -Math.sin(z) },
  };
}

/** A position on the sheet: north by the difference of latitude, east by departure at the AP's latitude. */
export function sheetOffset(ap: LatLon, p: LatLon): SheetPoint {
  let dLon = p.lon_deg - ap.lon_deg;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return { x: dLon * 60 * Math.cos(ap.lat_deg * D), y: (p.lat_deg - ap.lat_deg) * 60 };
}

/** Where two lines of position cross, or null when they are (nearly) parallel. */
export function crossing(p: PlotLop, q: PlotLop): SheetPoint | null {
  const det = p.along.x * -q.along.y - p.along.y * -q.along.x;
  if (Math.abs(det) < 1e-9) return null;
  const dx = q.foot.x - p.foot.x;
  const dy = q.foot.y - p.foot.y;
  const t = (dx * -q.along.y - dy * -q.along.x) / det;
  return { x: p.foot.x + t * p.along.x, y: p.foot.y + t * p.along.y };
}

const NICE = [2, 3, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 600];

/** Half the sheet's width, NM: room for every intercept and the fix, with a margin. */
export function sheetHalfSpan(lops: readonly PlotLop[], fix: SheetPoint | null): number {
  let need = 3;
  for (const l of lops) need = Math.max(need, Math.abs(l.aNm) * 1.35);
  if (fix) need = Math.max(need, Math.abs(fix.x) * 1.25, Math.abs(fix.y) * 1.25);
  return NICE.find((n) => n >= need) ?? Math.ceil(need / 600) * 600;
}

/** The grid step, minutes: about five lines each side. */
export function gridStep(halfSpanNm: number): number {
  const target = halfSpanNm / 5;
  return [0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120].find((v) => v >= target) ?? 120;
}

export interface PlottingInput {
  session: Session;
  sights: readonly ReducedSight[];
  fix: LatLon | null;
  fixLabel?: string;
  format?: AngleFormat;
}

/** The SVG of the plotting sheet (600 units wide; the plotting square prints about 15 cm). */
export function plottingSvg(input: PlottingInput): SVGSVGElement {
  const ap = input.session.observer.assumed_position!;
  const f = input.format ?? 'dm';
  const lops = input.sights.map(lopOf).filter((l): l is PlotLop => l !== null);
  const fix = input.fix ? sheetOffset(ap, input.fix) : null;
  const S = sheetHalfSpan(lops, fix);
  // A square plotting area with room for the latitude figures on the left and the
  // longitude figures below.
  const left = 74;
  const right = 18;
  const top = 18;
  const bottom = 34;
  const size = 600;
  const R = (size - left - right) / 2;
  const cx = left + R;
  const cy = top + R;
  const height = top + 2 * R + bottom;
  const k = R / S;
  const X = (p: SheetPoint): number => cx + p.x * k;
  const Y = (p: SheetPoint): number => cy - p.y * k;
  const n2 = (v: number): string => v.toFixed(2);
  const svg = s('svg', {
    viewBox: `0 0 ${size} ${height}`,
    class: 'sfn-plotsheet',
    role: 'img',
    'aria-label': `Plotting sheet centred on ${fmtPosition(ap, f)}: ${lops.length} line${lops.length === 1 ? '' : 's'} of position${fix ? ' and the fix' : ''}, ${S} NM each way.`,
  }) as SVGSVGElement;
  const clipId = `sfn-ps-${Math.random().toString(36).slice(2, 8)}`;
  svg.append(s('clipPath', { id: clipId }, s('rect', { x: left, y: top, width: 2 * R, height: 2 * R })));
  svg.append(s('rect', { x: left, y: top, width: 2 * R, height: 2 * R, class: 'sfn-ps__frame' }));

  // Latitude lines and meridians every `step` minutes, labelled like a chart's border.
  const step = gridStep(S);
  const grid = s('g', { class: 'sfn-ps__grid' });
  const lat0 = ap.lat_deg * 60;
  const cosLat = Math.cos(ap.lat_deg * D);
  for (let m = Math.ceil((lat0 - S) / step) * step; m <= lat0 + S + 1e-9; m += step) {
    const y = Y({ x: 0, y: m - lat0 });
    grid.append(s('line', { x1: left, y1: n2(y), x2: left + 2 * R, y2: n2(y) }));
    const t = s('text', { x: left - 5, y: n2(y + 3), 'text-anchor': 'end', class: 'sfn-ps__tick' });
    t.textContent = fmtLatitude(m / 60, 'dm', step < 1 ? 1 : 0);
    grid.append(t);
  }
  const lon0 = ap.lon_deg * 60;
  const spanLon = S / Math.max(cosLat, 0.05);
  const lonStep = gridStep(spanLon);
  let labelled = 0;
  for (let m = Math.ceil((lon0 - spanLon) / lonStep) * lonStep; m <= lon0 + spanLon + 1e-9; m += lonStep) {
    const x = X({ x: (m - lon0) * cosLat, y: 0 });
    grid.append(s('line', { x1: n2(x), y1: top, x2: n2(x), y2: top + 2 * R }));
    // Every other label when they would crowd.
    if (labelled++ % (lonStep * cosLat * k < 70 ? 2 : 1) === 0) {
      const t = s('text', { x: n2(x), y: top + 2 * R + 15, 'text-anchor': 'middle', class: 'sfn-ps__tick' });
      let lonMin = m;
      while (lonMin > 10800) lonMin -= 21600;
      while (lonMin <= -10800) lonMin += 21600;
      t.textContent = fmtLongitude(lonMin / 60, 'dm', lonStep < 1 ? 1 : 0);
      grid.append(t);
    }
  }
  svg.append(grid);

  // The compass rose round the assumed position, true, every 10°.
  const rose = s('g', { class: 'sfn-ps__rose' });
  const rr = R * 0.9;
  rose.append(s('circle', { cx, cy, r: n2(rr) }));
  for (let deg = 0; deg < 360; deg += 5) {
    const a = deg * D;
    const long = deg % 30 === 0 ? 12 : deg % 10 === 0 ? 7 : 4;
    rose.append(s('line', { x1: n2(cx + rr * Math.sin(a)), y1: n2(cy - rr * Math.cos(a)), x2: n2(cx + (rr - long) * Math.sin(a)), y2: n2(cy - (rr - long) * Math.cos(a)) }));
    if (deg % 30 === 0) {
      const t = s('text', { x: n2(cx + (rr - 22) * Math.sin(a)), y: n2(cy - (rr - 22) * Math.cos(a) + 3.5), 'text-anchor': 'middle', class: 'sfn-ps__rose-label' });
      t.textContent = String(deg).padStart(3, '0');
      rose.append(t);
    }
  }
  svg.append(rose);

  // Lines of position, their azimuth lines and intercepts.
  const layer = s('g', { 'clip-path': `url(#${clipId})` });
  const far = 3 * S;
  lops.forEach((l, i) => {
    const tip = { x: Math.sin(l.znDeg * D) * Math.max(Math.abs(l.aNm), S * 0.25), y: Math.cos(l.znDeg * D) * Math.max(Math.abs(l.aNm), S * 0.25) };
    layer.append(s('line', { x1: n2(cx), y1: n2(cy), x2: n2(X(tip)), y2: n2(Y(tip)), class: 'sfn-ps__azimuth' }));
    layer.append(s('circle', { cx: n2(X(l.foot)), cy: n2(Y(l.foot)), r: 2.6, class: 'sfn-ps__foot' }));
    const p1 = { x: l.foot.x - far * l.along.x, y: l.foot.y - far * l.along.y };
    const p2 = { x: l.foot.x + far * l.along.x, y: l.foot.y + far * l.along.y };
    layer.append(s('line', { x1: n2(X(p1)), y1: n2(Y(p1)), x2: n2(X(p2)), y2: n2(Y(p2)), class: 'sfn-ps__lop' }));
    // The label on the line, well inside the frame (alternate ends, so neighbours part).
    const t0 = 0.6 * Math.sqrt(Math.max(S * S - l.aNm * l.aNm, 0)) * (i % 2 === 0 ? 1 : -1);
    const lp = { x: l.foot.x + t0 * l.along.x, y: l.foot.y + t0 * l.along.y };
    const label = s('text', { x: n2(X(lp)), y: n2(Y(lp) - 4), class: 'sfn-ps__label', 'text-anchor': 'middle' });
    label.textContent = `${l.body} ${utcInputText(l.utc).slice(11, 16)}`;
    layer.append(label);
  });
  svg.append(layer);

  // The assumed position, and the fix.
  svg.append(s('circle', { cx, cy, r: 5, class: 'sfn-ps__ap' }), s('circle', { cx, cy, r: 1.5, class: 'sfn-ps__ap-dot' }));
  const apLabel = s('text', { x: cx + 8, y: cy + 16, class: 'sfn-ps__label' });
  apLabel.textContent = 'AP (DR)';
  svg.append(apLabel);
  if (fix && Math.abs(fix.x) <= S && Math.abs(fix.y) <= S) {
    svg.append(
      s('circle', { cx: n2(X(fix)), cy: n2(Y(fix)), r: 6, class: 'sfn-ps__fix' }),
      s('path', { d: `M${n2(X(fix) - 10)} ${n2(Y(fix))}H${n2(X(fix) + 10)}M${n2(X(fix))} ${n2(Y(fix) - 10)}V${n2(Y(fix) + 10)}`, class: 'sfn-ps__fix-cross' }),
    );
    const t = s('text', { x: n2(X(fix) + 10), y: n2(Y(fix) - 9), class: 'sfn-ps__label sfn-ps__label--strong' });
    t.textContent = input.fixLabel ?? 'Fix';
    svg.append(t);
  }

  // A scale of nautical miles.
  const bar = [1, 2, 5, 10, 20, 50, 100].reverse().find((v) => v <= S * 0.4) ?? 1;
  const bx = left + 2 * R - bar * k - 8;
  const by = top + 16;
  svg.append(
    s('path', { d: `M${n2(bx)} ${by - 4}V${by}H${n2(bx + bar * k)}V${by - 4}`, class: 'sfn-ps__scale' }),
    Object.assign(s('text', { x: n2(bx + (bar * k) / 2), y: by - 7, 'text-anchor': 'middle', class: 'sfn-ps__tick' }), { textContent: `${bar} NM` }),
  );
  return svg;
}

/** The printed plotting sheet with its key. */
export function plottingSheet(input: PlottingInput): HTMLElement {
  const ap = input.session.observer.assumed_position;
  const f = input.format ?? 'dm';
  if (!ap) {
    return sheet('Plotting sheet', 'needs an assumed position', input.session.meta.kind, h('p', {}, 'The session has no assumed position (DR): the lines of position are drawn from it. Set one in the session settings.'));
  }
  const lops = input.sights.map(lopOf).filter((l): l is PlotLop => l !== null);
  const rows = lops.map((l) =>
    h(
      'tr',
      {},
      h('th', { scope: 'row' }, l.body),
      h('td', {}, `${utcInputText(l.utc).slice(11)} UTC`),
      h('td', {}, fmtBearing(l.znDeg)),
      h('td', {}, `${fmtNm(Math.abs(l.aNm), 1)} ${l.aNm >= 0 ? 'Toward' : 'Away'}`),
    ),
  );
  const cosLat = Math.cos(ap.lat_deg * D);
  return sheet(
    'Plotting sheet',
    `${input.session.meta.name || 'Untitled session'} · centred on the DR, ${fmtPosition(ap, f)}`,
    input.session.meta.kind,
    h('div', { class: 'sfn-sheet__figure' }, plottingSvg(input)),
    h(
      'table',
      { class: 'sfn-ws sfn-ps__key' },
      h('caption', { class: 'sf-sr' }, 'The lines of position'),
      h('thead', {}, h('tr', {}, ...['Body', 'Time', 'Zn', 'Intercept a'].map((t) => h('th', { scope: 'col' }, t)))),
      h('tbody', {}, ...rows),
    ),
    h(
      'p',
      { class: 'sfn-sheet__note' },
      `From the AP each intercept is laid off along Zn (toward) or its reciprocal (away), and the line of position drawn at right angles. Meridians are drawn for ${fmtLatitude(ap.lat_deg, f)}: 1′ of longitude is ${cosLat.toFixed(3)} NM. Each line is at its own time, not advanced; for sights taken under way use the running fix.` +
        (input.fix ? ` The fix is the core’s least-squares position, ${fmtPosition(input.fix, f)}.` : ''),
    ),
  );
}
