/**
 * MOCK ADAPTER — a UI development stand-in, NOT the numerical core.
 *
 * `skyfix-core`, `skyfix-ephemeris` and `skyfix-sim` are all real now, and `wasm.ts` is
 * what the application uses. This file survives for one purpose: working on the
 * interface with no WebAssembly build to hand (`npm run dev` before the first
 * `npm run wasm`, or `?api=mock`). It is never selected silently, and the header says
 * "MOCK adapter" the whole time it is active.
 *
 * It understands the real `skyfix_sim::scenario::Scenario`, but only the parts the
 * packaged demos use, and it refuses rather than approximates anything it cannot do:
 *
 * - `BodySource::Named` is refused — the mock has no star catalogue.
 * - a shared bias, robust weighting and priors are reported as unsupported, not faked.
 *
 * What it genuinely computes (spherical geometry, CONVENTIONS sections 2-3): circles of
 * position, two-circle intersections, the six-step correction chain, and a plain
 * weighted Gauss-Newton fit with its a priori covariance.
 */

import { BODY_NAMES, isStar } from '../bodies.js';
import { reduceAltitude, inverseToSextantReading } from '../corrections.js';
import {
  altitudeAzimuthDeg,
  circleOfPosition,
  destination,
  geographicPosition,
  norm180Deg,
  norm360,
  pointFromDeg,
  pointToLatLon,
  toDeg,
  toRad,
  twoCircleIntersections,
} from '../geometry.js';
import type {
  CircleOfPosition,
  Conditioning,
  ErrorEllipse,
  FixResult,
  LatLon,
  Observation,
  ReducedSight,
  Residual,
  Session,
  SolveOptions,
  Truth,
  Warning,
} from '../types.js';
import { NM_M, SESSION_SCHEMA, TRUTH_SCHEMA, CHI2_95_2DOF } from '../types.js';
import type {
  Aggregate,
  BodySource,
  CoverageReport,
  DemoEntry,
  EphemerisMode,
  Experiment,
  ExperimentSummary,
  ParsedSession,
  ReduceEntry,
  Plan,
  PlanOptions,
  RunRecord,
  Scenario,
  SimulationOutput,
  SkyfixApi,
} from './adapter.js';
import { MOCK_DEMOS } from './mockDemos.js';
import { FAILED_FIX } from './fixtures.js';

const SIDEREAL_RATE_DEG_PER_HOUR = 15.04106864;

// ---------------------------------------------------------------------------
// Deterministic pseudo-random numbers (mulberry32 + Box-Muller)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng: () => number): number {
  const u = Math.max(rng(), Number.EPSILON);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// ---------------------------------------------------------------------------
// Session defaults and light validation (the core owns the canonical parser)
// ---------------------------------------------------------------------------

export function emptySession(name = 'Untitled session'): Session {
  return {
    schema: SESSION_SCHEMA,
    meta: { name, notes: '', kind: 'simulated' },
    observer: {
      height_of_eye_m: 2,
      pressure_hpa: 1010,
      temperature_c: 10,
      assumed_position: { lat_deg: 40, lon_deg: -75 },
      assumed_position_role: { role: 'initializer' },
    },
    instrument: { name: '', index_correction_arcmin: 0, horizon: 'sea' },
    clock: { uncertainty_s: 0, correction_s: 0 },
    observations: [],
  };
}

const RFC3339_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Fill serde's defaults so a hand-written or partial document loads. */
export function withDefaults(raw: unknown): Session {
  const base = emptySession();
  const s = (raw ?? {}) as Partial<Session>;
  const meta = { ...base.meta, ...(s.meta ?? {}) };
  const observer = { ...base.observer, ...(s.observer ?? {}) };
  const instrument = { ...base.instrument, ...(s.instrument ?? {}) };
  const clock = { ...base.clock, ...(s.clock ?? {}) };
  const observations = (s.observations ?? []).map(
    (o: Partial<Observation>, i: number): Observation => ({
      id: o.id ?? `obs-${i + 1}`,
      body: o.body ?? '',
      utc: o.utc ?? '',
      altitude_deg: Number(o.altitude_deg ?? 0),
      altitude_kind: o.altitude_kind ?? 'sextant_hs',
      sigma_arcmin: Number(o.sigma_arcmin ?? 1),
      limb: o.limb ?? 'center',
      horizon: o.horizon ?? null,
      geocentric: o.geocentric
        ? {
            gha_deg: Number(o.geocentric.gha_deg),
            dec_deg: Number(o.geocentric.dec_deg),
            semidiameter_arcmin: Number(o.geocentric.semidiameter_arcmin ?? 0),
            horizontal_parallax_arcmin: Number(o.geocentric.horizontal_parallax_arcmin ?? 0),
          }
        : null,
      notes: o.notes ?? '',
    }),
  );
  return { schema: s.schema ?? SESSION_SCHEMA, meta, observer, instrument, clock, observations };
}

function validate(session: Session): Warning[] {
  const warnings: Warning[] = [];
  if (session.schema !== SESSION_SCHEMA) {
    throw new Error(
      `unsupported session schema ${JSON.stringify(session.schema)} (expected ${JSON.stringify(SESSION_SCHEMA)})`,
    );
  }
  const seen = new Map<string, number>();
  for (const o of session.observations) {
    if (!o.id) throw new Error('every observation needs an id');
    seen.set(o.id, (seen.get(o.id) ?? 0) + 1);
    if (!Number.isFinite(o.altitude_deg)) throw new Error(`${o.id}: altitude is not finite`);
    if (o.altitude_deg < -90 || o.altitude_deg > 90) {
      throw new Error(`${o.id}: altitude_deg ${o.altitude_deg} is outside [-90, 90]`);
    }
    if (!(o.sigma_arcmin > 0)) throw new Error(`${o.id}: sigma_arcmin must be greater than zero`);
    if (o.utc && !RFC3339_Z.test(o.utc)) {
      throw new Error(`${o.id}: ${JSON.stringify(o.utc)} is not RFC 3339 UTC with a trailing Z`);
    }
    if (isStar(o.body) && o.limb !== 'center') {
      warnings.push({ code: 'limb_ignored_for_star', id: o.id });
    }
    if (o.geocentric) warnings.push({ code: 'supplied_direction_used', id: o.id });
    if (o.altitude_kind === 'observed_ho') {
      warnings.push({
        code: 'already_corrected',
        id: o.id,
        kind: 'observed_ho',
        ignored: ['refraction', 'semidiameter', 'parallax'],
      });
    }
  }
  const duplicates = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (duplicates.length > 0) throw new Error(`duplicate observation id ${duplicates.join(', ')}`);

  // Sights with the same body within a minute of each other carry no new information.
  const byBody = new Map<string, string[]>();
  for (const o of session.observations) {
    const key = `${o.body}|${o.utc.slice(0, 16)}`;
    byBody.set(key, [...(byBody.get(key) ?? []), o.id]);
  }
  for (const ids of byBody.values()) {
    if (ids.length > 1) warnings.push({ code: 'duplicate_observation', ids });
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Reduction
// ---------------------------------------------------------------------------

function reduceEntries(session: Session, mode: EphemerisMode): ReduceEntry[] {
  return session.observations.map((obs): ReduceEntry => {
    if (!obs.geocentric) {
      return {
        status: 'error',
        id: obs.id,
        message:
          mode === 'supplied'
            ? `observation ${obs.id}: no body direction available: supply gha_deg/dec_deg in the observation`
            : `observation ${obs.id}: no body direction available: the mock adapter has no ephemeris provider`,
      };
    }
    const corrections = reduceAltitude(session, obs);
    const warnings: Warning[] = [{ code: 'supplied_direction_used', id: obs.id }];
    const ap = session.observer.assumed_position;
    let hc: number | null = null;
    let zn: number | null = null;
    let intercept: number | null = null;
    if (ap && session.observer.assumed_position_role.role !== 'disabled') {
      const r = altitudeAzimuthDeg(ap, obs.geocentric.gha_deg, obs.geocentric.dec_deg);
      hc = r.altitude_deg;
      zn = r.azimuth_deg;
      intercept = (corrections.ho_deg - hc) * 60;
    }
    const sight: ReducedSight = {
      id: obs.id,
      body: obs.body,
      utc: obs.utc,
      jd_utc: julianDate(obs.utc) + session.clock.correction_s / 86400,
      gha_deg: obs.geocentric.gha_deg,
      dec_deg: obs.geocentric.dec_deg,
      direction_source: 'supplied',
      ho_deg: corrections.ho_deg,
      sigma_arcmin: corrections.sigma_ho_arcmin,
      corrections,
      hc_deg: hc,
      zn_deg: zn,
      intercept_nm: intercept,
      warnings,
      horizontal_parallax_arcmin: obs.geocentric.horizontal_parallax_arcmin,
      // The classic mock reduces stars and the Sun only: no Moon Earth-shape term.
      earth_shape_arcmin: null,
    };
    return { status: 'ok', sight };
  });
}

/** Julian date from an RFC 3339 UTC string. NaN-safe: unparseable becomes 0. */
export function julianDate(utc: string): number {
  const ms = Date.parse(utc);
  if (!Number.isFinite(ms)) return 0;
  return ms / 86400000 + 2440587.5;
}

// ---------------------------------------------------------------------------
// A small weighted Gauss-Newton fit. Not the core solver; see the file header.
// ---------------------------------------------------------------------------

interface MockSight {
  id: string;
  body: string;
  gha_deg: number;
  dec_deg: number;
  ho_deg: number;
  sigma_arcmin: number;
}

function sightsFrom(session: Session): MockSight[] {
  return reduceEntries(session, 'supplied')
    .filter((e): e is Extract<ReduceEntry, { status: 'ok' }> => e.status === 'ok')
    .map((e) => ({
      id: e.sight.id,
      body: e.sight.body,
      gha_deg: e.sight.gha_deg,
      dec_deg: e.sight.dec_deg,
      ho_deg: e.sight.ho_deg,
      sigma_arcmin: e.sight.sigma_arcmin,
    }));
}

function circlesFor(sights: MockSight[]): CircleOfPosition[] {
  return sights.map((s) => ({
    id: s.id,
    body: s.body,
    gp: geographicPosition(s.gha_deg, s.dec_deg),
    zenith_distance_deg: 90 - s.ho_deg,
  }));
}

function azimuthGap(azimuthsDeg: number[]): number {
  if (azimuthsDeg.length === 0) return 360;
  if (azimuthsDeg.length === 1) return 360;
  const sorted = [...azimuthsDeg].map(norm360).sort((a, b) => a - b);
  let gap = 360 - sorted[sorted.length - 1]! + sorted[0]!;
  for (let i = 1; i < sorted.length; i++) gap = Math.max(gap, sorted[i]! - sorted[i - 1]!);
  return gap;
}

/** Symmetric 2x2 eigen-decomposition; returns eigenvalues descending with vectors. */
export function eigen2(
  m: [[number, number], [number, number]],
): { values: [number, number]; vectors: [[number, number], [number, number]] } {
  const [a, b] = [m[0][0], m[0][1]];
  const d = m[1][1];
  const tr = a + d;
  const det = a * d - b * b;
  const disc = Math.sqrt(Math.max(tr * tr / 4 - det, 0));
  const l1 = tr / 2 + disc;
  const l2 = tr / 2 - disc;
  const vec = (l: number): [number, number] => {
    if (Math.abs(b) > 1e-18) {
      const v: [number, number] = [b, l - a];
      const n = Math.hypot(v[0], v[1]);
      return [v[0] / n, v[1] / n];
    }
    return a >= d ? (l === l1 ? [1, 0] : [0, 1]) : l === l1 ? [0, 1] : [1, 0];
  };
  return { values: [l1, l2], vectors: [vec(l1), vec(l2)] };
}

function ellipseFrom(cov: [[number, number], [number, number]]): ErrorEllipse {
  const { values, vectors } = eigen2(cov);
  // vectors are (north, east); the ellipse orientation is the azimuth of the major axis.
  const major = vectors[0];
  let orientation = toDeg(Math.atan2(major[1], major[0]));
  orientation = ((orientation % 180) + 180) % 180;
  return {
    semi_major_m: Math.sqrt(Math.max(CHI2_95_2DOF * values[0], 0)),
    semi_minor_m: Math.sqrt(Math.max(CHI2_95_2DOF * values[1], 0)),
    orientation_deg: orientation,
    confidence: 0.95,
    model: 'nominal 95 %, independent-noise model',
  };
}

function gaussNewton(
  sights: MockSight[],
  start: LatLon,
  maxIterations: number,
): { position: LatLon; iterations: number; converged: boolean } {
  let position = { ...start };
  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    let a = 0;
    let bb = 0;
    let c = 0;
    let gN = 0;
    let gE = 0;
    for (const s of sights) {
      const r = altitudeAzimuthDeg(position, s.gha_deg, s.dec_deg);
      const residual = toRad(s.ho_deg - r.altitude_deg);
      const w = 1 / toRad(s.sigma_arcmin / 60) ** 2;
      const jn = Math.cos(toRad(r.azimuth_deg));
      const je = Math.sin(toRad(r.azimuth_deg));
      a += w * jn * jn;
      bb += w * jn * je;
      c += w * je * je;
      gN += w * jn * residual;
      gE += w * je * residual;
    }
    const det = a * c - bb * bb;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
    const dN = (c * gN - bb * gE) / det;
    const dE = (a * gE - bb * gN) / det;
    const stepSize = Math.hypot(dN, dE);
    const moved = destination(
      pointFromDeg(position.lat_deg, position.lon_deg),
      Math.atan2(dE, dN),
      stepSize,
    );
    position = pointToLatLon(moved);
    if (stepSize < 1e-9) {
      converged = true;
      break;
    }
  }
  return { position, iterations, converged };
}

function analyse(
  sights: MockSight[],
  position: LatLon,
  options: SolveOptions,
): {
  residuals: Residual[];
  chi2: number;
  cov: [[number, number], [number, number]];
  conditioning: Conditioning;
} {
  const residuals: Residual[] = [];
  const azimuths: number[] = [];
  let a = 0;
  let b = 0;
  let c = 0;
  let ua = 0;
  let ub = 0;
  let uc = 0;
  let chi2 = 0;
  for (const s of sights) {
    const r = altitudeAzimuthDeg(position, s.gha_deg, s.dec_deg);
    const residualArcmin = (s.ho_deg - r.altitude_deg) * 60;
    const normalized = residualArcmin / s.sigma_arcmin;
    chi2 += normalized * normalized;
    azimuths.push(r.azimuth_deg);
    residuals.push({
      id: s.id,
      body: s.body,
      hc_deg: r.altitude_deg,
      zn_deg: r.azimuth_deg,
      residual_arcmin: residualArcmin,
      normalized,
      weight: 1,
      intercept_nm: residualArcmin,
    });
    const jn = Math.cos(toRad(r.azimuth_deg));
    const je = Math.sin(toRad(r.azimuth_deg));
    const w = 1 / (s.sigma_arcmin / 60) ** 2; // degrees^-2; units cancel below.
    a += w * jn * jn;
    b += w * jn * je;
    c += w * je * je;
    ua += jn * jn;
    ub += jn * je;
    uc += je * je;
  }
  const det = a * c - b * b;
  // Covariance in degrees^2 of arc, converted to metres^2 (1 arcmin of arc = 1 NM).
  const degToM = (60 * NM_M) ** 2;
  const cov: [[number, number], [number, number]] =
    Math.abs(det) > 1e-18
      ? [
          [(c / det) * degToM, (-b / det) * degToM],
          [(-b / det) * degToM, (a / det) * degToM],
        ]
      : [
          [Infinity, 0],
          [0, Infinity],
        ];

  const info = eigen2([
    [a, b],
    [b, c],
  ]);
  const singular = info.values.map((v) => Math.sqrt(Math.max(v, 0)));
  const udet = ua * uc - ub * ub;
  const dilution = Math.abs(udet) > 1e-18 ? Math.sqrt((uc + ua) / udet) * NM_M : null;
  const conditioning: Conditioning = {
    singular_values: singular,
    // serde_json writes an infinite f64 as null, so the mock does too.
    condition_number: singular[1]! > 0 ? singular[0]! / singular[1]! : null,
    rank: singular.filter((v) => v > 1e-8 * (singular[0] || 1)).length,
    geometric_dilution_m_per_arcmin: dilution,
    max_azimuth_gap_deg: azimuthGap(azimuths),
    columns: 'position (north, east)',
  };

  // Clock uncertainty: a rank-1 east-west term (CONVENTIONS section 6).
  if (options.clock_uncertainty_s > 0 && Number.isFinite(cov[1][1])) {
    const sigmaEastDeg =
      Math.cos(toRad(position.lat_deg)) *
      SIDEREAL_RATE_DEG_PER_HOUR *
      (options.clock_uncertainty_s / 3600);
    cov[1][1] += (sigmaEastDeg * 60 * NM_M) ** 2;
  }

  return { residuals, chi2, cov, conditioning };
}

function mockSolve(session: Session, options: SolveOptions): FixResult {
  const sights = sightsFrom(session);
  const circles = circlesFor(sights);
  const warnings: Warning[] = [];

  if (session.meta.notes.includes('mock:failed')) return FAILED_FIX;

  if (sights.length === 0) {
    return {
      kind: 'failed',
      reason:
        'no usable sights: every observation was rejected before reaching the solver (the mock adapter needs a supplied geocentric direction on each)',
      warnings,
    };
  }

  if (sights.length === 1) {
    return {
      kind: 'underdetermined',
      circles,
      reason:
        '1 usable sight: the Jacobian has rank 1, so position is constrained to a circle, not a point',
      warnings: [
        {
          code: 'ellipse_suppressed',
          reason: 'a single altitude constrains position to a circle, not to a point',
        },
      ],
    };
  }

  if (sights.length === 2) {
    const pair = twoCircleIntersections(
      circles[0]!.gp,
      circles[0]!.zenith_distance_deg,
      circles[1]!.gp,
      circles[1]!.zenith_distance_deg,
    );
    if (!pair) {
      return {
        kind: 'failed',
        reason:
          'the two circles of position do not intersect: the sights are inconsistent with any single position',
        warnings,
      };
    }
    const geometry = analyse(sights, pair[0], options).conditioning;
    const ambiguityWarnings: Warning[] = [
      {
        code: 'ellipse_suppressed',
        reason:
          'two circles of position meet at two points and nothing in this session distinguishes them',
      },
    ];
    if (
      geometry.condition_number === null ||
      geometry.condition_number > 10 ||
      geometry.max_azimuth_gap_deg > 180
    ) {
      ambiguityWarnings.push({
        code: 'poor_geometry',
        condition_number: geometry.condition_number ?? Number.POSITIVE_INFINITY,
        max_azimuth_gap_deg: geometry.max_azimuth_gap_deg,
      });
    }
    return {
      kind: 'ambiguous',
      candidates: pair.map((position) => ({
        position,
        chi2: 0,
        delta_chi2_from_best: 0,
        converged: true,
        iterations: 1,
        shared_bias_arcmin: null,
      })),
      circles,
      warnings: ambiguityWarnings,
    };
  }

  const start =
    options.initializer ??
    session.observer.assumed_position ??
    circles[0]!.gp;
  const { position, iterations, converged } = gaussNewton(sights, start, options.max_iterations);
  const { residuals, chi2, cov, conditioning } = analyse(sights, position, options);

  if (options.estimate_shared_bias) {
    warnings.push({
      code: 'other',
      message:
        'The mock adapter does not estimate a shared altitude bias. Build the WASM package for that.',
    });
  }
  if (!converged) warnings.push({ code: 'not_converged', iterations });
  if (
    conditioning.condition_number === null ||
    conditioning.condition_number > 10 ||
    conditioning.max_azimuth_gap_deg > 180
  ) {
    warnings.push({
      code: 'poor_geometry',
      condition_number: conditioning.condition_number ?? Number.POSITIVE_INFINITY,
      max_azimuth_gap_deg: conditioning.max_azimuth_gap_deg,
    });
  }
  const clockSigmaEast =
    options.clock_uncertainty_s > 0
      ? Math.cos(toRad(position.lat_deg)) *
        SIDEREAL_RATE_DEG_PER_HOUR *
        (options.clock_uncertainty_s / 3600) *
        60 *
        NM_M
      : 0;
  if (clockSigmaEast > 0) {
    warnings.push({ code: 'clock_degenerate_with_longitude', sigma_east_m: clockSigmaEast });
  }
  const dof = sights.length - 2;
  if (options.posterior_scaling && dof < 3) {
    warnings.push({ code: 'posterior_scaling_skipped', dof });
  }

  const wellConditioned =
    converged &&
    conditioning.rank === 2 &&
    conditioning.condition_number !== null &&
    conditioning.condition_number < 1e6;
  const ellipse = wellConditioned ? ellipseFrom(cov) : null;
  if (!ellipse) {
    warnings.push({
      code: 'ellipse_suppressed',
      reason: converged
        ? 'the normal matrix is too ill-conditioned for a meaningful ellipse'
        : 'the solver did not converge',
    });
  }

  return {
    kind: 'unique',
    circles,
    fix: {
      position,
      shared_bias_arcmin: null,
      covariance_ne_m2: cov,
      sigma_north_m: Math.sqrt(Math.max(cov[0][0], 0)),
      sigma_east_m: Math.sqrt(Math.max(cov[1][1], 0)),
      clock_sigma_east_m: clockSigmaEast,
      ellipse95: ellipse,
      ellipse_suppressed_reason: ellipse
        ? null
        : 'rank or conditioning does not support a nominal ellipse',
      posterior_scaled: null,
      residuals,
      chi2,
      dof,
      conditioning,
      iterations,
      converged,
      prior: null,
      robust: null,
    },
    alternatives: [],
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

/** Degrees of GHA per hour for a `supplied` source that does not say. */
const SIDEREAL_RATE = SIDEREAL_RATE_DEG_PER_HOUR;

function rfc3339(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The direction of a `supplied` source at `hoursFromStart`. */
function suppliedDirection(
  source: Extract<BodySource, { source: 'supplied' }>,
  hoursFromStart: number,
): { gha_deg: number; dec_deg: number } {
  const rate = Number.isFinite(source.gha_rate_deg_per_hour)
    ? source.gha_rate_deg_per_hour
    : SIDEREAL_RATE;
  return {
    gha_deg: norm360(source.gha_deg_at_start + rate * hoursFromStart),
    dec_deg: source.dec_deg,
  };
}

/** Azimuth of each source at the truth position and the start time. */
function startAzimuths(scenario: Scenario): number[] {
  return scenario.sources.map((source) => {
    if (source.source !== 'supplied') return Number.NaN;
    const d = suppliedDirection(source, 0);
    return altitudeAzimuthDeg(scenario.truth, d.gha_deg, d.dec_deg).azimuth_deg;
  });
}

/**
 * Apply the geometry preset. `clustered` keeps the largest set of bodies that fits in
 * one azimuth window; `well_spread` reorders by greedy farthest-point selection. Both
 * are evaluated at the truth position and the start time, as the Rust does.
 */
function applyGeometry(scenario: Scenario): number[] {
  const indices = scenario.sources.map((_, i) => i);
  const preset = scenario.geometry;
  if (preset.preset === 'as_given') return indices;
  const azimuths = startAzimuths(scenario);

  if (preset.preset === 'clustered') {
    let best: number[] = [];
    for (const anchor of azimuths) {
      if (!Number.isFinite(anchor)) continue;
      const kept = indices.filter((i) => {
        const gap = Math.abs(norm180Deg(azimuths[i]! - anchor));
        return gap <= preset.window_deg;
      });
      if (kept.length > best.length) best = kept;
    }
    if (best.length >= 2) return best;
    // No window holds two: keep the closest pair, a valid and very poor geometry.
    let pair: number[] = indices.slice(0, 2);
    let smallest = Infinity;
    for (let a = 0; a < indices.length; a++) {
      for (let b = a + 1; b < indices.length; b++) {
        const gap = Math.abs(norm180Deg(azimuths[a]! - azimuths[b]!));
        if (gap < smallest) {
          smallest = gap;
          pair = [a, b];
        }
      }
    }
    return pair;
  }

  // well_spread: greedy farthest point in azimuth.
  const remaining = [...indices];
  const order: number[] = [];
  order.push(remaining.shift()!);
  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestGap = -1;
    remaining.forEach((candidate, k) => {
      const gap = Math.min(
        ...order.map((chosen) => Math.abs(norm180Deg(azimuths[candidate]! - azimuths[chosen]!))),
      );
      if (gap > bestGap) {
        bestGap = gap;
        bestIndex = k;
      }
    });
    order.push(remaining.splice(bestIndex, 1)[0]!);
  }
  return preset.keep === null ? order : order.slice(0, Math.max(preset.keep, 1));
}

function assumedPositionOf(scenario: Scenario): LatLon | null {
  const mode = scenario.assumed_position.mode;
  switch (mode.mode) {
    case 'none':
      return null;
    case 'explicit':
      return { lat_deg: mode.lat_deg, lon_deg: mode.lon_deg };
    case 'truth':
      return { ...scenario.truth };
    case 'offset_from_truth':
      return pointToLatLon(
        destination(
          pointFromDeg(scenario.truth.lat_deg, scenario.truth.lon_deg),
          toRad(mode.bearing_deg),
          toRad(mode.distance_nm / 60),
        ),
      );
  }
}

/**
 * Generate a session and its truth from a real `Scenario`. Supports the subset the
 * packaged demos use; anything else throws with the reason.
 */
function mockSimulate(scenario: Scenario): SimulationOutput {
  const named = scenario.sources.find((s) => s.source === 'named');
  if (named) {
    throw new Error(
      `the mock adapter has no star catalogue, so it cannot resolve the body "${named.name}". ` +
        'Build the WebAssembly package (`npm run wasm --prefix web`) to run this scenario.',
    );
  }
  const reportedSigma = scenario.reported_sigma_arcmin ?? scenario.altitude_noise_arcmin;
  if (!(reportedSigma > 0)) {
    throw new Error(
      'a session needs sigma_arcmin > 0: set reported_sigma_arcmin when the scenario is noise-free',
    );
  }

  const rng = mulberry32(Number(BigInt.asUintN(32, BigInt(scenario.seed))));
  const chosen = applyGeometry(scenario);
  if (chosen.length === 0) throw new Error('the geometry preset kept no bodies');

  const emitted = scenario.altitude_kind;
  const session = emptySession(scenario.name);
  session.meta.kind = 'simulated';
  session.meta.notes =
    'Simulated session generated by the browser mock adapter, not by skyfix-sim. The ' +
    "observer's real position, the seed and the size of every effect are in a separate " +
    'truth document and are deliberately absent from this file.';
  session.observer.height_of_eye_m =
    emitted.kind === 'sextant_hs' ? emitted.height_of_eye_m : 0;
  session.observer.pressure_hpa = emitted.kind === 'sextant_hs' ? emitted.pressure_hpa : 1010;
  session.observer.temperature_c = emitted.kind === 'sextant_hs' ? emitted.temperature_c : 10;
  session.observer.assumed_position = assumedPositionOf(scenario);
  session.observer.assumed_position_role = scenario.assumed_position.role;
  session.instrument = {
    name: 'simulated',
    index_correction_arcmin:
      emitted.kind === 'sextant_hs' ? emitted.index_correction_arcmin : 0,
    horizon: 'sea',
  };
  session.clock = {
    uncertainty_s: scenario.reported_clock_uncertainty_s,
    correction_s: 0,
  };

  const startMs = Date.parse(scenario.start_utc);
  if (!Number.isFinite(startMs)) throw new Error(`start_utc ${scenario.start_utc} is not RFC 3339`);

  const count = scenario.schedule.count;
  const perBody = Math.ceil(count / chosen.length);
  const drop = Math.round(count * scenario.missing_fraction);
  // Which scheduled sights never make it into the session: spread through the run so a
  // gap is visible rather than a truncated tail.
  const dropped = new Set<number>();
  for (let k = 0; k < drop; k++) dropped.add(Math.floor(((k + 1) * count) / (drop + 1)));

  const observations: Observation[] = [];
  const truthAltitudes: number[] = [];
  for (let i = 0; i < count; i++) {
    if (dropped.has(i)) continue;
    const sourceIndex =
      scenario.schedule.ordering === 'round_robin'
        ? chosen[i % chosen.length]!
        : chosen[Math.min(Math.floor(i / perBody), chosen.length - 1)]!;
    const source = scenario.sources[sourceIndex] as Extract<BodySource, { source: 'supplied' }>;

    const trueMs = startMs + i * scenario.schedule.spacing_s * 1000;
    const recordedMs = trueMs + scenario.clock_offset_s * 1000;
    const trueHours = (trueMs - startMs) / 3600000;
    const lookupHours =
      scenario.almanac_lookup === 'recorded_time' ? (recordedMs - startMs) / 3600000 : trueHours;

    // The TRUE direction is at the true instant; the direction WRITTEN INTO the session
    // is at whichever instant `almanac_lookup` names. That difference is the clock
    // experiment (CONVENTIONS section 6).
    const trueDirection = suppliedDirection(source, trueHours);
    const recordedDirection = suppliedDirection(source, lookupHours);
    const trueAltitude = altitudeAzimuthDeg(
      scenario.truth,
      trueDirection.gha_deg,
      trueDirection.dec_deg,
    ).altitude_deg;
    truthAltitudes.push(trueAltitude);

    let ho = trueAltitude;
    ho += (scenario.altitude_noise_arcmin * gaussian(rng)) / 60;
    ho += scenario.shared_altitude_bias_arcmin / 60;

    const id = `obs-${observations.length + 1}`;
    observations.push({
      id,
      body: source.name,
      utc: rfc3339(recordedMs),
      altitude_deg: ho,
      altitude_kind: emitted.kind === 'sextant_hs' ? 'sextant_hs' : 'observed_ho',
      sigma_arcmin: reportedSigma,
      limb: 'center',
      horizon: null,
      geocentric: scenario.emit_supplied_directions
        ? {
            gha_deg: recordedDirection.gha_deg,
            dec_deg: recordedDirection.dec_deg,
            semidiameter_arcmin: 0,
            horizontal_parallax_arcmin: 0,
          }
        : null,
      notes: '',
    });
  }

  // The blunder indexes the EMITTED list, after anything was dropped.
  const wrongIds: string[] = [];
  if (scenario.wrong_sight) {
    const target = observations[scenario.wrong_sight.index];
    if (target) {
      target.altitude_deg += scenario.wrong_sight.error_arcmin / 60;
      wrongIds.push(target.id);
    }
  }

  // Raw sextant readings: run the correction chain backwards, last.
  if (emitted.kind === 'sextant_hs') {
    for (const obs of observations) {
      obs.altitude_deg = inverseToSextantReading(session, obs.altitude_deg, 'sea');
    }
  }
  for (const obs of observations) obs.altitude_deg = Number(obs.altitude_deg.toFixed(6));
  session.observations = observations;

  const truth: Truth = {
    schema: TRUTH_SCHEMA,
    session_name: scenario.name,
    position: { ...scenario.truth },
    seed: scenario.seed,
    clock_offset_s: scenario.clock_offset_s,
    shared_altitude_bias_arcmin: scenario.shared_altitude_bias_arcmin,
    wrong_sight_ids: wrongIds,
    notes:
      'Simulated truth from the browser mock adapter. Never read by the solver and never ' +
      'merged into the session (CONVENTIONS section 11).',
  };
  return { session, truth };
}

// ---------------------------------------------------------------------------
// Experiments: repetitions, coverage, and the Wilson interval
// ---------------------------------------------------------------------------

/** Wilson score interval for k successes in m trials, 95 %. */
export function wilsonInterval(k: number, m: number): [number, number] {
  if (m <= 0) return [0, 1];
  const z = 1.959963984540054;
  const p = k / m;
  const denom = 1 + (z * z) / m;
  const centre = (p + (z * z) / (2 * m)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / m + (z * z) / (4 * m * m))) / denom;
  return [Math.max(centre - half, 0), Math.min(centre + half, 1)];
}

function insideEllipse(fix: LatLon, truth: LatLon, ellipse: ErrorEllipse): boolean {
  const north = (truth.lat_deg - fix.lat_deg) * 60 * NM_M;
  const east =
    norm180Deg(truth.lon_deg - fix.lon_deg) * 60 * NM_M * Math.cos(toRad(fix.lat_deg));
  const t = toRad(ellipse.orientation_deg);
  const major = north * Math.cos(t) + east * Math.sin(t);
  const minor = -north * Math.sin(t) + east * Math.cos(t);
  return (major / ellipse.semi_major_m) ** 2 + (minor / ellipse.semi_minor_m) ** 2 <= 1;
}

function mockExperiment(experiment: Experiment): ExperimentSummary {
  const runs: RunRecord[] = [];
  const notes: string[] = [
    'Run by the browser mock adapter, not by skyfix_sim::experiment. Every number here is illustrative.',
  ];
  for (let i = 0; i < experiment.repetitions; i++) {
    const seed = experiment.scenario.seed + i;
    const record: RunRecord = {
      repetition: i,
      seed,
      result_kind: 'failed',
      converged: false,
      sights_used: 0,
      error_m: null,
      error_north_m: null,
      error_east_m: null,
      sigma_north_m: null,
      sigma_east_m: null,
      clock_sigma_east_m: null,
      ellipse_semi_major_m: null,
      ellipse_semi_minor_m: null,
      ellipse_orientation_deg: null,
      mahalanobis: null,
      inside_ellipse95: null,
      residual_rms_arcmin: null,
      max_abs_residual_arcmin: null,
      chi2: null,
      dof: null,
      shared_bias_arcmin: null,
      note: '',
    };
    try {
      const { session, truth } = mockSimulate({ ...experiment.scenario, seed });
      const result = mockSolve(session, experiment.solve_options);
      record.result_kind = result.kind;
      if (result.kind === 'unique') {
        const fix = result.fix;
        record.converged = fix.converged;
        record.sights_used = fix.residuals.length;
        const north = (truth.position.lat_deg - fix.position.lat_deg) * 60 * NM_M;
        const east =
          norm180Deg(truth.position.lon_deg - fix.position.lon_deg) *
          60 *
          NM_M *
          Math.cos(toRad(fix.position.lat_deg));
        record.error_north_m = north;
        record.error_east_m = east;
        record.error_m = Math.hypot(north, east);
        record.sigma_north_m = fix.sigma_north_m;
        record.sigma_east_m = fix.sigma_east_m;
        record.clock_sigma_east_m = fix.clock_sigma_east_m;
        record.chi2 = fix.chi2;
        record.dof = fix.dof;
        const residuals = fix.residuals.map((r) => r.residual_arcmin);
        record.residual_rms_arcmin = Math.sqrt(
          residuals.reduce((a, r) => a + r * r, 0) / Math.max(residuals.length, 1),
        );
        record.max_abs_residual_arcmin = Math.max(...residuals.map(Math.abs));
        if (fix.ellipse95) {
          record.ellipse_semi_major_m = fix.ellipse95.semi_major_m;
          record.ellipse_semi_minor_m = fix.ellipse95.semi_minor_m;
          record.ellipse_orientation_deg = fix.ellipse95.orientation_deg;
          record.inside_ellipse95 = insideEllipse(fix.position, truth.position, fix.ellipse95);
        }
      }
    } catch (error) {
      record.note = String(error);
    }
    runs.push(record);
  }

  const evaluated = runs.filter((r) => r.inside_ellipse95 !== null);
  const inside = evaluated.filter((r) => r.inside_ellipse95).length;
  const kinds = new Map<string, number>();
  for (const r of runs) kinds.set(r.result_kind, (kinds.get(r.result_kind) ?? 0) + 1);
  const errors = runs.map((r) => r.error_m).filter((v): v is number => v !== null);
  const sigmas = runs
    .map((r) => (r.sigma_north_m !== null && r.sigma_east_m !== null
      ? Math.hypot(r.sigma_north_m, r.sigma_east_m)
      : null))
    .filter((v): v is number => v !== null);
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
  const rms = (xs: number[]): number | null =>
    xs.length === 0 ? null : Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);
  const meanError = mean(errors);
  const meanSigma = mean(sigmas);

  const aggregate: Aggregate = {
    repetitions: experiment.repetitions,
    evaluated: evaluated.length,
    result_kind_counts: [...kinds.entries()],
    coverage_fraction: evaluated.length > 0 ? inside / evaluated.length : null,
    coverage_stderr:
      evaluated.length > 0
        ? Math.sqrt(
            ((inside / evaluated.length) * (1 - inside / evaluated.length)) / evaluated.length,
          )
        : null,
    coverage_ci95: evaluated.length > 0 ? wilsonInterval(inside, evaluated.length) : null,
    mean_error_m: meanError,
    rms_error_m: rms(errors),
    mean_error_north_m: mean(
      runs.map((r) => r.error_north_m).filter((v): v is number => v !== null),
    ),
    mean_error_east_m: mean(
      runs.map((r) => r.error_east_m).filter((v): v is number => v !== null),
    ),
    mean_predicted_sigma_m: meanSigma,
    rms_predicted_sigma_m: rms(sigmas),
    error_to_sigma_ratio:
      meanError !== null && meanSigma !== null && meanSigma > 0 ? meanError / meanSigma : null,
    mean_residual_rms_arcmin: mean(
      runs.map((r) => r.residual_rms_arcmin).filter((v): v is number => v !== null),
    ),
  };

  return {
    name: experiment.scenario.name,
    description: experiment.scenario.description,
    runs,
    aggregate,
    notes,
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class MockApi implements SkyfixApi {
  readonly kind = 'mock' as const;
  readonly description =
    'Browser mock adapter: spherical geometry is real, there is no star catalogue, and nothing here is a result. For UI development only.';

  async init(): Promise<void> {}

  async version(): Promise<string> {
    return '0.1.0-mock';
  }

  async parseSession(json: string): Promise<ParsedSession> {
    const session = withDefaults(JSON.parse(json));
    const warnings = validate(session);
    return { session, warnings };
  }

  async reduce(session: Session, mode: EphemerisMode): Promise<ReduceEntry[]> {
    return reduceEntries(session, mode);
  }

  async solve(session: Session, options: SolveOptions, _mode: EphemerisMode): Promise<FixResult> {
    return mockSolve(session, options);
  }

  async circlePoints(
    latGp: number,
    lonGp: number,
    zenithDistanceDeg: number,
    n: number,
  ): Promise<[number, number][]> {
    return circleOfPosition({ lat_deg: latGp, lon_deg: lonGp }, zenithDistanceDeg, n).map(
      (p) => [p.lat_deg, p.lon_deg] as [number, number],
    );
  }

  async simulate(scenario: Scenario): Promise<SimulationOutput> {
    return mockSimulate(scenario);
  }

  async demos(): Promise<DemoEntry[]> {
    return MOCK_DEMOS.map((scenario) => ({
      name: scenario.name,
      description: scenario.description,
      requires_provider: scenario.sources.some((s) => s.source === 'named'),
      scenario,
    }));
  }

  async experiment(experiment: Experiment): Promise<ExperimentSummary> {
    return mockExperiment(experiment);
  }

  async catalog(): Promise<string[]> {
    return [...BODY_NAMES];
  }

  async plan(_position: LatLon, _utc: string, _options: PlanOptions): Promise<Plan> {
    throw new Error(
      'the mock adapter has no astronomy, so it cannot say which bodies are up. ' +
        'Build the WebAssembly package (`npm run wasm --prefix web`) to use the planner.',
    );
  }

  async coverage(): Promise<CoverageReport> {
    return {
      providers: [
        {
          provider: 'mock (none)',
          start_utc: '',
          end_utc: '',
          bodies: [],
          notes:
            'The mock adapter has no astronomy at all. Every observation must carry its own apparent geocentric gha_deg / dec_deg, and any scenario naming a real body is refused.',
          accuracy_arcmin: 0,
        },
      ],
      modes: ['supplied'],
    };
  }
}

export { mockSolve, mockSimulate, mockExperiment, reduceEntries, validate, gaussNewton, azimuthGap };
