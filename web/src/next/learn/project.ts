/**
 * The two projections the Learn chart draws with. OWNER: learn agent. Pure functions.
 *
 * - `SheetProjection`: a navigator's plotting sheet round a fix. Azimuthal equidistant
 *   about the fix on the reference sphere, so distances and bearings from the fix are
 *   true and the 95 % ellipse (defined in the tangent plane at the fix) is drawn exactly.
 *   East is right, north is up, one scale for both axes.
 * - `Ortho`: an orthographic globe, as the Earth looks from far away. Points on the far
 *   side are hidden; lines are cut where they cross the edge of the disc.
 */

import { applyOffsetM, tangentOffsetM, toVec, type Vec3 } from './geo.js';
import type { LatLon } from '../../types.js';

export type XY = [number, number];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class SheetProjection {
  /** Pixels per metre. */
  readonly k: number;
  private readonly midE: number;
  private readonly midN: number;

  /** Fit the (east, north) box round `origin` into `rect`, keeping one scale. */
  constructor(
    readonly origin: LatLon,
    box: { minE: number; maxE: number; minN: number; maxN: number },
    readonly rect: Rect,
  ) {
    const spanE = Math.max(box.maxE - box.minE, 1e-6);
    const spanN = Math.max(box.maxN - box.minN, 1e-6);
    this.k = Math.min(rect.w / spanE, rect.h / spanN);
    this.midE = (box.minE + box.maxE) / 2;
    this.midN = (box.minN + box.maxN) / 2;
  }

  /** Metres (east, north) from the origin to pixels. */
  xy(east: number, north: number): XY {
    return [this.rect.x + this.rect.w / 2 + (east - this.midE) * this.k, this.rect.y + this.rect.h / 2 - (north - this.midN) * this.k];
  }

  project(p: LatLon): XY {
    const o = tangentOffsetM(this.origin, p);
    return this.xy(o.east, o.north);
  }

  /** Pixels back to a position. */
  unproject(x: number, y: number): LatLon {
    const east = (x - this.rect.x - this.rect.w / 2) / this.k + this.midE;
    const north = -(y - this.rect.y - this.rect.h / 2) / this.k + this.midN;
    return applyOffsetM(this.origin, north, east);
  }
}

export interface GlobePoint {
  x: number;
  y: number;
  /** Cosine of the angle from the centre of the view: > 0 on the near side. */
  z: number;
}

export class Ortho {
  private readonly e: Vec3;
  private readonly n: Vec3;
  private readonly u: Vec3;

  constructor(
    readonly center: LatLon,
    /** Globe radius, pixels. */
    readonly r: number,
    readonly cx: number,
    readonly cy: number,
  ) {
    const lat = (center.lat_deg * Math.PI) / 180;
    const lon = (center.lon_deg * Math.PI) / 180;
    // Local east, north and up at the centre of the view.
    this.u = toVec(center);
    this.e = [-Math.sin(lon), Math.cos(lon), 0];
    this.n = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  }

  projectVec(v: Vec3): GlobePoint {
    const x = v[0] * this.e[0] + v[1] * this.e[1] + v[2] * this.e[2];
    const y = v[0] * this.n[0] + v[1] * this.n[1] + v[2] * this.n[2];
    const z = v[0] * this.u[0] + v[1] * this.u[1] + v[2] * this.u[2];
    return { x: this.cx + x * this.r, y: this.cy - y * this.r, z };
  }

  project(p: LatLon): GlobePoint {
    return this.projectVec(toVec(p));
  }

  visible(p: LatLon): boolean {
    return this.project(p).z > 0;
  }

  /** The point on the edge of the disc in the direction of (x, y). */
  toLimb(x: number, y: number): XY {
    const dx = x - this.cx;
    const dy = y - this.cy;
    const d = Math.hypot(dx, dy) || 1;
    return [this.cx + (dx / d) * this.r, this.cy + (dy / d) * this.r];
  }
}

/** Where the segment a-b crosses the edge of the visible hemisphere (za > 0 >= zb, or the reverse). */
function horizonCrossing(o: Ortho, a: Vec3, b: Vec3, za: number, zb: number): XY {
  const t = za / (za - zb);
  const v: Vec3 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const g = o.projectVec(v);
  return o.toLimb(g.x, g.y);
}

/**
 * The visible pieces of a line on the globe, each cut exactly at the edge of the disc.
 * `closed` joins the last point back to the first.
 */
export function visibleRuns(o: Ortho, points: readonly LatLon[], closed = false): XY[][] {
  const vecs = points.map(toVec);
  if (closed && vecs.length) vecs.push(vecs[0]!);
  const runs: XY[][] = [];
  let run: XY[] = [];
  let prev: { v: Vec3; g: GlobePoint } | null = null;
  for (const v of vecs) {
    const g = o.projectVec(v);
    if (prev) {
      if (prev.g.z > 0 && g.z <= 0) {
        run.push(horizonCrossing(o, prev.v, v, prev.g.z, g.z));
        if (run.length >= 2) runs.push(run);
        run = [];
      } else if (prev.g.z <= 0 && g.z > 0) {
        run = [horizonCrossing(o, prev.v, v, prev.g.z, g.z)];
      }
    }
    if (g.z > 0) run.push([g.x, g.y]);
    prev = { v, g };
  }
  if (run.length >= 2) runs.push(run);
  // A closed line that was visible at both its start and its end is one piece, not two.
  if (closed && runs.length > 1) {
    const first = runs[0]!;
    const last = runs[runs.length - 1]!;
    const a = last[last.length - 1]!;
    const b = first[0]!;
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) {
      runs[0] = [...last, ...first.slice(1)];
      runs.pop();
    }
  }
  return runs;
}

/**
 * A filled ring on the globe: points on the far side are moved out to the edge of the
 * disc, so the visible part fills correctly and the hidden part runs along the rim.
 * Null when the whole ring is out of sight.
 */
export function ringOnGlobe(o: Ortho, ring: readonly LatLon[]): XY[] | null {
  let any = false;
  const out: XY[] = [];
  for (const p of ring) {
    const g = o.project(p);
    if (g.z > 0) {
      any = true;
      out.push([g.x, g.y]);
    } else {
      out.push(o.toLimb(g.x, g.y));
    }
  }
  return any ? out : null;
}

/** SVG path data for polylines; `close` adds Z. */
export function pathData(runs: readonly (readonly XY[])[], close = false): string {
  let d = '';
  for (const run of runs) {
    if (run.length < 2) continue;
    d += `M${r2(run[0]![0])} ${r2(run[0]![1])}`;
    for (let i = 1; i < run.length; i++) d += `L${r2(run[i]![0])} ${r2(run[i]![1])}`;
    if (close) d += 'Z';
  }
  return d;
}

export function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Liang-Barsky: the part of segment a-b inside `rect`, or null. */
export function clipSegment(a: XY, b: XY, rect: Rect): [XY, XY] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy];
  const q = [a[0] - rect.x, rect.x + rect.w - a[0], a[1] - rect.y, rect.y + rect.h - a[1]];
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!;
    const qi = q[i]!;
    if (pi === 0) {
      if (qi < 0) return null;
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

/** The pieces of a polyline inside `rect`. */
export function clipPolyline(points: readonly XY[], rect: Rect): XY[][] {
  const pieces: XY[][] = [];
  let current: XY[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const seg = clipSegment(points[i]!, points[i + 1]!, rect);
    if (!seg) {
      if (current.length >= 2) pieces.push(current);
      current = [];
      continue;
    }
    const [s, e] = seg;
    const last = current[current.length - 1];
    if (last && Math.abs(last[0] - s[0]) < 1e-6 && Math.abs(last[1] - s[1]) < 1e-6) current.push(e);
    else {
      if (current.length >= 2) pieces.push(current);
      current = [s, e];
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces;
}
