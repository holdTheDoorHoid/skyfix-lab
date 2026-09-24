/**
 * MOCK ADAPTER — not the numerical core.
 *
 * While `skyfix-core` is still `todo!()`, the UI runs against this. It produces JSON in
 * the exact contract shapes so that swapping in `wasm.ts` is a one-line change, and it
 * is deliberately loud about being a stand-in: the header shows "mock adapter" whenever
 * it is active and nothing it returns should be read as a navigational result.
 *
 * What is genuinely computed here (spherical geometry only, CONVENTIONS sections 2-3):
 * circles of position, two-circle intersections, and a plain weighted Gauss-Newton fit
 * with its a priori covariance. What is canned: the `failed` result, and anything that
 * needs an ephemeris.
 */

import { BODY_NAMES, isStar } from '../bodies.js';
import { reduceAltitude, inverseToSextantReading } from '../corrections.js';
import {
  altitudeAzimuthDeg,
  circleOfPosition,
  destination,
  geographicPosition,
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
  CoverageReport,
  EphemerisMode,
  ParsedSession,
  ReduceEntry,
  Scenario,
  SimulationOutput,
  SkyfixApi,
} from './adapter.js';
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
  const dilution =
    Math.abs(udet) > 1e-18 ? Math.sqrt((uc + ua) / udet) * NM_M : Number.POSITIVE_INFINITY;
  const conditioning: Conditioning = {
    singular_values: singular,
    condition_number: singular[1]! > 0 ? singular[0]! / singular[1]! : Number.POSITIVE_INFINITY,
    rank: singular.filter((v) => v > 1e-8 * (singular[0] || 1)).length,
    geometric_dilution_m_per_arcmin: dilution,
    max_azimuth_gap_deg: azimuthGap(azimuths),
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
    if (geometry.condition_number > 10 || geometry.max_azimuth_gap_deg > 180) {
      ambiguityWarnings.push({
        code: 'poor_geometry',
        condition_number: geometry.condition_number,
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
  if (conditioning.condition_number > 10 || conditioning.max_azimuth_gap_deg > 180) {
    warnings.push({
      code: 'poor_geometry',
      condition_number: conditioning.condition_number,
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

  const wellConditioned = converged && conditioning.rank === 2 && conditioning.condition_number < 1e6;
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

const PRESET_AZIMUTHS: Record<string, number[]> = {
  good: [35, 125, 215, 305, 80, 260],
  clustered: [100, 112, 124, 136, 148, 160],
  two_body: [45, 135],
  single_sight: [300],
  custom: [35, 125, 215, 305, 80, 260],
};

const PRESET_ALTITUDES = [61.2, 43.9, 28.4, 46.0, 35.2, 52.8];

function mockSimulate(scenario: Scenario): SimulationOutput {
  const rng = mulberry32(scenario.seed);
  const azimuths = PRESET_AZIMUTHS[scenario.geometry] ?? PRESET_AZIMUTHS['good']!;
  const wanted =
    scenario.geometry === 'two_body'
      ? 2
      : scenario.geometry === 'single_sight'
        ? 1
        : Math.max(1, Math.min(scenario.sight_count, azimuths.length));

  const session = emptySession(scenario.name || 'Simulated session');
  session.meta.kind = 'simulated';
  session.meta.notes =
    'Generated by the simulator. Every altitude in this session is synthetic.';
  session.observer.height_of_eye_m = scenario.height_of_eye_m;
  session.observer.assumed_position = { lat_deg: 40, lon_deg: -75 };
  session.observer.assumed_position_role = { role: 'initializer' };
  session.instrument = {
    name: 'simulated',
    index_correction_arcmin: scenario.index_correction_arcmin,
    horizon: scenario.horizon,
  };
  session.clock = { uncertainty_s: scenario.clock_uncertainty_s, correction_s: 0 };

  const truthPoint = scenario.truth_position;
  const wrongIds: string[] = [];
  const startMs = Date.parse(scenario.utc);
  const bodies =
    scenario.geometry === 'custom' && scenario.bodies.length > 0
      ? scenario.bodies
      : ['Vega', 'Altair', 'Arcturus', 'Kochab', 'Deneb', 'Alphecca'];

  for (let i = 0; i < wanted; i++) {
    if (scenario.missing_fraction > 0 && rng() < scenario.missing_fraction) continue;

    const azimuth = azimuths[i % azimuths.length]!;
    const trueAltitude = PRESET_ALTITUDES[i % PRESET_ALTITUDES.length]!;
    // Place the body's geographic position so the truth position sees exactly that
    // altitude at that azimuth: GP = truth walked `90 - h` degrees along the azimuth.
    const gp = pointToLatLon(
      destination(
        pointFromDeg(truthPoint.lat_deg, truthPoint.lon_deg),
        toRad(azimuth),
        toRad(90 - trueAltitude),
      ),
    );
    // GHA is west-positive: GHA = -lon_east. A clock offset shifts every GHA equally,
    // which is exactly the longitude degeneracy of CONVENTIONS section 6.
    const ghaTrue = norm360(-gp.lon_deg);
    const gha = norm360(
      ghaTrue + (SIDEREAL_RATE_DEG_PER_HOUR * scenario.clock_offset_s) / 3600,
    );

    let ho = trueAltitude;
    ho += (scenario.noise_arcmin * gaussian(rng)) / 60;
    ho += scenario.shared_altitude_bias_arcmin / 60;
    const id = `obs-${i + 1}`;
    if (scenario.wrong_sight && scenario.wrong_sight.index === i) {
      ho += scenario.wrong_sight.error_arcmin / 60;
      wrongIds.push(id);
    }

    const horizon = scenario.horizon;
    const reading = inverseToSextantReading(session, ho, horizon);
    session.observations.push({
      id,
      body: bodies[i % bodies.length]!,
      utc: new Date(startMs + i * 120000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      altitude_deg: Number(reading.toFixed(5)),
      altitude_kind: 'sextant_hs',
      sigma_arcmin: scenario.sigma_arcmin,
      limb: 'center',
      horizon: null,
      geocentric: {
        gha_deg: Number(gha.toFixed(6)),
        dec_deg: Number(gp.lat_deg.toFixed(6)),
        semidiameter_arcmin: 0,
        horizontal_parallax_arcmin: 0,
      },
      notes: '',
    });
  }

  const truth: Truth = {
    schema: TRUTH_SCHEMA,
    session_name: session.meta.name,
    position: truthPoint,
    seed: scenario.seed,
    clock_offset_s: scenario.clock_offset_s,
    shared_altitude_bias_arcmin: scenario.shared_altitude_bias_arcmin,
    wrong_sight_ids: wrongIds,
    notes:
      'Simulated truth. Never read by the solver and never merged into the session (CONVENTIONS section 11).',
  };
  return { session, truth };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class MockApi implements SkyfixApi {
  readonly kind = 'mock' as const;
  readonly description =
    'Mock adapter: spherical geometry is real, everything that needs an ephemeris is invented. Not a result.';
  readonly mockedCalls = [
    'parse_session',
    'reduce',
    'solve',
    'circle_points',
    'simulate',
    'catalog',
    'coverage',
  ] as const;

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

  async solve(session: Session, options: SolveOptions): Promise<FixResult> {
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

  async catalog(): Promise<string[]> {
    return [...BODY_NAMES];
  }

  async coverage(): Promise<CoverageReport> {
    return {
      providers: [
        {
          provider: 'mock',
          start_utc: '',
          end_utc: '',
          bodies: [],
          notes:
            'The mock adapter has no ephemeris. Every observation must carry its own apparent geocentric gha_deg / dec_deg.',
          accuracy_arcmin: 0,
        },
      ],
      modes: ['supplied'],
    };
  }
}

export { mockSolve, mockSimulate, reduceEntries, validate, gaussNewton, azimuthGap };
