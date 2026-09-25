/**
 * MOCK EXPLORER ENGINE — for developing the interface only (`?engine=mock`, or a
 * development server with no complete WebAssembly build). Never a source of results
 * (EXPLORER_PLAN section 3.1): every number is illustrative, and the page says so while
 * this engine runs.
 *
 * It implements the whole `ExplorerEngine` contract with the same shapes, ranges,
 * conventions and failure modes as the real one: canonical names, `errors` for bodies
 * outside the coverage window, thrown errors for malformed input, typed arrays where
 * the contract says, events found by the numerical method of CONVENTIONS 13.3-13.5.
 * The astronomy is low-precision (see `mock/astro.ts`); the star field is mostly
 * synthetic (see `mock/stars.ts`).
 */

import { isoUtc, jdFromIso, jdFromMs, utcMs } from '../time.js';
import { createMockNav } from './mock-nav.js';
import { mockAlmanacDay } from './mock/almanac.js';
// Expansion programme, geomag agent: magnetic field and compass error (mock/geomag.ts).
import { mockCompassError, mockMagneticField, mockMagneticGrid } from './mock/geomag.js';
import type { CompassError, CompassRequest, MagneticField, MagneticGrid, MagneticModelChoice } from './types.js';
import * as A from './mock/astro.js';
import { crossings, grid, sample } from './mock/roots.js';
import * as T from './mock/timescale.js';
import { createMockMisfit } from './mock-misfit.js';
import { MockPacks } from './mock/packs.js';
import type { MisfitEngine, PackEngine, PackInfo, PackStatus } from './types.js';
import { createMockSailings } from './mock-sailings.js';
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
} from './types.js';
// Deep sky (deepsky agent).
import { createMockDeepSky } from './mock/deepsky.js';
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
import {
  buildStarfield,
  mockConstellationAt,
  NAV_STAR_ROWS,
  type MockStarfield,
} from './mock/stars.js';
import type {
  AlmanacDay,
  AlmanacEngine,
  AltitudeCrossing,
  CalendarConversion,
  CalendarConvertRequest,
  BodyError,
  BodyEvents,
  BodyInfo,
  BodyKind,
  BodySelection,
  BodyState,
  ConstellationBoundary,
  DayEvents,
  EventOptions,
  ExplorerCoverage,
  ExplorerEngine,
  Observer,
  PhaseEvent,
  PhaseSegment,
  Sampled,
  SeasonEvent,
  SkyEvent,
  SkyPhase,
  SkyState,
  StarfieldCatalog,
  TimeEngine,
  TimeInfo,
} from './types.js';
import type { NavTools } from './wasm-nav.js';
// Expansion programme — sun tools (suntools agent).
import { createMockSunTools } from './mock-suntools.js';
import type {
  AlignmentResult,
  Analemma,
  AzimuthCrossing,
  EquationOfTime,
  GalacticCentreWindows,
  RiseSetAzimuths,
  SolarDay,
  SolarYear,
  SunHours,
  SunPath,
  SunToolsEngine,
} from './types.js';
import { mockMoonApsides, mockMoonFeatures, mockMoonOrientation, mockOccultations } from './mock/moondetail.js';
import type {
  MoonApsides,
  MoonDetailEngine,
  MoonFeatures,
  MoonOrientation,
  OccultationList,
  OccultationOptions,
} from './types.js';
import { MockTides } from './mock/tides.js';
import { MockLimb } from './mock/limb.js';
import type {
  TideCurve,
  TideDatum,
  TideExtremes,
  TideNow,
  TidesPackInfo,
  TideStation,
  TideStationNear,
} from './types.js';
// Planet detail (expansion programme P9, planetdetail agent): mock/planetdetail.ts.
import * as PD from './mock/planetdetail.js';
import type {
  ConjunctionList,
  ConjunctionOptions,
  CustomBodyInput,
  CustomBodyStates,
  EarthApsides,
  GalileanEvents,
  GalileanMoons,
  OrbitalElements,
  PlanetDisc,
  PlanetStationList,
  PlanetTransitList,
  SaturnRings,
} from './types.js';
import type { LimbEngine, LimbPackInfo, LimbProfile } from './types.js';

export const MOCK_DESCRIPTION =
  'MOCK ENGINE for developing the interface. Every number on this page is illustrative: positions come from ' +
  'low-precision published formulas (the Moon can be half a degree out, event times several minutes), the star ' +
  'field is mostly synthetic, and nothing here comes from the SkyFix Lab numerical core.';

export const MOCK_COVERAGE_START_UTC = '1990-01-01T00:00:00Z';
export const MOCK_COVERAGE_END_UTC = '2060-12-31T23:59:59Z';
const COVERAGE_START = jdFromIso(MOCK_COVERAGE_START_UTC)!;
const COVERAGE_END = jdFromIso(MOCK_COVERAGE_END_UTC)!;
const OUT_OF_COVERAGE = `outside the coverage window (${MOCK_COVERAGE_START_UTC} to ${MOCK_COVERAGE_END_UTC})`;

/** Contract limits (EXPLORER_API). */
export const MAX_SAMPLES = 20_000;
export const MAX_WINDOWS = 400;
/** A mock-only guard so a mistaken call cannot freeze the page. */
const MAX_WINDOW_DAYS = 400;

const MOON_STEP_DAYS = 10 / 1440;
const OTHER_STEP_DAYS = 20 / 1440;

const SUN_H0_DEG = -50 / 60;
const STANDARD_REFRACTION_DEG = 34 / 60;
const TWILIGHTS = [
  [-6, 'civil_dawn', 'civil_dusk'],
  [-12, 'nautical_dawn', 'nautical_dusk'],
  [-18, 'astronomical_dawn', 'astronomical_dusk'],
] as const;

const DEFAULT_OPTIONS: EventOptions = { horizon: 'standard', height_of_eye_m: 0 };

export interface MockEngineOptions {
  /** Synthetic stars in the star field (default 2000; the real catalogue has about 9 000). */
  syntheticStars?: number;
  /**
   * Report every coverage group as validated, to exercise the "offered for sights" paths
   * of the interface. Default false: the mock is not validated against anything.
   */
  validated?: boolean;
  /** Tides (tides agent): answer as if the tides-us pack were loaded (default true). */
  tidesLoaded?: boolean;
  /** Lunar limb (eclipselimb agent): answer as if the lunar-limb pack were loaded (default true). */
  limbLoaded?: boolean;
}

interface BodyDef {
  name: string;
  kind: BodyKind;
  navigational: boolean;
  /** Stars: catalogue data. */
  star?: { unit: A.Vec3; magnitude: number; con: string; hip: number };
}

/** Everything shared by all bodies at one instant; the costlier parts are computed on first use. */
class Epoch {
  readonly t: number;
  readonly gmst: number;
  private precession?: A.Mat3;
  private sunPos?: A.SunPosition;
  private earthPos?: A.Vec3;
  constructor(readonly jd: number) {
    this.t = A.centuriesTT(jd);
    this.gmst = A.gmstDeg(jd);
  }
  get P(): A.Mat3 {
    return (this.precession ??= A.precessionMatrix(this.t));
  }
  get sun(): A.SunPosition {
    return (this.sunPos ??= A.sunPosition(this.jd));
  }
  get earth(): A.Vec3 {
    return (this.earthPos ??= A.heliocentric('EMBary', this.t));
  }
}

/**
 * Epochs shared across the bodies of one call (they are sampled on the same grid), and
 * the Sun's samples, which the Sun's events and the sky phases both need.
 */
class EpochCache {
  private readonly map = new Map<number, Epoch>();
  readonly sun = new Map<number, Sample>();
  at(jd: number): Epoch {
    let ep = this.map.get(jd);
    if (!ep) {
      ep = new Epoch(jd);
      this.map.set(jd, ep);
    }
    return ep;
  }
}

interface Geo {
  ra: number;
  dec: number;
  dist_km: number | null;
  sd_arcmin: number;
  hp_arcmin: number;
  magnitude: number | null;
  phase_angle: number | null;
  illum: number | null;
  elong: number | null;
  limb: number | null;
}

interface Place {
  lat_deg: number;
  lon_deg: number;
  height_m: number;
  pressure_hpa: number;
  temperature_c: number;
  site: A.Site;
}

interface Sample {
  alt: number;
  az: number;
  altApparent: number;
  /** LHA, degrees [0, 360). */
  lha: number;
  gha: number;
  dec: number;
  sd_deg: number;
}

const NAVIGATIONAL_PLANETS = new Set(['Venus', 'Mars', 'Jupiter', 'Saturn']);

function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${what}: expected a finite number, got ${String(value)}`);
  }
  return value;
}

function skyPhase(altDeg: number): SkyPhase {
  if (altDeg > SUN_H0_DEG) return 'day';
  if (altDeg > -6) return 'civil';
  if (altDeg > -12) return 'nautical';
  if (altDeg > -18) return 'astronomical';
  return 'night';
}

/** Run `fn`; a thrown string becomes an `Error` named after the export, as in the WASM engine. */
function rethrow<R>(name: string, fn: () => R): R {
  try {
    return fn();
  } catch (error) {
    throw new Error(`${name}: ${typeof error === 'string' ? error : String(error)}`);
  }
}

function inCoverage(jd: number): boolean {
  return jd >= COVERAGE_START && jd <= COVERAGE_END;
}

export class MockEngine
  implements ExplorerEngine, AlmanacEngine, PackEngine, TimeEngine, SailingsEngine, MoonDetailEngine, DeepSkyEngine
{
  readonly kind = 'mock' as const;
  readonly description = MOCK_DESCRIPTION;
  /** Navigation tools for the Navigate view (mock-nav.ts): illustrative, like everything here. */
  readonly nav: NavTools = createMockNav(this);

  private readonly defs: BodyDef[];
  private readonly byName = new Map<string, BodyDef>();
  private readonly bySquash = new Map<string, BodyDef>();
  private readonly byHip = new Map<number, BodyDef>();
  private readonly field: MockStarfield;
  private readonly validated: boolean;
  /** The residual heat map (mock-misfit.ts): illustrative, like everything here. */
  readonly misfit: MisfitEngine = createMockMisfit(this);
  /** Data packs (mock/packs.ts): the planned registry; `loadPack` accepts anything. */
  private readonly packRegistry = new MockPacks();

  packs(): PackStatus[] {
    return this.packRegistry.packs();
  }

  loadPack(name: string, bytes: Uint8Array): PackInfo {
    const info = this.packRegistry.loadPack(name, bytes);
    if (name === 'tides-us') this.tides.install(); // tides agent: the synthetic station answers once loaded
    if (name === 'lunar-limb') this.limb.install(); // eclipselimb agent: the synthetic limb answers once loaded
    return info;
  }

  /** Sailings, DR, routes, star identification, star finder (mock-sailings.ts): illustrative. */
  private readonly sailings: SailingsEngine = createMockSailings((o, jd) => this.skyState(o, jd, 'all'));

  sailing(request: PassageRequest): PassageReport {
    return this.sailings.sailing(request);
  }

  drAdvance(request: DrRequest): DrReport {
    return this.sailings.drAdvance(request);
  }

  routePositions(request: RouteRequest): RouteReport {
    return this.sailings.routePositions(request);
  }

  starIdentify(request: StarIdRequest): StarIdResult {
    return this.sailings.starIdentify(request);
  }

  starFinderGeometry(latBand: number, jdUtc?: number): StarFinderGeometry {
    return this.sailings.starFinderGeometry(latBand, jdUtc);
  }
  /** Deep sky (mock/deepsky.ts): illustrative, like everything here. */
  private readonly deep: DeepSkyEngine = createMockDeepSky(this);

  constructor(options: MockEngineOptions = {}) {
    this.validated = options.validated ?? false;
    this.tides = new MockTides({ loaded: options.tidesLoaded ?? true });
    this.limb = new MockLimb({ loaded: options.limbLoaded ?? true });
    this.field = buildStarfield({ synthetic: options.syntheticStars ?? 2000 });
    this.defs = [
      { name: 'Sun', kind: 'sun', navigational: true },
      { name: 'Moon', kind: 'moon', navigational: true },
      ...A.PLANET_NAMES.map(
        (name): BodyDef => ({ name, kind: 'planet', navigational: NAVIGATIONAL_PLANETS.has(name) }),
      ),
      ...NAV_STAR_ROWS.map(
        ([name, hip, ra, dec, vmag, , , con]): BodyDef => ({
          name,
          kind: 'star',
          navigational: true,
          star: { unit: A.unitVector(ra, dec), magnitude: vmag, con, hip },
        }),
      ),
    ];
    for (const def of this.defs) {
      this.byName.set(def.name.toLowerCase(), def);
      this.bySquash.set(squash(def.name), def);
      if (def.star) this.byHip.set(def.star.hip, def);
    }
  }

  // -------------------------------------------------------------------------
  // Tables
  // -------------------------------------------------------------------------

  bodies(): BodyInfo[] {
    return this.defs.map((d) => ({
      body: d.name,
      kind: d.kind,
      navigational: d.navigational,
      magnitude: d.star ? d.star.magnitude : null,
    }));
  }

  coverage(): ExplorerCoverage {
    const note =
      'MOCK engine for interface development: illustrative numbers, not validated against any reference.' +
      (this.validated ? ' Reported as validated only to exercise the interface.' : '');
    const group = (name: string, provider: string, accuracy: number, bodies: string[]) => ({
      name,
      provider: `MOCK: ${provider}`,
      accuracy_arcmin: accuracy,
      validated: this.validated,
      notes: note,
      bodies,
    });
    return {
      start_utc: MOCK_COVERAGE_START_UTC,
      end_utc: MOCK_COVERAGE_END_UTC,
      groups: [
        group('Sun', 'Astronomical Almanac low-precision Sun', 1, ['Sun']),
        group('Moon', 'Astronomical Almanac low-precision Moon', 30, ['Moon']),
        group('Planets', 'JPL approximate Keplerian elements (Standish)', 10, [...A.PLANET_NAMES]),
        group(
          'Stars',
          'navigational star list, precession only',
          1,
          NAV_STAR_ROWS.map(([name]) => name),
        ),
      ],
    };
  }

  // -------------------------------------------------------------------------
  // Positions
  // -------------------------------------------------------------------------

  skyState(observer: Observer, jdUtc: number, bodies: BodySelection): SkyState {
    const place = this.place(observer);
    const jd = finite(jdUtc, 'jd_utc');
    const list = this.resolve(bodies);
    const ep = this.epoch(jd);
    const out: BodyState[] = [];
    const errors: BodyError[] = [];
    if (!inCoverage(jd)) {
      for (const def of list) errors.push({ body: def.name, message: OUT_OF_COVERAGE });
    } else {
      for (const def of list) out.push(this.bodyState(def, ep, place));
    }
    const sun = this.sampleAt(this.defs[0]!, ep, place);
    return {
      jd_utc: jd,
      utc: isoUtc(jd),
      gha_aries_deg: ep.gmst,
      sun_altitude_deg: sun.alt,
      sky_phase: skyPhase(sun.alt),
      bodies: out,
      errors,
    };
  }

  sampleBodies(
    observer: Observer,
    bodies: BodySelection,
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled {
    const place = this.place(observer);
    const list = this.resolve(bodies);
    const t0 = finite(jdStart, 'jd_start');
    const t1 = finite(jdEnd, 'jd_end');
    const step = finite(stepMinutes, 'step_minutes');
    if (!(step > 0)) throw new Error('step_minutes must be greater than zero');
    if (t1 < t0) throw new Error('jd_end is before jd_start');
    const stepDays = step / 1440;
    const n = Math.floor((t1 - t0) / stepDays + 1e-9) + 1;
    if (n > MAX_SAMPLES) {
      throw new Error(`sample_bodies: ${n} samples per body requested; the limit is ${MAX_SAMPLES}`);
    }
    const times = new Float64Array(n);
    for (let k = 0; k < n; k += 1) times[k] = t0 + k * stepDays;

    const errors: BodyError[] = [];
    if (!inCoverage(t0) || !inCoverage(times[n - 1]!)) {
      for (const def of list) errors.push({ body: def.name, message: OUT_OF_COVERAGE });
      return { jd_utc: times, bodies: [], errors };
    }
    const tracks = list.map((def) => ({
      body: def.name,
      alt_deg: new Float64Array(n),
      alt_apparent_deg: new Float64Array(n),
      az_deg: new Float64Array(n),
      gha_deg: new Float64Array(n),
      dec_deg: new Float64Array(n),
    }));
    for (let k = 0; k < n; k += 1) {
      const ep = this.epoch(times[k]!);
      list.forEach((def, j) => {
        const s = this.sampleAt(def, ep, place);
        const track = tracks[j]!;
        track.alt_deg[k] = s.alt;
        track.alt_apparent_deg[k] = s.altApparent;
        track.az_deg[k] = s.az;
        track.gha_deg[k] = s.gha;
        track.dec_deg[k] = s.dec;
      });
    }
    return { jd_utc: times, bodies: tracks, errors };
  }

  sidereal(jdUtc: number): { gha_aries_deg: number } {
    return { gha_aries_deg: A.gmstDeg(finite(jdUtc, 'jd_utc')) };
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  dayEvents(
    observer: Observer,
    jdStart: number,
    jdEnd: number,
    bodies: BodySelection,
    options: EventOptions = DEFAULT_OPTIONS,
  ): DayEvents {
    const place = this.place(observer);
    const list = this.resolve(bodies);
    const [t0, t1] = this.window(jdStart, jdEnd);
    const opts = this.eventOptions(options);
    const errors: BodyError[] = [];
    const out: BodyEvents[] = [];
    const covered = inCoverage(t0) && inCoverage(t1);
    const epochs = new EpochCache();
    for (const def of list) {
      if (covered) out.push(this.bodyEvents(def, place, t0, t1, opts, epochs));
      else errors.push({ body: def.name, message: OUT_OF_COVERAGE });
    }
    return { jd_start: t0, jd_end: t1, phases: this.phases(place, t0, t1, epochs), bodies: out, errors };
  }

  dayEventsBatch(
    observer: Observer,
    windows: [number, number][],
    bodies: BodySelection,
    options: EventOptions = DEFAULT_OPTIONS,
  ): DayEvents[] {
    if (!Array.isArray(windows)) throw new Error('windows: expected an array of [jd_start, jd_end]');
    if (windows.length > MAX_WINDOWS) {
      throw new Error(`day_events_batch: ${windows.length} windows; the limit is ${MAX_WINDOWS}`);
    }
    return windows.map((w) => {
      if (!Array.isArray(w) || w.length !== 2) throw new Error('windows: each window is [jd_start, jd_end]');
      return this.dayEvents(observer, w[0], w[1], bodies, options);
    });
  }

  findAltitude(
    observer: Observer,
    body: string,
    jdStart: number,
    jdEnd: number,
    altitudeDeg: number,
  ): AltitudeCrossing[] {
    const place = this.place(observer);
    const def = this.resolveOne(body);
    const [t0, t1] = this.window(jdStart, jdEnd);
    const target = finite(altitudeDeg, 'altitude_deg');
    if (!inCoverage(t0) || !inCoverage(t1)) throw new Error(`find_altitude: ${OUT_OF_COVERAGE}`);
    const ev = (t: number): Sample => this.sampleAt(def, this.epoch(t), place);
    const f = (t: number): number => ev(t).altApparent - target;
    const times = grid(t0, t1, def.kind === 'moon' ? MOON_STEP_DAYS : OTHER_STEP_DAYS);
    return crossings(f, times, sample(f, times)).map((c) => {
      const s = ev(c.t);
      return { jd_utc: c.t, utc: isoUtc(c.t), alt_deg: s.altApparent, az_deg: s.az, rising: c.rising };
    });
  }

  moonPhases(jdStart: number, jdEnd: number): PhaseEvent[] {
    const [t0, t1] = this.window(jdStart, jdEnd, 80 * 366);
    if (!inCoverage(t0) || !inCoverage(t1)) throw new Error(`moon_phases: ${OUT_OF_COVERAGE}`);
    const elongation = (t: number): number =>
      A.norm360(A.moonPosition(t).lon_deg - A.sunPosition(t).lon_deg);
    const times = grid(t0, t1, 0.5);
    const values = sample(elongation, times);
    const kinds = ['new_moon', 'first_quarter', 'full_moon', 'last_quarter'] as const;
    const out: PhaseEvent[] = [];
    kinds.forEach((kind, k) => {
      const f = (t: number): number => A.wrap180(elongation(t) - 90 * k);
      const v = values.map((x) => A.wrap180(x - 90 * k));
      for (const c of crossings(f, times, v, { maxJump: 90, risingOnly: true })) {
        out.push({ kind, jd_utc: c.t, utc: isoUtc(c.t) });
      }
    });
    return out.sort((a, b) => a.jd_utc - b.jd_utc);
  }

  seasons(year: number): SeasonEvent[] {
    if (!Number.isInteger(year)) throw new Error(`seasons: year must be an integer, got ${String(year)}`);
    const t0 = jdFromMs(utcMs(year, 1, 1));
    const t1 = jdFromMs(utcMs(year + 1, 1, 1));
    if (!inCoverage(t0) || !inCoverage(t1 - 1 / 86_400)) throw new Error(`seasons: ${year} is ${OUT_OF_COVERAGE}`);
    const lon = (t: number): number => A.sunPosition(t).lon_deg;
    const times = grid(t0, t1, 1);
    const values = sample(lon, times);
    const kinds = ['march_equinox', 'june_solstice', 'september_equinox', 'december_solstice'] as const;
    const out: SeasonEvent[] = [];
    kinds.forEach((kind, k) => {
      const f = (t: number): number => A.wrap180(lon(t) - 90 * k);
      const v = values.map((x) => A.wrap180(x - 90 * k));
      for (const c of crossings(f, times, v, { maxJump: 90, risingOnly: true })) {
        out.push({ kind, jd_utc: c.t, utc: isoUtc(c.t) });
      }
    });
    return out.sort((a, b) => a.jd_utc - b.jd_utc);
  }

  // -------------------------------------------------------------------------
  // Star field (display only)
  // -------------------------------------------------------------------------

  starfieldCatalog(): StarfieldCatalog {
    return this.field.catalog;
  }

  starfieldApparent(jdUtc: number): Float64Array {
    const m = A.precessionMatrix(A.centuriesTT(finite(jdUtc, 'jd_utc')));
    const u = this.field.unit;
    const count = this.field.catalog.count;
    const out = new Float64Array(2 * count);
    for (let i = 0; i < count; i += 1) {
      const x = u[3 * i]!;
      const y = u[3 * i + 1]!;
      const z = u[3 * i + 2]!;
      const X = m[0] * x + m[1] * y + m[2] * z;
      const Y = m[3] * x + m[4] * y + m[5] * z;
      const Z = m[6] * x + m[7] * y + m[8] * z;
      let ra = Math.atan2(Y, X);
      if (ra < 0) ra += 2 * Math.PI;
      out[2 * i] = ra;
      out[2 * i + 1] = Math.asin(Math.max(-1, Math.min(1, Z)));
    }
    return out;
  }

  constellationAt(raDeg: number, decDeg: number, jdUtc: number): string {
    const dec = finite(decDeg, 'dec_deg');
    if (dec < -90 || dec > 90) throw new Error(`dec_deg ${dec} is outside [-90, 90]`);
    return mockConstellationAt(this.field, finite(raDeg, 'ra_deg'), dec, A.centuriesTT(finite(jdUtc, 'jd_utc')));
  }

  constellationBoundaries(): ConstellationBoundary[] {
    return this.field.boundaries;
  }

  /** The mock's frame of date is precession only: the same matrix `starfieldApparent` uses. */
  starfieldFrameMatrix(jdUtc: number): Float64Array {
    return Float64Array.from(A.precessionMatrix(A.centuriesTT(finite(jdUtc, 'jd_utc'))));
  }

  // -------------------------------------------------------------------------
  // Almanac pages (illustrative; see mock/almanac.ts)
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Deep sky (mock/deepsky.ts)
  // -------------------------------------------------------------------------

  dsoCatalog(): DsoCatalog {
    return this.deep.dsoCatalog();
  }

  dsoList(observer: Observer | null, jdUtc: number, options?: DsoListOptions): DsoPositions {
    return this.deep.dsoList(observer, jdUtc, options);
  }

  dsoVisibility(id: string, observer: Observer, jdUtc: number, conditions?: SkyConditionsInput): DsoVisibility {
    return this.deep.dsoVisibility(id, observer, jdUtc, conditions);
  }

  meteorShowers(year: number, observer?: Observer | null, conditions?: SkyConditionsInput): ShowerYear {
    return this.deep.meteorShowers(year, observer, conditions);
  }

  milkyWayOutline(): MilkyWayOutline {
    return this.deep.milkyWayOutline();
  }

  skySearch(query: string, observer?: Observer | null, jdUtc?: number | null, limit?: number): SearchResult {
    return this.deep.skySearch(query, observer, jdUtc, limit);
  }

  tonight(observer: Observer, jdUtc: number, options?: TonightOptions): Tonight {
    return this.deep.tonight(observer, jdUtc, options);
  }

  extinction(conditions?: SkyConditionsInput): ExtinctionTable {
    return this.deep.extinction(conditions);
  }

  almanacDay(date: string): AlmanacDay {
    return mockAlmanacDay(this, date);
  }

  // --- Tides (tides agent): one synthetic station (mock/tides.ts), illustrative only.
  private readonly tides: MockTides;

  tideStationsNear(latDeg: number, lonDeg: number, n: number): TideStationNear[] {
    return this.tides.tideStationsNear(latDeg, lonDeg, n);
  }

  tideStation(stationId: string): TideStation {
    return this.tides.tideStation(stationId);
  }

  tidePredict(stationId: string, jdStart: number, jdEnd: number, stepMin: number, datum: TideDatum | '' = ''): TideCurve {
    return this.tides.tidePredict(stationId, jdStart, jdEnd, stepMin, datum);
  }

  tideExtremes(stationId: string, jdStart: number, jdEnd: number, datum: TideDatum | '' = ''): TideExtremes {
    return this.tides.tideExtremes(stationId, jdStart, jdEnd, datum);
  }

  tideNow(stationId: string, jdUtc: number, datum: TideDatum | '' = ''): TideNow {
    return this.tides.tideNow(stationId, jdUtc, datum);
  }

  tidePackInfo(): TidesPackInfo | null {
    return this.tides.tidePackInfo();
  }
  // --- end tides

  // --- Lunar limb (eclipselimb agent, P12): a synthetic profile (mock/limb.ts), illustrative only.
  private readonly limb: MockLimb;

  lunarLimbProfile(observer: Observer, jdUtc: number): LimbProfile {
    return this.limb.lunarLimbProfile(observer, jdUtc);
  }

  lunarLimbInfo(): LimbPackInfo | null {
    return this.limb.lunarLimbInfo();
  }
  // --- end lunar limb

  // -------------------------------------------------------------------------
  // Magnetic field and compass error (expansion programme, geomag agent;
  // illustrative: a tilted dipole, see mock/geomag.ts)
  // -------------------------------------------------------------------------

  magneticField(
    latDeg: number,
    lonDeg: number,
    heightM: number,
    jdUtc: number,
    model?: MagneticModelChoice,
  ): MagneticField {
    return mockMagneticField(latDeg, lonDeg, heightM, jdUtc, model);
  }

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
    return mockMagneticGrid(jdUtc, latMin, latMax, nLat, lonMin, lonMax, nLon, heightM);
  }

  compassError(request: CompassRequest): CompassError {
    return mockCompassError(this, request);
  }

  // -------------------------------------------------------------------------
  // Time scales, Delta-T and calendars (mock/timescale.ts: exact calendars, the Rust
  // model's Delta-T without its IERS table, no DUT1 history)
  // -------------------------------------------------------------------------

  private userDut1: number | null = null;

  timeInfo(jdUtc: number): TimeInfo {
    // The deeptime agent's mock tiers replace this `validated`/`outside` split.
    const tier = inCoverage(jdUtc) ? 'validated' : 'outside';
    return rethrow('time_info', () => T.timeInfo(jdUtc, this.userDut1, tier));
  }

  setDut1(seconds: number | null): void {
    this.userDut1 = rethrow('set_dut1', () => T.checkDut1(seconds));
  }

  calendarConvert(request: CalendarConvertRequest): CalendarConversion {
    return rethrow('calendar_convert', () => T.calendarConvert(request));
  }

  // -------------------------------------------------------------------------
  // Planet detail (expansion programme P9, planetdetail agent): `PlanetDetailEngine`,
  // illustrative like everything here (mock/planetdetail.ts).
  // -------------------------------------------------------------------------

  private get planetDetailEnv(): PD.PlanetDetailMockEnv {
    return {
      start: COVERAGE_START,
      end: COVERAGE_END,
      constellationAt: (ra, dec, jd) => this.constellationAt(ra, dec, jd),
    };
  }

  galileanMoons(jdUtc: number): GalileanMoons {
    return PD.mockGalileanMoons(this.planetDetailEnv, jdUtc);
  }

  galileanEvents(jdStart: number, jdEnd: number): GalileanEvents {
    return PD.mockGalileanEvents(this.planetDetailEnv, jdStart, jdEnd);
  }

  saturnRings(jdUtc: number): SaturnRings {
    return PD.mockSaturnRings(this.planetDetailEnv, jdUtc);
  }

  planetDisc(body: string, jdUtc: number): PlanetDisc {
    return PD.mockPlanetDisc(this.planetDetailEnv, body, jdUtc);
  }

  transits(jdStart: number, jdEnd: number, observer?: Observer): PlanetTransitList {
    return PD.mockTransits(this.planetDetailEnv, jdStart, jdEnd, observer);
  }

  conjunctions(jdStart: number, jdEnd: number, options?: ConjunctionOptions): ConjunctionList {
    return PD.mockConjunctions(this.planetDetailEnv, jdStart, jdEnd, options);
  }

  stations(jdStart: number, jdEnd: number): PlanetStationList {
    return PD.mockStations(this.planetDetailEnv, jdStart, jdEnd);
  }

  earthApsides(year: number): EarthApsides {
    return PD.mockEarthApsides(this.planetDetailEnv, year);
  }

  parseOrbits(text: string): OrbitalElements[] {
    return PD.mockParseOrbits(text);
  }

  customBodyStates(observer: Observer, jdUtc: number, bodies: CustomBodyInput[]): CustomBodyStates {
    return PD.mockCustomBodyStates(this.planetDetailEnv, observer, jdUtc, bodies);
  }

  sampleCustomBodies(
    observer: Observer,
    bodies: CustomBodyInput[],
    jdStart: number,
    jdEnd: number,
    stepMinutes: number,
  ): Sampled {
    return PD.mockSampleCustomBodies(this.planetDetailEnv, observer, bodies, jdStart, jdEnd, stepMinutes);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private place(observer: Observer): Place {
    if (!observer || typeof observer !== 'object') throw new Error('observer: expected an object');
    const lat = finite(observer.lat_deg, 'observer.lat_deg');
    if (lat < -90 || lat > 90) throw new Error(`observer.lat_deg ${lat} is outside [-90, 90]`);
    const lon = A.wrap180(finite(observer.lon_deg, 'observer.lon_deg'));
    const height = observer.height_m === undefined ? 0 : finite(observer.height_m, 'observer.height_m');
    const pressure =
      observer.pressure_hpa === undefined ? 1010 : finite(observer.pressure_hpa, 'observer.pressure_hpa');
    const temperature =
      observer.temperature_c === undefined ? 10 : finite(observer.temperature_c, 'observer.temperature_c');
    if (pressure < 0) throw new Error('observer.pressure_hpa must not be negative');
    if (temperature <= -273) throw new Error('observer.temperature_c is below absolute zero');
    return {
      lat_deg: lat,
      lon_deg: lon,
      height_m: height,
      pressure_hpa: pressure,
      temperature_c: temperature,
      site: A.makeSite(lat, lon, height),
    };
  }

  private window(jdStart: number, jdEnd: number, maxDays = MAX_WINDOW_DAYS): [number, number] {
    const t0 = finite(jdStart, 'jd_start');
    const t1 = finite(jdEnd, 'jd_end');
    if (!(t1 > t0)) throw new Error('jd_end must be after jd_start');
    if (t1 - t0 > maxDays) throw new Error(`window of ${(t1 - t0).toFixed(1)} days is longer than ${maxDays}`);
    return [t0, t1];
  }

  private eventOptions(options: EventOptions | undefined): EventOptions {
    const o = options ?? DEFAULT_OPTIONS;
    if (o.horizon !== 'standard' && o.horizon !== 'dip') {
      throw new Error(`options.horizon must be "standard" or "dip", got ${String(o.horizon)}`);
    }
    const hoe = o.height_of_eye_m === undefined ? 0 : finite(o.height_of_eye_m, 'options.height_of_eye_m');
    if (hoe < 0) throw new Error('options.height_of_eye_m must not be negative');
    return { horizon: o.horizon, height_of_eye_m: hoe };
  }

  private resolveOne(name: string): BodyDef {
    if (typeof name !== 'string') throw new Error(`body: expected a name, got ${String(name)}`);
    const trimmed = name.trim();
    const hip = /^hip[\s_-]*(\d+)$/i.exec(trimmed);
    const def =
      this.byName.get(trimmed.toLowerCase()) ??
      (hip ? this.byHip.get(Number(hip[1])) : undefined) ??
      (squash(trimmed) ? this.bySquash.get(squash(trimmed)) : undefined);
    if (!def) throw new Error(`unknown body ${JSON.stringify(name)}`);
    return def;
  }

  private resolve(selection: BodySelection): BodyDef[] {
    if (selection === 'all') return this.defs;
    if (selection === 'solar_system') return this.defs.filter((d) => d.kind !== 'star');
    if (selection === 'navigational') return this.defs.filter((d) => d.navigational);
    if (!Array.isArray(selection)) {
      throw new Error(`bodies: expected a list of names or "all", "solar_system", "navigational"`);
    }
    const seen = new Set<BodyDef>();
    for (const name of selection) seen.add(this.resolveOne(name));
    return [...seen];
  }

  private epoch(jd: number): Epoch {
    return new Epoch(jd);
  }

  private geocentric(def: BodyDef, ep: Epoch): Geo {
    const sun = ep.sun;
    switch (def.kind) {
      case 'sun':
        return {
          ra: sun.ra_deg,
          dec: sun.dec_deg,
          dist_km: sun.dist_au * A.AU_KM,
          sd_arcmin: 15.9938 / sun.dist_au,
          hp_arcmin: 0.146568 / sun.dist_au,
          magnitude: -26.74 + 5 * Math.log10(sun.dist_au),
          phase_angle: null,
          illum: null,
          elong: null,
          limb: null,
        };
      case 'moon': {
        const m = A.moonPosition(ep.jd);
        const sunKm = sun.dist_au * A.AU_KM;
        const psi = A.angleBetween(m.ra_deg, m.dec_deg, sun.ra_deg, sun.dec_deg);
        const i =
          Math.atan2(sunKm * Math.sin(psi * A.D2R), m.dist_km - sunKm * Math.cos(psi * A.D2R)) * A.R2D;
        return {
          ra: m.ra_deg,
          dec: m.dec_deg,
          dist_km: m.dist_km,
          sd_arcmin: 0.2725 * m.hp_deg * 60,
          hp_arcmin: m.hp_deg * 60,
          magnitude: -12.73 + 0.026 * Math.abs(i) + 4e-9 * i ** 4,
          phase_angle: i,
          illum: (1 + Math.cos(i * A.D2R)) / 2,
          elong: psi,
          limb: A.brightLimbAngle(sun.ra_deg, sun.dec_deg, m.ra_deg, m.dec_deg),
        };
      }
      case 'planet': {
        const p = A.heliocentric(def.name, ep.t);
        const e = ep.earth;
        const geo: A.Vec3 = [p[0] - e[0], p[1] - e[1], p[2] - e[2]];
        const { ra_deg, dec_deg, r: delta } = A.vecToRaDec(A.applyMat(ep.P, A.eclipticToEquatorialVec(geo)));
        const r = Math.hypot(p[0], p[1], p[2]);
        const R = Math.hypot(e[0], e[1], e[2]);
        const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
        const i = Math.acos(clamp((r * r + delta * delta - R * R) / (2 * r * delta))) * A.R2D;
        const psi = Math.acos(clamp((R * R + delta * delta - r * r) / (2 * R * delta))) * A.R2D;
        const distKm = delta * A.AU_KM;
        return {
          ra: ra_deg,
          dec: dec_deg,
          dist_km: distKm,
          sd_arcmin: (A.PLANET_SD_1AU_ARCSEC[def.name] ?? 0) / delta / 60,
          hp_arcmin: Math.asin(A.EARTH_RADIUS_KM / distKm) * A.R2D * 60,
          magnitude: A.planetMagnitude(def.name, r, delta, i),
          phase_angle: i,
          illum: (1 + Math.cos(i * A.D2R)) / 2,
          elong: psi,
          limb: A.brightLimbAngle(sun.ra_deg, sun.dec_deg, ra_deg, dec_deg),
        };
      }
      case 'star': {
        const { ra_deg, dec_deg } = A.vecToRaDec(A.applyMat(ep.P, def.star!.unit));
        return {
          ra: ra_deg,
          dec: dec_deg,
          dist_km: null,
          sd_arcmin: 0,
          hp_arcmin: 0,
          magnitude: def.star!.magnitude,
          phase_angle: null,
          illum: null,
          elong: null,
          limb: null,
        };
      }
    }
  }

  /** Topocentric place of a geocentric direction: hour angle and declination at the site. */
  private topocentric(g: Geo, place: Place, lst: number): { ha: number; dec: number } {
    const t =
      g.dist_km === null
        ? { ra_deg: g.ra, dec_deg: g.dec }
        : A.topocentricRaDec(g.ra, g.dec, g.dist_km, place.site, lst);
    return { ha: lst - t.ra_deg, dec: t.dec_deg };
  }

  private sampleAt(def: BodyDef, ep: Epoch, place: Place): Sample {
    const g = this.geocentric(def, ep);
    const lst = ep.gmst + place.lon_deg;
    const topo = this.topocentric(g, place, lst);
    const { alt_deg, az_deg } = A.horizontal(topo.ha, topo.dec, place.site);
    const gha = A.norm360(ep.gmst - g.ra);
    return {
      alt: alt_deg,
      az: az_deg,
      altApparent: alt_deg + A.refractionArcmin(alt_deg, place.pressure_hpa, place.temperature_c) / 60,
      lha: A.norm360(gha + place.lon_deg),
      gha,
      dec: g.dec,
      sd_deg: g.sd_arcmin / 60,
    };
  }

  /** `sampleAt` through the per-call caches (the Sun's samples are reused by the phases). */
  private sampleCached(def: BodyDef, t: number, place: Place, epochs: EpochCache): Sample {
    if (def.kind !== 'sun') return this.sampleAt(def, epochs.at(t), place);
    let s = epochs.sun.get(t);
    if (!s) {
      s = this.sampleAt(def, epochs.at(t), place);
      epochs.sun.set(t, s);
    }
    return s;
  }

  private bodyState(def: BodyDef, ep: Epoch, place: Place): BodyState {
    const g = this.geocentric(def, ep);
    const lst = ep.gmst + place.lon_deg;
    const topo = this.topocentric(g, place, lst);
    const { alt_deg, az_deg } = A.horizontal(topo.ha, topo.dec, place.site);
    const altApparent = alt_deg + A.refractionArcmin(alt_deg, place.pressure_hpa, place.temperature_c) / 60;
    const gha = A.norm360(ep.gmst - g.ra);
    const { hc_deg, zn_deg } = A.sightReduction(place.lat_deg, g.dec, gha + place.lon_deg);
    return {
      body: def.name,
      kind: def.kind,
      gha_deg: gha,
      dec_deg: g.dec,
      sha_deg: A.norm360(360 - g.ra),
      ra_deg: g.ra,
      gp: { lat_deg: g.dec, lon_deg: A.wrap180(-gha) },
      alt_deg,
      az_deg,
      alt_apparent_deg: altApparent,
      hc_deg,
      zn_deg,
      above_horizon: altApparent + g.sd_arcmin / 60 > 0,
      distance_km: g.dist_km,
      semidiameter_arcmin: g.sd_arcmin,
      horizontal_parallax_arcmin: g.hp_arcmin,
      magnitude: g.magnitude,
      phase_angle_deg: g.phase_angle,
      illuminated_fraction: g.illum,
      elongation_deg: g.elong,
      bright_limb_angle_deg: g.limb,
      parallactic_angle_deg: A.parallacticAngle(topo.ha, topo.dec, place.site),
      constellation: def.star ? def.star.con : mockConstellationAt(this.field, g.ra, g.dec, ep.t),
    };
  }

  private bodyEvents(
    def: BodyDef,
    place: Place,
    t0: number,
    t1: number,
    options: EventOptions,
    epochs: EpochCache,
  ): BodyEvents {
    const ev = (t: number): Sample => this.sampleCached(def, t, place, epochs);
    const times = grid(t0, t1, def.kind === 'moon' ? MOON_STEP_DAYS : OTHER_STEP_DAYS);
    const samples = Array.from(times, ev);
    const dip = options.horizon === 'dip' ? (1.76 * Math.sqrt(options.height_of_eye_m)) / 60 : 0;
    const h0 = (s: Sample): number =>
      def.kind === 'sun'
        ? SUN_H0_DEG - dip
        : def.kind === 'moon'
          ? -STANDARD_REFRACTION_DEG - s.sd_deg - dip
          : -STANDARD_REFRACTION_DEG - dip;

    const events: SkyEvent[] = [];
    const push = (kind: SkyEvent['kind'], t: number): void => {
      const s = ev(t);
      events.push({ kind, jd_utc: t, utc: isoUtc(t), alt_deg: s.alt, az_deg: s.az });
    };
    const values = (f: (s: Sample) => number): Float64Array => Float64Array.from(samples, f);

    const aboveH0 = (s: Sample): number => s.alt - h0(s);
    const riseSet = crossings((t) => aboveH0(ev(t)), times, values(aboveH0));
    for (const c of riseSet) push(c.rising ? 'rise' : 'set', c.t);

    const upper = (s: Sample): number => A.wrap180(s.lha);
    for (const c of crossings((t) => upper(ev(t)), times, values(upper), { maxJump: 90, risingOnly: true })) {
      push('transit', c.t);
    }
    const lower = (s: Sample): number => A.wrap180(s.lha - 180);
    for (const c of crossings((t) => lower(ev(t)), times, values(lower), { maxJump: 90, risingOnly: true })) {
      push('lower_transit', c.t);
    }
    if (def.kind === 'sun') {
      for (const [deg, dawn, dusk] of TWILIGHTS) {
        const f = (s: Sample): number => s.alt - deg;
        for (const c of crossings((t) => f(ev(t)), times, values(f))) push(c.rising ? dawn : dusk, c.t);
      }
    }
    events.sort((a, b) => a.jd_utc - b.jd_utc);

    const startsAbove = aboveH0(samples[0]!) >= 0;
    const crosses = riseSet.length > 0;
    let dayLength: number | null = null;
    if (def.kind === 'sun') {
      let above = startsAbove;
      let last = t0;
      let total = 0;
      for (const c of riseSet) {
        if (above) total += c.t - last;
        last = c.t;
        above = c.rising;
      }
      if (above) total += t1 - last;
      dayLength = total * 24;
    }
    return {
      body: def.name,
      events,
      always_above: !crosses && startsAbove,
      always_below: !crosses && !startsAbove,
      day_length_h: dayLength,
    };
  }

  /** Contiguous sky phases over the window (CONVENTIONS 13.4); never uses dip. */
  private phases(place: Place, t0: number, t1: number, epochs: EpochCache): PhaseSegment[] {
    const sun = this.defs[0]!;
    const alt = (t: number): number => this.sampleCached(sun, t, place, epochs).alt;
    const times = grid(t0, t1, OTHER_STEP_DAYS);
    const values = sample(alt, times);
    const bounds: number[] = [];
    for (const threshold of [SUN_H0_DEG, -6, -12, -18]) {
      const v = values.map((a) => a - threshold);
      for (const c of crossings((t) => alt(t) - threshold, times, v)) bounds.push(c.t);
    }
    bounds.sort((a, b) => a - b);
    const edges = [t0, ...bounds.filter((b) => b > t0 && b < t1), t1];
    const out: PhaseSegment[] = [];
    for (let i = 0; i + 1 < edges.length; i += 1) {
      const a = edges[i]!;
      const b = edges[i + 1]!;
      if (!(b > a)) continue;
      const phase = skyPhase(alt(0.5 * (a + b)));
      const last = out[out.length - 1];
      if (last && last.phase === phase) last.jd_end = b;
      else out.push({ jd_start: a, jd_end: b, phase });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Expansion programme — sun tools (suntools agent): illustrative, like everything
  // here; see mock-suntools.ts. `SunToolsEngine` in types.ts.
  // -------------------------------------------------------------------------

  private sunToolsCache?: SunToolsEngine;
  private get sunTools(): SunToolsEngine {
    return (this.sunToolsCache ??= createMockSunTools(this));
  }
  sunHours(...args: Parameters<SunToolsEngine['sunHours']>): SunHours {
    return this.sunTools.sunHours(...args);
  }
  findAzimuth(...args: Parameters<SunToolsEngine['findAzimuth']>): AzimuthCrossing[] {
    return this.sunTools.findAzimuth(...args);
  }
  alignmentDays(...args: Parameters<SunToolsEngine['alignmentDays']>): AlignmentResult {
    return this.sunTools.alignmentDays(...args);
  }
  analemma(...args: Parameters<SunToolsEngine['analemma']>): Analemma {
    return this.sunTools.analemma(...args);
  }
  sunPath(...args: Parameters<SunToolsEngine['sunPath']>): SunPath {
    return this.sunTools.sunPath(...args);
  }
  riseSetAzimuths(...args: Parameters<SunToolsEngine['riseSetAzimuths']>): RiseSetAzimuths {
    return this.sunTools.riseSetAzimuths(...args);
  }
  equationOfTime(...args: Parameters<SunToolsEngine['equationOfTime']>): EquationOfTime {
    return this.sunTools.equationOfTime(...args);
  }
  solarDay(...args: Parameters<SunToolsEngine['solarDay']>): SolarDay {
    return this.sunTools.solarDay(...args);
  }
  solarYear(...args: Parameters<SunToolsEngine['solarYear']>): SolarYear {
    return this.sunTools.solarYear(...args);
  }
  galacticCentreWindows(...args: Parameters<SunToolsEngine['galacticCentreWindows']>): GalacticCentreWindows {
    return this.sunTools.galacticCentreWindows(...args);
  }

  // Expansion programme P8 (moondetail agent): the Moon in detail, low precision
  // (mock/moondetail.ts), illustrative like everything here.

  moonOrientation(observer: Observer | null, jdUtc: number): MoonOrientation {
    return mockMoonOrientation(observer, jdUtc);
  }

  moonFeatures(observer: Observer | null, jdUtc: number): MoonFeatures {
    return mockMoonFeatures(observer, jdUtc);
  }

  moonApsides(jdStart: number, jdEnd: number): MoonApsides {
    return mockMoonApsides(this, jdStart, jdEnd);
  }

  occultations(observer: Observer, jdStart: number, jdEnd: number, options?: OccultationOptions): OccultationList {
    return mockOccultations(observer, jdStart, jdEnd, options);
  }
}

// The mock is a Moon-detail engine (checked here rather than in its `implements` list,
// so parallel additions to that line do not collide).
const _mockIsMoonDetail: (e: MockEngine) => MoonDetailEngine = (e) => e;
void _mockIsMoonDetail;
// And a lunar-limb engine (eclipselimb agent), the same way.
const _mockIsLimb: (e: MockEngine) => LimbEngine = (e) => e;
void _mockIsLimb;
