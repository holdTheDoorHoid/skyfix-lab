/**
 * The TypeScript geometry port must agree with `skyfix_core::geometry`. These cases are
 * the same analytic ones the Rust unit tests use, so the two implementations cannot
 * drift apart silently.
 */
import { describe, expect, it } from 'vitest';
import {
  altitudeAzimuthDeg,
  angularDistance,
  circleOfPosition,
  destination,
  geographicPosition,
  norm180Deg,
  pointFromDeg,
  twoCircleIntersections,
} from '../src/geometry.js';

describe('geographic position of a body', () => {
  it('maps declination to latitude and −GHA to east longitude', () => {
    const gp = geographicPosition(200, -12);
    expect(gp.lat_deg).toBeCloseTo(-12, 12);
    expect(gp.lon_deg).toBeCloseTo(160, 12);
  });

  it('normalises to (-180, 180]', () => {
    expect(norm180Deg(-180)).toBe(180);
    expect(norm180Deg(190)).toBe(-170);
  });
});

describe('altitude and azimuth', () => {
  it('puts a body at the zenith when its GP is the observer', () => {
    const { altitude_deg } = altitudeAzimuthDeg({ lat_deg: 39.9526, lon_deg: -75.1652 }, 75.1652, 39.9526);
    expect(altitude_deg).toBeCloseTo(90, 9);
  });

  it('gives Zn 0 north of the zenith and 180 south of it', () => {
    const north = altitudeAzimuthDeg({ lat_deg: 40, lon_deg: -75 }, 75, 60);
    expect(north.altitude_deg).toBeCloseTo(70, 9);
    expect(north.azimuth_deg).toBeCloseTo(0, 9);
    const south = altitudeAzimuthDeg({ lat_deg: 40, lon_deg: -75 }, 75, 10);
    expect(south.altitude_deg).toBeCloseTo(60, 9);
    expect(south.azimuth_deg).toBeCloseTo(180, 9);
  });

  it('puts a westerly body at Zn 270 (GHA is west-positive)', () => {
    const west = altitudeAzimuthDeg({ lat_deg: 0, lon_deg: 0 }, 30, 0);
    expect(west.altitude_deg).toBeCloseTo(60, 9);
    expect(west.azimuth_deg).toBeCloseTo(270, 9);
    const east = altitudeAzimuthDeg({ lat_deg: 0, lon_deg: 0 }, 330, 0);
    expect(east.azimuth_deg).toBeCloseTo(90, 9);
  });

  it('matches the spherical triangle for an off-meridian case', () => {
    const d = Math.PI / 180;
    const expected =
      Math.sin(40 * d) * Math.sin(20 * d) + Math.cos(40 * d) * Math.cos(20 * d) * Math.cos(25 * d);
    const { altitude_deg, azimuth_deg } = altitudeAzimuthDeg({ lat_deg: 40, lon_deg: -75 }, 100, 20);
    expect(Math.sin(altitude_deg * d)).toBeCloseTo(expected, 12);
    expect(azimuth_deg).toBeGreaterThan(180);
    expect(azimuth_deg).toBeLessThan(270);
  });
});

describe('circle of position', () => {
  it('places every point at the zenith distance from the GP', () => {
    const gp = { lat_deg: 38.79, lon_deg: -123.45 };
    const centre = pointFromDeg(gp.lat_deg, gp.lon_deg);
    for (const p of circleOfPosition(gp, 40, 36)) {
      const d = (angularDistance(centre, pointFromDeg(p.lat_deg, p.lon_deg)) * 180) / Math.PI;
      expect(d).toBeCloseTo(40, 9);
    }
  });

  it('starts due north of the GP, matching the Rust ordering', () => {
    const first = circleOfPosition({ lat_deg: 0, lon_deg: 0 }, 10, 36)[0]!;
    expect(first.lat_deg).toBeCloseTo(10, 9);
    expect(first.lon_deg).toBeCloseTo(0, 9);
  });

  it('never returns fewer than three points', () => {
    expect(circleOfPosition({ lat_deg: 0, lon_deg: 0 }, 10, 1)).toHaveLength(3);
  });

  it('wraps longitude across the dateline', () => {
    const p = destination(pointFromDeg(0, 179.5), Math.PI / 2, (1 * Math.PI) / 180);
    expect((p.lon * 180) / Math.PI).toBeCloseTo(-179.5, 9);
  });
});

describe('two circle intersections', () => {
  it('finds the symmetric pair for two equal circles', () => {
    const pair = twoCircleIntersections({ lat_deg: 0, lon_deg: 0 }, 60, { lat_deg: 0, lon_deg: 90 }, 60);
    expect(pair).not.toBeNull();
    const lats = pair!.map((p) => p.lat_deg).sort((a, b) => a - b);
    expect(lats[0]).toBeCloseTo(-45, 8);
    expect(lats[1]).toBeCloseTo(45, 8);
    for (const p of pair!) expect(p.lon_deg).toBeCloseTo(45, 8);
  });

  it('returns null for circles that do not meet', () => {
    expect(
      twoCircleIntersections({ lat_deg: 0, lon_deg: 0 }, 30, { lat_deg: 0, lon_deg: 90 }, 30),
    ).toBeNull();
  });

  it('returns null for concentric circles', () => {
    expect(
      twoCircleIntersections({ lat_deg: 10, lon_deg: 20 }, 30, { lat_deg: 10, lon_deg: 20 }, 30),
    ).toBeNull();
  });
});
