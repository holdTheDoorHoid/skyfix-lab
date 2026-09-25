/**
 * Civil calendar arithmetic for the interface (CONVENTIONS 15.3). OWNER: time-ui agent.
 *
 * JavaScript's `Date` and `Intl` know only the proleptic Gregorian calendar, and
 * `Date.UTC` reads the years 0-99 as 1900-1999. The explorer shows dates as people wrote
 * them: the **Julian calendar before 1582-10-15** and the Gregorian from that day (the
 * default, `historical`), or the proleptic Gregorian calendar throughout (`iso`, a
 * setting). Years are astronomical in code (year 0 is 1 BC, -584 is 585 BC).
 *
 * Everything here is exact integer arithmetic on **day numbers**: the Julian Day Number
 * of a civil date, i.e. the JD at noon of that date (2 451 545 is 2000-01-01). The
 * conversions are the same as `skyfix_core::calendar` and the engine's `calendar_convert`
 * (Meeus, *Astronomical Algorithms*, ch. 7, in the integer form of the "days from
 * 1 March of year 0" method); `web/test/next/time-civil.test.ts` holds them to both.
 *
 * The display calendar is a module setting, like the 12- or 24-hour clock of
 * shell/format.ts: `setCalendarMode` is kept equal to `settings.calendar` by the shell
 * (time/services.ts). Functions that take no explicit calendar use it.
 */

import type { CalendarKind } from '../engine/types.js';

/** `historical`: Julian before 1582-10-15, Gregorian after. `iso`: proleptic Gregorian (ISO 8601). */
export type CalendarMode = 'historical' | 'iso';

export const MS_PER_DAY = 86_400_000;
/** Day number of 1970-01-01 (the Unix epoch's date). */
export const JDN_UNIX_EPOCH = 2_440_588;
/** Day number of 1582-10-15, the first Gregorian date (the day after Julian 1582-10-04). */
export const GREGORIAN_START_JDN = 2_299_161;
/** JD of 1582-10-15T00:00 on the app's clock. */
export const GREGORIAN_START_JD = 2_299_160.5;

const JDN_MARCH_0_GREGORIAN = 1_721_120;
const JDN_MARCH_0_JULIAN = 1_721_118;

/** A calendar date. `calendar` names the calendar the fields are in. */
export interface CivilDay {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  calendar: CalendarKind;
}

/** A date as typed or stepped: the calendar may be left to the display calendar. */
export interface DateFields {
  year: number;
  month: number;
  day: number;
  /** Named when the person chose it; otherwise the display calendar decides. */
  calendar?: CalendarKind;
}

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}

// ---------------------------------------------------------------------------------
// One calendar
// ---------------------------------------------------------------------------------

export function isLeapYear(calendar: CalendarKind, year: number): boolean {
  if (calendar === 'julian') return mod(year, 4) === 0;
  return mod(year, 4) === 0 && (mod(year, 100) !== 0 || mod(year, 400) === 0);
}

/** Days in a month of one calendar (28-31). `month` outside 1-12 is normalised first. */
export function daysInMonthOf(calendar: CalendarKind, year: number, month: number): number {
  const y = year + floorDiv(month - 1, 12);
  const m = mod(month - 1, 12) + 1;
  if (m === 2) return isLeapYear(calendar, y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/**
 * Day number of a date in one calendar. `month` may lie outside 1-12 and `day` outside
 * the month (day 0 is the last day of the month before, day 32 of January is 1 February):
 * both overflow linearly.
 */
export function jdnFromCivil(calendar: CalendarKind, year: number, month: number, day: number): number {
  const yy = year + floorDiv(month - 1, 12);
  const mm = mod(month - 1, 12) + 1;
  const y = mm <= 2 ? yy - 1 : yy;
  const mp = mod(mm + 9, 12);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  if (calendar === 'gregorian') {
    const era = floorDiv(y, 400);
    const yoe = y - era * 400;
    return era * 146_097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy + JDN_MARCH_0_GREGORIAN;
  }
  const era = floorDiv(y, 4);
  const yoe = y - era * 4;
  return era * 1_461 + yoe * 365 + doy + JDN_MARCH_0_JULIAN;
}

/** The date of a day number in one calendar. */
export function civilFromJdn(calendar: CalendarKind, jdn: number): CivilDay {
  let y: number;
  let doy: number;
  if (calendar === 'gregorian') {
    const z = jdn - JDN_MARCH_0_GREGORIAN;
    const era = floorDiv(z, 146_097);
    const doe = z - era * 146_097;
    const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    y = yoe + era * 400;
    doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  } else {
    const z = jdn - JDN_MARCH_0_JULIAN;
    const era = floorDiv(z, 1_461);
    const doe = z - era * 1_461;
    const yoe = Math.floor((doe - Math.floor(doe / 1_460)) / 365);
    y = yoe + era * 4;
    doy = doe - 365 * yoe;
  }
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return { year: month <= 2 ? y + 1 : y, month, day, calendar };
}

/** Day of the week of a day number: 0 Sunday … 6 Saturday. Calendars agree on it. */
export function weekdayOfJdn(jdn: number): number {
  return mod(jdn + 1, 7);
}

// ---------------------------------------------------------------------------------
// The display calendar
// ---------------------------------------------------------------------------------

let mode: CalendarMode = 'historical';

/** The calendar dates are shown and typed in (the shell keeps it equal to `settings.calendar`). */
export function setCalendarMode(next: CalendarMode): void {
  mode = next === 'iso' ? 'iso' : 'historical';
}

export function calendarMode(): CalendarMode {
  return mode;
}

/** The calendar a day is shown in: Julian before 1582-10-15 in the historical mode. */
export function calendarOfJdn(jdn: number, m: CalendarMode = mode): CalendarKind {
  return m === 'historical' && jdn < GREGORIAN_START_JDN ? 'julian' : 'gregorian';
}

/** The date of a day number in the display calendar. */
export function dateFromJdn(jdn: number, m: CalendarMode = mode): CivilDay {
  return civilFromJdn(calendarOfJdn(jdn, m), jdn);
}

/**
 * True for 1582-10-05 … 1582-10-14 in the historical calendar: dates neither calendar
 * had (Thursday 4 October 1582, Julian, was followed by Friday 15 October, Gregorian).
 * A typed date there is refused unless its calendar is named (CONVENTIONS 15.3).
 */
export function isGapDate(date: DateFields, m: CalendarMode = mode): boolean {
  if (date.calendar || m !== 'historical') return false;
  const j = jdnFromCivil('julian', date.year, date.month, date.day);
  const g = jdnFromCivil('gregorian', date.year, date.month, date.day);
  return j >= GREGORIAN_START_JDN && g < GREGORIAN_START_JDN;
}

/**
 * Day number of a date. A named calendar is used as named. Otherwise, in the historical
 * mode, a date that is Julian and before the reform is read as Julian and one that is
 * Gregorian and on or after it as Gregorian; the ten skipped dates (`isGapDate`) continue
 * the Julian count (1582-10-05 is the day after 1582-10-04, which the calendar called the
 * 15th), so a date stepped forward by overflowing its day field lands right. Overflowing
 * day fields count linearly from the month named, as `jdnFromCivil` does.
 */
export function jdnFromDate(date: DateFields, m: CalendarMode = mode): number {
  if (date.calendar) return jdnFromCivil(date.calendar, date.year, date.month, date.day);
  if (m === 'iso') return jdnFromCivil('gregorian', date.year, date.month, date.day);
  const j = jdnFromCivil('julian', date.year, date.month, date.day);
  if (j < GREGORIAN_START_JDN) return j;
  const g = jdnFromCivil('gregorian', date.year, date.month, date.day);
  return g >= GREGORIAN_START_JDN ? g : j;
}

/** True when the fields name a real date of the display calendar (or of the calendar named). */
export function isValidDate(date: DateFields, m: CalendarMode = mode): boolean {
  if (![date.year, date.month, date.day].every(Number.isInteger)) return false;
  if (date.month < 1 || date.month > 12 || date.day < 1) return false;
  if (date.calendar) return date.day <= daysInMonthOf(date.calendar, date.year, date.month);
  if (isGapDate(date, m)) return false;
  const back = dateFromJdn(jdnFromDate(date, m), m);
  return back.year === date.year && back.month === date.month && back.day === date.day;
}

/** A date moved by whole days in the display calendar (across the 1582 reform too). */
export function addDaysToDate(date: DateFields, days: number, m: CalendarMode = mode): CivilDay {
  return dateFromJdn(jdnFromDate(date, m) + days, m);
}

/** First and last day numbers of a month in the display calendar (October 1582 has 21 days). */
export function monthSpan(year: number, month: number, m: CalendarMode = mode): [number, number] {
  const first = jdnFromDate({ year, month, day: 1 }, m);
  const next = jdnFromDate({ year, month: month + 1, day: 1 }, m);
  return [first, next - 1];
}

/** How many days a month has in the display calendar. */
export function monthLength(year: number, month: number, m: CalendarMode = mode): number {
  const [a, b] = monthSpan(year, month, m);
  return b - a + 1;
}

/**
 * The largest day number a month's dates reach in the display calendar (31 for October
 * 1582, although it had 21 days): what a date is clamped to when a month is stepped.
 */
export function lastDayOfMonth(year: number, month: number, m: CalendarMode = mode): number {
  const [, last] = monthSpan(year, month, m);
  return dateFromJdn(last, m).day;
}

/** How many days a year has in the display calendar (355 for 1582 in the historical one). */
export function yearLength(year: number, m: CalendarMode = mode): number {
  return jdnFromDate({ year: year + 1, month: 1, day: 1 }, m) - jdnFromDate({ year, month: 1, day: 1 }, m);
}

/** Day of the year, 0 for 1 January, in the display calendar. */
export function dayOfYear(date: DateFields, m: CalendarMode = mode): number {
  return jdnFromDate(date, m) - jdnFromDate({ year: date.year, month: 1, day: 1 }, m);
}

/** 0 Sunday … 6 Saturday. */
export function weekdayOf(date: DateFields, m: CalendarMode = mode): number {
  return weekdayOfJdn(jdnFromDate(date, m));
}

/**
 * A date stepped by whole months and years in the display calendar, its day clamped to the
 * new month (31 January + 1 month is 28 or 29 February; 29 February 1500 + 1 year, both
 * Julian, is 28 February 1501). A date that lands in the ten days the 1582 reform skipped
 * moves to the nearest real one in the direction of the step: 15 October stepping
 * forward, 4 October stepping back.
 */
export function addMonthsToDate(date: DateFields, months: number, m: CalendarMode = mode): CivilDay {
  const index = date.month - 1 + months;
  const year = date.year + floorDiv(index, 12);
  const month = mod(index, 12) + 1;
  const day = Math.min(date.day, lastDayOfMonth(year, month, m));
  if (isGapDate({ year, month, day }, m)) {
    return months < 0 ? civilFromJdn('julian', GREGORIAN_START_JDN - 1) : civilFromJdn('gregorian', GREGORIAN_START_JDN);
  }
  return dateFromJdn(jdnFromDate({ year, month, day }, m), m);
}

// ---------------------------------------------------------------------------------
// Milliseconds on a clock <-> civil dates
// ---------------------------------------------------------------------------------

/** The day number of the date a clock reading falls on (`ms` = Unix ms plus the zone offset). */
export function jdnFromLocalMs(localMs: number): number {
  return Math.floor(localMs / MS_PER_DAY) + JDN_UNIX_EPOCH;
}

/** Milliseconds (on a clock) at the start of a day number. */
export function localMsFromJdn(jdn: number): number {
  return (jdn - JDN_UNIX_EPOCH) * MS_PER_DAY;
}

/** Milliseconds (on a clock) at the start of a date in the display calendar. */
export function localMsOfDate(date: DateFields, m: CalendarMode = mode): number {
  return localMsFromJdn(jdnFromDate(date, m));
}

/**
 * Proleptic Gregorian milliseconds for civil fields, as `Date.UTC` should be: no 1900s
 * mapping for the years 0-99, any year, fields may overflow. For the wire format and for
 * reading `Intl`, which are Gregorian whatever the display calendar.
 */
export function gregorianMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  return localMsFromJdn(jdnFromCivil('gregorian', year, month, day)) + ((hour * 60 + minute) * 60 + second) * 1000 + millisecond;
}

/** The proleptic Gregorian date of a clock reading (`Intl`'s calendar). */
export function gregorianDateOfMs(localMs: number): CivilDay {
  return civilFromJdn('gregorian', jdnFromLocalMs(localMs));
}

// ---------------------------------------------------------------------------------
// Years and eras
// ---------------------------------------------------------------------------------

/** 585 BC is era year 585 BC and astronomical year -584; year 0 is 1 BC. */
export function eraOfYear(year: number): { eraYear: number; era: 'BC' | 'AD' } {
  return year >= 1 ? { eraYear: year, era: 'AD' } : { eraYear: 1 - year, era: 'BC' };
}

/** The astronomical year of an era year: 585 BC is -584, AD 1066 is 1066. */
export function yearFromEra(eraYear: number, era: 'BC' | 'AD'): number {
  return era === 'BC' ? 1 - eraYear : eraYear;
}
