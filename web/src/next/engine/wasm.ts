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
  BodySelection,
  ConstellationBoundary,
  DayEvents,
  EclipseEngine,
  EclipseList,
  EclipseLocal,
  EclipsePath,
  EventOptions,
  ExplorerCoverage,
  ExplorerEngine,
  Observer,
  PhaseEvent,
  PlanetEventList,
  PlanetEventsEngine,
  Sampled,
  SeasonEvent,
  SkyState,
  StarfieldCatalog,
} from './types.js';
import type { MisfitEngine } from './types.js';
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

export class WasmEngine implements ExplorerEngine, AlmanacEngine, EclipseEngine, PlanetEventsEngine {
  readonly kind = 'wasm' as const;
  readonly description: string;
  readonly version: string | null;
  /** Navigation tools (wasm-nav.ts); absent when the package predates their exports. */
  readonly nav?: NavTools;

  private bodiesCache: BodyInfo[] | null = null;
  private coverageCache: ExplorerCoverage | null = null;
  private catalogCache: StarfieldCatalog | null = null;
  private boundariesCache: ConstellationBoundary[] | null = null;

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

  /** What one observer sees of an eclipse, by id (`eclipse_local`). */
  eclipseLocal(id: string, observer: Observer): EclipseLocal {
    const fn = this.x.eclipse_local;
    if (typeof fn !== 'function') throw rebuildError('eclipse_local', 'eclipses');
    return this.call('eclipse_local', () => fn.call(this.x, id, observerJson(observer)));
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
}

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
