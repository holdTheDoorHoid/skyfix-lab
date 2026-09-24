/**
 * Spherical helpers for the Learn view: distances and offsets for the answer-key
 * comparison, and points along circles and ellipses for drawing. OWNER: learn agent.
 *
 * Every navigational quantity (the fix, its covariance and ellipse, the circles' ground
 * points and zenith distances) comes from the Rust core. What happens here is comparison
 * and presentation on the same reference sphere the core uses (CONVENTIONS section 1:
 * one arcminute of arc is one nautical mile, `EARTH_RADIUS_M`), built on the port of
 * `skyfix_core::geometry` in `src/geometry.ts`, which its own tests pin to the Rust.
 *
 * `tangentOffsetM` and `mahalanobis` are line-for-line ports of
 * `skyfix_core::geometry::tangent_offset` and `skyfix_sim::experiment::mahalanobis`, so a
 * single run is scored exactly the way the experiment runner scores each repetition.
 */

import {
  angularDistance,
  circleOfPosition,
  destination,
  initialBearing,
  pointFromDeg,
  pointToLatLon,
} from '../../geometry.js';
import { CHI2_95_2DOF, EARTH_RADIUS_M, NM_M, type ErrorEllipse, type LatLon } from '../../types.js';

const D2R = Math.PI / 180;

/** Great-circle distance on the reference sphere, metres. */
export function distanceM(a: LatLon, b: LatLon): number {
  return angularDistance(pointFromDeg(a.lat_deg, a.lon_deg), pointFromDeg(b.lat_deg, b.lon_deg)) * EARTH_RADIUS_M;
}

/** Initial true bearing from `a` to `b`, degrees [0, 360). */
export function bearingDeg(a: LatLon, b: LatLon): number {
  return initialBearing(pointFromDeg(a.lat_deg, a.lon_deg), pointFromDeg(b.lat_deg, b.lon_deg)) / D2R;
}

/**
 * `p` relative to `origin` in the tangent plane at `origin`, metres (north, east): the
 * great-circle distance split along the initial bearing (`geometry::tangent_offset`).
 */
export function tangentOffsetM(origin: LatLon, p: LatLon): { north: number; east: number } {
  const o = pointFromDeg(origin.lat_deg, origin.lon_deg);
  const q = pointFromDeg(p.lat_deg, p.lon_deg);
  const d = angularDistance(o, q);
  if (d === 0) return { north: 0, east: 0 };
  const b = initialBearing(o, q);
  return { north: d * Math.cos(b) * EARTH_RADIUS_M, east: d * Math.sin(b) * EARTH_RADIUS_M };
}

/** The point `north`, `east` metres from `origin` along the great circle of that step. */
export function applyOffsetM(origin: LatLon, north: number, east: number): LatLon {
  const d = Math.hypot(north, east);
  if (d === 0) return { ...origin };
  const o = pointFromDeg(origin.lat_deg, origin.lon_deg);
  return pointToLatLon(destination(o, Math.atan2(east, north), d / EARTH_RADIUS_M));
}

/**
 * Mahalanobis distance of a (north, east) offset under a 2 x 2 covariance, or null when
 * the covariance is degenerate (`skyfix_sim::experiment::mahalanobis`).
 */
export function mahalanobis(cov: readonly (readonly number[])[], dn: number, de: number): number | null {
  const a = cov[0]?.[0];
  const b = cov[0]?.[1];
  const c = cov[1]?.[0];
  const d = cov[1]?.[1];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
  if (![a, b, c, d, dn, de].every(Number.isFinite)) return null;
  const det = a * d - b * c;
  if (det <= 0 || a <= 0 || d <= 0) return null;
  const q = (d * dn * dn - (b + c) * dn * de + a * de * de) / det;
  return q < 0 ? null : Math.sqrt(q);
}

/** The nominal 95 % boundary in Mahalanobis units: sqrt(chi-square 95 %, 2 dof). */
export const MAHALANOBIS_95 = Math.sqrt(CHI2_95_2DOF);

/**
 * Points round a 95 % ellipse centred on `center`: the major axis on true bearing
 * `orientation_deg`, each point reached by walking its tangent-plane offset along a great
 * circle (`geometry::apply_tangent_step`). Closed: the first point is not repeated.
 */
export function ellipseRing(center: LatLon, ellipse: ErrorEllipse, n = 96): LatLon[] {
  const theta = ellipse.orientation_deg * D2R;
  const out: LatLon[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const a = ellipse.semi_major_m * Math.cos(t);
    const b = ellipse.semi_minor_m * Math.sin(t);
    const north = a * Math.cos(theta) - b * Math.sin(theta);
    const east = a * Math.sin(theta) + b * Math.cos(theta);
    out.push(applyOffsetM(center, north, east));
  }
  return out;
}

/** The point of the circle (ground point `gp`, radius `zenithDeg`) nearest to `p`. */
export function nearestOnCircle(gp: LatLon, zenithDeg: number, p: LatLon): LatLon {
  const g = pointFromDeg(gp.lat_deg, gp.lon_deg);
  const q = pointFromDeg(p.lat_deg, p.lon_deg);
  const bearing = angularDistance(g, q) === 0 ? 0 : initialBearing(g, q);
  return pointToLatLon(destination(g, bearing, zenithDeg * D2R));
}

/** How far `p` is from the circle, metres (positive outside, negative inside). */
export function offCircleM(gp: LatLon, zenithDeg: number, p: LatLon): number {
  return distanceM(gp, p) - zenithDeg * D2R * EARTH_RADIUS_M;
}

/**
 * A stretch of the circle centred on the point nearest `near`, `halfSpanM` metres of arc
 * each way, in `n + 1` points. A circle of position is thousands of kilometres across, so
 * a close-up draws only this piece of it, densely enough to stay exact at any zoom.
 */
export function circleArcNear(gp: LatLon, zenithDeg: number, near: LatLon, halfSpanM: number, n = 64): LatLon[] {
  const g = pointFromDeg(gp.lat_deg, gp.lon_deg);
  const q = pointFromDeg(near.lat_deg, near.lon_deg);
  const z = zenithDeg * D2R;
  const b0 = angularDistance(g, q) === 0 ? 0 : initialBearing(g, q);
  // Arc length along a small circle of angular radius z is sin(z) * (bearing change).
  const radius = Math.max(Math.sin(z), 1e-9) * EARTH_RADIUS_M;
  const half = Math.min(Math.PI, halfSpanM / radius);
  const out: LatLon[] = [];
  for (let i = 0; i <= n; i++) {
    const b = b0 - half + (2 * half * i) / n;
    out.push(pointToLatLon(destination(g, b, z)));
  }
  return out;
}

/** The whole circle, `n` points from due north of the ground point, clockwise. */
export function fullCircle(gp: LatLon, zenithDeg: number, n = 360): LatLon[] {
  return circleOfPosition(gp, zenithDeg, n);
}

/** Radius of a circle of position: metres and nautical miles (1' of arc = 1 NM). */
export function circleRadius(zenithDeg: number): { m: number; nm: number } {
  const nm = zenithDeg * 60;
  return { m: nm * NM_M, nm };
}

export type Vec3 = [number, number, number];

export function toVec(p: LatLon): Vec3 {
  const lat = p.lat_deg * D2R;
  const lon = p.lon_deg * D2R;
  return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
}

export function fromVec(v: Vec3): LatLon {
  const [x, y, z] = v;
  return { lat_deg: Math.atan2(z, Math.hypot(x, y)) / D2R, lon_deg: Math.atan2(y, x) / D2R };
}

/**
 * The direction "in the middle" of some points (their normalised vector mean), for
 * centring a globe on everything that matters. Null when they cancel out.
 */
export function meanDirection(points: readonly LatLon[]): LatLon | null {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const p of points) {
    const v = toVec(p);
    x += v[0];
    y += v[1];
    z += v[2];
  }
  const n = Math.hypot(x, y, z);
  if (!(n > 1e-9)) return null;
  return fromVec([x / n, y / n, z / n]);
}

/** Wrap a longitude into (-180, 180]. */
export function wrapLon(lon: number): number {
  const x = (((lon % 360) + 360) % 360);
  return x > 180 ? x - 360 : x;
}
