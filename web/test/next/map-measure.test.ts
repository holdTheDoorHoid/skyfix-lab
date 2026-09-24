/**
 * The measuring tool (web/src/next/map/measure.ts) and the map's number formats
 * (web/src/next/map/format.ts). Distances are checked against independent formulas on the
 * reference sphere (1′ of arc = 1 NM).
 */
import { describe, expect, it } from 'vitest';
import { formatAngle, formatBearing, formatDistance } from '../../src/next/map/format.js';
import { distanceText, measure, measureFeatures, measureText } from '../../src/next/map/measure.js';

const RAD = Math.PI / 180;
const PHL = { lat_deg: 39.9526, lon_deg: -75.1652 };
const LON = { lat_deg: 51.5074, lon_deg: -0.1278 };

function haversineNm(a: typeof PHL, b: typeof PHL): number {
  const h =
    Math.sin(((b.lat_deg - a.lat_deg) * RAD) / 2) ** 2 +
    Math.cos(a.lat_deg * RAD) * Math.cos(b.lat_deg * RAD) * Math.sin(((b.lon_deg - a.lon_deg) * RAD) / 2) ** 2;
  return (2 * Math.asin(Math.sqrt(h)) * 10800) / Math.PI;
}

describe('measure', () => {
  it('gives the great circle and the rhumb line between two places', () => {
    const m = measure(PHL, LON);
    expect(m.greatCircleNm).toBeCloseTo(haversineNm(PHL, LON), 6);
    // The rhumb line is longer, and its course is further east than the initial great-circle course.
    expect(m.rhumbNm).toBeGreaterThan(m.greatCircleNm);
    expect(m.greatCircleCourseDeg).toBeGreaterThan(40);
    expect(m.greatCircleCourseDeg).toBeLessThan(60);
    expect(m.rhumbCourseDeg).toBeGreaterThan(70);
    expect(m.rhumbCourseDeg).toBeLessThan(85);
  });

  it('writes both lines in plain words with the navigator’s terms', () => {
    const t = measureText(measure(PHL, LON), 'metric');
    expect(t.greatCircle).toMatch(/^Shortest route \(great circle\): 3 \d{3} NM · 5 \d{3} km, starting course 0\d\d\.\d°$/);
    expect(t.rhumb).toMatch(/^Constant course \(rhumb line\): /);
    expect(distanceText(100, 'imperial')).toBe('100 NM · 185 km · 115 mi');
  });

  it('draws both lines split at the antimeridian, and the two points', () => {
    const tokyo = { lat_deg: 35.68, lon_deg: 139.69 };
    const sf = { lat_deg: 37.77, lon_deg: -122.42 };
    const fc = measureFeatures(tokyo, sf);
    const gc = fc.features.filter((f) => f.properties!.kind === 'great-circle');
    const rhumb = fc.features.filter((f) => f.properties!.kind === 'rhumb');
    expect(gc).toHaveLength(2);
    expect(rhumb).toHaveLength(2);
    for (const f of [...gc, ...rhumb]) {
      for (const [lon] of (f.geometry as { coordinates: number[][] }).coordinates) expect(Math.abs(lon!)).toBeLessThanOrEqual(180);
    }
    expect(fc.features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties!.label)).toEqual(['A', 'B']);
    // One point only: no lines yet.
    expect(measureFeatures(tokyo, null).features).toHaveLength(1);
  });
});

describe('formats', () => {
  it('writes angles in each style', () => {
    expect(formatAngle(41.2881, 'dm')).toBe('41° 17.3′');
    expect(formatAngle(41.2881, 'dms')).toBe('41° 17′ 17″');
    expect(formatAngle(41.2881, 'decimal')).toBe('41.29°');
    expect(formatAngle(-0.5, 'dm')).toBe('−0° 30.0′');
    expect(formatAngle(59.99999, 'dm')).toBe('60° 00.0′');
    expect(formatAngle(Number.NaN, 'dm')).toBe('—');
  });

  it('writes bearings with three digits and never 360', () => {
    expect(formatBearing(51.3)).toBe('051°');
    expect(formatBearing(51.34, 1)).toBe('051.3°');
    expect(formatBearing(359.97)).toBe('000°');
    expect(formatBearing(-10)).toBe('350°');
  });

  it('groups thousands with a thin space', () => {
    expect(formatDistance(3012.4)).toBe('3 012');
    expect(formatDistance(8.44)).toBe('8.4');
    expect(formatDistance(0.423)).toBe('0.42');
  });
});
