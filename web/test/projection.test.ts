import { describe, expect, it } from 'vitest';
import {
  clipPolyline,
  clipSegment,
  fitProjection,
  graticuleStep,
  gridLines,
  norm180,
  projectAndClipRing,
  Projection,
  unwrapLon,
  type Rect,
} from '../src/projection.js';
import { angularDistance, circleOfPosition, pointFromDeg } from '../src/geometry.js';

const RECT: Rect = { x: 0, y: 0, width: 600, height: 400 };

describe('longitude unwrapping', () => {
  it('normalises into (-180, 180]', () => {
    expect(norm180(190)).toBe(-170);
    expect(norm180(-190)).toBe(170);
    expect(norm180(180)).toBe(180);
    expect(norm180(540)).toBe(180);
  });

  it('picks the representative nearest the view centre', () => {
    expect(unwrapLon(-179, 179)).toBe(181);
    expect(unwrapLon(179, -179)).toBe(-181);
    expect(unwrapLon(10, 10)).toBe(10);
  });
});

describe('equirectangular projection', () => {
  const p = new Projection(40, -75, 100, RECT);

  it('puts the centre of the view at (lat0, lon0)', () => {
    expect(p.project(40, -75)).toEqual([300, 200]);
  });

  it('grows y downward as latitude decreases', () => {
    const [, y] = p.project(39, -75);
    expect(y).toBeCloseTo(300, 9);
  });

  it('shortens longitude by cos(lat0) so local circles stay round', () => {
    const [x] = p.project(40, -74);
    expect(x - 300).toBeCloseTo(100 * Math.cos((40 * Math.PI) / 180), 9);
  });

  it('round-trips through unproject', () => {
    const back = p.unproject(...p.project(41.25, -73.5));
    expect(back.lat_deg).toBeCloseTo(41.25, 9);
    expect(back.lon_deg).toBeCloseTo(-73.5, 9);
  });

  it('stays finite at the pole instead of dividing by cos(90)', () => {
    const polar = new Projection(90, 0, 100, RECT);
    const [x, y] = polar.project(89, 10);
    expect(Number.isFinite(x)).toBe(true);
    expect(Number.isFinite(y)).toBe(true);
  });

  it('reports bounds that match the rect it was given', () => {
    const b = p.bounds();
    expect(b.latMax - b.latMin).toBeCloseTo(RECT.height / 100, 9);
  });
});

describe('fitProjection', () => {
  it('keeps every point inside the padded rect', () => {
    const points = [
      { lat_deg: 39.5, lon_deg: -75.5 },
      { lat_deg: 40.5, lon_deg: -74.5 },
      { lat_deg: 40.0, lon_deg: -75.0 },
    ];
    const projection = fitProjection(points, RECT, { padding: 20 });
    for (const point of points) {
      const [x, y] = projection.projectPoint(point);
      expect(x).toBeGreaterThanOrEqual(RECT.x + 19);
      expect(x).toBeLessThanOrEqual(RECT.x + RECT.width - 19);
      expect(y).toBeGreaterThanOrEqual(RECT.y + 19);
      expect(y).toBeLessThanOrEqual(RECT.y + RECT.height - 19);
    }
  });

  it('falls back to a minimum span for a single point', () => {
    const projection = fitProjection([{ lat_deg: 10, lon_deg: 20 }], RECT, { minSpanDeg: 0.1 });
    expect(projection.lat0).toBeCloseTo(10, 9);
    expect(Number.isFinite(projection.scale)).toBe(true);
    expect(projection.scale).toBeGreaterThan(0);
  });

  it('handles an empty point list', () => {
    const projection = fitProjection([], RECT);
    expect(Number.isFinite(projection.scale)).toBe(true);
  });

  it('centres across the antimeridian rather than spanning the globe', () => {
    const projection = fitProjection(
      [
        { lat_deg: 0, lon_deg: 179 },
        { lat_deg: 0, lon_deg: -179 },
      ],
      RECT,
    );
    expect(Math.abs(projection.lon0)).toBeCloseTo(180, 6);
  });
});

describe('graticule steps', () => {
  it('uses 1 degree for a few-degree view, as the brief asks', () => {
    expect(graticuleStep(4)).toBe(1);
    expect(graticuleStep(9)).toBe(2);
  });

  it('goes finer than a degree when the view is small', () => {
    expect(graticuleStep(0.5)).toBeLessThan(0.5);
    expect(graticuleStep(0.02)).toBeLessThanOrEqual(1 / 60);
  });

  it('lists the multiples inside a range', () => {
    expect(gridLines(39.4, 41.2, 1)).toEqual([40, 41]);
    expect(gridLines(-0.5, 0.5, 0.5)).toEqual([-0.5, 0, 0.5]);
  });

  it('refuses to enumerate an absurd number of lines', () => {
    expect(gridLines(-180, 180, 1e-9)).toEqual([]);
  });
});

describe('clipping', () => {
  it('keeps a segment entirely inside', () => {
    expect(clipSegment([10, 10], [100, 100], RECT)).toEqual([
      [10, 10],
      [100, 100],
    ]);
  });

  it('drops a segment entirely outside', () => {
    expect(clipSegment([-50, -50], [-10, -10], RECT)).toBeNull();
  });

  it('trims a segment that leaves the rect', () => {
    const clipped = clipSegment([300, 200], [900, 200], RECT);
    expect(clipped).not.toBeNull();
    expect(clipped![1][0]).toBeCloseTo(600, 9);
  });

  it('drops a segment running parallel to an edge outside it', () => {
    expect(clipSegment([-5, 10], [-5, 300], RECT)).toBeNull();
  });

  it('splits a polyline that leaves and re-enters', () => {
    const pieces = clipPolyline(
      [
        [10, 200],
        [200, 200],
        [200, -100],
        [400, -100],
        [400, 200],
        [500, 200],
      ],
      RECT,
    );
    expect(pieces.length).toBe(2);
    expect(pieces[0]![0]).toEqual([10, 200]);
    expect(pieces[1]![pieces[1]!.length - 1]).toEqual([500, 200]);
  });

  it('returns nothing for a polyline that never enters', () => {
    expect(
      clipPolyline(
        [
          [-10, -10],
          [-20, -20],
        ],
        RECT,
      ),
    ).toEqual([]);
  });
});

describe('circle of position clipping', () => {
  it('clips a circle that runs off every side into visible arcs', () => {
    const projection = new Projection(40, -75, 200, RECT);
    // A circle whose radius is exactly the distance to the view centre, so it must cross
    // the plot: at this scale the view is only about 2 degrees of latitude tall.
    const gp = { lat_deg: 38.8, lon_deg: -100 };
    const radiusDeg =
      (angularDistance(pointFromDeg(gp.lat_deg, gp.lon_deg), pointFromDeg(40, -75)) * 180) /
      Math.PI;
    const ring = circleOfPosition(gp, radiusDeg, 720);
    const pieces = projectAndClipRing(ring, projection);
    expect(pieces.length).toBeGreaterThan(0);
    for (const piece of pieces) {
      for (const [x, y] of piece) {
        expect(x).toBeGreaterThanOrEqual(RECT.x - 1e-6);
        expect(x).toBeLessThanOrEqual(RECT.x + RECT.width + 1e-6);
        expect(y).toBeGreaterThanOrEqual(RECT.y - 1e-6);
        expect(y).toBeLessThanOrEqual(RECT.y + RECT.height + 1e-6);
      }
    }
  });

  it('splits a ring that crosses the antimeridian instead of drawing across the plot', () => {
    // A small circle about a GP on the dateline: its points straddle +180/-180.
    const projection = new Projection(0, 180, 20, RECT);
    const ring = circleOfPosition({ lat_deg: 0, lon_deg: 180 }, 5, 72);
    const unsplit = ring.map((p) => projection.project(p.lat_deg, p.lon_deg));
    const pieces = projectAndClipRing(ring, projection);
    // Every drawn segment must be short: no 600-pixel jump across the whole view.
    for (const piece of pieces) {
      for (let i = 1; i < piece.length; i++) {
        expect(Math.abs(piece[i]![0] - piece[i - 1]![0])).toBeLessThan(RECT.width / 2);
      }
    }
    expect(unsplit.length).toBe(72);
  });

  it('draws a whole small circle as one closed piece when it fits', () => {
    const projection = new Projection(40, -75, 400, RECT);
    const ring = circleOfPosition({ lat_deg: 40, lon_deg: -75 }, 0.2, 90);
    const pieces = projectAndClipRing(ring, projection);
    expect(pieces.length).toBe(1);
    expect(pieces[0]!.length).toBe(91);
  });
});
