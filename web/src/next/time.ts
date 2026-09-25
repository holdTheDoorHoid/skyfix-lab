/**
 * Time for the explorer: Julian Date <-> JS time, stepping by calendar units in a time
 * zone, and display formatting that can always show UTC beside local time. OWNER:
 * time-ui agent (from the shell-design agent's first version).
 *
 * The engine works only on its clock (`jd_utc`, EXPLORER_API "Common rules"): UTC from 1972
 * to 2035 and UT outside (CONVENTIONS 15.2). Everything here is presentation: which wall
 * clock to show, and what "one day later" means on it. Zones follow CONVENTIONS 13.8 and
 * 15.3: an IANA zone (through the browser's `Intl`), the nautical zone time for a
 * longitude, local mean time (LMT) for a longitude, or UTC. Before 1850 a zone that
 * follows the place is local mean time: civil zones did not exist.
 *
 * Wall clocks are in the **display calendar** (time/civil.ts): the Julian calendar before
 * 1582-10-15 and the Gregorian after it, or the proleptic Gregorian throughout when the
 * person chose ISO in Settings. `Intl` and the wire format are proleptic Gregorian; the
 * conversion between them is done here, in exact integer arithmetic, never with `Date.UTC`
 * (which reads the years 0-99 as 1900-1999).
 *
 * Arithmetic is done on whole milliseconds: a `jd_utc` is converted to a rounded Unix
 * millisecond count, stepped, and converted back, so repeated steps never accumulate
 * floating-point drift.
 */

import type { CalendarKind } from './engine/types.js';
import { jdFromUnixMs, unixMsFromJd } from './engine/types.js';
import {
  addDaysToDate,
  addMonthsToDate,
  civilFromJdn,
  daysInMonthOf,
  dateFromJdn,
  gregorianMs,
  isLeapYear as isLeapYearOf,
  jdnFromDate,
  jdnFromLocalMs,
  JDN_UNIX_EPOCH,
  localMsFromJdn,
  monthSpan,
  weekdayOfJdn,
  type CivilDay,
} from './time/civil.js';
import { lmtByDefault, lmtOffsetMs, scaleLabel } from './time/scale.js';

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * What the user chose for a place (stored with the observer, never persisted).
 * `guessed: false` means the person chose the zone: it stays when the place moves
 * (`zonePinned` in state.ts). `guessed: true`, or no flag (a zone that came with a place),
 * means it follows the place: it is guessed again whenever the place moves, and before
 * 1850 it is local mean time at the place's longitude (`resolveZone`, CONVENTIONS 15.3).
 * UTC is always the person's choice.
 */
export type ZoneChoice =
  | { kind: 'iana'; zone: string; guessed?: boolean }
  | { kind: 'nautical'; guessed?: boolean }
  | { kind: 'utc' };

/** A zone ready for arithmetic: an IANA zone, or a fixed offset from UTC. */
export type Zone = { kind: 'iana'; zone: string } | { kind: 'fixed'; offsetMs: number; name: string };

export const UTC_ZONE: Zone = { kind: 'fixed', offsetMs: 0, name: 'UTC' };

/** The name of the local-mean-time zone (`resolveZone`). */
export const LMT_NAME = 'LMT';

/** Wall-clock fields in a zone. `month` is 1-12, `weekday` 0 = Sunday. */
export interface WallClock {
  /** Astronomical year (0 = 1 BC), in `calendar`. */
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
  /** Local time minus UTC, milliseconds (UTC-4 is -14 400 000). */
  offsetMs: number;
  /** The calendar the date is in: the display calendar's for this day (time/civil.ts). */
  calendar: CalendarKind;
}

/** The date-and-time part of a wall clock, as accepted by `jdFromWallClock`. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
  /** The calendar of the date; absent: the display calendar decides (time/civil.ts `jdnFromDate`). */
  calendar?: CalendarKind;
}

// ---------------------------------------------------------------------------
// Julian Date <-> JS time
// ---------------------------------------------------------------------------

/** Unix milliseconds of a `jd_utc`, rounded to the millisecond. */
export function msFromJd(jd: number): number {
  return Math.round(unixMsFromJd(jd));
}

export function jdFromMs(ms: number): number {
  return jdFromUnixMs(ms);
}

export function jdFromDate(date: Date): number {
  return jdFromUnixMs(date.getTime());
}

export function dateFromJd(jd: number): Date {
  return new Date(msFromJd(jd));
}

/** The current instant as a `jd_utc`. */
export function jdNow(nowMs: number = Date.now()): number {
  return jdFromUnixMs(nowMs);
}

function pad(n: number, width = 2): string {
  const s = String(Math.abs(n)).padStart(width, '0');
  return n < 0 ? `-${s}` : s;
}

/**
 * A year as the wire writes it (EXPLORER_API "Dates and years on the wire"): four digits
 * for 0000-9999, otherwise a sign and at least four digits (`-0584`, `+12345`).
 */
export function isoYear(year: number): string {
  if (year >= 0 && year <= 9999) return String(year).padStart(4, '0');
  return year < 0 ? `-${String(-year).padStart(4, '0')}` : `+${year}`;
}

/**
 * RFC 3339 with milliseconds and a trailing `Z` (CONVENTIONS section 6), in the wire's
 * form: proleptic Gregorian, ISO expanded years outside 0000-9999 (`-0584-05-22T12:00:00.000Z`).
 * Throws a RangeError for a non-finite `jd`, as `Date.prototype.toISOString` does.
 */
export function isoUtc(jd: number): string {
  const ms = msFromJd(jd);
  if (!Number.isFinite(ms)) throw new RangeError(`Invalid time value: jd ${jd}`);
  const days = Math.floor(ms / MS_PER_DAY);
  const t = ms - days * MS_PER_DAY;
  const d = civilFromJdn('gregorian', days + JDN_UNIX_EPOCH);
  const hh = Math.floor(t / MS_PER_HOUR);
  const mm = Math.floor((t % MS_PER_HOUR) / MS_PER_MINUTE);
  const ss = Math.floor((t % MS_PER_MINUTE) / MS_PER_SECOND);
  return `${isoYear(d.year)}-${pad(d.month)}-${pad(d.day)}T${pad(hh)}:${pad(mm)}:${pad(ss)}.${String(t % 1000).padStart(3, '0')}Z`;
}

const RFC3339_Z = /^([+-]?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;

/**
 * Parse RFC 3339 UTC with a trailing `Z`, in the wire's proleptic Gregorian calendar, with
 * ISO expanded years (`-0584-05-22T12:00:00Z`, `+12345-01-01T00:00Z`). Anything else
 * (offsets, bad fields) is `null`.
 */
export function jdFromIso(text: string): number | null {
  const m = RFC3339_Z.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return jdFromUnixMs(utcMs(year, month, day, hour, minute, second, ms));
}

// ---------------------------------------------------------------------------
// Calendar helpers of the wire and of Intl (proleptic Gregorian)
// ---------------------------------------------------------------------------

/**
 * `Date.UTC` without its 0-99 => 1900-1999 year mapping: proleptic Gregorian, any year,
 * fields may overflow. For the wire and for `Intl`; dates on screen go through the display
 * calendar (`jdFromWallClock`).
 */
export function utcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  return gregorianMs(year, month, day, hour, minute, second, millisecond);
}

/** Proleptic Gregorian leap year (the wire's calendar). */
export function isLeapYear(year: number): boolean {
  return isLeapYearOf('gregorian', year);
}

/** Days in a month of the proleptic Gregorian calendar (the wire's calendar). */
export function daysInMonth(year: number, month: number): number {
  if (!Number.isInteger(month) || month < 1 || month > 12) return 30;
  return daysInMonthOf('gregorian', year, month);
}

function floorMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** True when the browser knows this IANA zone name. */
export function isValidIanaZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    partsFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone, or `UTC` if it cannot say. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Nautical zone description for a longitude (CONVENTIONS 13.8): `ZD = round(lon_east / -15)`,
 * so zone time + ZD = UTC. 75 W is ZD +5.
 */
export function nauticalZoneDescription(lonDeg: number): number {
  let lon = floorMod(lonDeg, 360);
  if (lon > 180) lon -= 360;
  const zd = Math.round(lon / -15);
  return zd === 0 ? 0 : zd; // no -0
}

/** Local mean time at a longitude: UT plus four minutes per degree east, to the second. */
export function lmtZone(lonDeg: number): Zone {
  return { kind: 'fixed', offsetMs: lmtOffsetMs(lonDeg), name: LMT_NAME };
}

/** True for the zone `lmtZone` makes. */
export function isLmtZone(zone: Zone): boolean {
  return zone.kind === 'fixed' && zone.name === LMT_NAME;
}

/** True for UTC itself (the "UTC first" display, or UTC chosen as the place's zone). */
export function isUtcZone(zone: Zone): boolean {
  return zone.kind === 'fixed' && zone.offsetMs === 0 && zone.name === 'UTC';
}

/**
 * True when a choice follows the place (the same rule as `zonePinned` in state.ts, which
 * cannot be imported here): anything but UTC and a zone marked `guessed: false`.
 */
export function followsPlace(choice: ZoneChoice): boolean {
  return choice.kind !== 'utc' && choice.guessed !== false;
}

/**
 * Turn a stored choice into a zone ready for arithmetic. An unknown IANA name falls back to
 * UTC. With `jd`, a zone that follows the place is local mean time before 1850 (CONVENTIONS
 * 15.3: civil zones did not exist); a zone the person chose stays as chosen.
 */
export function resolveZone(choice: ZoneChoice, lonDeg: number, jd?: number): Zone {
  if (jd !== undefined && Number.isFinite(jd) && lmtByDefault(jd) && followsPlace(choice)) return lmtZone(lonDeg);
  switch (choice.kind) {
    case 'iana':
      return isValidIanaZone(choice.zone) ? { kind: 'iana', zone: choice.zone } : UTC_ZONE;
    case 'nautical': {
      const zd = nauticalZoneDescription(lonDeg);
      return { kind: 'fixed', offsetMs: -zd * MS_PER_HOUR, name: `ZD ${formatSigned(zd)}` };
    }
    case 'utc':
      return UTC_ZONE;
  }
}

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/** Local minus UTC at an instant, milliseconds. */
export function zoneOffsetMs(ms: number, zone: Zone): number {
  if (zone.kind === 'fixed') return zone.offsetMs;
  // Asking Intl costs tens of microseconds and the time bar and panel ask many times a
  // frame. Between 1900 and 2100 every change of a zone's offset happens on a quarter
  // hour of UTC, so the offset is constant within each UTC quarter hour: remember it.
  const cacheable = ms >= CACHE_FROM_MS && ms < CACHE_TO_MS;
  const key = cacheable ? `${zone.zone}|${Math.floor(ms / QUARTER_HOUR_MS)}` : '';
  if (cacheable) {
    const hit = offsetCache.get(key);
    if (hit !== undefined) return hit;
  }
  const base = ms - floorMod(ms, 1000); // whole second; no zone offset has a fraction of one
  const w = ianaParts(base, zone.zone);
  const offset = utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second) - base;
  if (cacheable) {
    if (offsetCache.size >= OFFSET_CACHE_MAX) offsetCache.clear();
    offsetCache.set(key, offset);
  }
  return offset;
}

const QUARTER_HOUR_MS = 15 * MS_PER_MINUTE;
/** 1900-01-01 and 2100-01-01 UTC: outside, local mean times change offsets at odd seconds. */
const CACHE_FROM_MS = -2_208_988_800_000;
const CACHE_TO_MS = 4_102_444_800_000;
const OFFSET_CACHE_MAX = 20_000;
const offsetCache = new Map<string, number>();

/** Intl's reading of an instant in a zone: proleptic Gregorian, astronomical year (the era read). */
function ianaParts(
  ms: number,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const part of partsFormatter(zone).formatToParts(new Date(ms))) {
    switch (part.type) {
      case 'year':
        out.year = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'day':
        out.day = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24;
        break;
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'second':
        out.second = Number(part.value);
        break;
      case 'era':
        bc = /^b/i.test(part.value);
        break;
      default:
        break;
    }
  }
  if (bc) out.year = 1 - out.year;
  return out;
}

/** Wall-clock fields of an instant in a zone, the date in the display calendar. */
export function wallClockMs(ms: number, zone: Zone): WallClock {
  const offsetMs = zoneOffsetMs(ms, zone);
  const local = ms + offsetMs;
  const jdn = jdnFromLocalMs(local);
  const t = local - localMsFromJdn(jdn);
  const date = dateFromJdn(jdn);
  return {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: Math.floor(t / MS_PER_HOUR),
    minute: Math.floor((t % MS_PER_HOUR) / MS_PER_MINUTE),
    second: Math.floor((t % MS_PER_MINUTE) / MS_PER_SECOND),
    millisecond: t % MS_PER_SECOND,
    weekday: weekdayOfJdn(jdn),
    offsetMs,
    calendar: date.calendar,
  };
}

export function wallClock(jd: number, zone: Zone): WallClock {
  return wallClockMs(msFromJd(jd), zone);
}

/**
 * The instant a wall clock in `zone` shows `wall`. The date is in the display calendar
 * unless `wall.calendar` names one. Fields may overflow (day 32 is the 1st of the next
 * month, minute 90 is 01:30). Daylight-saving transitions are resolved the way `Temporal`
 * does by default ("compatible"): a time in a spring-forward gap moves forward by the
 * length of the gap (02:30 becomes 03:30); a repeated time in a fall-back overlap takes the
 * earlier of its two instants.
 */
export function msFromWallClock(wall: WallTime, zone: Zone): number {
  const jdn = jdnFromDate(wall);
  const local =
    localMsFromJdn(jdn) +
    (wall.hour ?? 0) * MS_PER_HOUR +
    (wall.minute ?? 0) * MS_PER_MINUTE +
    (wall.second ?? 0) * MS_PER_SECOND +
    (wall.millisecond ?? 0);
  if (zone.kind === 'fixed') return local - zone.offsetMs;
  const before = zoneOffsetMs(local - MS_PER_DAY, zone);
  const after = zoneOffsetMs(local + MS_PER_DAY, zone);
  const candidates = before === after ? [local - before] : [local - before, local - after];
  const valid = candidates.filter((t) => t + zoneOffsetMs(t, zone) === local);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the offset before the transition carries the wall time past it.
  return local - before;
}

export function jdFromWallClock(wall: WallTime, zone: Zone): number {
  return jdFromUnixMs(msFromWallClock(wall, zone));
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/** Add an exact duration (independent of any zone). */
export function addDuration(
  jd: number,
  d: { days?: number; hours?: number; minutes?: number; seconds?: number },
): number {
  const delta =
    (d.days ?? 0) * MS_PER_DAY +
    (d.hours ?? 0) * MS_PER_HOUR +
    (d.minutes ?? 0) * MS_PER_MINUTE +
    (d.seconds ?? 0) * MS_PER_SECOND;
  return jdFromUnixMs(msFromJd(jd) + Math.round(delta));
}

/**
 * Step by calendar units on the wall clock of `zone`, keeping the clock time. Years and
 * months are applied first and clamp the day (31 January + 1 month = 28 or 29 February),
 * then days. Across a daylight-saving change one day is 23 or 25 hours long. Dates are in
 * the display calendar: a year before 1582 steps through Julian dates, and one day after
 * 4 October 1582 is 15 October (time/civil.ts).
 */
export function addCalendar(
  jd: number,
  zone: Zone,
  step: { years?: number; months?: number; days?: number },
): number {
  const w = wallClock(jd, zone);
  let date: CivilDay = { year: w.year, month: w.month, day: w.day, calendar: w.calendar };
  const months = (step.months ?? 0) + 12 * (step.years ?? 0);
  if (months) date = addMonthsToDate(date, months);
  if (step.days) date = addDaysToDate(date, step.days);
  return jdFromWallClock(
    { ...date, hour: w.hour, minute: w.minute, second: w.second, millisecond: w.millisecond },
    zone,
  );
}

export type CalendarUnit = 'day' | 'month' | 'year';

/**
 * The calendar day, month or year containing `jd` on the wall clock of `zone`, as
 * `[jd_start, jd_end)` from local midnight to local midnight. This is the window the
 * explorer asks `day_events` for (EXPLORER_API, `day_events`). Months and years are those
 * of the display calendar (October 1582 has 21 days, 1582 has 355).
 */
export function periodWindow(jd: number, zone: Zone, unit: CalendarUnit = 'day'): [number, number] {
  const w = wallClock(jd, zone);
  const today = jdnFromDate({ year: w.year, month: w.month, day: w.day, calendar: w.calendar });
  let first: number;
  let next: number;
  if (unit === 'day') {
    first = today;
    next = today + 1;
  } else if (unit === 'month') {
    const [a, b] = monthSpan(w.year, w.month);
    first = a;
    next = b + 1;
  } else {
    first = jdnFromDate({ year: w.year, month: 1, day: 1 });
    next = jdnFromDate({ year: w.year + 1, month: 1, day: 1 });
  }
  const at = (jdn: number): number => jdFromWallClock(dateFromJdn(jdn), zone);
  return [at(first), at(next)];
}

/** The local calendar day containing `jd`: `[local midnight, next local midnight)`. */
export function dayWindow(jd: number, zone: Zone): [number, number] {
  return periodWindow(jd, zone, 'day');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/**
 * `UTC`, `UTC+1`, `UTC−4`, `UTC+5:30`, `UTC+12:45`, `UTC−4:56:02`. With `jd`, the scale's
 * own word: `UT−5:00:40` for an instant outside 1972-2035 (CONVENTIONS 15.2).
 */
export function formatOffset(offsetMs: number, jd?: number): string {
  const base = jd === undefined ? 'UTC' : scaleLabel(jd);
  if (offsetMs === 0) return base;
  const sign = offsetMs > 0 ? '+' : '−';
  const total = Math.round(Math.abs(offsetMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (s) return `${base}${sign}${h}:${pad(m)}:${pad(s)}`;
  return m ? `${base}${sign}${h}:${pad(m)}` : `${base}${sign}${h}`;
}

const abbrevFormatters = new Map<string, Intl.DateTimeFormat[]>();

/**
 * A letters-only abbreviation such as `EDT` or `CEST` when the browser has one for this
 * zone and instant; `null` otherwise (many zones only have `GMT+9`-style names). For a
 * fixed zone, its own name (`ZD +5`, `LMT`); for UTC itself, the scale's word (`UTC` inside
 * 1972-2035, `UT` outside).
 */
export function zoneAbbreviation(jd: number, zone: Zone): string | null {
  if (zone.kind === 'fixed') return isUtcZone(zone) ? scaleLabel(jd) : zone.name;
  // Remembered per zone, offset and year (time-ui agent): the time bar asks several times a
  // frame, and while time runs fast every frame is another quarter hour. Within a year a
  // zone's offset names one abbreviation (the rare exception, a rename at an unchanged
  // offset such as New York's EWT to EPT in August 1945, keeps the year's first).
  const ms = msFromJd(jd);
  const key = `${zone.zone}|${zoneOffsetMs(ms, zone)}|${Math.floor(ms / 31_556_952_000)}`;
  const hit = abbrevCache.get(key);
  if (hit !== undefined) return hit;
  let list = abbrevFormatters.get(zone.zone);
  if (!list) {
    list = ['en-US', 'en-GB'].map(
      (locale) => new Intl.DateTimeFormat(locale, { timeZone: zone.zone, timeZoneName: 'short' }),
    );
    abbrevFormatters.set(zone.zone, list);
  }
  const date = new Date(ms);
  let found: string | null = null;
  for (const f of list) {
    const name = f.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (/^[A-Z]{2,5}$/.test(name)) {
      found = name;
      break;
    }
  }
  if (abbrevCache.size >= OFFSET_CACHE_MAX) abbrevCache.clear();
  abbrevCache.set(key, found);
  return found;
}

const abbrevCache = new Map<string, string | null>();

/**
 * A human label for a zone at an instant: `America/New_York · EDT (UTC−4)`,
 * `ZD +5 (UTC−5)`, `LMT (UT−5:00:40)`, `UTC` (or `UT` outside 1972-2035).
 */
export function zoneLabel(jd: number, zone: Zone): string {
  if (zone.kind === 'fixed') {
    return isUtcZone(zone) ? scaleLabel(jd) : `${zone.name} (${formatOffset(zone.offsetMs, jd)})`;
  }
  const w = wallClock(jd, zone);
  const abbr = zoneAbbreviation(jd, zone);
  const offset = formatOffset(w.offsetMs, jd);
  return abbr ? `${zone.zone} · ${abbr} (${offset})` : `${zone.zone} (${offset})`;
}

/** Short name for use right after a time: `EDT`, `UTC−3`, `ZD +5`, `LMT`, `UTC` or `UT`. */
export function zoneShortName(jd: number, zone: Zone): string {
  return zoneAbbreviation(jd, zone) ?? formatOffset(zoneOffsetMs(msFromJd(jd), zone), jd);
}

export interface TimeFormat {
  /** Show seconds. Default false. */
  seconds?: boolean;
}

/**
 * `08:05` or `08:05:09` on the wall clock of `zone`, rounded to the nearest minute or
 * second (`roundTo`).
 */
export function formatTime(jd: number, zone: Zone, options: TimeFormat = {}): string {
  return clockText(wallClock(roundTo(jd, options), zone), options);
}

/**
 * `jd` moved to the nearest whole minute. Times shown without seconds are rounded this
 * way, as the printed almanac rounds them (06:49:31 shows as 06:50, 06:49:29 as 06:49).
 */
export function roundToMinute(jd: number): number {
  return jdFromUnixMs(Math.round(msFromJd(jd) / MS_PER_MINUTE) * MS_PER_MINUTE);
}

/**
 * `jd` moved to the nearest whole second: the same rule for times shown with seconds
 * (an eclipse contact at 18:40:42.98 shows as 18:40:43, as the command-line tool prints it;
 * 23:59:59.6 is the next day's 00:00:00).
 */
export function roundToSecond(jd: number): number {
  return jdFromUnixMs(Math.round(msFromJd(jd) / MS_PER_SECOND) * MS_PER_SECOND);
}

/** The instant a time is shown at: to the nearest second with seconds, else the nearest minute. */
function roundTo(jd: number, options: TimeFormat): number {
  return options.seconds ? roundToSecond(jd) : roundToMinute(jd);
}

function clockText(w: WallClock, options: TimeFormat): string {
  const hm = `${pad(w.hour)}:${pad(w.minute)}`;
  return options.seconds ? `${hm}:${pad(w.second)}` : hm;
}

/**
 * `2026-09-24` on the wall clock of `zone` (ISO order: unambiguous in every locale), the
 * date in the display calendar, the year as the wire numbers it (`-0584-05-28`).
 */
export function formatDate(jd: number, zone: Zone): string {
  return dateText(wallClock(jd, zone));
}

function dateText(w: WallClock): string {
  return `${isoYear(w.year)}-${pad(w.month)}-${pad(w.day)}`;
}

/** `2026-09-24 08:05`, rounded to the nearest minute or second (the date too: 23:59:40 is the next day's 00:00). */
export function formatDateTime(jd: number, zone: Zone, options: TimeFormat = {}): string {
  const w = wallClock(roundTo(jd, options), zone);
  return `${dateText(w)} ${clockText(w, options)}`;
}

/**
 * Local time with UTC beside it, as CONVENTIONS 13.8 asks:
 * `2026-09-24 08:05 EDT · 12:05 UTC`, or with the UTC date when it differs:
 * `2026-09-24 20:05 EDT · 2026-09-25 00:05 UTC`. In UTC itself: `2026-09-24 12:05 UTC`.
 * Outside 1972-2035 the scale is UT and says so: `1800-01-01 07:00 LMT · 12:00 UT`.
 */
export function formatWithUtc(jd: number, zone: Zone, options: TimeFormat = {}): string {
  const t = roundTo(jd, options);
  const utc = wallClock(t, UTC_ZONE);
  const utcText = `${clockText(utc, options)} ${scaleLabel(t)}`;
  if (zone.kind === 'fixed' && zone.offsetMs === 0 && !isLmtZone(zone)) return `${dateText(utc)} ${utcText}`;
  const local = wallClock(t, zone);
  const localText = `${dateText(local)} ${clockText(local, options)} ${zoneShortName(t, zone)}`;
  const sameDate = local.year === utc.year && local.month === utc.month && local.day === utc.day;
  return sameDate ? `${localText} · ${utcText}` : `${localText} · ${dateText(utc)} ${utcText}`;
}

/** A duration in hours as `11 h 57 min`. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return String(hours);
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} h ${pad(m)} min` : `${m} min`;
}
