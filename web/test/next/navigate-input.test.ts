/**
 * Navigate view: reading what people type (sextant readings, UTC instants, numbers,
 * positions) and writing numbers back the way a navigator reads them. Every parser must
 * round-trip with its formatter, and every refusal must be a sentence.
 */
import { describe, expect, it } from 'vitest';
import {
  angleInputText,
  compassPoint,
  fmtAngle,
  fmtArcmin,
  fmtBearing,
  fmtMetresNm,
  fmtNum,
  fmtSeconds,
  fmtSigma,
  positionInputText,
  utcInputText,
} from '../../src/next/navigate/format.js';
import { parseAngle, parseNumber, parseOptionalNumber, parsePosition, parseUtcInput } from '../../src/next/navigate/parse.js';

const HS = { min: -90, max: 90, what: 'The sextant reading' };
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!r.ok) throw new Error(`expected a value, got: ${r.error}`);
  return r.value;
};

describe('parseAngle (sextant readings, degrees and decimal minutes)', () => {
  it('reads the navigator’s bare "degrees minutes" form', () => {
    expect(ok(parseAngle('45 54.0', HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle('45 54', HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle(' 7 03.5 ', HS))).toBeCloseTo(7 + 3.5 / 60, 12);
    expect(ok(parseAngle('45 54,5', HS))).toBeCloseTo(45 + 54.5 / 60, 12);
  });

  it('reads symbols, their look-alikes, seconds and decimal degrees', () => {
    expect(ok(parseAngle('45° 54.0′', HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle("45°54'", HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle('45º 54.0’', HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle('45° 54′ 30″', HS))).toBeCloseTo(45 + 54.5 / 60, 12);
    expect(ok(parseAngle('45.9', HS))).toBeCloseTo(45.9, 12);
    expect(ok(parseAngle('45d 54.0m', HS))).toBeCloseTo(45.9, 12);
  });

  it('keeps signs, including a true minus sign, and never returns -0', () => {
    expect(ok(parseAngle('-0 12.5', HS))).toBeCloseTo(-12.5 / 60, 12);
    expect(ok(parseAngle('−0 12.5', HS))).toBeCloseTo(-12.5 / 60, 12);
    expect(Object.is(ok(parseAngle('-0', HS)), -0)).toBe(false);
  });

  it('refuses hemisphere letters, ranges and nonsense with a sentence', () => {
    for (const bad of ['45 54.0 N', 'W 45', '45 54 E']) {
      const r = parseAngle(bad, HS);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/no north, south, east or west/);
    }
    const tooHigh = parseAngle('95 00', HS);
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.error).toMatch(/between -90° and 90°/);
    const minutes = parseAngle('45 61.0', HS);
    expect(minutes.ok).toBe(false);
    if (!minutes.ok) expect(minutes.error).toMatch(/less than 60/);
    const empty = parseAngle('  ', HS);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toMatch(/is empty/);
    expect(parseAngle('forty five', HS).ok).toBe(false);
  });

  it('lets a reflected artificial horizon read the double angle, up to 180°', () => {
    expect(ok(parseAngle('120 30.0', { min: 0, max: 180, what: 'The reading' }))).toBeCloseTo(120.5, 12);
    expect(parseAngle('120 30.0', HS).ok).toBe(false);
  });

  it('round-trips with angleInputText at two decimals of a minute', () => {
    for (const v of [0, 0.5, 45.9, 61.072473, 89.999, -12.25, 179.9]) {
      const text = angleInputText(v, 2);
      expect(ok(parseAngle(text, { min: -180, max: 180, what: 'x' }))).toBeCloseTo(v, 3);
    }
    expect(angleInputText(45.9999999, 1)).toBe('46 00.0');
    expect(angleInputText(71.0883333, 2)).toBe('71 05.30');
  });
});

describe('parseUtcInput', () => {
  it('reads the forms people type and returns RFC 3339 with Z', () => {
    expect(ok(parseUtcInput('2026-10-01 01:30:05'))).toBe('2026-10-01T01:30:05Z');
    expect(ok(parseUtcInput('2026-10-01T01:30:05Z'))).toBe('2026-10-01T01:30:05Z');
    expect(ok(parseUtcInput('2026-10-01 1:30'))).toBe('2026-10-01T01:30:00Z');
    expect(ok(parseUtcInput('2026-10-01 01:30:05.25'))).toBe('2026-10-01T01:30:05.25Z');
    expect(ok(parseUtcInput('2026-10-01 01:30:05 UTC'))).toBe('2026-10-01T01:30:05Z');
    expect(ok(parseUtcInput('2026-1-5 01:30:05'))).toBe('2026-01-05T01:30:05Z');
  });

  it('refuses offsets, impossible dates and other shapes', () => {
    const offset = parseUtcInput('2026-10-01T01:30:05+02:00');
    expect(offset.ok).toBe(false);
    if (!offset.ok) expect(offset.error).toMatch(/UTC/);
    expect(parseUtcInput('2026-02-30 01:00:00').ok).toBe(false);
    expect(parseUtcInput('2026-10-01 24:00:00').ok).toBe(false);
    expect(parseUtcInput('01:30').ok).toBe(false);
    expect(parseUtcInput('').ok).toBe(false);
  });

  it('round-trips with utcInputText', () => {
    for (const utc of ['2026-10-01T01:30:05Z', '2016-03-22T23:18:56Z', '2029-10-17T01:05:43.5Z']) {
      expect(ok(parseUtcInput(utcInputText(utc)))).toBe(utc);
    }
    expect(utcInputText('2026-09-23T16:52:57.000Z')).toBe('2026-09-23 16:52:57');
  });
});

describe('parseNumber and parsePosition', () => {
  it('reads numbers with a decimal comma and checks ranges', () => {
    expect(ok(parseNumber('2,5', { what: 'Height' }))).toBe(2.5);
    expect(ok(parseNumber(' −1.2 ', { what: 'IC' }))).toBe(-1.2);
    const zero = parseNumber('0', { what: 'The uncertainty', min: 0, exclusiveMin: true });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.error).toBe('The uncertainty must be more than 0.');
    expect(parseNumber('3 m', { what: 'Height' }).ok).toBe(false);
    expect(ok(parseOptionalNumber('   ', { what: 'x' }))).toBeNull();
  });

  it('reads positions in the navigator’s form, east-positive', () => {
    const p = ok(parsePosition('39 57.2 N, 075 09.9 W'));
    expect(p.lat_deg).toBeCloseTo(39 + 57.2 / 60, 10);
    expect(p.lon_deg).toBeCloseTo(-(75 + 9.9 / 60), 10);
    const q = ok(parsePosition('-33.8568, 151.2153'));
    expect(q).toEqual({ lat_deg: -33.8568, lon_deg: 151.2153 });
    expect(parsePosition('95 N, 10 E').ok).toBe(false);
    expect(parsePosition('').ok).toBe(false);
  });

  it('round-trips a position through positionInputText', () => {
    for (const p of [{ lat_deg: 39.9526, lon_deg: -75.1652 }, { lat_deg: -12.2, lon_deg: 128.5 }, { lat_deg: 0.001, lon_deg: 179.99 }]) {
      const back = ok(parsePosition(positionInputText(p)));
      expect(back.lat_deg).toBeCloseTo(p.lat_deg, 3);
      expect(back.lon_deg).toBeCloseTo(p.lon_deg, 3);
    }
  });
});

describe('formatting', () => {
  it('writes angles in the three formats, carrying 59.96′ into the next degree', () => {
    expect(fmtAngle(45.9)).toBe('45° 54.0′');
    expect(fmtAngle(45.9994)).toBe('46° 00.0′');
    expect(fmtAngle(-0.2723)).toBe('−0° 16.3′');
    expect(fmtAngle(-0.00001)).toBe('0° 00.0′');
    expect(fmtAngle(45.9, 'dms')).toBe('45° 54′ 00″');
    expect(fmtAngle(45.9, 'decimal')).toBe('45.9000°');
    expect(fmtAngle(40, 'dm', 0)).toBe('40° 00′');
    expect(fmtAngle(Number.NaN)).toBe('—');
  });

  it('writes corrections, sigmas, bearings, times and distances', () => {
    expect(fmtArcmin(0.2)).toBe('+0.2′');
    expect(fmtArcmin(-8.013, 1)).toBe('−8.0′');
    expect(fmtArcmin(-0.01, 1)).toBe('0.0′');
    expect(fmtSigma(0.1094)).toBe('±0.11′');
    expect(fmtBearing(359.8)).toBe('000° N');
    expect(fmtBearing(146.2)).toBe('146° SE');
    expect(compassPoint(247.5)).toBe('WSW');
    expect(fmtSeconds(6.98)).toBe('7.0 s');
    expect(fmtSeconds(581.6)).toBe('9 min 42 s');
    expect(fmtSeconds(-12.5)).toBe('−13 s');
    expect(fmtSeconds(7384)).toBe('2 h 03 min');
    expect(fmtMetresNm(1852)).toBe('1.85 km (1.00 NM)');
    expect(fmtMetresNm(null)).toBe('no finite value');
    expect(fmtNum(-0.0001, 1)).toBe('0.0');
    expect(fmtNum(-2.345, 2)).toBe('−2.35');
  });
});
