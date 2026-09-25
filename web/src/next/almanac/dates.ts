/**
 * Dates in any year for the Almanac view (almanac2 agent), over the shared time helpers of
 * `web/src/next/time/` (time-ui agent): the display calendar (Julian before 1582-10-15, or
 * proleptic Gregorian with the ISO setting), years as Settings writes them (585 BC, −584,
 * -0584), the ±ΔT chip, the tier sentences and the Deep time pack a date needs.
 *
 * The almanac adds only what is its own: a calendar it may be told to use instead of the
 * display calendar (`CalendarChoice`), the printed almanac's headings, and the note for
 * dates before the first Nautical Almanac.
 */

import type { AlmanacOpeningDay, CalendarKind, TimeInfo } from '../engine/types.js';
import type { Ctx } from '../component.js';
import {
  calendarMode,
  calendarName,
  calendarOfJdn,
  civilFromJdn,
  daysInMonthOf,
  eraOfYear,
  formatYear,
  isGapDate,
  isoDateKey,
  isValidDate,
  jdnFromDate,
  MONTHS_LONG,
  parseYear,
  tierNotice,
  timeInfoAt as sharedTimeInfoAt,
  uncertaintyChip,
} from '../time/index.js';

/** The calendar the almanac shows: `auto` is the display calendar of Settings. */
export type CalendarChoice = 'auto' | 'julian' | 'gregorian';

/** The first Nautical Almanac was for 1767. */
export const FIRST_ALMANAC_YEAR = 1767;

export const MONTHS: readonly string[] = MONTHS_LONG;

const WEEKDAY_ABBR: Record<string, string> = {
  Sunday: 'SUN.',
  Monday: 'MON.',
  Tuesday: 'TUES.',
  Wednesday: 'WED.',
  Thursday: 'THURS.',
  Friday: 'FRI.',
  Saturday: 'SAT.',
};

/** A date as the view shows it. */
export interface ShownDate {
  calendar: CalendarKind;
  /** Astronomical year (0 = 1 BC). */
  year: number;
  month: number;
  day: number;
  era_year: number;
  era: 'BC' | 'AD';
  /** The wire date: proleptic Gregorian `YYYY-MM-DD`, expanded outside 0000-9999. */
  wire: string;
  /** The day number (JDN). */
  jdn: number;
}

/** The day number (JDN) of the UT date containing `jd`. */
export function jdnOf(jd: number): number {
  return Math.floor(jd + 0.5);
}

/** The calendar a day is shown in under `choice`. */
export function calendarOfDay(jdn: number, choice: CalendarChoice): CalendarKind {
  return choice === 'auto' ? calendarOfJdn(jdn) : choice;
}

/** The engine's grouping argument for `choice`: auto follows the display calendar. */
export function engineCalendar(choice: CalendarChoice): '' | 'julian' | 'gregorian' {
  if (choice !== 'auto') return choice;
  return calendarMode() === 'iso' ? 'gregorian' : '';
}

/** The UT date containing `jd`, in the calendar the almanac shows. */
export function shownDate(jd: number, choice: CalendarChoice): ShownDate {
  const jdn = jdnOf(jd);
  const cal = calendarOfDay(jdn, choice);
  const c = civilFromJdn(cal, jdn);
  const { eraYear, era } = eraOfYear(c.year);
  return {
    calendar: cal,
    year: c.year,
    month: c.month,
    day: c.day,
    era_year: eraYear,
    era,
    wire: isoDateKey(civilFromJdn('gregorian', jdn)),
    jdn,
  };
}

/** A date typed in the entry. */
export interface DateEntryValue {
  /**
   * The year as typed: a bare number (in `era`), or with its own sign or era, which wins
   * over the switch: `1066`, `585 BC`, `AD 79`, `−584`, `-0584`, `+12345` (`parseYear`).
   */
  yearText: string;
  era: 'BC' | 'AD';
  month: number;
  day: number;
}

/**
 * The instant on the typed date at `dayFraction` (0-1) of the UT day, or a sentence saying
 * why there is none. `auto` reads the date in the display calendar, where 5-14 October
 * 1582 are refused unless a calendar is chosen (CONVENTIONS 15.3).
 */
export function entryToJd(entry: DateEntryValue, choice: CalendarChoice, dayFraction: number): { jd: number } | { error: string } {
  const year = parseYear(entry.yearText, entry.era);
  if (year === null) return { error: 'Type a year such as 1066, 585 BC or −584.' };
  if (!Number.isInteger(entry.month) || entry.month < 1 || entry.month > 12) return { error: 'Choose a month.' };
  const fields = { year, month: entry.month, day: entry.day, ...(choice === 'auto' ? {} : { calendar: choice }) };
  if (choice === 'auto' && isGapDate(fields)) {
    return {
      error:
        '5 to 14 October 1582 are in neither calendar as used: the Julian calendar ended on 4 October 1582 and the Gregorian began on 15 October. Choose a calendar to use one of them anyway.',
    };
  }
  if (!isValidDate(fields)) {
    const cal = choice === 'auto' ? calendarOfDay(jdnFromDate({ ...fields, day: 1 }), 'auto') : choice;
    const days = daysInMonthOf(cal, year, entry.month);
    return { error: `${MONTHS[entry.month - 1]} ${formatYear(year)} has ${days} days (${cal === 'julian' ? 'Julian' : 'Gregorian'} calendar).` };
  }
  return { jd: jdnFromDate(fields) - 0.5 + dayFraction };
}

/** A year as Settings writes it: `585 BC`, `−584`, `-0584`, `2026`. */
export function yearText(year: number): string {
  return formatYear(year);
}

/** `2016 MARCH 7, 8, 9 (MON., TUES., WED.)`, the printed almanac's opening heading. */
export function openingHeading(dates: readonly AlmanacOpeningDay[]): string {
  const first = dates[0]!;
  let text = `${yearText(first.year)} ${MONTHS[first.month - 1]!.toUpperCase()} ${first.day}`;
  for (let i = 1; i < dates.length; i += 1) {
    const d = dates[i]!;
    const prev = dates[i - 1]!;
    if (d.year !== prev.year) text += `, ${yearText(d.year)} ${MONTHS[d.month - 1]!.toUpperCase()} ${d.day}`;
    else if (d.month !== prev.month) text += `, ${MONTHS[d.month - 1]!.toUpperCase()} ${d.day}`;
    else text += `, ${d.day}`;
  }
  return `${text} (${dates.map((d) => WEEKDAY_ABBR[d.weekday] ?? d.weekday.toUpperCase()).join(', ')})`;
}

/** `2026 SEPTEMBER 24 (THURSDAY)`, a one-day heading in the display calendar. */
export function dayHeading(date: ShownDate, weekday: string): string {
  return `${yearText(date.year)} ${MONTHS[date.month - 1]!.toUpperCase()} ${date.day} (${weekday.toUpperCase()})`;
}

/**
 * The calendar a shown date is in, in words (the shared `calendarName`): `Julian calendar`,
 * `Gregorian calendar`, or `proleptic Gregorian calendar (ISO 8601)` for a Gregorian date
 * before 1582-10-15, whether Settings or the almanac's own choice asked for it.
 */
export function calendarLabel(date: Pick<ShownDate, 'calendar' | 'year' | 'month' | 'day'>): string {
  return calendarName(
    { year: date.year, month: date.month, day: date.day, calendar: date.calendar },
    date.calendar === 'gregorian' ? 'iso' : calendarMode(),
  );
}

/** The sentence for dates before the first Nautical Almanac, or null. */
export function anachronismNote(year: number): string | null {
  return year < FIRST_ALMANAC_YEAR
    ? 'The first Nautical Almanac was for 1767: this is what its tables would have said, in its format, computed from today’s ephemeris.'
    : null;
}

/** The engine's time information for an instant (shared, remembered), or null. */
export function timeInfoAt(ctx: Ctx, jd: number): TimeInfo | null {
  return sharedTimeInfoAt(ctx, jd);
}

/**
 * The ±ΔT chip beside a page heading (the shared `uncertaintyChip`): shown when the Earth's
 * rotation is uncertain by more than 30 s, and always in the labelled tier. Null when it
 * has nothing to show, so a heading does not carry an empty element.
 */
export function deltaTChip(info: TimeInfo | null): HTMLElement | null {
  const chip = uncertaintyChip(info);
  return chip.hidden ? null : chip;
}

/** The tier's sentence (historical or far-future estimate) for the page's notes, or null. */
export function tierNote(ctx: Ctx, jd: number): string | null {
  const n = tierNotice(ctx, jd);
  return n && n.persistent ? n.text : null;
}
