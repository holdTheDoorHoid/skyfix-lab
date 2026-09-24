/**
 * MOCK ENGINE ONLY — low-precision astronomy for developing the interface.
 *
 * Published low-precision formulas, chosen to be short and to look right on screen,
 * not to be right to the arcminute. Nothing here is ever a source of results
 * (EXPLORER_PLAN section 3.1); the real numbers come from the Rust core.
 *
 * - Sun and Moon: the Astronomical Almanac's low-precision formulas (section C for the
 *   Sun, about 0.01 deg; section D for the Moon, about 0.3 deg in longitude, 0.2 deg in
 *   latitude, 0.003 deg in horizontal parallax), referred to the mean equinox of date.
 * - Planets: JPL "Approximate Positions of the Planets" (E. M. Standish), Keplerian
 *   elements of Table 1 (1800-2050), J2000 ecliptic, then precessed to the date. No
 *   light-time, nutation or aberration; the Earth is the Earth-Moon barycentre.
 * - Precession: IAU 1976 angles (Meeus, Astronomical Algorithms, 21.2-21.4).
 * - Sidereal time: GMST, IAU 1982 (Meeus 12.4), with UT1 = UTC.
 * - Planet magnitudes: Meeus 41 (1984 Astronomical Almanac); Saturn's rings ignored.
 * - Topocentric place: WGS84 site, parallax by vector subtraction; display refraction as
 *   CONVENTIONS 13.2 (Saemundsson).
 */

export const D2R = Math.PI / 180;
export const R2D = 180 / Math.PI;
export const J2000 = 2_451_545.0;
export const AU_KM = 149_597_870.7;
export const EARTH_RADIUS_KM = 6378.137;
const WGS84_F = 1 / 298.257223563;
/** TT - UTC with 37 leap seconds; a constant is plenty for a mock. */
const TT_MINUS_UTC_DAYS = 69.184 / 86_400;

export type Vec3 = [number, number, number];
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function norm360(x: number): number {
  const r = x % 360;
  const out = r < 0 ? r + 360 : r;
  return out === 360 || Object.is(out, -0) ? 0 : out;
}

/** Normalise to (-180, 180]. */
export function wrap180(x: number): number {
  const r = norm360(x);
  return r > 180 ? r - 360 : r;
}

export function centuriesTT(jdUtc: number): number {
  return (jdUtc + TT_MINUS_UTC_DAYS - J2000) / 36_525;
}

/** Greenwich mean sidereal time, degrees = GHA of Aries (mock: no equation of the equinoxes). */
export function gmstDeg(jdUtc: number): number {
  const d = jdUtc - J2000;
  const t = d / 36_525;
  return norm360(280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - (t * t * t) / 38_710_000);
}

export function obliquityDeg(t: number): number {
  return 23.439291 - 0.0130042 * t;
}

export function eclipticToEquatorial(
  lonDeg: number,
  latDeg: number,
  epsDeg: number,
): { ra_deg: number; dec_deg: number } {
  const l = lonDeg * D2R;
  const b = latDeg * D2R;
  const e = epsDeg * D2R;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
  return { ra_deg: norm360(ra * R2D), dec_deg: dec * R2D };
}

export function equatorialToEcliptic(
  raDeg: number,
  decDeg: number,
  epsDeg: number,
): { lon_deg: number; lat_deg: number } {
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  const e = epsDeg * D2R;
  const lon = Math.atan2(Math.sin(a) * Math.cos(e) + Math.tan(d) * Math.sin(e), Math.cos(a));
  const lat = Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a));
  return { lon_deg: norm360(lon * R2D), lat_deg: lat * R2D };
}

// ---------------------------------------------------------------------------
// Sun and Moon (Astronomical Almanac low-precision formulas)
// ---------------------------------------------------------------------------

export interface SunPosition {
  /** Apparent ecliptic longitude, mean equinox of date. */
  lon_deg: number;
  ra_deg: number;
  dec_deg: number;
  dist_au: number;
}

export function sunPosition(jdUtc: number): SunPosition {
  const n = jdUtc + TT_MINUS_UTC_DAYS - J2000;
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lon = norm360(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = 23.439 - 0.0000004 * n;
  const { ra_deg, dec_deg } = eclipticToEquatorial(lon, 0, eps);
  return {
    lon_deg: lon,
    ra_deg,
    dec_deg,
    dist_au: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g),
  };
}

export interface MoonPosition {
  lon_deg: number;
  lat_deg: number;
  ra_deg: number;
  dec_deg: number;
  /** Horizontal parallax, degrees. */
  hp_deg: number;
  dist_km: number;
}

export function moonPosition(jdUtc: number): MoonPosition {
  const t = centuriesTT(jdUtc);
  const s = (a: number, b: number): number => Math.sin((a + b * t) * D2R);
  const c = (a: number, b: number): number => Math.cos((a + b * t) * D2R);
  const lon = norm360(
    218.32 +
      481_267.881 * t +
      6.29 * s(135.0, 477_198.87) -
      1.27 * s(259.3, -413_335.36) +
      0.66 * s(235.7, 890_534.22) +
      0.21 * s(269.9, 954_397.74) -
      0.19 * s(357.5, 35_999.05) -
      0.11 * s(186.5, 966_404.03),
  );
  const lat =
    5.13 * s(93.3, 483_202.02) +
    0.28 * s(228.2, 960_400.89) -
    0.28 * s(318.3, 6_003.15) -
    0.17 * s(217.6, -407_332.21);
  const hp =
    0.9508 +
    0.0518 * c(135.0, 477_198.87) +
    0.0095 * c(259.3, -413_335.36) +
    0.0078 * c(235.7, 890_534.22) +
    0.0028 * c(269.9, 954_397.74);
  const { ra_deg, dec_deg } = eclipticToEquatorial(lon, lat, obliquityDeg(t));
  return {
    lon_deg: lon,
    lat_deg: lat,
    ra_deg,
    dec_deg,
    hp_deg: hp,
    dist_km: EARTH_RADIUS_KM / Math.sin(hp * D2R),
  };
}

// ---------------------------------------------------------------------------
// Planets (JPL approximate Keplerian elements, Table 1)
// ---------------------------------------------------------------------------

/** a, e, I, L, varpi, Omega at J2000 and their rates per Julian century. */
type Elements = readonly [number, number, number, number, number, number];

const ELEMENTS: Record<string, readonly [Elements, Elements]> = {
  Mercury: [
    [0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593],
    [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081],
  ],
  Venus: [
    [0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255],
    [0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418],
  ],
  EMBary: [
    [1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0],
    [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0],
  ],
  Mars: [
    [1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
    [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343],
  ],
  Jupiter: [
    [5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
    [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106],
  ],
  Saturn: [
    [9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
    [-0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794],
  ],
  Uranus: [
    [19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.9542763, 74.01692503],
    [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589],
  ],
  Neptune: [
    [30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
    [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664],
  ],
};

export const PLANET_NAMES = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;

/** Heliocentric position, J2000 ecliptic, AU. `name` is a planet or `EMBary`. */
export function heliocentric(name: string, t: number): Vec3 {
  const el = ELEMENTS[name];
  if (!el) throw new Error(`mock: no elements for ${name}`);
  const [e0, rate] = el;
  const at = (i: number): number => e0[i]! + rate[i]! * t;
  const a = at(0);
  const e = at(1);
  const inc = at(2) * D2R;
  const L = at(3);
  const varpi = at(4);
  const node = at(5);
  const M = wrap180(L - varpi) * D2R;
  const w = (varpi - node) * D2R;
  const om = node * D2R;
  let E = M + e * Math.sin(M);
  for (let i = 0; i < 6; i += 1) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e);
  const yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const co = Math.cos(om);
  const so = Math.sin(om);
  const ci = Math.cos(inc);
  const si = Math.sin(inc);
  return [
    (cw * co - sw * so * ci) * xp + (-sw * co - cw * so * ci) * yp,
    (cw * so + sw * co * ci) * xp + (-sw * so + cw * co * ci) * yp,
    sw * si * xp + cw * si * yp,
  ];
}

const EPS_J2000 = 23.43928 * D2R;

/** J2000 ecliptic -> J2000 equator. */
export function eclipticToEquatorialVec(v: Vec3): Vec3 {
  const c = Math.cos(EPS_J2000);
  const s = Math.sin(EPS_J2000);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

/** IAU 1976 precession, J2000 mean equator -> mean equator of date (Meeus 21.2-21.4). */
export function precessionMatrix(t: number): Mat3 {
  const as = D2R / 3600;
  const zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * as;
  const z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * as;
  const theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * as;
  const cz = Math.cos(zeta);
  const sz = Math.sin(zeta);
  const cZ = Math.cos(z);
  const sZ = Math.sin(z);
  const ct = Math.cos(theta);
  const st = Math.sin(theta);
  return [
    cZ * ct * cz - sZ * sz,
    -cZ * ct * sz - sZ * cz,
    -cZ * st,
    sZ * ct * cz + cZ * sz,
    -sZ * ct * sz + cZ * cz,
    -sZ * st,
    st * cz,
    -st * sz,
    ct,
  ];
}

export function applyMat(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

export function unitVector(raDeg: number, decDeg: number): Vec3 {
  const a = raDeg * D2R;
  const d = decDeg * D2R;
  return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)];
}

export function vecToRaDec(v: Vec3): { ra_deg: number; dec_deg: number; r: number } {
  const r = Math.hypot(v[0], v[1], v[2]);
  return {
    ra_deg: norm360(Math.atan2(v[1], v[0]) * R2D),
    dec_deg: Math.asin(Math.max(-1, Math.min(1, v[2] / r))) * R2D,
    r,
  };
}

/** Planet magnitude (Meeus 41), from r and delta in AU and the phase angle in degrees. */
export function planetMagnitude(name: string, r: number, delta: number, i: number): number {
  const base = 5 * Math.log10(r * delta);
  switch (name) {
    case 'Mercury':
      return -0.42 + base + 0.038 * i - 0.000273 * i * i + 0.000002 * i * i * i;
    case 'Venus':
      return -4.4 + base + 0.0009 * i + 0.000239 * i * i - 0.00000065 * i * i * i;
    case 'Mars':
      return -1.52 + base + 0.016 * i;
    case 'Jupiter':
      return -9.4 + base + 0.005 * i;
    case 'Saturn':
      return -8.88 + base + 0.044 * i;
    case 'Uranus':
      return -7.19 + base;
    default:
      return -6.87 + base;
  }
}

/** Equatorial semidiameter at 1 AU, arcseconds. */
export const PLANET_SD_1AU_ARCSEC: Record<string, number> = {
  Mercury: 3.36,
  Venus: 8.41,
  Mars: 4.68,
  Jupiter: 98.44,
  Saturn: 82.73,
  Uranus: 35.02,
  Neptune: 33.5,
};

// ---------------------------------------------------------------------------
// The observer
// ---------------------------------------------------------------------------

export interface Site {
  lat_deg: number;
  lon_deg: number;
  sinLat: number;
  cosLat: number;
  /** Distance from the Earth's axis, km. */
  xy_km: number;
  /** Distance from the equatorial plane, km. */
  z_km: number;
}

export function makeSite(latDeg: number, lonDeg: number, heightM: number): Site {
  const e2 = WGS84_F * (2 - WGS84_F);
  const phi = latDeg * D2R;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const n = EARTH_RADIUS_KM / Math.sqrt(1 - e2 * s * s);
  const h = heightM / 1000;
  return {
    lat_deg: latDeg,
    lon_deg: lonDeg,
    sinLat: s,
    cosLat: c,
    xy_km: (n + h) * c,
    z_km: (n * (1 - e2) + h) * s,
  };
}

/** Topocentric RA/Dec: subtract the site's position (at local sidereal angle `lstDeg`). */
export function topocentricRaDec(
  raDeg: number,
  decDeg: number,
  distKm: number,
  site: Site,
  lstDeg: number,
): { ra_deg: number; dec_deg: number } {
  const u = unitVector(raDeg, decDeg);
  const l = lstDeg * D2R;
  const v: Vec3 = [
    distKm * u[0] - site.xy_km * Math.cos(l),
    distKm * u[1] - site.xy_km * Math.sin(l),
    distKm * u[2] - site.z_km,
  ];
  const { ra_deg, dec_deg } = vecToRaDec(v);
  return { ra_deg, dec_deg };
}

/** Altitude and azimuth (from north through east) from hour angle and declination. */
export function horizontal(haDeg: number, decDeg: number, site: Site): { alt_deg: number; az_deg: number } {
  const h = haDeg * D2R;
  const d = decDeg * D2R;
  const sd = Math.sin(d);
  const cd = Math.cos(d);
  const ch = Math.cos(h);
  const sinAlt = site.sinLat * sd + site.cosLat * cd * ch;
  const az = Math.atan2(-cd * Math.sin(h), sd * site.cosLat - cd * site.sinLat * ch);
  return { alt_deg: Math.asin(Math.max(-1, Math.min(1, sinAlt))) * R2D, az_deg: norm360(az * R2D) };
}

/** CONVENTIONS section 3: navigation Hc and Zn on the sphere. */
export function sightReduction(
  latDeg: number,
  decDeg: number,
  lhaDeg: number,
): { hc_deg: number; zn_deg: number } {
  const p = latDeg * D2R;
  const d = decDeg * D2R;
  const t = lhaDeg * D2R;
  const sinHc = Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(t);
  const n = Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(t);
  const e = -Math.cos(d) * Math.sin(t);
  return {
    hc_deg: Math.asin(Math.max(-1, Math.min(1, sinHc))) * R2D,
    zn_deg: norm360(Math.atan2(e, n) * R2D),
  };
}

/** Parallactic angle (Meeus 14.1), degrees in (-180, 180]. */
export function parallacticAngle(haDeg: number, decDeg: number, site: Site): number {
  const h = haDeg * D2R;
  const d = decDeg * D2R;
  const q = Math.atan2(
    Math.sin(h) * site.cosLat,
    site.sinLat * Math.cos(d) - site.cosLat * Math.sin(d) * Math.cos(h),
  );
  return wrap180(q * R2D);
}

/** Position angle of the bright limb (Meeus 48.5), from celestial north through east. */
export function brightLimbAngle(sunRa: number, sunDec: number, ra: number, dec: number): number {
  const d0 = sunDec * D2R;
  const d = dec * D2R;
  const da = (sunRa - ra) * D2R;
  return norm360(
    Math.atan2(Math.cos(d0) * Math.sin(da), Math.sin(d0) * Math.cos(d) - Math.cos(d0) * Math.sin(d) * Math.cos(da)) *
      R2D,
  );
}

/** Display refraction, arcminutes (CONVENTIONS 13.2, Saemundsson). */
export function refractionArcmin(altDeg: number, pressureHpa = 1010, temperatureC = 10): number {
  const h = Math.max(altDeg, -1);
  const r = 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * D2R);
  return r * (pressureHpa / 1010) * (283 / (273 + temperatureC));
}

export function angleBetween(ra1: number, dec1: number, ra2: number, dec2: number): number {
  const a = unitVector(ra1, dec1);
  const b = unitVector(ra2, dec2);
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.acos(Math.max(-1, Math.min(1, dot))) * R2D;
}
