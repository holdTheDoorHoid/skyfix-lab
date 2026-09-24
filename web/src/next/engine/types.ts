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
  /** The window actually searched (clipped to the coverage). */
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
