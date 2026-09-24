/**
 * Calendar windows for the charts: local days, months, years and nights in the display
 * zone, as the `[jd_start, jd_end)` Julian-date windows the engine takes. OWNER: charts
 * agent.
 *
 * Days run from local midnight to the next local midnight (`geo/timezone.ts`), so a day on
 * which the clocks change is 23 or 25 hours long. Nights run from local noon to the next
 * local noon, so one night is never split by the calendar.
 *
 * Wall-clock positions (`wallHours`, `hoursAfterNoon`) are what the charts plot on a time
 * of day axis: the clock reading, not the elapsed time. On the day the clocks go forward
 * sunrise really does jump an hour later, and the charts show that jump rather than
 * smoothing it away.
 *
 * Everything here is presentation: which instants to ask the engine about, and where to
 * draw what it answered. No astronomy.
 */

import { jdFromUnixMs } from '../engine/types.js';
import { addDays, startOfLocalDay, type DisplayZone, type LocalDate } from '../geo/timezone.js';
import { jdFromWallClock, msFromJd, wallClock, zoneOffsetMs, type Zone } from '../time.js';

export type { LocalDate } from '../geo/timezone.js';

export const MS_PER_HOUR = 3_600_000;

/** A local calendar day as an engine window. */
export interface LocalDay {
  readonly date: LocalDate;
  /** `2026-09-24` */
  readonly key: string;
  /** Local midnight, and the next local midnight: `[jd_start, jd_end)`. */
  readonly jd_start: number;
  readonly jd_end: number;
  /** 24, or 23 / 25 on the days the clocks change. */
  readonly hours: number;
  /** Zone offset (local − UTC) at the start of the day and just before its end, ms. */
  readonly offsetStartMs: number;
  readonly offsetEndMs: number;
}

/**
 * The same zone in the form `geo/timezone.ts` takes. `null` for a fixed offset that is
 * neither UTC nor a whole-hour nautical zone (the store never makes one).
 */
export function toDisplayZone(zone: Zone): DisplayZone | null {
  if (zone.kind === 'iana') return { kind: 'iana', id: zone.zone };
  if (zone.offsetMs === 0) return { kind: 'utc' };
  const zd = -zone.offsetMs / MS_PER_HOUR;
  if (Number.isInteger(zd) && Math.abs(zd) <= 12) return { kind: 'nautical', zd };
  return null;
}

/** A stable memo key for a zone. */
export function zoneKey(zone: Zone): string {
  return zone.kind === 'iana' ? zone.zone : `fixed:${zone.offsetMs}:${zone.name}`;
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `2026-09-24` */
export function dateKey(d: LocalDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

export function sameDate(a: LocalDate, b: LocalDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** The local calendar date of an instant in `zone`. */
export function localDateOf(jd: number, zone: Zone): LocalDate {
  const w = wallClock(jd, zone);
  return { year: w.year, month: w.month, day: w.day };
}

/** First instant of a local date, as a JS timestamp (see `startOfLocalDay`). */
function startMs(zone: Zone, dz: DisplayZone | null, date: LocalDate): number {
  if (dz) return startOfLocalDay(dz, date);
  return msFromJd(jdFromWallClock({ year: date.year, month: date.month, day: date.day }, zone));
}

/**
 * Consecutive local days from `first`, `count` of them. Each day's end is the next day's
 * start, so the windows tile time exactly.
 *
 * Cheap: a day's midnight is guessed from the previous day's offset and confirmed with one
 * zone lookup; only where the offset differs (a clock change during the previous day, or
 * at midnight) is the exact search of `geo/timezone.ts` used. A year costs about 370 zone
 * lookups instead of about 1 800.
 */
export function localDays(zone: Zone, first: LocalDate, count: number): LocalDay[] {
  const dz = toDisplayZone(zone);
  const dates: LocalDate[] = [];
  const starts: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i <= count; i += 1) {
    const date = addDays(first, i);
    dates.push(date);
    if (i === 0) {
      const ms = startMs(zone, dz, date);
      starts.push(ms);
      offsets.push(zoneOffsetMs(ms, zone));
      continue;
    }
    const prevOffset = offsets[i - 1]!;
    const guess = Date.UTC(date.year, date.month - 1, date.day) - prevOffset;
    const offset = zoneOffsetMs(guess, zone);
    if (offset === prevOffset) {
      starts.push(guess);
      offsets.push(offset);
    } else {
      const ms = startMs(zone, dz, date);
      starts.push(ms);
      offsets.push(zoneOffsetMs(ms, zone));
    }
  }
  const out: LocalDay[] = [];
  for (let i = 0; i < count; i += 1) {
    const ms0 = starts[i]!;
    const ms1 = starts[i + 1]!;
    const date = dates[i]!;
    const offsetStartMs = offsets[i]!;
    out.push({
      date,
      key: dateKey(date),
      jd_start: jdFromUnixMs(ms0),
      jd_end: jdFromUnixMs(ms1),
      hours: (ms1 - ms0) / MS_PER_HOUR,
      offsetStartMs,
      // Unchanged from this midnight to the next, the offset held all day.
      offsetEndMs: offsets[i + 1] === offsetStartMs ? offsetStartMs : zoneOffsetMs(ms1 - 1, zone),
    });
  }
  return out;
}

export function localDay(zone: Zone, date: LocalDate): LocalDay {
  return localDays(zone, date, 1)[0]!;
}

/** The local day containing `jd`. */
export function localDayAt(jd: number, zone: Zone): LocalDay {
  return localDay(zone, localDateOf(jd, zone));
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 30;
}

/** A small cache of window lists: they depend only on the zone and the calendar, and cost Intl calls. */
const windowCache = new Map<string, readonly LocalDay[]>();
const WINDOW_CACHE_SIZE = 24;

function cachedDays(key: string, make: () => LocalDay[]): readonly LocalDay[] {
  const hit = windowCache.get(key);
  if (hit) {
    windowCache.delete(key);
    windowCache.set(key, hit);
    return hit;
  }
  const value = Object.freeze(make());
  windowCache.set(key, value);
  while (windowCache.size > WINDOW_CACHE_SIZE) windowCache.delete(windowCache.keys().next().value as string);
  return value;
}

/** Every local day of a calendar year (365 or 366 windows: within `day_events_batch`'s 400). */
export function daysOfYear(zone: Zone, year: number): readonly LocalDay[] {
  return cachedDays(`y|${zoneKey(zone)}|${year}`, () =>
    localDays(zone, { year, month: 1, day: 1 }, isLeapYear(year) ? 366 : 365),
  );
}

/** Every local day of a calendar month. */
export function daysOfMonth(zone: Zone, year: number, month: number): readonly LocalDay[] {
  return cachedDays(`m|${zoneKey(zone)}|${year}|${month}`, () =>
    localDays(zone, { year, month, day: 1 }, daysInMonth(year, month)),
  );
}

/** Day of the year, 0 for 1 January. */
export function dayOfYear(date: LocalDate): number {
  return Math.round((Date.UTC(date.year, date.month - 1, date.day) - Date.UTC(date.year, 0, 1)) / 86_400_000);
}

/** True when the zone offset changes during the day (a clock change). */
export function hasClockChange(day: LocalDay): boolean {
  return day.offsetStartMs !== day.offsetEndMs;
}

/**
 * Where an instant falls on the day's wall clock: hours since local midnight as the clock
 * reads them. 0 at the start of the day, 24 at its end, whatever the day's length; on a
 * clock-change day the value jumps with the clock.
 */
export function wallHours(day: LocalDay, jd: number, zone: Zone): number {
  const elapsed = (jd - day.jd_start) * 24;
  if (!hasClockChange(day)) return elapsed;
  return elapsed + (zoneOffsetMs(msFromJd(jd), zone) - day.offsetStartMs) / MS_PER_HOUR;
}

// ---------------------------------------------------------------------------------------
// Clock changes

export interface ClockChange {
  /** The day it happens on. */
  readonly day: LocalDay;
  /** The instant, to the second. */
  readonly jd: number;
  readonly fromOffsetMs: number;
  readonly toOffsetMs: number;
}

/**
 * The instant within `day` when the zone offset changes, found by bisection on the zone
 * rules (to 1 s), or `null` when it does not change that day. A change exactly at the
 * day's first instant counts too (Chile changes at midnight): give the offset just before
 * the day began as `prevOffsetMs` when it is known, or it is looked up.
 */
export function clockChangeIn(day: LocalDay, zone: Zone, prevOffsetMs?: number): ClockChange | null {
  const before = prevOffsetMs ?? zoneOffsetMs(msFromJd(day.jd_start) - 1, zone);
  if (before !== day.offsetStartMs) {
    return { day, jd: day.jd_start, fromOffsetMs: before, toOffsetMs: day.offsetStartMs };
  }
  return clockChangeWithin(day, zone);
}

function clockChangeWithin(day: LocalDay, zone: Zone): ClockChange | null {
  if (!hasClockChange(day)) return null;
  let lo = msFromJd(day.jd_start);
  let hi = msFromJd(day.jd_end) - 1;
  const before = day.offsetStartMs;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (zoneOffsetMs(mid, zone) === before) lo = mid;
    else hi = mid;
  }
  // Offsets change on whole seconds, and (lo, hi] is at most a second long: the change is
  // the first whole second after lo.
  const at = Math.floor(lo / 1000) * 1000 + 1000;
  return { day, jd: jdFromUnixMs(at), fromOffsetMs: before, toOffsetMs: zoneOffsetMs(at, zone) };
}

// ---------------------------------------------------------------------------------------
// Nights: local noon to the next local noon

export interface LocalNight {
  /** The evening's date: the night of 24 September runs into the morning of the 25th. */
  readonly date: LocalDate;
  readonly key: string;
  /** Local noon on `date` and on the next day. */
  readonly jd_start: number;
  readonly jd_end: number;
  readonly offsetStartMs: number;
  readonly offsetEndMs: number;
}

/** Consecutive nights from the evening of `first`. */
export function localNights(zone: Zone, first: LocalDate, count: number): LocalNight[] {
  return nightsFromDays(localDays(zone, first, count + 1), zone);
}

/** Local noon of a day: twelve hours after midnight unless the clocks change that day. */
function noonOf(day: LocalDay, zone: Zone): number {
  if (!hasClockChange(day)) return day.jd_start + 0.5;
  const d = day.date;
  return jdFromWallClock({ year: d.year, month: d.month, day: d.day, hour: 12 }, zone);
}

/**
 * The nights of consecutive local days: one fewer than the days (each night ends on the
 * next day's noon). Days without a clock change need no zone lookups at all.
 */
export function nightsFromDays(days: readonly LocalDay[], zone: Zone): LocalNight[] {
  const out: LocalNight[] = [];
  for (let i = 0; i + 1 < days.length; i += 1) {
    const day = days[i]!;
    const next = days[i + 1]!;
    const jd0 = noonOf(day, zone);
    const jd1 = noonOf(next, zone);
    out.push({
      date: day.date,
      key: day.key,
      jd_start: jd0,
      jd_end: jd1,
      offsetStartMs: hasClockChange(day) ? zoneOffsetMs(msFromJd(jd0), zone) : day.offsetStartMs,
      offsetEndMs: hasClockChange(next) ? zoneOffsetMs(msFromJd(jd1) - 1, zone) : next.offsetStartMs,
    });
  }
  return out;
}

/**
 * Where an instant falls in a night, as the clock reads it: hours after the evening's
 * local noon (6 is 18:00, 12 is midnight, 18 is 06:00 the next morning).
 */
export function hoursAfterNoon(night: LocalNight, jd: number, zone: Zone): number {
  const elapsed = (jd - night.jd_start) * 24;
  if (night.offsetStartMs === night.offsetEndMs) return elapsed;
  return elapsed + (zoneOffsetMs(msFromJd(jd), zone) - night.offsetStartMs) / MS_PER_HOUR;
}

/** The night (by its evening's date) that contains `jd`: before local noon it is the previous one. */
export function nightDateOf(jd: number, zone: Zone): LocalDate {
  const w = wallClock(jd, zone);
  const date = { year: w.year, month: w.month, day: w.day };
  return w.hour < 12 ? addDays(date, -1) : date;
}

/**
 * The instant a wall-clock time falls on: `date` plus `hours` on the clock (hours may run
 * past 24 into the next day). Gaps and overlaps resolve as `jdFromWallClock` does.
 */
export function jdAtWallHours(date: LocalDate, hours: number, zone: Zone): number {
  const totalMinutes = Math.round(hours * 60);
  return jdFromWallClock(
    { year: date.year, month: date.month, day: date.day, hour: 0, minute: totalMinutes },
    zone,
  );
}

// ---------------------------------------------------------------------------------------
// Intervals

export type Interval = readonly [number, number];

/** The overlap of two sorted lists of disjoint intervals. */
export function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const [a0, a1] = a[i]!;
    const [b0, b1] = b[j]!;
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (hi > lo) out.push([lo, hi]);
    if (a1 < b1) i += 1;
    else j += 1;
  }
  return out;
}

/** Merge intervals that touch or overlap (input in any order). */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].filter(([s, e]) => e > s).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Total length of disjoint intervals. */
export function intervalsLength(list: readonly Interval[]): number {
  let total = 0;
  for (const [s, e] of list) total += e - s;
  return total;
}
