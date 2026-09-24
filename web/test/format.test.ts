import { describe, expect, it } from 'vitest';
import {
  arcmin,
  degBoth,
  degMin,
  formatLat,
  formatLatLon,
  formatLon,
  formatUtc,
  magnitude,
  metres,
  metresBoth,
  splitDegMin,
} from '../src/format.js';

describe('degrees and arcminutes', () => {
  it('renders the worked example from the brief', () => {
    // 39.9526 deg = 39 deg 57.156' -> 57.2' at one decimal.
    expect(degMin(39.9526)).toBe('39° 57.2′');
  });

  it('keeps the sign in front for a plain angle', () => {
    expect(degMin(-75.1652)).toBe('-75° 09.9′');
  });

  it('pads minutes below ten', () => {
    expect(degMin(5.05)).toBe('5° 03.0′');
    expect(degMin(0.01, 2)).toBe('0° 00.60′');
  });

  it('carries 59.96 arcminutes into the next degree instead of printing 60', () => {
    // 12.99934 deg = 12 deg 59.9604' -> rounds to 60.0, which must become 13 00.0.
    expect(splitDegMin(12.99934, 1)).toEqual({ deg: 13, min: 0 });
    expect(degMin(12.99934)).toBe('13° 00.0′');
  });

  it('shows the decimal and the minute form together', () => {
    expect(degBoth(39.9526)).toBe('39.9526° (39° 57.2′)');
  });

  it('handles non-finite input without throwing', () => {
    expect(degMin(Number.NaN)).toBe('NaN');
    expect(degBoth(Number.POSITIVE_INFINITY)).toBe('Infinity');
  });
});

describe('latitude and longitude', () => {
  it('uses hemisphere letters, never a bare sign', () => {
    expect(formatLat(39.9526)).toBe('39° 57.2′ N');
    expect(formatLat(-33.8688)).toBe('33° 52.1′ S');
  });

  it('treats longitude as east-positive and labels W for negatives', () => {
    expect(formatLon(-75.1652)).toBe('075° 09.9′ W');
    expect(formatLon(151.2093)).toBe('151° 12.6′ E');
  });

  it('pads longitude degrees to three digits', () => {
    expect(formatLon(-0.1278)).toBe('000° 07.7′ W');
  });

  it('joins both parts', () => {
    expect(formatLatLon({ lat_deg: 39.9526, lon_deg: -75.1652 })).toBe(
      '39° 57.2′ N, 075° 09.9′ W',
    );
  });
});

describe('small angles and distances', () => {
  it('signs arcminutes explicitly', () => {
    expect(arcmin(1.2)).toBe('+1.20′');
    expect(arcmin(-1.2)).toBe('−1.20′');
    expect(arcmin(0)).toBe('0.00′');
  });

  it('switches to kilometres above ten', () => {
    expect(metres(4.2)).toBe('4.2 m');
    expect(metres(431)).toBe('431 m');
    expect(metres(1257)).toBe('1.26 km');
    expect(metres(24000)).toBe('24.0 km');
  });

  it('offers nautical miles beside metres', () => {
    expect(metresBoth(1852)).toBe('1.85 km (1.00 NM)');
  });

  it('uses an exponent only for very large numbers', () => {
    expect(magnitude(1.44)).toBe('1.44');
    expect(magnitude(412)).toBe('412');
    expect(magnitude(1e7)).toBe('1.00e+7');
  });
});

describe('timestamps', () => {
  it('reformats RFC 3339 Z into a readable UTC stamp', () => {
    expect(formatUtc('2026-10-01T01:30:00Z')).toBe('2026-10-01 01:30:00 UTC');
  });

  it('echoes anything that is not RFC 3339 with a trailing Z', () => {
    expect(formatUtc('2026-10-01 01:30')).toBe('2026-10-01 01:30');
    expect(formatUtc('2026-10-01T01:30:00+02:00')).toBe('2026-10-01T01:30:00+02:00');
  });
});
