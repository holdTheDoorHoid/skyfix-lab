/**
 * TypeScript mirror of `crates/skyfix-core/src/types.rs`, field for field.
 *
 * Rules taken from that file and docs/CONVENTIONS.md:
 * - snake_case everywhere; the wire format is serde's JSON encoding.
 * - Rust enums without payloads are plain snake_case strings.
 * - Enums with payloads are internally tagged: `FixResult` by "kind",
 *   `Warning` by "code", `AssumedPositionRole` by "role".
 * - `Option<T>` is `T | null` (the WASM adapter serialises with
 *   `Serializer::json_compatible`, so `None` is `null`, never `undefined`).
 * - Degrees / arcminutes / metres / nautical miles / seconds on the wire.
 *   Radians never appear here.
 *
 * If this file and types.rs disagree, types.rs wins and this file is the bug.
 */

export const SESSION_SCHEMA = 'skyfix.session/1';
export const REFERENCE_SCHEMA = 'skyfix.reference/1';
export const TRUTH_SCHEMA = 'skyfix.truth/1';
/** Owned by the WASM adapter (crates/skyfix-wasm/src/lib.rs), not by types.rs. */
export const SCENARIO_SCHEMA = 'skyfix.scenario/1';

/** chi-square 95 % quantile, 2 dof. `skyfix_core::units::CHI2_95_2DOF`. */
export const CHI2_95_2DOF = 5.991464547;
/** Metres per nautical mile, exact. */
export const NM_M = 1852;
/** Reference-sphere radius: one arcminute of arc is exactly one nautical mile. */
export const EARTH_RADIUS_M = (NM_M * 10800) / Math.PI;

// ---------------------------------------------------------------------------
// Session model (CONVENTIONS section 10)
// ---------------------------------------------------------------------------

export type SessionKind = 'simulated' | 'real';

export interface LatLon {
  /** North positive, [-90, +90]. */
  lat_deg: number;
  /** EAST POSITIVE, (-180, +180]. Philadelphia is -75.1652. */
  lon_deg: number;
}

export type AssumedPositionRole =
  | { role: 'initializer' }
  | { role: 'prior'; sigma_nm: number }
  | { role: 'disabled' };

export interface SessionMeta {
  name: string;
  notes: string;
  kind: SessionKind;
}

export interface Observer {
  height_of_eye_m: number;
  pressure_hpa: number;
  temperature_c: number;
  assumed_position: LatLon | null;
  assumed_position_role: AssumedPositionRole;
}

export type HorizonMode = 'sea' | 'artificial_reflected' | 'electronic_vertical';

export interface Instrument {
  name: string;
  /** Signed arcminutes, ADDED to the reading. On the arc => negative. */
  index_correction_arcmin: number;
  horizon: HorizonMode;
}

export interface Clock {
  /** 1-sigma of the recorded UTC, seconds. Propagated, never estimated. */
  uncertainty_s: number;
  /** Known chronometer correction, seconds, ADDED to every recorded time. */
  correction_s: number;
}

export type AltitudeKind = 'sextant_hs' | 'apparent_ha' | 'observed_ho';
export type Limb = 'center' | 'lower' | 'upper';

export interface GeocentricDirection {
  /** Apparent geocentric of date. WEST POSITIVE, [0, 360). */
  gha_deg: number;
  dec_deg: number;
  semidiameter_arcmin: number;
  horizontal_parallax_arcmin: number;
}

export interface Observation {
  id: string;
  body: string;
  /** RFC 3339 UTC with a trailing Z. */
  utc: string;
  altitude_deg: number;
  altitude_kind: AltitudeKind;
  sigma_arcmin: number;
  limb: Limb;
  /** Per-observation override of the instrument horizon mode. */
  horizon: HorizonMode | null;
  /** Supplied body direction; wins over any ephemeris provider. */
  geocentric: GeocentricDirection | null;
  notes: string;
}

export interface Session {
  schema: string;
  meta: SessionMeta;
  observer: Observer;
  instrument: Instrument;
  clock: Clock;
  observations: Observation[];
}

// ---------------------------------------------------------------------------
// Corrections and reduction (CONVENTIONS sections 3-5)
// ---------------------------------------------------------------------------

export type CorrectionKind =
  | 'index_correction'
  | 'dip'
  | 'artificial_horizon_halving'
  | 'refraction'
  | 'semidiameter'
  | 'parallax';

/** The six steps in the order the reducer runs them (CONVENTIONS section 5). */
export const CORRECTION_ORDER: readonly CorrectionKind[] = [
  'index_correction',
  'dip',
  'artificial_horizon_halving',
  'refraction',
  'semidiameter',
  'parallax',
];

export const CORRECTION_LABEL: Record<CorrectionKind, string> = {
  index_correction: 'Index correction',
  dip: 'Dip of the horizon',
  artificial_horizon_halving: 'Artificial-horizon halving',
  refraction: 'Refraction',
  semidiameter: 'Semidiameter',
  parallax: 'Parallax in altitude',
};

export interface CorrectionStep {
  kind: CorrectionKind;
  applied: boolean;
  before_deg: number;
  after_deg: number;
  /** after - before, arcminutes (halving reports the amount removed). */
  delta_arcmin: number;
  note: string;
}

export interface CorrectionBreakdown {
  input_kind: AltitudeKind;
  input_deg: number;
  steps: CorrectionStep[];
  ho_deg: number;
  sigma_ho_arcmin: number;
  warnings: Warning[];
}

export interface ReducedSight {
  id: string;
  body: string;
  utc: string;
  jd_utc: number;
  gha_deg: number;
  dec_deg: number;
  /** "supplied" or the provider name. */
  direction_source: string;
  ho_deg: number;
  sigma_arcmin: number;
  corrections: CorrectionBreakdown;
  hc_deg: number | null;
  zn_deg: number | null;
  /** Ho - Hc in nautical miles, positive toward the body. */
  intercept_nm: number | null;
  warnings: Warning[];
}

// ---------------------------------------------------------------------------
// Solver options and results (CONVENTIONS sections 8-9)
// ---------------------------------------------------------------------------

export interface PositionPrior {
  center: LatLon;
  sigma_nm: number;
}

export interface RobustOptions {
  huber_k: number;
  max_reweight_iterations: number;
}

export interface MultistartOptions {
  enabled: boolean;
  grid_step_deg: number;
  cluster_radius_nm: number;
  ambiguity_delta_chi2: number;
}

export interface SolveOptions {
  /** Starting point only. Never a prior. */
  initializer: LatLon | null;
  prior: PositionPrior | null;
  estimate_shared_bias: boolean;
  robust: RobustOptions | null;
  clock_uncertainty_s: number;
  posterior_scaling: boolean;
  multistart: MultistartOptions;
  max_iterations: number;
  step_tolerance_rad: number;
}

/**
 * `SolveOptions` in types.rs carries no `#[serde(default)]`, so every field must be
 * present on the wire. This matches `SolveOptions::default()` exactly.
 */
export function defaultSolveOptions(): SolveOptions {
  return {
    initializer: null,
    prior: null,
    estimate_shared_bias: false,
    robust: null,
    clock_uncertainty_s: 0,
    posterior_scaling: false,
    multistart: {
      enabled: true,
      grid_step_deg: 10,
      cluster_radius_nm: 10,
      ambiguity_delta_chi2: CHI2_95_2DOF,
    },
    max_iterations: 50,
    step_tolerance_rad: 1e-9,
  };
}

export interface CircleOfPosition {
  id: string;
  body: string;
  gp: LatLon;
  zenith_distance_deg: number;
}

export interface FixCandidate {
  position: LatLon;
  chi2: number;
  delta_chi2_from_best: number;
  converged: boolean;
  iterations: number;
  shared_bias_arcmin: number | null;
}

export interface ErrorEllipse {
  semi_major_m: number;
  semi_minor_m: number;
  /** Azimuth of the major axis, degrees clockwise from north, [0, 180). */
  orientation_deg: number;
  confidence: number;
  /** Always "nominal 95 %, independent-noise model". */
  model: string;
}

export interface PosteriorScaled {
  scale_factor_s2: number;
  covariance_ne_m2: [[number, number], [number, number]];
  ellipse95: ErrorEllipse | null;
}

export interface Residual {
  id: string;
  body: string;
  hc_deg: number;
  zn_deg: number;
  /** Ho - Hc - bias, arcminutes. */
  residual_arcmin: number;
  normalized: number;
  weight: number;
  intercept_nm: number;
}

export interface Conditioning {
  singular_values: number[];
  condition_number: number;
  rank: number;
  /** sqrt(trace((J^T J)^-1)): metres of position per arcminute of altitude noise. */
  geometric_dilution_m_per_arcmin: number;
  /** Largest gap between consecutive sight azimuths, degrees. */
  max_azimuth_gap_deg: number;
}

export interface PriorReport {
  center: LatLon;
  sigma_nm: number;
  fix_without_prior: LatLon | null;
  shift_m: number;
}

export interface RobustReport {
  huber_k: number;
  downweighted_ids: string[];
  note: string;
}

export interface Fix {
  position: LatLon;
  shared_bias_arcmin: number | null;
  /** A priori tangent-plane covariance, m^2, rows/cols = (north, east). */
  covariance_ne_m2: [[number, number], [number, number]];
  sigma_north_m: number;
  sigma_east_m: number;
  clock_sigma_east_m: number;
  ellipse95: ErrorEllipse | null;
  ellipse_suppressed_reason: string | null;
  posterior_scaled: PosteriorScaled | null;
  residuals: Residual[];
  chi2: number;
  dof: number;
  conditioning: Conditioning;
  iterations: number;
  converged: boolean;
  prior: PriorReport | null;
  robust: RobustReport | null;
}

export type FixResult =
  | { kind: 'underdetermined'; circles: CircleOfPosition[]; reason: string; warnings: Warning[] }
  | {
      kind: 'ambiguous';
      candidates: FixCandidate[];
      circles: CircleOfPosition[];
      warnings: Warning[];
    }
  | { kind: 'unique'; fix: Fix; alternatives: FixCandidate[]; warnings: Warning[] }
  | { kind: 'failed'; reason: string; warnings: Warning[] };

// ---------------------------------------------------------------------------
// Simulation truth — never merged into a Session
// ---------------------------------------------------------------------------

export interface Truth {
  schema: string;
  session_name: string;
  position: LatLon;
  seed: number;
  clock_offset_s: number;
  shared_altitude_bias_arcmin: number;
  wrong_sight_ids: string[];
  notes: string;
}

// ---------------------------------------------------------------------------
// Warnings (CONVENTIONS section 12) — the single machine-readable caveat vocabulary
// ---------------------------------------------------------------------------

export type Warning =
  | {
      code: 'low_altitude_refraction';
      id: string;
      apparent_altitude_deg: number;
      sigma_added_arcmin: number;
    }
  | { code: 'dip_not_applicable'; id: string; horizon: HorizonMode }
  | { code: 'already_corrected'; id: string; kind: AltitudeKind; ignored: CorrectionKind[] }
  | { code: 'limb_ignored_for_star'; id: string }
  | { code: 'supplied_direction_used'; id: string }
  | { code: 'ephemeris_coverage_limited'; provider: string; coverage: string }
  | { code: 'poor_geometry'; condition_number: number; max_azimuth_gap_deg: number }
  | { code: 'clock_degenerate_with_longitude'; sigma_east_m: number }
  | { code: 'prior_used'; sigma_nm: number; shift_m: number }
  | { code: 'robust_weights_applied'; downweighted_ids: string[] }
  | { code: 'ellipse_suppressed'; reason: string }
  | { code: 'posterior_scaling_skipped'; dof: number }
  | { code: 'duplicate_observation'; ids: string[] }
  | { code: 'not_converged'; iterations: number }
  | { code: 'other'; message: string };

export type WarningCode = Warning['code'];

/**
 * Every variant of `skyfix_core::types::Warning`, in declaration order.
 * The unit tests iterate this list, so adding a variant to types.rs without adding it
 * here (and to `warningSentence`) fails the suite.
 */
export const WARNING_CODES = [
  'low_altitude_refraction',
  'dip_not_applicable',
  'already_corrected',
  'limb_ignored_for_star',
  'supplied_direction_used',
  'ephemeris_coverage_limited',
  'poor_geometry',
  'clock_degenerate_with_longitude',
  'prior_used',
  'robust_weights_applied',
  'ellipse_suppressed',
  'posterior_scaling_skipped',
  'duplicate_observation',
  'not_converged',
  'other',
] as const satisfies readonly WarningCode[];

/** "caution" changes what you should believe; "note" records what the code did. */
export type WarningSeverity = 'caution' | 'note';

export const WARNING_SEVERITY: Record<WarningCode, WarningSeverity> = {
  low_altitude_refraction: 'caution',
  dip_not_applicable: 'note',
  already_corrected: 'note',
  limb_ignored_for_star: 'note',
  supplied_direction_used: 'note',
  ephemeris_coverage_limited: 'caution',
  poor_geometry: 'caution',
  clock_degenerate_with_longitude: 'caution',
  prior_used: 'caution',
  robust_weights_applied: 'caution',
  ellipse_suppressed: 'caution',
  posterior_scaling_skipped: 'note',
  duplicate_observation: 'caution',
  not_converged: 'caution',
  other: 'note',
};

const HORIZON_PHRASE: Record<HorizonMode, string> = {
  sea: 'natural sea horizon',
  artificial_reflected: 'reflected artificial horizon',
  electronic_vertical: 'electronic local vertical',
};

const ALTITUDE_KIND_PHRASE: Record<AltitudeKind, string> = {
  sextant_hs: 'raw sextant reading (Hs)',
  apparent_ha: 'apparent altitude (Ha)',
  observed_ho: 'observed altitude (Ho)',
};

function list(items: string[]): string {
  if (items.length === 0) return 'none';
  if (items.length === 1) return items[0]!;
  return items.slice(0, -1).join(', ') + ' and ' + items[items.length - 1]!;
}

function n(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

/**
 * Render one warning as a full sentence a navigator can act on. Every variant is
 * mapped; the `never` fallthrough makes an unmapped variant a compile error.
 */
export function warningSentence(w: Warning): string {
  switch (w.code) {
    case 'low_altitude_refraction':
      return (
        `Sight ${w.id} was taken at ${n(w.apparent_altitude_deg, 2)} deg apparent altitude, ` +
        `where the refraction model is least reliable` +
        (w.sigma_added_arcmin > 0
          ? `; ${n(w.sigma_added_arcmin, 2)} arcmin was added in quadrature to its nominal uncertainty.`
          : '. Its nominal uncertainty was left unchanged.')
      );
    case 'dip_not_applicable':
      return (
        `No dip was applied to sight ${w.id}: with a ${HORIZON_PHRASE[w.horizon]} ` +
        `the height of eye does not enter the correction.`
      );
    case 'already_corrected':
      return (
        `Sight ${w.id} was supplied as an ${ALTITUDE_KIND_PHRASE[w.kind]}, so ` +
        `${list(w.ignored.map((k) => CORRECTION_LABEL[k].toLowerCase()))} ` +
        `${w.ignored.length === 1 ? 'was' : 'were'} not applied again.`
      );
    case 'limb_ignored_for_star':
      return `Sight ${w.id} is a star, which has no measurable disc, so the limb setting was ignored.`;
    case 'supplied_direction_used':
      return (
        `Sight ${w.id} used the body direction supplied in the observation record, ` +
        `not an ephemeris provider.`
      );
    case 'ephemeris_coverage_limited':
      return (
        `The ${w.provider} astronomy provider only covers ${w.coverage}. ` +
        `Outside that range it refuses to answer rather than extrapolating.`
      );
    case 'poor_geometry':
      return (
        `The sight geometry is poorly conditioned: condition number ${n(w.condition_number, 0)} ` +
        `with a ${n(w.max_azimuth_gap_deg, 0)} deg gap between neighbouring azimuths. ` +
        `Position error along the unconstrained direction is much larger than the ` +
        `altitude uncertainty suggests.`
      );
    case 'clock_degenerate_with_longitude':
      return (
        `Clock uncertainty is nearly indistinguishable from longitude for these sights. ` +
        `It contributes ${n(w.sigma_east_m, 0)} m of east-west nominal uncertainty, ` +
        `which is propagated, not estimated away.`
      );
    case 'prior_used':
      return (
        `A position prior of ${n(w.sigma_nm, 1)} NM (1 sigma) influenced this answer: ` +
        `it moved the fix ${n(w.shift_m, 0)} m from the same solve without it.`
      );
    case 'robust_weights_applied':
      return (
        `Robust (Huber) weighting reduced the influence of ${list(w.downweighted_ids)}. ` +
        `The reported covariance is approximate when weights are not the input sigmas.`
      );
    case 'ellipse_suppressed':
      return `No uncertainty ellipse is drawn: ${w.reason}.`;
    case 'posterior_scaling_skipped':
      return (
        `Residual-based covariance scaling was skipped: ${w.dof} degree` +
        `${w.dof === 1 ? '' : 's'} of freedom cannot establish the noise level ` +
        `(3 or more are required).`
      );
    case 'duplicate_observation':
      return (
        `Sights ${list(w.ids)} look like the same observation. Repeated measurements of ` +
        `the same thing do not add independent information.`
      );
    case 'not_converged':
      return (
        `The solver stopped after ${w.iterations} iterations without meeting its step ` +
        `tolerance. Treat the position and its nominal uncertainty as provisional.`
      );
    case 'other':
      return w.message;
    default: {
      const exhaustive: never = w;
      return `Unmapped warning: ${JSON.stringify(exhaustive)}`;
    }
  }
}

/** Short label for the badge next to the sentence. Colour is never the only cue. */
export function warningLabel(w: Warning): string {
  return WARNING_SEVERITY[w.code] === 'caution' ? 'Caution' : 'Note';
}

/** The observation id a warning is attached to, when it has one. */
export function warningSightId(w: Warning): string | null {
  return 'id' in w ? w.id : null;
}
