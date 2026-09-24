/**
 * Time utilities: Julian Date conversion, zone arithmetic across daylight-saving
 * changes, calendar stepping and the "UTC beside local" formatting of CONVENTIONS 13.8.
 */
import { describe, expect, it } from 'vitest';
import {
  addCalendar,
  addDuration,
  dayWindow,
  formatDate,
  formatDateTime,
  formatHours,
  formatOffset,
  formatTime,
  formatWithUtc,
  isoUtc,
  isValidIanaZone,
  jdFromIso,
  jdFromMs,
  jdFromWallClock,
  msFromJd,
  nauticalZoneDescription,
  periodWindow,
  resolveZone,
  UTC_ZONE,
  wallClock,
  zoneAbbreviation,
  zoneLabel,
  zoneOffsetMs,
  type Zone,
} from '../../src/next/time.js';

const NY: Zone = { kind: 'iana', zone: 'America/New_York' };
const LONDON: Zone = { kind: 'iana', zone: 'Europe/London' };
const KOLKATA: Zone = { kind: 'iana', zone: 'Asia/Kolkata' };
const LORD_HOWE: Zone = { kind: 'iana', zone: 'Australia/Lord_Howe' };
const SYDNEY: Zone = { kind: 'iana', zone: 'Australia/Sydney' };

const jd = (iso: string): number => {
  const v = jdFromIso(iso);
  if (v === null) throw new Error(`bad test time ${iso}`);
  return v;
};
const hoursBetween = (a: number, b: number): number => (msFromJd(b) - msFromJd(a)) / 3_600_000;

describe('Julian Date conversion', () => {
  it('matches the EXPLORER_API definition at the Unix epoch and J2000', () => {
    expect(jdFromMs(0)).toBe(2_440_587.5);
    expect(jd('2000-01-01T12:00:00Z')).toBe(2_451_545.0);
  });

  it('round-trips to the millisecond with no drift', () => {
    const ms = Date.UTC(2026, 8, 24, 12, 34, 56, 789);
    expect(msFromJd(jdFromMs(ms))).toBe(ms);
    expect(isoUtc(jdFromMs(ms))).toBe('2026-09-24T12:34:56.789Z');
  });

  it('parses only RFC 3339 UTC with a trailing Z', () => {
    expect(jdFromIso('2026-10-01T01:30:00Z')).toBe(jdFromMs(Date.UTC(2026, 9, 1, 1, 30)));
    expect(jdFromIso('2026-10-01T01:30Z')).toBe(jdFromMs(Date.UTC(2026, 9, 1, 1, 30)));
    expect(jdFromIso('2026-10-01T01:30:00.5Z')).toBe(jdFromMs(Date.UTC(2026, 9, 1, 1, 30, 0, 500)));
    expect(jdFromIso('2026-10-01T01:30:00+01:00')).toBeNull();
    expect(jdFromIso('2026-02-30T00:00:00Z')).toBeNull();
    expect(jdFromIso('2026-10-01 01:30:00Z')).toBeNull();
    expect(jdFromIso('yesterday')).toBeNull();
  });

  it('keeps two-digit years as years, not 19xx', () => {
    expect(isoUtc(jd('0050-06-01T00:00:00Z'))).toBe('0050-06-01T00:00:00.000Z');
  });
});

describe('zones', () => {
  it('reads New York wall clocks in winter and summer', () => {
    const winter = wallClock(jd('2026-01-15T17:00:00Z'), NY);
    expect([winter.hour, winter.offsetMs]).toEqual([12, -5 * 3_600_000]);
    const summer = wallClock(jd('2026-07-15T16:00:00Z'), NY);
    expect([summer.hour, summer.offsetMs]).toEqual([12, -4 * 3_600_000]);
  });

  it('handles half-hour and forty-five-minute offsets', () => {
    expect(zoneOffsetMs(Date.UTC(2026, 0, 1), KOLKATA)).toBe(5.5 * 3_600_000);
    const chatham: Zone = { kind: 'iana', zone: 'Pacific/Chatham' };
    expect(formatOffset(zoneOffsetMs(Date.UTC(2026, 6, 1), chatham))).toBe('UTC+12:45');
  });

  it('computes the nautical zone description (75 W is ZD +5)', () => {
    expect(nauticalZoneDescription(-75.17)).toBe(5);
    expect(nauticalZoneDescription(0)).toBe(0);
    expect(nauticalZoneDescription(3)).toBe(0);
    expect(nauticalZoneDescription(151.2)).toBe(-10);
    expect(nauticalZoneDescription(180)).toBe(-12);
    expect(nauticalZoneDescription(-179)).toBe(12);
    expect(Object.is(nauticalZoneDescription(7), -0)).toBe(false);
    const zone = resolveZone({ kind: 'nautical' }, -75.17);
    expect(zone).toEqual({ kind: 'fixed', offsetMs: -5 * 3_600_000, name: 'ZD +5' });
    // Zone time + ZD = UTC.
    expect(formatTime(jd('2026-09-24T12:00:00Z'), zone)).toBe('07:00');
    expect(resolveZone({ kind: 'nautical' }, 151.2)).toMatchObject({ name: 'ZD −10' });
  });

  it('falls back to UTC for an unknown IANA name instead of throwing', () => {
    expect(isValidIanaZone('America/New_York')).toBe(true);
    expect(isValidIanaZone('Mars/Olympus_Mons')).toBe(false);
    expect(resolveZone({ kind: 'iana', zone: 'Mars/Olympus_Mons' }, 0)).toEqual(UTC_ZONE);
    expect(resolveZone({ kind: 'utc' }, -75)).toEqual(UTC_ZONE);
  });

  it('labels zones with an abbreviation where the browser has one', () => {
    const t = jd('2026-09-24T12:00:00Z');
    expect(zoneAbbreviation(t, NY)).toBe('EDT');
    expect(zoneLabel(t, NY)).toBe('America/New_York · EDT (UTC−4)');
    expect(zoneLabel(t, UTC_ZONE)).toBe('UTC');
    expect(zoneLabel(t, resolveZone({ kind: 'nautical' }, -75))).toBe('ZD +5 (UTC−5)');
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(3_600_000)).toBe('UTC+1');
    expect(formatOffset(-(4 * 3_600_000 + 56 * 60_000 + 2_000))).toBe('UTC−4:56:02');
  });
});

describe('wall clock to instant across daylight saving', () => {
  it('maps a normal local time to one instant', () => {
    expect(isoUtc(jdFromWallClock({ year: 2026, month: 9, day: 24, hour: 8 }, NY))).toBe(
      '2026-09-24T12:00:00.000Z',
    );
  });

  it('moves a time in the spring-forward gap forward by the gap', () => {
    // 2026-03-08 02:30 does not exist in New York; the clock jumps 02:00 -> 03:00.
    const t = jdFromWallClock({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY);
    expect(isoUtc(t)).toBe('2026-03-08T07:30:00.000Z');
    expect(formatTime(t, NY)).toBe('03:30');
  });

  it('takes the earlier instant of a repeated fall-back time', () => {
    // 2026-11-01 01:30 happens twice in New York: 05:30 UTC (EDT) and 06:30 UTC (EST).
    const t = jdFromWallClock({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, NY);
    expect(isoUtc(t)).toBe('2026-11-01T05:30:00.000Z');
  });

  it('handles the half-hour daylight saving of Lord Howe Island', () => {
    // Lord Howe: +10:30 standard, +11 summer; 2026-10-04 02:00 -> 02:30.
    const t = jdFromWallClock({ year: 2026, month: 10, day: 4, hour: 2, minute: 15 }, LORD_HOWE);
    expect(formatTime(t, LORD_HOWE)).toBe('02:45');
  });
});

describe('calendar stepping', () => {
  it('keeps the clock time across spring forward (a 23-hour day)', () => {
    const start = jdFromWallClock({ year: 2026, month: 3, day: 7, hour: 12 }, NY);
    const next = addCalendar(start, NY, { days: 1 });
    expect(formatDateTime(next, NY)).toBe('2026-03-08 12:00');
    expect(hoursBetween(start, next)).toBe(23);
  });

  it('keeps the clock time across fall back (a 25-hour day)', () => {
    const start = jdFromWallClock({ year: 2026, month: 10, day: 31, hour: 12 }, NY);
    const next = addCalendar(start, NY, { days: 1 });
    expect(formatDateTime(next, NY)).toBe('2026-11-01 12:00');
    expect(hoursBetween(start, next)).toBe(25);
    expect(addCalendar(next, NY, { days: -1 })).toBe(start);
  });

  it('steps in the southern hemisphere, where the changes run the other way', () => {
    const start = jdFromWallClock({ year: 2026, month: 4, day: 4, hour: 21 }, SYDNEY);
    const next = addCalendar(start, SYDNEY, { days: 1 });
    expect(formatDateTime(next, SYDNEY)).toBe('2026-04-05 21:00');
    expect(hoursBetween(start, next)).toBe(25);
  });

  it('clamps the day when stepping months and years', () => {
    const jan31 = jdFromWallClock({ year: 2027, month: 1, day: 31, hour: 9 }, LONDON);
    expect(formatDateTime(addCalendar(jan31, LONDON, { months: 1 }), LONDON)).toBe('2027-02-28 09:00');
    const leap = jdFromWallClock({ year: 2028, month: 2, day: 29, hour: 9 }, LONDON);
    expect(formatDate(addCalendar(leap, LONDON, { years: 1 }), LONDON)).toBe('2029-02-28');
    expect(formatDate(addCalendar(leap, LONDON, { years: 4 }), LONDON)).toBe('2032-02-29');
    expect(formatDate(addCalendar(jan31, LONDON, { months: -2 }), LONDON)).toBe('2026-11-30');
    expect(formatDate(addCalendar(jan31, LONDON, { months: 13 }), LONDON)).toBe('2028-02-29');
  });

  it('adds exact durations independent of zone', () => {
    const t = jd('2026-03-08T06:50:00Z');
    expect(isoUtc(addDuration(t, { minutes: 10 }))).toBe('2026-03-08T07:00:00.000Z');
    expect(isoUtc(addDuration(t, { hours: -1 }))).toBe('2026-03-08T05:50:00.000Z');
    let u = t;
    for (let i = 0; i < 10_000; i += 1) u = addDuration(u, { minutes: 10 });
    expect(msFromJd(u) - msFromJd(t)).toBe(10_000 * 600_000);
  });
});

describe('day windows', () => {
  it('runs from local midnight to local midnight', () => {
    const [a, b] = dayWindow(jd('2026-09-24T15:00:00Z'), NY);
    expect(isoUtc(a)).toBe('2026-09-24T04:00:00.000Z');
    expect(isoUtc(b)).toBe('2026-09-25T04:00:00.000Z');
  });

  it('is 23 or 25 hours long on the days the clocks change', () => {
    const [a, b] = dayWindow(jd('2026-03-08T15:00:00Z'), NY);
    expect(hoursBetween(a, b)).toBe(23);
    const [c, d] = dayWindow(jd('2026-11-01T15:00:00Z'), NY);
    expect(hoursBetween(c, d)).toBe(25);
  });

  it('covers months and years', () => {
    const [a, b] = periodWindow(jd('2026-02-10T12:00:00Z'), UTC_ZONE, 'month');
    expect([isoUtc(a), isoUtc(b)]).toEqual(['2026-02-01T00:00:00.000Z', '2026-03-01T00:00:00.000Z']);
    const [c, d] = periodWindow(jd('2026-06-10T12:00:00Z'), NY, 'year');
    expect([isoUtc(c), isoUtc(d)]).toEqual(['2026-01-01T05:00:00.000Z', '2027-01-01T05:00:00.000Z']);
  });

  it('a nautical zone day is exactly 24 hours', () => {
    const zone = resolveZone({ kind: 'nautical' }, -75);
    const [a, b] = dayWindow(jd('2026-03-08T15:00:00Z'), zone);
    expect(isoUtc(a)).toBe('2026-03-08T05:00:00.000Z');
    expect(hoursBetween(a, b)).toBe(24);
  });
});

describe('formatting with UTC beside local time', () => {
  it('shows both clocks, and the UTC date only when it differs', () => {
    expect(formatWithUtc(jd('2026-09-24T12:05:00Z'), NY)).toBe('2026-09-24 08:05 EDT · 12:05 UTC');
    expect(formatWithUtc(jd('2026-09-25T00:05:09Z'), NY, { seconds: true })).toBe(
      '2026-09-24 20:05:09 EDT · 2026-09-25 00:05:09 UTC',
    );
    expect(formatWithUtc(jd('2026-09-24T12:05:00Z'), UTC_ZONE)).toBe('2026-09-24 12:05 UTC');
  });

  it('formats durations', () => {
    expect(formatHours(12.08)).toBe('12 h 05 min');
    expect(formatHours(0.5)).toBe('30 min');
  });
});
