/**
 * The real explorer engine: `crates/skyfix-wasm` compiled to WebAssembly (the exports of
 * `explorer.rs` and `starfield.rs`, wire format in docs/EXPLORER_API.md). This file only
 * serialises inputs to the JSON strings the exports take and passes results through;
 * typed arrays arrive as real typed arrays and are not copied.
 *
 * It loads the same package the workbench at `/` uses (`src/wasm-pkg/skyfix_wasm.js`,
 * a git-ignored build artefact found with `import.meta.glob`, so the site still builds
 * without it). A package built before the explorer exports existed is detected at load
 * time, and the missing exports are named exactly.
 */

import { createWasmNav, type NavTools } from './wasm-nav.js';
import type {
  AlmanacDay,
  AlmanacEngine,
  AltitudeCrossing,
  BodyInfo,
  CalendarConversion,
  CalendarConvertRequest,
  CoverageTier,
  CoverageTierEngine,
  BodySelection,
  ConstellationBoundary,
  DayEvents,
  EclipseEngine,
  EclipseList,
  EclipseLocal,
  EclipseLocalOptions,
  LimbEngine,
  LimbPackInfo,
  LimbProfile,
  EclipsePath,
  EventOptions,
  ExplorerCoverage,
  ExplorerEngine,
  Observer,
  PackEngine,
  PackInfo,
  PackStatus,
  PhaseEvent,
  PlanetEventList,
  PlanetEventsEngine,
  Sampled,
  SeasonEvent,
  SkyState,
  StarfieldCatalog,
  TimeEngine,
  TimeInfo,
} from './types.js';
import type { MisfitEngine } from './types.js';
import type {
  DrReport,
  DrRequest,
  PassageReport,
  PassageRequest,
  RouteReport,
  RouteRequest,
  SailingsEngine,
  StarFinderGeometry,
  StarIdRequest,
  StarIdResult,
  MoonApsides,
  MoonDetailEngine,
  MoonFeatures,
  MoonOrientation,
  OccultationList,
  OccultationOptions,
  TideCurve,
  TideDatum,
  TideExtremes,
  TideNow,
  TidesPackInfo,
  TideStation,
  TideStationNear,
} from './types.js';
// Deep sky (deepsky agent).
import type {
  DeepSkyEngine,
  DsoCatalog,
  DsoListOptions,
  DsoPositions,
  DsoVisibility,
  ExtinctionTable,
  MilkyWayOutline,
  SearchResult,
  ShowerYear,
  SkyConditionsInput,
  Tonight,
  TonightOptions,
} from './types.js';
// Planet detail (expansion programme P9, planetdetail agent).
import type {
  ConjunctionList,
  ConjunctionOptions,
  CustomBodyInput,
  CustomBodyStates,
  EarthApsides,
  GalileanEvents,
  GalileanMoons,
  OrbitalElements,
  PlanetDetailEngine,
  PlanetDisc,
  PlanetStationList,
  PlanetTransitList,
  SaturnRings,
} from './types.js';
import { createWasmMisfit } from './wasm-misfit.js';
// Expansion programme — sun tools (suntools agent).
import type {
  AlignmentRequest,
  AlignmentResult,
  Analemma,
  AnalemmaRequest,
  AzimuthAltitudeBand,
  AzimuthCrossing,
  EquationOfTime,
  GalacticCentreWindows,
  GalacticOptions,
  RiseSetAzimuthRequest,
  RiseSetAzimuths,
  SolarDay,
  SolarPanel,
  SolarYear,
  SolarYearRequest,
  SunHours,
  SunPath,
} from './types.js';
// Expansion programme, geomag agent: magnetic field and compass error (wasm-geomag.ts).
import type { CompassError, CompassRequest, MagneticField, MagneticGrid, MagneticModelChoice } from './types.js';
import { wasmCompassError, wasmMagneticField, wasmMagneticGrid, type GeomagWasmExports } from './wasm-geomag.js';

/** Exports the explorer cannot run without. */
export const REQUIRED_EXPORTS = [
  'explorer_bodies',
  'explorer_coverage',
  'sky_state',
  'sample_bodies',
  'day_events',
  'day_events_batch',
  'find_altitude',
  'moon_phases',
  'seasons',
  'sidereal',
  'starfield_catalog',
  'starfield_apparent',
  'constellation_at',
] as const;

/**
 * Exports that may be absent (EXPLORER_API: boundaries are optional in wave 1;
 * `starfield_frame_matrix` is the star-field agent's optional addition).
 */
export const OPTIONAL_EXPORTS = ['constellation_boundaries', 'starfield_frame_matrix'] as const;

/** The wasm-bindgen functions this engine calls (EXPLORER_API signatures). */
export interface ExplorerWasmExports {
  explorer_bodies(): unknown;
  explorer_coverage(): unknown;
  sky_state(observerJson: string, jdUtc: number, bodiesJson: string): unknown;
  sample_bodies(
    observerJson: string,
    bodiesJson: string,
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): unknown;
  day_events(
    observerJson: string,
    jdStart: number,
    jdEnd: number,
    bodiesJson: string,
    optionsJson: string,
  ): unknown;
  day_events_batch(observerJson: string, windowsJson: string, bodiesJson: string, optionsJson: string): unknown;
  find_altitude(observerJson: string, body: string, jdStart: number, jdEnd: number, altitudeDeg: number): unknown;
  moon_phases(jdStart: number, jdEnd: number): unknown;
  seasons(year: number): unknown;
  sidereal(jdUtc: number): unknown;
  starfield_catalog(): unknown;
  starfield_apparent(jdUtc: number): unknown;
  constellation_at(raDeg: number, decDeg: number, jdUtc: number): unknown;
  constellation_boundaries?(): unknown;
  starfield_frame_matrix?(jdUtc: number): unknown;
  /** Wave 2, almanac pages (EXPLORER_API "Wave 2 — almanac pages"); absent in older builds. */
  almanac_day?(date: string): unknown;
  /** Wave 2, eclipses (EXPLORER_API "Wave 2 — eclipses"); absent in older builds. */
  eclipses?(jdStart: number, jdEnd: number): unknown;
  eclipse_local?(id: string, observerJson: string): unknown;
  eclipse_path?(id: string): unknown;
  /** Wave 2, planet events (EXPLORER_API "Wave 2 — planet events"); absent in older builds. */
  planet_events?(jdStart: number, jdEnd: number): unknown;
  /** Expansion programme, magnetic field and compass error (wasm-geomag.ts); absent in older builds. */
  magnetic_field?: GeomagWasmExports['magnetic_field'];
  magnetic_grid?: GeomagWasmExports['magnetic_grid'];
  compass_error?: GeomagWasmExports['compass_error'];
  /** Expansion programme, data packs (EXPLORER_API "Packs"); absent in older builds. */
  packs?(): unknown;
  load_pack?(name: string, bytes: Uint8Array): unknown;
  /** Expansion wave 1, time scales (EXPLORER_API "time_info"); absent in older builds. */
  time_info?(jdUtc: number): unknown;
  set_dut1?(seconds: number | null | undefined): unknown;
  calendar_convert?(requestJson: string): unknown;
  /** Expansion programme, coverage tiers (deeptime agent); absent in older builds. */
  tier_at?(jdUtc: number): string;
  /** Expansion programme, sailings agent (EXPLORER_API "Expansion programme — sailings"). */
  sailing?(requestJson: string): unknown;
  dr_advance?(requestJson: string): unknown;
  route_positions?(requestJson: string): unknown;
  star_identify?(requestJson: string): unknown;
  star_finder_geometry?(latBand: number, jdUtc?: number): unknown;
  /** Expansion P8, the Moon in detail (EXPLORER_API "Moon in detail"); absent in older builds. */
  moon_orientation?(observerJson: string, jdUtc: number): unknown;
  moon_features?(observerJson: string, jdUtc: number): unknown;
  moon_apsides?(jdStart: number, jdEnd: number): unknown;
  occultations?(observerJson: string, jdStart: number, jdEnd: number, optionsJson: string): unknown;
  // Expansion programme — deep sky (EXPLORER_API "Expansion programme — deep sky");
  // absent in older builds.
  dso_catalog?(): unknown;
  dso_list?(observerJson: string, jdUtc: number, optionsJson: string): unknown;
  dso_visibility?(id: string, observerJson: string, jdUtc: number, conditionsJson: string): unknown;
  meteor_showers?(year: number, observerJson: string, conditionsJson: string): unknown;
  milky_way_outline?(): unknown;
  sky_search?(query: string, observerJson: string, jdUtc?: number, limit?: number): unknown;
  tonight?(observerJson: string, jdUtc: number, optionsJson: string): unknown;
  extinction_table?(conditionsJson: string): unknown;
  // --- Tides (tides agent, EXPLORER_API "Tides"); absent in builds before the tides work.
  tide_stations_near?(latDeg: number, lonDeg: number, n: number): unknown;
  tide_station?(stationId: string): unknown;
  tide_predict?(stationId: string, jdStart: number, jdEnd: number, stepMin: number, datum: string): unknown;
  tide_extremes?(stationId: string, jdStart: number, jdEnd: number, datum: string): unknown;
  tide_now?(stationId: string, jdUtc: number, datum: string): unknown;
  tide_pack_info?(): unknown;
  // --- end tides
  // --- Lunar limb (eclipselimb agent, EXPLORER_API "Expansion programme P12"); absent in
  // builds before it.
  eclipse_local_limb?(id: string, observerJson: string): unknown;
  lunar_limb_profile?(observerJson: string, jdUtc: number): unknown;
  lunar_limb_info?(): unknown;
  // --- end lunar limb
  version?(): string;
  // Expansion programme — sun tools (suntools agent; EXPLORER_API "Expansion programme —
  // sun tools"); absent in older builds.
  sun_hours?(observerJson: string, jdStart: number, jdEnd: number): unknown;
  find_azimuth?(
    observerJson: string,
    body: string,
    jdStart: number,
    jdEnd: number,
    azimuthDeg: number,
    bandJson: string,
  ): unknown;
  alignment_days?(observerJson: string, requestJson: string): unknown;
  analemma?(observerJson: string, requestJson: string): unknown;
  sun_path?(observerJson: string, jdStart: number, jdEnd: number, stepMinutes: number): unknown;
  rise_set_azimuths?(observerJson: string, requestJson: string): unknown;
  equation_of_time?(year: number, utcHour: number): unknown;
  solar_day?(observerJson: string, jdStart: number, jdEnd: number, panelJson: string, stepMinutes: number): unknown;
  solar_year?(observerJson: string, requestJson: string): unknown;
  galactic_centre_windows?(observerJson: string, jdStart: number, jdEnd: number, optionsJson: string): unknown;
}

// ---------------------------------------------------------------------------
// Planet detail (expansion programme P9, planetdetail agent): the exports of
// crates/skyfix-wasm/src/planetdetail.rs (EXPLORER_API "Planet detail"). Optional: a
// build without them answers with `rebuildError`.
// ---------------------------------------------------------------------------

export interface PlanetDetailWasmExports {
  galilean_moons?(jdUtc: number): unknown;
  galilean_events?(jdStart: number, jdEnd: number): unknown;
  saturn_rings?(jdUtc: number): unknown;
  planet_disc?(body: string, jdUtc: number): unknown;
  /** `observerJson` empty for the geocentric circumstances only. */
  transits?(jdStart: number, jdEnd: number, observerJson: string): unknown;
  /** `optionsJson` empty for every default. */
  conjunctions?(jdStart: number, jdEnd: number, optionsJson: string): unknown;
  stations?(jdStart: number, jdEnd: number): unknown;
  earth_apsides?(year: number): unknown;
  parse_orbits?(text: string): unknown;
  custom_body_states?(observerJson: string, jdUtc: number, customBodiesJson: string): unknown;
  sample_custom_bodies?(
    observerJson: string,
    customBodiesJson: string,
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): unknown;
}

// Declaration merging: the planet-detail exports are part of the module's shape.
export interface ExplorerWasmExports extends PlanetDetailWasmExports {}

/** Only the fields `ConjunctionOptions` defines (the Rust side rejects any other). */
export function conjunctionOptionsJson(o: ConjunctionOptions | undefined): string {
  if (!o) return '';
  const out: Record<string, unknown> = {};
  if (o.planets !== undefined) out.planets = o.planets;
  if (o.moon !== undefined) out.moon = o.moon;
  if (o.stars !== undefined) out.stars = o.stars;
  if (o.max_separation_deg !== undefined) out.max_separation_deg = o.max_separation_deg;
  if (o.min_sun_elongation_deg !== undefined) out.min_sun_elongation_deg = o.min_sun_elongation_deg;
  if (o.observer !== undefined) out.observer = JSON.parse(observerJson(o.observer)) as unknown;
  return JSON.stringify(out);
}

export function missingExports(module: object): { required: string[]; optional: string[] } {
  const has = (name: string): boolean => typeof (module as Record<string, unknown>)[name] === 'function';
  return {
    required: REQUIRED_EXPORTS.filter((name) => !has(name)),
    optional: OPTIONAL_EXPORTS.filter((name) => !has(name)),
  };
}

const DEFAULT_OPTIONS: EventOptions = { horizon: 'standard', height_of_eye_m: 0 };

/** wasm-bindgen throws the Rust `Err` value (a string); make it a readable Error. */
function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Only the fields the contract defines, so a UI object with extra fields serialises cleanly. */
export function observerJson(o: Observer): string {
  const out: Record<string, number> = { lat_deg: o.lat_deg, lon_deg: o.lon_deg };
  if (o.height_m !== undefined) out.height_m = o.height_m;
  if (o.pressure_hpa !== undefined) out.pressure_hpa = o.pressure_hpa;
  if (o.temperature_c !== undefined) out.temperature_c = o.temperature_c;
  return JSON.stringify(out);
}

/** `["Sun","Moon"]`, or a group name as a JSON string: `"all"`. */
export function bodiesJson(bodies: BodySelection): string {
  return JSON.stringify(bodies);
}

export function optionsJson(options: EventOptions | undefined): string {
  const o = options ?? DEFAULT_OPTIONS;
  return JSON.stringify({ horizon: o.horizon, height_of_eye_m: o.height_of_eye_m });
}

/** The error an optional wave-2 export gives when this build of the core predates it. */
function rebuildError(name: string, what: string): Error {
  return new Error(
    `${name}: this build of the numerical core has no ${what}. Rebuild it with: npm run wasm --prefix web`,
  );
}

/** Deep-sky sky conditions / options as the exports take them: JSON with only known fields. */
export function conditionsJson(c: SkyConditionsInput | TonightOptions | undefined): string {
  if (!c) return '';
  const out: Record<string, number> = {};
  for (const key of ['bortle', 'nelm', 'k', 'limit'] as const) {
    const v = (c as Record<string, number | null | undefined>)[key];
    if (typeof v === 'number') out[key] = v;
  }
  return JSON.stringify(out);
}

export class WasmEngine
  implements
    ExplorerEngine,
    AlmanacEngine,
    EclipseEngine,
    PlanetEventsEngine,
    PackEngine,
    TimeEngine,
    SailingsEngine,
    MoonDetailEngine,
    DeepSkyEngine,
    CoverageTierEngine,
    LimbEngine
{
  readonly kind = 'wasm' as const;
  readonly description: string;
  readonly version: string | null;
  /** Navigation tools (wasm-nav.ts); absent when the package predates their exports. */
  readonly nav?: NavTools;

  private bodiesCache: BodyInfo[] | null = null;
  private coverageCache: ExplorerCoverage | null = null;
  private catalogCache: StarfieldCatalog | null = null;
  private boundariesCache: ConstellationBoundary[] | null = null;
  private dsoCatalogCache: DsoCatalog | null = null;
  private milkyWayCache: MilkyWayOutline | null = null;

  /** The residual heat map (wasm-misfit.ts); absent when the package predates its exports. */
  readonly misfit?: MisfitEngine;

  /** Use `inspectWasmModule` or `loadWasmEngine`; this assumes every required export exists. */
  constructor(private readonly x: ExplorerWasmExports) {
    let version: string | null = null;
    try {
      version = typeof x.version === 'function' ? x.version() : null;
    } catch {
      version = null;
    }
    this.version = version;
    const nav = createWasmNav(x);
    if (nav) this.nav = nav;
    this.description =
      `The SkyFix Lab numerical core${version ? ` ${version}` : ''}, compiled to WebAssembly. ` +
      'It runs entirely in this browser, with no network.';
    const misfit = createWasmMisfit(x);
    if (misfit) this.misfit = misfit;
  }

  private call<T>(name: string, fn: () => unknown): T {
    try {
      return fn() as T;
    } catch (error) {
      throw new Error(`${name}: ${errorText(error)}`);
    }
  }

  bodies(): BodyInfo[] {
    this.bodiesCache ??= this.call<BodyInfo[]>('explorer_bodies', () => this.x.explorer_bodies());
    return this.bodiesCache;
  }

  coverage(): ExplorerCoverage {
    this.coverageCache ??= this.call<ExplorerCoverage>('explorer_coverage', () => this.x.explorer_coverage());
    return this.coverageCache;
  }

  skyState(observer: Observer, jdUtc: number, bodies: BodySelection): SkyState {
    return this.call('sky_state', () => this.x.sky_state(observerJson(observer), jdUtc, bodiesJson(bodies)));
  }

  sampleBodies(
    observer: Observer,
    bodies: BodySelection,
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled {
    return this.call('sample_bodies', () =>
      this.x.sample_bodies(observerJson(observer), bodiesJson(bodies), jdStart, jdEnd, stepMinutes),
    );
  }

  dayEvents(
    observer: Observer,
    jdStart: number,
    jdEnd: number,
    bodies: BodySelection,
    options?: EventOptions,
  ): DayEvents {
    return this.call('day_events', () =>
      this.x.day_events(observerJson(observer), jdStart, jdEnd, bodiesJson(bodies), optionsJson(options)),
    );
  }

  dayEventsBatch(
    observer: Observer,
    windows: [number, number][],
    bodies: BodySelection,
    options?: EventOptions,
  ): DayEvents[] {
    return this.call('day_events_batch', () =>
      this.x.day_events_batch(
        observerJson(observer),
        JSON.stringify(windows),
        bodiesJson(bodies),
        optionsJson(options),
      ),
    );
  }

  findAltitude(
    observer: Observer,
    body: string,
    jdStart: number,
    jdEnd: number,
    altitudeDeg: number,
  ): AltitudeCrossing[] {
    return this.call('find_altitude', () =>
      this.x.find_altitude(observerJson(observer), body, jdStart, jdEnd, altitudeDeg),
    );
  }

  moonPhases(jdStart: number, jdEnd: number): PhaseEvent[] {
    return this.call('moon_phases', () => this.x.moon_phases(jdStart, jdEnd));
  }

  seasons(year: number): SeasonEvent[] {
    return this.call('seasons', () => this.x.seasons(year));
  }

  sidereal(jdUtc: number): { gha_aries_deg: number } {
    return this.call('sidereal', () => this.x.sidereal(jdUtc));
  }

  starfieldCatalog(): StarfieldCatalog {
    this.catalogCache ??= this.call<StarfieldCatalog>('starfield_catalog', () => this.x.starfield_catalog());
    return this.catalogCache;
  }

  starfieldApparent(jdUtc: number): Float64Array {
    return this.call('starfield_apparent', () => this.x.starfield_apparent(jdUtc));
  }

  constellationAt(raDeg: number, decDeg: number, jdUtc: number): string {
    return this.call('constellation_at', () => this.x.constellation_at(raDeg, decDeg, jdUtc));
  }

  /** Empty when this build does not export boundaries (optional in wave 1). */
  constellationBoundaries(): ConstellationBoundary[] {
    const fn = this.x.constellation_boundaries;
    if (typeof fn !== 'function') return [];
    this.boundariesCache ??= this.call<ConstellationBoundary[]>('constellation_boundaries', () =>
      fn.call(this.x),
    );
    return this.boundariesCache;
  }

  /**
   * ICRS (J2000) to the true equator and equinox of date, row-major (EXPLORER_API
   * `starfield_frame_matrix`). Throws when this build does not export it (optional).
   */
  starfieldFrameMatrix(jdUtc: number): Float64Array {
    const fn = this.x.starfield_frame_matrix;
    if (typeof fn !== 'function') throw new Error('starfield_frame_matrix: not exported by this build');
    return this.call('starfield_frame_matrix', () => fn.call(this.x, jdUtc));
  }

  /**
   * The daily almanac pages for one UT date `YYYY-MM-DD` (`almanac_day`). Throws when this
   * build of the core predates the export, saying so.
   */
  almanacDay(date: string): AlmanacDay {
    const fn = this.x.almanac_day;
    if (typeof fn !== 'function') {
      throw new Error(
        'almanac_day: this build of the numerical core has no almanac pages. Rebuild it with: npm run wasm --prefix web',
      );
    }
    return this.call('almanac_day', () => fn.call(this.x, date));
  }

  /** Every eclipse with greatest eclipse in the window (`eclipses`). */
  eclipses(jdStart: number, jdEnd: number): EclipseList {
    const fn = this.x.eclipses;
    if (typeof fn !== 'function') throw rebuildError('eclipses', 'eclipses');
    return this.call('eclipses', () => fn.call(this.x, jdStart, jdEnd));
  }

  /**
   * What one observer sees of an eclipse, by id (`eclipse_local`); with `options.limb`,
   * with the limb-corrected block (`eclipse_local_limb`, P12).
   */
  eclipseLocal(id: string, observer: Observer, options?: EclipseLocalOptions): EclipseLocal {
    if (options?.limb) {
      const limbFn = this.x.eclipse_local_limb;
      if (typeof limbFn !== 'function') throw rebuildError('eclipse_local_limb', 'lunar limb');
      return this.call('eclipse_local_limb', () => limbFn.call(this.x, id, observerJson(observer)));
    }
    const fn = this.x.eclipse_local;
    if (typeof fn !== 'function') throw rebuildError('eclipse_local', 'eclipses');
    return this.call('eclipse_local', () => fn.call(this.x, id, observerJson(observer)));
  }

  /** The Moon's limb profile at any instant (`lunar_limb_profile`; needs the lunar-limb pack). */
  lunarLimbProfile(observer: Observer, jdUtc: number): LimbProfile {
    const fn = this.x.lunar_limb_profile;
    if (typeof fn !== 'function') throw rebuildError('lunar_limb_profile', 'lunar limb');
    return this.call('lunar_limb_profile', () => fn.call(this.x, observerJson(observer), jdUtc));
  }

  /** The installed lunar-limb pack (`lunar_limb_info`), or null (also in older builds). */
  lunarLimbInfo(): LimbPackInfo | null {
    const fn = this.x.lunar_limb_info;
    if (typeof fn !== 'function') return null;
    return this.call('lunar_limb_info', () => fn.call(this.x));
  }

  /** The lines to draw an eclipse on the map, by id (`eclipse_path`). */
  eclipsePath(id: string): EclipsePath {
    const fn = this.x.eclipse_path;
    if (typeof fn !== 'function') throw rebuildError('eclipse_path', 'eclipses');
    return this.call('eclipse_path', () => fn.call(this.x, id));
  }

  /** Oppositions, conjunctions, greatest elongations and closest approaches (`planet_events`). */
  planetEvents(jdStart: number, jdEnd: number): PlanetEventList {
    const fn = this.x.planet_events;
    if (typeof fn !== 'function') throw rebuildError('planet_events', 'planet events');
    return this.call('planet_events', () => fn.call(this.x, jdStart, jdEnd));
  }

  // -------------------------------------------------------------------------
  // Expansion programme — sun tools (suntools agent). `SunToolsEngine` in types.ts; each
  // throws "rebuild" when this build of the core predates the export.
  // -------------------------------------------------------------------------

  private sunTool<K extends keyof ExplorerWasmExports>(name: K): NonNullable<ExplorerWasmExports[K]> {
    const fn = this.x[name];
    if (typeof fn !== 'function') throw rebuildError(String(name), 'sun tools');
    return fn as NonNullable<ExplorerWasmExports[K]>;
  }

  /** Golden and blue hours over one local day, with the Sun's events (`sun_hours`). */
  sunHours(observer: Observer, jdStart: number, jdEnd: number): SunHours {
    const fn = this.sunTool('sun_hours');
    return this.call('sun_hours', () => fn.call(this.x, observerJson(observer), jdStart, jdEnd));
  }

  /** When a body crosses a bearing inside an altitude band (`find_azimuth`). */
  findAzimuth(
    observer: Observer,
    body: string,
    jdStart: number,
    jdEnd: number,
    azimuthDeg: number,
    band?: AzimuthAltitudeBand,
  ): AzimuthCrossing[] {
    const fn = this.sunTool('find_azimuth');
    return this.call('find_azimuth', () =>
      fn.call(this.x, observerJson(observer), body, jdStart, jdEnd, azimuthDeg, band ? JSON.stringify(band) : ''),
    );
  }

  /** The days of a year a body rises, sets or stands at an altitude on a bearing (`alignment_days`). */
  alignmentDays(observer: Observer, request: AlignmentRequest): AlignmentResult {
    const fn = this.sunTool('alignment_days');
    return this.call('alignment_days', () => fn.call(this.x, observerJson(observer), JSON.stringify(request)));
  }

  /** The Sun at one clock time on every day of a year (`analemma`). */
  analemma(observer: Observer, request: AnalemmaRequest): Analemma {
    const fn = this.sunTool('analemma');
    return this.call('analemma', () => fn.call(this.x, observerJson(observer), JSON.stringify(request)));
  }

  /** A day's sun path and the equinox and solstice envelope (`sun_path`). */
  sunPath(observer: Observer, jdStart: number, jdEnd: number, stepMinutes = 10): SunPath {
    const fn = this.sunTool('sun_path');
    return this.call('sun_path', () => fn.call(this.x, observerJson(observer), jdStart, jdEnd, stepMinutes));
  }

  /** Daily rise and set azimuths over a local year (`rise_set_azimuths`). */
  riseSetAzimuths(observer: Observer, request: RiseSetAzimuthRequest): RiseSetAzimuths {
    const fn = this.sunTool('rise_set_azimuths');
    return this.call('rise_set_azimuths', () => fn.call(this.x, observerJson(observer), JSON.stringify(request)));
  }

  /** The equation of time and the Sun's declination on every UTC date of a year (`equation_of_time`). */
  equationOfTime(year: number, utcHour = 12): EquationOfTime {
    const fn = this.sunTool('equation_of_time');
    return this.call('equation_of_time', () => fn.call(this.x, year, utcHour));
  }

  /** Clear-sky irradiance on a panel through a day, and the energy (`solar_day`). */
  solarDay(observer: Observer, jdStart: number, jdEnd: number, panel?: SolarPanel, stepMinutes = 10): SolarDay {
    const fn = this.sunTool('solar_day');
    return this.call('solar_day', () =>
      fn.call(this.x, observerJson(observer), jdStart, jdEnd, panel ? JSON.stringify(panel) : '', stepMinutes),
    );
  }

  /** Clear-sky energy for every local day of a year, and optionally the best tilt (`solar_year`). */
  solarYear(observer: Observer, request: SolarYearRequest): SolarYear {
    const fn = this.sunTool('solar_year');
    return this.call('solar_year', () => fn.call(this.x, observerJson(observer), JSON.stringify(request)));
  }

  /** The galactic centre's dark-sky windows over a span of nights (`galactic_centre_windows`). */
  galacticCentreWindows(
    observer: Observer,
    jdStart: number,
    jdEnd: number,
    options?: GalacticOptions,
  ): GalacticCentreWindows {
    const fn = this.sunTool('galactic_centre_windows');
    return this.call('galactic_centre_windows', () =>
      fn.call(this.x, observerJson(observer), jdStart, jdEnd, options ? JSON.stringify(options) : ''),
    );
  }

  // --- Expansion programme: magnetic field and compass error (geomag agent) -----------
  // `GeomagEngine` (types.ts), delegated to wasm-geomag.ts; each throws "rebuild" when this
  // build of the core predates the export.

  /** The field at a place and instant, or `available: false` with the reason (`magnetic_field`). */
  magneticField(
    latDeg: number,
    lonDeg: number,
    heightM: number,
    jdUtc: number,
    model?: MagneticModelChoice,
  ): MagneticField {
    return wasmMagneticField(this.x, latDeg, lonDeg, heightM, jdUtc, model);
  }

  /** Declination and horizontal intensity on a grid (`magnetic_grid`); null outside 1900–2030. */
  magneticGrid(
    jdUtc: number,
    latMin: number,
    latMax: number,
    nLat: number,
    lonMin: number,
    lonMax: number,
    nLon: number,
    heightM = 0,
  ): MagneticGrid | null {
    return wasmMagneticGrid(this.x, jdUtc, latMin, latMax, nLat, lonMin, lonMax, nLon, heightM);
  }

  /** Compass error by azimuth or amplitude (`compass_error`). */
  compassError(request: CompassRequest): CompassError {
    return wasmCompassError(this.x, request);
  }

  /** The data packs this build can install, and which are loaded (`packs`); none in older builds. */
  packs(): PackStatus[] {
    const fn = this.x.packs;
    if (typeof fn !== 'function') return [];
    return this.call('packs', () => fn.call(this.x));
  }

  /**
   * Parse, verify and install a data pack (`load_pack`). Throws with the core's sentence
   * when the file is wrong. The coverage it reports changes, so it is asked again.
   */
  loadPack(name: string, bytes: Uint8Array): PackInfo {
    const fn = this.x.load_pack;
    if (typeof fn !== 'function') throw rebuildError('load_pack', 'data packs');
    const info = this.call<PackInfo>('load_pack', () => fn.call(this.x, name, bytes));
    this.coverageCache = null;
    return info;
  }

  /** Scale, tier, Delta-T, DUT1 and the civil dates of an instant (`time_info`). */
  timeInfo(jdUtc: number): TimeInfo {
    const fn = this.x.time_info;
    if (typeof fn !== 'function') throw rebuildError('time_info', 'time scales');
    return this.call('time_info', () => fn.call(this.x, jdUtc));
  }

  /** The explorer-wide UT1 - UTC in seconds, or null for the IERS history (`set_dut1`). */
  setDut1(seconds: number | null): void {
    const fn = this.x.set_dut1;
    if (typeof fn !== 'function') throw rebuildError('set_dut1', 'time scales');
    this.call('set_dut1', () => fn.call(this.x, seconds));
  }

  /** A JD or a civil date in either calendar, converted both ways (`calendar_convert`). */
  calendarConvert(request: CalendarConvertRequest): CalendarConversion {
    const fn = this.x.calendar_convert;
    if (typeof fn !== 'function') throw rebuildError('calendar_convert', 'time scales');
    return this.call('calendar_convert', () => fn.call(this.x, JSON.stringify(request)));
  }

  /** The coverage tier of an instant (`tier_at`, deeptime agent): validated, labelled or outside. */
  tierAt(jdUtc: number): CoverageTier {
    const fn = this.x.tier_at;
    if (typeof fn !== 'function') throw rebuildError('tier_at', 'coverage tiers');
    return this.call('tier_at', () => fn.call(this.x, jdUtc) as CoverageTier);
  }

  // --- Expansion programme: sailings, DR, routes, star identification, star finder ---

  /** Great-circle, rhumb-line, mid-latitude and composite sailing between two points (`sailing`). */
  sailing(request: PassageRequest): PassageReport {
    const fn = this.x.sailing;
    if (typeof fn !== 'function') throw rebuildError('sailing', 'sailings');
    return this.call('sailing', () => fn.call(this.x, JSON.stringify(request)));
  }

  /** One leg of dead reckoning (`dr_advance`). */
  drAdvance(request: DrRequest): DrReport {
    const fn = this.x.dr_advance;
    if (typeof fn !== 'function') throw rebuildError('dr_advance', 'dead reckoning');
    return this.call('dr_advance', () => fn.call(this.x, JSON.stringify(request)));
  }

  /** Positions along a route of legs (`route_positions`). */
  routePositions(request: RouteRequest): RouteReport {
    const fn = this.x.route_positions;
    if (typeof fn !== 'function') throw rebuildError('route_positions', 'routes');
    return this.call('route_positions', () => fn.call(this.x, JSON.stringify(request)));
  }

  /** Which body a sight was of, from its altitude and bearing (`star_identify`). */
  starIdentify(request: StarIdRequest): StarIdResult {
    const fn = this.x.star_identify;
    if (typeof fn !== 'function') throw rebuildError('star_identify', 'star identification');
    return this.call('star_identify', () => fn.call(this.x, JSON.stringify(request)));
  }

  /** The star finder's base plate, Aries index and template (`star_finder_geometry`). */
  starFinderGeometry(latBand: number, jdUtc?: number): StarFinderGeometry {
    const fn = this.x.star_finder_geometry;
    if (typeof fn !== 'function') throw rebuildError('star_finder_geometry', 'star finder');
    return this.call('star_finder_geometry', () => fn.call(this.x, latBand, jdUtc));
  }

  // Expansion programme P8 (moondetail agent): the Moon in detail. `null` observer = the
  // Earth's centre (orientation and features only).

  /** Libration, axis, terminator and disc geometry (`moon_orientation`). */
  moonOrientation(observer: Observer | null, jdUtc: number): MoonOrientation {
    const fn = this.x.moon_orientation;
    if (typeof fn !== 'function') throw rebuildError('moon_orientation', 'Moon detail');
    const o = observer ? observerJson(observer) : 'null';
    return this.call('moon_orientation', () => fn.call(this.x, o, jdUtc));
  }

  /** The 150 named features at an instant (`moon_features`). */
  moonFeatures(observer: Observer | null, jdUtc: number): MoonFeatures {
    const fn = this.x.moon_features;
    if (typeof fn !== 'function') throw rebuildError('moon_features', 'Moon detail');
    const o = observer ? observerJson(observer) : 'null';
    return this.call('moon_features', () => fn.call(this.x, o, jdUtc));
  }

  /** Perigees, apogees, supermoons (`moon_apsides`). */
  moonApsides(jdStart: number, jdEnd: number): MoonApsides {
    const fn = this.x.moon_apsides;
    if (typeof fn !== 'function') throw rebuildError('moon_apsides', 'Moon detail');
    return this.call('moon_apsides', () => fn.call(this.x, jdStart, jdEnd));
  }

  /** Lunar occultations for one place (`occultations`). */
  occultations(observer: Observer, jdStart: number, jdEnd: number, options?: OccultationOptions): OccultationList {
    const fn = this.x.occultations;
    if (typeof fn !== 'function') throw rebuildError('occultations', 'Moon detail');
    const opts = JSON.stringify(options ?? {});
    return this.call('occultations', () => fn.call(this.x, observerJson(observer), jdStart, jdEnd, opts));
  }

  // --- deep sky (deepsky agent) ---

  private deep<K extends keyof ExplorerWasmExports>(name: K): NonNullable<ExplorerWasmExports[K]> {
    const fn = this.x[name];
    if (typeof fn !== 'function') throw rebuildError(name, 'deep-sky objects, meteor showers or search');
    return fn as NonNullable<ExplorerWasmExports[K]>;
  }

  /** The deep-sky table, once (`dso_catalog`). */
  dsoCatalog(): DsoCatalog {
    const fn = this.deep('dso_catalog');
    this.dsoCatalogCache ??= this.call<DsoCatalog>('dso_catalog', () => fn.call(this.x));
    return this.dsoCatalogCache;
  }

  /** Places of the (filtered) objects at `jdUtc`, typed arrays aligned with `index` (`dso_list`). */
  dsoList(observer: Observer | null, jdUtc: number, options?: DsoListOptions): DsoPositions {
    const fn = this.deep('dso_list');
    return this.call('dso_list', () =>
      fn.call(this.x, observer ? observerJson(observer) : '', jdUtc, options ? JSON.stringify(options) : ''),
    );
  }

  /** One object through the night `jdUtc` belongs to (`dso_visibility`). */
  dsoVisibility(id: string, observer: Observer, jdUtc: number, conditions?: SkyConditionsInput): DsoVisibility {
    const fn = this.deep('dso_visibility');
    return this.call('dso_visibility', () =>
      fn.call(this.x, id, observerJson(observer), jdUtc, conditionsJson(conditions)),
    );
  }

  /** Every shower's dates in `year`; with an observer, the night nearest each peak (`meteor_showers`). */
  meteorShowers(year: number, observer?: Observer | null, conditions?: SkyConditionsInput): ShowerYear {
    const fn = this.deep('meteor_showers');
    return this.call('meteor_showers', () =>
      fn.call(this.x, year, observer ? observerJson(observer) : '', conditionsJson(conditions)),
    );
  }

  /** The Milky Way outline, once (`milky_way_outline`). */
  milkyWayOutline(): MilkyWayOutline {
    const fn = this.deep('milky_way_outline');
    this.milkyWayCache ??= this.call<MilkyWayOutline>('milky_way_outline', () => fn.call(this.x));
    return this.milkyWayCache;
  }

  /** Search by name or designation (`sky_search`); an observer needs a time. */
  skySearch(query: string, observer?: Observer | null, jdUtc?: number | null, limit?: number): SearchResult {
    const fn = this.deep('sky_search');
    return this.call('sky_search', () =>
      fn.call(this.x, query, observer ? observerJson(observer) : '', jdUtc ?? undefined, limit),
    );
  }

  /** What the night `jdUtc` belongs to offers at the observer (`tonight`). */
  tonight(observer: Observer, jdUtc: number, options?: TonightOptions): Tonight {
    const fn = this.deep('tonight');
    return this.call('tonight', () => fn.call(this.x, observerJson(observer), jdUtc, conditionsJson(options)));
  }

  /** The extinction and limiting-magnitude table (`extinction_table`). */
  extinction(conditions?: SkyConditionsInput): ExtinctionTable {
    const fn = this.deep('extinction_table');
    return this.call('extinction_table', () => fn.call(this.x, conditionsJson(conditions)));
  }
  // ---------------------------------------------------------------------------------
  // Tides (tides agent; EXPLORER_API "Tides"; TidesEngine in types.ts). Each throws
  // `pack_not_loaded: …` until the tides-us pack is installed (`loadPack('tides-us', …)`).
  // ---------------------------------------------------------------------------------

  private tideFn<K extends keyof ExplorerWasmExports>(name: K): NonNullable<ExplorerWasmExports[K]> {
    const fn = this.x[name];
    if (typeof fn !== 'function') throw rebuildError(name, 'tide predictions');
    return fn as NonNullable<ExplorerWasmExports[K]>;
  }

  /** The `n` stations nearest to a place (`tide_stations_near`). */
  tideStationsNear(latDeg: number, lonDeg: number, n: number): TideStationNear[] {
    const fn = this.tideFn('tide_stations_near');
    return this.call('tide_stations_near', () => fn.call(this.x, latDeg, lonDeg, n));
  }

  /** One station by NOAA id (`tide_station`). */
  tideStation(stationId: string): TideStation {
    const fn = this.tideFn('tide_station');
    return this.call('tide_station', () => fn.call(this.x, stationId));
  }

  /** Heights every `stepMin` minutes (`tide_predict`); typed arrays pass through. */
  tidePredict(stationId: string, jdStart: number, jdEnd: number, stepMin: number, datum: TideDatum | '' = ''): TideCurve {
    const fn = this.tideFn('tide_predict');
    return this.call('tide_predict', () => fn.call(this.x, stationId, jdStart, jdEnd, stepMin, datum));
  }

  /** High and low water in the window (`tide_extremes`). */
  tideExtremes(stationId: string, jdStart: number, jdEnd: number, datum: TideDatum | '' = ''): TideExtremes {
    const fn = this.tideFn('tide_extremes');
    return this.call('tide_extremes', () => fn.call(this.x, stationId, jdStart, jdEnd, datum));
  }

  /** The tide at an instant (`tide_now`). */
  tideNow(stationId: string, jdUtc: number, datum: TideDatum | '' = ''): TideNow {
    const fn = this.tideFn('tide_now');
    return this.call('tide_now', () => fn.call(this.x, stationId, jdUtc, datum));
  }

  /** The installed pack's summary, or null (`tide_pack_info`). */
  tidePackInfo(): TidesPackInfo | null {
    const fn = this.x.tide_pack_info;
    if (typeof fn !== 'function') return null;
    return this.call('tide_pack_info', () => fn.call(this.x));
  }

  // --- end tides

  // -------------------------------------------------------------------------
  // Planet detail (expansion programme P9, planetdetail agent): `PlanetDetailEngine`.
  // -------------------------------------------------------------------------

  private planetDetail<T>(name: keyof PlanetDetailWasmExports, args: unknown[]): T {
    const fn = this.x[name] as ((...a: unknown[]) => unknown) | undefined;
    if (typeof fn !== 'function') throw rebuildError(name, 'planet detail');
    return this.call<T>(name, () => fn.apply(this.x, args));
  }

  /** The four Galilean moons (`galilean_moons`). */
  galileanMoons(jdUtc: number): GalileanMoons {
    return this.planetDetail('galilean_moons', [jdUtc]);
  }

  /** Their transits, shadow transits, occultations and eclipses (`galilean_events`). */
  galileanEvents(jdStart: number, jdEnd: number): GalileanEvents {
    return this.planetDetail('galilean_events', [jdStart, jdEnd]);
  }

  saturnRings(jdUtc: number): SaturnRings {
    return this.planetDetail('saturn_rings', [jdUtc]);
  }

  planetDisc(body: string, jdUtc: number): PlanetDisc {
    return this.planetDetail('planet_disc', [body, jdUtc]);
  }

  /** Transits of Mercury and Venus; `local` for each when an observer is given. */
  transits(jdStart: number, jdEnd: number, observer?: Observer): PlanetTransitList {
    return this.planetDetail('transits', [jdStart, jdEnd, observer ? observerJson(observer) : '']);
  }

  conjunctions(jdStart: number, jdEnd: number, options?: ConjunctionOptions): ConjunctionList {
    return this.planetDetail('conjunctions', [jdStart, jdEnd, conjunctionOptionsJson(options)]);
  }

  stations(jdStart: number, jdEnd: number): PlanetStationList {
    return this.planetDetail('stations', [jdStart, jdEnd]);
  }

  earthApsides(year: number): EarthApsides {
    return this.planetDetail('earth_apsides', [year]);
  }

  parseOrbits(text: string): OrbitalElements[] {
    return this.planetDetail('parse_orbits', [text]);
  }

  customBodyStates(observer: Observer, jdUtc: number, bodies: CustomBodyInput[]): CustomBodyStates {
    return this.planetDetail('custom_body_states', [observerJson(observer), jdUtc, JSON.stringify(bodies)]);
  }

  sampleCustomBodies(
    observer: Observer,
    bodies: CustomBodyInput[],
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled {
    return this.planetDetail('sample_custom_bodies', [
      observerJson(observer),
      JSON.stringify(bodies),
      jdStart,
      jdEnd,
      stepMinutes,
    ]);
  }
}

// The WASM engine is a Moon-detail engine (checked here rather than in its `implements`
// list, so parallel additions to that line do not collide).
const _wasmIsMoonDetail: (e: WasmEngine) => MoonDetailEngine = (e) => e;
void _wasmIsMoonDetail;

// Planet detail (planetdetail agent), checked the same way.
const _wasmIsPlanetDetail: (e: WasmEngine) => PlanetDetailEngine = (e) => e;
void _wasmIsPlanetDetail;

export type WasmLoad =
  | { status: 'ready'; engine: WasmEngine; missingOptional: string[] }
  | { status: 'absent' }
  | { status: 'incomplete'; missing: string[]; missingOptional: string[]; version: string | null };

/** Check an initialised package module for the explorer exports. */
export function inspectWasmModule(module: object): WasmLoad {
  const missing = missingExports(module);
  if (missing.required.length > 0) {
    const m = module as { version?: () => string };
    let version: string | null = null;
    try {
      version = typeof m.version === 'function' ? m.version() : null;
    } catch {
      version = null;
    }
    return { status: 'incomplete', missing: missing.required, missingOptional: missing.optional, version };
  }
  return {
    status: 'ready',
    engine: new WasmEngine(module as ExplorerWasmExports),
    missingOptional: missing.optional,
  };
}

const packageModules = import.meta.glob('../../wasm-pkg/skyfix_wasm.js');

/** True when a package has been built into `src/wasm-pkg/`. */
export function wasmPackagePresent(): boolean {
  return Object.keys(packageModules).length > 0;
}

/**
 * Load and initialise the package. `absent` and `incomplete` are reported; a package
 * that is present but fails to instantiate throws (a fault, never a reason to fall back).
 */
export async function loadWasmEngine(): Promise<WasmLoad> {
  const loader = Object.values(packageModules)[0];
  if (!loader) return { status: 'absent' };
  const module = (await loader()) as {
    default?: (input?: unknown) => Promise<unknown>;
    init?: () => void;
  };
  if (typeof module.default === 'function') await module.default();
  if (typeof module.init === 'function') module.init();
  return inspectWasmModule(module);
}
