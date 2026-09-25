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
  /**
   * UT1 − UTC in seconds for the directions (expansion programme, moonshape): read by
   * the WASM boundary of `predict_sextant`, `plan_sights` and `lunar_distance` to build
   * the providers, as a session's `clock.dut1_s` is for the methods. Absent or null:
   * automatic. Not part of the Rust `SightObserver`.
   */
  dut1_s?: number | null;
}

/** Any horizon the core's chain takes, a shore horizon included (sailings agent). */
export type SightHorizon = import('../../types.js').HorizonMode;
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
  /** Computed altitude and azimuth at the observer (CONVENTIONS §3; the Moon's altitude includes `earth_shape_arcmin`, §15.4). */
  hc_deg: number;
  zn_deg: number;
  /** The sextant reading (the double angle with a reflected artificial horizon). */
  hs_deg: number;
  /** Apparent altitude after index correction and dip or halving. */
  ha_deg: number;
  /** The forward chain from `hs_deg`, landing on `hc_deg`. */
  corrections: SightCorrectionBreakdown;
  warnings: SightWarning[];
  /**
   * The Moon's Earth-shape term included in `hc_deg`, arcminutes (CONVENTIONS 15.4); 0
   * for every other body. The reading is then the real (WGS84) Earth's. Expansion
   * programme.
   */
  earth_shape_arcmin: number;
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
  /** The observer as the plan used it (`dut1_s` is read at the boundary and not echoed). */
  observer: Required<Omit<SightObserver, 'dut1_s'>>;
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

// ---------------------------------------------------------------------------------
// Expansion programme — sun tools (suntools agent, P7). Rust: crates/skyfix-wasm/src/
// suntools.rs over skyfix_almanac::sun_tools. Wire format: docs/EXPLORER_API.md,
// "Expansion programme — sun tools"; definitions: CONVENTIONS 13.10. Every altitude is
// the topocentric one of CONVENTIONS 13.2 (`alt_deg` geometric, `alt_apparent_deg` with
// the display refraction) and agrees with `skyState` at the same instant.
// ---------------------------------------------------------------------------------

/** Golden hour: the Sun's centre between -4° and +6° (geometric); blue hour: -6° to -4°. */
export type SunLightKind = 'golden' | 'blue';
/**
 * `morning`/`evening`: the Sun climbs/sinks through the band; `midday`: it culminates
 * inside it (high-latitude winter); `midnight`: its lower culmination is inside it
 * (high-latitude summer); `all_day`: it stays in the band for the whole window.
 */
export type SunLightPeriod = 'morning' | 'evening' | 'midday' | 'midnight' | 'all_day';

export interface SunLightWindow {
  kind: SunLightKind;
  period: SunLightPeriod;
  jd_start: number;
  utc_start: string;
  jd_end: number;
  utc_end: string;
  duration_min: number;
  /** The Sun was already in the band when the requested window began (not a crossing). */
  open_start: boolean;
  /** The Sun was still in the band when the requested window ended. */
  open_end: boolean;
}

/** One threshold (-6, -4 or +6 degrees), with the twilight vocabulary for none. */
export interface SunHourBoundary {
  altitude_deg: number;
  /** `alt_deg` of each is the threshold (geometric). */
  crossings: AltitudeCrossing[];
  always_above: boolean;
  always_below: boolean;
}

export interface SunHours {
  jd_start: number;
  jd_end: number;
  /** Golden and blue hours, time-ordered. */
  windows: SunLightWindow[];
  /** The -6, -4 and +6 degree thresholds, in that order. */
  boundaries: SunHourBoundary[];
  /** The Sun's rise, set, transits and twilight: `dayEvents` for the Sun. */
  sun: BodyEvents;
  phases: PhaseSegment[];
}

/**
 * Apparent altitude limits of a bearing crossing, degrees. `min_deg` absent or null:
 * "above the horizon" exactly as `above_horizon` says (upper limb above the sea-level
 * horizon); `max_deg` absent or null: no upper limit.
 */
export interface AzimuthAltitudeBand {
  min_deg?: number | null;
  max_deg?: number | null;
}

export interface AzimuthCrossing {
  jd_utc: number;
  utc: string;
  az_deg: number;
  alt_deg: number;
  alt_apparent_deg: number;
  /** The altitude is increasing. */
  rising: boolean;
  /** The azimuth is increasing (east to south to west, seen from above). */
  clockwise: boolean;
}

/** Rise and set are the event finder's (upper limb on the sea-level horizon); `at_altitude` is the centre's apparent altitude. */
export type AlignmentEvent = { kind: 'rise' } | { kind: 'set' } | { kind: 'at_altitude'; altitude_deg: number };

export interface AlignmentRequest {
  /** Default `Sun`. */
  body?: string;
  year: number;
  azimuth_deg: number;
  /** Default 0.5. */
  tolerance_deg?: number;
  event: AlignmentEvent;
  /** The clock the dates are written on; absent or null: local mean time. */
  utc_offset_hours?: number | null;
  /** Rise and set only. */
  options?: EventOptions | null;
}

export type AlignmentKind = 'rise' | 'set' | 'rising' | 'setting';

export interface AlignmentMatch {
  /** Local date on the request's clock. */
  date: string;
  kind: AlignmentKind;
  jd_utc: number;
  utc: string;
  az_deg: number;
  /** `az_deg - azimuth_deg`, wrapped into (-180, 180]. */
  offset_deg: number;
  alt_deg: number;
  /** The closest day of its run of consecutive matching days. */
  best: boolean;
}

export interface AlignmentResult {
  body: string;
  year: number;
  azimuth_deg: number;
  tolerance_deg: number;
  event: AlignmentEvent;
  utc_offset_hours: number;
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  events_considered: number;
  matches: AlignmentMatch[];
  /** The year's event nearest the bearing, matching or not; null when there is none. */
  closest: AlignmentMatch | null;
}

/** `lmt`: local mean time at the observer's longitude; `zone`: a fixed offset all year (no daylight saving). */
export type AnalemmaClock = 'lmt' | 'zone';

export interface AnalemmaRequest {
  year: number;
  /** Clock time of day, hours in [0, 24). */
  time_h: number;
  clock: AnalemmaClock;
  /** Required for `zone`, refused for `lmt`. */
  utc_offset_hours?: number | null;
}

export interface AnalemmaPoint {
  date: string;
  jd_utc: number;
  utc: string;
  alt_deg: number;
  alt_apparent_deg: number;
  az_deg: number;
  dec_deg: number;
  /** Equation of time, seconds (CONVENTIONS 13.9). */
  eot_s: number;
}

export interface Analemma {
  year: number;
  time_h: number;
  clock: AnalemmaClock;
  utc_offset_hours: number;
  points: AnalemmaPoint[];
  errors: BodyError[];
}

export type SunPathDayKind = 'day' | 'march_equinox' | 'june_solstice' | 'september_equinox' | 'december_solstice';

export interface SunPathPoint {
  jd_utc: number;
  alt_deg: number;
  alt_apparent_deg: number;
  az_deg: number;
}

export interface SunPathDay {
  day: SunPathDayKind;
  jd_start: number;
  jd_end: number;
  /** The equinox or solstice instant; null for the requested day. */
  season_jd_utc: number | null;
  points: SunPathPoint[];
}

export interface SunPath {
  step_minutes: number;
  path: SunPathDay;
  /** The same local day on the year's equinoxes and solstices, in calendar order. */
  envelope: SunPathDay[];
  errors: BodyError[];
}

export interface RiseSetAzimuthRequest {
  /** Default `Sun`. */
  body?: string;
  year: number;
  utc_offset_hours?: number | null;
  options?: EventOptions | null;
}

export interface RiseSetEventRef {
  jd_utc: number;
  utc: string;
  az_deg: number;
  alt_deg: number;
}

export interface RiseSetDay {
  date: string;
  jd_start: number;
  jd_end: number;
  rises: RiseSetEventRef[];
  sets: RiseSetEventRef[];
  transit: RiseSetEventRef | null;
  always_above: boolean;
  always_below: boolean;
}

export interface RiseSetAzimuths {
  body: string;
  year: number;
  utc_offset_hours: number;
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  days: RiseSetDay[];
}

export interface EotPoint {
  /** UTC date. */
  date: string;
  jd_utc: number;
  utc: string;
  /** Apparent minus mean solar time, seconds (positive: the sundial is fast). */
  eot_s: number;
  dec_deg: number;
}

export interface EotExtreme {
  kind: 'minimum' | 'maximum';
  date: string;
  jd_utc: number;
  eot_s: number;
}

export interface EquationOfTime {
  year: number;
  utc_hour: number;
  points: EotPoint[];
  extremes: EotExtreme[];
  errors: BodyError[];
}

export interface SolarPanel {
  /** Degrees from horizontal, 0 to 90; default 0. */
  tilt_deg?: number;
  /** The direction the panel faces; default toward the equator. */
  azimuth_deg?: number | null;
  /** Ground reflectance; default 0.2. */
  albedo?: number | null;
}

export interface SolarPanelUsed {
  tilt_deg: number;
  azimuth_deg: number;
  albedo: number;
}

/** What the solar model is and how far to trust it: show `label` and `typical_error` with every number. */
export interface SolarModel {
  label: string;
  clear_sky: string;
  diffuse_split: string;
  transposition: string;
  typical_error: string;
  not_modelled: string;
}

export interface SolarSample {
  jd_utc: number;
  sun_alt_apparent_deg: number;
  sun_az_deg: number;
  ghi_w_m2: number;
  dni_w_m2: number;
  dhi_w_m2: number;
  poa_w_m2: number;
  /** Null with the Sun down. */
  incidence_deg: number | null;
}

export interface SolarDay {
  jd_start: number;
  jd_end: number;
  step_minutes: number;
  panel: SolarPanelUsed;
  samples: SolarSample[];
  poa_kwh_m2: number;
  ghi_kwh_m2: number;
  dni_kwh_m2: number;
  peak_poa_w_m2: number;
  model: SolarModel;
}

export interface SolarYearRequest {
  year: number;
  panel?: SolarPanel;
  utc_offset_hours?: number | null;
  /** Default 10. */
  step_minutes?: number | null;
  optimise_tilt?: boolean;
}

export interface SolarDayTotal {
  date: string;
  jd_start: number;
  poa_kwh_m2: number;
  ghi_kwh_m2: number;
}

export interface SolarMonth {
  month: number;
  days: number;
  poa_kwh_m2: number;
  ghi_kwh_m2: number;
}

export interface SolarOptimalTilt {
  tilt_deg: number;
  azimuth_deg: number;
  poa_kwh_m2: number;
}

export interface SolarYear {
  year: number;
  utc_offset_hours: number;
  step_minutes: number;
  panel: SolarPanelUsed;
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  days: SolarDayTotal[];
  months: SolarMonth[];
  poa_kwh_m2: number;
  ghi_kwh_m2: number;
  optimal: SolarOptimalTilt | null;
  model: SolarModel;
}

export interface GalacticOptions {
  /** Default 10 (apparent altitude of the galactic centre). */
  min_altitude_deg?: number | null;
  /** Default -18 (geometric altitude of the Sun). */
  sun_max_altitude_deg?: number | null;
}

export interface GalacticMoment {
  jd_utc: number;
  utc: string;
  alt_deg: number;
  alt_apparent_deg: number;
  az_deg: number;
  /** The galactic equator's highest point above the horizon. */
  arch_top_alt_deg: number;
  arch_top_az_deg: number;
  /** Where the galactic equator meets the horizon, the smaller first. */
  arch_ends_az_deg: [number, number];
}

export interface GalacticWindow {
  jd_start: number;
  utc_start: string;
  jd_end: number;
  utc_end: string;
  duration_h: number;
  moon_up: boolean;
  moon_illuminated_fraction: number;
  /** The galactic centre at its highest in the window. */
  best: GalacticMoment;
}

export interface J2000Direction {
  ra_j2000_deg: number;
  dec_j2000_deg: number;
}

export interface GalacticCentreWindows {
  jd_start: number;
  jd_end: number;
  min_altitude_deg: number;
  sun_max_altitude_deg: number;
  galactic_centre: J2000Direction;
  galactic_pole: J2000Direction;
  windows: GalacticWindow[];
}

/** Sun tools (suntools agent). Each method throws a string-derived Error on malformed input or outside the coverage. */
export interface SunToolsEngine {
  /** Golden and blue hours over a window (one local day), with the Sun's events. About 1 ms. */
  sunHours(observer: Observer, jdStart: number, jdEnd: number): SunHours;
  /** When a body crosses a bearing inside an altitude band (window at most 400 days). */
  findAzimuth(
    observer: Observer,
    body: string,
    jdStart: number,
    jdEnd: number,
    azimuthDeg: number,
    band?: AzimuthAltitudeBand,
  ): AzimuthCrossing[];
  /** The days of a year a body rises, sets or stands at an altitude on a bearing. About 60 ms (the Moon 0.3 s). */
  alignmentDays(observer: Observer, request: AlignmentRequest): AlignmentResult;
  /** The Sun at one clock time on every day of a year. About 10 ms. */
  analemma(observer: Observer, request: AnalemmaRequest): Analemma;
  /** A day's sun path (default 10-minute steps) and the equinox and solstice envelope. */
  sunPath(observer: Observer, jdStart: number, jdEnd: number, stepMinutes?: number): SunPath;
  /** Daily rise and set azimuths over a local year. About 60 ms (the Moon 0.3 s). */
  riseSetAzimuths(observer: Observer, request: RiseSetAzimuthRequest): RiseSetAzimuths;
  /** The equation of time and the Sun's declination each UTC day of a year, at `utcHour` (default 12). */
  equationOfTime(year: number, utcHour?: number): EquationOfTime;
  /** Clear-sky irradiance on a panel through a window (at most two days), and its energy. */
  solarDay(observer: Observer, jdStart: number, jdEnd: number, panel?: SolarPanel, stepMinutes?: number): SolarDay;
  /** Clear-sky energy for every local day of a year, and optionally the best tilt. About 60 ms. */
  solarYear(observer: Observer, request: SolarYearRequest): SolarYear;
  /** The galactic centre's dark-sky windows over a span of nights (at most 400 days). */
  galacticCentreWindows(
    observer: Observer,
    jdStart: number,
    jdEnd: number,
    options?: GalacticOptions,
  ): GalacticCentreWindows;
}

const SUN_TOOLS_METHODS = [
  'sunHours',
  'findAzimuth',
  'alignmentDays',
  'analemma',
  'sunPath',
  'riseSetAzimuths',
  'equationOfTime',
  'solarDay',
  'solarYear',
  'galacticCentreWindows',
] as const;

/** True when `engine` has the sun tools (the WASM engine of a new enough build, or the mock). */
export function isSunToolsEngine(engine: unknown): engine is SunToolsEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Record<string, unknown>;
  return SUN_TOOLS_METHODS.every((m) => typeof e[m] === 'function');
}

// ---------------------------------------------------------------------------------
// Expansion programme — magnetic field and compass error (geomag agent). Rust:
// crates/skyfix-wasm/src/geomag.rs over skyfix_geomag (WMM2025, IGRF-14) and
// skyfix_core::methods::compass. Wire format: EXPLORER_API.md, "Expansion programme —
// magnetic field and compass error"; CONVENTIONS 14.1-14.2; NAVIGATION_METHODS §9.
// ---------------------------------------------------------------------------------

export type MagneticModelName = 'WMM2025' | 'IGRF-14';
/** Which model answers: WMM2025 in 2025.0–2030.0 and IGRF-14 before (`auto`), or one of them. */
export type MagneticModelChoice = 'auto' | 'wmm2025' | 'igrf14';
/** By the horizontal intensity: `blackout` < 2000 nT (compass unreliable), `caution` < 6000 nT. */
export type MagneticZone = 'normal' | 'caution' | 'blackout';

/** Annual rate of change of each element. */
export interface MagneticAnnualChange {
  declination_deg_per_year: number;
  inclination_deg_per_year: number;
  horizontal_nt_per_year: number;
  north_nt_per_year: number;
  east_nt_per_year: number;
  down_nt_per_year: number;
  total_nt_per_year: number;
}

/** One standard deviation of each element, and where the numbers come from (CONVENTIONS 14.1). */
export interface MagneticUncertainty {
  declination_deg: number;
  inclination_deg: number;
  horizontal_nt: number;
  north_nt: number;
  east_nt: number;
  down_nt: number;
  total_nt: number;
  basis: string;
}

/** `magnetic_field` when a model answers. */
export interface MagneticFieldValue {
  available: true;
  jd_utc: number;
  utc: string;
  model: MagneticModelName;
  decimal_year: number;
  lat_deg: number;
  /** Normalised to (−180, 180]. */
  lon_deg: number;
  height_m: number;
  /** Magnetic variation: true north to magnetic north, east positive. */
  declination_deg: number;
  /** Dip below the horizontal, down positive. */
  inclination_deg: number;
  horizontal_nt: number;
  /** X, Y, Z in the geodetic frame. */
  north_nt: number;
  east_nt: number;
  down_nt: number;
  total_nt: number;
  annual_change: MagneticAnnualChange;
  uncertainty: MagneticUncertainty;
  zone: MagneticZone;
  /** After 2025.0 the value extrapolates a forecast rate of change. */
  forecast: boolean;
  /** Plain sentences (zones, less certain eras, forecasts). */
  notes: string[];
  /** `11.8° W`. */
  variation_text: string;
  /** `1.6′ E a year`. */
  annual_change_text: string;
  /** `Variation 11.8° W ±0.4° (WMM2025), changing 1.6′ E a year.` */
  sentence: string;
}

/** `magnetic_field` when no model covers the date (before 1900, after 2030) or height. */
export interface MagneticFieldUnavailable {
  available: false;
  jd_utc: number;
  utc: string;
  decimal_year: number;
  lat_deg: number;
  lon_deg: number;
  height_m: number;
  reason: string;
}

export type MagneticField = MagneticFieldValue | MagneticFieldUnavailable;

/** `magnetic_grid`: row by row from the first latitude, west to east. */
export interface MagneticGrid {
  model: MagneticModelName;
  decimal_year: number;
  lat_deg: Float64Array;
  lon_deg: Float64Array;
  declination_deg: Float64Array;
  horizontal_nt: Float64Array;
}

export type CompassMethod = 'azimuth' | 'amplitude';
export type CompassKind = 'magnetic' | 'gyro';
export type AmplitudeHorizon = 'visible' | 'celestial';
export type RiseSet = 'rising' | 'setting';

/** `compass_error` request (EXPLORER_API.md). Give `utc` or `jd_utc`. */
export interface CompassRequest {
  method?: CompassMethod;
  body: string;
  utc?: string;
  jd_utc?: number;
  observer: { lat_deg: number; lon_deg: number; height_m?: number };
  /** What the compass read, [0, 360). */
  compass_bearing_deg: number;
  compass?: CompassKind;
  /** A chart's variation, east positive; null: the model's. */
  variation_deg?: number | null;
  variation_sigma_deg?: number | null;
  bearing_sigma_deg?: number | null;
  magnetic_model?: MagneticModelChoice;
  horizon?: AmplitudeHorizon;
  height_of_eye_m?: number;
  limb?: SightLimb;
  event?: RiseSet | null;
  pressure_hpa?: number;
  temperature_c?: number;
}

export interface CompassVariation {
  /** East positive. */
  deg: number;
  sigma_deg: number | null;
  source: MagneticModelName | 'given';
  text: string;
  notes: string[];
}

export interface CompassAzimuthDetails {
  gha_deg: number;
  dec_deg: number;
  /** Topocentric geometric altitude of the centre. */
  altitude_deg: number;
  /** CONVENTIONS 3 Zn, what the sight-reduction tables give. */
  zn_spherical_deg: number;
  azimuth_rate_deg_per_min: number;
}

export interface CompassAmplitudeDetails {
  event: RiseSet;
  horizon: AmplitudeHorizon;
  dec_deg: number;
  /** On the celestial horizon, north positive; null when the body never reaches it. */
  amplitude_deg: number | null;
  /** `W 1.0° S`. */
  amplitude_text: string | null;
  celestial_bearing_deg: number | null;
  /** Geocentric altitude of the centre when the bearing was taken. */
  altitude_deg: number;
  /** Visible minus celestial bearing; Bowditch's Table 23 correction is its negative. */
  visible_horizon_correction_deg: number;
  dip_arcmin: number;
  refraction_arcmin: number;
  semidiameter_arcmin: number;
  parallax_arcmin: number;
  /** Degrees of bearing per degree of misjudged altitude. */
  bearing_per_altitude: number;
  minutes_from_given_time: number;
}

/** `compass_error` result (EXPLORER_API.md; CONVENTIONS 14.2). */
export interface CompassError {
  method: CompassMethod;
  body: string;
  compass: CompassKind;
  jd_utc: number;
  utc: string;
  true_bearing_deg: number;
  compass_bearing_deg: number;
  /** True minus compass, (−180, 180], east positive. */
  compass_error_deg: number;
  compass_error_text: string;
  compass_error_sigma_deg: number | null;
  variation: CompassVariation | null;
  /** Compass error minus variation, east positive. */
  deviation_deg: number | null;
  deviation_sigma_deg: number | null;
  deviation_text: string | null;
  /** `Compass error 14.4° W; variation 11.8° W; deviation 2.6° W.` */
  sentence: string;
  explanation: string;
  azimuth: CompassAzimuthDetails | null;
  amplitude: CompassAmplitudeDetails | null;
  direction_source: string;
  notes: string[];
}

/** Magnetic variation and compass error (geomag agent). */
export interface GeomagEngine {
  /** Never throws for a date or height no model covers: `available: false` with the reason. */
  magneticField(
    latDeg: number,
    lonDeg: number,
    heightM: number,
    jdUtc: number,
    model?: MagneticModelChoice,
  ): MagneticField;
  /** Declination on a grid for isogonic lines (≤ 70 000 points); null when no model covers the date. */
  magneticGrid(
    jdUtc: number,
    latMin: number,
    latMax: number,
    nLat: number,
    lonMin: number,
    lonMax: number,
    nLon: number,
    heightM?: number,
  ): MagneticGrid | null;
  /** Throws a string for malformed input or a body the engine cannot place. */
  compassError(request: CompassRequest): CompassError;
}

/** True when `engine` has the magnetic field and compass error (the memoised engine forwards them). */
export function isGeomagEngine(engine: unknown): engine is GeomagEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<GeomagEngine>;
  return (
    typeof e.magneticField === 'function' &&
    typeof e.magneticGrid === 'function' &&
    typeof e.compassError === 'function'
  );
}

// ---------------------------------------------------------------------------------
// Timescales agent (expansion wave 1): additive fields by declaration merging. See
// EXPLORER_API.md, "Time scales, Delta-T and calendars (timescales agent)".
// ---------------------------------------------------------------------------------

/**
 * Standard uncertainty of `delta_t_s`, seconds (CONVENTIONS 15.2): DUT1's on the UTC
 * scale (0.001 s from the IERS table, 0.05 s for a value the user set, 0.9 s when
 * unknown), the Delta-T model's on the UT scale. Every eclipse output from this core
 * on carries it; an older build does not, hence optional.
 */
export interface SolarEclipse {
  delta_t_sigma_s?: number;
}
export interface LunarEclipse {
  delta_t_sigma_s?: number;
}
export interface SolarEclipseLocal {
  delta_t_sigma_s?: number;
}
export interface LunarEclipseLocal {
  delta_t_sigma_s?: number;
}
export interface SolarEclipsePath {
  delta_t_sigma_s?: number;
}
export interface LunarEclipsePath {
  delta_t_sigma_s?: number;
}

// ---------------------------------------------------------------------------------
// Expansion programme — sailings, dead reckoning, star identification, star finder
// (sailings agent, 2026-09-24). Rust: crates/skyfix-core/src/sailings/,
// crates/skyfix-core/src/methods/{starid,starfinder}.rs, crates/skyfix-wasm/src/sailings.rs.
// Wire format: docs/EXPLORER_API.md, "Expansion programme — sailings"; methods:
// docs/NAVIGATION_METHODS.md sections 9-11. Behind `isSailingsEngine`.
// ---------------------------------------------------------------------------------

/** The figure Mercator sailing's meridional parts are computed on (default `sphere`). */
export type MeridionalParts = 'sphere' | 'wgs84';
/** How a leg of constant course is run (default `rhumb`). */
export type DrMethod = 'rhumb' | 'mid_latitude' | 'great_circle';
/** Waypoints every so many NM, or on every whole multiple of so many degrees of longitude. */
export type WaypointSpacing = { every_nm: number } | { every_deg_lon: number };

export interface PassageRequest {
  from: LatLonDeg;
  to: LatLonDeg;
  waypoints?: WaypointSpacing | null;
  /** Composite sailing: north positive (47 keeps the track south of 47° N). */
  limiting_latitude_deg?: number | null;
  meridional_parts?: MeridionalParts;
  speed_kn?: number | null;
  departure_utc?: string | null;
}

export interface SailingVertex {
  lat_deg: number;
  lon_deg: number;
  /** Along the track from the departure; negative when behind it. */
  distance_from_start_nm: number;
  on_route: boolean;
}

export interface SailingWaypoint {
  index: number;
  lat_deg: number;
  lon_deg: number;
  /** Along the great circle (or composite track). */
  distance_from_start_nm: number;
  track_course_deg: number;
  /** The rhumb line to the next waypoint; null at the destination. */
  leg_course_deg: number | null;
  leg_distance_nm: number | null;
  /** Rhumb-line legs sailed to here. */
  sailed_nm: number;
  eta_utc: string | null;
  eta_jd_utc: number | null;
}

export interface SailingArrival {
  hours: number;
  utc: string | null;
  jd_utc: number | null;
}

export interface GreatCircleReport {
  distance_nm: number;
  distance_km: number;
  distance_deg: number;
  initial_course_deg: number | null;
  final_course_deg: number | null;
  vertex: SailingVertex | null;
  highest_latitude_deg: number;
  equator_crossing: LatLonDeg | null;
  waypoints: SailingWaypoint[];
  waypoint_route_nm: number;
  /** For drawing, at most 60 NM apart. */
  track: LatLonDeg[];
  arrival: SailingArrival | null;
}

export interface RhumbReport {
  course_deg: number | null;
  distance_nm: number;
  distance_km: number;
  dlat_arcmin: number;
  dlo_arcmin: number;
  departure_nm: number;
  /** Null when an end is at a pole. */
  meridional_difference_arcmin: number | null;
  meridional_parts: MeridionalParts;
  track: LatLonDeg[];
  arrival: SailingArrival | null;
}

export interface MidLatitudeReport {
  course_deg: number | null;
  distance_nm: number;
  mean_latitude_deg: number;
  dlat_arcmin: number;
  dlo_arcmin: number;
  departure_nm: number;
  arrival: SailingArrival | null;
}

export interface CompositeLegReport {
  kind: 'great_circle' | 'parallel';
  from: LatLonDeg;
  to: LatLonDeg;
  distance_nm: number;
  initial_course_deg: number | null;
  final_course_deg: number | null;
}

export interface CompositeReport {
  limiting_latitude_deg: number;
  /** False when the great circle stays within the limit (then it is the track). */
  applies: boolean;
  distance_nm: number;
  distance_km: number;
  extra_distance_nm: number;
  legs: CompositeLegReport[];
  waypoints: SailingWaypoint[];
  waypoint_route_nm: number;
  track: LatLonDeg[];
  arrival: SailingArrival | null;
  note: string;
}

export interface PassageReport {
  from: LatLonDeg;
  to: LatLonDeg;
  great_circle: GreatCircleReport;
  rhumb_line: RhumbReport;
  /** Null across the equator. */
  mid_latitude: MidLatitudeReport | null;
  composite: CompositeReport | null;
  great_circle_saving_nm: number;
  speed_kn: number | null;
  departure_utc: string | null;
  notes: string[];
}

export interface DrRequest {
  from: LatLonDeg;
  course_deg: number;
  speed_kn: number;
  /** Negative: where the vessel was that long before. */
  hours: number;
  method?: DrMethod;
  meridional_parts?: MeridionalParts;
  start_utc?: string | null;
}

export interface DrReport {
  from: LatLonDeg;
  to: LatLonDeg;
  course_deg: number;
  speed_kn: number;
  hours: number;
  distance_nm: number;
  method: DrMethod;
  meridional_parts: MeridionalParts;
  /** The course on arrival: turns along a great circle, constant on a rhumb line. */
  final_course_deg: number;
  arrival_utc: string | null;
  arrival_jd_utc: number | null;
}

/** The running fix's leg shape (`RunningFixLeg`): a route's legs go to `runningFix` as they are. */
export interface RouteLeg {
  start_utc?: string | null;
  course_deg: number;
  speed_kn: number;
}

export interface RouteRequest {
  start: LatLonDeg;
  start_utc: string;
  legs: RouteLeg[];
  end_utc?: string | null;
  method?: DrMethod;
  meridional_parts?: MeridionalParts;
  times_utc?: string[];
  /** Needs `end_utc`. */
  step_minutes?: number | null;
}

export type RouteStatus = 'before_start' | 'waiting' | 'under_way' | 'after_end';

export interface RoutePoint {
  utc: string;
  jd_utc: number;
  lat_deg: number;
  lon_deg: number;
  leg: number | null;
  status: RouteStatus;
  distance_run_nm: number;
}

export interface RouteLegReport {
  index: number;
  start_utc: string;
  start_jd_utc: number;
  end_utc: string | null;
  end_jd_utc: number | null;
  from: LatLonDeg;
  to: LatLonDeg | null;
  course_deg: number;
  speed_kn: number;
  distance_nm: number | null;
}

export interface RouteMadeGood {
  course_deg: number | null;
  distance_nm: number;
  hours: number;
  speed_kn: number | null;
}

export interface RouteReport {
  method: DrMethod;
  meridional_parts: MeridionalParts;
  legs: RouteLegReport[];
  points: RoutePoint[];
  made_good: RouteMadeGood | null;
  notes: string[];
}

export type BearingKind = 'true' | 'magnetic' | 'compass';

export interface StarIdRequest {
  /** RFC 3339 UTC, already corrected for the watch. */
  utc: string;
  observer: SightObserver;
  instrument?: SightInstrument & { index_error_log?: import('../../types.js').IndexErrorLogEntry[] };
  altitude_deg: number;
  altitude_kind?: SightAltitudeKind;
  bearing_deg: number;
  bearing_kind?: BearingKind;
  /** Degrees, east positive. */
  variation_deg?: number | null;
  deviation_deg?: number | null;
  /** Default 2. */
  altitude_tolerance_deg?: number;
  /** Default 5. */
  bearing_tolerance_deg?: number;
}

export type StarIdCandidateKind = 'star' | 'planet' | 'moon';

export interface StarIdMatch {
  rank: number;
  body: string;
  kind: StarIdCandidateKind;
  navigational: boolean;
  /** Airless topocentric altitude at the DR (the Moon's parallax removed). */
  altitude_deg: number;
  azimuth_deg: number;
  /** Observed minus the body's. */
  delta_altitude_deg: number;
  delta_bearing_deg: number;
  separation_deg: number;
  score: number;
  within_tolerance: boolean;
  magnitude: number | null;
  bright_enough: boolean | null;
}

export interface StarIdResult {
  utc: string;
  jd_utc: number;
  observed_altitude_deg: number;
  observed_bearing_deg: number;
  corrections: SightCorrectionBreakdown;
  altitude_tolerance_deg: number;
  bearing_tolerance_deg: number;
  sun_altitude_deg: number;
  sky: SkyPhase;
  limiting_magnitude: number;
  candidates: StarIdMatch[];
  best: string | null;
  ambiguous: boolean;
  message: string;
  source: string;
  warnings: SightWarning[];
  notes: string[];
}

export type StarFinderSide = 'north' | 'south';
export type StarFinderPoint = [number, number];

export interface StarFinderStar {
  name: string;
  sha_deg: number;
  dec_deg: number;
  magnitude: number;
  north: StarFinderPoint;
  south: StarFinderPoint;
}

export interface AriesTick {
  lha_aries_deg: number;
  north: StarFinderPoint;
  south: StarFinderPoint;
  kind: 'label' | 'major' | 'minor';
}

export interface StarFinderLine {
  value_deg: number;
  points: StarFinderPoint[];
}

export interface StarFinderTemplate {
  latitude_deg: number;
  side: StarFinderSide;
  zenith: StarFinderPoint;
  horizon: StarFinderPoint[];
  altitude_circles: StarFinderLine[];
  azimuth_lines: StarFinderLine[];
}

/** Unit-disc coordinates, x right, y up, the base seen from outside the sphere. */
export interface StarFinderGeometry {
  requested_latitude_deg: number;
  template_latitude_deg: number;
  side: StarFinderSide;
  /** Rotate the template anticlockwise by rotation_sign × LHA ♈ degrees. */
  rotation_sign: number;
  equator_radius: number;
  epoch: string;
  stars: StarFinderStar[];
  aries_index: AriesTick[];
  template: StarFinderTemplate;
  notes: string[];
}

/** Sailings, dead reckoning, routes, star identification and the star finder. */
export interface SailingsEngine {
  sailing(request: PassageRequest): PassageReport;
  drAdvance(request: DrRequest): DrReport;
  routePositions(request: RouteRequest): RouteReport;
  starIdentify(request: StarIdRequest): StarIdResult;
  /** `latBand`: any latitude, snapped to its template (5° to 85°, signed); `jdUtc` plots apparent places of that date. */
  starFinderGeometry(latBand: number, jdUtc?: number): StarFinderGeometry;
}

export function isSailingsEngine(engine: unknown): engine is SailingsEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<SailingsEngine>;
  return (
    typeof e.sailing === 'function' &&
    typeof e.drAdvance === 'function' &&
    typeof e.routePositions === 'function' &&
    typeof e.starIdentify === 'function' &&
    typeof e.starFinderGeometry === 'function'
  );
}

// ---------------------------------------------------------------------------------
// Expansion programme P8 — the Moon in detail (moondetail agent). Rust:
// crates/skyfix-wasm/src/moondetail.rs over skyfix_almanac::{libration, lunar_features,
// apsides, occultations}. Wire format: docs/EXPLORER_API.md, "Moon in detail";
// definitions: CONVENTIONS 13.10.
// ---------------------------------------------------------------------------------

/** A place on the Moon, or a direction from its centre: selenographic latitude and east
 * longitude (toward Mare Crisium, IAU), degrees, longitude in (-180, 180]. */
export interface Selenographic {
  lat_deg: number;
  lon_deg: number;
}

/** Where a point of the Moon appears on its disc, in disc radii. */
export interface DiscPoint {
  /** Toward celestial east (position angle 90°) and north (0°). */
  east: number;
  north: number;
  /** As the observer sees it with the zenith up: x to the right, y up. Without an
   * observer: celestial north up, east to the left. */
  x: number;
  y: number;
  /** On the hemisphere facing the observer. */
  visible: boolean;
}

/** Libration, degrees: the selenographic place at the centre of the disc. */
export interface LibrationAngles {
  /** As the observer sees it (topocentric with an observer, else geocentric). */
  lon_deg: number;
  lat_deg: number;
  /** Meeus's optical (orbit) and physical (the Moon's own rocking) parts, geocentric. */
  optical_lon_deg: number;
  optical_lat_deg: number;
  physical_lon_deg: number;
  physical_lat_deg: number;
  /** The observer's own offset from the Earth's centre (up to about 1°); 0 without one. */
  diurnal_lon_deg: number;
  diurnal_lat_deg: number;
}

export interface MoonTerminator {
  /** The sub-solar point, the circle's pole. */
  pole: Selenographic;
  /** Where the sunrise and sunset terminators cross the lunar equator. */
  morning_lon_deg: number;
  evening_lon_deg: number;
  /** The whole great circle every 5°, `[lat_deg, lon_deg]`. */
  points: [number, number][];
  /** The half the observer sees, cusp to cusp, `[x, y]` in disc radii (DiscPoint x/y). */
  disc: [number, number][];
}

export interface MoonOrientation {
  jd_utc: number;
  utc: string;
  topocentric: boolean;
  libration: LibrationAngles;
  sub_observer: Selenographic;
  sub_earth: Selenographic;
  sub_solar: Selenographic;
  /** Selenographic colongitude of the Sun: ~270 new, 0 first quarter, 90 full, 180 last. */
  colongitude_deg: number;
  /** Position angle of the Moon's north pole as the observer sees it (north through east). */
  axis_position_angle_deg: number;
  geocentric_axis_position_angle_deg: number;
  /** Position angle of the bright limb's midpoint (the ephemeris's, geocentric). */
  bright_limb_angle_deg: number;
  illuminated_fraction: number;
  phase_angle_deg: number;
  waxing: boolean;
  terminator: MoonTerminator;
  /** Observer (or geocentre) to the Moon's centre. */
  distance_km: number;
  semidiameter_arcmin: number;
  apparent_diameter_arcmin: number;
  /** Size against the mean distance of 384 400 km, percent. */
  diameter_vs_mean_percent: number;
  geocentric_distance_km: number;
  geocentric_semidiameter_arcmin: number;
  /** Topocentric geometric; null without an observer. */
  alt_deg: number | null;
  az_deg: number | null;
  /** Position angle of the zenith at the Moon; null without an observer. */
  parallactic_angle_deg: number | null;
  north_pole_disc: DiscPoint;
  sub_solar_disc: DiscPoint;
}

export type LunarFeatureKind =
  | 'mare'
  | 'oceanus'
  | 'lacus'
  | 'sinus'
  | 'palus'
  | 'mons'
  | 'montes'
  | 'rupes'
  | 'rima'
  | 'vallis'
  | 'dorsum'
  | 'promontorium'
  | 'albedo'
  | 'crater'
  | 'landing_site';

export interface LunarFeatureState {
  name: string;
  kind: LunarFeatureKind;
  lat_deg: number;
  lon_deg: number;
  /** km; 0 for a landing site. */
  diameter_km: number;
  /** 1 showpiece, 2 notable, 3 more to find. */
  rank: 1 | 2 | 3;
  description: string;
  /** The Sun's altitude over the feature (negative: night). */
  sun_altitude_deg: number;
  lit: boolean;
  /** Lunar morning there (the Sun climbing). */
  morning: boolean;
  /** Faces the observer and the terminator crosses it or lies within the band: best relief. */
  near_terminator: boolean;
  visible: boolean;
  /** 0 at the disc's centre, 90 at the limb. */
  angle_from_disc_centre_deg: number;
  disc: DiscPoint;
}

export interface MoonFeatures {
  jd_utc: number;
  utc: string;
  topocentric: boolean;
  colongitude_deg: number;
  sub_solar: Selenographic;
  sub_observer: Selenographic;
  axis_position_angle_deg: number;
  parallactic_angle_deg: number | null;
  illuminated_fraction: number;
  waxing: boolean;
  terminator_band_deg: number;
  /** Visible relief features near the terminator, best first (names). */
  tonight: string[];
  /** All 150, in table order. */
  features: LunarFeatureState[];
  source: string;
}

export interface MoonApsis {
  kind: 'perigee' | 'apogee';
  jd_utc: number;
  utc: string;
  distance_km: number;
  semidiameter_arcmin: number;
  diameter_arcmin: number;
  diameter_vs_mean_percent: number;
}

export interface MoonApsisRef {
  jd_utc: number;
  utc: string;
  distance_km: number;
}

export interface MoonSyzygy {
  kind: 'new_moon' | 'full_moon';
  jd_utc: number;
  utc: string;
  distance_km: number;
  diameter_arcmin: number;
  diameter_vs_mean_percent: number;
  /** The perigee and apogee on either side of it in time. */
  perigee: MoonApsisRef;
  apogee: MoonApsisRef;
  hours_from_perigee: number;
  /** 0 at apogee, 1 at perigee. */
  perigee_fraction: number;
  /** perigee_fraction >= 0.9 (Nolle). */
  supermoon: boolean;
  /** perigee_fraction <= 0.1. */
  micromoon: boolean;
  /** Full Moons: nearest and farthest of the UTC calendar year. */
  largest_of_year: boolean;
  smallest_of_year: boolean;
}

export interface MoonApsides {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  apsides: MoonApsis[];
  syzygies: MoonSyzygy[];
  definitions: {
    apsis: string;
    supermoon: string;
    micromoon: string;
    largest_of_year: string;
    mean_distance_km: number;
  };
}

/** `occultations` options (all optional; defaults in brackets). */
export interface OccultationOptions {
  /** Catalogue stars brighter than this join the 58 navigational stars [3.5], at most 6.5. */
  max_magnitude?: number;
  /** Search stars [true] and planets [true]. */
  stars?: boolean;
  planets?: boolean;
  /** Keep events with the Moon below the horizon at every contact [false]. */
  include_below_horizon?: boolean;
  /** Keep near misses within 1′ of the mean limb [true]. */
  include_near_misses?: boolean;
  /** Only these bodies (names as results spell them). */
  bodies?: string[] | null;
}

export interface OccultationContact {
  kind: 'disappearance' | 'reappearance';
  jd_utc: number;
  utc: string;
  /** On the limb, from celestial north through east. */
  position_angle_deg: number;
  /** The same from the zenith. */
  vertex_angle_deg: number;
  /** From the nearer cusp, positive on the dark limb, negative on the bright. */
  cusp_angle_deg: number;
  cusp: 'N' | 'S';
  limb: 'dark' | 'bright';
  moon_alt_deg: number;
  moon_az_deg: number;
  moon_above_horizon: boolean;
  sun_alt_deg: number;
  sky_phase: SkyPhase;
  /** Planets: seconds for the disc to cross the limb; 0 for a star. */
  crossing_s: number;
}

export interface Occultation {
  body: string;
  kind: 'star' | 'planet';
  designation: string | null;
  hr: number | null;
  magnitude: number | null;
  navigational: boolean;
  /** Hidden by the mean limb; false for a near miss. */
  occulted: boolean;
  /** Passes within 1′ of the mean limb. */
  graze: boolean;
  disappearance: OccultationContact | null;
  reappearance: OccultationContact | null;
  closest: {
    jd_utc: number;
    utc: string;
    /** From the mean limb, arcminutes, negative inside. */
    limb_distance_arcmin: number;
    position_angle_deg: number;
    moon_alt_deg: number;
  };
  duration_s: number | null;
  body_semidiameter_arcsec: number;
  moon_illuminated_fraction: number;
  waxing: boolean;
  /** The Moon is up at a contact (at closest approach for a near miss). */
  visible: boolean;
}

export interface OccultationList {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  /** Say this beside the times: mean limb, real limb differs. */
  limb_note: string;
  bodies_searched: number;
  /** Sorted by the first contact. */
  events: Occultation[];
  errors: BodyError[];
}

/** The Moon in detail (moondetail agent). */
export interface MoonDetailEngine {
  /** Libration, axis, terminator and disc geometry; `null` observer = the Earth's centre. */
  moonOrientation(observer: Observer | null, jdUtc: number): MoonOrientation;
  /** The 150 named features at an instant (about a millisecond natively). */
  moonFeatures(observer: Observer | null, jdUtc: number): MoonFeatures;
  /** Perigees, apogees, supermoons in a window (about 0.1 s a year natively). */
  moonApsides(jdStart: number, jdEnd: number): MoonApsides;
  /** Occultations for one place, at most 400 days (about 0.1 s a year natively). */
  occultations(observer: Observer, jdStart: number, jdEnd: number, options?: OccultationOptions): OccultationList;
}

export function isMoonDetailEngine(engine: unknown): engine is MoonDetailEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<MoonDetailEngine>;
  return (
    typeof e.moonOrientation === 'function' &&
    typeof e.moonFeatures === 'function' &&
    typeof e.moonApsides === 'function' &&
    typeof e.occultations === 'function'
  );
}

// ---------------------------------------------------------------------------------
// Expansion programme — deep sky (deepsky agent, 2026-09-24). Rust:
// crates/skyfix-wasm/src/deepsky.rs over skyfix_starfield::{dso, showers, milkyway,
// search, extinction, tonight}. Wire format: EXPLORER_API.md, "Expansion programme —
// deep sky". Display-only data (CONVENTIONS 13.6): nothing here is a sight, and every
// ranking, rate and limiting magnitude is a labelled estimate.
// ---------------------------------------------------------------------------------

export type DsoType =
  | 'open_cluster'
  | 'globular_cluster'
  | 'planetary_nebula'
  | 'emission_nebula'
  | 'reflection_nebula'
  | 'supernova_remnant'
  | 'cluster_with_nebula'
  | 'spiral_galaxy'
  | 'elliptical_galaxy'
  | 'lenticular_galaxy'
  | 'irregular_galaxy'
  | 'double_star'
  | 'asterism'
  | 'star_cloud';

/** What the Sky view draws a symbol for. */
export type DsoCategory = 'cluster' | 'nebula' | 'galaxy' | 'other';

/** One deep-sky object (the 110 Messier objects and 103 others). */
export interface Dso {
  /** Stable id: "M31", "NGC869", "IC2602", "Mel25", "LMC". */
  id: string;
  /** As printed: "M31", "NGC 869". */
  label: string;
  name: string | null;
  type: DsoType;
  category: DsoCategory;
  /** IAU abbreviation. */
  constellation: string;
  /** ICRS (J2000). */
  ra_j2000_deg: number;
  dec_j2000_deg: number;
  /** Integrated V; null for nebulae without a meaningful one. */
  magnitude: number | null;
  /** Rounded apparent size, arcminutes (display only). */
  major_arcmin: number;
  minor_arcmin: number;
  description: string;
  /** Other catalogue numbers: ["NGC 224"]. */
  cross_ids: string[];
}

export interface DsoCatalog {
  objects: Dso[];
  source: string;
}

export interface DsoListOptions {
  /** Categories or types to keep; empty keeps everything. */
  kinds?: (DsoCategory | DsoType)[];
  /** Keep objects at least this bright (objects without a magnitude are kept). */
  max_magnitude?: number | null;
  /** With an observer: only objects above the horizon now. */
  above_horizon?: boolean;
}

/** Places at one instant, aligned with `index` (positions in `dsoCatalog().objects`). */
export interface DsoPositions {
  jd_utc: number;
  index: Int32Array;
  /** Apparent geocentric of date, the frame of `sky_state`. */
  ra_deg: Float64Array;
  dec_deg: Float64Array;
  /** With an observer; null without one. */
  alt_deg: Float64Array | null;
  az_deg: Float64Array | null;
  alt_apparent_deg: Float64Array | null;
}

/** The observer's sky: `nelm` wins over `bortle`; with neither, Bortle 5. */
export interface SkyConditionsInput {
  /** 1 (darkest) to 9. */
  bortle?: number | null;
  /** Naked-eye limiting magnitude at the zenith, 1 to 8. */
  nelm?: number | null;
  /** Extinction coefficient in V, 0.2 to 0.4 mag per air mass (default 0.25). */
  k?: number | null;
}

export interface SkyConditions {
  bortle: number | null;
  nelm: number;
  k: number;
  /** Dark-sky zenith brightness, V mag/arcsec² (Schaefer's relation, capped at 22.0). */
  sky_brightness_mpsas: number;
  source: 'nelm' | 'bortle' | 'default';
}

export interface DeepSkyInstant {
  jd_utc: number;
  utc: string;
}

export type CompassPoint =
  | 'N' | 'NNE' | 'NE' | 'ENE' | 'E' | 'ESE' | 'SE' | 'SSE'
  | 'S' | 'SSW' | 'SW' | 'WSW' | 'W' | 'WNW' | 'NW' | 'NNW';

/** An instant with where the thing is then: apparent altitude, azimuth, compass point. */
export interface DeepSkySighting {
  jd_utc: number;
  utc: string;
  alt_deg: number;
  az_deg: number;
  direction: CompassPoint;
}

export type DarknessKind = 'night' | 'astronomical_twilight' | 'nautical_twilight' | 'none';

export interface DarkWindow {
  /** Full darkness (Sun below −18°), or the darkest the night gets. */
  kind: DarknessKind;
  start: DeepSkyInstant;
  end: DeepSkyInstant;
  hours: number;
}

export interface SunNight {
  set: DeepSkyInstant | null;
  civil_dusk: DeepSkyInstant | null;
  nautical_dusk: DeepSkyInstant | null;
  astronomical_dusk: DeepSkyInstant | null;
  astronomical_dawn: DeepSkyInstant | null;
  nautical_dawn: DeepSkyInstant | null;
  civil_dawn: DeepSkyInstant | null;
  rise: DeepSkyInstant | null;
}

export type MoonPhaseName =
  | 'new'
  | 'waxing crescent'
  | 'first quarter'
  | 'waxing gibbous'
  | 'full'
  | 'waning gibbous'
  | 'last quarter'
  | 'waning crescent';

export interface MoonNight {
  illuminated_fraction: number;
  phase_angle_deg: number;
  phase: MoonPhaseName;
  waxing: boolean;
  rise: DeepSkyInstant | null;
  set: DeepSkyInstant | null;
  /** Hours of the observing window with the Moon up / down. */
  up_hours: number;
  down_hours: number;
}

/** A night: local mean noon to the next. */
export interface NightSummary {
  start: DeepSkyInstant;
  end: DeepSkyInstant;
  /** null when the Sun never goes below −6°. */
  darkness: DarkWindow | null;
  sun: SunNight;
  moon: MoonNight;
}

export interface MoonEffect {
  moon_alt_deg: number;
  separation_deg: number;
  /** Sky brightening at the object, magnitudes (Krisciunas & Schaefer 1991). */
  brightening_mag: number;
}

export type DsoInstrument = 'eye' | 'binoculars' | 'telescope' | 'camera';

export interface DsoVisibilityDetail {
  /** Highest point in the observing window. */
  best: DeepSkySighting | null;
  transit: DeepSkySighting | null;
  hours_above_20: number;
  moon: MoonEffect | null;
  /** Limiting magnitude at the object at the best time: extinction and moonlight. */
  limiting_mag: number | null;
  instrument: DsoInstrument | null;
}

export interface DsoVisibility {
  object: Dso;
  night: NightSummary;
  conditions: SkyConditions;
  visibility: DsoVisibilityDetail;
  /** Apparent altitude every 10 minutes from local noon to noon (145 values). */
  track: { jd_utc: number[]; alt_deg: number[] };
}

export interface MeteorShower {
  iau: number;
  code: string;
  name: string;
  /** Solar longitude (J2000) of the start, peak and end of activity. */
  lambda_start_deg: number;
  lambda_peak_deg: number;
  lambda_end_deg: number;
  /** Radiant at the peak, J2000, and its drift per degree of solar longitude. */
  ra_deg: number;
  dec_deg: number;
  dra_deg: number;
  ddec_deg: number;
  v_inf_kms: number;
  r: number;
  zhr: number;
  variable: boolean;
  parent: string | null;
}

/** One shower through one night at one place (an estimate). */
export interface ShowerNight {
  code: string;
  name: string;
  lambda_deg: number;
  zhr: number;
  days_from_peak: number;
  radiant_ra_deg: number;
  radiant_dec_deg: number;
  best: DeepSkySighting | null;
  /** ZHR × sin(radiant altitude) × r^(LM − 6.5). */
  expected_rate_per_hour: number;
  limiting_mag: number | null;
  hours_radiant_above_20: number;
  variable: boolean;
  /** One sentence without clock times. */
  reason: string;
}

export interface ShowerDates {
  shower: MeteorShower;
  peak: DeepSkyInstant;
  start: DeepSkyInstant;
  end: DeepSkyInstant;
  /** Geocentric, at the peak. */
  moon_illuminated_fraction: number;
  /** With an observer: the night nearest the peak. */
  at_site: ShowerNight | null;
}

export interface ShowerYear {
  year: number;
  /** In order of peak. */
  showers: ShowerDates[];
  errors: { code: string; message: string }[];
  source: string;
  rate_model: string;
}

/** A closed ring (first point repeated), ICRS degrees; the brighter side is where a × b points. */
export interface MilkyWayRing {
  /** 0 the faintest glow … levels.length − 1 the brightest. */
  level: number;
  ra_deg: Float64Array;
  dec_deg: Float64Array;
}

export interface MilkyWayOutline {
  levels: number[];
  rings: MilkyWayRing[];
  source: string;
}

export type SearchHitKind = 'star' | 'deep_sky' | 'constellation' | 'sun' | 'moon' | 'planet' | 'shower';

export interface SearchHit {
  kind: SearchHitKind;
  /** "HR 2491", "M31", "CMa", "Mars", "PER". */
  id: string;
  label: string;
  detail: string;
  magnitude: number | null;
  /** Stars: index into `starfieldCatalog()`. */
  index: number | null;
  /** Apparent of date at the time asked (a shower: its radiant); null without a time. */
  ra_deg: number | null;
  dec_deg: number | null;
  alt_deg: number | null;
  az_deg: number | null;
  alt_apparent_deg: number | null;
  above_horizon: boolean | null;
  score: number;
}

export interface SearchResult {
  query: string;
  hits: SearchHit[];
}

export interface ExtinctionTable {
  conditions: SkyConditions;
  /** 0, 1, … 90 degrees of apparent altitude. */
  alt_deg: Float64Array;
  airmass: Float64Array;
  extinction_mag: Float64Array;
  limiting_mag: Float64Array;
  model: string;
}

export interface PlanetTonight {
  body: string;
  magnitude: number | null;
  best: DeepSkySighting | null;
  up_from: DeepSkyInstant | null;
  up_until: DeepSkyInstant | null;
  hours_up: number;
  reason: string;
}

export interface DsoTonight {
  id: string;
  label: string;
  name: string | null;
  type: DsoType;
  category: DsoCategory;
  constellation: string;
  magnitude: number | null;
  best: DeepSkySighting;
  hours_above_20: number;
  moon: MoonEffect | null;
  instrument: DsoInstrument;
  score: number;
  reason: string;
}

export interface CoreTonight {
  best: DeepSkySighting | null;
  hours_above_20: number;
  reason: string;
}

export interface Tonight {
  night: NightSummary;
  conditions: SkyConditions;
  planets: PlanetTonight[];
  deep_sky: DsoTonight[];
  showers: ShowerNight[];
  milky_way_core: CoreTonight;
  /** Plain sentences; `{jd:2461308.517173}` tokens stand for times (see `formatSummaryTimes`). */
  summary: string;
  notes: string[];
  errors: string[];
}

export interface TonightOptions extends SkyConditionsInput {
  /** Deep-sky objects to list, 1 to 60 (default 12). */
  limit?: number;
}

/** Deep sky (deepsky agent). Separate from `ExplorerEngine`, like the eclipse engine. */
export interface DeepSkyEngine {
  dsoCatalog(): DsoCatalog;
  dsoList(observer: Observer | null, jdUtc: number, options?: DsoListOptions): DsoPositions;
  dsoVisibility(id: string, observer: Observer, jdUtc: number, conditions?: SkyConditionsInput): DsoVisibility;
  meteorShowers(year: number, observer?: Observer | null, conditions?: SkyConditionsInput): ShowerYear;
  milkyWayOutline(): MilkyWayOutline;
  /** An observer needs a time. */
  skySearch(query: string, observer?: Observer | null, jdUtc?: number | null, limit?: number): SearchResult;
  tonight(observer: Observer, jdUtc: number, options?: TonightOptions): Tonight;
  extinction(conditions?: SkyConditionsInput): ExtinctionTable;
}

/** True when `engine` has the deep-sky calls (the memoised engine forwards them). */
export function isDeepSkyEngine(engine: unknown): engine is DeepSkyEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<DeepSkyEngine>;
  return (
    typeof e.dsoCatalog === 'function' &&
    typeof e.dsoList === 'function' &&
    typeof e.tonight === 'function' &&
    typeof e.skySearch === 'function'
  );
}

/** Replace the `{jd:...}` time tokens of a `tonight` summary with `format(jd)`. */
export function formatSummaryTimes(summary: string, format: (jdUtc: number) => string): string {
  return summary.replace(/\{jd:(-?\d+(?:\.\d+)?)\}/g, (_, jd: string) => format(Number(jd)));
}

// ---------------------------------------------------------------------------------
// Expansion programme — tides (tides agent, work package P5). Rust:
// crates/skyfix-wasm/src/tides.rs over skyfix_tides. Wire format: EXPLORER_API.md,
// "Tides (tides agent)"; definitions: CONVENTIONS 13.11. Every call needs the optional
// `tides-us` pack and throws `pack_not_loaded: …` without it.
// ---------------------------------------------------------------------------------

/** Datums heights can be given on; `''` means the station's default (MLLW where published). */
export type TideDatum = 'MLLW' | 'MLW' | 'MSL' | 'MTL' | 'MHW' | 'MHHW' | 'LAT' | 'HAT' | 'NAVD88';

/** The character of the tide by the form number F = (K1 + O1)/(M2 + S2). */
export type TideType = 'semidiurnal' | 'mixed_semidiurnal' | 'mixed_diurnal' | 'diurnal';

export type TideStationFlag =
  | 'noaa_differs'
  | 'no_datums'
  | 'no_constants'
  | 'reference_unusable'
  | 'non_navigational';

/** One NOAA tide station. */
export interface TideStation {
  /** NOAA's id: `9414290`, `TEC4623`. */
  id: string;
  name: string;
  /** Two-letter U.S. state or territory code; null when NOAA gives none (many foreign ports, some U.S. ones). */
  state: string | null;
  lat_deg: number;
  lon_deg: number;
  /** `harmonic`: a true curve from harmonic constants; `subordinate`: high and low water from a reference station. */
  kind: 'harmonic' | 'subordinate';
  reference_id: string | null;
  reference_name: string | null;
  /** From the form number (the reference station's for a subordinate one). */
  tide_type: TideType | null;
  form_number: number | null;
  /** Datums heights can be given on here, highest first. */
  datums: TideDatum[];
  default_datum: TideDatum;
  /** `harmonic` (true curve), `interpolated` (subordinate: cosine curve between high and low water, an estimate) or `none`. */
  curve: 'harmonic' | 'interpolated' | 'none';
  flags: TideStationFlag[];
  /** Plain sentences to show with the station. */
  notes: string[];
}

/** A station with its distance and bearing from a place. */
export interface TideStationNear extends TideStation {
  distance_km: number;
  distance_nm: number;
  /** Initial great-circle bearing from the place to the station, degrees true. */
  bearing_deg: number;
}

/** One high or low water. */
export interface TideEvent {
  kind: 'high' | 'low';
  jd_utc: number;
  utc: string;
  /** Above the result's datum, metres. */
  height_m: number;
}

/** The label every tide result carries. */
export const TIDE_LABEL =
  'US stations (NOAA); predictions, not observations; weather and surge not included';

export interface TideExtremes {
  station: TideStation;
  datum: TideDatum;
  method: 'harmonic' | 'subordinate_offsets';
  jd_start: number;
  jd_end: number;
  /** Sorted by time, all inside the window. */
  extremes: TideEvent[];
  label: string;
  notes: string[];
}

export interface TideCurve {
  station: TideStation;
  datum: TideDatum;
  method: 'harmonic' | 'interpolated';
  jd_start: number;
  jd_end: number;
  step_min: number;
  jd_utc: Float64Array;
  height_m: Float64Array;
  label: string;
  notes: string[];
}

export interface TideNow {
  station: TideStation;
  datum: TideDatum;
  method: 'harmonic' | 'interpolated';
  jd_utc: number;
  utc: string;
  height_m: number;
  /** Rate of rise, metres per hour (negative when falling). */
  rate_m_per_h: number;
  state: 'rising' | 'falling';
  previous: TideEvent | null;
  next: TideEvent | null;
  next_high: TideEvent | null;
  next_low: TideEvent | null;
  label: string;
  notes: string[];
}

/** `tidePackInfo()`: the contract's PackInfo fields and the station counts. */
export interface TidesPackInfo {
  name: 'tides-us';
  version: string;
  bytes: number;
  provides: string[];
  stations: number;
  harmonic: number;
  subordinate: number;
}

/**
 * Tide predictions (tides agent). Separate from `ExplorerEngine`; the WASM engine and
 * the mock implement it. Errors throw with a leading code: `pack_not_loaded`,
 * `unknown_station`, `datum_unavailable`, `no_prediction`, `outside_range` (1900-2100),
 * `bad_request`.
 */
export interface TidesEngine {
  /** The `n` (1-100) stations nearest to a place, nearest first. */
  tideStationsNear(latDeg: number, lonDeg: number, n: number): TideStationNear[];
  tideStation(stationId: string): TideStation;
  /** Heights every `stepMin` (0.5-1440) minutes from `jdStart`, at most 20 000 samples. */
  tidePredict(stationId: string, jdStart: number, jdEnd: number, stepMin: number, datum?: TideDatum | ''): TideCurve;
  /** High and low water in the window (at most 400 days). A month takes a few milliseconds. */
  tideExtremes(stationId: string, jdStart: number, jdEnd: number, datum?: TideDatum | ''): TideExtremes;
  /** Height, rate, rising or falling, and the high and low waters around an instant. */
  tideNow(stationId: string, jdUtc: number, datum?: TideDatum | ''): TideNow;
  /** The installed pack's summary, or null when the pack is not loaded (`loadPack('tides-us', bytes)`). */
  tidePackInfo(): TidesPackInfo | null;
}

/** True when `engine` can predict tides (the memoised engine forwards the methods). */
export function isTidesEngine(engine: unknown): engine is TidesEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<TidesEngine>;
  return typeof e.tideExtremes === 'function' && typeof e.tideStationsNear === 'function';
}

/** True when a tides call failed only because the `tides-us` pack is not loaded. */
export function isTidePackNotLoaded(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('pack_not_loaded');
}

// ---------------------------------------------------------------------------------
// Expansion programme — planet detail (planetdetail agent, P9). Rust:
// crates/skyfix-wasm/src/planetdetail.rs over skyfix_almanac::{discs, rings,
// satellites, transits, conjunctions, earth_apsides, orbits}. Wire format:
// docs/EXPLORER_API.md, "Planet detail"; definitions: CONVENTIONS §13.12.
// ---------------------------------------------------------------------------------

export type GalileanMoonName = 'Io' | 'Europa' | 'Ganymede' | 'Callisto';

/** Jupiter as the moons' diagram needs it. */
export interface JupiterFrame {
  distance_au: number;
  light_time_s: number;
  /** Apparent radii of the disc, arcseconds. */
  equatorial_radius_arcsec: number;
  polar_radius_arcsec: number;
  /** Position angle of Jupiter's north pole, north through east. */
  pole_position_angle_deg: number;
  /** Planetocentric latitude of the Earth seen from Jupiter. */
  sub_earth_lat_deg: number;
  ra_deg: number;
  dec_deg: number;
  /** Angle from the Sun seen from the Earth. */
  elongation_deg: number;
}

export interface GalileanMoon {
  name: GalileanMoonName;
  /** Along Jupiter's equator, positive west, in Jupiter's apparent equatorial radii. */
  x_rj: number;
  /** Toward Jupiter's projected north pole, same unit. */
  y_rj: number;
  /** Depth along the line of sight, same unit; positive = farther than Jupiter. */
  z_rj: number;
  /** Offset from Jupiter's centre on the sky (true equator of date), arcseconds. */
  offset_east_arcsec: number;
  offset_north_arcsec: number;
  ra_deg: number;
  dec_deg: number;
  in_front: boolean;
  in_transit: boolean;
  occulted: boolean;
  eclipsed: boolean;
  shadow_on_disc: boolean;
  /** Where its shadow is on the disc (same axes and unit), or null. */
  shadow_x_rj: number | null;
  shadow_y_rj: number | null;
}

export interface GalileanMoons {
  jd_utc: number;
  utc: string;
  jupiter: JupiterFrame;
  moons: GalileanMoon[];
  theory: string;
  /** Worst error of the moons' offsets measured against JPL (arcseconds). */
  accuracy_arcsec: number;
}

export type GalileanPhenomenonKind = 'transit' | 'shadow_transit' | 'occultation' | 'eclipse';

export interface GalileanInstant {
  jd_utc: number;
  utc: string;
  /** False when another phenomenon hides the moment (an eclipse behind Jupiter). */
  observable: boolean;
}

export interface GalileanPhenomenon {
  moon: GalileanMoonName;
  kind: GalileanPhenomenonKind;
  start: GalileanInstant;
  end: GalileanInstant;
  /** Jupiter's angle from the Sun at the start (nothing is visible within ~15°). */
  jupiter_elongation_deg: number;
}

export interface GalileanEvents {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  /** Every phenomenon overlapping the window, sorted by start. */
  phenomena: GalileanPhenomenon[];
  conventions: string;
}

export interface SaturnRingEdge {
  name: string;
  radius_km: number;
  major_axis_arcsec: number;
  minor_axis_arcsec: number;
}

export interface SaturnRings {
  jd_utc: number;
  utc: string;
  /** B: the Earth's latitude above the ring plane (positive: north face seen). */
  earth_latitude_deg: number;
  /** B′: the Sun's (positive: north face lit). */
  sun_latitude_deg: number;
  delta_u_deg: number;
  /** P: position angle of the ring's northern minor axis. */
  position_angle_deg: number;
  /** Outer edge of the A ring. */
  major_axis_arcsec: number;
  minor_axis_arcsec: number;
  edges: SaturnRingEdge[];
  north_face_visible: boolean;
  /** False when the rings are seen from their unlit side. */
  lit_face_visible: boolean;
  distance_au: number;
  heliocentric_distance_au: number;
  /** Astronomical Almanac 1984 / Meeus 41 magnitude, for comparison with printed almanacs. */
  magnitude_aa1984: number;
  /** The explorer's magnitude (Mallama & Hilton 2018). */
  magnitude: number | null;
}

export interface PlanetCentralMeridian {
  system: 'I' | 'II' | 'III' | 'IAU';
  longitude_deg: number;
}

export interface PlanetDisc {
  body: string;
  jd_utc: number;
  utc: string;
  distance_au: number;
  light_time_s: number;
  equatorial_diameter_arcsec: number;
  polar_diameter_arcsec: number;
  phase_angle_deg: number;
  illuminated_fraction: number;
  defect_of_illumination_arcsec: number;
  bright_limb_angle_deg: number;
  pole_position_angle_deg: number;
  /** Planetocentric; `_graphic` on the IAU reference ellipsoid. */
  sub_earth_lat_deg: number;
  sub_earth_lat_graphic_deg: number;
  sub_earth_lon_deg: number;
  sub_solar_lat_deg: number;
  sub_solar_lat_graphic_deg: number;
  sub_solar_lon_deg: number;
  /** IAU planetographic sense of every longitude in the object. */
  longitude_positive: 'west' | 'east';
  /** Jupiter I, II, III; Saturn and Uranus III; the others IAU. */
  central_meridians: PlanetCentralMeridian[];
  magnitude: number | null;
  rotation_model: string;
  notes: string[];
}

export type PlanetTransitContactKind = 'c1' | 'c2' | 'greatest' | 'c3' | 'c4';

export interface PlanetTransitContact {
  kind: PlanetTransitContactKind;
  jd_utc: number;
  utc: string;
  jd_tt: number;
  /** On the Sun's disc, from the north point through east. */
  position_angle_deg: number;
  separation_arcsec: number;
}

export interface PlanetTransitPathPoint {
  jd_utc: number;
  /** The planet's centre relative to the Sun's, toward celestial east and north. */
  east_arcsec: number;
  north_arcsec: number;
}

export interface PlanetTransitLocalEvent {
  kind: PlanetTransitContactKind | 'sunrise' | 'sunset';
  jd_utc: number;
  utc: string;
  sun_alt_deg: number;
  sun_az_deg: number;
  /** The Sun is above its rise/set altitude (−50′). */
  visible: boolean;
  position_angle_deg: number;
  /** From the point of the Sun's limb nearest the zenith. */
  vertex_angle_deg: number;
  separation_arcsec: number;
}

export interface PlanetTransitLocal {
  observer: { lat_deg: number; lon_deg: number; height_m: number };
  visibility: 'visible' | 'partly_below_horizon' | 'below_horizon' | 'none';
  events: PlanetTransitLocalEvent[];
  path: PlanetTransitPathPoint[];
}

export interface PlanetTransit {
  /** `"2012-06-06-venus"`. */
  id: string;
  planet: 'Mercury' | 'Venus';
  /** Seen from the Earth's centre, in time order. */
  contacts: PlanetTransitContact[];
  min_separation_arcsec: number;
  sun_semidiameter_arcsec: number;
  planet_semidiameter_arcsec: number;
  /** No contacts II and III. */
  grazing: boolean;
  duration_s: number;
  path: PlanetTransitPathPoint[];
  tt_minus_utc_s: number;
  /** Present when an observer was given. */
  local: PlanetTransitLocal | null;
}

export interface PlanetTransitList {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  transits: PlanetTransit[];
  conventions: string;
}

export type ConjunctionKind = 'planet_planet' | 'moon_planet' | 'planet_star' | 'moon_star';

export interface ConjunctionOptions {
  /** Default all seven planets. */
  planets?: string[];
  /** Include the Moon (default true). */
  moon?: boolean;
  /** Navigational star names; default Aldebaran, Regulus, Spica, Antares. */
  stars?: string[];
  /** Largest separation reported, 0.1–20° (default 5). */
  max_separation_deg?: number;
  /** Least elongation from the Sun for `visible` (default 15°). */
  min_sun_elongation_deg?: number;
  observer?: Observer;
}

export interface ConjunctionView {
  jd_utc: number;
  utc: string;
  body_alt_deg: number;
  other_alt_deg: number;
  sun_alt_deg: number;
}

export interface ConjunctionLocal {
  /** Apparent altitudes at closest approach. */
  body_alt_deg: number;
  other_alt_deg: number;
  sun_alt_deg: number;
  /** Within 12 h, when the lower body stands highest with the Sun below −6°; null if never. */
  best: ConjunctionView | null;
}

export interface Conjunction {
  kind: ConjunctionKind;
  /** The Moon, else the planet (the inner of two). */
  body: string;
  other: string;
  jd_utc: number;
  utc: string;
  separation_deg: number;
  /** Of `body` seen from `other`, north through east. */
  position_angle_deg: number;
  ra_deg: number;
  dec_deg: number;
  body_elongation_deg: number;
  other_elongation_deg: number;
  body_magnitude: number | null;
  other_magnitude: number | null;
  /** Both at least `min_sun_elongation_deg` from the Sun. */
  visible: boolean;
  local: ConjunctionLocal | null;
}

export interface ConjunctionList {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  conjunctions: Conjunction[];
}

export type PlanetStationKind = 'retrograde_begins' | 'retrograde_ends';
export type PlanetStationCoordinate = 'ecliptic_longitude' | 'right_ascension';

export interface PlanetStation {
  body: string;
  kind: PlanetStationKind;
  coordinate: PlanetStationCoordinate;
  jd_utc: number;
  utc: string;
  /** The coordinate's value at the station. */
  angle_deg: number;
  ra_deg: number;
  dec_deg: number;
  ecliptic_longitude_deg: number;
  elongation_deg: number;
  magnitude: number | null;
}

export interface PlanetStationList {
  jd_start: number;
  jd_end: number;
  truncated: boolean;
  coverage_start_utc: string;
  coverage_end_utc: string;
  /** Both coordinates, sorted by time. */
  stations: PlanetStation[];
  /** What the explorer shows: `"ecliptic_longitude"`. */
  ui_coordinate: PlanetStationCoordinate;
}

export interface EarthApsisEvent {
  kind: 'perihelion' | 'aphelion';
  jd_utc: number;
  utc: string;
  distance_au: number;
  distance_km: number;
}

export interface EarthApsides {
  year: number;
  events: EarthApsisEvent[];
}

export type OrbitClass = 'asteroid' | 'comet';

export type OrbitMagnitudeModel =
  | { model: 'hg'; h: number; g: number }
  | { model: 'comet'; m1: number; k1: number }
  | { model: 'none' };

/** Heliocentric osculating elements, J2000.0 ecliptic; times TT Julian dates. */
export interface OrbitalElements {
  name: string;
  designation: string | null;
  class: OrbitClass;
  epoch_jd_tt: number | null;
  perihelion_distance_au: number;
  eccentricity: number;
  inclination_deg: number;
  ascending_node_deg: number;
  argument_of_perihelion_deg: number;
  perihelion_jd_tt: number;
  magnitude: OrbitMagnitudeModel;
  source: 'mpcorb' | 'mpc_comet' | 'manual';
}

/** Elements typed in by hand: q or a; the perihelion time or a mean anomaly at the epoch. */
export interface ManualOrbitalElements {
  name: string;
  class?: OrbitClass;
  epoch_jd_tt?: number;
  /** RFC 3339 read on the TT scale. */
  epoch_tt?: string;
  q_au?: number;
  a_au?: number;
  e: number;
  i_deg: number;
  node_deg: number;
  peri_deg: number;
  tp_jd_tt?: number;
  tp_tt?: string;
  mean_anomaly_deg?: number;
  h?: number;
  g?: number;
  m1?: number;
  k1?: number;
}

export type CustomBodyInput = OrbitalElements | ManualOrbitalElements;

/** `BodyState` for a comet or an asteroid, with the orbit's own quantities. */
export interface CustomBodyState extends Omit<BodyState, 'kind'> {
  kind: OrbitClass;
  custom: true;
  distance_au: number;
  heliocentric_distance_au: number;
  /** Days from the elements' epoch (or perihelion time). */
  elements_age_days: number;
  /** Staleness warnings (past 30 days from the epoch). */
  warnings: string[];
}

export interface CustomBodyStates {
  jd_utc: number;
  utc: string;
  bodies: CustomBodyState[];
  errors: BodyError[];
}

/** Planet detail (expansion programme). Behind a type guard, like the eclipse engine. */
export interface PlanetDetailEngine {
  galileanMoons(jdUtc: number): GalileanMoons;
  /** Up to 400 days; a month takes under 0.1 s natively. */
  galileanEvents(jdStart: number, jdEnd: number): GalileanEvents;
  saturnRings(jdUtc: number): SaturnRings;
  planetDisc(body: string, jdUtc: number): PlanetDisc;
  /** With an observer, each transit gains `local`. */
  transits(jdStart: number, jdEnd: number, observer?: Observer): PlanetTransitList;
  /** Up to ten years; a year of the default bodies takes about 0.22 s natively. */
  conjunctions(jdStart: number, jdEnd: number, options?: ConjunctionOptions): ConjunctionList;
  stations(jdStart: number, jdEnd: number): PlanetStationList;
  earthApsides(year: number): EarthApsides;
  /** MPCORB lines, MPC comet lines or JSON elements. Throws an Error naming the bad line or field. */
  parseOrbits(text: string): OrbitalElements[];
  customBodyStates(observer: Observer, jdUtc: number, bodies: CustomBodyInput[]): CustomBodyStates;
  /** The shape of `sampleBodies`; at most 5,000 samples per body. */
  sampleCustomBodies(
    observer: Observer,
    bodies: CustomBodyInput[],
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled;
}

/** True when `engine` has the planet-detail calls (the memoised engine must forward them). */
export function isPlanetDetailEngine(engine: unknown): engine is PlanetDetailEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<PlanetDetailEngine>;
  return (
    typeof e.galileanMoons === 'function' &&
    typeof e.conjunctions === 'function' &&
    typeof e.parseOrbits === 'function'
  );
}

// ---------------------------------------------------------------------------
// Expansion programme Q7 — almanac tables and three-day openings (almanac2 agent).
// docs/EXPLORER_API.md "Expansion programme — almanac tables and three-day pages";
// crates/skyfix-wasm/src/almanac_tables.rs over skyfix_almanac::{tables, opening};
// definitions CONVENTIONS 13.12. As with the daily pages, every tabulated value has its
// number and, under `printed`, the text the table prints; views show `printed`.
// ---------------------------------------------------------------------------

/** How the dates of an opening or a year's table are grouped and shown: `''`/`'auto'` is Julian before 1582-10-15. */
export type AlmanacCalendarChoice = '' | 'auto' | 'julian' | 'gregorian';

/** A tabulated quantity in arcminutes and its printed text (`+15.3`, `0 14.3`, `62.5`). */
export interface ArcminCell {
  arcmin: number;
  printed: string;
}

/** A tabulated angle in degrees (the Polaris azimuth, `359.3`). */
export interface DegCell {
  deg: number;
  printed: string;
}

export interface CriticalArgument {
  /** At the printed precision, in the table's unit (degrees, metres or feet). */
  value: number;
  /** `9 55`, `2.4`, `41`. */
  printed: string;
}

/**
 * A critical table: an argument above `boundaries[k]` and at most `boundaries[k + 1]`
 * takes `values[k]` (one cell per column); one exactly on a boundary takes the value above
 * it ("in critical cases ascend").
 */
export interface CriticalTable {
  argument: string;
  unit: 'deg_min' | 'deg' | 'm' | 'ft';
  columns: string[];
  boundaries: CriticalArgument[];
  values: ArcminCell[][];
}

/** One date of an opening, in the calendar the opening is shown in. */
export interface AlmanacOpeningDay {
  /** Wire date, proleptic Gregorian (`2016-03-07`, `-0584-05-22`). */
  date: string;
  calendar: CalendarKind;
  /** Astronomical year in `calendar`. */
  year: number;
  month: number;
  day: number;
  era_year: number;
  era: 'BC' | 'AD';
  weekday: string;
}

export interface AlmanacOpeningMoonRow {
  lat_deg: number;
  label: string;
  /** For the four `moon_dates`. */
  moonrise: AlmanacTime[];
  moonset: AlmanacTime[];
}

export interface AlmanacPlanetSha {
  body: string;
  sha_deg: number;
  printed: { gha: string };
}

/**
 * The printed almanac's two facing pages for three UT dates. Once-per-opening values are
 * the middle day's (`days[1]`): stars, the planets' magnitudes, v, d and meridian passages,
 * Aries' meridian passage, the Sun's SD and d, and the twilight and sunrise table.
 */
export interface AlmanacOpening {
  /** The date asked for (wire). */
  date: string;
  calendar: CalendarKind;
  /** Which of the three dates was asked for. */
  index: number;
  dates: AlmanacOpeningDay[];
  days: AlmanacDay[];
  /** The three dates and the next (wire). */
  moon_dates: string[];
  /** The same four dates in `calendar`, for the column headings. */
  moon_days: AlmanacOpeningDay[];
  moon_rows: AlmanacOpeningMoonRow[];
  /** At 0h UT of the middle date. */
  planet_sha_00h: AlmanacPlanetSha[];
  notes: string[];
  errors: BodyError[];
}

export interface IncrementRow {
  /** 0 to 60. */
  second: number;
  sun_planets: ArcminCell;
  aries: ArcminCell;
  moon: ArcminCell;
}

export interface VdCorrection {
  v_arcmin: number;
  v_printed: string;
  correction: ArcminCell;
}

/** One minute of the Increments and Corrections. */
export interface IncrementsMinute {
  minute: number;
  /** 61 rows, seconds 00 to 60. */
  rows: IncrementRow[];
  /** 181 values of v or d, 0.0 to 18.0 (the page shows three columns of 61). */
  corrections: VdCorrection[];
  how_to_use: string;
  example: string;
  notes: string[];
}

export interface ArcDegreeRow {
  deg: number;
  /** Minutes of time. */
  minutes: number;
  /** `h m`. */
  printed: string;
}

export interface ArcMinuteRow {
  arcmin: number;
  /** Seconds of time for 0′.00, 0′.25, 0′.50, 0′.75. */
  seconds: number[];
  /** `m s`. */
  printed: string[];
}

export interface ArcToTime {
  degrees: ArcDegreeRow[];
  arcminutes: ArcMinuteRow[];
  how_to_use: string;
  example: string;
  notes: string[];
}

/** One row of the 0°–10° table: lower and upper limb for each half-year, stars and planets. */
export interface LowAltitudeRow {
  alt_deg: number;
  printed_alt: string;
  sun_oct_mar: [ArcminCell, ArcminCell];
  sun_apr_sep: [ArcminCell, ArcminCell];
  stars_planets: ArcminCell;
}

export interface DipRow {
  height: number;
  printed_height: string;
  dip: ArcminCell;
}

export interface DipTables {
  metres: CriticalTable;
  feet: CriticalTable;
  more_metres: DipRow[];
  more_feet: DipRow[];
}

export interface RefractionZone {
  letter: string;
  /** The air-density factor the zone's corrections use (its centre). */
  factor: number;
  factor_low: number;
  factor_high: number;
}

export interface AdditionalRow {
  alt_deg: number;
  printed_alt: string;
  standard_refraction_arcmin: number;
  /** One per zone, A to N. */
  corrections: ArcminCell[];
}

export interface RefractionConditions {
  temperature_c: number;
  pressure_hpa: number;
}

export interface RefractionConditionsResult extends RefractionConditions {
  factor: number;
  /** `null` beyond zones A to N. */
  zone: string | null;
  /** Exact, one per `AdditionalRefraction.rows`. */
  corrections: ArcminCell[];
}

export interface AdditionalRefraction {
  zones: RefractionZone[];
  rows: AdditionalRow[];
  /** The zone chart's axes: the zone lines are P = 1010 f (273 + T) / 283. */
  chart: { temperature_c: [number, number]; pressure_hpa: [number, number] };
  conditions: RefractionConditionsResult | null;
}

export interface MoonCorrectionColumn {
  /** 0, 5, …, 85. */
  from_deg: number;
  /** 30 rows, every 10′: `(deg − from_deg) × 6 + minutes / 10`. */
  upper: ArcminCell[];
  lower_alt_deg: number;
  /** One per `hp_rows`: L (lower limb), U (upper limb; subtract 30′ in use). */
  lower_limb: ArcminCell[];
  upper_limb: ArcminCell[];
}

export interface MoonCorrectionTable {
  hp0_arcmin: number;
  /** 54.0′ to 61.5′ every 0.3′. */
  hp_rows: number[];
  columns: MoonCorrectionColumn[];
  how_to_use: string;
  notes: string[];
}

export interface TableExample {
  title: string;
  text: string;
}

export interface AltitudeTables {
  refraction: { model: string; pressure_hpa: number; temperature_c: number };
  sun_sd_oct_mar_arcmin: number;
  sun_sd_apr_sep_arcmin: number;
  sun_hp_arcmin: number;
  /** 10°–90°: lower and upper limb. */
  sun_oct_mar: CriticalTable;
  sun_apr_sep: CriticalTable;
  stars_planets: CriticalTable;
  /** 0°–10°. */
  low: LowAltitudeRow[];
  dip: DipTables;
  additional: AdditionalRefraction;
  moon: MoonCorrectionTable;
  how_to_use: string[];
  examples: TableExample[];
  notes: string[];
}

export interface CivilDay {
  year: number;
  month: number;
  day: number;
}

export interface ParallaxPeriod {
  from: CivilDay;
  to: CivilDay;
  from_jd_utc: number;
  to_jd_utc: number;
  /** The parallax the corrections use, to 0.1′. */
  hp_arcmin: number;
  /** Apparent altitude in whole degrees. */
  table: CriticalTable;
}

export interface PlanetCorrections {
  year: number;
  calendar: CalendarKind;
  venus: ParallaxPeriod[];
  mars: ParallaxPeriod[];
  how_to_use: string;
  notes: string[];
  errors: BodyError[];
}

export interface PolarisMonthPlace {
  month: number;
  jd_utc: number;
  sha_deg: number;
  dec_deg: number;
}

export interface PolarisColumn {
  /** 0, 10, …, 350. */
  from_deg: number;
  /** 11 rows, LHA Aries from_deg + 0 … + 10. */
  a0: ArcminCell[];
  /** One per `a1_latitudes`. */
  a1: ArcminCell[];
  /** January to December. */
  a2: ArcminCell[];
  /** One per `azimuth_latitudes`. */
  azimuth: DegCell[];
}

export interface PolarisExample {
  text: string;
  lha_aries_deg: number;
  a0_arcmin: number;
  a1_arcmin: number;
  a2_arcmin: number;
  latitude_deg: number;
  rigorous_latitude_deg: number;
}

export interface PolarisTable {
  year: number;
  calendar: CalendarKind;
  mean_sha_deg: number;
  mean_dec_deg: number;
  printed_mean: { sha: string; dec: string };
  polar_distance_arcmin: number;
  /** The second-order formula's worst error this year; a warning above 0.1′. */
  formula_error_arcmin: number;
  a1_latitudes: number[];
  azimuth_latitudes: number[];
  months: PolarisMonthPlace[];
  columns: PolarisColumn[];
  how_to_use: string;
  example: PolarisExample | null;
  notes: string[];
  warnings: string[];
}

/** The almanac's tables and three-day openings (almanac2 agent). */
export interface AlmanacTablesEngine {
  /** The opening containing the UT date (`YYYY-MM-DD`, expanded years allowed). About three daily pages of work. */
  almanacOpening(date: string, calendar?: AlmanacCalendarChoice): AlmanacOpening;
  /** One minute (0-59) of the Increments and Corrections. */
  almanacIncrements(minute: number): IncrementsMinute;
  almanacArcToTime(): ArcToTime;
  /** The altitude correction tables; `conditions` adds exact corrections for one temperature and pressure. */
  almanacAltitudeTables(conditions?: RefractionConditions | null): AltitudeTables;
  /** Venus and Mars through a year (a year's parallax: tens of milliseconds). */
  almanacPlanetCorrections(year: number, calendar?: AlmanacCalendarChoice): PlanetCorrections;
  almanacPolaris(year: number, calendar?: AlmanacCalendarChoice): PolarisTable;
}

/** True when `engine` has the almanac's tables and openings. */
export function isAlmanacTablesEngine(engine: unknown): engine is AlmanacTablesEngine {
  if (typeof engine !== 'object' || engine === null) return false;
  const e = engine as Partial<AlmanacTablesEngine>;
  return typeof e.almanacOpening === 'function' && typeof e.almanacIncrements === 'function';
}
// --- end almanac2
