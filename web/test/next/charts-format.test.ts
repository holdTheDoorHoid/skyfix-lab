/**
 * Charts: scales, text formatting (fast clocks against time.ts) and the Moon disc's
 * orientation (web/src/next/charts/{scale,format,disc}.ts).
 */
import { describe, expect, it } from 'vitest';
import { jdFromUnixMs } from '../../src/next/engine/types.js';
import { formatTime, UTC_ZONE, type Zone } from '../../src/next/time.js';
import { fallbackLimbFromUp, limbFromUp } from '../../src/next/charts/disc.js';
import {
  altitude,
  bearing,
  clockAt,
  clockUtcFast,
  compassPoint,
  dateLong,
  dateShort,
  hourLabel,
  offsetOn,
  signedOffsetChange,
  weekday,
} from '../../src/next/charts/format.js';
import { clamp, linearScale, pickStep, px, ticks } from '../../src/next/charts/scale.js';
import { daysOfYear, localNights } from '../../src/next/charts/windows.js';

const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
const KATHMANDU: Zone = { kind: 'iana', zone: 'Asia/Kathmandu' };

describe('scales', () => {
  it('maps and inverts linearly, either way round', () => {
    const x = linearScale([0, 24], [40, 1000]);
    expect(x(0)).toBe(40);
    expect(x(12)).toBe(520);
    expect(x.invert(520)).toBe(12);
    const y = linearScale([-30, 90], [460, 40]);
    expect(y(90)).toBe(40);
    expect(y(0)).toBe(355);
    expect(y.invert(355)).toBeCloseTo(0, 12);
    expect(x.domain).toEqual([0, 24]);
    expect(y.range).toEqual([460, 40]);
  });

  it('does not divide by zero on an empty domain', () => {
    const z = linearScale([5, 5], [0, 100]);
    expect(z(5)).toBe(0);
    expect(z.invert(50)).toBe(5);
  });

  it('picks tick steps and lists ticks', () => {
    expect(pickStep(24, 8, [1, 2, 3, 6, 12])).toBe(3);
    expect(pickStep(24, 3, [1, 2, 3, 6, 12])).toBe(12);
    expect(pickStep(24, 1, [3, 6])).toBe(6);
    expect(ticks(-30, 90, 30)).toEqual([-30, 0, 30, 60, 90]);
    expect(ticks(0.1, 0.9, 0.2)).toEqual([0.2, 0.4, 0.6, 0.8]);
    expect(ticks(5, 1, 1)).toEqual([]);
    expect(clamp(5, 0, 3)).toBe(3);
    expect(px(1.23456)).toBe(1.23);
  });
});

describe('text', () => {
  it('writes altitudes in each angle format with a true minus sign', () => {
    expect(altitude(42.3104, 'dm')).toBe('42° 19′');
    expect(altitude(-0.4, 'dm')).toBe('−0° 24′');
    expect(altitude(-0.004, 'dm')).toBe('0° 00′');
    expect(altitude(59.9999, 'dm')).toBe('60° 00′');
    expect(altitude(42.3104, 'dms')).toBe('42° 18′ 37″');
    expect(altitude(-12.5, 'decimal')).toBe('−12.50°');
    expect(altitude(Number.NaN, 'dm')).toBe('—');
  });

  it('names bearings on 16 points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(221)).toBe('SW');
    expect(compassPoint(-90)).toBe('W');
    expect(bearing(359.6)).toBe('0° N');
    expect(bearing(101.2)).toBe('101° E');
    expect(bearing(105)).toBe('105° ESE');
  });

  it('writes dates, hours and clock changes', () => {
    const d = { year: 2026, month: 9, day: 24 };
    expect(weekday(d)).toBe(4);
    expect(dateShort(d)).toBe('Thu 24 Sep 2026');
    expect(dateLong(d)).toBe('Thursday 24 September 2026');
    expect(hourLabel(18)).toBe('18:00');
    expect(hourLabel(26, true)).toBe('02');
    expect(signedOffsetChange(3_600_000)).toBe('+1 h');
    expect(signedOffsetChange(-3_600_000)).toBe('−1 h');
    expect(signedOffsetChange(1_800_000)).toBe('+30 min');
  });

  it('gives exactly what formatTime gives, without Intl, over a year with clock changes', () => {
    for (const zone of [NEW_YORK, KATHMANDU]) {
      const days = daysOfYear(zone, 2026);
      for (const day of days) {
        for (const f of [0, 0.0000057, 0.1234567, 0.49999, 0.87654321, 0.99999]) {
          const jd = day.jd_start + f * (day.jd_end - day.jd_start);
          expect(clockAt(jd, offsetOn(day, jd, zone))).toBe(formatTime(jd, zone));
        }
      }
    }
    const jd = jdFromUnixMs(Date.UTC(2026, 8, 24, 10, 52, 59, 999));
    expect(clockUtcFast(jd)).toBe(`${formatTime(jd, UTC_ZONE)} UTC`);
  });

  it('knows the offset across a night the clocks change in', () => {
    const [night] = localNights(NEW_YORK, { year: 2026, month: 10, day: 31 }, 1);
    const evening = night!.jd_start + 0.3;
    const morning = night!.jd_end - 0.2;
    expect(offsetOn(night!, evening, NEW_YORK)).toBe(-4 * 3_600_000);
    expect(offsetOn(night!, morning, NEW_YORK)).toBe(-5 * 3_600_000);
  });
});

describe('Moon disc orientation', () => {
  it('points the bright limb as seen: north up in the north, south up in the south', () => {
    // A waxing Moon's bright limb faces west, position angle about 270: lit on the right
    // (270 counter-clockwise from up) with north up; on the left with south up.
    expect(limbFromUp(270, false)).toBe(270);
    expect(limbFromUp(270, true)).toBe(90);
    expect(limbFromUp(90, false)).toBe(90);
    expect(limbFromUp(300, true)).toBe(120);
    expect(limbFromUp(-10, false)).toBe(350);
    expect(fallbackLimbFromUp(true, false)).toBe(270);
    expect(fallbackLimbFromUp(false, false)).toBe(90);
    expect(fallbackLimbFromUp(true, true)).toBe(90);
  });
});
