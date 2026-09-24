/**
 * Marching squares on fields whose contours are known exactly, and the GeoJSON the misfit
 * map publishes: closed, anticlockwise exteriors with clockwise holes, lines that stop at
 * the grid's edge, and nothing outside [-180, 180] when a grid crosses the antimeridian.
 */
import type { Position } from 'geojson';
import { describe, expect, it } from 'vitest';
import type { MisfitGrid, MisfitLevel } from '../../src/next/engine/types.js';
import { isoRings, misfitContours, polygons, ringLines, type Field } from '../../src/next/misfit/contours.js';
import { sampleMisfit } from '../../src/next/misfit/grid.js';

function field(rows: number, cols: number, f: (x: number, y: number) => number): Field {
  const values = new Float64Array(rows * cols);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) values[y * cols + x] = f(x, y);
  return { values, rows, cols };
}

/** Signed shoelace area of a closed [lon, lat] ring (last point repeats the first). */
function ringArea(ring: Position[]): number {
  let a = 0;
  for (let k = 0; k + 1 < ring.length; k++) a += ring[k]![0]! * ring[k + 1]![1]! - ring[k + 1]![0]! * ring[k]![1]!;
  return a / 2;
}

const LEVELS = (min: number): MisfitLevel[] =>
  (
    [
      ['one_sigma', '68.3 % (1 sigma)', 0.6827, 2.295748928898636],
      ['p95', '95 %', 0.95, 5.991464547],
      ['three_sigma', '99.7 % (3 sigma)', 0.9973, 11.829158081900795],
    ] as const
  ).map(([name, label, confidence, delta]) => ({ name, label, confidence, delta_chi2: delta, chi2: min + delta }));

/** A synthetic grid: chi2 = (d / r)^2 * 5.99 about `centre`, so the 95 % line is the circle of radius r (degrees, flat). */
function bowl(
  bounds: MisfitGrid['bounds'],
  nLat: number,
  nLon: number,
  centre: { lat: number; lon: number },
  r: number,
): MisfitGrid {
  const latStep = (bounds.north_deg - bounds.south_deg) / (nLat - 1);
  const lonStep = (bounds.east_deg - bounds.west_deg) / (nLon - 1);
  const chi2 = new Float64Array(nLat * nLon);
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const dLat = bounds.south_deg + i * latStep - centre.lat;
      const dLon = bounds.west_deg + j * lonStep - centre.lon;
      chi2[i * nLon + j] = 1 + 5.991464547 * ((dLat * dLat + dLon * dLon) / (r * r));
    }
  }
  return {
    bounds,
    crosses_antimeridian: bounds.east_deg > 180,
    n_lat: nLat,
    n_lon: nLon,
    lat_step_deg: latStep,
    lon_step_deg: lonStep,
    lat_deg: [],
    lon_deg: [],
    chi2,
    min: {
      lat_deg: centre.lat,
      lon_deg: centre.lon,
      chi2: 1,
      delta_chi2: 0,
      shared_bias_arcmin: null,
      inside_grid: true,
      well_determined: true,
      converged: true,
    },
    grid_min: { i: 0, j: 0, lat_deg: 0, lon_deg: 0, chi2: 1, delta_chi2: 0 },
    basins: [],
    unknowns: 2,
    dof: 3,
    levels: LEVELS(1),
    bias_profiled: false,
    weighted: false,
    sights: [],
    notes: [],
    solve_kind: 'unique',
  };
}

describe('marching squares', () => {
  it('draws a circle round a bowl: one anticlockwise ring, the right size, closed as a line', () => {
    const f = field(41, 41, (x, y) => (x - 20) ** 2 + (y - 20) ** 2);
    const rings = isoRings(f, 100); // radius 10
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring.area).toBeGreaterThan(0);
    expect(ring.area).toBeCloseTo(Math.PI * 100, -0.5); // within a few per cent
    expect(Math.abs(ring.area / (Math.PI * 100) - 1)).toBeLessThan(0.01);
    for (const [x, y] of ring.points) expect(Math.abs(Math.hypot(x - 20, y - 20) - 10)).toBeLessThan(0.05);
    expect(ring.boundary.every((b) => !b)).toBe(true);
    const lines = ringLines(ring);
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toEqual(lines[0]!.at(-1));
  });

  it('keeps a hole: an annulus is an exterior with a clockwise hole inside it', () => {
    const f = field(41, 41, (x, y) => (Math.hypot(x - 20, y - 20) - 10) ** 2);
    const rings = isoRings(f, 4); // 8 <= d <= 12
    expect(rings).toHaveLength(2);
    const polys = polygons(rings);
    expect(polys).toHaveLength(1);
    expect(polys[0]!.holes).toHaveLength(1);
    expect(polys[0]!.outer.area).toBeCloseTo(Math.PI * 144, -1);
    expect(polys[0]!.holes[0]!.area).toBeLessThan(0);
    expect(-polys[0]!.holes[0]!.area).toBeCloseTo(Math.PI * 64, -1);
  });

  it('closes a region along the edge, and leaves the edge out of the lines', () => {
    // Inside where x <= 2.5: the left part of a 6 x 6 field.
    const f = field(6, 6, (x) => x);
    const rings = isoRings(f, 2.5);
    expect(rings).toHaveLength(1);
    expect(rings[0]!.area).toBeCloseTo(2.5 * 5, 9);
    expect(rings[0]!.boundary.some((b) => b)).toBe(true);
    const lines = ringLines(rings[0]!);
    expect(lines).toHaveLength(1);
    const xs = lines[0]!.map(([x]) => x);
    expect(Math.min(...xs)).toBeCloseTo(2.5, 12);
    expect(Math.max(...xs)).toBeCloseTo(2.5, 12);
    const ys = lines[0]!.map(([, y]) => y).sort((a, b) => a - b);
    expect(ys[0]).toBe(0);
    expect(ys.at(-1)).toBe(5);
  });

  it('decides a saddle by its centre', () => {
    // Low at two opposite corners of the middle cell.
    const values = [0, 9, 9, 9, 0, 9, 9, 9, 0];
    const lowCentre = { values: [...values.slice(0, 4), 1, ...values.slice(5)], rows: 3, cols: 3 };
    // 3 x 3: corners (0,0) and (2,2) low... make a clean 2 x 2 saddle instead.
    const saddle = (centreLow: boolean): Field => ({ values: centreLow ? [0, 3, 3, 0] : [0, 3.1, 3.1, 0], rows: 2, cols: 2 });
    expect(isoRings(saddle(true), 1.5)).toHaveLength(1); // centre 1.5 <= 1.5: joined
    expect(isoRings(saddle(false), 1.5)).toHaveLength(2); // centre 1.55: two corners apart
    expect(isoRings(lowCentre, 0.5).length).toBeGreaterThan(0);
  });

  it('treats NaN as outside', () => {
    const f = field(5, 5, (x, y) => (x === 2 && y === 2 ? Number.NaN : 0));
    const rings = isoRings(f, 1);
    expect(rings.filter((r) => r.area < 0)).toHaveLength(1); // a hole round the NaN
  });
});

describe('the misfit contours as GeoJSON', () => {
  it('gives each level its region and line, outermost first, closed and anticlockwise', () => {
    const g = bowl({ south_deg: 39, north_deg: 41, west_deg: -76, east_deg: -74 }, 81, 81, { lat: 40, lon: -75 }, 0.5);
    const c = misfitContours(g, ['one_sigma', 'p95', 'three_sigma']);
    expect(c.regions.features.map((f) => f.properties.level)).toEqual(['three_sigma', 'p95', 'one_sigma']);
    const p95 = c.regions.features[1]!;
    expect(p95.properties.chi2).toBe(g.levels[1]!.chi2);
    expect(p95.geometry.coordinates).toHaveLength(1);
    const outer = p95.geometry.coordinates[0]![0]!;
    expect(outer[0]).toEqual(outer.at(-1));
    expect(ringArea(outer)).toBeGreaterThan(0);
    expect(Math.abs(ringArea(outer) / (Math.PI * 0.25) - 1)).toBeLessThan(0.01);
    // 1 sigma inside 95 % inside 3 sigma.
    const areas = c.regions.features.map((f) => ringArea(f.geometry.coordinates[0]![0]!));
    expect(areas[0]).toBeGreaterThan(areas[1]!);
    expect(areas[1]).toBeGreaterThan(areas[2]!);
    // Every line vertex sits on its level (linear interpolation of a smooth bowl).
    for (const f of c.lines.features) {
      for (const line of f.geometry.coordinates) {
        for (const [lon, lat] of line) {
          expect(Math.abs(sampleMisfit(g, { lat_deg: lat!, lon_deg: lon! }) - f.properties.chi2)).toBeLessThan(0.02);
        }
      }
    }
    // By default only the 95 % and 3-sigma lines.
    expect(misfitContours(g).lines.features.map((f) => f.properties.level)).toEqual(['three_sigma', 'p95']);
  });

  it('cuts a grid that crosses the antimeridian, keeping every longitude in [-180, 180]', () => {
    const g = bowl({ south_deg: -11, north_deg: -9, west_deg: 179, east_deg: 181 }, 61, 61, { lat: -10, lon: 180.2 }, 0.4);
    const c = misfitContours(g, ['one_sigma', 'p95', 'three_sigma']);
    for (const f of [...c.regions.features, ...c.lines.features]) {
      const flat = JSON.stringify(f.geometry.coordinates).match(/-?\d+(\.\d+)?(e-?\d+)?/g)!.map(Number);
      for (let k = 0; k < flat.length; k += 2) {
        expect(flat[k]).toBeGreaterThanOrEqual(-180);
        expect(flat[k]).toBeLessThanOrEqual(180);
      }
    }
    // The 95 % region is two polygons that meet on the meridian and add up to the circle.
    const p95 = c.regions.features.find((f) => f.properties.level === 'p95')!;
    expect(p95.geometry.coordinates).toHaveLength(2);
    const total = p95.geometry.coordinates.reduce((sum, poly) => sum + ringArea(poly[0]!), 0);
    expect(Math.abs(total / (Math.PI * 0.16) - 1)).toBeLessThan(0.01);
    const lons = p95.geometry.coordinates.flatMap((poly) => poly[0]!.map((p) => p[0]!));
    expect(lons).toContain(180);
    expect(lons).toContain(-180);
    // Its line is two open pieces, neither jumping across the map.
    const line = c.lines.features.find((f) => f.properties.level === 'p95')!;
    expect(line.geometry.coordinates).toHaveLength(2);
    for (const piece of line.geometry.coordinates) {
      for (let k = 1; k < piece.length; k++) expect(Math.abs(piece[k]![0]! - piece[k - 1]![0]!)).toBeLessThan(0.1);
    }
  });

  it('handles a cap at the pole across every longitude', () => {
    // Misfit grows with the distance from the pole: the levels are circles of latitude.
    const nLat = 41;
    const nLon = 73;
    const g = bowl({ south_deg: 80, north_deg: 90, west_deg: -180, east_deg: 180 }, nLat, nLon, { lat: 90, lon: 0 }, 1);
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) g.chi2[i * nLon + j] = 1 + 5.991464547 * ((90 - (80 + i * g.lat_step_deg)) / 3) ** 2;
    }
    const c = misfitContours(g, ['p95']);
    const line = c.lines.features[0]!;
    // One line round the cap at 87 N, from the west edge to the east edge (the seam is not a contour).
    expect(line.geometry.coordinates).toHaveLength(1);
    const piece = line.geometry.coordinates[0]!;
    for (const [, lat] of piece) expect(lat).toBeCloseTo(87, 6);
    const lons = piece.map((p) => p[0]!);
    expect(Math.min(...lons)).toBe(-180);
    expect(Math.max(...lons)).toBe(180);
    const region = c.regions.features[0]!.geometry.coordinates;
    expect(region).toHaveLength(1);
    expect(region[0]![0]!.some(([, lat]) => lat === 90)).toBe(true);
  });
});
