/**
 * Distances and courses for the map's measuring tool. OWNER: map-data agent.
 *
 * The Earth is the project's reference sphere (CONVENTIONS section 1): one arcminute of
 * great-circle arc is exactly one nautical mile, 1852 m, so the radius is
 * `1852 * 10800 / pi` = 6 366 707.02 m. Angles in and out are degrees; latitude north-positive,
 * longitude east-positive (section 2); courses are true, clockwise from north, [0, 360).
 *
 * Display-only (CONVENTIONS 13.6): these numbers are for the ruler on the map, never for
 * sight reduction or the solver (which live in Rust).
 */

import type { LatLonDeg } from '../engine/types.js';

export const NM_M = 1852;
export const EARTH_RADIUS_M = (NM_M * 10800) / Math.PI;
/** Nautical miles per radian of arc: 10800 / pi. */
export const NM_PER_RADIAN = 10800 / Math.PI;

const RAD = Math.PI / 180;

function norm360(deg: number): number {
  const x = ((deg % 360) + 360) % 360;
  return x === 360 || x === 0 ? 0 : x;
}

/** (-180, 180], never -0. */
export function normalizeLon(lonDeg: number): number {
  if (lonDeg > -180 && lonDeg <= 180) return lonDeg === 0 ? 0 : lonDeg;
  let x = ((((lonDeg + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x === 0 ? 0 : x;
}

/** Longitude difference b - a taken the short way round, (-180, 180]. */
function deltaLon(a: number, b: number): number {
  return normalizeLon(b - a);
}

// ---------------------------------------------------------------------------------------
// Great circle

/** Central angle between two points, radians (atan2 form: accurate for tiny and near-antipodal arcs). */
export function centralAngle(a: LatLonDeg, b: LatLonDeg): number {
  const p1 = a.lat_deg * RAD;
  const p2 = b.lat_deg * RAD;
  const dl = deltaLon(a.lon_deg, b.lon_deg) * RAD;
  const y = Math.hypot(Math.cos(p2) * Math.sin(dl), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x);
}

export function greatCircleDistanceNm(a: LatLonDeg, b: LatLonDeg): number {
  return centralAngle(a, b) * NM_PER_RADIAN;
}

export function greatCircleDistanceM(a: LatLonDeg, b: LatLonDeg): number {
  return centralAngle(a, b) * EARTH_RADIUS_M;
}

/**
 * Initial great-circle course from `a` to `b`, degrees [0, 360). NaN when the points coincide
 * or are antipodal (every direction is then a shortest route). From a pole every route runs
 * along a meridian: 180 from the North Pole, 0 from the South Pole.
 */
export function initialCourseDeg(a: LatLonDeg, b: LatLonDeg): number {
  const sigma = centralAngle(a, b);
  if (sigma < 1e-12 || Math.PI - sigma < 1e-12) return Number.NaN;
  const p1 = a.lat_deg * RAD;
  const p2 = b.lat_deg * RAD;
  if (Math.abs(a.lat_deg) >= 90) return a.lat_deg > 0 ? 180 : 0;
  const dl = deltaLon(a.lon_deg, b.lon_deg) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm360(Math.atan2(y, x) / RAD);
}

/** Course on arrival at `b` along the great circle from `a`, degrees [0, 360). NaN as above. */
export function finalCourseDeg(a: LatLonDeg, b: LatLonDeg): number {
  const back = initialCourseDeg(b, a);
  return Number.isNaN(back) ? back : norm360(back + 180);
}

function toVector(p: LatLonDeg): [number, number, number] {
  const phi = p.lat_deg * RAD;
  const lam = p.lon_deg * RAD;
  return [Math.cos(phi) * Math.cos(lam), Math.cos(phi) * Math.sin(lam), Math.sin(phi)];
}

function fromVector(v: [number, number, number]): LatLonDeg {
  const [x, y, z] = v;
  const lat = Math.atan2(z, Math.hypot(x, y)) / RAD;
  const lon = Math.hypot(x, y) < 1e-15 ? 0 : Math.atan2(y, x) / RAD;
  return { lat_deg: lat, lon_deg: normalizeLon(lon) };
}

/**
 * The point a fraction `f` of the way from `a` to `b` along the great circle (0 = a, 1 = b).
 * For antipodal points the route is not unique; one is chosen deterministically by nudging
 * `b` by 1e-9 degrees.
 */
export function intermediatePoint(a: LatLonDeg, b: LatLonDeg, f: number): LatLonDeg {
  let sigma = centralAngle(a, b);
  let bb = b;
  if (Math.PI - sigma < 1e-9) {
    bb = { lat_deg: b.lat_deg + (b.lat_deg < 89 ? 1e-9 : -1e-9), lon_deg: b.lon_deg + 1e-9 };
    sigma = centralAngle(a, bb);
  }
  if (sigma < 1e-15) return { lat_deg: a.lat_deg, lon_deg: normalizeLon(a.lon_deg) };
  const va = toVector(a);
  const vb = toVector(bb);
  const s = Math.sin(sigma);
  const ka = Math.sin((1 - f) * sigma) / s;
  const kb = Math.sin(f * sigma) / s;
  return fromVector([ka * va[0] + kb * vb[0], ka * va[1] + kb * vb[1], ka * va[2] + kb * vb[2]]);
}

export interface PointsOptions {
  /** Number of segments (points - 1). Default: one segment per `maxStepNm`. */
  segments?: number;
  /** Longest segment, nautical miles, when `segments` is not given. Default 60 (one degree of arc). */
  maxStepNm?: number;
}

function segmentCount(distanceNm: number, opts: PointsOptions): number {
  if (opts.segments !== undefined) return Math.max(1, Math.floor(opts.segments));
  const step = opts.maxStepNm ?? 60;
  return Math.max(1, Math.min(10_000, Math.ceil(distanceNm / step)));
}

/** Points along the great circle from `a` to `b`, both ends included, longitudes in (-180, 180]. */
export function greatCirclePoints(a: LatLonDeg, b: LatLonDeg, opts: PointsOptions = {}): LatLonDeg[] {
  const n = segmentCount(greatCircleDistanceNm(a, b), opts);
  const out: LatLonDeg[] = [];
  for (let i = 0; i <= n; i++) out.push(intermediatePoint(a, b, i / n));
  return out;
}

/** The point reached from `a` after `distanceNm` along the great circle on initial course `courseDeg`. */
export function destinationPoint(a: LatLonDeg, courseDeg: number, distanceNm: number): LatLonDeg {
  const p1 = a.lat_deg * RAD;
  const d = distanceNm / NM_PER_RADIAN;
  const c = courseDeg * RAD;
  const sinP2 = Math.min(1, Math.max(-1, Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(c)));
  const p2 = Math.asin(sinP2);
  const dl = Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * sinP2);
  return { lat_deg: p2 / RAD, lon_deg: normalizeLon(a.lon_deg + dl / RAD) };
}

// ---------------------------------------------------------------------------------------
// Rhumb line (loxodrome): constant course, a straight line on a Mercator chart

const MAX_LAT_RAD = (Math.PI / 2) * (1 - 1e-12);

/** Isometric latitude psi = ln tan(pi/4 + phi/2), clamped just short of the poles. */
function isometric(phiRad: number): number {
  const p = Math.max(-MAX_LAT_RAD, Math.min(MAX_LAT_RAD, phiRad));
  return Math.log(Math.tan(Math.PI / 4 + p / 2));
}

function rhumbParts(a: LatLonDeg, b: LatLonDeg): { dPhi: number; dPsi: number; dLam: number; q: number } {
  const p1 = a.lat_deg * RAD;
  const p2 = b.lat_deg * RAD;
  const dPhi = p2 - p1;
  const dPsi = isometric(p2) - isometric(p1);
  const dLam = deltaLon(a.lon_deg, b.lon_deg) * RAD;
  // q = dPhi / dPsi, which tends to cos(phi) on an east-west line.
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(p1);
  return { dPhi, dPsi, dLam, q };
}

/** Rhumb-line distance, nautical miles (the short way round in longitude). */
export function rhumbDistanceNm(a: LatLonDeg, b: LatLonDeg): number {
  const { dPhi, dLam, q } = rhumbParts(a, b);
  return Math.hypot(dPhi, q * dLam) * NM_PER_RADIAN;
}

/** Constant rhumb-line course from `a` to `b`, degrees [0, 360). NaN when the points coincide. */
export function rhumbCourseDeg(a: LatLonDeg, b: LatLonDeg): number {
  const { dPsi, dLam, dPhi } = rhumbParts(a, b);
  if (Math.abs(dPhi) < 1e-15 && Math.abs(dLam) < 1e-15) return Number.NaN;
  return norm360(Math.atan2(dLam, dPsi) / RAD);
}

/** The point reached from `a` after `distanceNm` on constant course `courseDeg`. */
export function rhumbDestination(a: LatLonDeg, courseDeg: number, distanceNm: number): LatLonDeg {
  const d = distanceNm / NM_PER_RADIAN;
  const c = courseDeg * RAD;
  const p1 = a.lat_deg * RAD;
  let p2 = p1 + d * Math.cos(c);
  // A rhumb line cannot pass a pole: it spirals into it. Stop there.
  if (Math.abs(p2) > Math.PI / 2) p2 = p2 > 0 ? Math.PI / 2 : -Math.PI / 2;
  const dPsi = isometric(p2) - isometric(p1);
  const q = Math.abs(dPsi) > 1e-12 ? (p2 - p1) / dPsi : Math.cos(p1);
  const dLam = Math.abs(q) > 1e-15 ? (d * Math.sin(c)) / q : 0;
  return { lat_deg: p2 / RAD, lon_deg: normalizeLon(a.lon_deg + dLam / RAD) };
}

/** Points along the rhumb line from `a` to `b` (equal steps of distance), both ends included. */
export function rhumbPoints(a: LatLonDeg, b: LatLonDeg, opts: PointsOptions = {}): LatLonDeg[] {
  const dist = rhumbDistanceNm(a, b);
  const n = segmentCount(dist, opts);
  const course = rhumbCourseDeg(a, b);
  const out: LatLonDeg[] = [];
  if (Number.isNaN(course)) return [a, b];
  for (let i = 0; i <= n; i++) out.push(i === n ? { lat_deg: b.lat_deg, lon_deg: normalizeLon(b.lon_deg) } : rhumbDestination(a, course, (dist * i) / n));
  return out;
}

// ---------------------------------------------------------------------------------------
// Paths and the antimeridian

export type PathMode = 'great-circle' | 'rhumb';

/** Total length of a path of legs, nautical miles. */
export function pathLengthNm(points: readonly LatLonDeg[], mode: PathMode = 'great-circle'): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as LatLonDeg;
    const b = points[i] as LatLonDeg;
    total += mode === 'rhumb' ? rhumbDistanceNm(a, b) : greatCircleDistanceNm(a, b);
  }
  return total;
}

/**
 * GeoJSON coordinates with continuous longitudes: each point is moved by a multiple of 360
 * so that no step exceeds 180 degrees. MapLibre draws such a line straight across the
 * antimeridian (longitudes may go beyond +/-180), which is what a line layer wants.
 */
export function unwrapLongitudes(points: readonly LatLonDeg[]): [number, number][] {
  const out: [number, number][] = [];
  let prev: number | null = null;
  for (const p of points) {
    let lon = p.lon_deg;
    if (prev !== null) {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([lon, p.lat_deg]);
    prev = lon;
  }
  return out;
}

/**
 * Split a path where it crosses the antimeridian, as RFC 7946 asks for GeoJSON: each piece
 * stays within [-180, 180] and the pieces meet at +/-180, at the latitude where the straight
 * segment between the two neighbouring points crosses it (points are dense enough for that
 * to be the great circle's crossing to well under a pixel).
 */
export function splitAtAntimeridian(points: readonly LatLonDeg[]): [number, number][][] {
  const pieces: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i] as LatLonDeg;
    const lon = normalizeLon(p.lon_deg);
    if (i > 0) {
      const q = points[i - 1] as LatLonDeg;
      const qlon = normalizeLon(q.lon_deg);
      if (Math.abs(lon - qlon) > 180) {
        const seam = qlon > 0 ? 180 : -180;
        const lonUnwrapped = qlon > 0 ? lon + 360 : lon - 360;
        const t = (seam - qlon) / (lonUnwrapped - qlon);
        const lat = q.lat_deg + t * (p.lat_deg - q.lat_deg);
        cur.push([seam, lat]);
        pieces.push(cur);
        cur = [[-seam, lat]];
      }
    }
    cur.push([lon, p.lat_deg]);
  }
  if (cur.length) pieces.push(cur);
  return pieces.filter((piece) => piece.length >= 2);
}
