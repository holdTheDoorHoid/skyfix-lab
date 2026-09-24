/**
 * Data for the planet-visibility chart: for every night of the observer's year, when each
 * planet is above the horizon while the sky is dark (night or astronomical twilight: the
 * Sun more than 12° down). OWNER: charts agent.
 *
 * How it asks the engine, cheaply and exactly:
 *  1. The darkness comes from the year chart's `day_events_batch` of the Sun (the same
 *     call, shared through the memo), plus one `day_events` for the next New Year's Day so
 *     the last night of the year is whole.
 *  2. Each night's dark stretch (local noon to local noon, cut to the Sun below -12°) is a
 *     window for `day_events_batch` over the planets. The planets' rise and set inside
 *     that window, with `always_above` / `always_below` when they do neither, give the
 *     exact dark hours each planet is up. Asking only about the dark hours is about a third
 *     of the work of whole days.
 *  3. That batch runs in chunks of about a month (`PlanetJob.step`): the primary planets
 *     (Venus, Mars, Jupiter, Saturn) across the year first, then Mercury, Uranus and
 *     Neptune, so the page stays responsive and the chart fills in as the engine answers.
 *
 * TypeScript here only intersects intervals the engine gave; it computes no astronomy.
 */

import type { BodyError, BodyEvents, EventOptions, ExplorerEngine, Observer, PhaseSegment } from '../engine/types.js';
import type { Zone } from '../time.js';
import type { YearData } from './year-data.js';
import {
  hoursAfterNoon,
  localDays,
  intersectIntervals,
  mergeIntervals,
  nightsFromDays,
  type Interval,
  type LocalNight,
} from './windows.js';

export const PRIMARY_PLANETS = ['Venus', 'Mars', 'Jupiter', 'Saturn'] as const;
export const SECONDARY_PLANETS = ['Mercury', 'Uranus', 'Neptune'] as const;
export const ALL_PLANETS: readonly string[] = [...PRIMARY_PLANETS, ...SECONDARY_PLANETS];

/** Nights per `day_events_batch` call: about a month, a few tens of milliseconds. */
export const CHUNK_NIGHTS = 31;

export interface PlanetInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly year: number;
  readonly options: EventOptions;
  readonly planets: readonly string[];
}

export type DarkPhase = 'night' | 'astronomical';

export interface DarkSpan {
  readonly phase: DarkPhase;
  readonly jd_start: number;
  readonly jd_end: number;
  /** Clock hours after the evening's local noon (6 = 18:00, 12 = midnight). */
  readonly from: number;
  readonly to: number;
}

export interface VisibleSpan {
  readonly jd_start: number;
  readonly jd_end: number;
  readonly from: number;
  readonly to: number;
}

export type Placement = 'evening' | 'morning' | 'all night' | 'midnight';

export interface PlanetNight {
  readonly night: LocalNight;
  readonly index: number;
  /** Dark stretches of the night, time-ordered (usually astronomical, night, astronomical). */
  readonly dark: readonly DarkSpan[];
  /** First dark instant to last, or null for a night that never gets dark. */
  readonly darkWindow: Interval | null;
  /** Per planet, the dark stretches it is up; filled as the job runs. */
  readonly visible: Map<string, VisibleSpan[]>;
  computed: boolean;
}

export interface PlanetYear {
  readonly input: PlanetInput;
  readonly nights: readonly PlanetNight[];
  /** Clock hours after noon spanning every night's darkness, whole hours; null if never dark. */
  readonly hourRange: readonly [number, number] | null;
  readonly errors: BodyError[];
  readonly problems: string[];
  readonly timing: { engineMs: number; totalMs: number };
}

export interface PlanetJob {
  readonly data: PlanetYear;
  /** Run chunks for about `budgetMs`; true once every night is done. */
  step(budgetMs?: number): boolean;
  readonly done: boolean;
  /** Fraction of the work done, 0-1. */
  readonly progress: number;
  /** Every night with darkness has this planet's answer. */
  has(planet: string): boolean;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isDark(phase: string): phase is DarkPhase {
  return phase === 'night' || phase === 'astronomical';
}

/**
 * Cut the dark phases out of consecutive phase lists (each window's phases in time order,
 * windows back to back) into one night: merged across the midnight joins, clipped to
 * `[jdStart, jdEnd)`.
 */
export function darkSpansIn(phases: readonly PhaseSegment[], jdStart: number, jdEnd: number): { phase: DarkPhase; jd_start: number; jd_end: number }[] {
  const out: { phase: DarkPhase; jd_start: number; jd_end: number }[] = [];
  for (const p of phases) {
    if (!isDark(p.phase)) continue;
    const s = Math.max(p.jd_start, jdStart);
    const e = Math.min(p.jd_end, jdEnd);
    if (!(e > s)) continue;
    const last = out[out.length - 1];
    if (last && last.phase === p.phase && Math.abs(last.jd_end - s) < 1e-9) last.jd_end = e;
    else out.push({ phase: p.phase, jd_start: s, jd_end: e });
  }
  return out;
}

/**
 * When a body is above its rise/set altitude inside a window, from the engine's events for
 * that window: sorted rises and sets, and `always_above` / `always_below` when neither
 * happens.
 */
export function upIntervals(events: BodyEvents, jdStart: number, jdEnd: number): Interval[] {
  const crossings = events.events.filter((e) => e.kind === 'rise' || e.kind === 'set');
  if (crossings.length === 0) return events.always_above ? [[jdStart, jdEnd]] : [];
  const out: Interval[] = [];
  let from: number | null = crossings[0]!.kind === 'set' ? jdStart : null;
  for (const c of crossings) {
    if (c.kind === 'rise') {
      if (from === null) from = c.jd_utc;
    } else if (from !== null) {
      if (c.jd_utc > from) out.push([from, c.jd_utc]);
      from = null;
    }
  }
  if (from !== null && jdEnd > from) out.push([from, jdEnd]);
  return out;
}

/** Evening (up when darkness begins), morning (up when it ends), both, or neither. */
export function placement(spans: readonly VisibleSpan[], darkWindow: Interval | null): Placement | null {
  if (!spans.length || !darkWindow) return null;
  const tol = 1 / 1440; // a minute
  const atStart = spans[0]!.jd_start <= darkWindow[0] + tol;
  const atEnd = spans[spans.length - 1]!.jd_end >= darkWindow[1] - tol;
  if (atStart && atEnd) return 'all night';
  if (atStart) return 'evening';
  if (atEnd) return 'morning';
  return 'midnight';
}

export function visibleHours(spans: readonly VisibleSpan[]): number {
  let total = 0;
  for (const s of spans) total += (s.jd_end - s.jd_start) * 24;
  return total;
}

/**
 * Set up the year's nights from the Sun's year (`computeYear`) and return a job that fills
 * in the planets: the primary planets for every night first, then the secondary ones.
 * `year` must be for the same observer, zone, year and options.
 */
export function planetYearJob(engine: ExplorerEngine, input: PlanetInput, year: YearData): PlanetJob {
  const t0 = now();
  const { observer, zone, options } = input;
  const problems: string[] = [];
  const timing = { engineMs: 0, totalMs: 0 };

  // The year's days and the next New Year's Day, whose morning ends the last night.
  const nextDay = localDays(zone, { year: input.year + 1, month: 1, day: 1 }, 1)[0]!;
  const allDays = [...year.days.map((d) => d.day), nextDay];
  let nextPhases: readonly PhaseSegment[] = [];
  const e0 = now();
  try {
    nextPhases = engine.dayEvents(observer, nextDay.jd_start, nextDay.jd_end, ['Sun'], options).phases;
  } catch (error) {
    problems.push(`The last night of the year is cut at midnight: ${error instanceof Error ? error.message : String(error)}`);
  }
  timing.engineMs += now() - e0;

  const phasesOf = (i: number): readonly PhaseSegment[] => (i < year.days.length ? year.days[i]!.phases : nextPhases);
  const nightsList = nightsFromDays(allDays, zone);
  let lo = Infinity;
  let hi = -Infinity;
  const nights: PlanetNight[] = nightsList.map((night, index) => {
    const phases = [...phasesOf(index), ...phasesOf(index + 1)];
    const dark = darkSpansIn(phases, night.jd_start, night.jd_end).map((s) => ({
      ...s,
      from: hoursAfterNoon(night, s.jd_start, zone),
      to: hoursAfterNoon(night, s.jd_end, zone),
    }));
    const darkWindow: Interval | null = dark.length ? [dark[0]!.jd_start, dark[dark.length - 1]!.jd_end] : null;
    for (const s of dark) {
      lo = Math.min(lo, s.from);
      hi = Math.max(hi, s.to);
    }
    return { night, index, dark, darkWindow, visible: new Map(), computed: darkWindow === null };
  });
  const hourRange: [number, number] | null = Number.isFinite(lo) ? [Math.floor(lo), Math.ceil(hi)] : null;

  const data: PlanetYear = { input, nights, hourRange, errors: [], problems, timing };
  const dark = nights.filter((n) => n.darkWindow !== null);
  const primary = input.planets.filter((p) => (PRIMARY_PLANETS as readonly string[]).includes(p));
  const secondary = input.planets.filter((p) => !primary.includes(p));
  // Work items: (planets, nights) chunks, primary planets across the year first.
  const queue: { planets: string[]; nights: PlanetNight[] }[] = [];
  for (const group of [primary, secondary]) {
    if (!group.length) continue;
    for (let i = 0; i < dark.length; i += CHUNK_NIGHTS) queue.push({ planets: group, nights: dark.slice(i, i + CHUNK_NIGHTS) });
  }
  const total = queue.length;
  let cursor = 0;
  const remaining = new Map<PlanetNight, number>(dark.map((n) => [n, (primary.length ? 1 : 0) + (secondary.length ? 1 : 0)]));
  timing.totalMs = now() - t0;

  function runChunk(): void {
    const item = queue[cursor]!;
    cursor += 1;
    const windows = item.nights.map((n) => [n.darkWindow![0], n.darkWindow![1]] as [number, number]);
    const c0 = now();
    const results = engine.dayEventsBatch(observer, windows, item.planets, options);
    timing.engineMs += now() - c0;
    item.nights.forEach((n, i) => {
      const res = results[i];
      const darkIntervals = mergeIntervals(n.dark.map((s) => [s.jd_start, s.jd_end] as Interval));
      for (const planet of item.planets) {
        const be = res?.bodies.find((b) => b.body === planet);
        if (!be) continue;
        const up = upIntervals(be, n.darkWindow![0], n.darkWindow![1]);
        const spans = intersectIntervals(up, darkIntervals).map(([s, e]) => ({
          jd_start: s,
          jd_end: e,
          from: hoursAfterNoon(n.night, s, zone),
          to: hoursAfterNoon(n.night, e, zone),
        }));
        n.visible.set(planet, spans);
      }
      for (const err of res?.errors ?? []) {
        if (!data.errors.some((x) => x.body === err.body)) data.errors.push(err);
      }
      const left = (remaining.get(n) ?? 1) - 1;
      remaining.set(n, left);
      if (left <= 0) n.computed = true;
    });
  }

  const job: PlanetJob = {
    data,
    step(budgetMs = 40) {
      const s0 = now();
      while (cursor < total) {
        runChunk();
        if (now() - s0 >= budgetMs) break;
      }
      timing.totalMs += now() - s0;
      return cursor >= total;
    },
    get done() {
      return cursor >= total;
    },
    get progress() {
      return total === 0 ? 1 : cursor / total;
    },
    has(planet: string) {
      return data.nights.every((n) => n.darkWindow === null || n.visible.has(planet));
    },
  };
  return job;
}
