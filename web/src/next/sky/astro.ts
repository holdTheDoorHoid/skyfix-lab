/**
 * Pure geometry for the Sky view: no DOM, no engine, no allocation in the per-frame
 * paths. OWNER: sky agent.
 *
 * EXPLORER_PLAN §3.1: every position comes from the Rust core. This module only turns
 * places the engine has already computed into what the eye sees from a place:
 *
 * - star directions are the engine's apparent places of date (`starfield_apparent`, the
 *   frame of `sky_state`: true equator and equinox of date);
 * - Earth rotation is the engine's own sidereal angle, `sidereal(jd).gha_aries_deg`
 *   (GAST with DUT1 = 0, CONVENTIONS 6), plus the east longitude;
 * - the horizon is the plane perpendicular to the WGS84 ellipsoid normal, i.e. the
 *   geodetic latitude (CONVENTIONS 13.2). Stars have no parallax, so the site's height
 *   does not matter for them; polar motion (< 0.5″) and diurnal aberration (< 0.32″) are
 *   left out, exactly as in the engine;
 * - the apparent altitude adds Saemundsson's display refraction (CONVENTIONS 13.2), so
 *   stars sit where `sky_state` puts the Sun, Moon and planets (`alt_apparent_deg`).
 *
 * Display only (CONVENTIONS 13.6): nothing here ever feeds navigation.
 */

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
const TWO_PI = 2 * Math.PI;

// ---------------------------------------------------------------------------
// Angles
// ---------------------------------------------------------------------------

/** Degrees into [0, 360). */
export function norm360(deg: number): number {
  const x = deg % 360;
  return x < 0 ? x + 360 : x === 360 ? 0 : x;
}

/** Radians into [0, 2π). */
export function norm2Pi(rad: number): number {
  const x = rad % TWO_PI;
  return x < 0 ? x + TWO_PI : x;
}

/** Radians into (−π, π]. */
export function wrapPi(rad: number): number {
  let x = rad % TWO_PI;
  if (x <= -Math.PI) x += TWO_PI;
  else if (x > Math.PI) x -= TWO_PI;
  return x;
}

/** The local sidereal angle, degrees [0, 360): GHA Aries + east longitude (EXPLORER_API `sidereal`). */
export function localSiderealDeg(ghaAriesDeg: number, lonEastDeg: number): number {
  return norm360(ghaAriesDeg + lonEastDeg);
}

// ---------------------------------------------------------------------------
// Refraction (CONVENTIONS 13.2)
// ---------------------------------------------------------------------------

/** The pressure/temperature factor of CONVENTIONS 13.2 (1 at 1010 hPa and 10 °C). */
export function refractionScale(pressureHpa = 1010, temperatureC = 10): number {
  return (pressureHpa / 1010) * (283 / (273 + temperatureC));
}

/**
 * Saemundsson's true-to-apparent refraction, arcminutes, evaluated at `max(alt, −1°)`
 * and scaled by `scale` (`refractionScale`). The same expression as the engine's
 * `refraction_true_to_apparent_arcmin` (skyfix-ephemeris `topocentric`).
 */
export function refractionArcmin(altDeg: number, scale = 1): number {
  const h = Math.max(altDeg, -1);
  return (scale * 1.02) / Math.tan((h + 10.3 / (h + 5.11)) * DEG);
}

/** Geometric altitude to what the eye sees, degrees. */
export function apparentAltitudeDeg(altDeg: number, scale = 1): number {
  return altDeg + refractionArcmin(altDeg, scale) / 60;
}

/** The same in radians, for the per-star loop. */
function apparentAltitudeRad(altRad: number, scale: number): number {
  const h = altRad * RAD;
  const hc = h > -1 ? h : -1;
  return altRad + (scale * 1.02 * DEG) / 60 / Math.tan((hc + 10.3 / (hc + 5.11)) * DEG);
}

// ---------------------------------------------------------------------------
// Vectors and frames
// ---------------------------------------------------------------------------

/** Unit vector of an equatorial direction (radians), written at `out[3k…3k+2]`. */
export function unitFromRaDec(raRad: number, decRad: number, out: Float64Array, k = 0): void {
  const c = Math.cos(decRad);
  out[3 * k] = c * Math.cos(raRad);
  out[3 * k + 1] = c * Math.sin(raRad);
  out[3 * k + 2] = Math.sin(decRad);
}

/**
 * `[ra_rad, dec_rad, …]` (the layout of `starfield_apparent`) into unit vectors,
 * `out` of length `3 × count`.
 */
export function unitsFromRaDecArray(radec: ArrayLike<number>, count: number, out: Float64Array): void {
  for (let i = 0; i < count; i += 1) {
    const ra = radec[2 * i]!;
    const dec = radec[2 * i + 1]!;
    const c = Math.cos(dec);
    out[3 * i] = c * Math.cos(ra);
    out[3 * i + 1] = c * Math.sin(ra);
    out[3 * i + 2] = Math.sin(dec);
  }
}

/** `out = m · v` for `count` unit vectors; `m` row-major 3×3 (length 9). `out` may be `v`. */
export function rotateUnits(m: ArrayLike<number>, v: Float64Array, count: number, out: Float64Array): void {
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!, m8 = m[8]!;
  for (let i = 0; i < count; i += 1) {
    const x = v[3 * i]!;
    const y = v[3 * i + 1]!;
    const z = v[3 * i + 2]!;
    out[3 * i] = m0 * x + m1 * y + m2 * z;
    out[3 * i + 1] = m3 * x + m4 * y + m5 * z;
    out[3 * i + 2] = m6 * x + m7 * y + m8 * z;
  }
}

export const IDENTITY3: Float64Array = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1);

/**
 * Rotation from the true equator and equinox of date into the local horizon, row-major,
 * rows East, North, Up: `(E, N, U) = M · v`.
 *
 * With `L` the local sidereal angle and `φ` the geodetic latitude, the hour angle is
 * `H = L − α`, and CONVENTIONS 3's `N = cos φ sin δ − sin φ cos δ cos H`,
 * `E = −cos δ sin H`, `sin h = sin φ sin δ + cos φ cos δ cos H` become linear in the
 * equatorial unit vector.
 */
export function horizonMatrix(lstDeg: number, latDeg: number, out: Float64Array = new Float64Array(9)): Float64Array {
  const sl = Math.sin(lstDeg * DEG);
  const cl = Math.cos(lstDeg * DEG);
  const sp = Math.sin(latDeg * DEG);
  const cp = Math.cos(latDeg * DEG);
  out[0] = -sl;
  out[1] = cl;
  out[2] = 0;
  out[3] = -sp * cl;
  out[4] = -sp * sl;
  out[5] = cp;
  out[6] = cp * cl;
  out[7] = cp * sl;
  out[8] = sp;
  return out;
}

/**
 * Apparent altitude (radians, with display refraction) and azimuth (radians, [0, 2π),
 * from true north clockwise) of `count` equatorial unit vectors, through a horizon
 * matrix. Writes `alt[i]`, `az[i]`. Allocation-free.
 *
 * `skipBelowRad`: directions whose geometric altitude is below this get `az` and the
 * geometric altitude only (they are never drawn, and refraction would be constant there
 * anyway). Default: compute every direction fully.
 */
export function horizonBatch(
  unit: Float64Array,
  count: number,
  m: Float64Array,
  scale: number,
  alt: Float64Array | Float32Array,
  az: Float64Array | Float32Array,
  skipBelowRad = -Infinity,
): void {
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!, m8 = m[8]!;
  for (let i = 0; i < count; i += 1) {
    const x = unit[3 * i]!;
    const y = unit[3 * i + 1]!;
    const z = unit[3 * i + 2]!;
    const e = m0 * x + m1 * y + m2 * z;
    const n = m3 * x + m4 * y + m5 * z;
    let u = m6 * x + m7 * y + m8 * z;
    if (u > 1) u = 1;
    else if (u < -1) u = -1;
    const h = Math.asin(u);
    alt[i] = h < skipBelowRad ? h : apparentAltitudeRad(h, scale);
    const a = Math.atan2(e, n);
    az[i] = a < 0 ? a + TWO_PI : a;
  }
}

/** Where `horizonDirections` writes, one entry per direction. */
export interface HorizonBuffers {
  /** Apparent altitude, radians (display refraction included). */
  alt: Float64Array;
  /** Sine and cosine of the apparent altitude. */
  sinAlt: Float64Array;
  cosAlt: Float64Array;
  /** Unit horizontal direction: sin and cos of the azimuth (from north, clockwise). */
  sinAz: Float64Array;
  cosAz: Float64Array;
}

export function horizonBuffers(count: number): HorizonBuffers {
  return {
    alt: new Float64Array(count),
    sinAlt: new Float64Array(count),
    cosAlt: new Float64Array(count),
    sinAz: new Float64Array(count),
    cosAz: new Float64Array(count),
  };
}

/**
 * The per-frame pass the Sky view runs for every star: the same answer as `horizonBatch`
 * (tests hold them together), but shaped for drawing and about three times cheaper. The
 * azimuth stays a unit vector (the dome never needs the angle) and the apparent
 * altitude comes with its sine and cosine: one `asin` and one `tan` per direction.
 *
 * Refraction `δ` (at most 0.0113 rad) is added with `sin(h0 + δ)` expanded to fifth
 * order in δ, exact to 1e-12. Directions below `skipBelowRad` get their geometric
 * altitude only (never drawn).
 */
export function horizonDirections(
  unit: Float64Array,
  count: number,
  m: Float64Array,
  scale: number,
  out: HorizonBuffers,
  skipBelowRad = -Infinity,
): void {
  const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m3 = m[3]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m7 = m[7]!, m8 = m[8]!;
  const { alt, sinAlt, cosAlt, sinAz, cosAz } = out;
  const k = (scale * 1.02 * DEG) / 60;
  for (let i = 0; i < count; i += 1) {
    const x = unit[3 * i]!;
    const y = unit[3 * i + 1]!;
    const z = unit[3 * i + 2]!;
    const e = m0 * x + m1 * y + m2 * z;
    const n = m3 * x + m4 * y + m5 * z;
    let u = m6 * x + m7 * y + m8 * z;
    if (u > 1) u = 1;
    else if (u < -1) u = -1;
    const c = Math.sqrt(e * e + n * n);
    if (c > 1e-12) {
      sinAz[i] = e / c;
      cosAz[i] = n / c;
    } else {
      sinAz[i] = 0;
      cosAz[i] = 1;
    }
    const h0 = Math.asin(u);
    if (h0 < skipBelowRad) {
      alt[i] = h0;
      sinAlt[i] = u;
      cosAlt[i] = c;
      continue;
    }
    const hd = h0 * RAD;
    const hc = hd > -1 ? hd : -1;
    const d = k / Math.tan((hc + 10.3 / (hc + 5.11)) * DEG);
    const d2 = d * d;
    const sd = d * (1 - d2 * (1 / 6 - d2 / 120));
    const cd = 1 - d2 * (0.5 - d2 / 24);
    alt[i] = h0 + d;
    sinAlt[i] = u * cd + c * sd;
    cosAlt[i] = c * cd - u * sd;
  }
}

/** Azimuth in radians [0, 2π) from a unit horizontal direction. */
export function azimuthOf(sinAz: number, cosAz: number): number {
  const a = Math.atan2(sinAz, cosAz);
  return a < 0 ? a + TWO_PI : a;
}

/** One direction, for tests and tooltips: apparent altitude and azimuth, degrees. */
export interface AltAz {
  /** Geometric altitude (no refraction). */
  alt_deg: number;
  /** What the eye sees: `alt_deg` plus display refraction (CONVENTIONS 13.2). */
  alt_apparent_deg: number;
  /** True bearing, [0, 360). */
  az_deg: number;
}

/**
 * Apparent RA/Dec of date (radians) seen from a place at the sidereal angle of the
 * engine. The reference implementation of what `horizonBatch` does for every star.
 */
export function starAltAz(
  raRad: number,
  decRad: number,
  ghaAriesDeg: number,
  latDeg: number,
  lonEastDeg: number,
  scale = 1,
): AltAz {
  const m = horizonMatrix(localSiderealDeg(ghaAriesDeg, lonEastDeg), latDeg);
  const v = new Float64Array(3);
  unitFromRaDec(raRad, decRad, v);
  const e = m[0]! * v[0]! + m[1]! * v[1]! + m[2]! * v[2]!;
  const n = m[3]! * v[0]! + m[4]! * v[1]! + m[5]! * v[2]!;
  const u = Math.max(-1, Math.min(1, m[6]! * v[0]! + m[7]! * v[1]! + m[8]! * v[2]!));
  const alt = Math.asin(u) * RAD;
  return { alt_deg: alt, alt_apparent_deg: apparentAltitudeDeg(alt, scale), az_deg: norm360(Math.atan2(e, n) * RAD) };
}

/** Horizon unit vector (E, N, U) of an apparent altitude and azimuth, radians. */
export function horizonUnit(altRad: number, azRad: number, out: Float64Array, k = 0): void {
  const c = Math.cos(altRad);
  out[3 * k] = c * Math.sin(azRad);
  out[3 * k + 1] = c * Math.cos(azRad);
  out[3 * k + 2] = Math.sin(altRad);
}

// ---------------------------------------------------------------------------
// Reference circles, drawn in the frame of date
// ---------------------------------------------------------------------------

/**
 * Mean obliquity of the ecliptic (IAU 2006, arcseconds polynomial to T²), degrees, from
 * a UTC Julian Date (the few tens of seconds between UTC and TT change it by 1e-9°).
 * Display aid only: the drawn ecliptic leaves out nutation in obliquity (at most 9.2″,
 * well under a pixel at every zoom this view offers).
 */
export function meanObliquityDeg(jdUtc: number): number {
  const t = (jdUtc - 2_451_545.0) / 36_525;
  return (84_381.406 - 46.836769 * t - 0.0001831 * t * t) / 3600;
}

/**
 * Unit vectors of a great circle in the equatorial frame of date, `n` points closed
 * (the last equals the first): the celestial equator for `tiltDeg = 0`, the ecliptic for
 * the obliquity (ascending node at the equinox, RA 0).
 */
export function greatCircleUnits(tiltDeg: number, n: number, out: Float64Array = new Float64Array(3 * n)): Float64Array {
  const ce = Math.cos(tiltDeg * DEG);
  const se = Math.sin(tiltDeg * DEG);
  for (let k = 0; k < n; k += 1) {
    const t = (TWO_PI * k) / (n - 1);
    const c = Math.cos(t);
    const s = Math.sin(t);
    out[3 * k] = c;
    out[3 * k + 1] = s * ce;
    out[3 * k + 2] = s * se;
  }
  return out;
}

/**
 * Ecliptic longitude on the drawn ecliptic of the point `k` of `greatCircleUnits(ε, n)`,
 * degrees. (The parameter is the longitude.)
 */
export function eclipticLongitudeOfSample(k: number, n: number): number {
  return (360 * k) / (n - 1);
}

// ---------------------------------------------------------------------------
// Moon and planet phase orientation
// ---------------------------------------------------------------------------

/**
 * Screen angle (canvas convention: radians, x right, y down) of the midpoint of a disc's
 * bright limb.
 *
 * `brightLimbDeg − parallacticDeg` is the bright limb's position angle measured from the
 * direction of the zenith (EXPLORER_API `parallactic_angle_deg`; Meeus ch. 48), turning
 * the same way as a position angle: north → east, which is counterclockwise as the
 * observer sees the sky. Both views draw the sky as the observer sees it (not mirrored)
 * and both projections are conformal, so that angle is also counterclockwise on screen,
 * from the screen direction `(upX, upY)` toward the zenith at the body.
 */
export function brightLimbScreenAngle(brightLimbDeg: number, parallacticDeg: number, upX: number, upY: number): number {
  const theta = (brightLimbDeg - parallacticDeg) * DEG;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  // A visual counterclockwise turn by θ with y pointing down.
  return Math.atan2(-upX * s + upY * c, upX * c + upY * s);
}

// ---------------------------------------------------------------------------
// Sky brightness
// ---------------------------------------------------------------------------

/**
 * The faintest magnitude drawn for the Sun's altitude (degrees, topocentric geometric):
 * 6.5 in a dark sky, fading through the twilights of CONVENTIONS 13.4 to about −1 by
 * day (only Venus, Jupiter and the Moon stay). A display choice, not a photometric model.
 */
export function limitingMagnitude(sunAltDeg: number): number {
  if (!Number.isFinite(sunAltDeg)) return 6.5;
  const knots: readonly (readonly [number, number])[] = [
    [-18, 6.5],
    [-12, 5.6],
    [-6, 3.6],
    [-0.83, 1.2],
    [4, -0.6],
    [10, -1.5],
  ];
  if (sunAltDeg <= knots[0]![0]) return knots[0]![1];
  for (let i = 1; i < knots.length; i += 1) {
    const [a1, m1] = knots[i]!;
    if (sunAltDeg <= a1) {
      const [a0, m0] = knots[i - 1]!;
      return m0 + ((m1 - m0) * (sunAltDeg - a0)) / (a1 - a0);
    }
  }
  return knots[knots.length - 1]![1];
}
