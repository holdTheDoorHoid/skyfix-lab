/**
 * Small pure helpers behind the Selected card's SunCalc-style tools: the length of a
 * shadow, reading a height or a bearing typed for "When is it at…?" and the alignment
 * finder, the direction from the place to a point picked on the map, and the words and
 * numbers the photographer's and astronomer's rows share. OWNER: photo agent (expansion
 * programme Q8; first written by the shell-design agent's polish pass). Tested in
 * panel-tools.test.ts and photo-tools.test.ts.
 *
 * Nothing here computes astronomy: altitudes, azimuths and times come from the engine
 * (`sky_state`, `find_altitude`, `find_azimuth`, `alignment_days`). The one computation is
 * geodesy: the direction from the place to a point on the WGS84 ellipsoid (Vincenty's
 * inverse formula), which is what a bearing picked on the map means.
 */

import type { LatLonDeg } from '../engine/types.js';
import { eventTime, MINUS } from '../shell/format.js';
import type { AngleFormat } from '../state.js';
import type { Zone } from '../time.js';

/** What to say about a shadow: none (the Sun is down), too long to measure, or its length. */
export type Shadow = { kind: 'none' } | { kind: 'long' } | { kind: 'length'; m: number };

/** Below this apparent altitude the shadow is too long to be worth a number (over 115 × the height). */
export const SHADOW_MIN_ALT_DEG = 0.5;

/**
 * The shadow of an upright object `heightM` tall on level ground, with the Sun at apparent
 * altitude `altDeg` (refraction included: the shadow follows the light as it arrives):
 * `height / tan(altitude)`. No shadow with the Sun at or below the horizon.
 */
export function shadowOf(heightM: number, altDeg: number): Shadow {
  if (!(altDeg > 0) || !Number.isFinite(heightM)) return { kind: 'none' };
  if (altDeg < SHADOW_MIN_ALT_DEG) return { kind: 'long' };
  return { kind: 'length', m: heightM / Math.tan((altDeg * Math.PI) / 180) };
}

/** Heights "When is it at…?" accepts, degrees: down to astronomical twilight, up to the zenith. */
export const FIND_ALT_MIN = -18;
export const FIND_ALT_MAX = 90;

/**
 * A height typed as degrees (`30`, `-6`, `30.5`, `30°`) or degrees and minutes (`30 15`,
 * `30° 15′`, `-0 50`), or null when it is not one or is outside −18°..90°.
 */
export function parseAltitude(text: string): number | null {
  const t = text
    .trim()
    .replace(/[−–]/g, '-')
    .replace(/[°º′'’″"]/g, ' ')
    .replace(/,/g, '.')
    .trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  if (parts.length > 2 || !parts.every((p) => /^-?\d+(\.\d+)?$|^-?\.\d+$/.test(p))) return null;
  const negative = parts[0]!.startsWith('-');
  const deg = Math.abs(Number(parts[0]));
  const min = parts.length === 2 ? Number(parts[1]) : 0;
  if (parts.length === 2 && (parts[1]!.startsWith('-') || min >= 60 || !Number.isInteger(deg))) return null;
  const value = (negative ? -1 : 1) * (deg + min / 60);
  return Number.isFinite(value) && value >= FIND_ALT_MIN && value <= FIND_ALT_MAX ? value : null;
}

// ---------------------------------------------------------------------------------
// Bearings (photo agent, expansion programme Q8)
// ---------------------------------------------------------------------------------

/** A bearing in [0, 360). */
export function normBearing(deg: number): number {
  const x = ((deg % 360) + 360) % 360;
  return x >= 360 - 1e-12 ? 0 : x;
}

const COMPASS_POINTS: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

/**
 * A bearing typed as degrees from true north (`299`, `299.5°`, `299 30` = 299° 30′) or a
 * compass point (`WNW`), in [0, 360) (360 reads as 0); null for anything else.
 */
export function parseBearing(text: string): number | null {
  const raw = text.trim().toUpperCase();
  if (!raw) return null;
  if (raw in COMPASS_POINTS) return COMPASS_POINTS[raw]!;
  const t = raw
    .replace(/[°º′'’″"]/g, ' ')
    .replace(/,/g, '.')
    .replace(/\bT(RUE)?\b/g, '')
    .trim();
  const parts = t.split(/\s+/);
  if (parts.length > 2 || !parts.every((p) => /^\d+(\.\d+)?$|^\.\d+$/.test(p))) return null;
  const deg = Number(parts[0]);
  const min = parts.length === 2 ? Number(parts[1]) : 0;
  if (parts.length === 2 && (min >= 60 || !Number.isInteger(deg))) return null;
  const value = deg + min / 60;
  if (!Number.isFinite(value) || value > 360) return null;
  return normBearing(value);
}

/** Tolerances the alignment finder accepts, degrees. */
export const TOLERANCE_MIN = 0.05;
export const TOLERANCE_MAX = 10;

/** A tolerance typed in degrees (`0.5`, `0,3`), within the finder's range; null otherwise. */
export function parseTolerance(text: string): number | null {
  const t = text.trim().replace(/[°º]/g, '').replace(/,/g, '.').trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const v = Number(t);
  return v >= TOLERANCE_MIN && v <= TOLERANCE_MAX ? v : null;
}

/** The angle from `a` to `b`, degrees in (−180, 180]: positive when `b` is clockwise of `a`. */
export function bearingDifference(a: number, b: number): number {
  const d = normBearing(b - a);
  return d > 180 ? d - 360 : d;
}

/**
 * The magnetic bearing of a true bearing, with the variation (magnetic declination) east
 * positive: magnetic = true − variation. Variation 11.8° W (−11.8) makes 245° true 256.8°
 * magnetic.
 */
export function magneticFromTrue(trueDeg: number, variationDeg: number): number {
  return normBearing(trueDeg - variationDeg);
}

// --- geodesy: the direction from the place to a point picked on the map ------------

/** WGS84 (CONVENTIONS section 2): semi-major axis, metres, and flattening. */
const WGS84_A = 6_378_137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const RAD = Math.PI / 180;

export interface Geodesic {
  /** Initial azimuth at the start, degrees from true north [0, 360); NaN for coincident points. */
  azimuth_deg: number;
  /** Length of the geodesic, metres. */
  distance_m: number;
  /** `vincenty` on the ellipsoid; `sphere` when Vincenty's iteration fails (nearly antipodal points). */
  method: 'vincenty' | 'sphere';
}

/**
 * The shortest path from `from` to `to` on the WGS84 ellipsoid: its initial azimuth and
 * length, by Vincenty's inverse formula (Survey Review 23, 1975), iterated to 1e-12 rad.
 * This is the bearing at which a person at `from` sees `to` (a normal section and the
 * geodesic differ by under 1e-6° at the distances a street or a skyline spans). Within
 * 1e-5° and 1 mm of Geoscience Australia's worked example (photo-tools.test.ts). For
 * nearly antipodal points, where the iteration does not converge, the sphere's great
 * circle (error up to about 0.2°), and `method` says so.
 */
export function geodesicInverse(from: LatLonDeg, to: LatLonDeg): Geodesic {
  const f = WGS84_F;
  const L = normSigned(to.lon_deg - from.lon_deg) * RAD;
  const U1 = Math.atan((1 - f) * Math.tan(from.lat_deg * RAD));
  const U2 = Math.atan((1 - f) * Math.tan(to.lat_deg * RAD));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 1;
  let sigma = 0;
  let sinAlpha = 0;
  let cos2Alpha = 1;
  let cos2SigmaM = 0;
  let converged = false;
  for (let i = 0; i < 200; i++) {
    const sinL = Math.sin(lambda);
    const cosL = Math.cos(lambda);
    const t1 = cosU2 * sinL;
    const t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosL;
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2);
    if (sinSigma === 0) return { azimuth_deg: Number.NaN, distance_m: 0, method: 'vincenty' };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = cos2Alpha === 0 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (f / 16) * cos2Alpha * (4 + f * (4 - 3 * cos2Alpha));
    const next = L + (1 - C) * f * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(next) > Math.PI) break;
    const done = Math.abs(next - lambda) < 1e-12;
    lambda = next;
    if (done) {
      converged = true;
      break;
    }
  }
  if (!converged) return sphereInverse(from, to);
  const uSq = (cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B)) / (WGS84_B * WGS84_B);
  const A = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma =
    B *
    sinSigma *
    (cos2SigmaM +
      (B / 4) *
        (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) -
          (B / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const s = WGS84_B * A * (sigma - deltaSigma);
  const sinL = Math.sin(lambda);
  const cosL = Math.cos(lambda);
  const alpha1 = Math.atan2(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
  return { azimuth_deg: normBearing(alpha1 / RAD), distance_m: s, method: 'vincenty' };
}

function normSigned(deg: number): number {
  const x = normBearing(deg);
  return x > 180 ? x - 360 : x;
}

/** The great circle on the sphere of mean radius 6371.0088 km (the fallback). */
function sphereInverse(from: LatLonDeg, to: LatLonDeg): Geodesic {
  const p1 = from.lat_deg * RAD;
  const p2 = to.lat_deg * RAD;
  const dl = normSigned(to.lon_deg - from.lon_deg) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const c = Math.acos(Math.max(-1, Math.min(1, Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl))));
  return { azimuth_deg: normBearing(Math.atan2(y, x) / RAD), distance_m: c * 6_371_008.8, method: 'sphere' };
}

/**
 * Points of a ray on the map: from `from` along the great circle leaving at `azimuthDeg`,
 * `lengthKm` long, every `stepKm` (at least 2 points). For drawing only: the map is a
 * sphere, and the ray's first kilometres run within 0.2° of the ellipsoid's bearing.
 */
export function rayPoints(from: LatLonDeg, azimuthDeg: number, lengthKm: number, stepKm = 10): LatLonDeg[] {
  const R = 6371.0088;
  const n = Math.max(1, Math.min(2000, Math.ceil(lengthKm / stepKm)));
  const p1 = from.lat_deg * RAD;
  const l1 = from.lon_deg * RAD;
  const th = azimuthDeg * RAD;
  const out: LatLonDeg[] = [];
  for (let i = 0; i <= n; i++) {
    const d = (lengthKm * i) / n / R;
    const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
    const l2 = l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
    out.push({ lat_deg: p2 / RAD, lon_deg: normSigned(l2 / RAD) });
  }
  return out;
}

// ---------------------------------------------------------------------------------
// Words and numbers the rows share
// ---------------------------------------------------------------------------------

/** No-break space, as shell/format.ts writes before AM and PM. */
const NBSP = ' ';

/**
 * A time range on the display clock, compact: `06:23–06:33`, `6:23–6:33 AM` (one AM when
 * both share it), `11:40 AM–12:20 PM`.
 */
export function timeRange(jdA: number, jdB: number, zone: Zone): string {
  const a = eventTime(jdA, zone);
  const b = eventTime(jdB, zone);
  for (const suffix of [`${NBSP}AM`, `${NBSP}PM`]) {
    if (a.endsWith(suffix) && b.endsWith(suffix)) return `${a.slice(0, -suffix.length)}–${b}`;
  }
  return `${a}–${b}`;
}

/** A duration in minutes as `52 min` or `1 h 03 min`. */
export function minutesText(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

/**
 * Right ascension as astronomers write it: `12h 34m 57s` (`dm`), `12h 34m 56.7s` (`dms`),
 * or in degrees for the decimal format, `188.736°`.
 */
export function formatRa(raDeg: number, format: AngleFormat): string {
  if (!Number.isFinite(raDeg)) return '—';
  const deg = normBearing(raDeg);
  if (format === 'decimal') return `${deg.toFixed(3)}°`;
  const digits = format === 'dms' ? 1 : 0;
  const f = 10 ** digits;
  let totalS = Math.round((deg / 15) * 3600 * f) / f;
  if (totalS >= 86_400) totalS -= 86_400;
  const h = Math.floor(totalS / 3600 + 1e-12);
  const m = Math.floor((totalS - h * 3600) / 60 + 1e-12);
  const s = Math.max(0, totalS - h * 3600 - m * 60);
  const sText = digits ? s.toFixed(digits).padStart(digits + 3, '0') : String(Math.round(s)).padStart(2, '0');
  return `${h}h ${String(m).padStart(2, '0')}m ${sText}s`;
}

/**
 * A declination with an explicit sign, as astronomers write it: `+12° 35′` (`dm`),
 * `+12° 34′ 56″` (`dms`), `+12.582°` (decimal); the minus is the true minus.
 */
export function formatDecSigned(decDeg: number, format: AngleFormat): string {
  if (!Number.isFinite(decDeg)) return '—';
  const abs = Math.abs(decDeg);
  let body: string;
  let zero: boolean;
  if (format === 'decimal') {
    body = `${abs.toFixed(3)}°`;
    zero = Number(abs.toFixed(3)) === 0;
  } else if (format === 'dms') {
    const totalS = Math.round(abs * 3600);
    const d = Math.floor(totalS / 3600);
    const m = Math.floor((totalS - d * 3600) / 60);
    const s = totalS - d * 3600 - m * 60;
    body = `${d}° ${String(m).padStart(2, '0')}′ ${String(s).padStart(2, '0')}″`;
    zero = totalS === 0;
  } else {
    const totalM = Math.round(abs * 60);
    const d = Math.floor(totalM / 60);
    const m = totalM - d * 60;
    body = `${d}° ${String(m).padStart(2, '0')}′`;
    zero = totalM === 0;
  }
  return `${zero || decDeg >= 0 ? '+' : MINUS}${body}`;
}
