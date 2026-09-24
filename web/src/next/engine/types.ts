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
