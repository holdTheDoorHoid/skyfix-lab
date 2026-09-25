/**
 * The calendar formatter (CONVENTIONS 15.3): years with their era, dates in the display
 * calendar with its name, and the words for the clock's scale. OWNER: time-ui agent.
 * Deterministic English, as the rest of the explorer; no `Intl` (which knows neither the
 * Julian calendar nor year 0).
 *
 * Years are astronomical in code (0 is 1 BC). How they are written is a setting
 * (`settings.yearStyle`, kept in step by the shell through `setYearStyle`):
 *
 * | style | 585 BC | 1 BC | AD 79 | 1066 | 2026 | 12345 |
 * |---|---|---|---|---|---|---|
 * | `era` (default) | 585 BC | 1 BC | AD 79 | 1066 | 2026 | 12345 |
 * | `astronomical` | −584 | 0 | 79 | 1066 | 2026 | 12345 |
 * | `iso` | -0584 | 0000 | 0079 | 1066 | 2026 | +12345 |
 *
 * "AD" is written out below the year 1000, where a bare number reads like a shortened
 * year, and on request (`era: 'always'`: "AD 1066" beside a BC date or in the year field).
 */

import type { CalendarKind } from '../engine/types.js';
import { isoYear, wallClock, type Zone } from '../time.js';
import { calendarMode, eraOfYear, GREGORIAN_START_JDN, jdnFromDate, weekdayOfJdn, type CalendarMode, type DateFields } from './civil.js';

export type YearStyle = 'era' | 'astronomical' | 'iso';

export const YEAR_STYLES: readonly YearStyle[] = ['era', 'astronomical', 'iso'];

let style: YearStyle = 'era';

/** How years are written (the shell keeps it equal to `settings.yearStyle`). */
export function setYearStyle(next: YearStyle): void {
  style = YEAR_STYLES.includes(next) ? next : 'era';
}

export function yearStyle(): YearStyle {
  return style;
}

export const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MINUS = '−';

// ---------------------------------------------------------------------------------
// Years
// ---------------------------------------------------------------------------------

export interface YearOptions {
  /** `always`: write "AD" on every year after 1 BC (the era style only). Default `auto`. */
  era?: 'auto' | 'always';
}

/**
 * A year as the settings write it: `585 BC`, `AD 79`, `2026` (era); `−584` (astronomical);
 * `-0584` (ISO 8601 expanded years). `year` is astronomical.
 */
export function formatYear(year: number, s: YearStyle = style, options: YearOptions = {}): string {
  if (!Number.isFinite(year)) return '—';
  switch (s) {
    case 'astronomical':
      return year < 0 ? `${MINUS}${-year}` : String(year);
    case 'iso':
      return isoYear(year);
    case 'era': {
      const { eraYear, era } = eraOfYear(year);
      if (era === 'BC') return `${eraYear} BC`;
      return options.era === 'always' || year < 1000 ? `AD ${year}` : String(year);
    }
  }
}

/**
 * Every way of writing a year, for a tooltip: "585 BC: astronomical year −584, ISO 8601
 * -0584". A year from 1000 to 9999 is written the same every way, so it is just "2026".
 */
export function yearForms(year: number): string {
  if (year >= 1000 && year <= 9999) return String(year);
  const era = formatYear(year, 'era', { era: 'always' });
  return `${era}: astronomical year ${formatYear(year, 'astronomical')}, ISO 8601 ${formatYear(year, 'iso')}`;
}

/**
 * A year typed by a person: `585 BC`, `585 BCE`, `AD 1066`, `1066 AD`, `CE 1066`, `-584`,
 * `−584`, `-0584`, `+12345`, or a bare number (in `defaultEra`, AD unless the BC switch is
 * on). Astronomical, or null for anything else. Years beyond ±99 999 are refused.
 */
export function parseYear(text: string, defaultEra: 'AD' | 'BC' = 'AD'): number | null {
  const t = text.trim().replace(/\s+/g, ' ').replace(/([A-Za-z])\./g, '$1').toUpperCase().replace(MINUS, '-');
  let m: RegExpExecArray | null;
  let year: number;
  if ((m = /^(?:AD|CE) ?(\d{1,5})$/.exec(t)) || (m = /^(\d{1,5}) ?(?:AD|CE)$/.exec(t))) {
    // There is no year 0 AD (or 0 BC): the era count starts at 1.
    if (Number(m[1]) < 1) return null;
    year = Number(m[1]);
  } else if ((m = /^(\d{1,5}) ?(?:BC|BCE)$/.exec(t))) {
    if (Number(m[1]) < 1) return null;
    year = 1 - Number(m[1]);
  } else if ((m = /^([+-])(\d{1,6})$/.exec(t))) {
    // A signed number is astronomical (and ISO 8601): -584 is 585 BC, 0 is 1 BC.
    year = (m[1] === '-' ? -1 : 1) * Number(m[2]);
  } else if ((m = /^(\d{1,5})$/.exec(t))) {
    if (defaultEra === 'BC') {
      if (Number(m[1]) < 1) return null;
      year = 1 - Number(m[1]);
    } else {
      year = Number(m[1]);
    }
  } else {
    return null;
  }
  if (!Number.isInteger(year) || Math.abs(year) > 99_999) return null;
  return year === 0 ? 0 : year; // no -0
}

// ---------------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------------

/** True when a date of the display calendar lies before the 1582 reform. */
function beforeReform(date: DateFields): boolean {
  return jdnFromDate(date) < GREGORIAN_START_JDN;
}

/**
 * The calendar a date is shown in, in words: "Julian calendar", "Gregorian calendar", or,
 * for a date before 1582-10-15 shown in the ISO mode, "proleptic Gregorian calendar (ISO 8601)".
 */
export function calendarName(date: DateFields & { calendar: CalendarKind }, m: CalendarMode = calendarMode()): string {
  if (date.calendar === 'julian') return 'Julian calendar';
  if (m === 'iso' && beforeReform(date)) return 'proleptic Gregorian calendar (ISO 8601)';
  return 'Gregorian calendar';
}

/**
 * A short tag for a date before the reform: `Julian` (historical mode) or `ISO` (a proleptic
 * Gregorian date in the ISO mode); '' from 1582-10-15 on, where there is nothing to say.
 */
export function calendarTag(date: DateFields & { calendar: CalendarKind }, m: CalendarMode = calendarMode()): '' | 'Julian' | 'ISO' {
  if (date.calendar === 'julian') return 'Julian';
  return m === 'iso' && beforeReform(date) ? 'ISO' : '';
}

/** Why a date is in the calendar it is in, for the tag's tooltip. */
export function calendarTip(date: DateFields & { calendar: CalendarKind }, m: CalendarMode = calendarMode()): string {
  if (date.calendar === 'julian') {
    return 'Julian calendar: dates before 15 October 1582 are shown as people then wrote them. Thursday 4 October 1582 was followed by Friday 15 October, the first Gregorian date. Settings → Calendar can show the proleptic Gregorian (ISO 8601) date instead.';
  }
  if (m === 'iso' && beforeReform(date)) {
    return 'Proleptic Gregorian calendar (ISO 8601): the Gregorian rules carried back before 1582, as astronomers and ISO 8601 date them. People at the time used the Julian calendar; Settings → Calendar shows their dates.';
  }
  return 'Gregorian calendar.';
}

// ---------------------------------------------------------------------------------
// Dates from fields
// ---------------------------------------------------------------------------------

/** Fields of a date to write, with or without a known weekday. */
export type DateLike = DateFields & { weekday?: number };

function weekdayOfDate(d: DateLike): number {
  return d.weekday ?? weekdayOfJdn(jdnFromDate(d));
}

/** `24 Sep` */
export function dayMonth(d: DateLike): string {
  return `${d.day} ${MONTHS_SHORT[d.month - 1] ?? ''}`;
}

/** `Thu 24 Sep` */
export function dateShortText(d: DateLike): string {
  return `${WEEKDAYS_SHORT[weekdayOfDate(d)]} ${dayMonth(d)}`;
}

/** `Thu 24 Sep 2026`, `Mon 28 May 585 BC` */
export function dateMediumText(d: DateLike, options: YearOptions = {}): string {
  return `${dateShortText(d)} ${formatYear(d.year, style, options)}`;
}

/** `Thursday 24 September 2026` */
export function dateLongText(d: DateLike, options: YearOptions = {}): string {
  return `${WEEKDAYS_LONG[weekdayOfDate(d)]} ${d.day} ${MONTHS_LONG[d.month - 1] ?? ''} ${formatYear(d.year, style, options)}`;
}

/** `24 September 2026`, `28 May 585 BC` */
export function dayMonthYear(d: DateFields, options: YearOptions = {}): string {
  return `${d.day} ${MONTHS_LONG[d.month - 1] ?? ''} ${formatYear(d.year, style, options)}`;
}

/** `September 2026`, `May 585 BC` */
export function monthYear(year: number, month: number, options: YearOptions = {}): string {
  return `${MONTHS_LONG[month - 1] ?? ''} ${formatYear(year, style, options)}`;
}

/** `-0584-05-28`: a date's fields in ISO order with the wire's year numbering (a key, a file name). */
export function isoDateKey(d: DateFields): string {
  return `${isoYear(d.year)}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------
// Dates of instants
// ---------------------------------------------------------------------------------

export type DateForm = 'short' | 'medium' | 'long' | 'day-month-year';

/**
 * The date of an instant on the wall clock of `zone`, in the display calendar:
 * `Thu 24 Sep` (short), `Thu 24 Sep 2026` (medium), `Thursday 24 September 2026` (long),
 * `24 September 2026` (day-month-year). With `calendar: true` a date before the reform
 * carries its calendar: `Mon 28 May 585 BC (Julian)`.
 */
export function formatCivilDate(jd: number, zone: Zone, form: DateForm = 'medium', options: YearOptions & { calendar?: boolean } = {}): string {
  const w = wallClock(jd, zone);
  const text =
    form === 'short'
      ? dateShortText(w)
      : form === 'medium'
        ? dateMediumText(w, options)
        : form === 'long'
          ? dateLongText(w, options)
          : dayMonthYear(w, options);
  if (!options.calendar) return text;
  const tag = calendarTag(w);
  return tag ? `${text} (${tag})` : text;
}
