/**
 * MOCK ENGINE ONLY — the Moon in detail (expansion programme P8), for developing the
 * interface. Never a source of results: the real numbers come from `skyfix_almanac::
 * {libration, lunar_features, apsides, occultations}` through `crates/skyfix-wasm/src/
 * moondetail.rs`. Shapes, ranges and failure modes follow EXPLORER_API.md, "Moon in
 * detail"; the astronomy is the mock's low-precision Sun and Moon (`astro.ts`, the Moon to
 * about 0.3°), so everything here can be that far out:
 *
 * - orientation: Meeus's optical libration (chapter 53) from the mock Moon, no physical
 *   libration; topocentric from the mock's topocentric Moon; the sub-solar point from
 *   the mock Sun;
 * - features: 15 of the real table's 150 rows (`crates/skyfix-almanac/data/
 *   lunar_features.tsv`, from the USGS/IAU gazetteer, public domain);
 * - apsides: extremes of the mock Moon's distance sampled every 3 hours; supermoons by
 *   the real rule;
 * - occultations: the mock Moon against the navigational stars near the ecliptic and the
 *   planets, contacts on a one-minute grid (minutes out).
 */

import { isoUtc } from '../../time.js';
import type {
  DiscPoint,
  ExplorerEngine,
  LunarFeatureKind,
  LunarFeatureState,
  MoonApsides,
  MoonApsis,
  MoonFeatures,
  MoonOrientation,
  MoonSyzygy,
  Observer,
  Occultation,
  OccultationContact,
  OccultationList,
  OccultationOptions,
  Selenographic,
  SkyPhase,
} from '../types.js';
import * as A from './astro.js';
import { NAV_STAR_ROWS } from './stars.js';

const I_DEG = 1.54242;
const MEAN_DISTANCE_KM = 384_400;
const K_MOON = 0.2725076;
const COVERAGE_START_UTC = '1990-01-01T00:00:00Z';
const COVERAGE_END_UTC = '2060-12-31T23:59:59Z';
const COVERAGE_START = 2_447_892.5;
const COVERAGE_END = 2_473_824.5 - 1 / 86_400;
const LIMB_NOTE =
  'MOCK engine: low-precision Moon, contacts minutes out. The real engine uses the mean lunar limb; ' +
  'real limbs move times by seconds, by up to a minute near the Moon\'s poles.';

type Row = [string, LunarFeatureKind, number, number, number, 1 | 2 | 3, string];
/** 15 rows of the real table (tools/moon/picks.txt; USGS/IAU gazetteer positions). */
const FEATURES: readonly Row[] = [
  ['Oceanus Procellarum', 'oceanus', 20.67, -56.68, 2592.24, 1, 'The Ocean of Storms, the largest of the dark lava plains'],
  ['Mare Imbrium', 'mare', 34.72, -14.91, 1145.53, 1, 'The Sea of Showers, a huge impact basin ringed by mountains'],
  ['Mare Serenitatis', 'mare', 27.29, 18.36, 674.28, 1, 'The Sea of Serenity, a round lava plain with pale shores'],
  ['Mare Tranquillitatis', 'mare', 8.35, 30.83, 875.75, 1, 'The Sea of Tranquillity, where Apollo 11 landed'],
  ['Mare Crisium', 'mare', 16.18, 59.1, 555.92, 1, 'The Sea of Crises, an isolated oval sea near the eastern limb'],
  ['Mare Nubium', 'mare', -20.59, -17.29, 714.5, 2, 'The Sea of Clouds, home of the Straight Wall'],
  ['Montes Apenninus', 'montes', 19.87, 0.03, 599.67, 1, 'The Apennines, the grandest range, part of the rim of Imbrium'],
  ['Rupes Recta', 'rupes', -21.67, -7.7, 115.95, 1, 'The Straight Wall: a dark line before full Moon, a bright one after'],
  ['Copernicus', 'crater', 9.62, -20.08, 96.07, 1, 'A crater with terraced walls and central peaks; rays at full Moon'],
  ['Tycho', 'crater', -43.3, -11.22, 85.29, 1, 'A young crater whose bright rays cross the whole disc at full Moon'],
  ['Aristarchus', 'crater', 23.73, -47.49, 39.99, 1, 'The brightest crater on the Moon, on a dark volcanic plateau'],
  ['Plato', 'crater', 51.62, -9.38, 100.68, 1, 'A crater with a flat, dark lava floor, north of Imbrium'],
  ['Clavius', 'crater', -58.62, -14.73, 230.77, 1, 'One of the largest craters, with an arc of smaller craters on its floor'],
  ['Ptolemaeus', 'crater', -9.16, -1.84, 153.67, 1, 'A great walled plain near the centre, first of a chain of three'],
  ['Apollo 11', 'landing_site', 0.67, 23.47, 0, 1, 'Tranquility Base, the first crewed landing, 20 July 1969'],
];

function checkJd(name: string, jd: number): void {
  if (!Number.isFinite(jd)) throw new Error(`${name}: jd_utc must be a finite Julian date`);
  if (jd < COVERAGE_START || jd > COVERAGE_END) {
    throw new Error(`${name}: ${isoUtc(jd)} is outside the Moon's coverage (${COVERAGE_START_UTC} to ${COVERAGE_END_UTC})`);
  }
}

function checkObserver(name: string, o: Observer): void {
  if (!Number.isFinite(o.lat_deg) || !Number.isFinite(o.lon_deg) || Math.abs(o.lat_deg) > 90) {
    throw new Error(`${name}: observer latitude and longitude must be finite, latitude within ±90`);
  }
}

const dot = (a: A.Vec3, b: A.Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: A.Vec3): A.Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / n, v[1] / n, v[2] / n];
};

/** Meeus 47.2-47.7 (mean elongation not needed here): F and the node, degrees. */
function fAndNode(jd: number): { f: number; node: number } {
  const t = A.centuriesTT(jd);
  return { f: 93.272095 + 483202.0175233 * t, node: 125.0445479 - 1934.1362891 * t };
}

/** Meeus 53: the sub-point of a direction given by the Moon's ecliptic place seen from it. */
function optical(lonDeg: number, latDeg: number, jd: number): Selenographic {
  const { f, node } = fAndNode(jd);
  const w = (lonDeg - node) * A.D2R;
  const b = latDeg * A.D2R;
  const i = I_DEG * A.D2R;
  const a = Math.atan2(Math.sin(w) * Math.cos(b) * Math.cos(i) - Math.sin(b) * Math.sin(i), Math.cos(w) * Math.cos(b));
  return {
    lat_deg: Math.asin(-Math.sin(w) * Math.cos(b) * Math.sin(i) - Math.sin(b) * Math.cos(i)) * A.R2D,
    lon_deg: A.wrap180(a * A.R2D - f),
  };
}

/** The Moon's pole (equatorial of date, mean equinox) from Meeus 53 without physical libration. */
function pole(jd: number): A.Vec3 {
  const t = A.centuriesTT(jd);
  const { node } = fAndNode(jd);
  const eps = A.obliquityDeg(t) * A.D2R;
  const v = node * A.D2R;
  const i = I_DEG * A.D2R;
  const x = -Math.sin(i) * Math.sin(v);
  const yEcl = Math.sin(i) * Math.cos(v);
  const zEcl = Math.cos(i);
  return [x, yEcl * Math.cos(eps) - zEcl * Math.sin(eps), yEcl * Math.sin(eps) + zEcl * Math.cos(eps)];
}

interface Geometry {
  jd: number;
  moon: A.MoonPosition;
  sun: A.SunPosition;
  /** Observer to Moon, km, equatorial of date. */
  los: A.Vec3;
  observer: Observer | null;
  q: number | null;
  subObserver: Selenographic;
  subEarth: Selenographic;
  subSolar: Selenographic;
  pole: A.Vec3;
}

function geometry(observer: Observer | null, jd: number): Geometry {
  const moon = A.moonPosition(jd);
  const sun = A.sunPosition(jd);
  const m = A.unitVector(moon.ra_deg, moon.dec_deg).map((x) => x * moon.dist_km) as A.Vec3;
  let los: A.Vec3 = m;
  let q: number | null = null;
  let subObserver = optical(moon.lon_deg, moon.lat_deg, jd);
  if (observer) {
    const site = A.makeSite(observer.lat_deg, observer.lon_deg, observer.height_m ?? 0);
    const lst = A.gmstDeg(jd) + observer.lon_deg;
    const l = lst * A.D2R;
    los = [m[0] - site.xy_km * Math.cos(l), m[1] - site.xy_km * Math.sin(l), m[2] - site.z_km];
    const { ra_deg, dec_deg } = A.vecToRaDec(los);
    const t = A.centuriesTT(jd);
    const ecl = A.equatorialToEcliptic(ra_deg, dec_deg, A.obliquityDeg(t));
    subObserver = optical(ecl.lon_deg, ecl.lat_deg, jd);
    q = A.parallacticAngle(A.norm360(lst - ra_deg), dec_deg, site);
  }
  // Meeus 53: the Sun's selenographic place from the Moon's heliocentric direction.
  const ratio = moon.dist_km / (sun.dist_au * A.AU_KM);
  const lh = sun.lon_deg + 180 + ratio * A.R2D * Math.cos(moon.lat_deg * A.D2R) * Math.sin((sun.lon_deg - moon.lon_deg) * A.D2R);
  const subSolar = optical(lh, ratio * moon.lat_deg, jd);
  return {
    jd,
    moon,
    sun,
    los,
    observer,
    q,
    subObserver,
    subEarth: optical(moon.lon_deg, moon.lat_deg, jd),
    subSolar,
    pole: pole(jd),
  };
}

/** Selenographic place to an equatorial unit vector, rebuilt from the sub-observer point
 * and the pole (enough for the mock's drawing). */
function selenographicToEquatorial(g: Geometry, s: Selenographic): A.Vec3 {
  const u = unit(g.los);
  const toward = [-u[0], -u[1], -u[2]] as A.Vec3;
  const p = unit(g.pole);
  // A frame on the Moon: z the pole, x the sub-observer meridian rotated back by its longitude.
  const zc = p;
  const xr = unit([
    toward[0] - dot(toward, zc) * zc[0],
    toward[1] - dot(toward, zc) * zc[1],
    toward[2] - dot(toward, zc) * zc[2],
  ]);
  const yr: A.Vec3 = [zc[1] * xr[2] - zc[2] * xr[1], zc[2] * xr[0] - zc[0] * xr[2], zc[0] * xr[1] - zc[1] * xr[0]];
  const dl = (s.lon_deg - g.subObserver.lon_deg) * A.D2R;
  const b = s.lat_deg * A.D2R;
  const c = Math.cos(b);
  return [
    c * Math.cos(dl) * xr[0] + c * Math.sin(dl) * yr[0] + Math.sin(b) * zc[0],
    c * Math.cos(dl) * xr[1] + c * Math.sin(dl) * yr[1] + Math.sin(b) * zc[1],
    c * Math.cos(dl) * xr[2] + c * Math.sin(dl) * yr[2] + Math.sin(b) * zc[2],
  ];
}

function northEast(u: A.Vec3): { n: A.Vec3; e: A.Vec3 } {
  const e = unit([-u[1], u[0], 0]);
  return { e, n: [u[1] * e[2] - u[2] * e[1], u[2] * e[0] - u[0] * e[2], u[0] * e[1] - u[1] * e[0]] };
}

function disc(g: Geometry, s: A.Vec3): DiscPoint {
  const u = unit(g.los);
  const { n, e } = northEast(u);
  const east = dot(s, e);
  const north = dot(s, n);
  const visible = -dot(s, u) > 0;
  if (g.q === null) return { east, north, x: -east, y: north, visible };
  const q = g.q * A.D2R;
  return { east, north, x: north * Math.sin(q) - east * Math.cos(q), y: north * Math.cos(q) + east * Math.sin(q), visible };
}

function angle(a: Selenographic, b: Selenographic): number {
  return A.angleBetween(a.lon_deg, a.lat_deg, b.lon_deg, b.lat_deg);
}

export function mockMoonOrientation(observer: Observer | null, jdUtc: number): MoonOrientation {
  checkJd('moon_orientation', jdUtc);
  if (observer) checkObserver('moon_orientation', observer);
  const g = geometry(observer, jdUtc);
  const u = unit(g.los);
  const { n, e } = northEast(u);
  const pa = A.norm360(Math.atan2(dot(g.pole, e), dot(g.pole, n)) * A.R2D);
  const u0 = A.unitVector(g.moon.ra_deg, g.moon.dec_deg);
  const ne0 = northEast(u0);
  const pa0 = A.norm360(Math.atan2(dot(g.pole, ne0.e), dot(g.pole, ne0.n)) * A.R2D);
  const dist = Math.hypot(g.los[0], g.los[1], g.los[2]);
  const sd = Math.asin((K_MOON * A.EARTH_RADIUS_KM) / dist) * A.R2D;
  const psi = A.angleBetween(g.moon.ra_deg, g.moon.dec_deg, g.sun.ra_deg, g.sun.dec_deg);
  const sunKm = g.sun.dist_au * A.AU_KM;
  const i = Math.atan2(sunKm * Math.sin(psi * A.D2R), g.moon.dist_km - sunKm * Math.cos(psi * A.D2R)) * A.R2D;
  const points: [number, number][] = [];
  const discPts: [number, number][] = [];
  const s0 = g.subSolar;
  for (let k = 0; k < 360; k += 5) {
    // Points 90° from the sub-solar point, walking the great circle.
    const lat = Math.asin(Math.cos(s0.lat_deg * A.D2R) * Math.sin(k * A.D2R)) * A.R2D;
    const lon = A.wrap180(s0.lon_deg - 90 + Math.atan2(Math.sin(k * A.D2R) * Math.sin(s0.lat_deg * A.D2R), Math.cos(k * A.D2R)) * A.R2D);
    points.push([lat, lon]);
    const d = disc(g, selenographicToEquatorial(g, { lat_deg: lat, lon_deg: lon }));
    if (d.visible) discPts.push([d.x, d.y]);
  }
  let alt: number | null = null;
  let az: number | null = null;
  if (observer) {
    const site = A.makeSite(observer.lat_deg, observer.lon_deg, observer.height_m ?? 0);
    const { ra_deg, dec_deg } = A.vecToRaDec(g.los);
    const h = A.horizontal(A.norm360(A.gmstDeg(jdUtc) + observer.lon_deg - ra_deg), dec_deg, site);
    alt = h.alt_deg;
    az = h.az_deg;
  }
  return {
    jd_utc: jdUtc,
    utc: isoUtc(jdUtc),
    topocentric: observer !== null,
    libration: {
      lon_deg: g.subObserver.lon_deg,
      lat_deg: g.subObserver.lat_deg,
      optical_lon_deg: g.subEarth.lon_deg,
      optical_lat_deg: g.subEarth.lat_deg,
      physical_lon_deg: 0,
      physical_lat_deg: 0,
      diurnal_lon_deg: A.wrap180(g.subObserver.lon_deg - g.subEarth.lon_deg),
      diurnal_lat_deg: g.subObserver.lat_deg - g.subEarth.lat_deg,
    },
    sub_observer: g.subObserver,
    sub_earth: g.subEarth,
    sub_solar: g.subSolar,
    colongitude_deg: A.norm360(90 - g.subSolar.lon_deg),
    axis_position_angle_deg: pa,
    geocentric_axis_position_angle_deg: pa0,
    bright_limb_angle_deg: A.brightLimbAngle(g.sun.ra_deg, g.sun.dec_deg, g.moon.ra_deg, g.moon.dec_deg),
    illuminated_fraction: (1 + Math.cos(i * A.D2R)) / 2,
    phase_angle_deg: i,
    waxing: A.norm360(g.moon.lon_deg - g.sun.lon_deg) < 180,
    terminator: {
      pole: g.subSolar,
      morning_lon_deg: A.wrap180(g.subSolar.lon_deg - 90),
      evening_lon_deg: A.wrap180(g.subSolar.lon_deg + 90),
      points,
      disc: discPts,
    },
    distance_km: dist,
    semidiameter_arcmin: sd * 60,
    apparent_diameter_arcmin: 2 * sd * 60,
    diameter_vs_mean_percent: (MEAN_DISTANCE_KM / dist - 1) * 100,
    geocentric_distance_km: g.moon.dist_km,
    geocentric_semidiameter_arcmin: K_MOON * g.moon.hp_deg * 60,
    alt_deg: alt,
    az_deg: az,
    parallactic_angle_deg: g.q,
    north_pole_disc: disc(g, g.pole),
    sub_solar_disc: disc(g, selenographicToEquatorial(g, g.subSolar)),
  };
}

export function mockMoonFeatures(observer: Observer | null, jdUtc: number): MoonFeatures {
  const o = mockMoonOrientation(observer, jdUtc);
  const g = geometry(observer, jdUtc);
  const band = 10;
  const features: LunarFeatureState[] = FEATURES.map(([name, kind, lat, lon, diameter, rank, description]) => {
    const place = { lat_deg: lat, lon_deg: lon };
    const sunAlt = 90 - angle(place, o.sub_solar);
    const r = ((diameter / 2 / 1737.4) * 180) / Math.PI;
    const d = disc(g, selenographicToEquatorial(g, place));
    return {
      name,
      kind,
      lat_deg: lat,
      lon_deg: lon,
      diameter_km: diameter,
      rank,
      description,
      sun_altitude_deg: sunAlt,
      lit: sunAlt > 0,
      morning: A.wrap180(lon - o.sub_solar.lon_deg) < 0,
      near_terminator: d.visible && sunAlt > -r && sunAlt < band + r,
      visible: d.visible,
      angle_from_disc_centre_deg: angle(place, o.sub_observer),
      disc: d,
    };
  });
  const tonight = features
    .filter((f) => f.near_terminator && f.kind !== 'albedo')
    .sort((a, b) => a.rank - b.rank || a.sun_altitude_deg - b.sun_altitude_deg)
    .map((f) => f.name);
  return {
    jd_utc: jdUtc,
    utc: isoUtc(jdUtc),
    topocentric: o.topocentric,
    colongitude_deg: o.colongitude_deg,
    sub_solar: o.sub_solar,
    sub_observer: o.sub_observer,
    axis_position_angle_deg: o.axis_position_angle_deg,
    parallactic_angle_deg: o.parallactic_angle_deg,
    illuminated_fraction: o.illuminated_fraction,
    waxing: o.waxing,
    terminator_band_deg: band,
    tonight,
    features,
    source: 'MOCK: 15 of the 150 features (USGS/IAU Gazetteer of Planetary Nomenclature positions).',
  };
}

function clipWindow(name: string, jdStart: number, jdEnd: number, maxDays: number): [number, number, boolean] {
  if (!Number.isFinite(jdStart) || !Number.isFinite(jdEnd) || jdEnd <= jdStart) {
    throw new Error(`${name}: the window must be finite and end after it starts`);
  }
  if (jdEnd - jdStart > maxDays) throw new Error(`${name}: the window is longer than ${maxDays} days`);
  const lo = Math.max(jdStart, COVERAGE_START);
  const hi = Math.min(jdEnd, COVERAGE_END);
  return [lo, hi, lo > jdStart || hi < jdEnd];
}

export function mockMoonApsides(engine: ExplorerEngine, jdStart: number, jdEnd: number): MoonApsides {
  const [lo, hi, truncated] = clipWindow('moon_apsides', jdStart, jdEnd, 36_525);
  const dist = (t: number): number => A.moonPosition(t).dist_km;
  const sd = (d: number): number => Math.asin((K_MOON * A.EARTH_RADIUS_KM) / d) * A.R2D * 60;
  const ext: { kind: 'perigee' | 'apogee'; t: number; d: number }[] = [];
  const a0 = Math.max(lo - 20, COVERAGE_START);
  const a1 = Math.min(hi + 20, COVERAGE_END);
  const step = 0.125;
  for (let t = a0 + step; t < a1 - step; t += step) {
    const [p, c, n] = [dist(t - step), dist(t), dist(t + step)];
    if (c <= p && c < n) ext.push({ kind: 'perigee', t, d: c });
    else if (c >= p && c > n) ext.push({ kind: 'apogee', t, d: c });
  }
  const apsides: MoonApsis[] = ext
    .filter((e) => e.t >= lo && e.t <= hi)
    .map((e) => ({
      kind: e.kind,
      jd_utc: e.t,
      utc: isoUtc(e.t),
      distance_km: e.d,
      semidiameter_arcmin: sd(e.d),
      diameter_arcmin: 2 * sd(e.d),
      diameter_vs_mean_percent: (MEAN_DISTANCE_KM / e.d - 1) * 100,
    }));
  const phases = hi > lo ? engine.moonPhases(lo, hi) : [];
  const full = phases.filter((p) => p.kind === 'full_moon').map((p) => ({ t: p.jd_utc, d: dist(p.jd_utc) }));
  const yearOf = (t: number): number => new Date((t - 2_440_587.5) * 86_400_000).getUTCFullYear();
  const syzygies: MoonSyzygy[] = [];
  for (const p of phases) {
    if (p.kind !== 'new_moon' && p.kind !== 'full_moon') continue;
    const k = ext.findIndex((e) => e.t > p.jd_utc);
    if (k < 1) continue;
    const pair = [ext[k - 1]!, ext[k]!];
    const per = pair.find((e) => e.kind === 'perigee');
    const apo = pair.find((e) => e.kind === 'apogee');
    if (!per || !apo) continue;
    const d = dist(p.jd_utc);
    const fraction = (apo.d - d) / (apo.d - per.d);
    const sameYear = full.filter((f) => yearOf(f.t) === yearOf(p.jd_utc)).map((f) => f.d);
    const isFull = p.kind === 'full_moon';
    syzygies.push({
      kind: p.kind,
      jd_utc: p.jd_utc,
      utc: p.utc,
      distance_km: d,
      diameter_arcmin: 2 * sd(d),
      diameter_vs_mean_percent: (MEAN_DISTANCE_KM / d - 1) * 100,
      perigee: { jd_utc: per.t, utc: isoUtc(per.t), distance_km: per.d },
      apogee: { jd_utc: apo.t, utc: isoUtc(apo.t), distance_km: apo.d },
      hours_from_perigee: (p.jd_utc - per.t) * 24,
      perigee_fraction: fraction,
      supermoon: fraction >= 0.9,
      micromoon: fraction <= 0.1,
      largest_of_year: isFull && d === Math.min(...sameYear),
      smallest_of_year: isFull && d === Math.max(...sameYear),
    });
  }
  return {
    jd_start: lo,
    jd_end: hi,
    truncated,
    coverage_start_utc: COVERAGE_START_UTC,
    coverage_end_utc: COVERAGE_END_UTC,
    apsides,
    syzygies,
    definitions: {
      apsis: 'MOCK: extremes of the low-precision Moon distance.',
      supermoon: 'A new or full Moon at least 90 % of the way from apogee to perigee (Nolle 1979).',
      micromoon: 'A new or full Moon at least 90 % of the way to apogee.',
      largest_of_year: 'The nearest and farthest full Moons of a UTC calendar year.',
      mean_distance_km: MEAN_DISTANCE_KM,
    },
  };
}

function skyPhase(sunAlt: number): SkyPhase {
  if (sunAlt > -50 / 60) return 'day';
  if (sunAlt > -6) return 'civil';
  if (sunAlt > -12) return 'nautical';
  if (sunAlt > -18) return 'astronomical';
  return 'night';
}

export function mockOccultations(
  observer: Observer,
  jdStart: number,
  jdEnd: number,
  options: OccultationOptions = {},
): OccultationList {
  checkObserver('occultations', observer);
  const [lo, hi, truncated] = clipWindow('occultations', jdStart, jdEnd, 400);
  const site = A.makeSite(observer.lat_deg, observer.lon_deg, observer.height_m ?? 0);
  const maxMag = options.max_magnitude ?? 3.5;
  if (!(maxMag >= -2 && maxMag <= 6.5)) throw new Error('occultations: options: max_magnitude is outside -2 .. 6.5');
  const bodies: { name: string; kind: 'star' | 'planet'; mag: number | null; radec: (t: number) => { ra: number; dec: number } }[] = [];
  if (options.stars ?? true) {
    for (const [name, , ra, dec, vmag] of NAV_STAR_ROWS) {
      const t = A.centuriesTT(0.5 * (lo + hi));
      const { ra_deg, dec_deg } = A.vecToRaDec(A.applyMat(A.precessionMatrix(t), A.unitVector(ra, dec)));
      const ecl = A.equatorialToEcliptic(ra_deg, dec_deg, A.obliquityDeg(t));
      if (Math.abs(ecl.lat_deg) > 7) continue;
      bodies.push({ name, kind: 'star', mag: vmag, radec: () => ({ ra: ra_deg, dec: dec_deg }) });
    }
  }
  if (options.planets ?? true) {
    for (const name of A.PLANET_NAMES) {
      bodies.push({
        name,
        kind: 'planet',
        mag: null,
        radec: (t) => {
          const tc = A.centuriesTT(t);
          const p = A.heliocentric(name, tc);
          const e = A.heliocentric('EMBary', tc);
          const { ra_deg, dec_deg } = A.vecToRaDec(
            A.applyMat(A.precessionMatrix(tc), A.eclipticToEquatorialVec([p[0] - e[0], p[1] - e[1], p[2] - e[2]])),
          );
          return { ra: ra_deg, dec: dec_deg };
        },
      });
    }
  }
  const wanted = options.bodies?.map((b) => b.trim().toLowerCase());
  for (const w of wanted ?? []) {
    if (!bodies.some((b) => b.name.toLowerCase() === w)) {
      throw new Error(`occultations: options: bodies: "${w}" is not a body this search knows`);
    }
  }
  const targets = wanted ? bodies.filter((b) => wanted.includes(b.name.toLowerCase())) : bodies;
  const events: Occultation[] = [];
  const limbDistance = (b: (typeof bodies)[number], t: number): { f: number; pa: number; alt: number; ra: number; dec: number } => {
    const m = A.moonPosition(t);
    const lst = A.gmstDeg(t) + observer.lon_deg;
    const topo = A.topocentricRaDec(m.ra_deg, m.dec_deg, m.dist_km, site, lst);
    const { ra, dec } = b.radec(t);
    const sep = A.angleBetween(topo.ra_deg, topo.dec_deg, ra, dec);
    const pa = A.norm360(
      Math.atan2(
        Math.sin((ra - topo.ra_deg) * A.D2R) * Math.cos(dec * A.D2R),
        Math.cos(topo.dec_deg * A.D2R) * Math.sin(dec * A.D2R) -
          Math.sin(topo.dec_deg * A.D2R) * Math.cos(dec * A.D2R) * Math.cos((ra - topo.ra_deg) * A.D2R),
      ) * A.R2D,
    );
    const alt = A.horizontal(A.norm360(lst - topo.ra_deg), topo.dec_deg, site).alt_deg;
    return { f: sep - K_MOON * m.hp_deg, pa, alt, ra: topo.ra_deg, dec: topo.dec_deg };
  };
  const contact = (b: (typeof bodies)[number], kind: 'disappearance' | 'reappearance', t: number): OccultationContact => {
    const s = limbDistance(b, t);
    const sun = A.sunPosition(t);
    const chi = A.brightLimbAngle(sun.ra_deg, sun.dec_deg, s.ra, s.dec);
    const off = A.wrap180(s.pa - chi);
    const lst = A.gmstDeg(t) + observer.lon_deg;
    const sunAlt = A.horizontal(A.norm360(lst - sun.ra_deg), sun.dec_deg, site).alt_deg;
    const q = A.parallacticAngle(A.norm360(lst - s.ra), s.dec, site);
    const cuspPa = off >= 0 ? chi + 90 : chi - 90;
    return {
      kind,
      jd_utc: t,
      utc: isoUtc(t),
      position_angle_deg: s.pa,
      vertex_angle_deg: A.norm360(s.pa - q),
      cusp_angle_deg: Math.abs(off) - 90,
      cusp: Math.cos(cuspPa * A.D2R) >= 0 ? 'N' : 'S',
      limb: Math.abs(off) < 90 ? 'bright' : 'dark',
      moon_alt_deg: s.alt,
      moon_az_deg: 0,
      moon_above_horizon: s.alt > 0,
      sun_alt_deg: sunAlt,
      sky_phase: skyPhase(sunAlt),
      crossing_s: 0,
    };
  };
  for (const b of targets) {
    let prev = limbDistance(b, lo).f;
    let inside = prev < 0;
    let start: number | null = inside ? lo : null;
    for (let t = lo + 1 / 1440; t <= hi; t += prev > 3 ? 1 / 24 : 1 / 1440) {
      const cur = limbDistance(b, t).f;
      if (!inside && cur < 0) {
        inside = true;
        start = t;
      } else if (inside && cur >= 0) {
        inside = false;
        const d = start !== null ? contact(b, 'disappearance', start) : null;
        const r = contact(b, 'reappearance', t);
        const visible = (d?.moon_above_horizon ?? false) || r.moon_above_horizon;
        if (visible || options.include_below_horizon) {
          const mid = 0.5 * ((start ?? t) + t);
          events.push({
            body: b.name,
            kind: b.kind,
            designation: null,
            hr: null,
            magnitude: b.mag,
            navigational: b.kind === 'star' || ['Venus', 'Mars', 'Jupiter', 'Saturn'].includes(b.name),
            occulted: true,
            graze: false,
            disappearance: d,
            reappearance: r,
            closest: { jd_utc: mid, utc: isoUtc(mid), limb_distance_arcmin: -5, position_angle_deg: 0, moon_alt_deg: r.moon_alt_deg },
            duration_s: start !== null ? (t - start) * 86_400 : null,
            body_semidiameter_arcsec: 0,
            moon_illuminated_fraction: 0.5,
            waxing: true,
            visible,
          });
        }
      }
      prev = cur;
    }
  }
  events.sort((a, b) => (a.disappearance?.jd_utc ?? a.closest.jd_utc) - (b.disappearance?.jd_utc ?? b.closest.jd_utc));
  return {
    jd_start: lo,
    jd_end: hi,
    truncated,
    coverage_start_utc: COVERAGE_START_UTC,
    coverage_end_utc: COVERAGE_END_UTC,
    limb_note: LIMB_NOTE,
    bodies_searched: targets.length,
    events,
    errors: [],
  };
}
