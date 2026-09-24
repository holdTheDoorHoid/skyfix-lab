/**
 * Pure helpers for the Almanac view: dates, the printed almanac's column conventions and
 * grouping. No DOM, so they are unit-tested in Node (`test/next/almanac.test.ts`).
 *
 * Every number the page shows is already rounded by the engine (`printed`); nothing here
 * rounds a raw value. What this module decides is presentation only: which part of a
 * printed angle is repeated on a row, how rows are grouped, how a date is stepped.
 */

import type { AlmanacDay, AlmanacTime, PhaseEvent } from '../engine/types.js';

const MS_PER_DAY = 86_400_000;
const JD_UNIX_EPOCH = 2_440_587.5;

/** The UT calendar date `YYYY-MM-DD` containing `jd` (the almanac's day is a UT day). */
export function utDateOf(jd: number): string {
  const ms = Math.round((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
  return new Date(ms).toISOString().slice(0, 10);
}

/** 00h UT of a `YYYY-MM-DD` date as a Julian Date, or null when it is not one. */
export function jdOfUtDate(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return t.getTime() / MS_PER_DAY + JD_UNIX_EPOCH;
}

/** The UT hour (0-23) of `jd`. */
export function utHourOf(jd: number): number {
  const ms = Math.round((jd - JD_UNIX_EPOCH) * MS_PER_DAY);
  return new Date(ms).getUTCHours();
}

/**
 * The instant on `date` at the same UT time of day as `jd`: moving the almanac to another
 * date keeps the hour the rest of the explorer is showing.
 */
export function moveToUtDate(jd: number, date: string): number | null {
  const target = jdOfUtDate(date);
  const current = jdOfUtDate(utDateOf(jd));
  if (target === null || current === null) return null;
  return target + (jd - current);
}

/** `2026 SEPTEMBER 24 (THURSDAY)`, the printed almanac's page heading. */
export function pageHeading(day: Pick<AlmanacDay, 'date' | 'weekday'>): string {
  const [y, m, d] = day.date.split('-');
  const months = [
    'JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
    'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER',
  ];
  return `${y} ${months[Number(m) - 1] ?? m} ${Number(d)} (${day.weekday.toUpperCase()})`;
}

/** Split `list` into consecutive groups of `size` (the last may be shorter). */
export function blocks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** A printed GHA or SHA, `183 12.4`, as its degrees and minutes. */
export interface GhaParts {
  deg: string;
  min: string;
}

export function ghaParts(printed: string): GhaParts {
  const [deg = '', min = ''] = printed.split(' ');
  return { deg, min };
}

/** A printed declination, `N 12 34.5`, as hemisphere, degrees and minutes. */
export interface DecParts {
  hemisphere: string;
  deg: string;
  min: string;
}

export function decParts(printed: string): DecParts {
  const [hemisphere = '', deg = '', min = ''] = printed.split(' ');
  return { hemisphere, deg, min };
}

/**
 * The printed almanac repeats a declination's hemisphere and degrees only on the first
 * row of each block and where they change; the other rows show the minutes alone. For a
 * column of printed declinations in one block, true where the degrees are shown.
 */
export function showDecDegrees(column: readonly string[]): boolean[] {
  return column.map((value, i) => {
    if (i === 0) return true;
    const a = decParts(column[i - 1]!);
    const b = decParts(value);
    return a.hemisphere !== b.hemisphere || a.deg !== b.deg;
  });
}

/** The printed almanac's phase symbols: new ●, first quarter ◐, full ○, last quarter ◑. */
export function phaseSymbol(kind: PhaseEvent['kind']): string {
  switch (kind) {
    case 'new_moon':
      return '●';
    case 'first_quarter':
      return '◐';
    case 'full_moon':
      return '○';
    case 'last_quarter':
      return '◑';
  }
}

export function phaseName(kind: PhaseEvent['kind']): string {
  return kind.replace('_', ' ').replace(/^./, (c) => c.toUpperCase());
}

/** CSS class for a time cell: symbols are centred, the rest aligned as numbers. */
export function timeCellClass(t: AlmanacTime): string {
  return t.kind === 'time' ? 'alm-t' : `alm-t alm-sym alm-${t.kind.replace('_', '-')}`;
}

/** Plain-language meaning of a time cell, for its tooltip and screen readers. */
export function timeCellTitle(t: AlmanacTime): string | undefined {
  switch (t.kind) {
    case 'time':
      return t.hours !== null && (t.hours >= 24 || t.hours < 0)
        ? `${t.utc ?? ''} (${t.hours >= 24 ? 'on the following date' : 'before 00h'})`
        : undefined;
    case 'above':
      return 'Above the horizon all day';
    case 'below':
      return 'Below the horizon (or the twilight altitude) all day';
    case 'all_night':
      return 'Twilight lasts all night';
    case 'later':
      return 'Not on this date nor the next';
    case 'unavailable':
      return 'Outside the ephemeris coverage';
  }
}

/** `24`, the day of the month of a `YYYY-MM-DD` date, for a column heading. */
export function dayOfMonth(date: string): string {
  return String(Number(date.slice(8, 10)));
}
