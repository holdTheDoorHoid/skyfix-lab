/**
 * Dates in any year for the Almanac view (almanac2 agent): the date entry (year with its
 * era, month, day, calendar), conversion between the explorer's instant and the wire's
 * proleptic Gregorian date, page headings in the display calendar, and the uncertainty
 * chip and notes of far dates.
 *
 * Julian dates and years BC go through the engine's `calendarConvert` and `timeInfo`
 * (EXPLORER_API "Time scales, Delta-T and calendars"), never `Date`/`Intl`, which are
 * proleptic Gregorian only and map years 0-99 to the 1900s. MERGE (time-ui): when the
 * shared helpers of `web/src/next/time/` land (the calendar formatter, `tierAt`, the ±ΔT
 * chip), the functions below marked MERGE delegate to them.
 */

import { h } from '../../dom.js';
import {
  isTimeEngine,
  type AlmanacOpeningDay,
  type CalendarKind,
  type TimeInfo,
} from '../engine/types.js';
import { chip } from '../theme/primitives.js';
import { utDateOf } from './layout.js';

/** The calendar the view shows: auto is Julian before 1582-10-15 (CONVENTIONS 15.3). */
export type CalendarChoice = 'auto' | 'julian' | 'gregorian';

/** JD of 1582-10-15 00:00, the first day of the Gregorian calendar. */
export const GREGORIAN_START_JD = 2_299_160.5;
/** The first Nautical Almanac was for 1767. */
export const FIRST_ALMANAC_YEAR = 1767;

export const MONTHS = [
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
];

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
}

/** `2026`, `-0584`, `+12345`: an astronomical year as ISO 8601 writes it. */
export function isoYear(year: number): string {
  if (year >= 0 && year <= 9999) return String(year).padStart(4, '0');
  return year < 0 ? `-${String(-year).padStart(4, '0')}` : `+${year}`;
}

export function wireDate(year: number, month: number, day: number): string {
  return `${isoYear(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The astronomical year of a year as people write it (585 BC is -584). */
export function astronomicalYear(eraYear: number, era: 'BC' | 'AD'): number {
  return era === 'BC' ? 1 - eraYear : eraYear;
}

/** The calendar of a date typed in `choice`: auto is Julian before 1582-10-05, Gregorian
 * after 1582-10-14, and neither in between (CONVENTIONS 15.3: refused unless named). */
export function calendarOfEntry(year: number, month: number, day: number, choice: CalendarChoice): CalendarKind | null {
  if (choice !== 'auto') return choice;
  const key = year * 10000 + month * 100 + day;
  if (key < 15821005) return 'julian';
  if (key > 15821014) return 'gregorian';
  return null;
}

/** The calendar an instant is shown in. */
export function calendarOfJd(jd: number, choice: CalendarChoice): CalendarKind {
  if (choice !== 'auto') return choice;
  return jd < GREGORIAN_START_JD ? 'julian' : 'gregorian';
}

/**
 * The UT date containing `jd`, in the display calendar. MERGE (time-ui): the calendar
 * formatter. Without a time engine (an older core) the date is proleptic Gregorian.
 */
export function shownDate(engine: unknown, jd: number, choice: CalendarChoice): ShownDate {
  if (isTimeEngine(engine)) {
    const conv = engine.calendarConvert({ jd_utc: Math.floor(jd - 0.5) + 0.5 });
    const cal = calendarOfJd(jd, choice);
    const c = cal === 'julian' ? conv.julian : conv.gregorian;
    return {
      calendar: cal,
      year: c.year,
      month: c.month,
      day: c.day,
      era_year: c.era_year,
      era: c.era,
      wire: wireDate(conv.gregorian.year, conv.gregorian.month, conv.gregorian.day),
    };
  }
  const wire = utDateOf(jd);
  const [y, m, d] = wire.split('-').map(Number) as [number, number, number];
  return { calendar: 'gregorian', year: y, month: m, day: d, era_year: y >= 1 ? y : 1 - y, era: y >= 1 ? 'AD' : 'BC', wire };
}

/** A date typed in the entry. */
export interface DateEntryValue {
  /** The year as people write it, 1 or more. */
  eraYear: number;
  era: 'BC' | 'AD';
  month: number;
  day: number;
}

/**
 * The instant on the typed date at `dayFraction` (0-1) of the UT day, or a sentence saying
 * why there is none. MERGE (time-ui): the calendar formatter's parser.
 */
export function entryToJd(
  engine: unknown,
  entry: DateEntryValue,
  choice: CalendarChoice,
  dayFraction: number,
): { jd: number } | { error: string } {
  if (!Number.isInteger(entry.eraYear) || entry.eraYear < 1) return { error: 'Type a year of 1 or more, with AD or BC.' };
  if (!Number.isInteger(entry.day) || entry.day < 1 || entry.day > 31) return { error: 'Type a day of the month, 1 to 31.' };
  const year = astronomicalYear(entry.eraYear, entry.era);
  const cal = calendarOfEntry(year, entry.month, entry.day, choice);
  if (cal === null) {
    return {
      error:
        '5 to 14 October 1582 are in neither calendar as used: the Julian calendar ended on 4 October 1582 and the Gregorian began on 15 October. Choose a calendar to use one of them anyway.',
    };
  }
  if (!isTimeEngine(engine)) {
    if (cal === 'julian' || year < 0 || year > 9999) {
      return { error: 'This build of the numerical core cannot convert calendars. Rebuild it with: npm run wasm --prefix web' };
    }
    const t = new Date(0);
    t.setUTCFullYear(year, entry.month - 1, entry.day);
    if (t.getUTCMonth() !== entry.month - 1) return { error: `${MONTHS[entry.month - 1]} ${entry.eraYear} has no day ${entry.day}.` };
    return { jd: t.getTime() / 86_400_000 + 2_440_587.5 + dayFraction };
  }
  try {
    const conv = engine.calendarConvert({ civil: { calendar: cal, year, month: entry.month, day: entry.day } });
    return { jd: conv.jd_utc + dayFraction };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { error: `That is not a date in the ${cal === 'julian' ? 'Julian' : 'Gregorian'} calendar (${text.replace(/^calendar_convert: /, '')}).` };
  }
}

/** `585 BC` or `2026`. */
export function yearText(eraYear: number, era: 'BC' | 'AD'): string {
  return era === 'BC' ? `${eraYear} BC` : String(eraYear);
}

/** `2016 MARCH 7, 8, 9 (MON., TUES., WED.)`, the printed almanac's opening heading. */
export function openingHeading(dates: readonly AlmanacOpeningDay[]): string {
  const first = dates[0]!;
  let text = `${yearText(first.era_year, first.era)} ${MONTHS[first.month - 1]!.toUpperCase()} ${first.day}`;
  for (let i = 1; i < dates.length; i += 1) {
    const d = dates[i]!;
    const prev = dates[i - 1]!;
    if (d.year !== prev.year) text += `, ${yearText(d.era_year, d.era)} ${MONTHS[d.month - 1]!.toUpperCase()} ${d.day}`;
    else if (d.month !== prev.month) text += `, ${MONTHS[d.month - 1]!.toUpperCase()} ${d.day}`;
    else text += `, ${d.day}`;
  }
  return `${text} (${dates.map((d) => WEEKDAY_ABBR[d.weekday] ?? d.weekday.toUpperCase()).join(' ')})`;
}

/** `2026 SEPTEMBER 24 (THURSDAY)`, a one-day heading in the display calendar. */
export function dayHeading(date: ShownDate, weekday: string): string {
  return `${yearText(date.era_year, date.era)} ${MONTHS[date.month - 1]!.toUpperCase()} ${date.day} (${weekday.toUpperCase()})`;
}

/** `Julian calendar` / `Gregorian calendar`, for a label beside the date. */
export function calendarLabel(cal: CalendarKind): string {
  return cal === 'julian' ? 'Julian calendar' : 'Gregorian calendar';
}

/** The sentence for dates before the first Nautical Almanac, or null. */
export function anachronismNote(year: number): string | null {
  return year < FIRST_ALMANAC_YEAR
    ? 'The first Nautical Almanac was for 1767: this is what its tables would have said, in its format, computed from today’s ephemeris.'
    : null;
}

/** ΔT's uncertainty as the chip writes it: `±40 s`, `±12 min`, `±2.1 h`. */
export function sigmaText(seconds: number): string {
  if (seconds < 90) return `±${Math.round(seconds)} s`;
  if (seconds < 5400) return `±${Math.round(seconds / 60)} min`;
  return `±${(seconds / 3600).toFixed(1)} h`;
}

/** The engine's time information for an instant, or null (an older core, or a failure). */
export function timeInfoAt(engine: unknown, jd: number): TimeInfo | null {
  if (!isTimeEngine(engine)) return null;
  try {
    return engine.timeInfo(jd);
  } catch {
    return null;
  }
}

/**
 * The ±ΔT chip beside a page heading when the Earth's rotation at the date is uncertain by
 * more than 30 s (EXPANSION_PLAN 3; the wave-2 rule: never a labelled-tier time without
 * its chip). MERGE (time-ui): `uncertaintyChip(timeInfo)`.
 */
export function deltaTChip(info: TimeInfo | null): HTMLElement | null {
  if (!info || !(info.delta_t_sigma_s > 30)) return null;
  const s = info.delta_t_sigma_s;
  const gha = (s / 240).toFixed(s / 240 >= 10 ? 0 : 1);
  return chip({
    label: sigmaText(s),
    class: 'alm-dt-chip',
    tip: `The Earth's rotation at this date is known only to ${sigmaText(s)} (ΔT), so every time on these pages, and every GHA (by ${gha}°), carries that uncertainty; declinations and SHA do not.`,
  });
}

/** The labelled tier's sentence (historical or far-future estimate), or null. */
export function tierNote(info: TimeInfo | null): string | null {
  if (!info || info.tier !== 'labelled') return null;
  const past = info.civil.year < 1550;
  return `${past ? 'Historical' : 'Far-future'} estimate: outside 1550–2650 these pages come from the deep-time series, with the accuracy the About view tabulates, and every time and GHA carries the ΔT uncertainty shown beside the heading.`;
}

/** The small element that says which calendar a date is in. */
export function calendarTag(cal: CalendarKind): HTMLElement {
  return h('span', { class: `alm-cal alm-cal--${cal}` }, calendarLabel(cal));
}
