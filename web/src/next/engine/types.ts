/**
 * Explorer engine contract — the TypeScript mirror of docs/EXPLORER_API.md.
 *
 * NORMATIVE. Change this file and the Rust exports in crates/skyfix-wasm/src/{explorer,
 * starfield,nav,almanac,eclipses}.rs together, in one commit.
 *
 * The engine is synchronous once loaded: WASM calls are fast enough for the render
 * loop (EXPLORER_PLAN §3.7), and a synchronous interface keeps redraws simple. Inputs
 * are plain objects; the WASM implementation serialises them to the JSON strings the
 * Rust exports take. Every astronomical number the UI shows comes through here
 * (EXPLORER_PLAN §3.1).
 */

/** A place on the Earth. Longitude east-positive (CONVENTIONS §2). */
export interface Observer {
  lat_deg: number;
  lon_deg: number;
  /** Height of the site above the WGS84 ellipsoid, metres. Not the height of eye. */
  height_m?: number;
  pressure_hpa?: number;
  temperature_c?: number;
}

export type BodyKind = 'sun' | 'moon' | 'planet' | 'star';

/** A body list: canonical names, or one of the named groups. */
export type BodySelection = string[] | 'all' | 'solar_system' | 'navigational';

export type SkyPhase = 'day' | 'civil' | 'nautical' | 'astronomical' | 'night';

export interface BodyError {
  body: string;
  message: string;
}

export interface BodyInfo {
  body: string;
  kind: BodyKind;
  navigational: boolean;
  magnitude: number | null;
}

export interface CoverageGroup {
  name: string;
  provider: string;
  accuracy_arcmin: number | null;
  validated: boolean;
  notes: string;
  /**
   * Canonical names of the bodies this group covers. Optional; when absent the UI maps
   * a body to the group whose name matches its kind (Sun, Moon, Planets, Stars). See
   * `engine/bodies.ts`, `coverageGroupFor`.
   */
  bodies?: string[];
}

export interface ExplorerCoverage {
  start_utc: string;
  end_utc: string;
  groups: CoverageGroup[];
}

export interface LatLonDeg {
  lat_deg: number;
  lon_deg: number;
}

export interface BodyState {
  body: string;
  kind: BodyKind;
  gha_deg: number;
  dec_deg: number;
  sha_deg: number;
  ra_deg: number;
  gp: LatLonDeg;
  /** Topocentric geometric altitude of the centre (CONVENTIONS §13.2). */
  alt_deg: number;
  az_deg: number;
  /** What the eye sees: `alt_deg` plus display refraction. */
  alt_apparent_deg: number;
  /** Navigation computed altitude and azimuth (CONVENTIONS §3). Not comparable with `alt_deg`. */
  hc_deg: number;
  zn_deg: number;
  above_horizon: boolean;
  distance_km: number | null;
  semidiameter_arcmin: number;
  horizontal_parallax_arcmin: number;
  magnitude: number | null;
  phase_angle_deg: number | null;
  illuminated_fraction: number | null;
  elongation_deg: number | null;
  bright_limb_angle_deg: number | null;
  parallactic_angle_deg: number;
  constellation: string | null;
}

export interface SkyState {
  jd_utc: number;
  utc: string;
  gha_aries_deg: number;
  sun_altitude_deg: number;
  sky_phase: SkyPhase;
  bodies: BodyState[];
  errors: BodyError[];
}

export interface SampledBody {
  body: string;
  alt_deg: Float64Array;
  alt_apparent_deg: Float64Array;
  az_deg: Float64Array;
  gha_deg: Float64Array;
  dec_deg: Float64Array;
}

export interface Sampled {
  jd_utc: Float64Array;
  bodies: SampledBody[];
  errors: BodyError[];
}

export type SunEventKind =
  | 'astronomical_dawn'
  | 'nautical_dawn'
  | 'civil_dawn'
  | 'rise'
  | 'transit'
  | 'set'
  | 'civil_dusk'
  | 'nautical_dusk'
  | 'astronomical_dusk'
  | 'lower_transit';

export type BodyEventKind = 'rise' | 'transit' | 'set' | 'lower_transit';

export interface SkyEvent {
  kind: SunEventKind | BodyEventKind;
  jd_utc: number;
  utc: string;
  alt_deg: number;
  az_deg: number;
}

export interface PhaseSegment {
  jd_start: number;
  jd_end: number;
  phase: SkyPhase;
}

export interface BodyEvents {
  body: string;
  events: SkyEvent[];
  always_above: boolean;
  always_below: boolean;
  /** The Sun only; `null` for every other body. */
  day_length_h: number | null;
}

export interface DayEvents {
  jd_start: number;
  jd_end: number;
  phases: PhaseSegment[];
  bodies: BodyEvents[];
  errors: BodyError[];
}

export interface EventOptions {
  horizon: 'standard' | 'dip';
  height_of_eye_m: number;
}

export interface AltitudeCrossing {
  jd_utc: number;
  utc: string;
  /** Geometric, like every `alt_deg`: the requested *apparent* altitude minus refraction. */
  alt_deg: number;
  az_deg: number;
  rising: boolean;
}

export interface PhaseEvent {
  kind: 'new_moon' | 'first_quarter' | 'full_moon' | 'last_quarter';
  jd_utc: number;
  utc: string;
}

export interface SeasonEvent {
  kind: 'march_equinox' | 'june_solstice' | 'september_equinox' | 'december_solstice';
  jd_utc: number;
  utc: string;
}

export interface ConstellationFigure {
  abbr: string;
  name: string;
  /** Pairs of star indices into the star-field arrays. */
  lines: [number, number][];
  /** Label position: an ICRS (J2000) direction inside the boundary, degrees. */
  label_ra_deg: number;
  label_dec_deg: number;
}

/** Display-only (CONVENTIONS §13.6). Never used for sights. */
export interface StarfieldCatalog {
  count: number;
  hr: Int32Array;
  vmag: Float32Array;
  /** NaN when unknown. */
  bv: Float32Array;
  names: { index: number; name: string }[];
  designations: string[];
  navigational: { name: string; index: number }[];
  constellations: ConstellationFigure[];
  source: string;
  licence: string;
}

export interface ConstellationBoundary {
  abbr: string;
  ra_deg: Float64Array;
  dec_deg: Float64Array;
}

/**
 * The one interface every explorer view uses. Implementations: the WASM engine (the
 * real core) and the mock (UI development only, `?engine=mock`, never shipped as a
 * source of results).
 */
export interface ExplorerEngine {
  readonly kind: 'wasm' | 'mock';
  /** Shown to the user when the engine is not the real core. */
  readonly description: string;

  bodies(): BodyInfo[];
  coverage(): ExplorerCoverage;
  skyState(observer: Observer, jdUtc: number, bodies: BodySelection): SkyState;
  sampleBodies(
    observer: Observer,
    bodies: BodySelection,
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled;
  dayEvents(
    observer: Observer,
    jdStart: number,
    jdEnd: number,
    bodies: BodySelection,
    options?: EventOptions,
  ): DayEvents;
  dayEventsBatch(
    observer: Observer,
    windows: [number, number][],
    bodies: BodySelection,
    options?: EventOptions,
  ): DayEvents[];
  findAltitude(
    observer: Observer,
    body: string,
    jdStart: number,
    jdEnd: number,
    altitudeDeg: number,
  ): AltitudeCrossing[];
  moonPhases(jdStart: number, jdEnd: number): PhaseEvent[];
  seasons(year: number): SeasonEvent[];
  /** Cheap; called every frame by the Sky view. */
  sidereal(jdUtc: number): { gha_aries_deg: number };

  starfieldCatalog(): StarfieldCatalog;
  /** `[ra_rad, dec_rad, …]`, apparent geocentric of date. */
  starfieldApparent(jdUtc: number): Float64Array;
  constellationAt(raDeg: number, decDeg: number, jdUtc: number): string;
  constellationBoundaries(): ConstellationBoundary[];
  /**
   * ICRS (J2000) → true equator and equinox of date, row-major 3×3 (length 9):
   * `v_date[i] = Σ_j m[3i + j] · v_icrs[j]`. Carries the J2000 boundaries and label
   * positions into the frame of `starfieldApparent`. Addition by the star-field agent
   * (EXPLORER_API "starfield_frame_matrix"); optional so existing engines still compile.
   */
  starfieldFrameMatrix?(jdUtc: number): Float64Array;
  /**
   * The navigation tools (`NavEngine` and `NavSkyEngine`, below), composed in by the
   * engine when its build has them (`engine/wasm-nav.ts`, `engine/mock-nav.ts`). Optional:
   * a package built before the navigation exports has none, and the Navigate view says
   * which functions are missing. Addition by the navigate agent.
   */
  readonly nav?: NavEngine & NavSkyEngine;
}

/** UTC-based Julian Date from a JS timestamp (EXPLORER_API "Common rules"). */
export function jdFromUnixMs(ms: number): number {
  return ms / 86_400_000 + 2_440_587.5;
}

/** JS timestamp from a UTC-based Julian Date. */
export function unixMsFromJd(jd: number): number {
  return (jd - 2_440_587.5) * 86_400_000;
}

// ---------------------------------------------------------------------------
// Wave 1 — navigation methods (docs/EXPLORER_API.md; crates/skyfix-wasm/src/nav.rs)
//
// Mirrors the Rust wire types in crates/skyfix-core/src/types.rs ("Navigation
// methods") and crates/skyfix-wasm/src/nav.rs. The sights are always a
// `skyfix.session/1` Session; the methods are docs/NAVIGATION_METHODS.md.
// ---------------------------------------------------------------------------

import type {
  FixResult,
  LatLon,
  Observation,
  ReducedSight,
  Session,
  SolveOptions,
  Warning,
} from '../../types.js';

/** Where body directions come from, exactly as `reduce` and `solve` take it. */
export type EphemerisMode = 'auto' | 'supplied';

/** Constant course and speed over the ground while the sights were taken. */
export interface VesselMotion {
  course_deg: number;
  speed_kn: number;
}

/**
 * A dead-reckoning position. `sigma_nm` is its 1-sigma error in each of north and
 * east; `null`/absent means "not stated" and is never replaced by a guess.
 */
export interface DrPosition {
  lat_deg: number;
  lon_deg: number;
  sigma_nm?: number | null;
}

export type BodyBearing = 'auto' | 'north' | 'south';
export type MeridianSide = 'north' | 'south';
export type NoonCurvature = 'predicted' | 'fitted';
export type SingleAltitudeMode = 'maximum' | 'ex_meridian';
export type NoonMethod = 'curve_fit' | 'curve_fit_free_curvature' | 'ex_meridian' | 'maximum_altitude';

/** Every field defaults; `{}` is valid. `dr` defaults to the session's assumed position. */
export interface NoonSightOptions {
  dr?: DrPosition | null;
  vessel?: VesselMotion | null;
  body_bearing?: BodyBearing;
  curvature?: NoonCurvature;
  single_altitude?: SingleAltitudeMode;
}

export interface LatitudeEstimate {
  lat_deg: number;
  /** 1 sigma, arcminutes (= nautical miles). */
  sigma_arcmin: number;
}

export interface LongitudeEstimate {
  lon_deg: number;
  /** 1 sigma, arcminutes of longitude, clock included. */
  sigma_arcmin: number;
  /** The same as an east-west distance, nautical miles. */
  sigma_nm: number;
  clock_sigma_arcmin: number;
}

export interface TimeEstimate {
  utc: string;
  jd_utc: number;
  sigma_s: number;
}

export interface CurveMaximum {
  utc: string;
  jd_utc: number;
  altitude_deg: number;
  seconds_after_passage: number;
}

/** `h ≈ H0 + a t − k t²`, t in minutes from meridian passage. */
export interface CurvatureReport {
  predicted_arcmin_per_min2: number;
  rate_at_passage_arcmin_per_min: number;
  max_minus_meridian_arcmin: number;
  fitted_arcmin_per_min2: number | null;
  fitted_sigma_arcmin_per_min2: number | null;
  z: number | null;
  consistent: boolean | null;
}

export interface NoonAlternative {
  method: NoonMethod;
  latitude: LatitudeEstimate;
  meridian_altitude_deg: number;
  meridian_passage: TimeEstimate | null;
  longitude: LongitudeEstimate | null;
  chi2: number;
  dof: number;
}

export interface NoonDrCheck {
  predicted_passage_utc: string;
  predicted_passage_jd_utc: number;
  predicted_passage_sigma_s: number | null;
  latitude_difference_arcmin: number;
  longitude_difference_arcmin: number | null;
}

/** One sight against the fitted model. */
export interface RunResidual {
  id: string;
  utc: string;
  jd_utc: number;
  /** Minutes from the reference instant (noon: meridian passage; averaging: the chosen time). */
  minutes: number;
  ho_deg: number;
  model_deg: number;
  residual_arcmin: number;
  normalized: number;
  /** Averaging only: the leave-one-out statistic the outlier test uses. */
  normalized_loo: number | null;
  used: boolean;
  outlier: boolean;
}

/** A point on a fitted curve, for plotting. */
export interface CurvePoint {
  jd_utc: number;
  minutes: number;
  altitude_deg: number;
}

export interface NoonSightResult {
  body: string;
  method: NoonMethod;
  n_sights: number;
  side: MeridianSide;
  latitude: LatitudeEstimate;
  meridian_altitude_deg: number;
  declination_deg: number;
  zenith_distance_deg: number;
  /** The rule applied, in words, with the numbers. */
  latitude_rule: string;
  /** `null` for one altitude and for the ex-meridian method (they cannot time the peak). */
  meridian_passage: TimeEstimate | null;
  longitude: LongitudeEstimate | null;
  /** Plain-language statement of how weak the longitude is, or why there is none. */
  longitude_caveat: string;
  longitude_sensitivity_arcmin_per_nm: number | null;
  maximum: CurveMaximum | null;
  curvature: CurvatureReport;
  alternative: NoonAlternative | null;
  dr_check: NoonDrCheck;
  chi2: number;
  dof: number;
  residuals: RunResidual[];
  model_curve: CurvePoint[];
  sights: ReducedSight[];
  warnings: Warning[];
}

export interface PolarisOptions {
  /** The longitude is required (defaults to the session's assumed position). */
  dr?: DrPosition | null;
  vessel?: VesselMotion | null;
  /** RFC 3339 UTC the combined latitude refers to; default: the last sight. */
  reference_utc?: string | null;
}

/** The Nautical Almanac Polaris-table terms, unrounded: latitude = Ho − 1° + a0 + a1 + a2. */
export interface PolarisAlmanacTerms {
  lha_aries_deg: number;
  a0_arcmin: number;
  a1_arcmin: number;
  a2_arcmin: number;
  latitude_deg: number;
  difference_arcmin: number;
  table_latitude_deg: number;
  mean_sha_deg: number;
  mean_dec_deg: number;
  within_printed_table: boolean;
  note: string;
}

export interface PolarisSight {
  id: string;
  utc: string;
  jd_utc: number;
  ho_deg: number;
  gha_deg: number;
  dec_deg: number;
  dr_lon_deg: number;
  lha_deg: number;
  azimuth_deg: number;
  latitude: LatitudeEstimate;
  sigma_from_altitude_arcmin: number;
  sigma_from_longitude_arcmin: number | null;
  sigma_from_clock_arcmin: number;
  longitude_sensitivity_arcmin_per_nm: number;
  correction_arcmin: number;
  normalized_residual: number | null;
  almanac: PolarisAlmanacTerms | null;
}

export interface PolarisResult {
  latitude: LatitudeEstimate;
  reference_utc: string;
  reference_jd_utc: number;
  polaris: PolarisSight[];
  chi2: number | null;
  dof: number;
  sights: ReducedSight[];
  warnings: Warning[];
}

export interface AveragingOptions {
  /** RFC 3339 UTC of the averaged sight; default: the weighted mean time of the sights used. */
  reference_utc?: string | null;
  dr?: DrPosition | null;
  vessel?: VesselMotion | null;
  /** Default true. */
  reject_outliers?: boolean;
  /** Default 3. */
  outlier_threshold?: number;
}

export interface FreeSlopeFit {
  slope_arcmin_per_min: number;
  slope_sigma_arcmin_per_min: number;
  ho_deg: number;
  sigma_arcmin: number;
  z: number;
  consistent: boolean;
  chi2: number;
  dof: number;
}

export interface AveragedSight {
  body: string;
  utc: string;
  jd_utc: number;
  ho_deg: number;
  sigma_arcmin: number;
  n_used: number;
  n_total: number;
  predicted_slope_arcmin_per_min: number;
  predicted_slope_sigma_arcmin_per_min: number | null;
  predicted_curvature_arcmin_per_min2: number;
  chi2: number;
  dof: number;
  free_slope: FreeSlopeFit | null;
  outliers: string[];
  residuals: RunResidual[];
  model_curve: CurvePoint[];
  /**
   * The averaged sight as an `observed_ho` observation, ready for a session. Its `utc` is on
   * the session's chronometer (the averaged instant minus `clock.correction_s`), like the
   * observations it replaces; the reducer's correction brings it back to `utc` above.
   */
  observation: Observation;
  sights: ReducedSight[];
  warnings: Warning[];
}

export interface RunningFixLeg {
  /** RFC 3339 UTC; only the first leg may leave it out (it then starts at the first sight). */
  start_utc?: string | null;
  course_deg: number;
  speed_kn: number;
}

/** All zero (the default) means "not stated"; the result then says the run was taken as exact. */
export interface MotionUncertaintyInput {
  speed_sigma_kn?: number;
  course_sigma_deg?: number;
  random_walk_nm_per_sqrt_hour?: number;
}

export interface RunningFixRequest {
  /** RFC 3339 UTC of the fix; default: the last sight. */
  reference_utc?: string | null;
  legs: RunningFixLeg[];
  end_utc?: string | null;
  motion_uncertainty?: MotionUncertaintyInput;
  options?: Partial<SolveOptions>;
}

export interface SigmaInflationReport {
  id: string;
  hours_to_reference: number;
  run_nm: number;
  zn_deg: number;
  sigma_sight_arcmin: number;
  sigma_motion_arcmin: number;
  sigma_total_arcmin: number;
}

export interface RunningFixOutput {
  /** The same result `solve` returns. */
  result: FixResult;
  reference_utc: string;
  reference_jd_utc: number;
  applied: boolean;
  passes: number;
  reference_estimate: LatLon | null;
  inflations: SigmaInflationReport[];
  sights: ReducedSight[];
}

/**
 * Navigation methods. A separate interface from `ExplorerEngine` so the Navigate view can
 * depend on it alone. Every call throws a string on malformed input.
 */
export interface NavEngine {
  noonSight(session: Session, options?: NoonSightOptions, mode?: EphemerisMode): NoonSightResult;
  polarisLatitude(session: Session, options?: PolarisOptions, mode?: EphemerisMode): PolarisResult;
  averageSights(session: Session, options?: AveragingOptions, mode?: EphemerisMode): AveragedSight;
  runningFix(session: Session, request: RunningFixRequest, mode?: EphemerisMode): RunningFixOutput;
}

// ---------------------------------------------------------------------------
// Wave 2 — Moon and planet sights (docs/EXPLORER_API.md, "Wave 2 — Moon and planet
// sights"; Rust: crates/skyfix-wasm/src/navsky.rs, types at the end of
// crates/skyfix-core/src/types.rs). Appended by the navigation-Moon agent; the
// interfaces above are unchanged. Implemented in the WASM engine by the Navigate work
// (wave 3).
// ---------------------------------------------------------------------------

/** A navigator's position (the DR for a lunar) and what the correction chain needs. */
export interface SightObserver {
  lat_deg: number;
  lon_deg: number;
  /** Height of EYE above the sea, metres (dip). Not the site's height. Default 0. */
  height_of_eye_m?: number;
  pressure_hpa?: number;
  temperature_c?: number;
}

export type SightHorizon = 'sea' | 'artificial_reflected' | 'electronic_vertical';
export type SightLimb = 'center' | 'lower' | 'upper';
export type SightAltitudeKind = 'sextant_hs' | 'apparent_ha' | 'observed_ho';

/** Every field defaults: index correction 0 (added), sea horizon. */
export interface SightInstrument {
  name?: string;
  /** Arcminutes, ADDED to every reading (index error on the arc is negative). */
  index_correction_arcmin?: number;
  horizon?: SightHorizon;
}

/** A machine-readable caveat (CONVENTIONS section 12); `code` names the variant. */
export interface SightWarning {
  code: string;
  [field: string]: unknown;
}

export type SightCorrectionKind =
  | 'index_correction'
  | 'dip'
  | 'artificial_horizon_halving'
  | 'refraction'
  | 'semidiameter'
  | 'parallax';

export interface SightCorrectionStep {
  kind: SightCorrectionKind;
  applied: boolean;
  before_deg: number;
  after_deg: number;
  delta_arcmin: number;
  note: string;
}

/** The existing session `CorrectionBreakdown`: always six steps, in section 5 order. */
export interface SightCorrectionBreakdown {
  input_kind: SightAltitudeKind;
  input_deg: number;
  steps: SightCorrectionStep[];
  ho_deg: number;
  sigma_ho_arcmin: number;
  warnings: SightWarning[];
}

export interface SightBodyInfo {
  body: string;
  kind: 'sun' | 'moon' | 'planet' | 'star';
}

/** What the sextant will read: the correction chain run in reverse from Hc. */
export interface PredictedSight {
  body: string;
  jd_utc: number;
  utc: string;
  limb: SightLimb;
  horizon: SightHorizon;
  direction_source: string;
  /** Apparent geocentric; Venus at its centre of light. */
  gha_deg: number;
  dec_deg: number;
  semidiameter_arcmin: number;
  horizontal_parallax_arcmin: number;
  /** Computed altitude and azimuth at the observer (CONVENTIONS §3). */
  hc_deg: number;
  zn_deg: number;
  /** The sextant reading (the double angle with a reflected artificial horizon). */
  hs_deg: number;
  /** Apparent altitude after index correction and dip or halving. */
  ha_deg: number;
  /** The forward chain from `hs_deg`, landing on `hc_deg`. */
  corrections: SightCorrectionBreakdown;
  warnings: SightWarning[];
}

export type LunarLimb = 'near' | 'far' | 'center';

export interface LunarAltitudeObservation {
  altitude_deg: number;
  /** Default `sextant_hs`. `observed_ho` is refused. */
  altitude_kind?: SightAltitudeKind;
  /** Default `center`. */
  limb?: SightLimb;
  /** Default 1'. */
  sigma_arcmin?: number;
}

export interface LunarDistanceInput {
  /** The DR position, height of eye, pressure, temperature. */
  observer: SightObserver;
  instrument?: SightInstrument;
  /** The Sun, a navigational star or planet. */
  body: string;
  /** The watch's UTC for the distance, RFC 3339 with `Z`. */
  utc_estimate: string;
  /** The sextant reading of the distance, degrees. */
  distance_deg: number;
  /** Default `near`. */
  moon_limb?: LunarLimb;
  /** Default `near` for the Sun, `center` otherwise. */
  body_limb?: LunarLimb | null;
  /** Observed altitudes; each absent one is computed from the DR position. */
  moon_altitude?: LunarAltitudeObservation | null;
  body_altitude?: LunarAltitudeObservation | null;
  /** Distance measurement 1-sigma, arcminutes. Default 0.2. */
  sigma_arcmin?: number;
  /** Half-width of the search around `utc_estimate`, hours. Default 12, at most 48. */
  search_hours?: number;
  /** DR 1-sigma, nautical miles. Default 0 (sensitivity still reported). */
  dr_uncertainty_nm?: number;
}

export interface LunarClearingStep {
  kind: 'index_correction' | 'moon_semidiameter' | 'body_semidiameter' | 'refraction' | 'parallax';
  before_deg: number;
  after_deg: number;
  delta_arcmin: number;
  note: string;
}

export interface LunarAltitudes {
  moon_source: 'observed' | 'computed';
  body_source: 'observed' | 'computed';
  moon_apparent_deg: number;
  body_apparent_deg: number;
  moon_true_deg: number;
  body_true_deg: number;
  moon_azimuth_deg: number;
  body_azimuth_deg: number;
  moon_computed_apparent_deg: number;
  body_computed_apparent_deg: number;
}

export interface LunarErrorTerm {
  name: string;
  distance_arcmin: number;
  time_s: number;
}

export interface LunarDistanceResult {
  body: string;
  jd_utc: number;
  utc: string;
  /** Found UTC minus the estimate: the correction to add to the watch. */
  utc_minus_estimate_s: number;
  /** 1-sigma of the UTC, seconds. */
  sigma_s: number;
  longitude_sigma_arcmin: number;
  longitude_sigma_nm: number;
  apparent_distance_deg: number;
  cleared_distance_deg: number;
  distance_rate_arcmin_per_min: number;
  clearing: LunarClearingStep[];
  altitudes: LunarAltitudes;
  error_budget: LunarErrorTerm[];
  /** [north, east]: arcminutes of cleared distance per 10 NM of DR error. */
  dr_sensitivity_arcmin_per_10nm: [number, number];
  alternatives: { jd_utc: number; utc: string }[];
  warnings: SightWarning[];
  notes: string[];
}

/** The planner's metrics (skyfix_core::planner::PlanMetrics). */
export interface SightPlanMetrics {
  sight_count: number;
  sigma_north_m: number | null;
  sigma_east_m: number | null;
  trace_sigma_m: number | null;
  semi_major_sigma_m: number | null;
  semi_minor_sigma_m: number | null;
  semi_major_azimuth_deg: number | null;
  geometric_dilution_m_per_arcmin: number | null;
  condition_number: number | null;
  rank: number;
  max_azimuth_gap_deg: number;
  singular: boolean;
}

export interface SightPlannedBody {
  body: string;
  altitude_deg: number;
  azimuth_deg: number;
  score: number;
  rationale: string;
  step: number;
  score_units: string;
  score_basis: 'objective' | 'log_det_growth';
  sigma_arcmin: number;
  magnitude: number | null;
}

/** The planner's ranking of the chosen bodies (skyfix_core::planner::Plan). */
export interface SightRanking {
  approximate_position: LatLonDeg;
  utc: string;
  bodies: SightPlannedBody[];
  notes: string[];
  objective: 'min_trace' | 'min_max_eigenvalue' | 'min_condition_number';
  baseline: SightPlanMetrics;
  predicted: SightPlanMetrics;
  progression: SightPlanMetrics[];
  excluded: { body: string; altitude_deg: number; azimuth_deg: number; reason: string }[];
}

export interface RecommendedSight {
  body: string;
  kind: 'moon' | 'planet' | 'star';
  magnitude: number | null;
  step: number;
  /** The Moon's lit limb; `center` otherwise. */
  limb: SightLimb;
  hc_deg: number;
  zn_deg: number;
  /** Predicted sextant reading at the window's start. */
  hs_deg: number;
  rationale: string;
  prediction: PredictedSight;
}

export interface TwilightPlan {
  kind: 'evening' | 'morning';
  jd_start: number;
  utc_start: string;
  jd_end: number;
  utc_end: string;
  jd_predicted: number;
  utc_predicted: string;
  sun_altitude_deg: number;
  limiting_magnitude: number;
  sights: RecommendedSight[];
  also_eligible: string[];
  plan: SightRanking;
  notes: string[];
}

export interface SightPlan {
  observer: Required<SightObserver>;
  jd_start: number;
  utc_start: string;
  jd_end: number;
  utc_end: string;
  windows: TwilightPlan[];
  notes: string[];
}

/**
 * Moon and planet sight tools. The WASM implementation serialises the inputs to the
 * JSON strings the Rust exports take (`predict_sextant`, `lunar_distance`,
 * `plan_sights`, `sight_bodies`). Malformed input or a body that cannot be computed
 * throws.
 */
export interface NavSkyEngine {
  sightBodies(): SightBodyInfo[];
  predictSextant(
    observer: SightObserver,
    instrument: SightInstrument,
    body: string,
    limb: SightLimb,
    jdUtc: number,
  ): PredictedSight;
  lunarDistance(input: LunarDistanceInput): LunarDistanceResult;
  planSights(
    observer: SightObserver,
    jdStart: number,
    jdEnd: number,
    instrument: SightInstrument,
  ): SightPlan;
}

// ---------------------------------------------------------------------------
// Wave 2 — almanac pages (docs/EXPLORER_API.md; crates/skyfix-wasm/src/almanac.rs)
//
// Mirrors `skyfix_almanac::pages` (definitions: CONVENTIONS 13.9). Every tabulated
// quantity has its raw value (unit in the field name) and, under `printed`, the text the
// page prints, already rounded as the printed Nautical Almanac rounds. Views show
// `printed` and never round the raw values themselves.
// ---------------------------------------------------------------------------

/**
 * What a time cell holds: a time; the body above (□) or below (■) the horizon all day;
 * twilight all night (////); not on the date nor the next (--); or outside the
 * ephemeris coverage (n/a).
 */
export type AlmanacTimeKind = 'time' | 'above' | 'below' | 'all_night' | 'later' | 'unavailable';

export interface AlmanacTime {
  kind: AlmanacTimeKind;
  /** The instant, when `kind` is `time`. */
  jd_utc: number | null;
  utc: string | null;
  /** Hours after 00h UT of the column's date (LMT at Greenwich); may be negative or ≥ 24. */
  hours: number | null;
  /** `06 42`, `24 05` (the next date), `-00 02`, `□`, `■`, `////`, `--`, `n/a`. */
  printed: string;
}

export interface AlmanacAriesHour {
  gha_deg: number;
  printed: { gha: string };
}

/** The Sun or a planet at one hour (apparent geocentric, CONVENTIONS §7). */
export interface AlmanacBodyHour {
  body: string;
  gha_deg: number;
  dec_deg: number;
  printed: { gha: string; dec: string };
}

/** The Moon at one hour; `v` and `d` are from this hour to the next. */
export interface AlmanacMoonHour {
  gha_deg: number;
  dec_deg: number;
  v_arcmin: number;
  /** Signed, north positive; printed without a sign. */
  d_arcmin: number;
  hp_arcmin: number;
  printed: { gha: string; v: string; dec: string; d: string; hp: string };
}

export interface AlmanacHour {
  /** 0 to 23. */
  hour: number;
  jd_utc: number;
  utc: string;
  aries: AlmanacAriesHour;
  sun: AlmanacBodyHour;
  /** `null` when the Moon cannot be computed (listed in `errors`). */
  moon: AlmanacMoonHour | null;
  /** In the order of `AlmanacDay.planets`. */
  planets: AlmanacBodyHour[];
}

export interface AlmanacSunDay {
  /** At 12h UT. */
  sd_arcmin: number;
  /** Mean hourly change of declination over the day, signed. */
  d_arcmin: number;
  /** Equation of time, apparent minus mean, seconds; negative is shaded on the page. */
  eot_00h_s: number;
  eot_12h_s: number;
  mer_pass: AlmanacTime;
  printed: { sd: string; d: string; eot_00h: string; eot_12h: string };
}

export interface AlmanacMoonDay {
  /** At 12h UT. */
  sd_arcmin: number;
  mer_pass_upper: AlmanacTime;
  mer_pass_lower: AlmanacTime;
  /** Days since the preceding new moon at 12h UT; `null` before the coverage allows. */
  age_days: number | null;
  /** At 12h UT. */
  illuminated_fraction: number | null;
  /** A principal phase during the date, if any. */
  phase: PhaseEvent | null;
  printed: { sd: string; age: string; illuminated: string };
}

export interface AlmanacPlanetDay {
  body: string;
  /** At 12h UT. */
  magnitude: number | null;
  /** Mean over the day. */
  v_arcmin: number;
  d_arcmin: number;
  /** At 12h UT. */
  sha_deg: number;
  mer_pass: AlmanacTime;
  printed: { magnitude: string; v: string; d: string; sha: string };
}

/** A star at 12h UT of the date. */
export interface AlmanacStar {
  body: string;
  sha_deg: number;
  dec_deg: number;
  /** Catalogue visual magnitude. */
  magnitude: number;
  printed: { sha: string; dec: string };
}

/** One latitude of the twilight, sunrise, sunset, moonrise and moonset tables. */
export interface AlmanacLatitudeRow {
  lat_deg: number;
  /** `N 72`, `0`, `S 60`. */
  label: string;
  nautical_dawn: AlmanacTime;
  civil_dawn: AlmanacTime;
  sunrise: AlmanacTime;
  sunset: AlmanacTime;
  civil_dusk: AlmanacTime;
  nautical_dusk: AlmanacTime;
  /** One per `AlmanacRiseSet.moon_dates`. */
  moonrise: AlmanacTime[];
  moonset: AlmanacTime[];
}

export interface AlmanacRiseSet {
  /** The UT dates of the moonrise and moonset columns: the page's date and the next. */
  moon_dates: string[];
  /** 31 latitudes, 72 N to 60 S, in the printed almanac's order. */
  rows: AlmanacLatitudeRow[];
}

/** Everything the two facing daily pages give for one UT date (EXPLORER_API `AlmanacDay`). */
export interface AlmanacDay {
  /** `YYYY-MM-DD`, UT. */
  date: string;
  weekday: string;
  /** 00h UT of the date. */
  jd_utc: number;
  /** 12h UT: the instant of every once-a-day value. */
  noon_jd_utc: number;
  /** 24 rows, 00h to 23h. */
  hours: AlmanacHour[];
  aries: { mer_pass: AlmanacTime };
  sun: AlmanacSunDay;
  moon: AlmanacMoonDay | null;
  /** Venus, Mars, Jupiter, Saturn. */
  planets: AlmanacPlanetDay[];
  /** The 57 navigational stars in the printed almanac's order, then Polaris. */
  stars: AlmanacStar[];
  rise_set: AlmanacRiseSet;
  /** Sentences the page prints under its tables. */
  notes: string[];
  errors: BodyError[];
}

/**
 * Daily almanac pages. A separate interface from `ExplorerEngine` so the Almanac view can
 * depend on it alone; the WASM engine and the mock implement both.
 */
export interface AlmanacEngine {
  /**
   * The daily pages for one UT calendar date, `YYYY-MM-DD` (a date, not an instant).
   * Throws a string for a malformed date or one outside the coverage (1990-2060).
   */
  almanacDay(date: string): AlmanacDay;
}

/** True when `engine` can make almanac pages (the memoised engine forwards the method). */
export function isAlmanacEngine(engine: unknown): engine is AlmanacEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as Partial<AlmanacEngine>).almanacDay === 'function'
  );
}

// ---------------------------------------------------------------------------
// Misfit grid: the residual heat map. Rust: crates/skyfix-wasm/src/misfit.rs over
// skyfix_core::misfit (CONVENTIONS sections 8-9). Wire format: docs/EXPLORER_API.md,
// "Misfit grid". Composed as `engine.misfit` by engine/wasm-misfit.ts and
// engine/mock-misfit.ts. Addition by the misfit agent.
// ---------------------------------------------------------------------------

/**
 * A latitude/longitude box, degrees. The grid runs east from `west_deg` to `east_deg`;
 * across the antimeridian `east_deg` may be below `west_deg` (170 to -170) or above 180.
 * In results it is normalised: `west_deg` in [-180, 180), `east_deg = west_deg + span`.
 */
export interface MisfitBounds {
  south_deg: number;
  north_deg: number;
  west_deg: number;
  east_deg: number;
}

/** A polished minimum of the map. */
export interface MisfitPoint {
  lat_deg: number;
  lon_deg: number;
  chi2: number;
  /** `chi2 - min.chi2`. */
  delta_chi2: number;
  /** The best-fitting shared bias there, arcminutes; null unless the bias is estimated. */
  shared_bias_arcmin: number | null;
  inside_grid: boolean;
  /** The sights fix a point here (full rank, condition number < 1e6); false along a valley. */
  well_determined: boolean;
  converged: boolean;
}

/** The lowest node: row `i` from the south edge, column `j` from the west edge. */
export interface MisfitGridNode {
  i: number;
  j: number;
  lat_deg: number;
  lon_deg: number;
  chi2: number;
  delta_chi2: number;
}

export type MisfitLevelName = 'one_sigma' | 'p95' | 'three_sigma';

/** One contour level: `chi2 = min.chi2 + delta_chi2`. */
export interface MisfitLevel {
  name: MisfitLevelName;
  /** `68.3 % (1 sigma)`, `95 %`, `99.7 % (3 sigma)`. */
  label: string;
  confidence: number;
  delta_chi2: number;
  chi2: number;
}

export interface MisfitSight {
  id: string;
  body: string;
  sigma_arcmin: number;
  /** Multiplier on 1 / sigma²: 1 unless the solver's final robust weights are held fixed. */
  weight: number;
}

/** What `solve` returned for the same inputs. */
export type MisfitSolveKind = FixResult['kind'];

/** `misfit_grid` (EXPLORER_API "Misfit grid"). */
export interface MisfitGrid {
  bounds: MisfitBounds;
  /** The columns run past 180 degrees (`bounds.east_deg > 180`). */
  crosses_antimeridian: boolean;
  n_lat: number;
  n_lon: number;
  lat_step_deg: number;
  lon_step_deg: number;
  /** Node latitudes, south to north. */
  lat_deg: number[];
  /**
   * Node longitudes, west to east, normalised to (-180, 180]; they jump by -360 where the
   * grid crosses the antimeridian (`bounds.west_deg + j * lon_step_deg` has no jump).
   */
  lon_deg: number[];
  /** Row-major, south row first: `chi2[i * n_lon + j]` at `(lat_deg[i], lon_deg[j])`. */
  chi2: Float64Array;
  /** The best point: the levels are measured from it. */
  min: MisfitPoint;
  grid_min: MisfitGridNode;
  /** Distinct polished minima, best first (at most 8), `min` included. */
  basins: MisfitPoint[];
  /** 2, or 3 with the shared bias estimated. */
  unknowns: number;
  /** Usable sights minus unknowns; zero or negative when nothing is redundant. */
  dof: number;
  /** 1 sigma, 95 %, 3 sigma, in that order. */
  levels: MisfitLevel[];
  bias_profiled: boolean;
  weighted: boolean;
  sights: MisfitSight[];
  /** Plain-language caveats for this map. */
  notes: string[];
  solve_kind: MisfitSolveKind;
}

/** `misfit_default_bounds`: the frame `misfit_grid` uses when given no bounds. */
export interface MisfitDefaultBounds {
  bounds: MisfitBounds;
  centre: LatLon;
  centred_on: 'fix' | 'candidates' | 'initializer' | 'circle';
  /** The radius kept round each point framed, nautical miles. */
  radius_nm: number;
  reason: string;
  solve_kind: MisfitSolveKind;
}

/**
 * The residual heat map of a solve. The session, mode and options are exactly what
 * `solve` takes; `bounds` null means the default frame; 2 to 1024 nodes along each axis.
 * Errors throw.
 */
export interface MisfitEngine {
  misfitGrid(
    session: Session,
    mode: EphemerisMode,
    options: Partial<SolveOptions> | null,
    bounds: MisfitBounds | null,
    nLat: number,
    nLon: number,
  ): MisfitGrid;
  misfitDefaultBounds(session: Session, mode: EphemerisMode, options: Partial<SolveOptions> | null): MisfitDefaultBounds;
}

/**
 * `ExplorerEngine.misfit` (interface merging, so the declaration above stays untouched):
 * present when the engine's build has the misfit exports; a package built before them has
 * none.
 */
export interface ExplorerEngine {
  readonly misfit?: MisfitEngine;
}

// ---------------------------------------------------------------------------
// Wave 2 — eclipses. Rust: crates/skyfix-wasm/src/eclipses.rs over
// skyfix_almanac::eclipses. Wire format: docs/EXPLORER_API.md, "Wave 2 — eclipses".
// ---------------------------------------------------------------------------

export type SolarEclipseType = 'total' | 'annular' | 'hybrid' | 'partial';
export type LunarEclipseType = 'total' | 'partial' | 'penumbral';

/** A global contact: when the penumbra or umbra first/last touches the Earth (solar),
 * or the Moon enters/leaves the penumbra or umbra (lunar). */
export interface EclipseContact {
  kind: 'p1' | 'u1' | 'u2' | 'u3' | 'u4' | 'p4';
  jd_utc: number;
  utc: string;
}

export interface SolarEclipseGreatest {
  jd_utc: number;
  utc: string;
  jd_tt: number;
  /** On the central line, or the point of the Earth's limb nearest the shadow axis. */
  lat_deg: number;
  lon_deg: number;
  sun_alt_deg: number;
  sun_az_deg: number;
}

export interface SolarEclipse {
  kind: 'solar';
  /** `"YYYY-MM-DD-solar"`: the UTC date of greatest eclipse. */
  id: string;
  type: SolarEclipseType;
  /** The shadow axis meets the Earth. */
  central: boolean;
  greatest: SolarEclipseGreatest;
  /** Central: Moon/Sun diameter ratio. Otherwise: fraction of the Sun's diameter covered. */
  magnitude: number;
  /** Axis distance from the Earth's centre at greatest eclipse, Earth radii, + north. */
  gamma: number;
  saros: number;
  lunation: number;
  /** `p1`, `u1`, `u4`, `p4` as they occur. */
  contacts: EclipseContact[];
  path_width_km: number | null;
  central_duration_s: number | null;
  /** TT − UT1 the ground track assumes. */
  delta_t_s: number;
}

export interface LunarEclipseGreatest {
  jd_utc: number;
  utc: string;
  jd_tt: number;
  /** Where the Moon is overhead. */
  lat_deg: number;
  lon_deg: number;
}

export interface LunarEclipse {
  kind: 'lunar';
  /** `"YYYY-MM-DD-lunar"`. */
  id: string;
  type: LunarEclipseType;
  greatest: LunarEclipseGreatest;
  umbral_magnitude: number;
  penumbral_magnitude: number;
  gamma: number;
  saros: number;
  lunation: number;
  /** `p1`, `u1`, `u2`, `u3`, `u4`, `p4` as they occur. */
  contacts: EclipseContact[];
  penumbral_duration_s: number | null;
  partial_duration_s: number | null;
  total_duration_s: number | null;
  delta_t_s: number;
}

export type Eclipse = SolarEclipse | LunarEclipse;

export interface EclipseConventions {
  moon_radius_k_penumbra: number;
  moon_radius_k_umbra: number;
  lunar_shadow: string;
  delta_t: string;
  sources: string;
}

export interface EclipseList {
  /** The window actually searched: the request clipped to the coverage
   * (`jd_start > jd_end`, and no eclipses, when the request lies wholly outside it). */
  jd_start: number;
  jd_end: number;
  /** The request extended beyond the coverage. */
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  /** Sorted by greatest eclipse. */
  eclipses: Eclipse[];
  conventions: EclipseConventions;
}

export type EclipseVisibility = 'visible' | 'partly_below_horizon' | 'below_horizon' | 'none';
export type LocalEclipseType = 'total' | 'annular' | 'partial' | 'none';
export type EclipseLocalEventKind =
  | 'c1'
  | 'c2'
  | 'max'
  | 'c3'
  | 'c4'
  | 'p1'
  | 'u1'
  | 'u2'
  | 'u3'
  | 'u4'
  | 'p4'
  | 'sunrise'
  | 'sunset'
  | 'moonrise'
  | 'moonset';

export interface EclipseLocalEvent {
  kind: EclipseLocalEventKind;
  jd_utc: number;
  utc: string;
  /** The eclipsed body (Sun or Moon), topocentric geometric (CONVENTIONS §13.2). */
  alt_deg: number;
  az_deg: number;
  /** Above its rise/set altitude (§13.3). */
  visible: boolean;
  /** Solar contacts: where the limbs touch on the Sun, from north / from the zenith. */
  position_angle_deg: number | null;
  vertex_angle_deg: number | null;
  /** Solar maximum and the visible maximum. */
  magnitude: number | null;
  obscuration: number | null;
}

export interface EclipseObserverEcho {
  lat_deg: number;
  lon_deg: number;
  height_m: number;
}

export interface SolarEclipseLocal {
  kind: 'solar';
  id: string;
  observer: EclipseObserverEcho;
  visibility: EclipseVisibility;
  local_type: LocalEclipseType;
  /** At the geometric maximum, Sun up or not (0 when `none`). */
  magnitude: number;
  obscuration: number;
  duration_s: number | null;
  central_duration_s: number | null;
  /** `c1`, `c2`, `max`, `c3`, `c4`, `sunrise`, `sunset`, sorted by time. */
  events: EclipseLocalEvent[];
  /** The most the observer sees: the maximum, or the sunrise/sunset nearest it. */
  visible_max: EclipseLocalEvent | null;
  delta_t_s: number;
}

export interface LunarEclipseLocal {
  kind: 'lunar';
  id: string;
  observer: EclipseObserverEcho;
  visibility: EclipseVisibility;
  /** `p1` … `p4`, `max`, `moonrise`, `moonset`, sorted by time. */
  events: EclipseLocalEvent[];
  delta_t_s: number;
}

export type EclipseLocal = SolarEclipseLocal | LunarEclipseLocal;

/** GeoJSON-ready: `segments` is MultiLineString coordinates, split at ±180°. */
export interface EclipsePolyline {
  /** `[[lon_deg, lat_deg], …]` per segment. */
  segments: [number, number][][];
  /** UTC Julian date of each vertex, parallel to `segments`. */
  jd_utc: number[][];
}

export interface SolarEclipsePath {
  kind: 'solar';
  id: string;
  type: SolarEclipseType;
  central: boolean;
  greatest: SolarEclipseGreatest;
  central_line: EclipsePolyline;
  /** Limits of totality or annularity. */
  umbra_north: EclipsePolyline;
  umbra_south: EclipsePolyline;
  /** Closed loops closing the path of totality at sunrise and sunset. */
  umbra_horizon: EclipsePolyline;
  /** Limits of the partial eclipse. */
  penumbra_north: EclipsePolyline;
  penumbra_south: EclipsePolyline;
  /** Closed loops where the partial eclipse begins or ends at sunrise or sunset. */
  penumbra_horizon: EclipsePolyline;
  delta_t_s: number;
}

export interface SublunarPoint {
  kind: EclipseLocalEventKind;
  jd_utc: number;
  utc: string;
  lat_deg: number;
  lon_deg: number;
}

export interface LunarEclipsePath {
  kind: 'lunar';
  id: string;
  type: LunarEclipseType;
  /** The point under the Moon at each contact and at greatest eclipse. */
  sublunar: SublunarPoint[];
  delta_t_s: number;
}

export type EclipsePath = SolarEclipsePath | LunarEclipsePath;

/** Eclipse calls (wave 2). Separate from `ExplorerEngine` so wave 1 is untouched. */
export interface EclipseEngine {
  /** Every eclipse with greatest eclipse in the window. ~0.3 s for 1990–2060 natively. */
  eclipses(jdStart: number, jdEnd: number): EclipseList;
  eclipseLocal(id: string, observer: Observer): EclipseLocal;
  /** Solar: paths for the map (≤ 50 ms). Lunar: sub-lunar points. */
  eclipsePath(id: string): EclipsePath;
}

/** True when `engine` can compute eclipses (the memoised engine forwards the methods). */
export function isEclipseEngine(engine: unknown): engine is EclipseEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<EclipseEngine>;
  return (
    typeof e.eclipses === 'function' &&
    typeof e.eclipseLocal === 'function' &&
    typeof e.eclipsePath === 'function'
  );
}

// ---------------------------------------------------------------------------
// Wave 2 — planet events. Rust: crates/skyfix-wasm/src/planet_events.rs over
// skyfix_almanac::planet_events. Wire format: docs/EXPLORER_API.md,
// "Wave 2 — planet events".
// ---------------------------------------------------------------------------

export type PlanetEventKind =
  | 'opposition'
  | 'conjunction'
  | 'inferior_conjunction'
  | 'superior_conjunction'
  | 'greatest_elongation_east'
  | 'greatest_elongation_west'
  | 'perigee';

export interface PlanetEvent {
  kind: PlanetEventKind;
  /** `Mercury` … `Neptune`. */
  body: string;
  jd_utc: number;
  utc: string;
  /** Apparent planet–Sun angle from the Earth's centre at that instant, degrees. */
  elongation_deg: number;
  /** Geocentric light-time distance. */
  distance_au: number;
  distance_km: number;
  /** Apparent visual magnitude; null where the model does not cover the geometry. */
  magnitude: number | null;
  /** Apparent geocentric of date. */
  ra_deg: number;
  dec_deg: number;
  /** Inferior conjunctions only: the planet crosses the Sun's disc (geocentric). */
  transit: boolean;
}

export interface PlanetEventList {
  /** The window actually searched: the request clipped to the coverage. */
  jd_start: number;
  jd_end: number;
  /** The request extended beyond the coverage. */
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  /** Sorted by time. */
  events: PlanetEvent[];
}

/** Planet events (wave 2). Geocentric: the same for every observer. */
export interface PlanetEventsEngine {
  /** Oppositions, conjunctions, greatest elongations and closest approaches in the
   * window. About 30 ms a year natively. Throws a string for a non-finite or reversed
   * window. */
  planetEvents(jdStart: number, jdEnd: number): PlanetEventList;
}

/** True when `engine` can find planet events (the memoised engine forwards the method). */
export function isPlanetEventsEngine(engine: unknown): engine is PlanetEventsEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as Partial<PlanetEventsEngine>).planetEvents === 'function'
  );
}

// ---------------------------------------------------------------------------------
// Expansion programme — shared contract (planner, 2026-09-24). See EXPLORER_API.md,
// "Expansion programme". Contract only until the wave-1 agents implement it; every
// engine method is behind a type guard, as the almanac and eclipse engines are.
// ---------------------------------------------------------------------------------

/** Coverage tier of an instant (CONVENTIONS §15.1). */
export type CoverageTier = 'validated' | 'labelled' | 'outside';

export interface CoverageTierSpan {
  tier: Exclude<CoverageTier, 'outside'>;
  start_utc: string;
  end_utc: string;
  /** Worst error over the span, or null when not measured. */
  accuracy_arcmin: number | null;
  notes?: string;
}

/** Additive fields (declaration merging with the original block above). */
export interface ExplorerCoverage {
  validated_start_utc?: string;
  validated_end_utc?: string;
  /** Names of the packs loaded in this page session. */
  packs_loaded?: string[];
}

export interface CoverageGroup {
  tiers?: CoverageTierSpan[];
}

/** Coverage tiers (deeptime agent). */
export interface CoverageTierEngine {
  tierAt(jdUtc: number): CoverageTier;
}

export function isCoverageTierEngine(engine: unknown): engine is CoverageTierEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as Partial<CoverageTierEngine>).tierAt === 'function'
  );
}

export type TimeScale = 'utc' | 'ut';
export type DeltaTSource = 'iers' | 'smh2016' | 'parabola' | 'prediction';
export type Dut1Source = 'iers' | 'user' | 'model' | 'assumed';
export type CalendarKind = 'julian' | 'gregorian';

export interface CivilDate {
  calendar: CalendarKind;
  /** Astronomical year (0 = 1 BC). */
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Year as people write it, with `era`: 585 BC is era_year 585, year −584. */
  era_year: number;
  era: 'BC' | 'AD';
}

export interface TimeInfo {
  jd_utc: number;
  utc: string;
  scale: TimeScale;
  tier: CoverageTier;
  delta_t_s: number;
  delta_t_sigma_s: number;
  delta_t_source: DeltaTSource;
  /** TT minus the app's clock: 32.184 + ΔAT on the UTC scale, ΔT on the UT scale. */
  tt_minus_clock_s: number;
  dut1_s: number;
  dut1_sigma_s: number;
  dut1_source: Dut1Source;
  /** The calendar the UI should show for this date. */
  calendar: CalendarKind;
  civil: CivilDate;
  julian_civil: CivilDate;
  notes: string[];
}

export interface CalendarConvertRequest {
  jd_utc?: number;
  civil?: Partial<CivilDate> & { calendar: CalendarKind; year: number; month: number; day: number };
}

export interface CalendarConversion {
  jd_utc: number;
  gregorian: CivilDate;
  julian: CivilDate;
}

/** Time scales, ΔT, DUT1 and calendars (timescales agent). */
export interface TimeEngine {
  timeInfo(jdUtc: number): TimeInfo;
  /** Explorer-wide user DUT1 in seconds; null returns to the history or model. */
  setDut1(seconds: number | null): void;
  calendarConvert(request: CalendarConvertRequest): CalendarConversion;
}

export function isTimeEngine(engine: unknown): engine is TimeEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as Partial<TimeEngine>).timeInfo === 'function'
  );
}

export interface PackStatus {
  name: string;
  /** The loaded pack's data version; '' until one is loaded (the manifest has the offered file's). */
  version: string;
  label: string;
  description: string;
  /** The loaded pack file's size; 0 until one is loaded. */
  bytes: number;
  provides: string[];
  loaded: boolean;
}

export interface PackInfo {
  name: string;
  version: string;
  /** The whole pack file's size, header included. */
  bytes: number;
  provides: string[];
}

/** Optional data packs (packs agent). */
export interface PackEngine {
  packs(): PackStatus[];
  /** Parses, verifies and installs a pack; throws a string on a bad file. Idempotent. */
  loadPack(name: string, bytes: Uint8Array): PackInfo;
}

export function isPackEngine(engine: unknown): engine is PackEngine {
  return (
    typeof engine === 'object' &&
    engine !== null &&
    typeof (engine as Partial<PackEngine>).loadPack === 'function'
  );
}

/**
 * One pack as the page sees it (packs agent, 2026-09-24): what the engine says
 * (`PackStatus`), what the site offers (its manifest) and what this device has saved.
 * `version`, `bytes`, `label` and `description` are the offered file's when the site
 * offers it, else the saved or loaded copy's.
 */
export interface PackState extends PackStatus {
  /** Listed in the site's `data/packs/manifest.json`: it can be downloaded. */
  offered: boolean;
  /** This build of the core can install it (its name is in `packs()`). */
  supported: boolean;
  /** A copy is saved on this device. */
  saved: boolean;
  savedBytes: number;
  /** The saved copy is an older revision than the site's; it is replaced on next use. */
  stale: boolean;
  /** Removed from this device while loaded: still in use until the page is reloaded. */
  removedInUse: boolean;
  /** A download in progress. */
  progress: { received: number; total: number } | null;
  /** The last thing that went wrong with this pack, in a sentence. */
  error: string | null;
}

/** The pack service every component reaches through `Ctx.packs` (packs agent). */
export interface PackService {
  /**
   * Makes sure a pack is loaded: at once when it is loaded or saved, otherwise after one
   * prompt that starts with `reason` (a sentence: "Positions before 1550 need the Deep time
   * pack.") and gives the size. False when declined (remembered for the page session), when
   * offline without a saved copy, or when the site does not offer it.
   */
  ensure(name: string, reason: string): Promise<boolean>;
  /** Every pack the site offers, and any other saved or loaded one. */
  status(): PackState[];
  /** Deletes the saved copy (a loaded pack stays in use until the page is reloaded). */
  remove(name: string): Promise<void>;
  /** Downloads, saves and loads a pack with no prompt (Settings → Data packs: Get). */
  get(name: string): Promise<boolean>;
  /** Called after every change: loaded, saved, removed, download progress. Returns the stop function. */
  subscribe(listener: () => void): () => void;
  /** Reads the site's pack list and this device's saved packs again. */
  refresh(): Promise<void>;
}
