/**
 * The map's spherical geometry (web/src/next/map/geometry.ts): small circles, caps as
 * polygons across the antimeridian and round the poles, the twilight bands and circles of
 * equal altitude. Expected values come from independent formulas (haversine, the spherical
 * law of cosines) or from exact geometry, never from the code under test.
 */
import type { Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import {
  SHADE_BANDS,
  altitudeRingFeatures,
  angularDistanceDeg,
  antipode,
  capPolygon,
  circleLine,
  destination,
  ellipseRing,
  equalAltitudeCircle,
  graticuleFeatures,
  graticuleStep,
  multiPolygonContains,
  polygonPieces,
  ringArea,
  smallCircle,
  splitClosedLine,
  splitLine,
  stackedAlphas,
  terminatorLine,
  twilightFeatures,
  wrapLon,
} from '../../src/next/map/geometry.js';

const RAD = Math.PI / 180;
const P = (lat_deg: number, lon_deg: number) => ({ lat_deg, lon_deg });

/** Independent: haversine central angle in degrees. */
function haversineDeg(a: { lat_deg: number; lon_deg: number }, b: { lat_deg: number; lon_deg: number }): number {
  const dphi = (b.lat_deg - a.lat_deg) * RAD;
  const dlam = (b.lon_deg - a.lon_deg) * RAD;
  const h = Math.sin(dphi / 2) ** 2 + Math.cos(a.lat_deg * RAD) * Math.cos(b.lat_deg * RAD) * Math.sin(dlam / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h))) / RAD;
}

/** A small deterministic generator (mulberry32) so failures reproduce. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function allPositions(coords: Position[][][]): Position[] {
  return coords.flatMap((poly) => poly.flat());
}

describe('basics', () => {
  it('wraps longitudes into (-180, 180]', () => {
    expect(wrapLon(180)).toBe(180);
    expect(wrapLon(-180)).toBe(180);
    expect(wrapLon(190)).toBeCloseTo(-170, 12);
    expect(wrapLon(-190)).toBeCloseTo(170, 12);
    expect(wrapLon(540)).toBe(180);
    expect(Object.is(wrapLon(-0), 0)).toBe(true);
    expect(Object.is(wrapLon(360), 0)).toBe(true);
  });

  it('measures angular distance like the haversine formula', () => {
    const r = rng(1);
    for (let i = 0; i < 200; i++) {
      const a = P(r() * 180 - 90, r() * 360 - 180);
      const b = P(r() * 180 - 90, r() * 360 - 180);
      expect(angularDistanceDeg(a, b)).toBeCloseTo(haversineDeg(a, b), 9);
    }
  });

  it('finds destinations on the sphere', () => {
    const e = destination(P(0, 0), 90, 90);
    expect(e.lat_deg).toBeCloseTo(0, 12);
    expect(e.lon_deg).toBeCloseTo(90, 12);
    const n = destination(P(0, 0), 0, 45);
    expect(n.lat_deg).toBeCloseTo(45, 12);
    expect(n.lon_deg).toBeCloseTo(0, 12);
    // From Philadelphia, 3000 NM on 051: the distance back is 50 degrees.
    const phl = P(39.9526, -75.1652);
    const d = destination(phl, 51, 50);
    expect(haversineDeg(phl, d)).toBeCloseTo(50, 9);
  });

  it('draws small circles at the right distance, closed', () => {
    const c = P(52.3, 171.4);
    const pts = smallCircle(c, 37.5, 180);
    expect(pts).toHaveLength(181);
    expect(pts[180]).toEqual(pts[0]);
    for (const p of pts) expect(haversineDeg(c, p)).toBeCloseTo(37.5, 9);
    // Bearing 0 first: due north of the centre.
    expect(pts[0]!.lat_deg).toBeCloseTo(52.3 + 37.5, 9);
  });

  it('draws a circle round a pole as a parallel', () => {
    for (const p of smallCircle(P(90, 0), 20, 72)) expect(p.lat_deg).toBeCloseTo(70, 9);
    for (const p of smallCircle(P(-90, 0), 20, 72)) expect(p.lat_deg).toBeCloseTo(-70, 9);
  });
});

describe('lines across the antimeridian', () => {
  it('cuts a line at +/-180 at the crossing latitude', () => {
    const pieces = splitLine([P(10, 170), P(20, -170)]);
    expect(pieces).toHaveLength(2);
    expect(pieces[0]).toEqual([
      [170, 10],
      [180, 15],
    ]);
    expect(pieces[1]).toEqual([
      [-180, 15],
      [-170, 20],
    ]);
  });

  it('joins the pieces of a closed ring so the only breaks are on the seam', () => {
    // Crosses the seam twice: two pieces, not three.
    const lines = circleLine(P(0, 175), 20);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const ends = [line[0]!, line[line.length - 1]!];
      for (const e of ends) expect(Math.abs(e[0]!)).toBe(180);
    }
    // A circle round the North Pole crosses once: one piece from -180 to 180.
    const polar = circleLine(P(80, 30), 25);
    expect(polar).toHaveLength(1);
    const lons = polar[0]!.map((p) => p[0]!);
    expect(Math.min(...lons)).toBe(-180);
    expect(Math.max(...lons)).toBe(180);
    // A circle that never reaches the seam stays in one piece.
    expect(circleLine(P(40, -75), 30)).toHaveLength(1);
  });

  it('keeps every point on the circle (seam points to well under a pixel)', () => {
    const c = P(-20, 178);
    for (const line of circleLine(c, 33)) {
      for (const [lon, lat] of line) {
        expect(Math.abs(lon!)).toBeLessThanOrEqual(180);
        expect(Math.abs(haversineDeg(c, P(lat!, lon!)) - 33)).toBeLessThan(0.01);
      }
    }
  });

  it('merges a closed ring whose first and last pieces meet', () => {
    const ring = [P(0, 170), P(10, -170), P(0, -160), P(-10, 175), P(0, 170)];
    const pieces = splitClosedLine(ring);
    expect(pieces).toHaveLength(2);
  });
});

describe('caps as polygons', () => {
  function checkCap(center: { lat_deg: number; lon_deg: number }, radius: number, seed: number): void {
    const coords = capPolygon(center, radius, 720);
    // RFC 7946: every position in range, exterior rings counter-clockwise.
    for (const p of allPositions(coords)) {
      expect(Math.abs(p[0]!)).toBeLessThanOrEqual(180);
      expect(Math.abs(p[1]!)).toBeLessThanOrEqual(90);
    }
    for (const poly of coords) expect(ringArea(poly[0]!)).toBeGreaterThan(0);
    // Inside the polygon exactly when within `radius` (away from the boundary).
    const r = rng(seed);
    let tested = 0;
    for (let i = 0; i < 600; i++) {
      const lat = r() * 179 - 89.5;
      const lon = r() * 359.8 - 179.9;
      const d = haversineDeg(center, P(lat, lon));
      if (Math.abs(d - radius) < 0.3) continue;
      tested++;
      expect(multiPolygonContains(coords, [lon, lat]), `(${lat}, ${lon}) at ${d} from centre`).toBe(d < radius);
    }
    expect(tested).toBeGreaterThan(400);
  }

  it('a plain cap', () => checkCap(P(40, -75), 30, 11));
  it('a cap across the antimeridian', () => checkCap(P(-10, 172), 25, 12));
  it('a cap containing the North Pole', () => checkCap(P(75, 40), 30, 13));
  it('a cap containing the South Pole, across the seam', () => checkCap(P(-66, -178), 40, 14));
  it('a cap containing both poles', () => checkCap(P(3, 20), 120, 15));
  it('a cap containing both poles, the hole across the seam', () => checkCap(P(-5, 5), 150, 16));
  it('a large cap missing both poles', () => checkCap(P(0, -100), 89.5, 17));
  it('random caps', () => {
    const r = rng(99);
    for (let k = 0; k < 40; k++) {
      checkCap(P(r() * 178 - 89, r() * 360 - 180), 0.5 + r() * 178, 1000 + k);
    }
  });

  it('degenerate radii', () => {
    expect(capPolygon(P(0, 0), 0)).toEqual([]);
    const world = capPolygon(P(0, 0), 180);
    expect(world).toHaveLength(1);
    expect(multiPolygonContains(world, [10, 10])).toBe(true);
  });

  it('a simple ring across the seam', () => {
    const ring = [P(-5, 170), P(-5, -170), P(5, -170), P(5, 170), P(-5, 170)];
    const pieces = polygonPieces(ring);
    expect(pieces).toHaveLength(2);
    expect(multiPolygonContains(pieces, [175, 0])).toBe(true);
    expect(multiPolygonContains(pieces, [-175, 0])).toBe(true);
    expect(multiPolygonContains(pieces, [0, 0])).toBe(false);
  });
});

describe('day, night and twilight', () => {
  /** Sun altitude at a place from its ground point (spherical, no refraction). */
  const sunAltitude = (gp: { lat_deg: number; lon_deg: number }, lat: number, lon: number) => 90 - haversineDeg(gp, P(lat, lon));

  it('stacks the bands so each is exactly the theme darkness', () => {
    const targets = [0.1, 0.19, 0.28, 0.37];
    const alphas = stackedAlphas(targets);
    let clear = 1;
    alphas.forEach((a, i) => {
      clear *= 1 - a;
      expect(1 - clear).toBeCloseTo(targets[i]!, 12);
    });
    expect(stackedAlphas([0.3, 0.2])[1]).toBe(0); // never lighter inward
  });

  it('puts each place in the bands CONVENTIONS 13.4 gives for the Sun altitude there', () => {
    const r = rng(5);
    for (const gp of [P(0, 0), P(23.44, 0), P(-23.44, 120), P(12, -179.5), P(-0.4, 179.9)]) {
      const fc = twilightFeatures(gp, [0.1, 0.1, 0.1, 0.1], 720);
      for (let i = 0; i < 400; i++) {
        const lat = r() * 179 - 89.5;
        const lon = r() * 359.8 - 179.9;
        const h = sunAltitude(gp, lat, lon);
        const bounds = [-50 / 60, -6, -12, -18];
        if (bounds.some((b) => Math.abs(h - b) < 0.3)) continue;
        fc.features.forEach((f, k) => {
          expect(multiPolygonContains(f.geometry.coordinates, [lon, lat]), `${f.properties!.band} at h=${h}`).toBe(h < bounds[k]!);
        });
      }
    }
  });

  it('polar night and midnight Sun at the June solstice', () => {
    const fc = twilightFeatures(P(23.44, 0), [0.1, 0.1, 0.1, 0.1]);
    const night = fc.features[3]!.geometry.coordinates;
    expect(multiPolygonContains(night, [0, -89])).toBe(true);
    expect(multiPolygonContains(fc.features[0]!.geometry.coordinates, [0, 89])).toBe(false);
  });

  it('draws the terminator where the Sun is at -50 minutes', () => {
    const gp = P(-12.3, 45.6);
    for (const line of terminatorLine(gp).coordinates) {
      for (const [lon, lat] of line) expect(sunAltitude(gp, lat!, lon!)).toBeCloseTo(-50 / 60, 1);
    }
    expect(SHADE_BANDS[0].radiusDeg).toBeCloseTo(89 + 10 / 60, 12);
    expect(antipode(P(10, 170))).toEqual(P(-10, -10));
  });
});

describe('circles of equal altitude', () => {
  it('passes through the observer', () => {
    const observer = P(39.9526, -75.1652);
    const gp = P(-1.2, -30.4);
    // Independent: navigation computed altitude (CONVENTIONS section 3).
    const lha = (gp.lon_deg - observer.lon_deg) * -1;
    const hc =
      Math.asin(
        Math.sin(observer.lat_deg * RAD) * Math.sin(gp.lat_deg * RAD) +
          Math.cos(observer.lat_deg * RAD) * Math.cos(gp.lat_deg * RAD) * Math.cos(lha * RAD),
      ) / RAD;
    const circle = equalAltitudeCircle(gp, hc);
    for (const line of circle.coordinates) {
      for (const [lon, lat] of line) expect(haversineDeg(gp, P(lat!, lon!))).toBeCloseTo(90 - hc, 2);
    }
    expect(haversineDeg(gp, observer)).toBeCloseTo(90 - hc, 9);
  });

  it('labels altitude rings from the horizon up', () => {
    const rings = altitudeRingFeatures(P(10, 20), 10);
    expect(rings.features.map((f) => f.properties!.altitude)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80]);
    expect(rings.features[1]!.properties!.label).toBe('10°');
  });
});

describe('ellipse', () => {
  it('has its semi-axes on the given bearings', () => {
    const c = P(40, -70);
    const ring = ellipseRing(c, 12, 4, 30, 8);
    expect(ring).toHaveLength(9);
    expect(haversineDeg(c, ring[0]!) * 60).toBeCloseTo(12, 6); // along the major axis
    expect(haversineDeg(c, ring[2]!) * 60).toBeCloseTo(4, 6); // a quarter turn: the minor axis
    // The major axis points 030: the first point is north-east of the centre.
    expect(ring[0]!.lat_deg).toBeGreaterThan(c.lat_deg);
    expect(ring[0]!.lon_deg).toBeGreaterThan(c.lon_deg);
  });
});

describe('graticule', () => {
  it('chooses finer steps for smaller views', () => {
    expect(graticuleStep(360)).toBe(30);
    expect(graticuleStep(90)).toBe(15);
    expect(graticuleStep(60)).toBe(10);
    expect(graticuleStep(10)).toBe(1);
    expect(graticuleStep(1)).toBeCloseTo(1 / 6, 12);
  });

  it('covers the world once at coarse steps', () => {
    const fc = graticuleFeatures(30);
    const meridians = fc.features.filter((f) => f.properties!.kind === 'meridian');
    const parallels = fc.features.filter((f) => f.properties!.kind === 'parallel');
    expect(meridians.map((f) => f.properties!.value)).toEqual([180, -150, -120, -90, -60, -30, 0, 30, 60, 90, 120, 150]);
    expect(parallels.map((f) => f.properties!.label)).toEqual(['60° S', '30° S', '0°', '30° N', '60° N']);
  });

  it('labels fine steps in degrees and minutes', () => {
    const fc = graticuleFeatures(0.5, { west: -75.6, south: 39.6, east: -74.6, north: 40.4 });
    const labels = fc.features.filter((f) => f.properties!.kind === 'parallel').map((f) => f.properties!.label);
    expect(labels).toContain('39° 30′ N');
    expect(labels).toContain('40° 00′ N');
  });
});
