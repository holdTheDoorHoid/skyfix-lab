/**
 * Data for the year chart ("sunrise and sunset calendar"): for every local day of the
 * observer's year, the Sun's rise, set and three twilights, the sky phases and the day
 * length, plus the Moon's phases, the equinoxes and solstices, and the clock changes.
 * OWNER: charts agent.
 *
 * One `day_events_batch` call for the whole year (365 or 366 local-midnight windows) is
 * the chart; `moon_phases` and `seasons` do not depend on the observer and are computed
 * separately (`computeYearSky`), so the chart can draw before they arrive. Everything else
 * is arranging the answers on a clock face: local wall-clock hours, so the clock changes
 * show as the jumps they are.
 */

import type {
  BodyError,
  EventOptions,
  ExplorerEngine,
  Observer,
  PhaseEvent,
  PhaseSegment,
  SeasonEvent,
  SkyPhase,
  SunEventKind,
} from '../engine/types.js';
import type { Zone } from '../time.js';
import { coverageRange, covers, OutsideCoverageError, outsideCoverage } from './coverage.js';
import { clockChangeIn, daysOfYear, wallHours, zoneKey, type ClockChange, type LocalDay } from './windows.js';

export interface YearInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly year: number;
  readonly options: EventOptions;
}

export interface WallSpan {
  readonly phase: SkyPhase;
  /** Wall-clock hours since local midnight, 0-24. */
  readonly from: number;
  readonly to: number;
}

export interface WallEvent {
  readonly kind: SunEventKind;
  readonly jd: number;
  /** Wall-clock hours since local midnight. */
  readonly hour: number;
  /** The engine's azimuth and geometric altitude of the Sun at the event (charts2: the bearings chart). */
  readonly az: number;
  readonly alt: number;
}

export interface YearDay {
  readonly day: LocalDay;
  readonly index: number;
  /** The engine's phases for the day, as returned (jd). */
  readonly phases: readonly PhaseSegment[];
  /** The same on the day's wall clock. */
  readonly spans: readonly WallSpan[];
  readonly events: readonly WallEvent[];
  readonly dayLengthH: number | null;
  readonly alwaysAbove: boolean;
  readonly alwaysBelow: boolean;
  readonly clockChange: ClockChange | null;
  /** The engine could not compute the Sun for this day (for example outside its coverage). */
  readonly error: string | null;
}

export interface PolarRun {
  readonly kind: 'midnight_sun' | 'polar_night';
  /** Day indices, inclusive. */
  readonly first: number;
  readonly last: number;
}

export interface DayExtreme {
  readonly index: number;
  readonly hours: number;
}

export interface YearData {
  readonly input: YearInput;
  readonly days: readonly YearDay[];
  readonly clockChanges: readonly ClockChange[];
  readonly polar: readonly PolarRun[];
  readonly longest: DayExtreme | null;
  readonly shortest: DayExtreme | null;
  /** Problems worth saying: calls that failed, bodies left out. */
  readonly errors: readonly string[];
  readonly timing: { readonly engineMs: number; readonly totalMs: number; readonly batchMs: number };
}

/** The Sun's event kinds, in the order of a normal day. */
export const SUN_EVENT_ORDER: readonly SunEventKind[] = [
  'astronomical_dawn',
  'nautical_dawn',
  'civil_dawn',
  'rise',
  'transit',
  'set',
  'civil_dusk',
  'nautical_dusk',
  'astronomical_dusk',
];

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs of consecutive days on which the Sun never rises or never sets. */
export function polarRuns(days: readonly Pick<YearDay, 'alwaysAbove' | 'alwaysBelow' | 'error'>[]): PolarRun[] {
  const out: PolarRun[] = [];
  let current: { kind: PolarRun['kind']; first: number; last: number } | null = null;
  days.forEach((d, i) => {
    const kind = d.error ? null : d.alwaysAbove ? 'midnight_sun' : d.alwaysBelow ? 'polar_night' : null;
    if (current && kind === current.kind && current.last === i - 1) {
      current.last = i;
      return;
    }
    if (current) out.push(current);
    current = kind ? { kind, first: i, last: i } : null;
  });
  if (current) out.push(current);
  return out;
}

/** The Sun's year for an observer: one `day_events_batch` of 365 or 366 local days. */
export function computeYear(engine: ExplorerEngine, input: YearInput): YearData {
  const t0 = now();
  const { observer, zone, year, options } = input;
  const localDays = daysOfYear(zone, year);
  const errors: string[] = [];
  // Only the days the engine covers: it refuses a whole batch that reaches outside.
  const inside = localDays.map((d) => covers(engine, d.jd_start, d.jd_end));
  if (!inside.some(Boolean)) throw new OutsideCoverageError(engine);
  const windows: [number, number][] = localDays.filter((_, i) => inside[i]).map((d) => [d.jd_start, d.jd_end]);
  const outside = localDays.length - windows.length;
  if (outside) errors.push(`${outside} day${outside === 1 ? ' is' : 's are'} left blank. ${outsideCoverage(engine)}`);

  const b0 = now();
  const batch = engine.dayEventsBatch(observer, windows, ['Sun'], options);
  const batchMs = now() - b0;

  const bodyErrors: BodyError[] = [];
  let next = 0;
  const days: YearDay[] = localDays.map((day, index) => {
    const res = inside[index] ? batch[next++] : undefined;
    const sun = res?.bodies.find((b) => b.body === 'Sun') ?? null;
    const err = res?.errors.find((e) => e.body === 'Sun') ?? null;
    if (err && bodyErrors.length === 0) bodyErrors.push(err);
    const phases = res?.phases ?? [];
    const spans: WallSpan[] = phases.map((p) => ({
      phase: p.phase,
      from: Math.max(0, wallHours(day, p.jd_start, zone)),
      to: Math.min(24, wallHours(day, p.jd_end, zone)),
    }));
    const events: WallEvent[] = (sun?.events ?? [])
      .filter((e) => e.kind !== 'lower_transit')
      .map((e) => ({ kind: e.kind as SunEventKind, jd: e.jd_utc, hour: wallHours(day, e.jd_utc, zone), az: e.az_deg, alt: e.alt_deg }));
    return {
      day,
      index,
      phases,
      spans,
      events,
      dayLengthH: sun?.day_length_h ?? null,
      alwaysAbove: sun?.always_above ?? false,
      alwaysBelow: sun?.always_below ?? false,
      clockChange: clockChangeIn(day, zone, index > 0 ? localDays[index - 1]!.offsetEndMs : undefined),
      error: sun ? null : inside[index] ? (err?.message ?? 'no result') : 'outside the engine’s coverage',
    };
  });
  if (bodyErrors.length) {
    const failed = days.filter((d) => d.error).length;
    errors.push(`The Sun could not be computed on ${failed} of ${days.length} days: ${bodyErrors[0]!.message}`);
  }

  let longest: DayExtreme | null = null;
  let shortest: DayExtreme | null = null;
  for (const d of days) {
    if (d.dayLengthH === null || d.error) continue;
    if (!longest || d.dayLengthH > longest.hours) longest = { index: d.index, hours: d.dayLengthH };
    if (!shortest || d.dayLengthH < shortest.hours) shortest = { index: d.index, hours: d.dayLengthH };
  }

  return {
    input,
    days,
    clockChanges: days.flatMap((d) => (d.clockChange ? [d.clockChange] : [])),
    polar: polarRuns(days),
    longest,
    shortest,
    errors,
    timing: { engineMs: batchMs, batchMs, totalMs: now() - t0 },
  };
}

/** The Moon's phases and the equinoxes and solstices of a local year. They do not depend on the observer. */
export interface YearSky {
  readonly zoneYear: string;
  readonly moonPhases: readonly PhaseEvent[];
  readonly seasons: readonly SeasonEvent[];
  readonly errors: readonly string[];
  readonly engineMs: number;
}

export function computeYearSky(engine: ExplorerEngine, zone: Zone, year: number): YearSky {
  const localDays = daysOfYear(zone, year);
  const range = coverageRange(engine);
  const yearStart = Math.max(localDays[0]!.jd_start, range?.start ?? -Infinity);
  const yearEnd = Math.min(localDays[localDays.length - 1]!.jd_end, range?.end ?? Infinity);
  const errors: string[] = [];
  let moonPhases: PhaseEvent[] = [];
  let seasons: SeasonEvent[] = [];
  const m0 = now();
  try {
    if (yearEnd > yearStart) {
      moonPhases = engine.moonPhases(yearStart, yearEnd).filter((p) => p.jd_utc >= yearStart && p.jd_utc < yearEnd);
    }
  } catch (error) {
    errors.push(`Moon phases: ${message(error)}`);
  }
  try {
    // The UTC year's equinoxes and solstices; none falls within a day of New Year, so they
    // are the local year's too.
    seasons = engine.seasons(year).filter((s) => s.jd_utc >= yearStart && s.jd_utc < yearEnd);
  } catch (error) {
    errors.push(`Equinoxes and solstices: ${message(error)}`);
  }
  return { zoneYear: `${zoneKey(zone)}|${year}`, moonPhases, seasons, errors, engineMs: now() - m0 };
}

/** The first event of a kind on a day, or null. */
export function eventOf(day: YearDay, kind: SunEventKind): WallEvent | null {
  return day.events.find((e) => e.kind === kind) ?? null;
}

/** Every event of a kind on a day (at high latitudes a kind can happen twice). */
export function eventsOf(day: YearDay, kind: SunEventKind): WallEvent[] {
  return day.events.filter((e) => e.kind === kind);
}

/**
 * The wall-clock intervals (hours) of one day during which the sky is at least as light as
 * `phase` (phases ranked night < astronomical < nautical < civil < day). Nested layers
 * drawn from night up to day then tile the column with no seams.
 */
export function atLeast(day: YearDay, rank: number, rankOf: (p: SkyPhase) => number): [number, number][] {
  const out: [number, number][] = [];
  for (const s of day.spans) {
    if (rankOf(s.phase) < rank || !(s.to > s.from)) continue;
    const last = out[out.length - 1];
    if (last && Math.abs(last[1] - s.from) < 1e-9) last[1] = s.to;
    else out.push([s.from, s.to]);
  }
  return out;
}
