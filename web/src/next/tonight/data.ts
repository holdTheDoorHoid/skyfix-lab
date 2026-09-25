/**
 * What the Tonight view asks the engines, grouped by how soon the page needs it. OWNER:
 * tonight agent (expansion programme Q2).
 *
 * Every engine is behind its type guard: a build (or the mock) without one gets `null` and
 * the card says so in a sentence, never an error. Errors of a call that exists are kept as
 * sentences for the card that needed it. Calls go through the memoised engine (`ctx.engine`,
 * component.ts), so the same night asked twice costs nothing.
 *
 * Measured in Node on the real module (2026-09-25, a shared machine): `tonight` 65 ms,
 * `day_events` for the Sun, the Moon and the planets 19 ms, `galactic_centre_windows` 16 ms,
 * `sun_hours` 4 ms — the first stage, drawn at once. The Moon's details and the planets'
 * extras (a few tens of milliseconds) come in the next task; the fortnight ahead
 * (coming.ts: `meteor_showers` for a year 0.26 s, `moon_apsides` 0.16 s, the rest tens of
 * milliseconds each) one engine call per task after that, so the page never stops
 * answering while it fills in.
 */

import type { Ctx } from '../component.js';
import {
  isDeepSkyEngine,
  isEclipseEngine,
  isMoonDetailEngine,
  isPlanetDetailEngine,
  isSunToolsEngine,
  type BodyState,
  type DayEvents,
  type Eclipse,
  type EclipseLocal,
  type EventOptions,
  type GalacticCentreWindows,
  type GalileanEvents,
  type MoonFeatures,
  type MoonOrientation,
  type MoonSyzygy,
  type Observer,
  type PhaseEvent,
  type SaturnRings,
  type SkyConditionsInput,
  type SunHours,
  type Tonight,
} from '../engine/types.js';
import { covered } from '../shell/derived.js';
import { displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { addCalendar } from '../time.js';
import { darkRun, MINUTE, nightProbe, nightStartFor, type SunWindow } from './night.js';

export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^[a-z_]+: /, '');
}

/** Run an engine call; a failure becomes a sentence in `errors` and `null`. */
export function tryCall<T>(errors: string[], what: string, fn: () => T): T | null {
  try {
    return fn();
  } catch (error) {
    errors.push(`${what}: ${errorText(error)}`);
    return null;
  }
}

/** The view's own choice of sky (the deep-sky engine's conditions). */
export interface SkyChoice {
  /** Bortle class, 1 (darkest) to 9. */
  bortle: number;
}

export const DEFAULT_SKY: SkyChoice = { bortle: 5 };

/** Everything that decides one night's numbers. */
export interface NightQuery {
  observer: Observer;
  /** Local mean noon starting the night (night.ts). */
  n: number;
  /** Rise and set on the person's horizon (Settings), as every other view shows them. */
  options: EventOptions;
  conditions: SkyConditionsInput;
  /** Deep-sky objects asked of the engine (the card shows 8, then more). */
  limit: number;
}

/** A key that changes exactly when the numbers of the night would. */
export function queryKey(q: NightQuery): string {
  const o = q.observer;
  return [o.lat_deg, o.lon_deg, o.height_m ?? 0, q.n, q.options.horizon, q.options.height_of_eye_m, q.conditions.bortle ?? '', q.limit].join('|');
}

/** Deep-sky objects the view asks for (it lists 8 at first, more on request). */
export const DSO_LIMIT = 32;

/** The Sun's sky phases and events over a night window, for choosing the night. */
export function sunWindow(ctx: Pick<Ctx, 'engine'>, observer: Observer, n0: number): SunWindow {
  const d = ctx.engine.dayEvents(observer, n0, n0 + 1, ['Sun']);
  return { phases: d.phases, sun: d.bodies.find((b) => b.body === 'Sun') ?? null };
}

/**
 * The night the explorer's time belongs to (night.ts's rule), or null when the engine cannot
 * say (outside its years).
 */
export function chooseNight(ctx: Pick<Ctx, 'engine'>, s: ExplorerState, jd: number = s.time.jd_utc): number | null {
  const observer = engineObserver(s);
  try {
    return nightStartFor(jd, observer.lon_deg, (n0) => sunWindow(ctx, observer, n0));
  } catch {
    return null;
  }
}

/**
 * Where ◀ ▶ put the explorer's time: the same clock time a day away when that moment belongs
 * to the neighbouring night (the usual case), else that night's evening (18:00 local mean
 * time), since dawn moves by a minute or two a day and the same clock time can fall on the
 * other side of the switch. A plain day when the engine cannot say which night it is.
 */
export function stepNightTime(ctx: Pick<Ctx, 'engine'>, s: ExplorerState, dir: -1 | 1): number {
  const candidate = addCalendar(s.time.jd_utc, displayZone(s), { days: dir });
  const n = chooseNight(ctx, s);
  // Outside the engine's years there is no night to find: a day, as the time bar's arrows step.
  if (n === null) return candidate;
  const target = n + dir;
  const nc = chooseNight(ctx, s, candidate);
  return nc !== null && Math.abs(nc - target) < MINUTE ? candidate : target + 0.25;
}

export function nightQuery(s: ExplorerState, n: number, sky: SkyChoice): NightQuery {
  return { observer: engineObserver(s), n, options: eventOptions(s), conditions: { bortle: sky.bortle }, limit: DSO_LIMIT };
}

// -------------------------------------------------------------------------------------
// Stage 1: the night itself
// -------------------------------------------------------------------------------------

export interface NightCore {
  q: NightQuery;
  /** The night lies inside the engine's years. */
  covered: boolean;
  /** The Sun, the Moon and the seven planets from noon to noon. */
  day: DayEvents | null;
  /** The deep-sky engine's night: darkness, planets, objects, showers, the Milky Way. */
  tonight: Tonight | null;
  /** Golden and blue hours, noon to noon. */
  sunHours: SunHours | null;
  /** The galactic centre's dark windows (the photographers' definition). */
  galactic: GalacticCentreWindows | null;
  /** Which engines this build lacks, in words ("deep sky"). */
  missing: string[];
  errors: string[];
}

export function loadCore(ctx: Pick<Ctx, 'engine'>, q: NightQuery): NightCore {
  const { engine } = ctx;
  const errors: string[] = [];
  const missing: string[] = [];
  const inside = covered(ctx, q.n) && covered(ctx, q.n + 1);
  const core: NightCore = { q, covered: inside, day: null, tonight: null, sunHours: null, galactic: null, missing, errors };
  if (!inside) return core;
  core.day = tryCall(errors, 'Rising and setting', () => engine.dayEvents(q.observer, q.n, q.n + 1, 'solar_system', q.options));
  if (isDeepSkyEngine(engine)) {
    core.tonight = tryCall(errors, 'Tonight’s sky', () => engine.tonight(q.observer, nightProbe(q.n), { ...q.conditions, limit: q.limit }));
  } else missing.push('deep sky');
  if (isSunToolsEngine(engine)) {
    core.sunHours = tryCall(errors, 'Golden and blue hours', () => engine.sunHours(q.observer, q.n, q.n + 1));
    core.galactic = tryCall(errors, 'The Milky Way’s core', () => engine.galacticCentreWindows(q.observer, q.n, q.n + 1));
  } else missing.push('sun tools');
  return core;
}

/** The darkness the whole view uses: the deep-sky engine's, else worked out from the phases the same way. */
export function darknessOf(core: NightCore): { kind: string; start: number; end: number; hours: number } | null {
  const d = core.tonight?.night.darkness;
  if (d) return { kind: d.kind, start: d.start.jd_utc, end: d.end.jd_utc, hours: d.hours };
  if (core.tonight) return null;
  const run = core.day ? darkRun(core.day.phases) : null;
  return run ? { kind: run.kind, start: run.start, end: run.end, hours: (run.end - run.start) * 24 } : null;
}

/** A moment that stands for the night: the middle of its darkness, else local mean midnight. */
export function nightMiddle(core: NightCore): number {
  const d = darknessOf(core);
  return d ? (d.start + d.end) / 2 : core.q.n + 0.5;
}

// -------------------------------------------------------------------------------------
// Stage 2: the Moon and the planets in detail
// -------------------------------------------------------------------------------------

export interface EclipseTonight {
  eclipse: Eclipse;
  local: EclipseLocal | null;
}

export interface NightDetail {
  /** Principal phases from 16 days before the night to 16 after. */
  phases: PhaseEvent[] | null;
  /** The Moon at the night's middle (its disc and bright limb). */
  moon: BodyState | null;
  orientation: MoonOrientation | null;
  /** A new or full Moon within two days of the night, with its supermoon flags. */
  syzygy: MoonSyzygy | null;
  features: MoonFeatures | null;
  /** Jupiter's moons during the night. */
  galilean: GalileanEvents | null;
  /** Saturn's rings at the night's middle. */
  rings: SaturnRings | null;
  /** Eclipses whose greatest phase falls in the night. */
  eclipses: EclipseTonight[];
  errors: string[];
}

export function loadDetail(ctx: Pick<Ctx, 'engine'>, core: NightCore): NightDetail {
  const { engine } = ctx;
  const { q } = core;
  const errors: string[] = [];
  const detail: NightDetail = { phases: null, moon: null, orientation: null, syzygy: null, features: null, galilean: null, rings: null, eclipses: [], errors };
  if (!core.covered) return detail;
  const mid = nightMiddle(core);
  detail.phases = tryCall(errors, 'Moon phases', () => engine.moonPhases(q.n - 16, q.n + 16));
  const sky = tryCall(errors, 'The Moon', () => engine.skyState(q.observer, mid, ['Moon']));
  detail.moon = sky?.bodies.find((b) => b.body === 'Moon') ?? null;
  if (isMoonDetailEngine(engine)) {
    detail.orientation = tryCall(errors, 'The Moon’s distance', () => engine.moonOrientation(q.observer, mid));
    const near = (detail.phases ?? []).find((p) => (p.kind === 'full_moon' || p.kind === 'new_moon') && Math.abs(p.jd_utc - mid) <= 2);
    if (near) {
      const a = tryCall(errors, 'Supermoons', () => engine.moonApsides(near.jd_utc - 0.01, near.jd_utc + 0.01));
      detail.syzygy = a?.syzygies.find((z) => Math.abs(z.jd_utc - near.jd_utc) < 0.01) ?? null;
    }
  }
  if (isPlanetDetailEngine(engine)) {
    detail.galilean = tryCall(errors, 'Jupiter’s moons', () => engine.galileanEvents(q.n, q.n + 1));
    detail.rings = tryCall(errors, 'Saturn’s rings', () => engine.saturnRings(mid));
  }
  if (isEclipseEngine(engine)) {
    const list = tryCall(errors, 'Eclipses', () => engine.eclipses(q.n, q.n + 1));
    for (const eclipse of list?.eclipses ?? []) {
      detail.eclipses.push({ eclipse, local: tryCall(errors, 'The eclipse from here', () => engine.eclipseLocal(eclipse.id, q.observer)) });
    }
  }
  return detail;
}

/**
 * The named features along the terminator at `jd` (a separate call: tens of milliseconds in
 * WebAssembly), or null without a moment (model.ts `featuresMoment`: the Moon must be up).
 */
export function loadFeatures(ctx: Pick<Ctx, 'engine'>, core: NightCore, jd: number | null): MoonFeatures | null {
  const { engine } = ctx;
  if (jd === null || !core.covered || !isMoonDetailEngine(engine)) return null;
  try {
    return engine.moonFeatures(core.q.observer, jd);
  } catch {
    return null;
  }
}
