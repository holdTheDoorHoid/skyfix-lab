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
  EventOptions,
  ExplorerCoverage,
  ExplorerEngine,
  Observer,
  PhaseEvent,
  Sampled,
  SeasonEvent,
  SkyState,
  StarfieldCatalog,
} from './types.js';

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
  version?(): string;
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

export class WasmEngine implements ExplorerEngine, AlmanacEngine {
  readonly kind = 'wasm' as const;
  readonly description: string;
  readonly version: string | null;
  /** Navigation tools (wasm-nav.ts); absent when the package predates their exports. */
  readonly nav?: NavTools;

  private bodiesCache: BodyInfo[] | null = null;
  private coverageCache: ExplorerCoverage | null = null;
  private catalogCache: StarfieldCatalog | null = null;
  private boundariesCache: ConstellationBoundary[] | null = null;

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
