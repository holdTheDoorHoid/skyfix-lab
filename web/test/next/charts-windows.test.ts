/**
 * Charts: local days, months, years and nights in the display zone, wall-clock positions,
 * clock changes and interval arithmetic (web/src/next/charts/windows.ts).
 */
import { describe, expect, it } from 'vitest';
import { jdFromUnixMs } from '../../src/next/engine/types.js';
import { addDays, startOfLocalDay } from '../../src/next/geo/timezone.js';
import { dayWindow as timeDayWindow, formatTime, resolveZone, type Zone } from '../../src/next/time.js';
import {
  clockChangeIn,
  dateKey,
  dayOfYear,
  daysInMonth,
  daysOfMonth,
  daysOfYear,
  hasClockChange,
  hoursAfterNoon,
  intersectIntervals,
  intervalsLength,
  jdAtWallHours,
  localDay,
  localDayAt,
  localNights,
  mergeIntervals,
  nightDateOf,
  nightsFromDays,
  toDisplayZone,
  wallHours,
  zoneKey,
} from '../../src/next/charts/windows.js';

const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
const SANTIAGO: Zone = { kind: 'iana', zone: 'America/Santiago' };
const SYDNEY: Zone = { kind: 'iana', zone: 'Australia/Sydney' };
const UTC: Zone = { kind: 'fixed', offsetMs: 0, name: 'UTC' };
const ZD5 = resolveZone({ kind: 'nautical' }, -75.17);

const HOUR = 1 / 24;
const jdUtc = (y: number, mo: number, d: number, h = 0, mi = 0): number => jdFromUnixMs(Date.UTC(y, mo - 1, d, h, mi));

describe('zones', () => {
  it('maps the store’s zones onto geo/timezone.ts display zones', () => {
    expect(toDisplayZone(NEW_YORK)).toEqual({ kind: 'iana', id: 'America/New_York' });
    expect(toDisplayZone(UTC)).toEqual({ kind: 'utc' });
    expect(toDisplayZone(ZD5)).toEqual({ kind: 'nautical', zd: 5 });
    expect(toDisplayZone({ kind: 'fixed', offsetMs: 5.5 * 3_600_000, name: 'odd' })).toBeNull();
    expect(zoneKey(NEW_YORK)).not.toBe(zoneKey(UTC));
  });
});

describe('local days', () => {
  it('tiles a year with 365 or 366 local-midnight windows', () => {
    for (const [year, n] of [
      [2026, 365],
      [2028, 366],
    ] as const) {
      const days = daysOfYear(NEW_YORK, year);
      expect(days).toHaveLength(n);
      expect(days[0]!.key).toBe(`${year}-01-01`);
      expect(days[n - 1]!.key).toBe(`${year}-12-31`);
      for (let i = 1; i < n; i += 1) expect(days[i]!.jd_start).toBe(days[i - 1]!.jd_end);
    }
  });

  it('makes the clock-change days 23 and 25 hours long, and only those', () => {
    const days = daysOfYear(NEW_YORK, 2026);
    const odd = days.filter((d) => d.hours !== 24).map((d) => [d.key, d.hours]);
    expect(odd).toEqual([
      ['2026-03-08', 23],
      ['2026-11-01', 25],
    ]);
    expect(days.filter(hasClockChange).map((d) => d.key)).toEqual(['2026-03-08', '2026-11-01']);
  });

  it('agrees with time.ts dayWindow, including where the clocks change at midnight', () => {
    const cases: [Zone, number][] = [
      [NEW_YORK, jdUtc(2026, 3, 8, 12)],
      [NEW_YORK, jdUtc(2026, 11, 1, 12)],
      [SANTIAGO, jdUtc(2026, 9, 6, 15)], // Chile: clocks go forward at 24:00 (Sep 5 -> 6)
      [SANTIAGO, jdUtc(2026, 4, 5, 15)], // and back at 24:00 (Apr 4 -> 5)
      [SYDNEY, jdUtc(2026, 10, 4, 3)],
      [ZD5, jdUtc(2026, 9, 24, 12)],
      [UTC, jdUtc(2026, 9, 24, 12)],
    ];
    for (const [zone, jd] of cases) {
      const mine = localDayAt(jd, zone);
      const theirs = timeDayWindow(jd, zone);
      expect([mine.jd_start, mine.jd_end]).toEqual(theirs);
      expect(jd >= mine.jd_start && jd < mine.jd_end).toBe(true);
    }
  });

  it('starts the Chilean spring-forward day at 01:00, the first instant that exists', () => {
    const day = localDay(SANTIAGO, { year: 2026, month: 9, day: 6 });
    expect(formatTime(day.jd_start, SANTIAGO)).toBe('01:00');
    expect(day.hours).toBe(23);
  });

  it('lists a month and knows the calendar', () => {
    expect(daysOfMonth(NEW_YORK, 2026, 2)).toHaveLength(28);
    expect(daysOfMonth(NEW_YORK, 2028, 2)).toHaveLength(29);
    expect(daysInMonth(2026, 9)).toBe(30);
    expect(dayOfYear({ year: 2026, month: 12, day: 31 })).toBe(364);
    expect(dateKey({ year: 2026, month: 9, day: 4 })).toBe('2026-09-04');
  });

  it('finds every midnight exactly as geo/timezone.ts does, in zones with awkward rules', () => {
    // Lord Howe changes by 30 minutes; Casablanca suspends summer time for Ramadan; Chile
    // changes at midnight; Kathmandu is UTC+5:45; Tehran has no DST since 2022.
    const zones = ['America/New_York', 'America/Santiago', 'Australia/Lord_Howe', 'Africa/Casablanca', 'Asia/Kathmandu', 'Asia/Tehran', 'Europe/London'];
    for (const id of zones) {
      const zone: Zone = { kind: 'iana', zone: id };
      const days = daysOfYear(zone, 2026);
      for (const d of days) {
        const exact = startOfLocalDay({ kind: 'iana', id }, d.date);
        const next = startOfLocalDay({ kind: 'iana', id }, addDays(d.date, 1));
        expect([d.key, d.jd_start, d.jd_end]).toEqual([d.key, jdFromUnixMs(exact), jdFromUnixMs(next)]);
      }
    }
  });

  it('caches window lists (they cost Intl calls) and freezes them', () => {
    const a = daysOfYear(SYDNEY, 2026);
    expect(daysOfYear(SYDNEY, 2026)).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('wall-clock positions', () => {
  it('reads the clock, not the elapsed time, on the day the clocks go forward', () => {
    const day = localDay(NEW_YORK, { year: 2026, month: 3, day: 8 });
    // 03:30 EDT is 07:30 UTC: 2.5 hours after local midnight, but the clock says 3.5.
    const jd = jdUtc(2026, 3, 8, 7, 30);
    expect((jd - day.jd_start) * 24).toBeCloseTo(2.5, 6);
    expect(wallHours(day, jd, NEW_YORK)).toBeCloseTo(3.5, 6);
    expect(wallHours(day, day.jd_end, NEW_YORK)).toBeCloseTo(24, 6);
  });

  it('reads the clock on the day the clocks go back (the repeated hour folds)', () => {
    const day = localDay(NEW_YORK, { year: 2026, month: 11, day: 1 });
    // 01:30 EST (second time round) is 06:30 UTC: 2.5 hours after midnight on the clock.
    expect(wallHours(day, jdUtc(2026, 11, 1, 6, 30), NEW_YORK)).toBeCloseTo(1.5, 6);
    expect(wallHours(day, day.jd_end, NEW_YORK)).toBeCloseTo(24, 6);
  });

  it('is plain elapsed time on an ordinary day', () => {
    const day = localDay(NEW_YORK, { year: 2026, month: 9, day: 24 });
    expect(wallHours(day, day.jd_start + 6.5 * HOUR, NEW_YORK)).toBeCloseTo(6.5, 6);
  });

  it('finds the instant and the size of a clock change', () => {
    const spring = clockChangeIn(localDay(NEW_YORK, { year: 2026, month: 3, day: 8 }), NEW_YORK)!;
    expect(spring.jd).toBe(jdUtc(2026, 3, 8, 7)); // 02:00 EST
    expect(spring.toOffsetMs - spring.fromOffsetMs).toBe(3_600_000);
    const fall = clockChangeIn(localDay(NEW_YORK, { year: 2026, month: 11, day: 1 }), NEW_YORK)!;
    expect(fall.jd).toBe(jdUtc(2026, 11, 1, 6)); // 02:00 EDT
    expect(fall.toOffsetMs - fall.fromOffsetMs).toBe(-3_600_000);
    expect(clockChangeIn(localDay(NEW_YORK, { year: 2026, month: 9, day: 24 }), NEW_YORK)).toBeNull();
  });

  it('turns a date and clock hours (past 24 too) into an instant', () => {
    const date = { year: 2026, month: 9, day: 24 };
    expect(jdAtWallHours(date, 6.5, NEW_YORK)).toBe(jdUtc(2026, 9, 24, 10, 30));
    expect(jdAtWallHours(date, 26.25, NEW_YORK)).toBe(jdUtc(2026, 9, 25, 6, 15));
  });
});

describe('nights', () => {
  it('runs from local noon to the next local noon', () => {
    const nights = localNights(NEW_YORK, { year: 2026, month: 9, day: 24 }, 3);
    expect(nights.map((n) => n.key)).toEqual(['2026-09-24', '2026-09-25', '2026-09-26']);
    expect(nights[0]!.jd_start).toBe(jdUtc(2026, 9, 24, 16)); // 12:00 EDT
    expect(nights[0]!.jd_end).toBe(nights[1]!.jd_start);
    expect(hoursAfterNoon(nights[0]!, jdUtc(2026, 9, 25, 4), NEW_YORK)).toBeCloseTo(12, 6); // midnight
  });

  it('keeps clock hours across the night the clocks go back', () => {
    const [night] = localNights(NEW_YORK, { year: 2026, month: 10, day: 31 }, 1);
    expect((night!.jd_end - night!.jd_start) * 24).toBeCloseTo(25, 6);
    // 06:00 EST on 1 November is 18 clock hours after noon, though 19 hours have passed.
    expect(hoursAfterNoon(night!, jdUtc(2026, 11, 1, 11), NEW_YORK)).toBeCloseTo(18, 6);
  });

  it('builds nights from days without extra zone lookups, the same as from dates', () => {
    const days = daysOfYear(NEW_YORK, 2026);
    const a = nightsFromDays(days.slice(60, 70), NEW_YORK);
    const b = localNights(NEW_YORK, days[60]!.date, 9);
    expect(a).toEqual(b);
  });

  it('assigns a moment before noon to the previous evening’s night', () => {
    expect(nightDateOf(jdUtc(2026, 9, 25, 8), NEW_YORK)).toEqual({ year: 2026, month: 9, day: 24 }); // 04:00 EDT
    expect(nightDateOf(jdUtc(2026, 9, 25, 20), NEW_YORK)).toEqual({ year: 2026, month: 9, day: 25 });
  });
});

describe('intervals', () => {
  it('intersects sorted lists', () => {
    expect(
      intersectIntervals(
        [
          [0, 2],
          [3, 6],
        ],
        [
          [1, 4],
          [5, 9],
        ],
      ),
    ).toEqual([
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(intersectIntervals([[0, 1]], [[1, 2]])).toEqual([]);
  });

  it('merges touching and overlapping intervals and drops empty ones', () => {
    expect(
      mergeIntervals([
        [5, 6],
        [0, 1],
        [1, 2],
        [1.5, 3],
        [4, 4],
      ]),
    ).toEqual([
      [0, 3],
      [5, 6],
    ]);
    expect(intervalsLength([
      [0, 3],
      [5, 6],
    ])).toBe(4);
  });
});
