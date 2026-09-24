/**
 * A small port of the parts of `skyfix_core::geometry` the *drawing* code needs, so the
 * plot can render without waiting for a WASM build. Radians internally, degrees at the
 * boundary, longitude east-positive, GHA west-positive — CONVENTIONS sections 2-3.
 *
 * The authoritative implementation is Rust. When the WASM package is present the UI
 * calls `circle_points` there instead; these functions then only serve the mock adapter
 * and the unit tests that pin the two implementations to the same convention.
 */

import type { LatLon } from './types.js';

const D = Math.PI / 180;

export function toRad(deg: number): number {
  return deg * D;
}
export function toDeg(rad: number): number {
  return rad / D;
}

/** Normalise to (-pi, pi]. */
export function normPi(rad: number): number {
  const twoPi = 2 * Math.PI;
  let x = rad % twoPi;
  if (x <= -Math.PI) x += twoPi;
  if (x > Math.PI) x -= twoPi;
  return x;
}

/** Normalise to [0, 2pi). */
export function norm2Pi(rad: number): number {
  const twoPi = 2 * Math.PI;
  const x = ((rad % twoPi) + twoPi) % twoPi;
  return x === twoPi ? 0 : x;
}

/** Normalise to [0, 360). */
export function norm360(deg: number): number {
  const x = ((deg % 360) + 360) % 360;
  return x === 360 ? 0 : x;
}

export interface PointRad {
  lat: number;
  lon: number;
}

export function pointFromDeg(latDeg: number, lonDeg: number): PointRad {
  return { lat: toRad(latDeg), lon: normPi(toRad(lonDeg)) };
}

export function pointToLatLon(p: PointRad): LatLon {
  return { lat_deg: toDeg(p.lat), lon_deg: toDeg(normPi(p.lon)) };
}

/** Normalise a longitude to (-180, +180]. */
export function norm180Deg(deg: number): number {
  const x = norm360(deg);
  return x > 180 ? x - 360 : x;
}

/** Geographic position of a body: lat = dec, lon_east = -GHA (CONVENTIONS section 2). */
export function geographicPosition(ghaDeg: number, decDeg: number): LatLon {
  return { lat_deg: decDeg, lon_deg: norm180Deg(-ghaDeg) };
}

export function angularDistance(a: PointRad, b: PointRad): number {
  const dLon = b.lon - a.lon;
  const sa = Math.sin(a.lat);
  const ca = Math.cos(a.lat);
  const sb = Math.sin(b.lat);
  const cb = Math.cos(b.lat);
  const y = Math.hypot(cb * Math.sin(dLon), ca * sb - sa * cb * Math.cos(dLon));
  const x = sa * sb + ca * cb * Math.cos(dLon);
  return Math.atan2(y, x);
}

/** Initial bearing from a to b, [0, 2pi) clockwise from north. */
export function initialBearing(a: PointRad, b: PointRad): number {
  const dLon = b.lon - a.lon;
  const y = Math.sin(dLon) * Math.cos(b.lat);
  const x = Math.cos(a.lat) * Math.sin(b.lat) - Math.sin(a.lat) * Math.cos(b.lat) * Math.cos(dLon);
  return norm2Pi(Math.atan2(y, x));
}

/** Point reached from `start` travelling `distance` radians along `bearing`. */
export function destination(start: PointRad, bearing: number, distance: number): PointRad {
  const sl = Math.sin(start.lat);
  const cl = Math.cos(start.lat);
  const sd = Math.sin(distance);
  const cd = Math.cos(distance);
  const sinLat2 = Math.min(1, Math.max(-1, sl * cd + cl * sd * Math.cos(bearing)));
  const lat2 = Math.atan2(sinLat2, Math.sqrt(Math.max(0, 1 - sinLat2 * sinLat2)));
  const lon2 =
    start.lon + Math.atan2(Math.sin(bearing) * sd * cl, cd - sl * sinLat2);
  return { lat: lat2, lon: normPi(lon2) };
}

/**
 * `n` points of the circle of position: every point at angular radius
 * `zenithDistanceDeg` from the body's geographic position. Same ordering as
 * `skyfix_core::geometry::circle_of_position` (due north first, clockwise).
 */
export function circleOfPosition(gp: LatLon, zenithDistanceDeg: number, n: number): LatLon[] {
  const centre = pointFromDeg(gp.lat_deg, gp.lon_deg);
  const z = toRad(zenithDistanceDeg);
  const count = Math.max(3, Math.floor(n));
  const out: LatLon[] = [];
  for (let i = 0; i < count; i++) {
    out.push(pointToLatLon(destination(centre, (2 * Math.PI * i) / count, z)));
  }
  return out;
}

/** Altitude and true azimuth Zn (both radians) of a body at an observer. */
export function altitudeAzimuth(
  observer: PointRad,
  ghaRad: number,
  decRad: number,
): { altitude: number; azimuth: number } {
  const lha = ghaRad + observer.lon;
  const sphi = Math.sin(observer.lat);
  const cphi = Math.cos(observer.lat);
  const sdec = Math.sin(decRad);
  const cdec = Math.cos(decRad);
  const slha = Math.sin(lha);
  const clha = Math.cos(lha);
  const up = sphi * sdec + cphi * cdec * clha;
  const north = cphi * sdec - sphi * cdec * clha;
  const east = -cdec * slha;
  return { altitude: Math.atan2(up, Math.hypot(north, east)), azimuth: norm2Pi(Math.atan2(east, north)) };
}

/** Degrees in, degrees out. */
export function altitudeAzimuthDeg(
  observer: LatLon,
  ghaDeg: number,
  decDeg: number,
): { altitude_deg: number; azimuth_deg: number } {
  const r = altitudeAzimuth(
    pointFromDeg(observer.lat_deg, observer.lon_deg),
    toRad(ghaDeg),
    toRad(decDeg),
  );
  return { altitude_deg: toDeg(r.altitude), azimuth_deg: toDeg(r.azimuth) };
}

/** Both intersections of two circles of position, or null when they do not meet. */
export function twoCircleIntersections(
  gp1: LatLon,
  z1Deg: number,
  gp2: LatLon,
  z2Deg: number,
): [LatLon, LatLon] | null {
  const unit = (p: LatLon): [number, number, number] => {
    const lat = toRad(p.lat_deg);
    const lon = toRad(p.lon_deg);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
  };
  const g1 = unit(gp1);
  const g2 = unit(gp2);
  const d = Math.min(1, Math.max(-1, g1[0] * g2[0] + g1[1] * g2[1] + g1[2] * g2[2]));
  const oneMinusD2 = 1 - d * d;
  if (oneMinusD2 < 1e-18) return null;
  const c1 = Math.cos(toRad(z1Deg));
  const c2 = Math.cos(toRad(z2Deg));
  const a = (c1 - c2 * d) / oneMinusD2;
  const b = (c2 - c1 * d) / oneMinusD2;
  const t2 = (1 - a * a - b * b - 2 * a * b * d) / oneMinusD2;
  if (t2 <= 0) return null;
  const t = Math.sqrt(t2);
  const cross: [number, number, number] = [
    g1[1] * g2[2] - g1[2] * g2[1],
    g1[2] * g2[0] - g1[0] * g2[2],
    g1[0] * g2[1] - g1[1] * g2[0],
  ];
  const base: [number, number, number] = [
    a * g1[0] + b * g2[0],
    a * g1[1] + b * g2[1],
    a * g1[2] + b * g2[2],
  ];
  const fromUnit = (v: [number, number, number]): LatLon => ({
    lat_deg: toDeg(Math.atan2(v[2], Math.hypot(v[0], v[1]))),
    lon_deg: toDeg(Math.atan2(v[1], v[0])),
  });
  return [
    fromUnit([base[0] + t * cross[0], base[1] + t * cross[1], base[2] + t * cross[2]]),
    fromUnit([base[0] - t * cross[0], base[1] - t * cross[1], base[2] - t * cross[2]]),
  ];
}
