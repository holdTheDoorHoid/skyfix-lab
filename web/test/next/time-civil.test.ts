/**
 * Civil calendar arithmetic (time/civil.ts, time/format.ts, time.ts) for any year:
 * the Julian calendar before 1582-10-15, BC years, and the `Date.UTC` traps the accuracy
 * audit listed. Held to JavaScript's own proleptic Gregorian `Date`, to the mock engine's
 * calendars, and to the real engine's `calendar_convert` when a package is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Mock from '../../src/next/engine/mock/timescale.js';
import type { CalendarConversion } from '../../src/next/engine/types.js';
import {
  addCalendar,
  formatDate,
  formatDateTime,
  isoUtc,
  jdFromIso,
  jdFromWallClock,
  periodWindow,
  UTC_ZONE,
  wallClock,
} from '../../src/next/time.js';
import {
  addDaysToDate,
  addMonthsToDate,
  civilFromJdn,
  dateFromJdn,
  dayOfYear,
  GREGORIAN_START_JDN,
  isGapDate,
  isValidDate,
  jdnFromCivil,
  jdnFromDate,
  lastDayOfMonth,
  monthLength,
  monthSpan,
  setCalendarMode,
  weekdayOf,
  weekdayOfJdn,
  yearLength,
} from '../../src/next/time/civil.js';
import {
  calendarTag,
  dateLongText,
  dateMediumText,
  formatCivilDate,
  formatYear,
  parseYear,
  setYearStyle,
  yearForms,
} from '../../src/next/time/format.js';

afterEach(() => {
  setCalendarMode('historical');
  setYearStyle('era');
});

/** A day number from JavaScript's own (proleptic Gregorian) calendar, years 0-99 kept as such. */
function jsJdn(year: number, month: number, day: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  return Math.round(d.getTime() / 86_400_000) + 2_440_588;
}

describe('one calendar at a time (Meeus ch. 7, integer form)', () => {
  it('pins the reference days', () => {
    expect(jdnFromCivil('gregorian', 2000, 1, 1)).toBe(2_451_545);
    expect(jdnFromCivil('gregorian', 1582, 10, 15)).toBe(GREGORIAN_START_JDN);
    expect(jdnFromCivil('julian', 1582, 10, 4)).toBe(GREGORIAN_START_JDN - 1);
    // Meeus, example 7.b: 333 January 27.5 (Julian) is JD 1 842 713.0.
    expect(jdnFromCivil('julian', 333, 1, 27)).toBe(1_842_713);
    // JD 0 is noon of -4712 January 1 (Julian).
    expect(jdnFromCivil('julian', -4712, 1, 1)).toBe(0);
    // Meeus 7.a: 1957 October 4.81 (Sputnik) is JD 2 436 116.31.
    expect(jdnFromCivil('gregorian', 1957, 10, 4)).toBe(2_436_116);
  });

  it('agrees with JavaScript Date for every day of the Gregorian years 0-9999 sampled', () => {
    let checked = 0;
    for (let jdn = jsJdn(0, 1, 1); jdn <= jsJdn(9999, 12, 31); jdn += 97) {
      const d = new Date((jdn - 2_440_588) * 86_400_000);
      const c = civilFromJdn('gregorian', jdn);
      if (c.year !== d.getUTCFullYear() || c.month !== d.getUTCMonth() + 1 || c.day !== d.getUTCDate()) throw new Error(`${jdn}: ${JSON.stringify(c)} vs ${d.toISOString()}`);
      if (jdnFromCivil('gregorian', c.year, c.month, c.day) !== jdn) throw new Error(`back ${jdn}`);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(37_000);
  }, 30_000);

  it('round-trips every day from 2000 BC to AD 3000 in both calendars', () => {
    for (const calendar of ['julian', 'gregorian'] as const) {
      const a = jdnFromCivil(calendar, -1999, 1, 1);
      const b = jdnFromCivil(calendar, 3000, 12, 31);
      let prev = civilFromJdn(calendar, a - 1);
      for (let jdn = a; jdn <= b; jdn += 1) {
        const c = civilFromJdn(calendar, jdn);
        if (jdnFromCivil(calendar, c.year, c.month, c.day) !== jdn) throw new Error(`${calendar} ${jdn}`);
        // Consecutive day numbers are consecutive dates.
        const next = prev.day + 1 <= Mock.daysInMonth(calendar, prev.year, prev.month)! ? { ...prev, day: prev.day + 1 } : prev.month < 12 ? { ...prev, month: prev.month + 1, day: 1 } : { ...prev, year: prev.year + 1, month: 1, day: 1 };
        if (next.year !== c.year || next.month !== c.month || next.day !== c.day) throw new Error(`${calendar} gap at ${jdn}`);
        prev = c;
      }
    }
  }, 30_000);

  it('matches the mock engine’s calendars (the Rust algorithm) over -2000..3000', () => {
    for (const calendar of ['julian', 'gregorian'] as const) {
      for (let jdn = 990_000; jdn < 2_817_000; jdn += 211) {
        const c = civilFromJdn(calendar, jdn);
        const [y, m, d] = Mock.civilFromJdn(calendar, jdn);
        if (c.year !== y || c.month !== m || c.day !== d) throw new Error(`${calendar} ${jdn}`);
        if (jdnFromCivil(calendar, c.year, c.month, c.day) !== Mock.jdnFromCivil(calendar, y, m, d)) throw new Error(`${calendar} back ${jdn}`);
      }
    }
  }, 30_000);

  it('lets fields overflow linearly', () => {
    expect(jdnFromCivil('gregorian', 2026, 1, 32)).toBe(jdnFromCivil('gregorian', 2026, 2, 1));
    expect(jdnFromCivil('gregorian', 2026, 3, 0)).toBe(jdnFromCivil('gregorian', 2026, 2, 28));
    expect(jdnFromCivil('julian', 1500, 13, 1)).toBe(jdnFromCivil('julian', 1501, 1, 1));
    expect(jdnFromCivil('julian', 1500, 0, 1)).toBe(jdnFromCivil('julian', 1499, 12, 1));
  });

  it('knows the weekdays of history', () => {
    expect(weekdayOfJdn(2_451_545)).toBe(6); // Saturday 1 January 2000
    expect(weekdayOfJdn(jdnFromCivil('julian', 1582, 10, 4))).toBe(4); // Thursday
    expect(weekdayOfJdn(jdnFromCivil('gregorian', 1582, 10, 15))).toBe(5); // Friday
    expect(weekdayOfJdn(jdnFromCivil('julian', 1066, 10, 14))).toBe(6); // Hastings: a Saturday
    expect(weekdayOfJdn(jdnFromCivil('julian', 1492, 10, 12))).toBe(5); // Columbus's landfall: a Friday
  });
});

describe('the display calendar: Julian before 1582-10-15, Gregorian from it', () => {
  it('shows 4 October 1582 followed by 15 October 1582', () => {
    const oct4 = dateFromJdn(GREGORIAN_START_JDN - 1);
    const oct15 = dateFromJdn(GREGORIAN_START_JDN);
    expect(oct4).toEqual({ year: 1582, month: 10, day: 4, calendar: 'julian' });
    expect(oct15).toEqual({ year: 1582, month: 10, day: 15, calendar: 'gregorian' });
    expect(addDaysToDate(oct4, 1)).toEqual(oct15);
    expect(addDaysToDate(oct15, -1)).toEqual(oct4);
    expect(weekdayOf(oct4)).toBe(4);
    expect(weekdayOf(oct15)).toBe(5);
  });

  it('gives October 1582 21 days and the year 355', () => {
    expect(monthLength(1582, 10)).toBe(21);
    expect(lastDayOfMonth(1582, 10)).toBe(31);
    expect(yearLength(1582)).toBe(355);
    expect(yearLength(1500)).toBe(366); // a Julian leap year
    expect(yearLength(1600)).toBe(366);
    expect(yearLength(1700)).toBe(365);
    expect(monthLength(1500, 2)).toBe(29);
    const [a, b] = monthSpan(1582, 10);
    expect(b - a + 1).toBe(21);
    expect(dayOfYear({ year: 1582, month: 10, day: 15 })).toBe(277); // 1 January + 287 days - 10 skipped
  });

  it('refuses the ten skipped dates unless the calendar is named', () => {
    expect(isGapDate({ year: 1582, month: 10, day: 10 })).toBe(true);
    expect(isValidDate({ year: 1582, month: 10, day: 10 })).toBe(false);
    expect(isValidDate({ year: 1582, month: 10, day: 10, calendar: 'julian' })).toBe(true);
    expect(isValidDate({ year: 1582, month: 10, day: 4 })).toBe(true);
    expect(isValidDate({ year: 1582, month: 10, day: 15 })).toBe(true);
    expect(isValidDate({ year: 1500, month: 2, day: 29 })).toBe(true); // Julian leap day
    expect(isValidDate({ year: 1700, month: 2, day: 29 })).toBe(false);
    expect(isValidDate({ year: -584, month: 2, day: 29 })).toBe(true); // -584 is divisible by 4
    // A skipped date read on its own continues the Julian count (the day after the 4th is the 15th).
    expect(jdnFromDate({ year: 1582, month: 10, day: 5 })).toBe(GREGORIAN_START_JDN);
  });

  it('steps months and years in the display calendar, clamping the day', () => {
    expect(addMonthsToDate({ year: 1500, month: 1, day: 31 }, 1)).toEqual({ year: 1500, month: 2, day: 29, calendar: 'julian' });
    expect(addMonthsToDate({ year: 1500, month: 2, day: 29 }, 12)).toEqual({ year: 1501, month: 2, day: 28, calendar: 'julian' });
    expect(addMonthsToDate({ year: 1582, month: 9, day: 10 }, 1)).toEqual({ year: 1582, month: 10, day: 15, calendar: 'gregorian' });
    expect(addMonthsToDate({ year: 1582, month: 11, day: 10 }, -1)).toEqual({ year: 1582, month: 10, day: 4, calendar: 'julian' });
    expect(addMonthsToDate({ year: 1600, month: 3, day: 1 }, -1200)).toEqual({ year: 1500, month: 3, day: 1, calendar: 'julian' });
  });

  it('is proleptic Gregorian throughout in the ISO mode', () => {
    setCalendarMode('iso');
    expect(dateFromJdn(GREGORIAN_START_JDN - 1)).toEqual({ year: 1582, month: 10, day: 14, calendar: 'gregorian' });
    expect(monthLength(1582, 10)).toBe(31);
    expect(isGapDate({ year: 1582, month: 10, day: 10 })).toBe(false);
    expect(yearLength(1500)).toBe(365);
  });
});

describe('the Date.UTC traps are gone (years -584, 0, 99, 1066, 12345)', () => {
  const cases: Array<[number, number, number, string, string]> = [
    // year, month, day in the display calendar; the wire string; the date as shown
    [-584, 5, 28, '-0584-05-22T12:00:00.000Z', 'Wed 28 May 585 BC'],
    [0, 3, 1, '0000-02-28T12:00:00.000Z', 'Mon 1 Mar 1 BC'],
    [99, 7, 4, '0099-07-02T12:00:00.000Z', 'Thu 4 Jul AD 99'],
    [1066, 10, 14, '1066-10-20T12:00:00.000Z', 'Sat 14 Oct 1066'],
    [12345, 1, 1, '+12345-01-01T12:00:00.000Z', 'Mon 1 Jan 12345'],
  ];

  it.each(cases)('%d-%d-%d: wall clock, wire string and back', (year, month, day, wire, shown) => {
    const jd = jdFromWallClock({ year, month, day, hour: 12 }, UTC_ZONE);
    expect(isoUtc(jd)).toBe(wire);
    expect(jdFromIso(wire)).toBe(jd);
    const w = wallClock(jd, UTC_ZONE);
    expect([w.year, w.month, w.day, w.hour]).toEqual([year, month, day, 12]);
    expect(dateMediumText(w)).toBe(shown);
    expect(formatCivilDate(jd, UTC_ZONE, 'medium')).toBe(shown);
    const key = formatDate(jd, UTC_ZONE);
    expect(key.slice(-6)).toBe(`-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  });

  it('numbers the years in ISO order with expanded years', () => {
    expect(formatDate(jdFromWallClock({ year: -584, month: 5, day: 28 }, UTC_ZONE), UTC_ZONE)).toBe('-0584-05-28');
    expect(formatDate(jdFromWallClock({ year: 99, month: 7, day: 4 }, UTC_ZONE), UTC_ZONE)).toBe('0099-07-04');
    expect(formatDateTime(jdFromWallClock({ year: 12345, month: 1, day: 1, hour: 6 }, UTC_ZONE), UTC_ZONE)).toBe('+12345-01-01 06:00');
  });

  it('steps a century across year 0 and the reform', () => {
    const start = jdFromWallClock({ year: 50, month: 3, day: 1, hour: 9 }, UTC_ZONE);
    const back = addCalendar(start, UTC_ZONE, { years: -100 });
    expect(wallClock(back, UTC_ZONE)).toMatchObject({ year: -50, month: 3, day: 1, hour: 9, calendar: 'julian' });
    const t1500 = jdFromWallClock({ year: 1500, month: 2, day: 29, hour: 9 }, UTC_ZONE);
    expect(wallClock(addCalendar(t1500, UTC_ZONE, { years: 100 }), UTC_ZONE)).toMatchObject({ year: 1600, month: 2, day: 29, calendar: 'gregorian' });
    expect(wallClock(addCalendar(t1500, UTC_ZONE, { years: 1 }), UTC_ZONE)).toMatchObject({ year: 1501, month: 2, day: 28 });
    const oct4 = jdFromWallClock({ year: 1582, month: 10, day: 4, hour: 12 }, UTC_ZONE);
    expect(wallClock(addCalendar(oct4, UTC_ZONE, { days: 1 }), UTC_ZONE)).toMatchObject({ month: 10, day: 15, calendar: 'gregorian' });
  });

  it('makes the day, month and year windows of the display calendar', () => {
    const t = jdFromWallClock({ year: 1582, month: 10, day: 20, hour: 12 }, UTC_ZONE);
    const [a, b] = periodWindow(t, UTC_ZONE, 'month');
    expect(b - a).toBe(21);
    const [c, d] = periodWindow(t, UTC_ZONE, 'year');
    expect(d - c).toBe(355);
    const bc = jdFromWallClock({ year: -584, month: 5, day: 28, hour: 12 }, UTC_ZONE);
    const [e, f] = periodWindow(bc, UTC_ZONE, 'day');
    expect([isoUtc(e), isoUtc(f)]).toEqual(['-0584-05-22T00:00:00.000Z', '-0584-05-23T00:00:00.000Z']);
  });
});

describe('years as people write them', () => {
  it('writes the three styles', () => {
    expect([-584, 0, 1, 99, 1066, 2026, 12345].map((y) => formatYear(y, 'era'))).toEqual(['585 BC', '1 BC', 'AD 1', 'AD 99', '1066', '2026', '12345']);
    expect(formatYear(1066, 'era', { era: 'always' })).toBe('AD 1066');
    expect([-584, 0, 99, 1066, 12345].map((y) => formatYear(y, 'astronomical'))).toEqual(['−584', '0', '99', '1066', '12345']);
    expect([-584, 0, 99, 1066, 12345].map((y) => formatYear(y, 'iso'))).toEqual(['-0584', '0000', '0099', '1066', '+12345']);
    expect(yearForms(-584)).toBe('585 BC: astronomical year −584, ISO 8601 -0584');
    expect(yearForms(2026)).toBe('2026');
  });

  it('follows the setting in dates', () => {
    const w = { year: -584, month: 5, day: 28 };
    expect(dateLongText(w)).toBe('Wednesday 28 May 585 BC');
    setYearStyle('astronomical');
    expect(dateLongText(w)).toBe('Wednesday 28 May −584');
    setYearStyle('iso');
    expect(dateLongText(w)).toBe('Wednesday 28 May -0584');
  });

  it('reads typed years', () => {
    expect(parseYear('585 BC')).toBe(-584);
    expect(parseYear('585 b.c.')).toBe(-584);
    expect(parseYear('585 BCE')).toBe(-584);
    expect(parseYear('AD 1066')).toBe(1066);
    expect(parseYear('1066 CE')).toBe(1066);
    expect(parseYear('-584')).toBe(-584);
    expect(parseYear('−584')).toBe(-584);
    expect(parseYear('-0584')).toBe(-584);
    expect(parseYear('+12345')).toBe(12345);
    expect(parseYear('0')).toBe(0);
    expect(parseYear('585', 'BC')).toBe(-584);
    expect(parseYear('1', 'BC')).toBe(0);
    expect(parseYear('0 BC')).toBeNull();
    expect(parseYear('0', 'BC')).toBeNull();
    expect(parseYear('AD 0')).toBeNull();
    expect(parseYear('twelve')).toBeNull();
    expect(parseYear('1066.5')).toBeNull();
    expect(Object.is(parseYear('-0'), -0)).toBe(false);
  });

  it('tags dates before the reform with their calendar', () => {
    expect(calendarTag({ year: 1066, month: 10, day: 14, calendar: 'julian' })).toBe('Julian');
    expect(calendarTag({ year: 2026, month: 9, day: 24, calendar: 'gregorian' })).toBe('');
    setCalendarMode('iso');
    expect(calendarTag({ year: 1066, month: 10, day: 20, calendar: 'gregorian' })).toBe('ISO');
    const jd = jdFromWallClock({ year: 1066, month: 10, day: 20, hour: 12 }, UTC_ZONE);
    expect(formatCivilDate(jd, UTC_ZONE, 'medium', { calendar: true })).toBe('Sat 20 Oct 1066 (ISO)');
  });
});

// ---------------------------------------------------------------------------------
// Against the real engine's calendar_convert, when a package has been built
// ---------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built package’s calendar_convert (src/wasm-pkg)', () => {
  let convert: ((request: string) => CalendarConversion) | null = null;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
      calendar_convert?: (request: string) => CalendarConversion;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    convert = glue.calendar_convert ?? null;
  });

  it('agrees on every sampled day from 2000 BC to AD 3000, both ways, both calendars', ({ skip }) => {
    if (!convert) {
      skip();
      return;
    }
    const days: number[] = [];
    for (let jdn = 990_557; jdn < 2_817_152; jdn += 1_009) days.push(jdn);
    for (let jdn = GREGORIAN_START_JDN - 3; jdn <= GREGORIAN_START_JDN + 3; jdn += 1) days.push(jdn);
    days.push(jdnFromCivil('julian', 0, 2, 29), jdnFromCivil('julian', -584, 5, 28), jdnFromCivil('gregorian', 1600, 2, 29));
    for (const jdn of days) {
      const r = convert(JSON.stringify({ jd_utc: jdn }));
      const j = civilFromJdn('julian', jdn);
      const g = civilFromJdn('gregorian', jdn);
      expect([r.julian.year, r.julian.month, r.julian.day]).toEqual([j.year, j.month, j.day]);
      expect([r.gregorian.year, r.gregorian.month, r.gregorian.day]).toEqual([g.year, g.month, g.day]);
      const back = convert(JSON.stringify({ civil: { calendar: 'julian', year: j.year, month: j.month, day: j.day, hour: 12 } }));
      expect(back.jd_utc).toBe(jdn);
      // The display calendar chooses what time_info.calendar chooses.
      expect(dateFromJdn(jdn).calendar).toBe(jdn < GREGORIAN_START_JDN ? 'julian' : 'gregorian');
    }
  }, 30_000);

  it('agrees on the eras', ({ skip }) => {
    if (!convert) {
      skip();
      return;
    }
    const r = convert(JSON.stringify({ civil: { calendar: 'julian', year: -584, month: 5, day: 28, hour: 12 } }));
    expect(r.jd_utc).toBe(1_507_900);
    expect([r.julian.era_year, r.julian.era]).toEqual([585, 'BC']);
    expect(formatYear(r.julian.year)).toBe(`${r.julian.era_year} BC`);
  });
});
