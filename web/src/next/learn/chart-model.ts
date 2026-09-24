/**
 * What the Learn chart may draw for a result, before any pixels. OWNER: learn agent.
 *
 * The rules (CONVENTIONS 8-9, EXPLORER_PLAN §3.5) live here, where the tests can see
 * them, rather than in the drawing code:
 *
 * - a fix and an ellipse only for a UNIQUE result, and the ellipse only when the core
 *   emitted one (`ellipse95` present). A suppressed ellipse is never drawn;
 * - AMBIGUOUS: every candidate, all drawn the same way, none promoted;
 * - UNDERDETERMINED: the circle(s) and no point at all;
 * - FAILED: nothing to draw;
 * - the truth only as the answer key, and only when the caller passes it (simulated runs).
 *
 * Two pictures: a close-up plotting sheet (unique fixes: where the lines cross, the
 * ellipse, the answer key) and a globe (circles thousands of kilometres across: one sight,
 * two crossings, or a unique fix seen whole).
 */

import type { ErrorEllipse, FixResult, LatLon } from '../../types.js';
import { distanceM, ellipseRing, meanDirection, nearestOnCircle, tangentOffsetM } from './geo.js';

export type ChartView = 'sheet' | 'globe';

export interface ChartCircle {
  id: string;
  body: string;
  gp: LatLon;
  zenithDeg: number;
  /** Index into the chart palette, one per body. */
  color: number;
  /** Label this circle (the first circle of each body). */
  labelled: boolean;
}

export interface ChartBody {
  body: string;
  color: number;
  /** Ground point at the body's first sight. */
  gp: LatLon;
}

export interface ChartModel {
  kind: FixResult['kind'];
  /** The picture to open with. */
  view: ChartView;
  /** Whether the close-up exists (unique fixes only). */
  canSheet: boolean;
  circles: ChartCircle[];
  bodies: ChartBody[];
  fix: LatLon | null;
  /** Only when the core emitted a 95 % ellipse for a unique fix. */
  ellipse: { center: LatLon; ellipse: ErrorEllipse } | null;
  /** Why there is no ellipse on a unique fix, when there is none. */
  suppressedReason: string | null;
  candidates: LatLon[];
  /** The answer key (simulated runs only). */
  truth: LatLon | null;
}

/** Number of distinct circle colours in the palette (learn.css `--sfl-c0` … `--sfl-c5`). */
export const PALETTE_SIZE = 6;

/** Build the model. Returns null when there is nothing to draw (a failed solve). */
export function chartModel(result: FixResult, truth: LatLon | null): ChartModel | null {
  if (result.kind === 'failed') return null;
  const colors = new Map<string, number>();
  const bodies: ChartBody[] = [];
  const circles: ChartCircle[] = result.circles.map((c) => {
    let color = colors.get(c.body);
    const first = color === undefined;
    if (color === undefined) {
      color = colors.size % PALETTE_SIZE;
      colors.set(c.body, color);
      bodies.push({ body: c.body, color, gp: c.gp });
    }
    return { id: c.id, body: c.body, gp: c.gp, zenithDeg: c.zenith_distance_deg, color, labelled: first };
  });
  const base = { kind: result.kind, circles, bodies, truth } as const;
  if (result.kind === 'unique') {
    const f = result.fix;
    return {
      ...base,
      view: 'sheet',
      canSheet: true,
      fix: f.position,
      ellipse: f.ellipse95 ? { center: f.position, ellipse: f.ellipse95 } : null,
      suppressedReason: f.ellipse95 ? null : (f.ellipse_suppressed_reason ?? 'the core did not emit one'),
      candidates: [],
    };
  }
  if (result.kind === 'ambiguous') {
    return {
      ...base,
      view: 'globe',
      canSheet: false,
      fix: null,
      ellipse: null,
      suppressedReason: null,
      candidates: result.candidates.map((c) => c.position),
    };
  }
  return { ...base, view: 'globe', canSheet: false, fix: null, ellipse: null, suppressedReason: null, candidates: [] };
}

// ---------------------------------------------------------------------------------------
// Framing

/** A close-up's extent in metres, (east, north) relative to `origin` (the fix). */
export interface SheetFrame {
  origin: LatLon;
  minE: number;
  maxE: number;
  minN: number;
  maxN: number;
}

/** Smallest half-width a close-up shows, metres, so a perfect fix is not a point on a blank page. */
export const MIN_HALF_SPAN_M = 400;

/**
 * The close-up: the fix, the answer key, the ellipse, and where each line of position
 * passes nearest the fix, so every line crosses the picture. A line much further out than
 * everything else (a wild blunder) is left to run off the edge rather than shrink the
 * picture to nothing.
 */
export function sheetFrame(model: ChartModel): SheetFrame | null {
  if (!model.fix) return null;
  const origin = model.fix;
  const pts: { north: number; east: number }[] = [{ north: 0, east: 0 }];
  if (model.truth) pts.push(tangentOffsetM(origin, model.truth));
  if (model.ellipse) {
    for (const p of ellipseRing(model.ellipse.center, model.ellipse.ellipse, 48)) pts.push(tangentOffsetM(origin, p));
  }
  const core = Math.max(MIN_HALF_SPAN_M, ...pts.map((p) => Math.hypot(p.north, p.east)));
  for (const c of model.circles) {
    const near = nearestOnCircle(c.gp, c.zenithDeg, origin);
    const d = distanceM(origin, near);
    if (d <= 3 * core) pts.push(tangentOffsetM(origin, near));
  }
  let minE = Math.min(...pts.map((p) => p.east));
  let maxE = Math.max(...pts.map((p) => p.east));
  let minN = Math.min(...pts.map((p) => p.north));
  let maxN = Math.max(...pts.map((p) => p.north));
  // Pad by an eighth, and never less than the minimum half-span round the middle.
  const padE = Math.max((maxE - minE) / 8, MIN_HALF_SPAN_M / 4);
  const padN = Math.max((maxN - minN) / 8, MIN_HALF_SPAN_M / 4);
  minE -= padE;
  maxE += padE;
  minN -= padN;
  maxN += padN;
  const midE = (minE + maxE) / 2;
  const midN = (minN + maxN) / 2;
  const halfE = Math.max((maxE - minE) / 2, MIN_HALF_SPAN_M);
  const halfN = Math.max((maxN - minN) / 2, MIN_HALF_SPAN_M);
  return { origin, minE: midE - halfE, maxE: midE + halfE, minN: midN - halfN, maxN: midN + halfN };
}

/**
 * Where a globe looks from: the fix (every line passes through the middle), a single
 * circle's ground point (so it is seen as a ring), or the middle of everything that
 * matters (candidates, ground points, answer key).
 */
export function globeCenter(model: ChartModel): LatLon {
  if (model.fix) return model.fix;
  if (model.kind === 'underdetermined' && model.bodies.length === 1) return model.bodies[0]!.gp;
  const pts: LatLon[] = [...model.candidates, ...model.bodies.map((b) => b.gp)];
  if (model.fix) pts.push(model.fix);
  if (model.truth) pts.push(model.truth);
  return meanDirection(pts) ?? model.fix ?? model.truth ?? { lat_deg: 0, lon_deg: 0 };
}
