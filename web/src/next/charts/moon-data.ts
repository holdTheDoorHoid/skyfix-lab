/**
 * Data for the Moon calendar: for each local day of a month, the Moon's phase (illuminated
 * fraction, bright-limb direction, waxing or waning, age), its rise and set, and the named
 * phases that fall on that date. OWNER: charts agent.
 *
 * Engine calls: one `day_events_batch` for the month's days, one `moon_phases` spanning the
 * month with a lunation either side (to know the preceding new moon), and one `sky_state`
 * per day at local noon for the disc.
 */

import type { EventOptions, ExplorerEngine, Observer, PhaseEvent } from '../engine/types.js';
import { jdFromWallClock, type Zone } from '../time.js';
import { coverageRange, covers, OutsideCoverageError } from './coverage.js';
import { daysOfMonth, localDateOf, sameDate, type LocalDate, type LocalDay } from './windows.js';

/** A lunation is 29.53 days; asking for 35 either side always brackets the month. */
const MARGIN_DAYS = 35;

export interface MoonInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  readonly options: EventOptions;
}

export type PhaseKind = PhaseEvent['kind'];

export const PHASE_NAMES: Record<PhaseKind, string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter',
};

export interface MoonDay {
  readonly day: LocalDay;
  /** Local noon: the instant the disc shows. */
  readonly noonJd: number;
  readonly illuminated: number | null;
  readonly brightLimbDeg: number | null;
  readonly phaseAngleDeg: number | null;
  /** Between a new moon and the next full moon; null when the engine's phases do not say. */
  readonly waxing: boolean | null;
  /** Days since the preceding new moon, at local noon. */
  readonly ageDays: number | null;
  /** "Waxing crescent", or the principal phase's name on the day it happens. */
  readonly name: string;
  /** A principal phase whose instant falls on this local date. */
  readonly principal: PhaseEvent | null;
  readonly rises: readonly number[];
  readonly sets: readonly number[];
  readonly alwaysAbove: boolean;
  readonly alwaysBelow: boolean;
  readonly error: string | null;
}

export interface MoonMonth {
  readonly input: MoonInput;
  readonly days: readonly MoonDay[];
  /** The principal phases within the month. */
  readonly events: readonly PhaseEvent[];
  readonly errors: readonly string[];
  readonly timing: { readonly engineMs: number; readonly totalMs: number };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Waxing or waning at `jd` from the engine's principal phases: after a new moon or first
 * quarter it is waxing; after a full moon or last quarter, waning. Null when no phase
 * precedes `jd` in the list.
 */
export function waxingAt(events: readonly PhaseEvent[], jd: number): boolean | null {
  let last: PhaseEvent | null = null;
  for (const e of events) {
    if (e.jd_utc <= jd) last = e;
    else break;
  }
  if (!last) return null;
  return last.kind === 'new_moon' || last.kind === 'first_quarter';
}

/** Days since the latest new moon at or before `jd`, or null. */
export function moonAge(events: readonly PhaseEvent[], jd: number): number | null {
  let lastNew: number | null = null;
  for (const e of events) {
    if (e.jd_utc > jd) break;
    if (e.kind === 'new_moon') lastNew = e.jd_utc;
  }
  return lastNew === null ? null : jd - lastNew;
}

/** The descriptive name between the principal phases. */
export function phaseName(illuminated: number | null, waxing: boolean | null): string {
  if (illuminated === null) return '—';
  const gibbous = illuminated > 0.5;
  if (waxing === null) return gibbous ? 'Gibbous' : 'Crescent';
  return `${waxing ? 'Waxing' : 'Waning'} ${gibbous ? 'gibbous' : 'crescent'}`;
}

export function computeMoonMonth(engine: ExplorerEngine, input: MoonInput): MoonMonth {
  const t0 = now();
  const { observer, zone, year, month, options } = input;
  const days = daysOfMonth(zone, year, month);
  const errors: string[] = [];
  const first = days[0]!;
  const last = days[days.length - 1]!;

  const inside = days.map((d) => covers(engine, d.jd_start, d.jd_end));
  if (!inside.some(Boolean)) throw new OutsideCoverageError(engine);
  const range = coverageRange(engine);

  let engineMs = 0;
  let e0 = now();
  let phases: PhaseEvent[] = [];
  try {
    phases = engine.moonPhases(
      Math.max(first.jd_start - MARGIN_DAYS, range?.start ?? -Infinity),
      Math.min(last.jd_end + MARGIN_DAYS, range?.end ?? Infinity),
    );
  } catch (error) {
    errors.push(`Moon phases: ${message(error)}`);
  }
  const sent = days.filter((_, i) => inside[i]);
  const answers = engine.dayEventsBatch(
    observer,
    sent.map((d) => [d.jd_start, d.jd_end] as [number, number]),
    ['Moon'],
    options,
  );
  let next = 0;
  const batch = days.map((_, i) => (inside[i] ? answers[next++] : undefined));
  engineMs += now() - e0;

  const inMonth = phases.filter((p) => p.jd_utc >= first.jd_start && p.jd_utc < last.jd_end);
  const out: MoonDay[] = days.map((day, i) => {
    const date: LocalDate = day.date;
    const noonJd = jdFromWallClock({ year: date.year, month: date.month, day: date.day, hour: 12 }, zone);
    e0 = now();
    let state = null;
    let stateError: string | null = null;
    try {
      if (!covers(engine, noonJd, noonJd)) throw new Error('outside the engine’s coverage');
      const sky = engine.skyState(observer, noonJd, ['Moon']);
      state = sky.bodies.find((b) => b.body === 'Moon') ?? null;
      if (!state) stateError = sky.errors[0]?.message ?? 'no result';
    } catch (error) {
      stateError = message(error);
    }
    engineMs += now() - e0;
    const res = batch[i];
    const moon = res?.bodies.find((b) => b.body === 'Moon') ?? null;
    const principal = inMonth.find((p) => sameDate(localDateOf(p.jd_utc, zone), date)) ?? null;
    const illuminated = state?.illuminated_fraction ?? null;
    const waxing = waxingAt(phases, noonJd);
    return {
      day,
      noonJd,
      illuminated,
      brightLimbDeg: state?.bright_limb_angle_deg ?? null,
      phaseAngleDeg: state?.phase_angle_deg ?? null,
      waxing,
      ageDays: moonAge(phases, noonJd),
      name: principal ? PHASE_NAMES[principal.kind] : phaseName(illuminated, waxing),
      principal,
      rises: (moon?.events ?? []).filter((e) => e.kind === 'rise').map((e) => e.jd_utc),
      sets: (moon?.events ?? []).filter((e) => e.kind === 'set').map((e) => e.jd_utc),
      alwaysAbove: moon?.always_above ?? false,
      alwaysBelow: moon?.always_below ?? false,
      error: stateError ?? (moon ? null : (res?.errors[0]?.message ?? 'no result')),
    };
  });
  const failed = out.filter((d) => d.error);
  if (failed.length) errors.push(`The Moon could not be computed on ${failed.length} of ${out.length} days: ${failed[0]!.error}`);

  return { input, days: out, events: inMonth, errors, timing: { engineMs, totalMs: now() - t0 } };
}

/**
 * The month as calendar rows of seven, `null` for the blank cells before the 1st and after
 * the last day. `firstWeekday` 0 = Sunday, 1 = Monday.
 */
export function monthGrid<T extends { readonly day: LocalDay }>(days: readonly T[], firstWeekday: number): (T | null)[][] {
  if (days.length === 0) return [];
  const d0 = days[0]!.day.date;
  const lead = (new Date(Date.UTC(d0.year, d0.month - 1, d0.day)).getUTCDay() - firstWeekday + 7) % 7;
  const cells: (T | null)[] = [...Array<null>(lead).fill(null), ...days];
  while (cells.length % 7) cells.push(null);
  const rows: (T | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7));
  return rows;
}
