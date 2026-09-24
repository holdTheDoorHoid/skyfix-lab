/**
 * Distances and courses on the reference sphere (CONVENTIONS section 1: 1′ of arc = 1 NM =
 * 1852 m exactly). Expected values come from independent formulas (unit vectors, the
 * Mercator projection) or from exact geometry, never from the code under test.
 */
import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  NM_PER_RADIAN,
  destinationPoint,
  finalCourseDeg,
  greatCircleDistanceM,
  greatCircleDistanceNm,
  greatCirclePoints,
  initialCourseDeg,
  intermediatePoint,
  normalizeLon,
  pathLengthNm,
  rhumbCourseDeg,
  rhumbDestination,
  rhumbDistanceNm,
  rhumbPoints,
  splitAtAntimeridian,
  unwrapLongitudes,
} from '../../src/next/geo/greatcircle.js';

const P = (lat_deg: number, lon_deg: number) => ({ lat_deg, lon_deg });
const RAD = Math.PI / 180;

/** Independent: angle between unit vectors, in NM. */
function vectorDistanceNm(a: { lat_deg: number; lon_deg: number }, b: { lat_deg: number; lon_deg: number }): number {
  const v = (p: typeof a) => [Math.cos(p.lat_deg * RAD) * Math.cos(p.lon_deg * RAD), Math.cos(p.lat_deg * RAD) * Math.sin(p.lon_deg * RAD), Math.sin(p.lat_deg * RAD)];
  const [x1, y1, z1] = v(a) as [number, number, number];
  const [x2, y2, z2] = v(b) as [number, number, number];
  const cross = Math.hypot(y1 * z2 - z1 * y2, z1 * x2 - x1 * z2, x1 * y2 - y1 * x2);
  return Math.atan2(cross, x1 * x2 + y1 * y2 + z1 * z2) * (10800 / Math.PI);
}

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

const JFK = P(40.6413, -73.7781);
const LHR = P(51.47, -0.4543);
const SYD = P(-33.8688, 151.2093);
const SCL = P(-33.4489, -70.6693);

describe('the reference sphere', () => {
  it('has 1852 m per arcminute', () => {
    expect(EARTH_RADIUS_M).toBeCloseTo(6_366_707.0194937, 6);
    expect(NM_PER_RADIAN).toBeCloseTo(3437.7467707849, 9);
    expect(greatCircleDistanceNm(P(0, 0), P(1 / 60, 0))).toBeCloseTo(1, 12);
    expect(greatCircleDistanceM(P(0, 0), P(1 / 60, 0))).toBeCloseTo(1852, 7);
  });

  it('one degree of latitude or of equator is 60 NM; a quarter circle 5400; half 10800', () => {
    expect(greatCircleDistanceNm(P(10, 20), P(11, 20))).toBeCloseTo(60, 10);
    expect(greatCircleDistanceNm(P(0, 20), P(0, 21))).toBeCloseTo(60, 10);
    expect(greatCircleDistanceNm(P(0, 0), P(90, 0))).toBeCloseTo(5400, 9);
    expect(greatCircleDistanceNm(P(0, 0), P(0, 180))).toBeCloseTo(10800, 9);
    expect(greatCircleDistanceNm(P(0, 0), P(0, 0))).toBe(0);
  });

  it('agrees with the vector formula on long routes, both ways', () => {
    for (const [a, b] of [[JFK, LHR], [SYD, SCL], [LHR, SYD], [P(89.9, 10), P(-89.9, -170)]] as const) {
      expect(greatCircleDistanceNm(a, b)).toBeCloseTo(vectorDistanceNm(a, b), 8);
      expect(greatCircleDistanceNm(b, a)).toBeCloseTo(greatCircleDistanceNm(a, b), 9);
    }
    // JFK to Heathrow on this sphere: about 2 990 NM.
    expect(greatCircleDistanceNm(JFK, LHR)).toBeGreaterThan(2980);
    expect(greatCircleDistanceNm(JFK, LHR)).toBeLessThan(3000);
  });

  it('is accurate for a few metres', () => {
    const a = P(39.9526, -75.1652);
    const b = destinationPoint(a, 45, 0.001); // 1.852 m
    expect(greatCircleDistanceM(a, b)).toBeCloseTo(1.852, 9);
  });
});

describe('courses', () => {
  it('cardinal directions', () => {
    expect(initialCourseDeg(P(0, 0), P(10, 0))).toBeCloseTo(0, 12);
    expect(initialCourseDeg(P(0, 0), P(0, 10))).toBeCloseTo(90, 12);
    expect(initialCourseDeg(P(10, 0), P(0, 0))).toBeCloseTo(180, 12);
    expect(initialCourseDeg(P(0, 0), P(0, -10))).toBeCloseTo(270, 12);
  });

  it('crosses the antimeridian the short way', () => {
    expect(initialCourseDeg(P(0, 179), P(0, -179))).toBeCloseTo(90, 10);
    expect(greatCircleDistanceNm(P(0, 179), P(0, -179))).toBeCloseTo(120, 9);
    expect(initialCourseDeg(P(0, -179), P(0, 179))).toBeCloseTo(270, 10);
  });

  it('is NaN where no course exists', () => {
    expect(initialCourseDeg(P(10, 10), P(10, 10))).toBeNaN();
    expect(initialCourseDeg(P(10, 10), P(-10, -170))).toBeNaN();
    expect(finalCourseDeg(P(10, 10), P(10, 10))).toBeNaN();
  });

  it('from the poles: due south from the North Pole, due north from the South Pole', () => {
    expect(initialCourseDeg(P(90, 0), P(40, -75))).toBe(180);
    expect(initialCourseDeg(P(-90, 0), P(40, -75))).toBe(0);
  });

  it('the final course is the course of the last small step', () => {
    for (const [a, b] of [[JFK, LHR], [SYD, SCL], [P(0, 0), P(0, 90)]] as const) {
      const nearEnd = intermediatePoint(a, b, 1 - 1e-7);
      expect(angleDiff(finalCourseDeg(a, b), initialCourseDeg(nearEnd, b))).toBeLessThan(1e-4);
    }
    // Along the equator the course never changes.
    expect(finalCourseDeg(P(0, 0), P(0, 90))).toBeCloseTo(90, 9);
  });

  it('destination(a, course(a, b), distance(a, b)) lands on b', () => {
    for (const [a, b] of [[JFK, LHR], [SYD, SCL], [LHR, SYD], [P(-60, 170), P(-55, -160)]] as const) {
      const d = destinationPoint(a, initialCourseDeg(a, b), greatCircleDistanceNm(a, b));
      expect(greatCircleDistanceNm(d, b)).toBeLessThan(1e-6);
    }
  });

  it('destination keeps longitude in (-180, 180]', () => {
    const d = destinationPoint(P(0, 179.5), 90, 60);
    expect(d.lon_deg).toBeCloseTo(-179.5, 9);
    expect(d.lat_deg).toBeCloseTo(0, 9);
  });
});

describe('points along a great circle', () => {
  it('interpolate on the arc', () => {
    expect(intermediatePoint(P(0, 0), P(0, 90), 0.5)).toEqual({ lat_deg: 0, lon_deg: 45 });
    const mid = intermediatePoint(JFK, LHR, 0.5);
    expect(greatCircleDistanceNm(JFK, mid)).toBeCloseTo(greatCircleDistanceNm(JFK, LHR) / 2, 7);
    expect(greatCircleDistanceNm(mid, LHR)).toBeCloseTo(greatCircleDistanceNm(JFK, LHR) / 2, 7);
    // A great-circle route from New York to London bulges north of both ends.
    expect(mid.lat_deg).toBeGreaterThan(51.47);
  });

  it('greatCirclePoints includes both ends and steps no more than 60 NM by default', () => {
    const pts = greatCirclePoints(JFK, LHR);
    expect(pts[0]).toMatchObject({ lat_deg: expect.closeTo(JFK.lat_deg, 9), lon_deg: expect.closeTo(JFK.lon_deg, 9) });
    expect(pts[pts.length - 1]).toMatchObject({ lat_deg: expect.closeTo(LHR.lat_deg, 9), lon_deg: expect.closeTo(LHR.lon_deg, 9) });
    for (let i = 1; i < pts.length; i++) expect(greatCircleDistanceNm(pts[i - 1]!, pts[i]!)).toBeLessThanOrEqual(60 + 1e-9);
    expect(pathLengthNm(pts)).toBeCloseTo(greatCircleDistanceNm(JFK, LHR), 6);
    expect(greatCirclePoints(JFK, LHR, { segments: 4 })).toHaveLength(5);
  });

  it('antipodal points still give a route of 10 800 NM', () => {
    const pts = greatCirclePoints(P(0, 0), P(0, 180), { segments: 8 });
    expect(pathLengthNm(pts)).toBeCloseTo(10800, 3);
  });
});

describe('rhumb lines', () => {
  it('equal the great circle along the equator and along a meridian', () => {
    expect(rhumbDistanceNm(P(0, 10), P(0, 50))).toBeCloseTo(2400, 9);
    expect(rhumbCourseDeg(P(0, 10), P(0, 50))).toBeCloseTo(90, 12);
    expect(rhumbDistanceNm(P(-20, 10), P(30, 10))).toBeCloseTo(3000, 9);
    expect(rhumbCourseDeg(P(-20, 10), P(30, 10))).toBeCloseTo(0, 12);
    expect(rhumbCourseDeg(P(30, 10), P(-20, 10))).toBeCloseTo(180, 12);
  });

  it('along a parallel: distance = difference of longitude x cos(latitude) x 60', () => {
    expect(rhumbDistanceNm(P(60, 0), P(60, 10))).toBeCloseTo(10 * 60 * Math.cos(60 * RAD), 9);
    expect(rhumbCourseDeg(P(60, 0), P(60, 10))).toBeCloseTo(90, 12);
  });

  it('cross the antimeridian the short way', () => {
    expect(rhumbCourseDeg(P(10, 170), P(10, -170))).toBeCloseTo(90, 12);
    expect(rhumbDistanceNm(P(10, 170), P(10, -170))).toBeCloseTo(20 * 60 * Math.cos(10 * RAD), 9);
  });

  it('are never shorter than the great circle', () => {
    for (const [a, b] of [[JFK, LHR], [SYD, SCL], [P(60, -40), P(55, 20)]] as const) {
      expect(rhumbDistanceNm(a, b)).toBeGreaterThanOrEqual(greatCircleDistanceNm(a, b) - 1e-9);
    }
    // New York to London: the rhumb line is roughly 70 NM longer.
    expect(rhumbDistanceNm(JFK, LHR) - greatCircleDistanceNm(JFK, LHR)).toBeGreaterThan(40);
  });

  it('are straight on a Mercator chart: the course is constant', () => {
    const a = P(40.6413, -73.7781);
    const b = P(51.47, -0.4543);
    const course = rhumbCourseDeg(a, b);
    // Independent: atan2(dLon, dPsi) with the Mercator isometric latitude.
    const psi = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2));
    expect(course).toBeCloseTo(Math.atan2((b.lon_deg - a.lon_deg) * RAD, psi(b.lat_deg) - psi(a.lat_deg)) / RAD, 9);
    const pts = rhumbPoints(a, b, { segments: 10 });
    for (let i = 1; i < pts.length; i++) expect(rhumbCourseDeg(pts[i - 1]!, pts[i]!)).toBeCloseTo(course, 7);
    expect(pathLengthNm(pts, 'rhumb')).toBeCloseTo(rhumbDistanceNm(a, b), 6);
  });

  it('rhumbDestination(a, course, distance) lands on b', () => {
    for (const [a, b] of [[JFK, LHR], [SYD, SCL], [P(10, 170), P(-5, -175)]] as const) {
      const d = rhumbDestination(a, rhumbCourseDeg(a, b), rhumbDistanceNm(a, b));
      expect(greatCircleDistanceNm(d, b)).toBeLessThan(1e-6);
    }
  });

  it('stop at a pole instead of passing it', () => {
    const d = rhumbDestination(P(80, 0), 0, 1200);
    expect(d.lat_deg).toBe(90);
  });
});

describe('the antimeridian when drawing', () => {
  const route = [P(0, 170), P(5, 178), P(10, -170), P(12, -160)];

  it('unwrapLongitudes makes longitudes continuous', () => {
    expect(unwrapLongitudes(route)).toEqual([
      [170, 0],
      [178, 5],
      [190, 10],
      [200, 12],
    ]);
    expect(unwrapLongitudes([P(0, -170), P(0, 170)])).toEqual([
      [-170, 0],
      [-190, 0],
    ]);
  });

  it('splitAtAntimeridian ends each piece exactly on the seam', () => {
    const pieces = splitAtAntimeridian(route);
    expect(pieces).toHaveLength(2);
    const [west, east] = pieces as [[number, number][], [number, number][]];
    expect(west[west.length - 1]![0]).toBe(180);
    expect(east[0]![0]).toBe(-180);
    expect(west[west.length - 1]![1]).toBeCloseTo(5 + (2 / 12) * 5, 12);
    expect(east[0]![1]).toBe(west[west.length - 1]![1]);
    for (const piece of pieces) for (const [lon] of piece) expect(Math.abs(lon)).toBeLessThanOrEqual(180);
  });

  it('a route that does not cross stays in one piece', () => {
    expect(splitAtAntimeridian([P(0, 0), P(10, 10)])).toEqual([
      [
        [0, 0],
        [10, 10],
      ],
    ]);
  });

  it('a great-circle route across the Pacific splits once', () => {
    const pts = greatCirclePoints(SYD, SCL);
    expect(splitAtAntimeridian(pts)).toHaveLength(2);
    expect(normalizeLon(190)).toBe(-170);
  });
});
