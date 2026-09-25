/**
 * MOCK ENGINE ONLY — planet detail (EXPLORER_API "Planet detail"), for developing the
 * interface. Every number is illustrative. The shapes, ranges, sign conventions and
 * failure modes follow the real engine (`crates/skyfix-wasm/src/planetdetail.rs`); the
 * astronomy is the mock's own low-precision positions (`mock/astro.ts`):
 *
 * - Galilean moons: Meeus, Astronomical Algorithms (2nd ed.), chapter 44, the
 *   low-accuracy method (about 0.2 of Jupiter's radius; phenomena within about 20
 *   minutes of JPL's), with the eclipses and shadows cast along the Sun's direction.
 * - Discs and rings: the IAU 2015 poles and prime meridians without their periodic
 *   terms, on the mock's planet positions (no aberration, one light-time iteration).
 * - Transits, conjunctions, stations and the Earth's apsides: the real engine's
 *   definitions searched on the mock's positions (minutes out, sometimes more).
 * - Orbits: Kepler's equation (elliptic, parabolic, hyperbolic) on the elements as
 *   given; the MPC one-line formats are read by column.
 */

import { isoUtc, jdFromIso } from '../../time.js';
import * as A from './astro.js';
import { NAV_STAR_ROWS } from './stars.js';
import type {
  Conjunction,
  ConjunctionKind,
  ConjunctionList,
  ConjunctionLocal,
  ConjunctionOptions,
  ConjunctionView,
  CustomBodyInput,
  CustomBodyState,
  CustomBodyStates,
  EarthApsides,
  EarthApsisEvent,
  GalileanEvents,
  GalileanInstant,
  GalileanMoon,
  GalileanMoonName,
  GalileanMoons,
  GalileanPhenomenon,
  GalileanPhenomenonKind,
  Observer,
  OrbitalElements,
  OrbitClass,
  OrbitMagnitudeModel,
  PlanetCentralMeridian,
  PlanetDisc,
  PlanetStation,
  PlanetStationCoordinate,
  PlanetStationList,
  PlanetTransit,
  PlanetTransitContact,
  PlanetTransitContactKind,
  PlanetTransitList,
  PlanetTransitLocal,
  PlanetTransitLocalEvent,
  PlanetTransitPathPoint,
  Sampled,
  SampledBody,
  SaturnRings,
} from '../types.js';

/** What the planet-detail mock needs from the mock engine. */
export interface PlanetDetailMockEnv {
  /** The mock's coverage window, UTC Julian dates. */
  start: number;
  end: number;
  constellationAt(raDeg: number, decDeg: number, jdUtc: number): string;
}

type V3 = A.Vec3;
const { D2R, R2D } = A;
const LT_DAYS_PER_AU = 0.0057755183;
const AU_LIGHT_S = 499.004784;
const TT_MINUS_UTC_S = 69.184;
const ARCSEC = 3600;
const SUN_SD_1AU_ARCSEC = 959.63;
const RISE_SET_DEG = -50 / 60;
const GAUSS_K = 0.01720209895;

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const unit = (a: V3): V3 => scale(a, 1 / len(a));
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const angleDeg = (a: V3, b: V3): number => Math.atan2(len(cross(a, b)), dot(a, b)) * R2D;

function finite(x: number, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`${what}: expected a finite number`);
  return x;
}

/** The real engine's window check: finite, ordered, not too long; then clipped to coverage. */
function clip(
  env: PlanetDetailMockEnv,
  what: string,
  a: number,
  b: number,
  maxDays: number,
): [number, number, boolean] {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) {
    throw new Error(`${what} needs a finite window with jd_end >= jd_start (got ${a}, ${b})`);
  }
  if (b - a > maxDays) {
    throw new Error(`${what}: the window is ${Math.round(b - a)} days; at most ${maxDays} days per call`);
  }
  const lo = Math.max(a, env.start);
  const hi = Math.min(b, env.end);
  return [lo, hi, lo > a || hi < b];
}

function inside(env: PlanetDetailMockEnv, jd: number, what: string): void {
  finite(jd, `${what}: jd_utc`);
  if (jd < env.start || jd > env.end) {
    throw new Error(
      `${what}: ${isoUtc(jd)} is outside the coverage window (${isoUtc(env.start)} to ${isoUtc(env.end)})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Positions (the mock's own)
// ---------------------------------------------------------------------------

interface Geo {
  ra_deg: number;
  dec_deg: number;
  /** Unit vector, equator and equinox of date. */
  u: V3;
  /** Geocentric and heliocentric distances, AU. */
  delta: number;
  r: number;
  /** Geocentric and heliocentric vectors, J2000 equator, AU. */
  geoEq: V3;
  helioEq: V3;
}

function ofDate(v: V3, t: number): { ra_deg: number; dec_deg: number; u: V3 } {
  const w = A.applyMat(A.precessionMatrix(t), v);
  const { ra_deg, dec_deg } = A.vecToRaDec(w);
  return { ra_deg, dec_deg, u: unit(w) };
}

/** A planet (or a heliocentric J2000-ecliptic vector function) seen from the Earth. */
function geoFrom(helioAt: (t: number) => V3, jd: number): Geo {
  const t = A.centuriesTT(jd);
  const earth = A.heliocentric('EMBary', t);
  let helio = helioAt(t);
  let geo = sub(helio, earth);
  helio = helioAt(t - (len(geo) * LT_DAYS_PER_AU) / 36_525);
  geo = sub(helio, earth);
  const geoEq = A.eclipticToEquatorialVec(geo);
  return {
    ...ofDate(geoEq, t),
    delta: len(geo),
    r: len(helio),
    geoEq,
    helioEq: A.eclipticToEquatorialVec(helio),
  };
}

function planetGeo(name: string, jd: number): Geo {
  return geoFrom((t) => A.heliocentric(name, t), jd);
}

function sunDir(jd: number): { ra_deg: number; dec_deg: number; u: V3; dist_au: number } {
  const s = A.sunPosition(jd);
  return { ra_deg: s.ra_deg, dec_deg: s.dec_deg, u: A.unitVector(s.ra_deg, s.dec_deg), dist_au: s.dist_au };
}

function starRow(name: string): (typeof NAV_STAR_ROWS)[number] | undefined {
  const key = name.trim().toLowerCase();
  return NAV_STAR_ROWS.find((row) => row[0].toLowerCase() === key);
}

function starDir(name: string, jd: number): { ra_deg: number; dec_deg: number; u: V3 } {
  const row = starRow(name);
  if (!row) throw new Error(`${name} is not a navigational star`);
  return ofDate(A.unitVector(row[2], row[3]), A.centuriesTT(jd));
}

function phaseAngleDeg(r: number, delta: number, sunDist: number): number {
  const c = (r * r + delta * delta - sunDist * sunDist) / (2 * r * delta);
  return Math.acos(Math.max(-1, Math.min(1, c))) * R2D;
}

function planetMagnitude(name: string, jd: number): number {
  const g = planetGeo(name, jd);
  return A.planetMagnitude(name, g.r, g.delta, phaseAngleDeg(g.r, g.delta, A.sunPosition(jd).dist_au));
}

/** Position angle of `b` seen from `a`, north through east, degrees. */
function positionAngle(aRa: number, aDec: number, bRa: number, bDec: number): number {
  const da = (bRa - aRa) * D2R;
  const d0 = aDec * D2R;
  const d = bDec * D2R;
  return A.norm360(
    Math.atan2(Math.sin(da) * Math.cos(d), Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) *
      R2D,
  );
}

/** Offset of `b` from `a` on the sky, arcseconds east and north (small angles). */
function offsetArcsec(aRa: number, aDec: number, bRa: number, bDec: number): [number, number] {
  return [A.wrap180(bRa - aRa) * Math.cos(aDec * D2R) * ARCSEC, (bDec - aDec) * ARCSEC];
}

interface Place {
  site: A.Site;
  lat: number;
  lon: number;
  height: number;
  pressure: number;
  temperature: number;
}

function place(observer: Observer): Place {
  if (!observer || typeof observer !== 'object') throw new Error('observer: expected an object');
  const lat = finite(observer.lat_deg, 'observer.lat_deg');
  if (lat < -90 || lat > 90) throw new Error(`observer.lat_deg ${lat} is outside [-90, 90]`);
  const lon = A.wrap180(finite(observer.lon_deg, 'observer.lon_deg'));
  const height = observer.height_m === undefined ? 0 : finite(observer.height_m, 'observer.height_m');
  const pressure =
    observer.pressure_hpa === undefined ? 1010 : finite(observer.pressure_hpa, 'observer.pressure_hpa');
  const temperature =
    observer.temperature_c === undefined ? 10 : finite(observer.temperature_c, 'observer.temperature_c');
  return { site: A.makeSite(lat, lon, height), lat, lon, height, pressure, temperature };
}

/** Topocentric geometric altitude and azimuth, hour angle and declination of a geocentric place. */
function topo(
  p: Place,
  jd: number,
  raDeg: number,
  decDeg: number,
  distKm: number | null,
): { alt_deg: number; az_deg: number; ha_deg: number; ra_deg: number; dec_deg: number } {
  const lst = A.gmstDeg(jd) + p.lon;
  const t =
    distKm === null ? { ra_deg: raDeg, dec_deg: decDeg } : A.topocentricRaDec(raDeg, decDeg, distKm, p.site, lst);
  const ha = A.norm360(lst - t.ra_deg);
  return { ...A.horizontal(ha, t.dec_deg, p.site), ha_deg: ha, ra_deg: t.ra_deg, dec_deg: t.dec_deg };
}

function apparentAlt(p: Place, geometric: number): number {
  return geometric + A.refractionArcmin(geometric, p.pressure, p.temperature) / 60;
}

/** Golden-section minimum of `f` on [a, b]. */
function minimise(f: (t: number) => number, a: number, b: number, tol = 1e-6): [number, number] {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a);
  let d = a + g * (b - a);
  let fc = f(c);
  let fd = f(d);
  while (b - a > tol) {
    if (fc < fd) {
      b = d;
      d = c;
      fd = fc;
      c = b - g * (b - a);
      fc = f(c);
    } else {
      a = c;
      c = d;
      fc = fd;
      d = a + g * (b - a);
      fd = f(d);
    }
  }
  const t = 0.5 * (a + b);
  return [t, f(t)];
}

/** A sign change of `f` on [a, b] (f(a), f(b) of opposite signs), by bisection. */
function bisect(f: (t: number) => number, a: number, b: number, tol = 0.5 / 86_400): number {
  let fa = f(a);
  while (b - a > tol) {
    const m = 0.5 * (a + b);
    const fm = f(m);
    if (fa < 0 === fm < 0) {
      a = m;
      fa = fm;
    } else {
      b = m;
    }
  }
  return 0.5 * (a + b);
}

// ---------------------------------------------------------------------------
// IAU rotation (2015, periodic terms left out)
// ---------------------------------------------------------------------------

/** [alpha0, d alpha0/century, delta0, d delta0/century, W0, dW/day, flattening]. */
const IAU: Record<string, [number, number, number, number, number, number, number]> = {
  Mercury: [281.0103, -0.0328, 61.4155, -0.0049, 329.5988, 6.1385108, 0],
  Venus: [272.76, 0, 67.16, 0, 160.2, -1.4813688, 0],
  Mars: [317.269202, -0.10927547, 54.432516, -0.05827105, 176.049863, 350.891982443297, 0.005886],
  Jupiter: [268.056595, -0.006499, 64.495303, 0.002413, 284.95, 870.536, 0.064874],
  Saturn: [40.589, -0.036, 83.537, -0.004, 38.9, 810.7939024, 0.097962],
  Uranus: [257.311, 0, -15.175, 0, 203.81, -501.1600928, 0.022927],
  Neptune: [299.36, 0, 43.46, 0, 249.978, 541.1397757, 0.017081],
};

interface Rotation {
  pole: V3;
  poleRa: number;
  poleDec: number;
  /** The equator's ascending node on the J2000 equator, and 90 degrees on. */
  q: V3;
  s: V3;
  flattening: number;
}

function rotation(name: string, jd: number): Rotation {
  const row = IAU[name]!;
  const t = A.centuriesTT(jd);
  const ra = row[0] + row[1] * t;
  const dec = row[2] + row[3] * t;
  const pole = A.unitVector(ra, dec);
  const q: V3 = [-Math.sin(ra * D2R), Math.cos(ra * D2R), 0];
  return { pole, poleRa: ra, poleDec: dec, q, s: cross(pole, q), flattening: row[6] };
}

/** Angle of a direction in the planet's equator, from the node toward `s`, and its latitude. */
function inEquator(rot: Rotation, dir: V3): { theta: number; lat: number } {
  return {
    theta: A.norm360(Math.atan2(dot(dir, rot.s), dot(dir, rot.q)) * R2D),
    lat: Math.asin(Math.max(-1, Math.min(1, dot(dir, rot.pole)))) * R2D,
  };
}

function graphic(latDeg: number, f: number): number {
  return Math.atan(Math.tan(latDeg * D2R) / ((1 - f) * (1 - f))) * R2D;
}

// ---------------------------------------------------------------------------
// Galilean moons (Meeus 44, low accuracy)
// ---------------------------------------------------------------------------

const MOON_NAMES: readonly GalileanMoonName[] = ['Io', 'Europa', 'Ganymede', 'Callisto'];
/** Jupiter's polar radius over its equatorial radius (IAU). */
const JUPITER_B = 66_854 / 71_492;

interface Jovian {
  psi: number;
  ds: number;
  de: number;
  moons: { u: number; r: number }[];
}

function jovian(jd: number): Jovian {
  const s = (x: number): number => Math.sin(x * D2R);
  const c = (x: number): number => Math.cos(x * D2R);
  const d = jd + TT_MINUS_UTC_S / 86_400 - A.J2000;
  const V = 172.74 + 0.00111588 * d;
  const M = 357.529 + 0.9856003 * d;
  const N = 20.02 + 0.0830853 * d + 0.329 * s(V);
  const J = 66.115 + 0.9025179 * d - 0.329 * s(V);
  const Aa = 1.915 * s(M) + 0.02 * s(2 * M);
  const B = 5.555 * s(N) + 0.168 * s(2 * N);
  const K = J + Aa - B;
  const R = 1.00014 - 0.01671 * c(M) - 0.00014 * c(2 * M);
  const r = 5.20872 - 0.25208 * c(N) - 0.00611 * c(2 * N);
  const delta = Math.sqrt(r * r + R * R - 2 * r * R * c(K));
  const psi = Math.asin((R / delta) * s(K)) * R2D;
  const lam = 34.35 + 0.083091 * d + 0.329 * s(V) + B;
  const ds = 3.12 * s(lam + 42.8);
  const de = ds - 2.22 * s(psi) * c(lam + 22) - 1.3 * ((r - delta) / delta) * s(lam - 100.5);
  const t = d - delta / 173;
  const u = [
    163.8069 + 203.4058646 * t,
    358.414 + 101.2916335 * t,
    5.7176 + 50.234518 * t,
    224.8092 + 21.48798 * t,
  ].map((x) => x + psi - B) as [number, number, number, number];
  const G = 331.18 + 50.310482 * t;
  const H = 87.45 + 21.569231 * t;
  const u1 = u[0] + 0.473 * s(2 * (u[0] - u[1]));
  const u2 = u[1] + 1.065 * s(2 * (u[1] - u[2]));
  const u3 = u[2] + 0.165 * s(G);
  const u4 = u[3] + 0.843 * s(H);
  return {
    psi,
    ds,
    de,
    moons: [
      { u: u1, r: 5.9057 - 0.0244 * c(2 * (u1 - u2)) },
      { u: u2, r: 9.3966 - 0.0882 * c(2 * (u2 - u3)) },
      { u: u3, r: 14.9883 - 0.0216 * c(G) },
      { u: u4, r: 26.3627 - 0.1939 * c(H) },
    ],
  };
}

interface MoonGeometry {
  x: number;
  y: number;
  z: number;
  inTransit: boolean;
  occulted: boolean;
  eclipsed: boolean;
  shadow: [number, number] | null;
}

/**
 * Jupiter's frame: x along its equator toward the west on the sky, y its pole, z along the
 * equator away from the Earth; the Earth is DE above the equator, the Sun DS above it
 * and psi round from the Earth. Distances in equatorial radii; the oblate planet is made
 * a unit sphere by stretching y.
 */
function moonGeometry(sys: Jovian): MoonGeometry[] {
  const de = sys.de * D2R;
  const ds = sys.ds * D2R;
  const psi = sys.psi * D2R;
  const skyY: V3 = [0, Math.cos(de), Math.sin(de)];
  const depth: V3 = [0, -Math.sin(de), Math.cos(de)];
  const e2 = 1 - JUPITER_B * JUPITER_B;
  const bApparent = Math.sqrt(1 - e2 * Math.cos(de) ** 2);
  const sun = unit([Math.sin(psi) * Math.cos(ds), Math.sin(ds) / JUPITER_B, -Math.cos(psi) * Math.cos(ds)]);
  return sys.moons.map(({ u, r }) => {
    const m: V3 = [r * Math.sin(u * D2R), 0, -r * Math.cos(u * D2R)];
    const x = m[0];
    const y = dot(m, skyY);
    const z = dot(m, depth);
    const onDisc = x * x + (y / bApparent) ** 2 < 1;
    const along = dot(m, sun);
    const perp = len(sub(m, scale(sun, along)));
    let shadow: [number, number] | null = null;
    if (along > 0 && perp < 1) {
      const t = along - Math.sqrt(along * along - dot(m, m) + 1);
      const p = sub(m, scale(sun, t));
      const q: V3 = [p[0], p[1] * JUPITER_B, p[2]];
      shadow = [q[0], dot(q, skyY)];
    }
    return {
      x,
      y,
      z,
      inTransit: onDisc && z < 0,
      occulted: onDisc && z > 0,
      eclipsed: along < 0 && perp < 1,
      shadow,
    };
  });
}

function jupiterFrame(jd: number, sys: Jovian) {
  const g = planetGeo('Jupiter', jd);
  const sun = sunDir(jd);
  const rot = rotation('Jupiter', jd);
  const eq = A.PLANET_SD_1AU_ARCSEC.Jupiter! / g.delta;
  const j2000 = A.vecToRaDec(g.geoEq);
  return {
    geo: g,
    frame: {
      distance_au: g.delta,
      light_time_s: g.delta * AU_LIGHT_S,
      equatorial_radius_arcsec: eq,
      polar_radius_arcsec: eq * JUPITER_B,
      pole_position_angle_deg: positionAngle(j2000.ra_deg, j2000.dec_deg, rot.poleRa, rot.poleDec),
      sub_earth_lat_deg: sys.de,
      ra_deg: g.ra_deg,
      dec_deg: g.dec_deg,
      elongation_deg: angleDeg(g.u, sun.u),
    },
  };
}

export function mockGalileanMoons(env: PlanetDetailMockEnv, jdUtc: number): GalileanMoons {
  inside(env, jdUtc, 'galilean_moons');
  const sys = jovian(jdUtc);
  const { frame } = jupiterFrame(jdUtc, sys);
  const pa = frame.pole_position_angle_deg * D2R;
  const rj = frame.equatorial_radius_arcsec;
  const moons: GalileanMoon[] = moonGeometry(sys).map((m, i) => {
    const east = (-m.x * Math.cos(pa) + m.y * Math.sin(pa)) * rj;
    const north = (m.x * Math.sin(pa) + m.y * Math.cos(pa)) * rj;
    return {
      name: MOON_NAMES[i]!,
      x_rj: m.x,
      y_rj: m.y,
      z_rj: m.z,
      offset_east_arcsec: east,
      offset_north_arcsec: north,
      ra_deg: A.norm360(frame.ra_deg + east / ARCSEC / Math.cos(frame.dec_deg * D2R)),
      dec_deg: frame.dec_deg + north / ARCSEC,
      in_front: m.z < 0,
      in_transit: m.inTransit,
      occulted: m.occulted,
      eclipsed: m.eclipsed,
      shadow_on_disc: m.shadow !== null,
      shadow_x_rj: m.shadow ? m.shadow[0] : null,
      shadow_y_rj: m.shadow ? m.shadow[1] : null,
    };
  });
  return {
    jd_utc: jdUtc,
    utc: isoUtc(jdUtc),
    jupiter: frame,
    moons,
    theory: 'MOCK: Meeus chapter 44, low-accuracy method (illustrative)',
    accuracy_arcsec: 5,
  };
}

const PHENOMENA: readonly [GalileanPhenomenonKind, (m: MoonGeometry) => boolean][] = [
  ['transit', (m) => m.inTransit],
  ['shadow_transit', (m) => m.shadow !== null],
  ['occultation', (m) => m.occulted],
  ['eclipse', (m) => m.eclipsed],
];

export function mockGalileanEvents(env: PlanetDetailMockEnv, jdStart: number, jdEnd: number): GalileanEvents {
  const [a, b, truncated] = clip(env, 'galilean_events', jdStart, jdEnd, 400);
  const phenomena: GalileanPhenomenon[] = [];
  if (a < b) {
    const step = 5 / 1440;
    const lo = Math.max(env.start, a - 0.5);
    const hi = Math.min(env.end, b + 0.5);
    const at = (t: number): MoonGeometry[] => moonGeometry(jovian(t));
    const instant = (t: number, observable: boolean): GalileanInstant => ({
      jd_utc: t,
      utc: isoUtc(t),
      observable,
    });
    const n = Math.ceil((hi - lo) / step);
    let prev = at(lo);
    const open = new Map<string, number>();
    for (let k = 1; k <= n; k += 1) {
      const t1 = Math.min(hi, lo + k * step);
      const t0 = lo + (k - 1) * step;
      const cur = at(t1);
      MOON_NAMES.forEach((moon, i) => {
        for (const [kind, test] of PHENOMENA) {
          const was = test(prev[i]!);
          const is = test(cur[i]!);
          if (was === is) continue;
          const edge = bisect((t) => (test(at(t)[i]!) ? 1 : -1), t0, t1);
          const key = `${moon}/${kind}`;
          if (is) {
            open.set(key, edge);
            continue;
          }
          const start = open.get(key);
          open.delete(key);
          if (start === undefined || edge < a || start > b) continue;
          // An eclipse's edges are hidden behind the planet; an occultation's in the shadow.
          const hidden = (t: number): boolean => {
            const g = at(t)[i]!;
            return kind === 'eclipse' ? g.occulted : kind === 'occultation' ? g.eclipsed : false;
          };
          phenomena.push({
            moon,
            kind,
            start: instant(start, !hidden(start)),
            end: instant(edge, !hidden(edge)),
            jupiter_elongation_deg: angleDeg(planetGeo('Jupiter', start).u, sunDir(start).u),
          });
        }
      });
      prev = cur;
    }
  }
  phenomena.sort((x, y) => x.start.jd_utc - y.start.jd_utc);
  return {
    jd_start: a,
    jd_end: b,
    truncated,
    phenomena,
    conventions:
      'MOCK (illustrative). Times when the Earth sees them (UTC). Transits and occultations: the moon\'s centre ' +
      "crossing the limb of Jupiter's oblate disc. Eclipses and shadow transits: the shadow cast by the Sun's centre.",
  };
}

// ---------------------------------------------------------------------------
// Saturn's rings and the planets' discs
// ---------------------------------------------------------------------------

const RING_EDGES_KM: readonly [string, number][] = [
  ['A outer', 136_780],
  ['A inner', 122_340],
  ['B outer', 117_507],
  ['B inner', 91_975],
  ['C inner', 74_658],
];

export function mockSaturnRings(env: PlanetDetailMockEnv, jdUtc: number): SaturnRings {
  inside(env, jdUtc, 'saturn_rings');
  const g = planetGeo('Saturn', jdUtc);
  const rot = rotation('Saturn', jdUtc);
  const toEarth = unit(scale(g.geoEq, -1));
  const toSun = unit(scale(g.helioEq, -1));
  const e = inEquator(rot, toEarth);
  const s = inEquator(rot, toSun);
  const B = e.lat;
  const dU = Math.abs(A.wrap180(s.theta - e.theta));
  const j2000 = A.vecToRaDec(g.geoEq);
  const sinB = Math.abs(Math.sin(B * D2R));
  const axis = (km: number): number => ((2 * km) / (g.delta * A.AU_KM)) * R2D * ARCSEC;
  const aa1984 =
    -8.88 + 5 * Math.log10(g.r * g.delta) + 0.044 * dU - 2.6 * sinB + 1.25 * Math.sin(B * D2R) ** 2;
  return {
    jd_utc: jdUtc,
    utc: isoUtc(jdUtc),
    earth_latitude_deg: B,
    sun_latitude_deg: s.lat,
    delta_u_deg: dU,
    position_angle_deg: positionAngle(j2000.ra_deg, j2000.dec_deg, rot.poleRa, rot.poleDec),
    major_axis_arcsec: axis(RING_EDGES_KM[0]![1]),
    minor_axis_arcsec: axis(RING_EDGES_KM[0]![1]) * sinB,
    edges: RING_EDGES_KM.map(([name, km]) => ({
      name,
      radius_km: km,
      major_axis_arcsec: axis(km),
      minor_axis_arcsec: axis(km) * sinB,
    })),
    north_face_visible: B > 0,
    lit_face_visible: Math.sign(B) === Math.sign(s.lat),
    distance_au: g.delta,
    heliocentric_distance_au: g.r,
    magnitude_aa1984: aa1984,
    magnitude: aa1984,
  };
}

/** Jupiter's System I and II rotation (degrees at J2000 TT, degrees a day). */
const JUPITER_SYSTEMS: readonly [PlanetCentralMeridian['system'], number, number][] = [
  ['I', 67.1, 877.9],
  ['II', 43.3, 870.27],
];

export function mockPlanetDisc(env: PlanetDetailMockEnv, body: string, jdUtc: number): PlanetDisc {
  const name = A.PLANET_NAMES.find((p) => p.toLowerCase() === String(body).trim().toLowerCase());
  if (!name) {
    throw new Error(
      `planet_disc: ${JSON.stringify(body)} is not a planet (Mercury, Venus, Mars, Jupiter, Saturn, Uranus, Neptune)`,
    );
  }
  inside(env, jdUtc, 'planet_disc');
  const g = planetGeo(name, jdUtc);
  const sun = sunDir(jdUtc);
  const rot = rotation(name, jdUtc);
  const row = IAU[name]!;
  const d = jdUtc + TT_MINUS_UTC_S / 86_400 - A.J2000 - g.delta * LT_DAYS_PER_AU;
  const w = row[4] + row[5] * d;
  const east = row[5] < 0;
  const lon = (theta: number, wDeg: number): number => A.norm360(east ? theta - wDeg : wDeg - theta);
  const toEarth = unit(scale(g.geoEq, -1));
  const toSun = unit(scale(g.helioEq, -1));
  const e = inEquator(rot, toEarth);
  const s = inEquator(rot, toSun);
  const f = rot.flattening;
  const eq = (2 * A.PLANET_SD_1AU_ARCSEC[name]!) / g.delta;
  const e2 = 1 - (1 - f) * (1 - f);
  const phase = angleDeg(toEarth, toSun);
  const k = (1 + Math.cos(phase * D2R)) / 2;
  const j2000 = A.vecToRaDec(g.geoEq);
  const central: PlanetCentralMeridian[] =
    name === 'Jupiter'
      ? [
          ...JUPITER_SYSTEMS.map(([system, w0, rate]) => ({ system, longitude_deg: lon(e.theta, w0 + rate * d) })),
          { system: 'III', longitude_deg: lon(e.theta, w) },
        ]
      : [{ system: name === 'Saturn' || name === 'Uranus' ? 'III' : 'IAU', longitude_deg: lon(e.theta, w) }];
  const notes: string[] = [];
  if (name === 'Jupiter') {
    notes.push(
      'The Great Red Spot is not tracked: its System II longitude drifts by tens of degrees a year, irregularly, ' +
        'so no longitude compiled into the site stays right for more than a few months.',
    );
  }
  if (name === 'Venus') notes.push('Venus shows only its clouds; its longitudes are those of the solid surface.');
  if (name === 'Uranus' || name === 'Neptune') notes.push(`${name}'s rotation period is uncertain by seconds a day.`);
  return {
    body: name,
    jd_utc: jdUtc,
    utc: isoUtc(jdUtc),
    distance_au: g.delta,
    light_time_s: g.delta * AU_LIGHT_S,
    equatorial_diameter_arcsec: eq,
    polar_diameter_arcsec: eq * Math.sqrt(1 - e2 * Math.cos(e.lat * D2R) ** 2),
    phase_angle_deg: phase,
    illuminated_fraction: k,
    defect_of_illumination_arcsec: eq * (1 - k),
    bright_limb_angle_deg: A.brightLimbAngle(sun.ra_deg, sun.dec_deg, g.ra_deg, g.dec_deg),
    pole_position_angle_deg: positionAngle(j2000.ra_deg, j2000.dec_deg, rot.poleRa, rot.poleDec),
    sub_earth_lat_deg: e.lat,
    sub_earth_lat_graphic_deg: graphic(e.lat, f),
    sub_earth_lon_deg: lon(e.theta, w),
    sub_solar_lat_deg: s.lat,
    sub_solar_lat_graphic_deg: graphic(s.lat, f),
    sub_solar_lon_deg: lon(s.theta, w),
    longitude_positive: east ? 'east' : 'west',
    central_meridians: central,
    magnitude: A.planetMagnitude(name, g.r, g.delta, phase),
    rotation_model: 'MOCK: IAU 2015 poles and prime meridians without their periodic terms (illustrative)',
    notes,
  };
}

// ---------------------------------------------------------------------------
// Transits of Mercury and Venus
// ---------------------------------------------------------------------------

interface Pair {
  sep: number;
  pa: number;
  east: number;
  north: number;
  sunSd: number;
  planetSd: number;
}

function pair(planet: string, jd: number, p?: Place): Pair {
  const g = planetGeo(planet, jd);
  const s = sunDir(jd);
  let pr = { ra: g.ra_deg, dec: g.dec_deg };
  let sr = { ra: s.ra_deg, dec: s.dec_deg };
  if (p) {
    const tp = topo(p, jd, g.ra_deg, g.dec_deg, g.delta * A.AU_KM);
    const ts = topo(p, jd, s.ra_deg, s.dec_deg, s.dist_au * A.AU_KM);
    pr = { ra: tp.ra_deg, dec: tp.dec_deg };
    sr = { ra: ts.ra_deg, dec: ts.dec_deg };
  }
  const [east, north] = offsetArcsec(sr.ra, sr.dec, pr.ra, pr.dec);
  return {
    sep: A.angleBetween(sr.ra, sr.dec, pr.ra, pr.dec) * ARCSEC,
    pa: positionAngle(sr.ra, sr.dec, pr.ra, pr.dec),
    east,
    north,
    sunSd: SUN_SD_1AU_ARCSEC / s.dist_au,
    planetSd: A.PLANET_SD_1AU_ARCSEC[planet]! / g.delta,
  };
}

/** Contacts around a least separation at `tm`; null when the discs never touch. */
function contacts(
  planet: string,
  tm: number,
  p?: Place,
): { list: [PlanetTransitContactKind, number][]; min: number; grazing: boolean } | null {
  const [t0, min] = minimise((t) => pair(planet, t, p).sep, tm - 0.6, tm + 0.6, 1e-7);
  const at = pair(planet, t0, p);
  if (min > at.sunSd + at.planetSd) return null;
  const outer = (t: number): number => {
    const q = pair(planet, t, p);
    return q.sep - (q.sunSd + q.planetSd);
  };
  const inner = (t: number): number => {
    const q = pair(planet, t, p);
    return q.sep - (q.sunSd - q.planetSd);
  };
  const list: [PlanetTransitContactKind, number][] = [['c1', bisect(outer, t0 - 0.5, t0)]];
  const grazing = min > at.sunSd - at.planetSd;
  if (!grazing) list.push(['c2', bisect(inner, t0 - 0.5, t0)]);
  list.push(['greatest', t0]);
  if (!grazing) list.push(['c3', bisect(inner, t0, t0 + 0.5)]);
  list.push(['c4', bisect(outer, t0, t0 + 0.5)]);
  return { list, min, grazing };
}

function path(planet: string, c1: number, c4: number, p?: Place): PlanetTransitPathPoint[] {
  return Array.from({ length: 25 }, (_, k) => {
    const t = c1 + ((c4 - c1) * k) / 24;
    const q = pair(planet, t, p);
    return { jd_utc: t, east_arcsec: q.east, north_arcsec: q.north };
  });
}

function transitLocal(planet: string, tm: number, observer: Observer): PlanetTransitLocal {
  const p = place(observer);
  const obs = { lat_deg: p.lat, lon_deg: p.lon, height_m: p.height };
  const found = contacts(planet, tm, p);
  if (!found) return { observer: obs, visibility: 'none', events: [], path: [] };
  const sunAt = (t: number) => {
    const s = sunDir(t);
    return topo(p, t, s.ra_deg, s.dec_deg, s.dist_au * A.AU_KM);
  };
  const event = (kind: PlanetTransitLocalEvent['kind'], t: number): PlanetTransitLocalEvent => {
    const s = sunAt(t);
    const q = pair(planet, t, p);
    return {
      kind,
      jd_utc: t,
      utc: isoUtc(t),
      sun_alt_deg: s.alt_deg,
      sun_az_deg: s.az_deg,
      visible: s.alt_deg > RISE_SET_DEG,
      position_angle_deg: q.pa,
      vertex_angle_deg: A.norm360(q.pa - A.parallacticAngle(s.ha_deg, s.dec_deg, p.site)),
      separation_arcsec: q.sep,
    };
  };
  const events = found.list.map(([kind, t]) => event(kind, t));
  const c1 = found.list[0]![1];
  const c4 = found.list[found.list.length - 1]![1];
  const step = 10 / 1440;
  const up = (t: number): number => sunAt(t).alt_deg - RISE_SET_DEG;
  for (let t = c1; t < c4; t += step) {
    const t1 = Math.min(c4, t + step);
    const [u0, u1] = [up(t), up(t1)];
    if (u0 < 0 !== u1 < 0) events.push(event(u1 >= 0 ? 'sunrise' : 'sunset', bisect(up, t, t1)));
  }
  events.sort((x, y) => x.jd_utc - y.jd_utc);
  const seen = events.filter((e) => e.kind !== 'sunrise' && e.kind !== 'sunset').map((e) => e.visible);
  const crossed = events.some((e) => e.kind === 'sunrise' || e.kind === 'sunset');
  const visibility = crossed
    ? 'partly_below_horizon'
    : seen.every(Boolean)
      ? 'visible'
      : seen.some(Boolean)
        ? 'partly_below_horizon'
        : 'below_horizon';
  return { observer: obs, visibility, events, path: path(planet, c1, c4, p) };
}

export function mockTransits(
  env: PlanetDetailMockEnv,
  jdStart: number,
  jdEnd: number,
  observer?: Observer,
): PlanetTransitList {
  const [a, b, truncated] = clip(env, 'transits', jdStart, jdEnd, 1200 * 365.25);
  if (observer !== undefined) place(observer);
  const transits: PlanetTransit[] = [];
  if (a < b) {
    for (const planet of ['Mercury', 'Venus']) {
      const step = planet === 'Mercury' ? 0.5 : 1;
      const lo = Math.max(env.start, a - 1);
      const hi = Math.min(env.end, b + 1);
      const elong = (t: number): number => A.angleBetween(...radec(planetGeo(planet, t)), ...radec(sunDir(t)));
      let e0 = elong(lo);
      let e1 = elong(lo + step);
      for (let t = lo + step; t + step <= hi; t += step) {
        const e2 = elong(t + step);
        if (e1 < e0 && e1 <= e2 && e1 < 2 && planetGeo(planet, t).delta < 1) {
          const found = contacts(planet, t);
          const greatest = found?.list.find(([k]) => k === 'greatest')?.[1];
          if (found && greatest !== undefined && greatest >= a && greatest <= b) {
            const list: PlanetTransitContact[] = found.list.map(([kind, tc]) => {
              const q = pair(planet, tc);
              return {
                kind,
                jd_utc: tc,
                utc: isoUtc(tc),
                jd_tt: tc + TT_MINUS_UTC_S / 86_400,
                position_angle_deg: q.pa,
                separation_arcsec: q.sep,
              };
            });
            const c1 = found.list[0]![1];
            const c4 = found.list[found.list.length - 1]![1];
            const q = pair(planet, greatest);
            transits.push({
              id: `${isoUtc(greatest).slice(0, 10)}-${planet.toLowerCase()}`,
              planet: planet as PlanetTransit['planet'],
              contacts: list,
              min_separation_arcsec: found.min,
              sun_semidiameter_arcsec: q.sunSd,
              planet_semidiameter_arcsec: q.planetSd,
              grazing: found.grazing,
              duration_s: (c4 - c1) * 86_400,
              path: path(planet, c1, c4),
              tt_minus_utc_s: TT_MINUS_UTC_S,
              local: observer === undefined ? null : transitLocal(planet, greatest, observer),
            });
          }
        }
        e0 = e1;
        e1 = e2;
      }
    }
  }
  transits.sort((x, y) => x.contacts[0]!.jd_utc - y.contacts[0]!.jd_utc);
  return {
    jd_start: a,
    jd_end: b,
    truncated,
    coverage_start_utc: isoUtc(env.start),
    coverage_end_utc: isoUtc(env.end),
    transits,
    conventions:
      'MOCK (illustrative). Contacts I and IV: the discs externally tangent; II and III internally tangent; greatest ' +
      "transit: the least separation of the centres. Position angles on the Sun's disc from the north point through " +
      'east (vertex angles from the zenith point).',
  };
}

function radec(x: { ra_deg: number; dec_deg: number }): [number, number] {
  return [x.ra_deg, x.dec_deg];
}

// ---------------------------------------------------------------------------
// Conjunctions and stations
// ---------------------------------------------------------------------------

const DEFAULT_STARS = ['Aldebaran', 'Regulus', 'Spica', 'Antares'];
const OPTION_KEYS = new Set(['planets', 'moon', 'stars', 'max_separation_deg', 'min_sun_elongation_deg', 'observer']);

interface MockBody {
  name: string;
  type: 'moon' | 'planet' | 'star';
  at(jd: number): { ra_deg: number; dec_deg: number; u: V3; distKm: number | null };
  magnitude(jd: number): number | null;
}

function mockBody(name: string, type: MockBody['type']): MockBody {
  if (type === 'moon') {
    return {
      name,
      type,
      at: (jd) => {
        const m = A.moonPosition(jd);
        return { ra_deg: m.ra_deg, dec_deg: m.dec_deg, u: A.unitVector(m.ra_deg, m.dec_deg), distKm: m.dist_km };
      },
      magnitude: (jd) => {
        const m = A.moonPosition(jd);
        const i = 180 - A.angleBetween(m.ra_deg, m.dec_deg, ...radec(sunDir(jd)));
        return -12.73 + 0.026 * Math.abs(i) + 4e-9 * i ** 4;
      },
    };
  }
  if (type === 'planet') {
    return {
      name,
      type,
      at: (jd) => {
        const g = planetGeo(name, jd);
        return { ra_deg: g.ra_deg, dec_deg: g.dec_deg, u: g.u, distKm: g.delta * A.AU_KM };
      },
      magnitude: (jd) => planetMagnitude(name, jd),
    };
  }
  const row = starRow(name)!;
  return { name: row[0], type, at: (jd) => ({ ...starDir(row[0], jd), distKm: null }), magnitude: () => row[4] };
}

export function mockConjunctions(
  env: PlanetDetailMockEnv,
  jdStart: number,
  jdEnd: number,
  options: ConjunctionOptions = {},
): ConjunctionList {
  const o = options ?? {};
  for (const key of Object.keys(o)) {
    if (!OPTION_KEYS.has(key)) throw new Error(`conjunctions options: unknown field \`${key}\``);
  }
  const maxSep = o.max_separation_deg ?? 5;
  const minElong = o.min_sun_elongation_deg ?? 15;
  if (!(maxSep >= 0.1 && maxSep <= 20)) {
    throw new Error(`conjunctions: max_separation_deg must be 0.1 to 20 (got ${maxSep})`);
  }
  const observer = o.observer ? place(o.observer) : null;
  const asked = (o.planets ?? [...A.PLANET_NAMES]).map((n) => {
    const p = A.PLANET_NAMES.find((q) => q.toLowerCase() === String(n).trim().toLowerCase());
    if (!p) throw new Error(`conjunctions: ${JSON.stringify(n)} is not a planet (Mercury..Neptune)`);
    return p;
  });
  // In the Sun-outward order whatever the request's, so `body` is the inner planet.
  const planets = A.PLANET_NAMES.filter((p) => asked.includes(p));
  const stars: string[] = [];
  for (const n of o.stars ?? DEFAULT_STARS) {
    const row = starRow(n);
    if (!row) throw new Error(`conjunctions: ${JSON.stringify(n)} is not a navigational star`);
    if (!stars.includes(row[0])) stars.push(row[0]);
  }
  const bodies: MockBody[] = [
    ...(o.moon === false ? [] : [mockBody('Moon', 'moon')]),
    ...planets.map((p) => mockBody(p, 'planet')),
    ...stars.map((s) => mockBody(s, 'star')),
  ];
  const [a, b, truncated] = clip(env, 'conjunctions', jdStart, jdEnd, 3660);
  const out: Conjunction[] = [];
  if (a < b) {
    const lo = Math.max(env.start, a - 2);
    const hi = Math.min(env.end, b + 2);
    const step = 0.25;
    const n = Math.ceil((hi - lo) / step);
    const times = Array.from({ length: n + 1 }, (_, k) => lo + ((hi - lo) * k) / n);
    const dirs = bodies.map((body) => times.map((t) => body.at(t).u));
    for (let i = 0; i < bodies.length; i += 1) {
      for (let j = i + 1; j < bodies.length; j += 1) {
        const [bi, bj] = [bodies[i]!, bodies[j]!];
        if (bi.type === 'star' && bj.type === 'star') continue;
        const kind: ConjunctionKind =
          bi.type === 'moon'
            ? bj.type === 'planet'
              ? 'moon_planet'
              : 'moon_star'
            : bj.type === 'planet'
              ? 'planet_planet'
              : 'planet_star';
        const s = times.map((_, k) => angleDeg(dirs[i]![k]!, dirs[j]![k]!));
        const sep = (t: number): number => angleDeg(bi.at(t).u, bj.at(t).u);
        for (let k = 1; k < n; k += 1) {
          if (!(s[k]! < s[k - 1]! && s[k]! <= s[k + 1]! && s[k]! < maxSep + 1)) continue;
          const [t, v] = minimise(sep, times[k - 1]!, times[k + 1]!, 1e-6);
          if (t < a || t > b || v > maxSep) continue;
          out.push(conjunction(bi, bj, kind, t, minElong, observer));
        }
      }
    }
  }
  out.sort((x, y) => x.jd_utc - y.jd_utc);
  return {
    jd_start: a,
    jd_end: b,
    truncated,
    coverage_start_utc: isoUtc(env.start),
    coverage_end_utc: isoUtc(env.end),
    conjunctions: out,
  };
}

function conjunction(
  bi: MockBody,
  bj: MockBody,
  kind: ConjunctionKind,
  t: number,
  minElong: number,
  observer: Place | null,
): Conjunction {
  const pb = bi.at(t);
  const po = bj.at(t);
  const sun = sunDir(t);
  const eb = angleDeg(pb.u, sun.u);
  const eo = angleDeg(po.u, sun.u);
  let local: ConjunctionLocal | null = null;
  if (observer) {
    const alts = (tk: number): [number, number, number] => {
      const x = bi.at(tk);
      const y = bj.at(tk);
      const s = sunDir(tk);
      return [
        apparentAlt(observer, topo(observer, tk, x.ra_deg, x.dec_deg, x.distKm).alt_deg),
        apparentAlt(observer, topo(observer, tk, y.ra_deg, y.dec_deg, y.distKm).alt_deg),
        topo(observer, tk, s.ra_deg, s.dec_deg, s.dist_au * A.AU_KM).alt_deg,
      ];
    };
    let best: ConjunctionView | null = null;
    // Half-hour steps (the real engine's are 15 minutes).
    for (let k = 0; k <= 48; k += 1) {
      const tk = t - 0.5 + k / 48;
      const [hb, ho, hs] = alts(tk);
      if (hs > -6 || Math.min(hb, ho) <= 0) continue;
      if (!best || Math.min(hb, ho) > Math.min(best.body_alt_deg, best.other_alt_deg)) {
        best = { jd_utc: tk, utc: isoUtc(tk), body_alt_deg: hb, other_alt_deg: ho, sun_alt_deg: hs };
      }
    }
    const [hb, ho, hs] = alts(t);
    local = { body_alt_deg: hb, other_alt_deg: ho, sun_alt_deg: hs, best };
  }
  return {
    kind,
    body: bi.name,
    other: bj.name,
    jd_utc: t,
    utc: isoUtc(t),
    separation_deg: angleDeg(pb.u, po.u),
    position_angle_deg: positionAngle(po.ra_deg, po.dec_deg, pb.ra_deg, pb.dec_deg),
    ra_deg: pb.ra_deg,
    dec_deg: pb.dec_deg,
    body_elongation_deg: eb,
    other_elongation_deg: eo,
    body_magnitude: bi.magnitude(t),
    other_magnitude: bj.magnitude(t),
    visible: eb >= minElong && eo >= minElong,
    local,
  };
}

function longitudeOfDate(name: string, jd: number, ecliptic: boolean): number {
  const g = planetGeo(name, jd);
  if (!ecliptic) return g.ra_deg;
  return A.equatorialToEcliptic(g.ra_deg, g.dec_deg, A.obliquityDeg(A.centuriesTT(jd))).lon_deg;
}

export function mockStations(env: PlanetDetailMockEnv, jdStart: number, jdEnd: number): PlanetStationList {
  const [a, b, truncated] = clip(env, 'stations', jdStart, jdEnd, 29_220);
  const stations: PlanetStation[] = [];
  if (a < b) {
    for (const name of A.PLANET_NAMES) {
      for (const coordinate of ['ecliptic_longitude', 'right_ascension'] as PlanetStationCoordinate[]) {
        const ecl = coordinate === 'ecliptic_longitude';
        const rate = (t: number): number =>
          A.wrap180(longitudeOfDate(name, t + 0.05, ecl) - longitudeOfDate(name, t - 0.05, ecl)) / 0.1;
        const step = name === 'Mercury' ? 2 : 4;
        let t0 = a;
        let r0 = rate(t0);
        while (t0 < b) {
          const t1 = Math.min(b, t0 + step);
          const r1 = rate(t1);
          if (r0 < 0 !== r1 < 0) {
            const t = bisect(rate, t0, t1, 1e-5);
            const g = planetGeo(name, t);
            const sun = sunDir(t);
            stations.push({
              body: name,
              kind: r1 < 0 ? 'retrograde_begins' : 'retrograde_ends',
              coordinate,
              jd_utc: t,
              utc: isoUtc(t),
              angle_deg: longitudeOfDate(name, t, ecl),
              ra_deg: g.ra_deg,
              dec_deg: g.dec_deg,
              ecliptic_longitude_deg: longitudeOfDate(name, t, true),
              elongation_deg: angleDeg(g.u, sun.u),
              magnitude: planetMagnitude(name, t),
            });
          }
          t0 = t1;
          r0 = r1;
        }
      }
    }
  }
  stations.sort((x, y) => x.jd_utc - y.jd_utc);
  return {
    jd_start: a,
    jd_end: b,
    truncated,
    coverage_start_utc: isoUtc(env.start),
    coverage_end_utc: isoUtc(env.end),
    stations,
    ui_coordinate: 'ecliptic_longitude',
  };
}

export function mockEarthApsides(env: PlanetDetailMockEnv, year: number): EarthApsides {
  if (!Number.isInteger(year)) throw new Error(`earth_apsides: year must be a whole number (got ${year})`);
  const start = Date.UTC(year, 0, 1) / 86_400_000 + 2_440_587.5;
  const end = Date.UTC(year + 1, 0, 1) / 86_400_000 + 2_440_587.5;
  if (start < env.start || end > env.end) {
    throw new Error(
      `earth_apsides: ${year} is outside the coverage window (${isoUtc(env.start)} to ${isoUtc(env.end)})`,
    );
  }
  const r = (t: number): number => A.sunPosition(t).dist_au;
  const events: EarthApsisEvent[] = [];
  for (let t = start - 1; t < end + 1; t += 1) {
    const [r0, r1, r2] = [r(t), r(t + 1), r(t + 2)];
    const kind = r1 < r0 && r1 <= r2 ? 'perihelion' : r1 > r0 && r1 >= r2 ? 'aphelion' : null;
    if (!kind) continue;
    const [tm, v] = minimise((x) => (kind === 'perihelion' ? r(x) : -r(x)), t, t + 2, 1e-6);
    if (tm < start || tm >= end) continue;
    const au = Math.abs(v);
    events.push({ kind, jd_utc: tm, utc: isoUtc(tm), distance_au: au, distance_km: au * A.AU_KM });
  }
  return { year, events };
}

// ---------------------------------------------------------------------------
// Orbits
// ---------------------------------------------------------------------------

const PACKED_CENTURY: Record<string, number> = { I: 1800, J: 1900, K: 2000 };

function unpackDigit(c: string): number {
  const code = c.charCodeAt(0);
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 65 && code <= 90) return code - 55;
  return code - 61;
}

/** `K2555` -> TT Julian date of 2025 May 5.0. */
function unpackEpoch(p: string): number {
  const century = PACKED_CENTURY[p[0] ?? ''];
  if (century === undefined || p.length < 5) throw new Error(`orbits: bad packed epoch ${JSON.stringify(p)}`);
  const y = century + Number(p.slice(1, 3));
  const m = unpackDigit(p[3]!);
  const d = unpackDigit(p[4]!);
  return Date.UTC(y, m - 1, d) / 86_400_000 + 2_440_587.5;
}

function num(line: string, from: number, to: number, what: string): number {
  const v = Number(line.slice(from - 1, to).trim());
  if (!Number.isFinite(v) || line.slice(from - 1, to).trim() === '') {
    throw new Error(`orbits: ${what} unreadable in ${JSON.stringify(line.trim().slice(0, 40))}`);
  }
  return v;
}

function hgOrNone(h: number | undefined, g: number | undefined): OrbitMagnitudeModel {
  return h === undefined ? { model: 'none' } : { model: 'hg', h, g: g ?? 0.15 };
}

function mpcorbLine(line: string): OrbitalElements {
  const a = num(line, 93, 103, 'a');
  const e = num(line, 71, 79, 'e');
  const n = num(line, 81, 91, 'n');
  const m = num(line, 27, 35, 'M');
  const epoch = unpackEpoch(line.slice(20, 25).trim());
  const h = line.slice(8, 13).trim();
  const g = line.slice(14, 19).trim();
  const readable = line.slice(166, 194).trim();
  return {
    name: readable || line.slice(0, 7).trim(),
    designation: line.slice(0, 7).trim(),
    class: 'asteroid',
    epoch_jd_tt: epoch,
    perihelion_distance_au: a * (1 - e),
    eccentricity: e,
    inclination_deg: num(line, 60, 68, 'i'),
    ascending_node_deg: num(line, 49, 57, 'node'),
    argument_of_perihelion_deg: num(line, 38, 46, 'peri'),
    perihelion_jd_tt: epoch - A.wrap180(m) / n,
    magnitude: hgOrNone(h ? Number(h) : undefined, g ? Number(g) : undefined),
    source: 'mpcorb',
  };
}

function cometLine(line: string): OrbitalElements {
  const y = num(line, 15, 18, 'perihelion year');
  const mo = num(line, 20, 21, 'perihelion month');
  const day = num(line, 23, 29, 'perihelion day');
  const epochText = line.slice(81, 89).trim();
  const m1 = line.slice(91, 95).trim();
  const k = line.slice(96, 100).trim();
  const number = line.slice(0, 5).trim();
  const provisional = line.slice(5, 12).trim();
  return {
    name: line.slice(102, 158).trim() || number || provisional,
    designation: number || provisional || null,
    class: 'comet',
    epoch_jd_tt: epochText
      ? Date.UTC(Number(epochText.slice(0, 4)), Number(epochText.slice(4, 6)) - 1, Number(epochText.slice(6, 8))) /
          86_400_000 +
        2_440_587.5
      : null,
    perihelion_distance_au: num(line, 31, 39, 'q'),
    eccentricity: num(line, 42, 49, 'e'),
    inclination_deg: num(line, 72, 79, 'i'),
    ascending_node_deg: num(line, 62, 69, 'node'),
    argument_of_perihelion_deg: num(line, 52, 59, 'peri'),
    perihelion_jd_tt: Date.UTC(y, mo - 1, 1) / 86_400_000 + 2_440_587.5 + day - 1,
    magnitude: m1 ? { model: 'comet', m1: Number(m1), k1: k ? 2.5 * Number(k) : 10 } : { model: 'none' },
    source: 'mpc_comet',
  };
}

function manual(m: Record<string, unknown>): OrbitalElements {
  const allowed = new Set([
    'name', 'class', 'epoch_jd_tt', 'epoch_tt', 'q_au', 'a_au', 'e', 'i_deg', 'node_deg', 'peri_deg', 'tp_jd_tt',
    'tp_tt', 'mean_anomaly_deg', 'h', 'g', 'm1', 'k1',
  ]);
  for (const key of Object.keys(m)) if (!allowed.has(key)) throw new Error(`elements JSON: unknown field \`${key}\``);
  const n = (key: string): number | undefined => {
    const v = m[key];
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`orbits: ${key} must be a number`);
    return v;
  };
  // RFC 3339 with its `Z`, read on the TT scale (as the real engine reads it).
  const tt = (key: string): number | undefined => {
    const v = m[key];
    if (v === undefined || v === null) return undefined;
    const t = typeof v === 'string' ? jdFromIso(v) : null;
    if (t === null) throw new Error(`${key}: ${JSON.stringify(v)} is not an RFC 3339 time`);
    return t;
  };
  const e = n('e');
  const i = n('i_deg');
  const node = n('node_deg');
  const peri = n('peri_deg');
  if (typeof m.name !== 'string' || e === undefined || i === undefined || node === undefined || peri === undefined) {
    throw new Error('orbits: manual elements need name, e, i_deg, node_deg and peri_deg');
  }
  const aAu = n('a_au');
  const q = n('q_au') ?? (aAu !== undefined ? aAu * (1 - e) : undefined);
  if (q === undefined || !(q > 0) || e < 0) throw new Error('orbits: give q_au, or a_au with e < 1');
  const epoch = n('epoch_jd_tt') ?? tt('epoch_tt') ?? null;
  let tp = n('tp_jd_tt') ?? tt('tp_tt');
  const mean = n('mean_anomaly_deg');
  if (tp === undefined && mean !== undefined && epoch !== null && e < 1) {
    const a = q / (1 - e);
    tp = epoch - (A.wrap180(mean) * D2R) / (GAUSS_K / a ** 1.5);
  }
  if (tp === undefined) throw new Error('orbits: give the perihelion time, or a mean anomaly and an epoch');
  const cometLike = m.class === 'comet' || (m.class === undefined && n('m1') !== undefined);
  const cls: OrbitClass = cometLike ? 'comet' : 'asteroid';
  const m1 = n('m1');
  return {
    name: m.name,
    designation: null,
    class: cls,
    epoch_jd_tt: epoch,
    perihelion_distance_au: q,
    eccentricity: e,
    inclination_deg: i,
    ascending_node_deg: node,
    argument_of_perihelion_deg: peri,
    perihelion_jd_tt: tp,
    magnitude: m1 !== undefined ? { model: 'comet', m1, k1: n('k1') ?? 10 } : hgOrNone(n('h'), n('g')),
    source: 'manual',
  };
}

function elementsOf(x: CustomBodyInput): OrbitalElements {
  return 'perihelion_distance_au' in x ? x : manual(x as unknown as Record<string, unknown>);
}

export function mockParseOrbits(text: string): OrbitalElements[] {
  const t = String(text ?? '').trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch (error) {
      throw new Error(`elements JSON: ${(error as Error).message}`);
    }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((x) => elementsOf(x as CustomBodyInput));
  }
  const out: OrbitalElements[] = [];
  for (const line of t.split(/\r?\n/)) {
    // Headers and blank lines: the MPC's lines are over 100 characters, their headers shorter.
    if (line.trim().length < 100 || line.startsWith('-')) continue;
    // A comet line has its orbit type in column 5 and the perihelion year in columns 15-18.
    const comet = /^[CPDXIA]$/.test(line[4] ?? '') && /^\d{4}$/.test(line.slice(14, 18));
    out.push(comet ? cometLine(line) : mpcorbLine(line));
  }
  if (out.length === 0) throw new Error('no orbital elements found');
  return out;
}

/** Heliocentric J2000 ecliptic position, AU, `dt` days after perihelion. */
function heliocentricOrbit(el: OrbitalElements, dt: number): V3 {
  const q = el.perihelion_distance_au;
  const e = el.eccentricity;
  let nu: number;
  let r: number;
  if (Math.abs(e - 1) < 1e-6) {
    const w = (3 * GAUSS_K * dt) / Math.sqrt(2 * q ** 3);
    const y = Math.cbrt(w + Math.sqrt(w * w + 1));
    const s = y - 1 / y;
    nu = 2 * Math.atan(s);
    r = q * (1 + s * s);
  } else if (e < 1) {
    const a = q / (1 - e);
    const m = (GAUSS_K / a ** 1.5) * dt;
    const mm = Math.atan2(Math.sin(m), Math.cos(m));
    let E = e < 0.8 ? mm : Math.PI * Math.sign(mm || 1);
    for (let k = 0; k < 50; k += 1) E -= (E - e * Math.sin(E) - mm) / (1 - e * Math.cos(E));
    nu = 2 * Math.atan2(Math.sqrt(1 + e) * Math.sin(E / 2), Math.sqrt(1 - e) * Math.cos(E / 2));
    r = a * (1 - e * Math.cos(E));
  } else {
    const a = q / (e - 1);
    const m = (GAUSS_K / a ** 1.5) * dt;
    let H = Math.asinh(m / e);
    for (let k = 0; k < 60; k += 1) H -= (e * Math.sinh(H) - H - m) / (e * Math.cosh(H) - 1);
    nu = 2 * Math.atan(Math.sqrt((e + 1) / (e - 1)) * Math.tanh(H / 2));
    r = a * (e * Math.cosh(H) - 1);
  }
  const w = el.argument_of_perihelion_deg * D2R;
  const om = el.ascending_node_deg * D2R;
  const inc = el.inclination_deg * D2R;
  const u = w + nu;
  return [
    r * (Math.cos(om) * Math.cos(u) - Math.sin(om) * Math.sin(u) * Math.cos(inc)),
    r * (Math.sin(om) * Math.cos(u) + Math.cos(om) * Math.sin(u) * Math.cos(inc)),
    r * Math.sin(u) * Math.sin(inc),
  ];
}

function customState(env: PlanetDetailMockEnv, el: OrbitalElements, p: Place, jd: number): CustomBodyState {
  inside(env, jd, el.name);
  const t0 = jd + TT_MINUS_UTC_S / 86_400;
  const g = geoFrom((t) => heliocentricOrbit(el, t * 36_525 + A.J2000 - el.perihelion_jd_tt), jd);
  const sun = sunDir(jd);
  const phase = phaseAngleDeg(g.r, g.delta, sun.dist_au);
  const mag = el.magnitude;
  let magnitude: number | null = null;
  if (mag.model === 'hg') {
    const tanHalf = Math.tan((phase * D2R) / 2);
    const phi1 = Math.exp(-3.33 * tanHalf ** 0.63);
    const phi2 = Math.exp(-1.87 * tanHalf ** 1.22);
    magnitude = mag.h + 5 * Math.log10(g.r * g.delta) - 2.5 * Math.log10((1 - mag.g) * phi1 + mag.g * phi2);
  } else if (mag.model === 'comet') {
    magnitude = mag.m1 + 5 * Math.log10(g.delta) + mag.k1 * Math.log10(g.r);
  }
  const t = topo(p, jd, g.ra_deg, g.dec_deg, g.delta * A.AU_KM);
  const gha = A.norm360(A.gmstDeg(jd) - g.ra_deg);
  const lha = A.norm360(gha + p.lon);
  const { hc_deg, zn_deg } = A.sightReduction(p.lat, g.dec_deg, lha);
  const altApparent = apparentAlt(p, t.alt_deg);
  const reference = el.epoch_jd_tt ?? el.perihelion_jd_tt;
  const age = t0 - reference;
  const warnings: string[] = [];
  if (Math.abs(age) > 30) {
    warnings.push(
      `The elements are ${Math.round(Math.abs(age))} days from their epoch; ` +
        'unperturbed orbits drift within weeks to months.',
    );
  }
  return {
    body: el.name,
    kind: el.class,
    custom: true,
    gha_deg: gha,
    dec_deg: g.dec_deg,
    sha_deg: A.norm360(360 - g.ra_deg),
    ra_deg: g.ra_deg,
    gp: { lat_deg: g.dec_deg, lon_deg: A.wrap180(-gha) },
    alt_deg: t.alt_deg,
    az_deg: t.az_deg,
    alt_apparent_deg: altApparent,
    hc_deg,
    zn_deg,
    above_horizon: altApparent > 0,
    distance_km: g.delta * A.AU_KM,
    semidiameter_arcmin: 0,
    horizontal_parallax_arcmin: Math.asin(A.EARTH_RADIUS_KM / (g.delta * A.AU_KM)) * R2D * 60,
    magnitude,
    phase_angle_deg: phase,
    // A point of light: no disc, so no illuminated fraction or bright limb (as the real engine).
    illuminated_fraction: null,
    elongation_deg: angleDeg(g.u, sun.u),
    bright_limb_angle_deg: null,
    parallactic_angle_deg: A.parallacticAngle(t.ha_deg, t.dec_deg, p.site),
    constellation: env.constellationAt(g.ra_deg, g.dec_deg, jd),
    distance_au: g.delta,
    heliocentric_distance_au: g.r,
    elements_age_days: age,
    warnings,
  };
}

export function mockCustomBodyStates(
  env: PlanetDetailMockEnv,
  observer: Observer,
  jdUtc: number,
  bodies: CustomBodyInput[],
): CustomBodyStates {
  const p = place(observer);
  finite(jdUtc, 'jd_utc');
  const list = (bodies ?? []).map(elementsOf);
  const out: CustomBodyStates = { jd_utc: jdUtc, utc: isoUtc(jdUtc), bodies: [], errors: [] };
  for (const el of list) {
    try {
      out.bodies.push(customState(env, el, p, jdUtc));
    } catch (error) {
      out.errors.push({ body: el.name, message: (error as Error).message });
    }
  }
  return out;
}

export function mockSampleCustomBodies(
  env: PlanetDetailMockEnv,
  observer: Observer,
  bodies: CustomBodyInput[],
  jdStart: number,
  jdEnd: number,
  stepMinutes: number,
): Sampled {
  const p = place(observer);
  const list = (bodies ?? []).map(elementsOf);
  if (!(Number.isFinite(jdStart) && Number.isFinite(jdEnd) && jdEnd >= jdStart) || !(stepMinutes > 0)) {
    throw new Error('sample_custom_bodies needs jd_end >= jd_start and step_minutes > 0');
  }
  const step = stepMinutes / 1440;
  const n = Math.floor((jdEnd - jdStart) / step + 1e-9) + 1;
  if (n > 5000) throw new Error(`sample_custom_bodies: ${n} samples asked for; at most 5000 per body`);
  const times = Float64Array.from({ length: n }, (_, k) => jdStart + step * k);
  const out: SampledBody[] = [];
  const errors: Sampled['errors'] = [];
  for (const el of list) {
    const s: SampledBody = {
      body: el.name,
      alt_deg: new Float64Array(n),
      alt_apparent_deg: new Float64Array(n),
      az_deg: new Float64Array(n),
      gha_deg: new Float64Array(n),
      dec_deg: new Float64Array(n),
    };
    try {
      times.forEach((t, k) => {
        const c = customState(env, el, p, t);
        s.alt_deg[k] = c.alt_deg;
        s.alt_apparent_deg[k] = c.alt_apparent_deg;
        s.az_deg[k] = c.az_deg;
        s.gha_deg[k] = c.gha_deg;
        s.dec_deg[k] = c.dec_deg;
      });
      out.push(s);
    } catch (error) {
      errors.push({ body: el.name, message: (error as Error).message });
    }
  }
  return { jd_utc: times, bodies: out, errors };
}
