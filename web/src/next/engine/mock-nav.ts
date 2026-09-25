/**
 * MOCK NAVIGATION TOOLS — for developing the Navigate view only (`?engine=mock`, or a
 * development server with no complete WebAssembly build). Never a source of results
 * (EXPLORER_PLAN section 3.1): every number is illustrative, and the page says so while
 * the mock runs. OWNER: navigate agent.
 *
 * It implements `NavEngine` and `NavSkyEngine` with the contract's shapes, ranges and
 * failure modes (one body for a noon run, a DR required, Mercury/Uranus/Neptune refused,
 * a Moon sight without horizontal parallax refused, a lunar distance to the Moon refused,
 * at most 7 days for a plan), and `createMockSessionApi` gives the Navigate view a
 * `SkyfixApi` (parse, reduce, solve, circle points, planner) that reduces body-first
 * sights with these directions. What it computes, and how simply:
 *
 * - directions: the mock explorer engine's low-precision astronomy (`mock/astro.ts`);
 * - corrections: CONVENTIONS section 5 in TypeScript (Moon augmentation and the planets'
 *   parallax included), the same six steps the core records;
 * - noon sight: a weighted parabola through the run (the core fits the exact curve);
 * - Polaris: the rigorous latitude on the DR meridian; the Almanac a0/a1/a2 with this
 *   instant's Polaris instead of the year's mean position;
 * - averaging: the predicted shape at the DR plus one fitted level, as the core does;
 * - running fix: each line of position advanced by `run · cos(Zn − course)`, then the old
 *   mock adapter's least squares (the core rotates the sphere instead);
 * - lunar distance: Borda's clearing on a sphere (the core clears on the WGS84 ellipsoid);
 * - tonight's sights: nautical twilight from the mock's day events, the brightness rule of
 *   docs/NAVIGATION_SKY.md section 5, and the best azimuth spread with a shared bias.
 */

import type {
  CoverageReport,
  EphemerisMode as ApiEphemerisMode,
  ParsedSession,
  Plan,
  PlanMetrics,
  PlannedBody,
  PlanOptions,
  ReduceEntry,
  SkyfixApi,
} from '../../api/adapter.js';
import { eigen2, MockApi } from '../../api/mock.js';
import { dipArcmin, refractionArcmin } from '../../corrections.js';
import {
  altitudeAzimuthDeg,
  circleOfPosition,
  destination,
  geographicPosition,
  norm180Deg,
  norm360,
  pointFromDeg,
  pointToLatLon,
  twoCircleIntersections,
} from '../../geometry.js';
import type {
  AltitudeKind,
  CorrectionBreakdown,
  CorrectionStep,
  ErrorEllipse,
  FixResult,
  GeocentricDirection,
  HorizonMode,
  LatLon,
  Limb,
  Observation,
  ReducedSight,
  Residual,
  Session,
  SolveOptions,
  Warning,
} from '../../types.js';
import { CHI2_95_2DOF, NM_M } from '../../types.js';
import { isoUtc, jdFromIso } from '../time.js';
import type {
  AveragedSight,
  AveragingOptions,
  CurvePoint,
  DrPosition,
  EphemerisMode,
  ExplorerEngine,
  LunarAltitudeObservation,
  LunarClearingStep,
  LunarDistanceInput,
  LunarDistanceResult,
  LunarErrorTerm,
  MeridianSide,
  NoonSightOptions,
  NoonSightResult,
  PolarisOptions,
  PolarisResult,
  PolarisSight,
  PredictedSight,
  RecommendedSight,
  RunningFixOutput,
  RunningFixRequest,
  RunResidual,
  SigmaInflationReport,
  SightBodyInfo,
  SightInstrument,
  SightLimb,
  SightObserver,
  SightPlan,
  SightPlanMetrics,
  SightPlannedBody,
  SightWarning,
  TwilightPlan,
} from './types.js';
import type { NavTools } from './wasm-nav.js';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const MIN_PER_DAY = 1440;
const S_PER_DAY = 86_400;
const MOCK_SOURCE = 'MOCK (low-precision formulas, illustrative)';
const NOT_OFFERED = new Set(['Mercury', 'Uranus', 'Neptune']);
const PLANETS = new Set(['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']);
const MOCK_NOTE: Warning = {
  code: 'other',
  message: 'MOCK engine: illustrative numbers from low-precision formulas, not the SkyFix Lab core.',
};

type BodyClass = 'sun' | 'moon' | 'planet' | 'star';

function bodyClass(name: string): BodyClass {
  const n = name.trim().toLowerCase();
  if (n === 'sun') return 'sun';
  if (n === 'moon') return 'moon';
  for (const p of PLANETS) if (p.toLowerCase() === n) return 'planet';
  return 'star';
}

/**
 * The Moon's Earth-shape term, arcminutes (CONVENTIONS 15.4): the altitude a perfect Moon
 * sight reduces to on the WGS84 Earth minus the sphere's Hc, at geodetic `latDeg`,
 * `lonDeg` (east). The same geometry as `skyfix_core::sights::wgs84::EarthShape`; 0
 * without a horizontal parallax.
 */
export function mockEarthShapeArcmin(latDeg: number, lonDeg: number, ghaDeg: number, decDeg: number, hpArcmin: number): number {
  if (!(hpArcmin > 0)) return 0;
  const a = 6378.137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const sphi = Math.sin(latDeg * D2R);
  const cphi = Math.cos(latDeg * D2R);
  const sdec = Math.sin(decDeg * D2R);
  const cdec = Math.cos(decDeg * D2R);
  const lha = (ghaDeg + lonDeg) * D2R;
  const up = sphi * sdec + cphi * cdec * Math.cos(lha);
  const north = cphi * sdec - sphi * cdec * Math.cos(lha);
  const east = -cdec * Math.sin(lha);
  const sinHp = Math.sin((hpArcmin / 60) * D2R);
  const k = sinHp / 6378.14;
  const w = Math.sqrt(1 - e2 * sphi * sphi);
  const upT = up - k * a * w;
  const northT = north + k * (a / w) * e2 * sphi * cphi;
  const horizontalT = Math.hypot(northT, east);
  const hT = Math.atan2(upT, horizontalT);
  const parallax = Math.asin(sinHp * (horizontalT / Math.hypot(upT, horizontalT)));
  return (hT - Math.atan2(up, Math.hypot(north, east)) + parallax) * R2D * 60;
}

function wrap180(x: number): number {
  return norm180Deg(x);
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / Math.max(xs.length, 1);
}

function signed(v: number, digits = 3): string {
  return `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(digits)}`;
}

function jdOf(utc: string, what: string): number {
  const jd = jdFromIso(utc);
  if (jd === null) throw new Error(`${what}: ${JSON.stringify(utc)} is not RFC 3339 UTC with a trailing Z`);
  return jd;
}

// ---------------------------------------------------------------------------------------
// Directions and the correction chain
// ---------------------------------------------------------------------------------------

/** The mock's canonical spelling of a body, or a thrown "unknown body". */
function canonical(engine: ExplorerEngine, body: string): string {
  const key = body.trim().toLowerCase();
  const hit = engine.bodies().find((b) => b.body.toLowerCase() === key);
  if (!hit) throw new Error(`unknown body ${JSON.stringify(body)}`);
  return hit.body;
}

/** Apparent geocentric direction of a body at an instant (the mock's astronomy). */
export function mockDirection(engine: ExplorerEngine, body: string, jd: number): GeocentricDirection {
  const name = canonical(engine, body);
  if (NOT_OFFERED.has(name)) {
    throw new Error(`${name} is not offered for sights (CONVENTIONS 13.1): only the Sun, the Moon, Venus, Mars, Jupiter, Saturn and the navigational stars are`);
  }
  const state = engine.skyState({ lat_deg: 0, lon_deg: 0 }, jd, [name]);
  const b = state.bodies[0];
  if (!b) throw new Error(state.errors[0]?.message ?? `no direction for ${name}`);
  return {
    gha_deg: b.gha_deg,
    dec_deg: b.dec_deg,
    semidiameter_arcmin: b.semidiameter_arcmin,
    horizontal_parallax_arcmin: b.horizontal_parallax_arcmin,
  };
}

/** GHA rate from the direction track (CONVENTIONS 13.1): degrees per minute. */
function ghaRateDegPerMin(dir: (jd: number) => GeocentricDirection, jd: number): number {
  const h = 60 / S_PER_DAY;
  const a = dir(jd - h).gha_deg;
  const b = dir(jd + h).gha_deg;
  return wrap180(b - a) / 2;
}

export interface ChainParams {
  id: string;
  body: string;
  kind: AltitudeKind;
  altitude_deg: number;
  sigma_arcmin: number;
  limb: Limb;
  horizon: HorizonMode;
  index_correction_arcmin: number;
  height_of_eye_m: number;
  pressure_hpa: number;
  temperature_c: number;
  semidiameter_arcmin: number;
  horizontal_parallax_arcmin: number;
}

function step(kind: CorrectionStep['kind'], applied: boolean, before: number, after: number, note: string): CorrectionStep {
  return { kind, applied, before_deg: before, after_deg: after, delta_arcmin: (after - before) * 60, note };
}

/**
 * CONVENTIONS section 5 for the mock: the six steps, each recorded as applied or not,
 * only after the declared altitude kind. Throws as the core does for an apparent altitude
 * below the horizon and for a Moon sight without horizontal parallax.
 */
export function mockChain(p: ChainParams): CorrectionBreakdown {
  const cls = bodyClass(p.body);
  const raw = p.kind === 'sextant_hs';
  const apparent = p.kind !== 'observed_ho';
  const steps: CorrectionStep[] = [];
  const warnings: Warning[] = [];
  const skipKind = `not applicable: altitude supplied as ${p.kind}`;
  let h = p.altitude_deg;
  let sigma = p.sigma_arcmin;

  if (raw) {
    const after = h + p.index_correction_arcmin / 60;
    steps.push(step('index_correction', true, h, after, `index correction ${signed(p.index_correction_arcmin)}' added to the sextant reading`));
    h = after;
  } else steps.push(step('index_correction', false, h, h, skipKind));

  if (raw && p.horizon === 'sea') {
    const dip = dipArcmin(p.height_of_eye_m);
    const after = h - dip / 60;
    steps.push(step('dip', true, h, after, `sea horizon, height of eye ${p.height_of_eye_m.toFixed(3)} m: dip ${dip.toFixed(3)}' subtracted`));
    h = after;
  } else {
    const note = !raw
      ? skipKind
      : p.horizon === 'artificial_reflected'
        ? 'not applicable: a reflected artificial horizon has no dip'
        : 'not applicable: an electronic local vertical has no dip';
    steps.push(step('dip', false, h, h, note));
    if (raw && p.horizon !== 'sea') warnings.push({ code: 'dip_not_applicable', id: p.id, horizon: p.horizon });
  }

  if (raw && p.horizon === 'artificial_reflected') {
    const after = h / 2;
    steps.push(step('artificial_horizon_halving', true, h, after, 'reflected artificial horizon: the double angle halved after the index correction'));
    h = after;
    sigma /= 2;
  } else {
    steps.push(step('artificial_horizon_halving', false, h, h, raw ? `not applicable: the ${p.horizon === 'sea' ? 'sea horizon' : 'electronic vertical'} reading is a single angle` : skipKind));
  }

  const ha = h;
  if (apparent) {
    if (ha < 0) {
      throw new Error(`observation ${p.id}: apparent altitude ${ha.toFixed(4)} deg is below the horizon, where the refraction model does not apply`);
    }
    const r = refractionArcmin(ha, p.pressure_hpa, p.temperature_c);
    const after = h - r / 60;
    steps.push(step('refraction', true, h, after, `Bennett 1982 at Ha ${ha.toFixed(4)} deg, ${p.pressure_hpa.toFixed(1)} hPa, ${p.temperature_c.toFixed(1)} C: ${r.toFixed(3)}' subtracted`));
    h = after;
    if (ha < 10) {
      const added = ha < 5 ? 1 : 0;
      if (added) sigma = Math.hypot(sigma, added);
      warnings.push({ code: 'low_altitude_refraction', id: p.id, apparent_altitude_deg: ha, sigma_added_arcmin: added });
    }
  } else steps.push(step('refraction', false, h, h, skipKind));

  const sd = p.semidiameter_arcmin;
  const hp = p.horizontal_parallax_arcmin;
  if (apparent && (cls === 'sun' || cls === 'moon') && p.limb !== 'center') {
    const sign = p.limb === 'lower' ? 1 : -1;
    if (!(sd > 0)) {
      steps.push(step('semidiameter', false, h, h, 'not applied: the semidiameter is unknown (0)'));
      warnings.push({ code: 'other', message: `Sight ${p.id}: ${p.limb} limb given but the semidiameter is unknown, so it was not applied.` });
    } else if (cls === 'sun') {
      const after = h + (sign * sd) / 60;
      steps.push(step('semidiameter', true, h, after, `Sun ${p.limb} limb: semidiameter ${sd.toFixed(3)}' ${sign > 0 ? 'added' : 'subtracted'}`));
      h = after;
    } else {
      let aug = sd;
      const sinHp = Math.sin((hp / 60) * D2R);
      for (let i = 0; i < 6; i += 1) {
        const centre = (h + (sign * aug) / 60) * D2R;
        const denom = Math.sqrt(1 - sinHp * sinHp * Math.cos(centre) ** 2) - sinHp * Math.sin(centre);
        aug = (Math.asin(Math.min(1, Math.sin((sd / 60) * D2R) / denom)) * R2D) * 60;
      }
      const after = h + (sign * aug) / 60;
      steps.push(step('semidiameter', true, h, after, `Moon ${p.limb} limb: semidiameter ${sd.toFixed(3)}' augmented by ${(aug - sd).toFixed(3)}' to ${aug.toFixed(3)}' ${sign > 0 ? 'added' : 'subtracted'}`));
      h = after;
    }
  } else {
    const note = !apparent
      ? skipKind
      : cls === 'star' || cls === 'planet'
        ? `not applicable: a ${cls} is observed as a point (centre of light)`
        : 'not applicable: the centre of the disc was observed';
    steps.push(step('semidiameter', false, h, h, note));
    if (apparent && (cls === 'star' || cls === 'planet') && p.limb !== 'center') {
      warnings.push({ code: 'limb_ignored_for_star', id: p.id });
    }
  }

  if (apparent && cls !== 'star') {
    if (cls === 'moon' && !(hp > 0)) {
      throw new Error(`observation ${p.id}: a Moon sight needs the Moon's horizontal parallax (it reaches 61'), and the direction has none`);
    }
    const pa = cls === 'sun' ? hp * Math.cos(ha * D2R) : Math.asin(Math.sin((hp / 60) * D2R) * Math.cos(h * D2R)) * R2D * 60;
    const after = h + pa / 60;
    steps.push(step('parallax', true, h, after, cls === 'sun' ? `Sun: HP ${hp.toFixed(3)}' x cos(Ha) = ${pa.toFixed(3)}' added` : `${p.body}: asin(sin HP ${hp.toFixed(3)}' x cos h) = ${pa.toFixed(3)}' added`));
    h = after;
  } else {
    steps.push(step('parallax', false, h, h, apparent ? 'not applicable: a star has no parallax at this precision' : skipKind));
  }

  if (!apparent) warnings.push({ code: 'already_corrected', id: p.id, kind: p.kind, ignored: ['refraction', 'semidiameter', 'parallax'] });

  return { input_kind: p.kind, input_deg: p.altitude_deg, steps, ho_deg: h, sigma_ho_arcmin: sigma, warnings };
}

/** Reduce one observation the way `reduce::reduce_observation` does, with mock directions. */
export function mockReduceObservation(
  engine: ExplorerEngine,
  session: Session,
  obs: Observation,
  mode: EphemerisMode,
): ReducedSight {
  const recorded = jdOf(obs.utc, `observation ${obs.id}`);
  const jd = recorded + session.clock.correction_s / S_PER_DAY;
  const warnings: Warning[] = [];
  let direction: GeocentricDirection;
  let source: string;
  if (obs.geocentric) {
    direction = obs.geocentric;
    source = 'supplied';
    warnings.push({ code: 'supplied_direction_used', id: obs.id });
  } else if (mode === 'supplied') {
    throw new Error(`observation ${obs.id}: no body direction available: supply gha_deg/dec_deg in the observation (ephemeris mode "supplied")`);
  } else {
    try {
      direction = mockDirection(engine, obs.body, jd);
    } catch (error) {
      throw new Error(`observation ${obs.id}: no body direction available: ${error instanceof Error ? error.message : String(error)}`);
    }
    source = MOCK_SOURCE;
  }
  const corrections = mockChain({
    id: obs.id,
    body: obs.body,
    kind: obs.altitude_kind,
    altitude_deg: obs.altitude_deg,
    sigma_arcmin: obs.sigma_arcmin,
    limb: obs.limb,
    horizon: obs.horizon ?? session.instrument.horizon,
    index_correction_arcmin: session.instrument.index_correction_arcmin,
    height_of_eye_m: session.observer.height_of_eye_m,
    pressure_hpa: session.observer.pressure_hpa,
    temperature_c: session.observer.temperature_c,
    semidiameter_arcmin: direction.semidiameter_arcmin,
    horizontal_parallax_arcmin: direction.horizontal_parallax_arcmin,
  });
  warnings.push(...corrections.warnings);
  const ap = session.observer.assumed_position;
  const moonTerm = bodyClass(obs.body) === 'moon' && direction.horizontal_parallax_arcmin > 0;
  let hc: number | null = null;
  let zn: number | null = null;
  let intercept: number | null = null;
  let earthShape: number | null = null;
  if (ap) {
    const r = altitudeAzimuthDeg(ap, direction.gha_deg, direction.dec_deg);
    earthShape = moonTerm ? mockEarthShapeArcmin(ap.lat_deg, ap.lon_deg, direction.gha_deg, direction.dec_deg, direction.horizontal_parallax_arcmin) : null;
    hc = r.altitude_deg + (earthShape ?? 0) / 60;
    zn = r.azimuth_deg;
    intercept = (corrections.ho_deg - hc) * 60;
  }
  return {
    id: obs.id,
    body: canonicalOr(engine, obs.body),
    utc: obs.utc,
    jd_utc: jd,
    gha_deg: direction.gha_deg,
    dec_deg: direction.dec_deg,
    direction_source: source,
    ho_deg: corrections.ho_deg,
    sigma_arcmin: corrections.sigma_ho_arcmin,
    corrections,
    hc_deg: hc,
    zn_deg: zn,
    intercept_nm: intercept,
    warnings,
    horizontal_parallax_arcmin: direction.horizontal_parallax_arcmin,
    earth_shape_arcmin: earthShape,
  };
}

function canonicalOr(engine: ExplorerEngine, body: string): string {
  try {
    return canonical(engine, body);
  } catch {
    return body;
  }
}

/** Every observation reduced; a rejected one becomes an `other` warning naming it. */
function reduceAll(
  engine: ExplorerEngine,
  session: Session,
  mode: EphemerisMode | undefined,
): { sights: ReducedSight[]; warnings: Warning[]; rejected: string[] } {
  const sights: ReducedSight[] = [];
  const warnings: Warning[] = [];
  const rejected: string[] = [];
  for (const obs of session.observations) {
    try {
      sights.push(mockReduceObservation(engine, session, obs, mode ?? 'auto'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rejected.push(message);
      warnings.push({ code: 'other', message: `${message}. This sight was not used.` });
    }
  }
  return { sights, warnings, rejected };
}

function drOf(session: Session, dr: DrPosition | null | undefined, what: string): DrPosition {
  if (dr) return dr;
  const ap = session.observer.assumed_position;
  if (!ap) throw new Error(`${what} needs a DR position: give one, or an assumed position in the session`);
  const role = session.observer.assumed_position_role;
  return { lat_deg: ap.lat_deg, lon_deg: ap.lon_deg, sigma_nm: role.role === 'prior' ? role.sigma_nm : null };
}

function oneBody(engine: ExplorerEngine, session: Session, what: string): string {
  const names = [...new Set(session.observations.map((o) => canonicalOr(engine, o.body)))];
  if (names.length === 0) throw new Error(`${what} needs at least one observation`);
  if (names.length > 1) throw new Error(`every observation of ${what} must be of one body; this session has ${names.join(', ')}`);
  return names[0]!;
}

// ---------------------------------------------------------------------------------------
// Small linear algebra
// ---------------------------------------------------------------------------------------

/** Solve a small symmetric system (Gaussian elimination); null when singular. */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c += 1) {
    let piv = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(m[r]![c]!) > Math.abs(m[piv]![c]!)) piv = r;
    if (Math.abs(m[piv]![c]!) < 1e-15) return null;
    [m[c], m[piv]] = [m[piv]!, m[c]!];
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = m[r]![c]! / m[c]![c]!;
      for (let k = c; k <= n; k += 1) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

function inverse(a: number[][]): number[][] | null {
  const n = a.length;
  const cols: number[][] = [];
  for (let j = 0; j < n; j += 1) {
    const e = Array.from({ length: n }, (_, i) => (i === j ? 1 : 0));
    const x = solveLinear(a, e);
    if (!x) return null;
    cols.push(x);
  }
  return a.map((_, i) => cols.map((c) => c[i]!));
}

/** Weighted polynomial fit `y = Σ c_k x^k`; coefficients and their covariance. */
function polyFit(x: number[], y: number[], w: number[], degree: number): { c: number[]; cov: number[][] } | null {
  const n = degree + 1;
  const a = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b = new Array<number>(n).fill(0);
  x.forEach((xi, i) => {
    for (let r = 0; r < n; r += 1) {
      b[r]! += w[i]! * y[i]! * xi ** r;
      for (let c = 0; c < n; c += 1) a[r]![c]! += w[i]! * xi ** (r + c);
    }
  });
  const cov = inverse(a);
  if (!cov) return null;
  const c = cov.map((row) => row.reduce((s, v, k) => s + v * b[k]!, 0));
  return { c, cov };
}

// ---------------------------------------------------------------------------------------
// Geometry metrics for the planners (azimuths only, sphere, 1′ = 1 NM)
// ---------------------------------------------------------------------------------------

function azimuthGap(azimuths: number[]): number {
  if (azimuths.length < 2) return 360;
  const s = azimuths.map(norm360).sort((a, b) => a - b);
  let gap = 360 - s[s.length - 1]! + s[0]!;
  for (let i = 1; i < s.length; i += 1) gap = Math.max(gap, s[i]! - s[i - 1]!);
  return gap;
}

interface Aimed {
  zn_deg: number;
  sigma_arcmin: number;
}

/** The planner's metrics for a set of lines of position. */
export function planMetrics(sights: Aimed[]): PlanMetrics {
  let a = 0;
  let b = 0;
  let c = 0;
  let ua = 0;
  let ub = 0;
  let uc = 0;
  for (const s of sights) {
    const w = 1 / (s.sigma_arcmin * s.sigma_arcmin);
    const cn = Math.cos(s.zn_deg * D2R);
    const se = Math.sin(s.zn_deg * D2R);
    a += w * cn * cn;
    b += w * cn * se;
    c += w * se * se;
    ua += cn * cn;
    ub += cn * se;
    uc += se * se;
  }
  const det = a * c - b * b;
  const tr = a + c;
  const disc = Math.sqrt(Math.max((tr * tr) / 4 - det, 0));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const singular = !(det > 1e-12 * Math.max(tr * tr, 1e-30)) || sights.length < 2;
  const gap = azimuthGap(sights.map((s) => s.zn_deg));
  if (singular) {
    return {
      sight_count: sights.length,
      sigma_north_m: null,
      sigma_east_m: null,
      trace_sigma_m: null,
      semi_major_sigma_m: null,
      semi_minor_sigma_m: null,
      semi_major_azimuth_deg: null,
      geometric_dilution_m_per_arcmin: null,
      condition_number: null,
      rank: sights.length === 0 || tr === 0 ? 0 : 1,
      max_azimuth_gap_deg: gap,
      singular: true,
    };
  }
  // Covariance in NM² (1′ of arc = 1 NM), then metres.
  const covN = c / det;
  const covE = a / det;
  const covNE = -b / det;
  const m2 = NM_M * NM_M;
  const ctr = covN + covE;
  const cdisc = Math.sqrt(Math.max((ctr * ctr) / 4 - (covN * covE - covNE * covNE), 0));
  const major = ctr / 2 + cdisc;
  const minor = ctr / 2 - cdisc;
  const az = Math.abs(covNE) > 1e-18 ? Math.atan2(major - covN, covNE) * R2D : covN >= covE ? 0 : 90;
  const udet = ua * uc - ub * ub;
  return {
    sight_count: sights.length,
    sigma_north_m: Math.sqrt(covN * m2),
    sigma_east_m: Math.sqrt(covE * m2),
    trace_sigma_m: Math.sqrt(ctr * m2),
    semi_major_sigma_m: Math.sqrt(major * m2),
    semi_minor_sigma_m: Math.sqrt(Math.max(minor, 0) * m2),
    semi_major_azimuth_deg: ((az % 180) + 180) % 180,
    geometric_dilution_m_per_arcmin: udet > 1e-18 ? Math.sqrt((ua + uc) / udet) * NM_M : null,
    condition_number: l2 > 0 ? Math.sqrt(l1 / l2) : null,
    rank: 2,
    max_azimuth_gap_deg: gap,
    singular: false,
  };
}

/** Trace of the position block when a shared altitude bias is estimated too (the spread criterion). */
function spreadObjective(sights: Aimed[]): number {
  const n = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const s of sights) {
    const w = 1 / (s.sigma_arcmin * s.sigma_arcmin);
    const row = [Math.cos(s.zn_deg * D2R), Math.sin(s.zn_deg * D2R), 1];
    for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) n[i]![j]! += w * row[i]! * row[j]!;
  }
  const inv = inverse(n);
  return inv ? inv[0]![0]! + inv[1]![1]! : Number.POSITIVE_INFINITY;
}

function subsets<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]): void => {
    if (acc.length === size) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i += 1) {
      acc.push(items[i]!);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  return out;
}

/** Greedy shooting order: each pick the one that most shrinks the fix error given the others. */
function greedyOrder<T extends Aimed & { body: string }>(chosen: T[]): { order: T[]; progression: PlanMetrics[]; scores: number[] } {
  const left = [...chosen];
  const order: T[] = [];
  const progression: PlanMetrics[] = [planMetrics([])];
  const scores: number[] = [];
  while (left.length) {
    let best = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    left.forEach((cand, i) => {
      const m = planMetrics([...order, cand]);
      const score = m.trace_sigma_m === null ? cand.zn_deg / 1000 - azimuthGap([...order, cand].map((x) => x.zn_deg)) : -m.trace_sigma_m;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    });
    const [pick] = left.splice(best, 1);
    order.push(pick!);
    progression.push(planMetrics(order));
    scores.push(bestScore);
  }
  return { order, progression, scores };
}

// ---------------------------------------------------------------------------------------
// The navigation tools
// ---------------------------------------------------------------------------------------

export function createMockNav(engine: ExplorerEngine): NavTools {
  const direction = (body: string) => (jd: number) => mockDirection(engine, body, jd);

  const tools: NavTools = {
    // -------------------------------------------------------------------- noon sight
    noonSight(session: Session, options: NoonSightOptions = {}, mode?: EphemerisMode): NoonSightResult {
      const body = oneBody(engine, session, 'a noon sight');
      const dr = drOf(session, options.dr, 'a noon sight');
      const { sights, warnings } = reduceAll(engine, session, mode);
      if (sights.length === 0) throw new Error('every observation of the noon sight was rejected; see the reductions');
      const dir = direction(body);
      const t0 = mean(sights.map((s) => s.jd_utc));
      // Meridian passage the DR predicts: LHA = 0 (Newton on the wrapped LHA).
      let tDr = t0;
      for (let i = 0; i < 8; i += 1) {
        const lha = wrap180(dir(tDr).gha_deg + dr.lon_deg);
        const rate = ghaRateDegPerMin(dir, tDr);
        tDr -= lha / rate / MIN_PER_DAY;
      }
      const wDegPerMin = ghaRateDegPerMin(dir, tDr);
      const tau = sights.map((s) => (s.jd_utc - tDr) * MIN_PER_DAY);
      const ho = sights.map((s) => s.ho_deg * 60);
      const wts = sights.map((s) => 1 / (s.sigma_arcmin * s.sigma_arcmin));
      const n = sights.length;
      const decAt = (jd: number): number => dir(jd).dec_deg;
      let method: NoonSightResult['method'];
      let peakMin = 0;
      let h0Arcmin: number;
      let h0Sigma: number;
      let fitted: { c: number[]; cov: number[][] } | null = null;
      if (n >= 3) {
        fitted = polyFit(tau, ho, wts, 2);
        if (fitted && fitted.c[2]! < 0) {
          const [c0, c1, c2] = fitted.c as [number, number, number];
          peakMin = -c1 / (2 * c2);
          h0Arcmin = c0 - (c1 * c1) / (4 * c2);
          const g = [1, -c1 / (2 * c2), (c1 * c1) / (4 * c2 * c2)];
          let v = 0;
          for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) v += g[i]! * g[j]! * fitted.cov[i]![j]!;
          h0Sigma = Math.sqrt(Math.max(v, 0));
          method = 'curve_fit';
        } else {
          throw new Error('the run does not curve over a peak: the sights are not around meridian passage');
        }
      } else {
        const best = ho.indexOf(Math.max(...ho));
        h0Arcmin = ho[best]!;
        h0Sigma = sights[best]!.sigma_arcmin;
        peakMin = tau[best]!;
        method = options.single_altitude === 'ex_meridian' ? 'ex_meridian' : 'maximum_altitude';
      }
      const tPeak = tDr + peakMin / MIN_PER_DAY;
      const h0 = h0Arcmin / 60;
      const dec = decAt(tPeak);
      const side: MeridianSide =
        options.body_bearing === 'north' || options.body_bearing === 'south'
          ? options.body_bearing
          : dr.lat_deg >= dec
            ? 'south'
            : 'north';
      const zd = 90 - h0;
      const lat = side === 'south' ? dec + zd : dec - zd;
      const kPred =
        0.5 * (wDegPerMin * D2R) ** 2 * Math.cos(lat * D2R) * Math.cos(dec * D2R) / Math.max(Math.cos(h0 * D2R), 1e-6) * R2D * 60;
      const rms = Math.sqrt(mean(tau.map((t) => (t - peakMin) ** 2)));
      const sigmaH = Math.sqrt(1 / wts.reduce((a, b) => a + b, 0)) * Math.sqrt(n);
      const hasLon = method === 'curve_fit';
      const sigmaT = hasLon ? (sigmaH / (2 * kPred * Math.max(rms, 1e-6) * Math.sqrt(n))) * 60 : null;
      const clock = session.clock.uncertainty_s;
      const lonSigma = sigmaT === null ? null : Math.hypot((wDegPerMin / 60) * 60 * sigmaT, (wDegPerMin / 60) * 60 * clock);
      const lon = hasLon ? wrap180(-dir(tPeak).gha_deg) : null;
      const fmtDm = (deg: number): string => {
        const s = deg < 0 ? '−' : '+';
        const a = Math.abs(deg);
        const d = Math.floor(a);
        return `${s}${d}°${((a - d) * 60).toFixed(1)}′`;
      };
      const latitudeRule =
        side === 'south'
          ? `The ${body} crossed your meridian SOUTH of the zenith, so latitude = declination + zenith distance, counting north as positive: ${fmtDm(dec)} + ${fmtDm(zd)} = ${fmtDm(lat)}. Zenith distance = 90° − meridian altitude ${fmtDm(h0)}. (MOCK)`
          : `The ${body} crossed your meridian NORTH of the zenith, so latitude = declination − zenith distance, counting north as positive: ${fmtDm(dec)} − ${fmtDm(zd)} = ${fmtDm(lat)}. Zenith distance = 90° − meridian altitude ${fmtDm(h0)}. (MOCK)`;
      const out: Warning[] = [MOCK_NOTE, ...warnings];
      if (hasLon && sigmaT !== null && lonSigma !== null) {
        out.push({ code: 'flat_peak_longitude', body, sigma_time_s: sigmaT, sigma_lon_arcmin: lonSigma, sigma_east_nm: lonSigma * Math.cos(lat * D2R) });
      }
      if (h0 > 85) out.push({ code: 'meridian_near_zenith', body, meridian_altitude_deg: h0 });
      if (n >= 3 && (tau.every((t) => t < peakMin) || tau.every((t) => t > peakMin))) {
        out.push({ code: 'one_sided_run', body, before: tau.filter((t) => t < peakMin).length, after: tau.filter((t) => t > peakMin).length });
      }
      if (!hasLon && Math.abs(peakMin) > 15) {
        out.push({ code: 'not_at_meridian_passage', id: sights[0]!.id, minutes_from_passage: peakMin });
      }
      const model = (t: number): number =>
        fitted ? fitted.c[0]! + fitted.c[1]! * t + fitted.c[2]! * t * t : h0Arcmin - kPred * (t - peakMin) ** 2;
      const residuals: RunResidual[] = sights.map((s, i) => {
        const m = model(tau[i]!) / 60;
        const r = (s.ho_deg - m) * 60;
        return {
          id: s.id,
          utc: isoUtc(s.jd_utc),
          jd_utc: s.jd_utc,
          minutes: tau[i]! - peakMin,
          ho_deg: s.ho_deg,
          model_deg: m,
          residual_arcmin: r,
          normalized: r / s.sigma_arcmin,
          normalized_loo: null,
          used: true,
          outlier: Math.abs(r / s.sigma_arcmin) > 3,
        };
      });
      const lo = Math.min(...tau, peakMin - 5) - 3;
      const hi = Math.max(...tau, peakMin + 5) + 3;
      const modelCurve: CurvePoint[] = Array.from({ length: 49 }, (_, i) => {
        const t = lo + ((hi - lo) * i) / 48;
        return { jd_utc: tDr + t / MIN_PER_DAY, minutes: t - peakMin, altitude_deg: model(t) / 60 };
      });
      const chi2 = residuals.reduce((a, r) => a + r.normalized ** 2, 0);
      const sigmaE = dr.sigma_nm ?? null;
      return {
        body,
        method,
        n_sights: n,
        side,
        latitude: { lat_deg: lat, sigma_arcmin: h0Sigma },
        meridian_altitude_deg: h0,
        declination_deg: dec,
        zenith_distance_deg: zd,
        latitude_rule: latitudeRule,
        meridian_passage: hasLon ? { utc: isoUtc(tPeak), jd_utc: tPeak, sigma_s: sigmaT! } : null,
        longitude:
          hasLon && lon !== null && lonSigma !== null
            ? { lon_deg: lon, sigma_arcmin: lonSigma, sigma_nm: lonSigma * Math.cos(lat * D2R), clock_sigma_arcmin: (wDegPerMin / 60) * 60 * clock }
            : null,
        longitude_caveat: hasLon
          ? `Near noon the ${body}'s height hardly changes, so the time of the peak — and the longitude, which is nothing but that time — is uncertain by ±${sigmaT!.toFixed(0)} s (1 sigma): ±${lonSigma!.toFixed(1)}′ of longitude. The latitude does not suffer from this: it comes from how HIGH the peak is, not WHEN it happened. (MOCK)`
          : 'One altitude cannot time the peak, so there is no longitude: the latitude comes from how high the body stood, the time only picks the declination. (MOCK)',
        longitude_sensitivity_arcmin_per_nm: method === 'ex_meridian' ? 0 : null,
        maximum: hasLon ? { utc: isoUtc(tPeak), jd_utc: tPeak, altitude_deg: h0, seconds_after_passage: 0 } : null,
        curvature: {
          predicted_arcmin_per_min2: kPred,
          rate_at_passage_arcmin_per_min: 0,
          max_minus_meridian_arcmin: 0,
          fitted_arcmin_per_min2: fitted ? -fitted.c[2]! : null,
          fitted_sigma_arcmin_per_min2: fitted ? Math.sqrt(Math.max(fitted.cov[2]![2]!, 0)) : null,
          z: fitted ? (-fitted.c[2]! - kPred) / Math.max(Math.sqrt(Math.max(fitted.cov[2]![2]!, 0)), 1e-9) : null,
          consistent: fitted ? Math.abs((-fitted.c[2]! - kPred) / Math.max(Math.sqrt(Math.max(fitted.cov[2]![2]!, 0)), 1e-9)) <= 3 : null,
        },
        alternative: null,
        dr_check: {
          predicted_passage_utc: isoUtc(tDr),
          predicted_passage_jd_utc: tDr,
          predicted_passage_sigma_s: sigmaE === null ? null : (sigmaE / Math.cos(dr.lat_deg * D2R) / (wDegPerMin * 60)) * 60,
          latitude_difference_arcmin: (lat - dr.lat_deg) * 60,
          longitude_difference_arcmin: lon === null ? null : wrap180(lon - dr.lon_deg) * 60,
        },
        chi2,
        dof: Math.max(n - 3, 0),
        residuals,
        model_curve: modelCurve,
        sights,
        warnings: out,
      };
    },

    // -------------------------------------------------------------------- Polaris
    polarisLatitude(session: Session, options: PolarisOptions = {}, mode?: EphemerisMode): PolarisResult {
      const dr = drOf(session, options.dr, 'latitude by Polaris');
      const polarisOnly: Session = { ...session, observations: session.observations.filter((o) => o.body.trim().toLowerCase() === 'polaris') };
      const ignored = session.observations.filter((o) => o.body.trim().toLowerCase() !== 'polaris');
      const { sights, warnings } = reduceAll(engine, polarisOnly, mode);
      if (sights.length === 0) throw new Error('latitude by Polaris needs at least one usable Polaris sight');
      const out: Warning[] = [MOCK_NOTE, ...warnings];
      for (const o of ignored) out.push({ code: 'other', message: `Sight ${o.id} (${o.body}) is not Polaris and was ignored.` });
      if (dr.sigma_nm === null || dr.sigma_nm === undefined) {
        out.push({ code: 'other', message: 'The DR longitude has no stated uncertainty, so its effect on the latitude is not included.' });
      }
      const refUtc = options.reference_utc ?? sights[sights.length - 1]!.utc;
      const refJd = jdOf(refUtc, 'reference_utc');
      const per: PolarisSight[] = sights.map((s) => {
        const lha = norm360(s.gha_deg + dr.lon_deg);
        const A = Math.sin(s.dec_deg * D2R);
        const B = Math.cos(s.dec_deg * D2R) * Math.cos(lha * D2R);
        const R = Math.hypot(A, B);
        const psi = Math.atan2(B, A);
        const x = Math.sin(s.ho_deg * D2R) / R;
        if (Math.abs(x) > 1) throw new Error(`sight ${s.id}: no latitude on this meridian sees Polaris that high`);
        const r1 = (Math.asin(x) - psi) * R2D;
        const r2 = (Math.PI - Math.asin(x) - psi) * R2D;
        const lat = Math.abs(r1 - dr.lat_deg) <= Math.abs(r2 - dr.lat_deg) ? r1 : r2;
        const zn = altitudeAzimuthDeg({ lat_deg: lat, lon_deg: dr.lon_deg }, s.gha_deg, s.dec_deg).azimuth_deg;
        const tanZ = Math.abs(Math.tan(zn * D2R));
        const fromAlt = s.sigma_arcmin / Math.max(Math.abs(Math.cos(zn * D2R)), 1e-6);
        const fromLon = dr.sigma_nm === null || dr.sigma_nm === undefined ? null : tanZ * dr.sigma_nm;
        const fromClock = Math.abs(Math.cos(lat * D2R) * tanZ) * (15.041 / 3600) * 60 * session.clock.uncertainty_s;
        const sigma = Math.hypot(fromAlt, fromLon ?? 0, fromClock);
        const ghaAries = engine.sidereal(s.jd_utc).gha_aries_deg;
        const lhaAries = norm360(ghaAries + dr.lon_deg);
        const p = (90 - s.dec_deg) * 60;
        const hAngle = lha * D2R;
        const halfTerm = (latDeg: number): number => 0.5 * p * Math.sin((p / 60) * D2R) * Math.sin(hAngle) ** 2 * Math.tan(latDeg * D2R);
        const a0 = 58.8 - p * Math.cos(hAngle) + halfTerm(50);
        const a1 = 0.6 + halfTerm(dr.lat_deg) - halfTerm(50);
        const a2 = 0.6;
        const tableLat = s.ho_deg - 1 + (a0 + a1 + a2) / 60;
        if (lat > 88 || (zn > 20 && zn < 340)) out.push({ code: 'polaris_near_pole', id: s.id, latitude_deg: lat, azimuth_deg: zn });
        return {
          id: s.id,
          utc: isoUtc(s.jd_utc),
          jd_utc: s.jd_utc,
          ho_deg: s.ho_deg,
          gha_deg: s.gha_deg,
          dec_deg: s.dec_deg,
          dr_lon_deg: dr.lon_deg,
          lha_deg: lha,
          azimuth_deg: zn,
          latitude: { lat_deg: lat, sigma_arcmin: sigma },
          sigma_from_altitude_arcmin: fromAlt,
          sigma_from_longitude_arcmin: fromLon,
          sigma_from_clock_arcmin: fromClock,
          longitude_sensitivity_arcmin_per_nm: tanZ,
          correction_arcmin: (lat - s.ho_deg) * 60,
          normalized_residual: null,
          almanac: {
            lha_aries_deg: lhaAries,
            a0_arcmin: a0,
            a1_arcmin: a1,
            a2_arcmin: a2,
            latitude_deg: tableLat,
            difference_arcmin: (tableLat - lat) * 60,
            table_latitude_deg: dr.lat_deg,
            mean_sha_deg: norm360(s.gha_deg - ghaAries),
            mean_dec_deg: s.dec_deg,
            within_printed_table: dr.lat_deg >= 0 && dr.lat_deg <= 68,
            note: 'MOCK: a0, a1 and a2 use this instant\'s Polaris instead of the year\'s mean position, so a2 is exactly 0.6′.',
          },
        };
      });
      const w = per.map((s) => 1 / s.sigma_from_altitude_arcmin ** 2);
      const sw = w.reduce((a, b) => a + b, 0);
      const latMean = per.reduce((a, s, i) => a + w[i]! * s.latitude.lat_deg, 0) / sw;
      const shared = Math.hypot(per[0]!.sigma_from_longitude_arcmin ?? 0, per[0]!.sigma_from_clock_arcmin);
      if (per.length > 1) {
        per.forEach((s) => {
          s.normalized_residual = ((s.latitude.lat_deg - latMean) * 60) / s.sigma_from_altitude_arcmin;
        });
      }
      const chi2 = per.length > 1 ? per.reduce((a, s) => a + (s.normalized_residual ?? 0) ** 2, 0) : null;
      void refJd;
      return {
        latitude: { lat_deg: latMean, sigma_arcmin: Math.hypot(Math.sqrt(1 / sw), shared) },
        reference_utc: isoUtc(refJd),
        reference_jd_utc: refJd,
        polaris: per,
        chi2,
        dof: per.length - 1,
        sights,
        warnings: out,
      };
    },

    // -------------------------------------------------------------------- averaging
    averageSights(session: Session, options: AveragingOptions = {}, mode?: EphemerisMode): AveragedSight {
      const body = oneBody(engine, session, 'averaging');
      const dr = drOf(session, options.dr, 'averaging');
      const { sights, warnings } = reduceAll(engine, session, mode);
      if (sights.length === 0) throw new Error('every observation of the run was rejected');
      const dir = direction(body);
      const predicted = (jd: number): number => {
        const d = dir(jd);
        return altitudeAzimuthDeg({ lat_deg: dr.lat_deg, lon_deg: dr.lon_deg }, d.gha_deg, d.dec_deg).altitude_deg * 60;
      };
      const threshold = options.outlier_threshold ?? 3;
      const reject = options.reject_outliers ?? true;
      const used = sights.map(() => true);
      const fit = (): { b: number; sw: number } => {
        let sw = 0;
        let sb = 0;
        sights.forEach((s, i) => {
          if (!used[i]) return;
          const w = 1 / s.sigma_arcmin ** 2;
          sw += w;
          sb += w * (s.ho_deg * 60 - predicted(s.jd_utc));
        });
        return { b: sb / sw, sw };
      };
      const out: Warning[] = [MOCK_NOTE, ...warnings];
      let f = fit();
      const loo = (i: number): number => {
        const s = sights[i]!;
        const r = s.ho_deg * 60 - predicted(s.jd_utc) - f.b;
        const w = 1 / s.sigma_arcmin ** 2;
        return used[i] ? r / (s.sigma_arcmin * Math.sqrt(Math.max(1 - w / f.sw, 1e-9))) : r / Math.sqrt(s.sigma_arcmin ** 2 + 1 / f.sw);
      };
      if (reject) {
        for (;;) {
          const inUse = used.filter(Boolean).length;
          if (inUse < 3) break;
          let worst = -1;
          let worstZ = threshold;
          sights.forEach((_, i) => {
            if (!used[i]) return;
            const z = Math.abs(loo(i));
            if (z > worstZ) {
              worstZ = z;
              worst = i;
            }
          });
          if (worst < 0) break;
          used[worst] = false;
          out.push({ code: 'run_outlier', id: sights[worst]!.id, normalized_residual: worstZ, rejected: true });
          f = fit();
        }
      }
      const tMean =
        sights.reduce((a, s, i) => a + (used[i] ? s.jd_utc / s.sigma_arcmin ** 2 : 0), 0) / f.sw;
      const tRef = options.reference_utc ? jdOf(options.reference_utc, 'reference_utc') : tMean;
      const hRef = predicted(tRef) + f.b;
      const hStep = 30 / S_PER_DAY;
      const slope = (predicted(tRef + hStep) - predicted(tRef - hStep)) / 1;
      const curv = (predicted(tRef + hStep) - 2 * predicted(tRef) + predicted(tRef - hStep)) / 0.25;
      const sigmaSlope = dr.sigma_nm === null || dr.sigma_nm === undefined ? null : Math.abs(slope) * 0.002 * dr.sigma_nm;
      const dtMin = (tRef - tMean) * MIN_PER_DAY;
      const sigma = Math.hypot(Math.sqrt(1 / f.sw), sigmaSlope === null ? 0 : sigmaSlope * dtMin);
      const residuals: RunResidual[] = sights.map((s, i) => {
        const model = (predicted(s.jd_utc) + f.b) / 60;
        const r = (s.ho_deg - model) * 60;
        return {
          id: s.id,
          utc: isoUtc(s.jd_utc),
          jd_utc: s.jd_utc,
          minutes: (s.jd_utc - tRef) * MIN_PER_DAY,
          ho_deg: s.ho_deg,
          model_deg: model,
          residual_arcmin: r,
          normalized: r / s.sigma_arcmin,
          normalized_loo: loo(i),
          used: used[i]!,
          outlier: !used[i],
        };
      });
      const usedIdx = sights.map((_, i) => i).filter((i) => used[i]);
      let freeSlope: AveragedSight['free_slope'] = null;
      if (usedIdx.length >= 4) {
        const x = usedIdx.map((i) => (sights[i]!.jd_utc - tMean) * MIN_PER_DAY);
        const y = usedIdx.map((i) => sights[i]!.ho_deg * 60 - predicted(sights[i]!.jd_utc));
        const w = usedIdx.map((i) => 1 / sights[i]!.sigma_arcmin ** 2);
        const lf = polyFit(x, y, w, 1);
        if (lf) {
          const c = lf.c[1]!;
          const sc = Math.sqrt(Math.max(lf.cov[1]![1]!, 0));
          const z = c / Math.hypot(sc, sigmaSlope ?? 0);
          const chi2 = x.reduce((a, xi, k) => a + w[k]! * (y[k]! - lf.c[0]! - c * xi) ** 2, 0);
          freeSlope = {
            slope_arcmin_per_min: slope + c,
            slope_sigma_arcmin_per_min: sc,
            ho_deg: (predicted(tRef) + lf.c[0]! + c * dtMin) / 60,
            sigma_arcmin: Math.sqrt(Math.max(lf.cov[0]![0]!, 0)),
            z,
            consistent: Math.abs(z) <= 3,
            chi2,
            dof: x.length - 2,
          };
          if (Math.abs(z) > 3) {
            out.push({ code: 'slope_inconsistent', body, predicted_arcmin_per_min: slope, fitted_arcmin_per_min: slope + c, z });
          }
        }
      }
      const curve: CurvePoint[] = (() => {
        const lo = Math.min(...sights.map((s) => s.jd_utc), tRef) - 0.5 / MIN_PER_DAY;
        const hi = Math.max(...sights.map((s) => s.jd_utc), tRef) + 0.5 / MIN_PER_DAY;
        return Array.from({ length: 25 }, (_, i) => {
          const jd = lo + ((hi - lo) * i) / 24;
          return { jd_utc: jd, minutes: (jd - tRef) * MIN_PER_DAY, altitude_deg: (predicted(jd) + f.b) / 60 };
        });
      })();
      const chi2 = residuals.reduce((a, r) => a + (r.used ? r.normalized ** 2 : 0), 0);
      const utc = isoUtc(tRef);
      const usedIds = usedIdx.map((i) => sights[i]!.id);
      return {
        body,
        utc,
        jd_utc: tRef,
        ho_deg: hRef / 60,
        sigma_arcmin: sigma,
        n_used: usedIdx.length,
        n_total: sights.length,
        predicted_slope_arcmin_per_min: slope,
        predicted_slope_sigma_arcmin_per_min: sigmaSlope,
        predicted_curvature_arcmin_per_min2: curv,
        chi2,
        dof: usedIdx.length - 1,
        free_slope: freeSlope,
        outliers: sights.filter((_, i) => !used[i]).map((s) => s.id),
        residuals,
        model_curve: curve,
        observation: {
          id: `avg-${body.toLowerCase().replace(/[^a-z0-9]+/g, '')}-${utc.slice(11, 19).replace(/:/g, '')}`,
          body,
          utc,
          altitude_deg: hRef / 60,
          altitude_kind: 'observed_ho',
          sigma_arcmin: sigma,
          limb: 'center',
          horizon: null,
          geocentric: null,
          notes: `Average of ${usedIds.length} sights (${usedIds.join(', ')}) at a predicted slope of ${slope.toFixed(3)}′/min; fully corrected (observed_ho). MOCK engine.`,
        },
        sights,
        warnings: out,
      };
    },

    // -------------------------------------------------------------------- running fix
    runningFix(session: Session, request: RunningFixRequest, mode?: EphemerisMode): RunningFixOutput {
      if (!request || !Array.isArray(request.legs) || request.legs.length === 0) {
        throw new Error('running fix request: legs is required and must not be empty');
      }
      request.legs.forEach((leg, i) => {
        if (i > 0 && !leg.start_utc) throw new Error(`running fix request: leg ${i + 1} needs start_utc (only the first leg may leave it out)`);
        if (!Number.isFinite(leg.course_deg) || !Number.isFinite(leg.speed_kn)) throw new Error(`running fix request: leg ${i + 1} needs a course and a speed`);
      });
      const { sights, warnings } = reduceAll(engine, session, mode);
      if (sights.length === 0) throw new Error('a running fix needs at least one usable observation');
      const first = Math.min(...sights.map((s) => s.jd_utc));
      const last = Math.max(...sights.map((s) => s.jd_utc));
      const tRef = request.reference_utc ? jdOf(request.reference_utc, 'reference_utc') : last;
      const legs = request.legs.map((leg, i) => ({
        start: i === 0 && !leg.start_utc ? first : jdOf(leg.start_utc!, `leg ${i + 1} start_utc`),
        course: leg.course_deg,
        speed: leg.speed_kn,
      }));
      const end = request.end_utc ? jdOf(request.end_utc, 'end_utc') : Number.POSITIVE_INFINITY;
      /** North and east run (NM) from t1 to t2 along the legs (flat, short runs). */
      const run = (t1: number, t2: number): { n: number; e: number; hours: number; course: number; speed: number } => {
        const sgn = t2 >= t1 ? 1 : -1;
        const [a, b] = t2 >= t1 ? [t1, t2] : [t2, t1];
        let n = 0;
        let e = 0;
        legs.forEach((leg, i) => {
          const s = Math.max(a, leg.start);
          const f = Math.min(b, legs[i + 1]?.start ?? end, end);
          if (f <= s) return;
          const d = leg.speed * (f - s) * 24;
          n += d * Math.cos(leg.course * D2R);
          e += d * Math.sin(leg.course * D2R);
        });
        const lastLeg = legs[legs.length - 1]!;
        return { n: sgn * n, e: sgn * e, hours: (t2 - t1) * 24, course: lastLeg.course, speed: lastLeg.speed };
      };
      const mu = request.motion_uncertainty ?? {};
      const speedSigma = mu.speed_sigma_kn ?? 0;
      const courseSigma = mu.course_sigma_deg ?? 0;
      const walk = mu.random_walk_nm_per_sqrt_hour ?? 0;
      const ap = session.observer.assumed_position ?? { lat_deg: 0, lon_deg: 0 };
      const inflations: SigmaInflationReport[] = [];
      const advanced: Observation[] = sights.map((s) => {
        const r = run(s.jd_utc, tRef);
        const zn = s.zn_deg ?? altitudeAzimuthDeg(ap, s.gha_deg, s.dec_deg).azimuth_deg;
        const along = r.n * Math.cos(zn * D2R) + r.e * Math.sin(zn * D2R);
        const dist = Math.hypot(r.n, r.e);
        const dirRun = Math.atan2(r.e, r.n) * R2D;
        const hours = Math.abs(r.hours);
        const sm = Math.hypot(
          speedSigma * hours * Math.cos((zn - dirRun) * D2R),
          dist * courseSigma * D2R * Math.sin((zn - dirRun) * D2R),
          walk * Math.sqrt(hours),
        );
        const total = Math.hypot(s.sigma_arcmin, sm);
        inflations.push({
          id: s.id,
          hours_to_reference: (tRef - s.jd_utc) * 24,
          run_nm: dist,
          zn_deg: zn,
          sigma_sight_arcmin: s.sigma_arcmin,
          sigma_motion_arcmin: sm,
          sigma_total_arcmin: total,
        });
        return {
          id: s.id,
          body: s.body,
          utc: isoUtc(tRef),
          altitude_deg: s.ho_deg + along / 60,
          altitude_kind: 'observed_ho',
          sigma_arcmin: total,
          limb: 'center',
          horizon: null,
          geocentric: { gha_deg: s.gha_deg, dec_deg: s.dec_deg, semidiameter_arcmin: 0, horizontal_parallax_arcmin: 0 },
          notes: '',
        };
      });
      const result = mockSolveSync({ ...session, observations: advanced }, { ...defaultSolve(), ...(request.options ?? {}) });
      const standing: Warning[] = [
        MOCK_NOTE,
        { code: 'other', message: 'Running fix: the sigmas behind this fix include the run\'s uncertainty, not only the instrument\'s.' },
        { code: 'other', message: 'Running fix: the dead-reckoning error is shared by every sight but treated as independent, so the covariance is optimistic.' },
        ...warnings,
      ];
      if (speedSigma === 0 && courseSigma === 0 && walk === 0) {
        standing.push({ code: 'other', message: 'No motion uncertainty was stated, so the run was treated as exact.' });
      }
      if (sights.some((s) => s.jd_utc < legs[0]!.start)) {
        standing.push({ code: 'other', message: 'A sight falls before the first leg starts; the vessel is taken as stationary then.' });
      }
      result.warnings.push(...standing);
      return {
        result,
        reference_utc: isoUtc(tRef),
        reference_jd_utc: tRef,
        applied: true,
        passes: 1,
        reference_estimate: result.kind === 'unique' ? result.fix.position : null,
        inflations,
        sights,
      };
    },

    // -------------------------------------------------------------------- bodies
    sightBodies(): SightBodyInfo[] {
      const order = { sun: 0, moon: 1, planet: 2, star: 3 } as const;
      return engine
        .bodies()
        .filter((b) => b.navigational)
        .map((b) => ({ body: b.body, kind: b.kind }))
        .sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === 'star' ? a.body.localeCompare(b.body) : 0));
    },

    // -------------------------------------------------------------------- predict
    predictSextant(observer: SightObserver, instrument: SightInstrument, body: string, limb: SightLimb, jdUtc: number): PredictedSight {
      const name = canonical(engine, body);
      const dir = mockDirection(engine, name, jdUtc);
      const sphere = altitudeAzimuthDeg({ lat_deg: observer.lat_deg, lon_deg: observer.lon_deg }, dir.gha_deg, dir.dec_deg);
      // The Moon's model altitude carries its Earth-shape term (CONVENTIONS 15.4).
      const earthShape = bodyClass(name) === 'moon' ? mockEarthShapeArcmin(observer.lat_deg, observer.lon_deg, dir.gha_deg, dir.dec_deg, dir.horizontal_parallax_arcmin) : 0;
      const at = { ...sphere, altitude_deg: sphere.altitude_deg + earthShape / 60 };
      const horizon = instrument.horizon ?? 'sea';
      const params = (hs: number): ChainParams => ({
        id: 'predicted',
        body: name,
        kind: 'sextant_hs',
        altitude_deg: hs,
        sigma_arcmin: 1,
        limb,
        horizon,
        index_correction_arcmin: instrument.index_correction_arcmin ?? 0,
        height_of_eye_m: observer.height_of_eye_m ?? 0,
        pressure_hpa: observer.pressure_hpa ?? 1010,
        temperature_c: observer.temperature_c ?? 10,
        semidiameter_arcmin: dir.semidiameter_arcmin,
        horizontal_parallax_arcmin: dir.horizontal_parallax_arcmin,
      });
      const forward = (hs: number): number | null => {
        try {
          return mockChain(params(hs)).ho_deg;
        } catch {
          return null;
        }
      };
      let lo = horizon === 'artificial_reflected' ? 0 : -1;
      let hi = horizon === 'artificial_reflected' ? 180 : 91;
      // Move the lower bracket up to the first reading the chain accepts.
      while (forward(lo) === null && lo < hi) lo += 0.05;
      const fLo = forward(lo);
      if (fLo === null || fLo > at.altitude_deg) {
        throw new Error(`${name} is below the visible horizon here (computed altitude ${at.altitude_deg.toFixed(2)} deg)`);
      }
      for (let i = 0; i < 80; i += 1) {
        const mid = (lo + hi) / 2;
        const f = forward(mid);
        if (f === null || f < at.altitude_deg) lo = mid;
        else hi = mid;
      }
      const hs = (lo + hi) / 2;
      const corrections = mockChain(params(hs));
      const ha = corrections.steps.find((s) => s.kind === 'refraction')!.before_deg;
      return {
        body: name,
        jd_utc: jdUtc,
        utc: isoUtc(jdUtc),
        limb,
        horizon,
        direction_source: MOCK_SOURCE,
        gha_deg: dir.gha_deg,
        dec_deg: dir.dec_deg,
        semidiameter_arcmin: dir.semidiameter_arcmin,
        horizontal_parallax_arcmin: dir.horizontal_parallax_arcmin,
        hc_deg: at.altitude_deg,
        zn_deg: at.azimuth_deg,
        hs_deg: hs,
        ha_deg: ha,
        corrections: corrections as PredictedSight['corrections'],
        warnings: corrections.warnings as SightWarning[],
        earth_shape_arcmin: earthShape,
      };
    },

    // -------------------------------------------------------------------- lunar distance
    lunarDistance(input: LunarDistanceInput): LunarDistanceResult {
      const body = canonical(engine, input.body);
      if (body === 'Moon') throw new Error('lunar distance: the other body cannot be the Moon itself');
      const moonLimb = input.moon_limb ?? 'near';
      if (moonLimb === 'center') throw new Error("lunar distance: measure to the Moon's near or far limb, not its centre");
      const bodyLimb = input.body_limb ?? (body === 'Sun' ? 'near' : 'center');
      const est = jdOf(input.utc_estimate, 'utc_estimate');
      const hours = Math.min(input.search_hours ?? 12, 48);
      const sigmaD = input.sigma_arcmin ?? 0.2;
      const ic = input.instrument?.index_correction_arcmin ?? 0;
      const obsr = input.observer;
      const place = { lat_deg: obsr.lat_deg, lon_deg: obsr.lon_deg };
      const pressure = obsr.pressure_hpa ?? 1010;
      const temp = obsr.temperature_c ?? 10;
      const dip = (input.instrument?.horizon ?? 'sea') === 'sea' ? dipArcmin(obsr.height_of_eye_m ?? 0) : 0;
      const geo = (jd: number): { m: GeocentricDirection; b: GeocentricDirection } => ({
        m: mockDirection(engine, 'Moon', jd),
        b: mockDirection(engine, body, jd),
      });
      const sep = (a: GeocentricDirection, b: GeocentricDirection): number => {
        const d1 = a.dec_deg * D2R;
        const d2 = b.dec_deg * D2R;
        const dh = (a.gha_deg - b.gha_deg) * D2R;
        return Math.acos(Math.min(1, Math.max(-1, Math.sin(d1) * Math.sin(d2) + Math.cos(d1) * Math.cos(d2) * Math.cos(dh)))) * R2D;
      };
      /** Apparent (refracted) altitude of a centre, from an observation or computed at `jd`. */
      const apparentAlt = (
        obs: LunarAltitudeObservation | null | undefined,
        which: 'moon' | 'body',
        jd: number,
        at = place,
      ): { h: number; source: 'observed' | 'computed'; computed: number; az: number; hp: number; sd: number } => {
        const d = which === 'moon' ? mockDirection(engine, 'Moon', jd) : mockDirection(engine, body, jd);
        const topo = engine.skyState({ ...at, height_m: 0, pressure_hpa: pressure, temperature_c: temp }, jd, [which === 'moon' ? 'Moon' : body]).bodies[0]!;
        const computed = topo.alt_apparent_deg;
        if (!obs) return { h: computed, source: 'computed', computed, az: topo.az_deg, hp: d.horizontal_parallax_arcmin, sd: d.semidiameter_arcmin };
        let h = obs.altitude_deg;
        const kind = obs.altitude_kind ?? 'sextant_hs';
        if (kind === 'observed_ho') throw new Error('lunar distance: an observed altitude must be a sextant or apparent altitude, not Ho');
        if (kind === 'sextant_hs') h = h + ic / 60 - dip / 60;
        const limb = obs.limb ?? 'center';
        if (limb !== 'center' && (which === 'moon' || body === 'Sun')) h += ((limb === 'lower' ? 1 : -1) * d.semidiameter_arcmin) / 60;
        return { h, source: 'observed', computed, az: topo.az_deg, hp: d.horizontal_parallax_arcmin, sd: d.semidiameter_arcmin };
      };
      const trueAlt = (h: number, hp: number, cls: BodyClass): number => {
        const r = refractionArcmin(Math.max(h, -0.5), pressure, temp) / 60;
        const hAir = h - r;
        const p = cls === 'star' ? 0 : cls === 'sun' ? (hp * Math.cos(hAir * D2R)) / 60 : Math.asin(Math.sin((hp / 60) * D2R) * Math.cos(hAir * D2R)) * R2D;
        return hAir + p;
      };
      const clsBody = bodyClass(body);
      const clear = (jd: number, at = place) => {
        const m = apparentAlt(input.moon_altitude, 'moon', jd, at);
        const b = apparentAlt(input.body_altitude, 'body', jd, at);
        const reading = input.distance_deg + ic / 60;
        const sdMoon = (m.sd * (1 + Math.sin((m.hp / 60) * D2R) * Math.sin(m.h * D2R))) / 60;
        const afterMoon = reading + (moonLimb === 'near' ? sdMoon : -sdMoon);
        const sdBody = bodyLimb === 'center' || clsBody !== 'sun' ? 0 : ((bodyLimb === 'near' ? 1 : -1) * b.sd) / 60;
        const apparent = afterMoon + sdBody;
        const cosDA = (Math.cos(apparent * D2R) - Math.sin(m.h * D2R) * Math.sin(b.h * D2R)) / (Math.cos(m.h * D2R) * Math.cos(b.h * D2R));
        const airM = m.h - refractionArcmin(Math.max(m.h, -0.5), pressure, temp) / 60;
        const airB = b.h - refractionArcmin(Math.max(b.h, -0.5), pressure, temp) / 60;
        const dist = (h1: number, h2: number): number =>
          Math.acos(Math.min(1, Math.max(-1, Math.sin(h1 * D2R) * Math.sin(h2 * D2R) + Math.cos(h1 * D2R) * Math.cos(h2 * D2R) * cosDA))) * R2D;
        const airless = dist(airM, airB);
        const cleared = dist(trueAlt(m.h, m.hp, 'moon'), trueAlt(b.h, b.hp, clsBody));
        return { m, b, reading, afterIc: reading, afterMoon, apparent, airless, cleared };
      };
      const f = (jd: number, c = clear(jd)): number => {
        const g = geo(jd);
        return sep(g.m, g.b) - c.cleared;
      };
      const step = 10 / MIN_PER_DAY;
      const roots: number[] = [];
      let tPrev = est - hours / 24;
      let fPrev = f(tPrev);
      for (let t = tPrev + step; t <= est + hours / 24 + 1e-9; t += step) {
        const ft = f(t);
        if (fPrev === 0 || fPrev * ft < 0) {
          let a = tPrev;
          let b = t;
          let fa = fPrev;
          for (let i = 0; i < 40; i += 1) {
            const mid = (a + b) / 2;
            const fm = f(mid);
            if (fa * fm <= 0) b = mid;
            else {
              a = mid;
              fa = fm;
            }
          }
          const root = (a + b) / 2;
          const c = clear(root);
          if (c.m.computed > 0 && c.b.computed > 0) roots.push(root);
        }
        tPrev = t;
        fPrev = ft;
      }
      if (roots.length === 0) {
        throw new Error(`lunar distance: the Moon-${body} distance never equals the cleared ${input.distance_deg.toFixed(4)} deg within ${hours} h of the estimate (while both are above the horizon)`);
      }
      roots.sort((a, b) => Math.abs(a - est) - Math.abs(b - est));
      const jd = roots[0]!;
      const c = clear(jd);
      const g1 = geo(jd - 1 / MIN_PER_DAY);
      const g2 = geo(jd + 1 / MIN_PER_DAY);
      const rate = ((sep(g2.m, g2.b) - sep(g1.m, g1.b)) * 60) / 2;
      const perMin = Math.abs(rate);
      const refrArc = Math.abs(c.airless - c.apparent) * 60 * 0.01;
      const budget: LunarErrorTerm[] = [
        { name: 'measurement', distance_arcmin: sigmaD, time_s: (sigmaD / perMin) * 60 },
        { name: 'ephemeris (MOCK, illustrative)', distance_arcmin: 0.5, time_s: (0.5 / perMin) * 60 },
        { name: 'refraction model (1 %)', distance_arcmin: refrArc, time_s: (refrArc / perMin) * 60 },
      ];
      const shift = (dn: number, de: number) => ({
        lat_deg: place.lat_deg + dn / 60,
        lon_deg: place.lon_deg + de / 60 / Math.max(Math.cos(place.lat_deg * D2R), 1e-6),
      });
      const drN = (clear(jd, shift(10, 0)).cleared - c.cleared) * 60;
      const drE = (clear(jd, shift(0, 10)).cleared - c.cleared) * 60;
      const drSigma = input.dr_uncertainty_nm ?? 0;
      if (drSigma > 0) {
        const d = (Math.hypot(drN, drE) / 10) * drSigma;
        budget.push({ name: 'DR position', distance_arcmin: d, time_s: (d / perMin) * 60 });
      }
      const total = Math.sqrt(budget.reduce((a, t) => a + t.distance_arcmin ** 2, 0));
      const sigmaS = (total / perMin) * 60;
      const lonSigma = sigmaS / 4;
      const warnings: SightWarning[] = [MOCK_NOTE];
      if (perMin < 0.25) warnings.push({ code: 'other', message: `The distance changes only ${perMin.toFixed(2)}′ a minute: a body far from the Moon's path makes a poor clock.` });
      const alternatives = roots.slice(1).map((r) => ({ jd_utc: r, utc: isoUtc(r) }));
      if (alternatives.length) warnings.push({ code: 'other', message: `The same distance also occurs at ${alternatives.map((a) => a.utc).join(', ')}; the instant nearest the watch is given.` });
      const clearing: LunarClearingStep[] = [
        { kind: 'index_correction', before_deg: input.distance_deg, after_deg: c.afterIc, delta_arcmin: ic, note: `index correction ${signed(ic, 2)}' added to the sextant reading` },
        { kind: 'moon_semidiameter', before_deg: c.afterIc, after_deg: c.afterMoon, delta_arcmin: (c.afterMoon - c.afterIc) * 60, note: `Moon's ${moonLimb} limb: augmented semidiameter (MOCK)` },
        { kind: 'body_semidiameter', before_deg: c.afterMoon, after_deg: c.apparent, delta_arcmin: (c.apparent - c.afterMoon) * 60, note: clsBody === 'sun' ? `Sun's ${bodyLimb} limb` : `${body}: a point, no semidiameter` },
        { kind: 'refraction', before_deg: c.apparent, after_deg: c.airless, delta_arcmin: (c.airless - c.apparent) * 60, note: `refraction removed: Moon at ${c.m.h.toFixed(2)} deg apparent, ${body} at ${c.b.h.toFixed(2)} deg` },
        { kind: 'parallax', before_deg: c.airless, after_deg: c.cleared, delta_arcmin: (c.cleared - c.airless) * 60, note: 'parallax removed on a sphere (MOCK; the core uses the WGS84 ellipsoid)' },
      ];
      return {
        body,
        jd_utc: jd,
        utc: isoUtc(jd),
        utc_minus_estimate_s: (jd - est) * S_PER_DAY,
        sigma_s: sigmaS,
        longitude_sigma_arcmin: lonSigma,
        longitude_sigma_nm: lonSigma * Math.cos(place.lat_deg * D2R),
        apparent_distance_deg: c.apparent,
        cleared_distance_deg: c.cleared,
        distance_rate_arcmin_per_min: rate,
        clearing,
        altitudes: {
          moon_source: c.m.source,
          body_source: c.b.source,
          moon_apparent_deg: c.m.h,
          body_apparent_deg: c.b.h,
          moon_true_deg: trueAlt(c.m.h, c.m.hp, 'moon'),
          body_true_deg: trueAlt(c.b.h, c.b.hp, clsBody),
          moon_azimuth_deg: c.m.az,
          body_azimuth_deg: c.b.az,
          moon_computed_apparent_deg: c.m.computed,
          body_computed_apparent_deg: c.b.computed,
        },
        error_budget: budget,
        dr_sensitivity_arcmin_per_10nm: [drN, drE],
        alternatives,
        warnings,
        notes: [
          'MOCK: cleared by Borda\'s method on a sphere with low-precision directions; illustrative only.',
          `one arcminute of distance is ${(60 / perMin).toFixed(0)} s of time here, and one second of time is 0.25' of longitude`,
        ],
      };
    },

    // -------------------------------------------------------------------- tonight
    planSights(observer: SightObserver, jdStart: number, jdEnd: number, instrument: SightInstrument): SightPlan {
      if (!(jdEnd > jdStart)) throw new Error('plan_sights: jd_end must be after jd_start');
      if (jdEnd - jdStart > 7) throw new Error('plan_sights: the span is at most 7 days');
      const place = { lat_deg: observer.lat_deg, lon_deg: observer.lon_deg };
      const full: Required<Omit<SightObserver, 'dut1_s'>> = {
        lat_deg: observer.lat_deg,
        lon_deg: observer.lon_deg,
        height_of_eye_m: observer.height_of_eye_m ?? 0,
        pressure_hpa: observer.pressure_hpa ?? 1010,
        temperature_c: observer.temperature_c ?? 10,
      };
      const events = engine.dayEvents(place, jdStart, jdEnd, ['Sun']).bodies[0]?.events ?? [];
      const sunAlt = (jd: number): number => engine.skyState(place, jd, ['Sun']).sun_altitude_deg;
      const found: { kind: 'evening' | 'morning'; start: number; end: number }[] = [];
      const first = (kind: string, after: number): number | null => events.find((e) => e.kind === kind && e.jd_utc >= after)?.jd_utc ?? null;
      const a0 = sunAlt(jdStart);
      const a1 = sunAlt(jdStart + 5 / MIN_PER_DAY);
      if (a0 <= -6 && a0 > -12) {
        const kind = a1 < a0 ? 'evening' : 'morning';
        const end = first(kind === 'evening' ? 'nautical_dusk' : 'civil_dawn', jdStart);
        if (end !== null) found.push({ kind, start: jdStart, end });
      }
      for (const [kind, startKind, endKind] of [
        ['evening', 'civil_dusk', 'nautical_dusk'],
        ['morning', 'nautical_dawn', 'civil_dawn'],
      ] as const) {
        if (found.some((w) => w.kind === kind)) continue;
        const s = first(startKind, jdStart);
        const e = s === null ? null : first(endKind, s);
        if (s !== null && e !== null) found.push({ kind, start: s, end: e });
      }
      found.sort((a, b) => a.start - b.start);
      const windows: TwilightPlan[] = found.map((w) => {
        const t = Math.max(w.start, jdStart);
        const sun = sunAlt(t);
        let limit = Math.min(3, Math.max(1.5, 1.5 + ((-6 - sun) / 6) * 1.5));
        const notes: string[] = [
          `brightness limit ${limit.toFixed(1)} mag with the Sun at ${sun.toFixed(1)} deg (1.5 at -6 deg, 3.0 at -12 deg: a planning rule of thumb, not a sky-brightness model)`,
          'MOCK engine: illustrative predictions from low-precision formulas.',
        ];
        const state = engine.skyState(place, t, 'navigational').bodies.filter((b) => b.kind !== 'sun');
        const high = state.filter((b) => b.hc_deg >= 15 && b.hc_deg <= 75);
        let eligible = high.filter((b) => (b.magnitude ?? -30) <= limit);
        if (eligible.length < 3) {
          limit = 3;
          eligible = high.filter((b) => (b.magnitude ?? -30) <= limit);
          notes.push('fewer than three bodies were bright enough, so every navigational body up to magnitude 3.0 was considered');
        }
        const pool = [...eligible].sort((a, b) => (a.magnitude ?? -30) - (b.magnitude ?? -30)).slice(0, 12);
        const aimed = pool.map((b) => ({ body: b.body, zn_deg: b.zn_deg, sigma_arcmin: 1, state: b }));
        let chosen: typeof aimed = [];
        if (aimed.length >= 3) {
          const size = Math.min(5, aimed.length);
          let best = Number.POSITIVE_INFINITY;
          for (const sub of subsets(aimed, size)) {
            const v = spreadObjective(sub);
            if (v < best) {
              best = v;
              chosen = sub;
            }
          }
        } else chosen = aimed;
        const { order, progression, scores } = greedyOrder(chosen);
        const plannedBodies: SightPlannedBody[] = order.map((b, i) => ({
          body: b.body,
          altitude_deg: b.state.hc_deg,
          azimuth_deg: b.zn_deg,
          score: scores[i]!,
          rationale: `azimuth ${b.zn_deg.toFixed(0)} deg: chosen for the spread round the horizon (MOCK)`,
          step: i + 1,
          score_units: 'm (trace sigma after this pick, negated)',
          score_basis: 'objective',
          sigma_arcmin: 1,
          magnitude: b.state.magnitude,
        }));
        const sights: RecommendedSight[] = order.map((b, i) => {
          const limb: SightLimb = b.body === 'Moon' ? 'lower' : 'center';
          const prediction = tools.predictSextant(full, instrument, b.body, limb, t);
          return {
            body: b.body,
            kind: b.state.kind === 'moon' ? 'moon' : b.state.kind === 'planet' ? 'planet' : 'star',
            magnitude: b.state.magnitude,
            step: i + 1,
            limb,
            hc_deg: prediction.hc_deg,
            zn_deg: prediction.zn_deg,
            hs_deg: prediction.hs_deg,
            rationale: plannedBodies[i]!.rationale,
            prediction,
          };
        });
        notes.push(`${order.length} chosen from ${eligible.length} eligible bodies for the best spread round the horizon`);
        const metrics = (m: PlanMetrics): SightPlanMetrics => m;
        return {
          kind: w.kind,
          jd_start: w.start,
          utc_start: isoUtc(w.start),
          jd_end: w.end,
          utc_end: isoUtc(w.end),
          jd_predicted: t,
          utc_predicted: isoUtc(t),
          sun_altitude_deg: sun,
          limiting_magnitude: limit,
          sights,
          also_eligible: eligible.filter((b) => !order.some((o) => o.body === b.body)).map((b) => b.body),
          plan: {
            approximate_position: place,
            utc: isoUtc(t),
            bodies: plannedBodies,
            notes: [`approximate position supplied: ${place.lat_deg.toFixed(4)}, ${place.lon_deg.toFixed(4)}: ranking is only as good as it`, 'MOCK planner'],
            objective: 'min_trace',
            baseline: metrics(planMetrics([])),
            predicted: metrics(planMetrics(order)),
            progression: progression.map(metrics),
            excluded: [],
          },
          notes,
        };
      });
      return {
        observer: full,
        jd_start: jdStart,
        utc_start: isoUtc(jdStart),
        jd_end: jdEnd,
        utc_end: isoUtc(jdEnd),
        windows,
        notes: [
          "nautical twilight: the Sun's centre between -6 and -12 degrees (CONVENTIONS 13.3-13.4)",
          'predictions are for the start of each window; the bodies move up to 15 degrees an hour, so recompute before a late sight',
          'MOCK engine: illustrative numbers.',
        ],
      };
    },
  };

  return tools;
}

// ---------------------------------------------------------------------------------------
// A synchronous least squares for the mock running fix (the old mock adapter's model)
// ---------------------------------------------------------------------------------------

function defaultSolve(): SolveOptions {
  return {
    initializer: null,
    prior: null,
    estimate_shared_bias: false,
    robust: null,
    clock_uncertainty_s: 0,
    posterior_scaling: false,
    multistart: { enabled: true, grid_step_deg: 10, cluster_radius_nm: 10, ambiguity_delta_chi2: CHI2_95_2DOF },
    max_iterations: 50,
    step_tolerance_rad: 1e-9,
  };
}

interface Line {
  id: string;
  body: string;
  gha_deg: number;
  dec_deg: number;
  ho_deg: number;
  sigma_arcmin: number;
}

/**
 * Weighted Gauss-Newton on the sphere for fully corrected sights with supplied directions:
 * one sight is underdetermined, two are ambiguous (both circle intersections), three or more
 * give a fix with its a priori covariance. The old mock adapter's model, run inline.
 */
export function mockSolveSync(session: Session, options: SolveOptions): FixResult {
  const lines: Line[] = session.observations
    .filter((o) => o.geocentric)
    .map((o) => ({ id: o.id, body: o.body, gha_deg: o.geocentric!.gha_deg, dec_deg: o.geocentric!.dec_deg, ho_deg: o.altitude_deg, sigma_arcmin: o.sigma_arcmin }));
  const circles = lines.map((l) => ({ id: l.id, body: l.body, gp: geographicPosition(l.gha_deg, l.dec_deg), zenith_distance_deg: 90 - l.ho_deg }));
  if (lines.length === 0) return { kind: 'failed', reason: 'no usable sights', warnings: [MOCK_NOTE] };
  if (lines.length === 1) {
    return {
      kind: 'underdetermined',
      circles,
      reason: '1 usable sight: the Jacobian has rank 1, so position is constrained to a circle, not a point',
      warnings: [{ code: 'ellipse_suppressed', reason: 'a single altitude constrains position to a circle, not to a point' }, MOCK_NOTE],
    };
  }
  if (lines.length === 2) {
    const pair = twoCircleIntersections(circles[0]!.gp, circles[0]!.zenith_distance_deg, circles[1]!.gp, circles[1]!.zenith_distance_deg);
    if (!pair) return { kind: 'failed', reason: 'the two circles of position do not intersect', warnings: [MOCK_NOTE] };
    return {
      kind: 'ambiguous',
      candidates: pair.map((position) => ({ position, chi2: 0, delta_chi2_from_best: 0, converged: true, iterations: 1, shared_bias_arcmin: null })),
      circles,
      warnings: [{ code: 'ellipse_suppressed', reason: '2 minima within delta chi2 5.991: no candidate is promoted' }, MOCK_NOTE],
    };
  }
  let position: LatLon = options.initializer ?? session.observer.assumed_position ?? circles[0]!.gp;
  let iterations = 0;
  let converged = false;
  for (let it = 0; it < options.max_iterations; it += 1) {
    iterations = it + 1;
    let a = 0;
    let b = 0;
    let c = 0;
    let gn = 0;
    let ge = 0;
    for (const l of lines) {
      const r = altitudeAzimuthDeg(position, l.gha_deg, l.dec_deg);
      const res = (l.ho_deg - r.altitude_deg) * D2R;
      const w = 1 / ((l.sigma_arcmin / 60) * D2R) ** 2;
      const jn = Math.cos(r.azimuth_deg * D2R);
      const je = Math.sin(r.azimuth_deg * D2R);
      a += w * jn * jn;
      b += w * jn * je;
      c += w * je * je;
      gn += w * jn * res;
      ge += w * je * res;
    }
    const det = a * c - b * b;
    if (!(Math.abs(det) > 1e-12)) break;
    const dN = (c * gn - b * ge) / det;
    const dE = (a * ge - b * gn) / det;
    const size = Math.hypot(dN, dE);
    position = pointToLatLon(destination(pointFromDeg(position.lat_deg, position.lon_deg), Math.atan2(dE, dN), size));
    if (size < options.step_tolerance_rad) {
      converged = true;
      break;
    }
  }
  const residuals: Residual[] = [];
  const zns: number[] = [];
  let a = 0;
  let b = 0;
  let c = 0;
  let chi2 = 0;
  for (const l of lines) {
    const r = altitudeAzimuthDeg(position, l.gha_deg, l.dec_deg);
    const res = (l.ho_deg - r.altitude_deg) * 60;
    chi2 += (res / l.sigma_arcmin) ** 2;
    zns.push(r.azimuth_deg);
    residuals.push({ id: l.id, body: l.body, hc_deg: r.altitude_deg, zn_deg: r.azimuth_deg, residual_arcmin: res, normalized: res / l.sigma_arcmin, weight: 1, intercept_nm: res });
    const w = 1 / l.sigma_arcmin ** 2;
    const jn = Math.cos(r.azimuth_deg * D2R);
    const je = Math.sin(r.azimuth_deg * D2R);
    a += w * jn * jn;
    b += w * jn * je;
    c += w * je * je;
  }
  const det = a * c - b * b;
  const m2 = NM_M * NM_M;
  const cov: [[number, number], [number, number]] = [
    [(c / det) * m2, (-b / det) * m2],
    [(-b / det) * m2, (a / det) * m2],
  ];
  const metrics = planMetrics(lines.map((l, i) => ({ zn_deg: zns[i]!, sigma_arcmin: l.sigma_arcmin })));
  const warnings: Warning[] = [MOCK_NOTE];
  const ok = converged && !metrics.singular && (metrics.condition_number ?? Infinity) < 1e6;
  let ellipse: ErrorEllipse | null = null;
  if (ok) {
    const { values, vectors } = eigen2(cov);
    let orientation = Math.atan2(vectors[0][1], vectors[0][0]) * R2D;
    orientation = ((orientation % 180) + 180) % 180;
    ellipse = {
      semi_major_m: Math.sqrt(Math.max(CHI2_95_2DOF * values[0], 0)),
      semi_minor_m: Math.sqrt(Math.max(CHI2_95_2DOF * values[1], 0)),
      orientation_deg: orientation,
      confidence: 0.95,
      model: 'nominal 95 %, independent-noise model',
    };
  } else {
    warnings.push({ code: 'ellipse_suppressed', reason: converged ? 'the geometry is too ill-conditioned for a meaningful ellipse' : 'the solver did not converge' });
  }
  if (!converged) warnings.push({ code: 'not_converged', iterations });
  return {
    kind: 'unique',
    circles,
    fix: {
      position,
      shared_bias_arcmin: null,
      covariance_ne_m2: cov,
      sigma_north_m: Math.sqrt(Math.max(cov[0][0], 0)),
      sigma_east_m: Math.sqrt(Math.max(cov[1][1], 0)),
      clock_sigma_east_m: 0,
      ellipse95: ellipse,
      ellipse_suppressed_reason: ellipse ? null : 'rank or conditioning does not support a nominal ellipse',
      posterior_scaled: null,
      residuals,
      chi2,
      dof: lines.length - 2,
      conditioning: {
        singular_values: [],
        condition_number: metrics.condition_number,
        rank: metrics.rank,
        geometric_dilution_m_per_arcmin: metrics.geometric_dilution_m_per_arcmin,
        max_azimuth_gap_deg: metrics.max_azimuth_gap_deg,
        columns: 'position (north, east)',
      },
      iterations,
      converged,
      prior: null,
      robust: null,
    },
    alternatives: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------------------
// The session adapter for the mock (SkyfixApi)
// ---------------------------------------------------------------------------------------

/**
 * A `SkyfixApi` for the Navigate view in mock mode: the old mock adapter (`src/api/mock.ts`)
 * for parsing, solving, the simulator and the demos, with this module's reduction so a
 * sight named by body gets a (mock) direction, as `ephemeris_mode = "auto"` does in the core.
 */
export function createMockSessionApi(engine: ExplorerEngine): SkyfixApi {
  const legacy = new MockApi();
  const nav = engine.nav ?? createMockNav(engine);
  const reduceEntries = (session: Session, mode: ApiEphemerisMode): ReduceEntry[] =>
    session.observations.map((obs): ReduceEntry => {
      try {
        return { status: 'ok', sight: mockReduceObservation(engine, session, obs, mode) };
      } catch (error) {
        return { status: 'error', id: obs.id, message: error instanceof Error ? error.message : String(error) };
      }
    });
  return {
    kind: 'mock',
    description:
      'MOCK session adapter for the Navigate view: low-precision directions from the mock explorer engine, the correction chain in TypeScript, and the old mock adapter\'s least squares. Illustrative only.',
    init: () => legacy.init(),
    version: async () => '0.0.0-mock',
    parseSession: (json: string): Promise<ParsedSession> => legacy.parseSession(json),
    async reduce(session, mode) {
      return reduceEntries(session, mode);
    },
    async solve(session, options, mode): Promise<FixResult> {
      const entries = reduceEntries(session, mode);
      const ok = entries.filter((e): e is Extract<ReduceEntry, { status: 'ok' }> => e.status === 'ok');
      const rejected = entries.filter((e): e is Extract<ReduceEntry, { status: 'error' }> => e.status === 'error');
      if (ok.length === 0) {
        return {
          kind: 'failed',
          reason: rejected.length
            ? `every observation was rejected before the solver: ${rejected.map((r) => r.message).join('; ')}`
            : 'the session has no observations',
          warnings: [MOCK_NOTE],
        };
      }
      const converted: Session = {
        ...session,
        observations: ok.map(({ sight }) => ({
          id: sight.id,
          body: sight.body,
          utc: sight.utc,
          altitude_deg: sight.ho_deg,
          altitude_kind: 'observed_ho',
          sigma_arcmin: sight.sigma_arcmin,
          limb: 'center',
          horizon: null,
          geocentric: { gha_deg: sight.gha_deg, dec_deg: sight.dec_deg, semidiameter_arcmin: 0, horizontal_parallax_arcmin: 0 },
          notes: '',
        })),
      };
      const result = await legacy.solve(converted, options, 'supplied');
      result.warnings.push(MOCK_NOTE, ...rejected.map((r): Warning => ({ code: 'other', message: `${r.message}. This sight was not used in the fix.` })));
      return result;
    },
    async circlePoints(latGp, lonGp, zenithDistanceDeg, n) {
      return circleOfPosition({ lat_deg: latGp, lon_deg: lonGp }, zenithDistanceDeg, n).map((p) => [p.lat_deg, p.lon_deg] as [number, number]);
    },
    simulate: (scenario) => legacy.simulate(scenario),
    demos: () => legacy.demos(),
    experiment: (experiment) => legacy.experiment(experiment),
    async catalog() {
      return nav.sightBodies().map((b) => b.body);
    },
    async coverage(): Promise<CoverageReport> {
      const c = engine.coverage();
      return {
        providers: c.groups.map((g) => ({
          provider: g.provider,
          start_utc: c.start_utc,
          end_utc: c.end_utc,
          bodies: g.bodies ?? [],
          notes: g.notes,
          accuracy_arcmin: g.accuracy_arcmin ?? 0,
        })),
        modes: ['supplied', 'auto'],
      };
    },
    async plan(position: LatLon, utc: string, options: PlanOptions): Promise<Plan> {
      const jd = jdOf(utc, 'utc');
      const state = engine.skyState(position, jd, 'navigational').bodies.filter((b) => b.kind !== 'sun');
      const excluded = state
        .filter((b) => b.hc_deg < options.min_altitude_deg || b.hc_deg > options.max_altitude_deg)
        .map((b) => ({ body: b.body, altitude_deg: b.hc_deg, azimuth_deg: b.zn_deg, reason: b.hc_deg < options.min_altitude_deg ? `below ${options.min_altitude_deg} deg` : `above ${options.max_altitude_deg} deg` }));
      const pool = state
        .filter((b) => b.hc_deg >= options.min_altitude_deg && b.hc_deg <= options.max_altitude_deg)
        .map((b) => ({ body: b.body, zn_deg: b.zn_deg, sigma_arcmin: options.base_sigma_arcmin, state: b }));
      const taken = options.already_taken.map((t) => ({ body: t.body, zn_deg: t.azimuth_deg, sigma_arcmin: t.sigma_arcmin }));
      const chosen: typeof pool = [];
      const progression: PlanMetrics[] = [planMetrics(taken)];
      const bodies: PlannedBody[] = [];
      while (chosen.length < options.select && pool.length) {
        let best = 0;
        let bestScore = Number.POSITIVE_INFINITY;
        pool.forEach((cand, i) => {
          const m = planMetrics([...taken, ...chosen, cand]);
          const score = m.trace_sigma_m ?? 1e12 - azimuthGap([...taken, ...chosen, cand].map((x) => x.zn_deg));
          if (score < bestScore) {
            bestScore = score;
            best = i;
          }
        });
        const [pick] = pool.splice(best, 1);
        chosen.push(pick!);
        const m = planMetrics([...taken, ...chosen]);
        progression.push(m);
        bodies.push({
          body: pick!.body,
          altitude_deg: pick!.state.hc_deg,
          azimuth_deg: pick!.zn_deg,
          score: m.trace_sigma_m ?? Number.NaN,
          rationale: `azimuth ${pick!.zn_deg.toFixed(0)} deg fills the widest gap left by the bodies above it (MOCK)`,
          step: chosen.length,
          score_units: 'm (trace sigma after this pick)',
          score_basis: m.trace_sigma_m === null ? 'log_det_growth' : 'objective',
          sigma_arcmin: options.base_sigma_arcmin,
          magnitude: pick!.state.magnitude,
        });
      }
      return {
        approximate_position: position,
        utc,
        bodies,
        notes: [
          `approximate position supplied: ${position.lat_deg.toFixed(4)}, ${position.lon_deg.toFixed(4)}: ranking is only as good as it`,
          'geometric visibility only: no weather, no twilight model beyond the Sun-altitude flag',
          'MOCK planner: illustrative.',
        ],
        objective: options.objective,
        baseline: planMetrics(taken),
        predicted: planMetrics([...taken, ...chosen]),
        progression,
        excluded,
      };
    },
  };
}
