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
  /** The averaged sight as an `observed_ho` observation, ready for a session. */
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
