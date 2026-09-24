/**
 * Spherical geometry for the map's world layers, as GeoJSON that MapLibre draws correctly in
 * both the flat (Mercator) and the globe projection. OWNER: map agent. Pure: no DOM, no
 * engine calls; tested in web/test/next/map-geometry.test.ts.
 *
 * Everything the map draws that is "a circle on the Earth" goes through here: the day/night
 * terminator and the twilight bands (small circles around the antisolar point), the circle
 * of equal altitude through the observer, altitude rings around a ground point, and the
 * overlays other views add (circles of position, eclipse paths, the fix ellipse).
 *
 * Conventions (CONVENTIONS sections 1-2): degrees; latitude north-positive; longitude
 * east-positive; GeoJSON positions are `[lon, lat]`. The Earth is the reference sphere,
 * so "radius" here is an angle: 1 degree of arc = 60 NM.
 *
 * The two hard cases, both handled once here so no caller has to:
 *  - the antimeridian: RFC 7946 asks for geometry split at +/-180 with every position in
 *    [-180, 180]. Lines are cut where they cross; polygons are clipped into pieces that
 *    meet exactly on the seam.
 *  - the poles: a cap that contains a pole has a boundary that runs all the way round in
 *    longitude, so as a polygon in [lon, lat] it is closed along the pole's latitude
 *    (+/-90). A cap that contains both poles (radius over 90 degrees around a point near
 *    the equator) is the whole world minus the opposite cap.
 * Exterior rings are counter-clockwise (RFC 7946); MapLibre relies on consistent winding
 * to tell separate polygons from holes.
 */

import type { Feature, FeatureCollection, MultiLineString, MultiPolygon, Position } from 'geojson';
import type { LatLonDeg } from '../engine/types.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** A new empty FeatureCollection. */
export function emptyCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] };
}

/** Longitude in (-180, 180], never -0. */
export function wrapLon(lon: number): number {
  if (lon > -180 && lon <= 180) return lon === 0 ? 0 : lon;
  let x = ((((lon + 180) % 360) + 360) % 360) - 180;
  if (x === -180) x = 180;
  return x === 0 ? 0 : x;
}

type Vec3 = [number, number, number];

function toVec(p: LatLonDeg): Vec3 {
  const phi = p.lat_deg * RAD;
  const lam = p.lon_deg * RAD;
  const c = Math.cos(phi);
  return [c * Math.cos(lam), c * Math.sin(lam), Math.sin(phi)];
}

function fromVec(v: Vec3): LatLonDeg {
  const [x, y, z] = v;
  const lat = Math.atan2(z, Math.hypot(x, y)) * DEG;
  const lon = Math.abs(lat) > 90 - 1e-12 ? 0 : Math.atan2(y, x) * DEG;
  return { lat_deg: lat, lon_deg: wrapLon(lon) };
}

/** Angular distance between two points, degrees (atan2 form: accurate everywhere). */
export function angularDistanceDeg(a: LatLonDeg, b: LatLonDeg): number {
  const u = toVec(a);
  const v = toVec(b);
  const cx = u[1] * v[2] - u[2] * v[1];
  const cy = u[2] * v[0] - u[0] * v[2];
  const cz = u[0] * v[1] - u[1] * v[0];
  return Math.atan2(Math.hypot(cx, cy, cz), u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) * DEG;
}

/** The point at angular distance `distanceDeg` from `from` on initial true bearing `bearingDeg`. */
export function destination(from: LatLonDeg, bearingDeg: number, distanceDeg: number): LatLonDeg {
  const { c, north, east } = frame(from);
  const t = bearingDeg * RAD;
  const d = distanceDeg * RAD;
  const cd = Math.cos(d);
  const sd = Math.sin(d);
  const ct = Math.cos(t);
  const st = Math.sin(t);
  return fromVec([
    c[0] * cd + (north[0] * ct + east[0] * st) * sd,
    c[1] * cd + (north[1] * ct + east[1] * st) * sd,
    c[2] * cd + (north[2] * ct + east[2] * st) * sd,
  ]);
}

/** The point's unit vector and the local north and east unit vectors (any pair at a pole). */
function frame(p: LatLonDeg): { c: Vec3; north: Vec3; east: Vec3 } {
  const phi = p.lat_deg * RAD;
  const lam = p.lon_deg * RAD;
  const sp = Math.sin(phi);
  const cp = Math.cos(phi);
  const sl = Math.sin(lam);
  const cl = Math.cos(lam);
  return {
    c: [cp * cl, cp * sl, sp],
    north: [-sp * cl, -sp * sl, cp],
    east: [-sl, cl, 0],
  };
}

/**
 * Points of the small circle of angular radius `radiusDeg` around `center`, clockwise as seen
 * from above (bearing 0, 360/n, ...), closed: `segments + 1` points, the last equal to the first.
 */
export function smallCircle(center: LatLonDeg, radiusDeg: number, segments = 360): LatLonDeg[] {
  const n = Math.max(8, Math.floor(segments));
  const { c, north, east } = frame(center);
  const cd = Math.cos(radiusDeg * RAD);
  const sd = Math.sin(radiusDeg * RAD);
  const out: LatLonDeg[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const ct = Math.cos(t) * sd;
    const st = Math.sin(t) * sd;
    out.push(
      fromVec([
        c[0] * cd + north[0] * ct + east[0] * st,
        c[1] * cd + north[1] * ct + east[1] * st,
        c[2] * cd + north[2] * ct + east[2] * st,
      ]),
    );
  }
  out.push(out[0]!);
  return out;
}

/** Which poles lie strictly inside the cap of angular radius `radiusDeg` around `center`. */
export function capPoles(center: LatLonDeg, radiusDeg: number): { north: boolean; south: boolean } {
  return { north: 90 - center.lat_deg < radiusDeg, south: 90 + center.lat_deg < radiusDeg };
}

// ---------------------------------------------------------------------------------------
// Lines

/**
 * An open path as GeoJSON line coordinates split at the antimeridian: each piece lies in
 * [-180, 180] and consecutive pieces meet on the seam at the latitude where the segment
 * crosses it (points must be dense enough for a straight segment in [lon, lat] to stand for
 * the curve, which one-degree steps are).
 */
export function splitLine(points: readonly LatLonDeg[]): Position[][] {
  const pieces: Position[][] = [];
  let cur: Position[] = [];
  let prevLon = 0;
  let prevLat = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    const lon = wrapLon(p.lon_deg);
    const lat = p.lat_deg;
    if (i > 0 && Math.abs(lon - prevLon) > 180) {
      // Crossing the seam between prev and this point.
      const seam = prevLon > 0 ? 180 : -180;
      const lonU = prevLon > 0 ? lon + 360 : lon - 360;
      const t = (seam - prevLon) / (lonU - prevLon);
      const latSeam = prevLat + t * (lat - prevLat);
      cur.push([seam, latSeam]);
      if (cur.length >= 2) pieces.push(cur);
      cur = [[-seam, latSeam]];
    }
    cur.push([lon, lat]);
    prevLon = lon;
    prevLat = lat;
  }
  if (cur.length >= 2) pieces.push(cur);
  return pieces;
}

function samePosition(a: Position | undefined, b: Position | undefined): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1];
}

/**
 * A closed ring (first point = last point) as line pieces split at the antimeridian. The
 * piece that ends where the ring started is joined to the first one, so the only breaks are
 * on the seam.
 */
export function splitClosedLine(ring: readonly LatLonDeg[]): Position[][] {
  const pieces = splitLine(ring);
  if (pieces.length >= 2) {
    const first = pieces[0]!;
    const last = pieces[pieces.length - 1]!;
    if (samePosition(last[last.length - 1], first[0])) {
      pieces[0] = [...last.slice(0, -1), ...first];
      pieces.pop();
    }
  }
  return pieces;
}

/** The small circle as line pieces (for strokes), split at the antimeridian. */
export function circleLine(center: LatLonDeg, radiusDeg: number, segments = 360): Position[][] {
  if (!(radiusDeg > 0) || radiusDeg >= 180) return [];
  return splitClosedLine(smallCircle(center, radiusDeg, segments));
}

// ---------------------------------------------------------------------------------------
// Polygons

/** Signed area of a ring in the [lon, lat] plane; positive = counter-clockwise. */
export function ringArea(ring: readonly Position[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[i]!;
    const q = ring[j]!;
    a += (q[0]! - p[0]!) * (q[1]! + p[1]!);
  }
  return a / 2;
}

function closeRing(ring: Position[]): Position[] {
  if (ring.length && !samePosition(ring[0], ring[ring.length - 1])) ring.push([ring[0]![0]!, ring[0]![1]!]);
  return ring;
}

function orient(ring: Position[], ccw: boolean): Position[] {
  const a = ringArea(ring);
  return (a > 0) === ccw ? ring : ring.slice().reverse();
}

/** Continuous longitudes: each point moved by a multiple of 360 so that no step exceeds 180. */
export function unwrap(points: readonly LatLonDeg[]): Position[] {
  const out: Position[] = [];
  let prev: number | null = null;
  for (const p of points) {
    let lon = p.lon_deg;
    if (prev === null) lon = wrapLon(lon);
    else {
      while (lon - prev > 180) lon -= 360;
      while (lon - prev < -180) lon += 360;
    }
    out.push([lon, p.lat_deg]);
    prev = lon;
  }
  return out;
}

/** Sutherland-Hodgman against one vertical half-plane: keep x >= edge (`keepAbove`) or x <= edge. */
function clipHalf(ring: readonly Position[], edge: number, keepAbove: boolean): Position[] {
  const out: Position[] = [];
  const inside = (p: Position) => (keepAbove ? p[0]! >= edge : p[0]! <= edge);
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const cur = ring[i]!;
    const prev = ring[(i + n - 1) % n]!;
    const ci = inside(cur);
    const pi = inside(prev);
    if (ci !== pi) {
      const t = (edge - prev[0]!) / (cur[0]! - prev[0]!);
      out.push([edge, prev[1]! + t * (cur[1]! - prev[1]!)]);
    }
    if (ci) out.push(cur);
  }
  return out;
}

/**
 * Clip a ring given in continuous longitudes into pieces inside [-180, 180]: the part in
 * each 360-degree "world copy" it touches, shifted back into the main one. Rings must be
 * simple and cross any line of constant longitude at most twice (true for small circles and
 * for the pole-closed caps built here).
 */
export function splitRing(ring: readonly Position[]): Position[][] {
  const open = samePosition(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring.slice();
  if (open.length < 3) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const p of open) {
    if (p[0]! < min) min = p[0]!;
    if (p[0]! > max) max = p[0]!;
  }
  const out: Position[][] = [];
  const k0 = Math.floor((min + 180) / 360);
  const k1 = Math.ceil((max + 180) / 360) - 1;
  for (let k = k0; k <= k1; k++) {
    const lo = -180 + 360 * k;
    const hi = 180 + 360 * k;
    if (max <= lo || min >= hi) continue;
    let piece = open;
    if (min < lo) piece = clipHalf(piece, lo, true);
    if (max > hi) piece = clipHalf(piece, hi, false);
    if (piece.length < 3) continue;
    const shifted = piece.map((p): Position => [p[0]! - 360 * k, p[1]!]);
    if (Math.abs(ringArea(shifted)) < 1e-12) continue;
    out.push(closeRing(shifted));
  }
  return out;
}

const WORLD_RING: Position[] = [
  [-180, -90],
  [180, -90],
  [180, 90],
  [-180, 90],
  [-180, -90],
];

/**
 * The cap within `radiusDeg` of `center` (the region inside the small circle) as
 * MultiPolygon coordinates: split at the antimeridian, closed along the pole when it
 * contains one, the world minus the opposite cap when it contains both.
 */
export function capPolygon(center: LatLonDeg, radiusDeg: number, segments = 360): Position[][][] {
  if (!(radiusDeg > 0)) return [];
  if (radiusDeg >= 180) return [[WORLD_RING.map((p) => [...p])]];
  const poles = capPoles(center, radiusDeg);
  if (poles.north && poles.south) return worldMinusCap({ lat_deg: -center.lat_deg, lon_deg: wrapLon(center.lon_deg + 180) }, 180 - radiusDeg, segments);

  const ring = unwrap(smallCircle(center, radiusDeg, segments));
  if (!poles.north && !poles.south) {
    return splitRing(ring).map((r) => [orient(r, true)]);
  }
  // One pole: the boundary winds once round it. Walk it eastwards, then close along the pole.
  let pts = ring;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (last[0]! < first[0]!) pts = pts.slice().reverse();
  const start = pts[0]!;
  const end = pts[pts.length - 1]!;
  const poleLat = poles.north ? 90 : -90;
  const closed: Position[] = [...pts.slice(0, -1), [end[0]!, end[1]!], [end[0]!, poleLat], [start[0]!, poleLat]];
  return splitRing(closed).map((r) => [orient(r, true)]);
}

/**
 * The whole world except the cap within `radiusDeg` of `center` (a cap containing no pole):
 * vertical strips either side of the cap, and above and below it within its longitude span.
 */
function worldMinusCap(center: LatLonDeg, radiusDeg: number, segments: number): Position[][][] {
  const ring = unwrap(smallCircle(center, radiusDeg, segments)).slice(0, -1);
  if (ring.length < 3) return [[WORLD_RING.map((p) => [...p])]];
  // Leftmost and rightmost points split the boundary into an upper and a lower chain.
  let iMin = 0;
  let iMax = 0;
  ring.forEach((p, i) => {
    if (p[0]! < ring[iMin]![0]!) iMin = i;
    if (p[0]! > ring[iMax]![0]!) iMax = i;
  });
  const n = ring.length;
  const chain = (from: number, to: number): Position[] => {
    const out: Position[] = [];
    for (let i = from; ; i = (i + 1) % n) {
      out.push(ring[i]!);
      if (i === to) break;
    }
    return out;
  };
  const a = chain(iMin, iMax);
  const b = chain(iMax, iMin);
  const meanLat = (c: Position[]) => c.reduce((s, p) => s + p[1]!, 0) / c.length;
  const upper = meanLat(a) >= meanLat(b) ? a : b.slice().reverse();
  const lower = meanLat(a) >= meanLat(b) ? b.slice().reverse() : a;
  // Both chains now run from the leftmost to the rightmost point.
  const x0 = ring[iMin]![0]!;
  const x1 = ring[iMax]![0]!;
  const pieces: Position[][] = [];
  pieces.push([...upper, [x1, 90], [x0, 90]]);
  pieces.push([...lower, [x1, -90], [x0, -90]]);
  if (x1 - x0 < 360) {
    // The rest of the world, as one strip from the cap's right edge round to its left edge.
    pieces.push([
      [x1, -90],
      [x0 + 360, -90],
      [x0 + 360, 90],
      [x1, 90],
    ]);
  }
  const out: Position[][][] = [];
  for (const p of pieces) for (const r of splitRing(closeRing(p))) out.push([orient(r, true)]);
  return out;
}

/** A simple ring (not enclosing a pole) as MultiPolygon coordinates split at the antimeridian. */
export function polygonPieces(ring: readonly LatLonDeg[]): Position[][][] {
  return splitRing(unwrap(ring)).map((r) => [orient(r, true)]);
}

// ---------------------------------------------------------------------------------------
// Shapes other views need

/**
 * An ellipse on the sphere around `center`: semi-axes in nautical miles, the major axis on
 * true bearing `orientationDeg`. Built point by point along geodesics from the centre, which
 * for fix ellipses (a few NM to a few hundred) is the tangent-plane ellipse to well under a
 * pixel. Closed ring.
 */
export function ellipseRing(
  center: LatLonDeg,
  semiMajorNm: number,
  semiMinorNm: number,
  orientationDeg: number,
  segments = 96,
): LatLonDeg[] {
  const n = Math.max(8, Math.floor(segments));
  const out: LatLonDeg[] = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    const along = semiMajorNm * Math.cos(t);
    const across = semiMinorNm * Math.sin(t);
    const dist = Math.hypot(along, across);
    const bearing = orientationDeg + Math.atan2(across, along) * DEG;
    out.push(dist === 0 ? { ...center } : destination(center, bearing, dist / 60));
  }
  out.push(out[0]!);
  return out;
}

// ---------------------------------------------------------------------------------------
// The Sun's day/night and twilight bands (CONVENTIONS 13.4)

/**
 * Zenith distance of the Sun at each boundary, as distance from the ANTISOLAR point (every
 * radius is under 90 degrees, so each cap contains at most one pole):
 *   not day:           Sun altitude below -50'  -> within 89 deg 10' of the antisolar point
 *   nautical or darker: below -6 deg            -> within 84 deg
 *   astronomical or darker: below -12 deg       -> within 78 deg
 *   night:             below -18 deg            -> within 72 deg
 */
export const SHADE_BANDS = [
  { band: 'civil', radiusDeg: 90 - 50 / 60 },
  { band: 'nautical', radiusDeg: 84 },
  { band: 'astronomical', radiusDeg: 78 },
  { band: 'night', radiusDeg: 72 },
] as const;

export type ShadeBand = (typeof SHADE_BANDS)[number]['band'];

export function antipode(p: LatLonDeg): LatLonDeg {
  return { lat_deg: -p.lat_deg, lon_deg: wrapLon(p.lon_deg + 180) };
}

/**
 * Per-layer opacities for stacked fills so that the composite darkness in each band equals
 * the theme's target (`--shade-civil` ... `--shade-night`, cumulative): layer k covers every
 * band from k inward, so alpha_k = 1 - (1 - T_k) / (1 - T_{k-1}).
 */
export function stackedAlphas(targets: readonly number[]): number[] {
  let prev = 0;
  return targets.map((t) => {
    const clamped = Math.min(0.98, Math.max(prev, t));
    const a = 1 - (1 - clamped) / (1 - prev);
    prev = clamped;
    return Math.max(0, Math.min(1, a));
  });
}

/** Stacked shading polygons, darkest last, each with its per-layer `alpha`. */
export function twilightFeatures(sunGp: LatLonDeg, alphas: readonly number[], segments = 360): FeatureCollection<MultiPolygon> {
  const anti = antipode(sunGp);
  return {
    type: 'FeatureCollection',
    features: SHADE_BANDS.map((b, i): Feature<MultiPolygon> => ({
      type: 'Feature',
      properties: { band: b.band, alpha: alphas[i] ?? 0 },
      geometry: { type: 'MultiPolygon', coordinates: capPolygon(anti, b.radiusDeg, segments) },
    })),
  };
}

/** The day/night boundary (Sun's centre at -50', the sky-phase "day" edge) as a line. */
export function terminatorLine(sunGp: LatLonDeg, segments = 360): MultiLineString {
  return { type: 'MultiLineString', coordinates: circleLine(antipode(sunGp), SHADE_BANDS[0].radiusDeg, segments) };
}

// ---------------------------------------------------------------------------------------
// Circles of equal altitude

/**
 * Everywhere the body stands at altitude `altitudeDeg` now: the small circle of radius
 * 90 - altitude around its ground point (a navigator's circle of position).
 */
export function equalAltitudeCircle(gp: LatLonDeg, altitudeDeg: number, segments = 360): MultiLineString {
  return { type: 'MultiLineString', coordinates: circleLine(gp, 90 - altitudeDeg, segments) };
}

/** Circles of altitude 0, step, 2 step, ... below 90 around a ground point, labelled. */
export function altitudeRingFeatures(gp: LatLonDeg, stepDeg = 10, segments = 240): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = [];
  for (let h = 0; h < 90 - 1e-9; h += stepDeg) {
    features.push({
      type: 'Feature',
      properties: { altitude: h, label: `${h}°` },
      geometry: { type: 'MultiLineString', coordinates: circleLine(gp, 90 - h, segments) },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------------------------
// Graticule

export interface GraticuleBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** Spacing, degrees, that gives roughly `target` lines across a view `spanDeg` wide. */
export function graticuleStep(spanDeg: number, target = 8): number {
  const steps = [30, 15, 10, 5, 2, 1, 0.5, 0.25, 1 / 6, 1 / 12, 1 / 30, 1 / 60];
  for (const s of steps) if (spanDeg / s >= target * 0.7) return s;
  return steps[steps.length - 1]!;
}

function degLabel(value: number, pos: string, neg: string, step: number): string {
  const abs = Math.abs(value);
  const hemi = abs === 180 ? '' : value > 0 ? pos : value < 0 ? neg : '';
  if (step >= 1) return `${Math.round(abs)}°${hemi ? ` ${hemi}` : ''}`;
  let d = Math.floor(abs + 1e-9);
  let m = Math.round((abs - d) * 60);
  if (m === 60) {
    d += 1;
    m = 0;
  }
  return `${d}° ${String(m).padStart(2, '0')}′${hemi ? ` ${hemi}` : ''}`;
}

/**
 * Meridians and parallels every `stepDeg`, densified so they curve correctly on the globe.
 * With `bounds`, only lines inside them (plus one step) are generated: fine grids are only
 * ever needed for a small view. Longitudes in the result may run past +/-180 when the bounds
 * do (MapLibre draws world copies); labels always say the wrapped value.
 */
export function graticuleFeatures(stepDeg: number, bounds?: GraticuleBounds): FeatureCollection<MultiLineString> {
  const features: Feature<MultiLineString>[] = [];
  const west = bounds ? Math.floor(bounds.west / stepDeg) * stepDeg - stepDeg : -180;
  const east = bounds ? Math.ceil(bounds.east / stepDeg) * stepDeg + stepDeg : 180;
  const south = Math.max(-90, bounds ? Math.floor(bounds.south / stepDeg) * stepDeg - stepDeg : -90);
  const north = Math.min(90, bounds ? Math.ceil(bounds.north / stepDeg) * stepDeg + stepDeg : 90);
  const dense = Math.min(stepDeg, 2);
  const eps = 1e-9;
  const lonCount = Math.round((east - west) / stepDeg);
  for (let i = 0; i <= lonCount; i++) {
    const lon = west + i * stepDeg;
    if (!bounds && lon >= 180 - eps) break; // the global grid has one line at +/-180
    const coords: Position[] = [];
    const lat0 = Math.max(south, -89);
    const lat1 = Math.min(north, 89);
    const m = Math.max(1, Math.ceil((lat1 - lat0) / dense));
    for (let k = 0; k <= m; k++) coords.push([lon, lat0 + ((lat1 - lat0) * k) / m]);
    const w = wrapLon(lon);
    features.push({
      type: 'Feature',
      properties: { kind: 'meridian', value: w, label: degLabel(w === 180 ? 180 : w, 'E', 'W', stepDeg), major: isMajor(w, stepDeg) },
      geometry: { type: 'MultiLineString', coordinates: [coords] },
    });
  }
  const latCount = Math.round((north - south) / stepDeg);
  for (let i = 0; i <= latCount; i++) {
    const lat = south + i * stepDeg;
    if (Math.abs(lat) >= 90 - eps) continue;
    const coords: Position[] = [];
    const m = Math.max(1, Math.ceil((east - west) / dense));
    for (let k = 0; k <= m; k++) coords.push([west + ((east - west) * k) / m, lat]);
    features.push({
      type: 'Feature',
      properties: { kind: 'parallel', value: lat, label: degLabel(lat, 'N', 'S', stepDeg), major: isMajor(lat, stepDeg) },
      geometry: { type: 'MultiLineString', coordinates: [coords] },
    });
  }
  return { type: 'FeatureCollection', features };
}

function isMajor(value: number, step: number): boolean {
  const major = step >= 10 ? 30 : step >= 1 ? 10 : 1;
  return Math.abs(value / major - Math.round(value / major)) < 1e-9;
}

// ---------------------------------------------------------------------------------------
// Point-in-polygon on the output (used by the tests and by hit-testing)

/** Even-odd test of a [lon, lat] position against MultiPolygon coordinates. */
export function multiPolygonContains(coords: readonly (readonly (readonly Position[])[])[], p: Position): boolean {
  let inside = false;
  for (const poly of coords) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a[1]! > p[1]! !== b[1]! > p[1]! && p[0]! < ((b[0]! - a[0]!) * (p[1]! - a[1]!)) / (b[1]! - a[1]!) + a[0]!) {
          inside = !inside;
        }
      }
    }
  }
  return inside;
}
