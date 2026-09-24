/**
 * Publishing the misfit map through the map service, the image overlays it may use, and
 * the Mercator raster behind them.
 */
import { describe, expect, it } from 'vitest';
import type { MisfitGrid } from '../../src/next/engine/types.js';
import { MapServiceImpl } from '../../src/next/map/overlays.js';
import { mercatorHeat } from '../../src/next/misfit/heat.js';
import { publishMisfitTo } from '../../src/next/misfit/overlay.js';
import { misfitRamp } from '../../src/next/misfit/ramp.js';

function grid(bounds: MisfitGrid['bounds'], n = 41): MisfitGrid {
  const latStep = (bounds.north_deg - bounds.south_deg) / (n - 1);
  const lonStep = (bounds.east_deg - bounds.west_deg) / (n - 1);
  const cLat = (bounds.north_deg + bounds.south_deg) / 2;
  const cLon = (bounds.east_deg + bounds.west_deg) / 2;
  const chi2 = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const d = ((bounds.south_deg + i * latStep - cLat) / latStep) ** 2 + ((bounds.west_deg + j * lonStep - cLon) / lonStep) ** 2;
      chi2[i * n + j] = 2 + d / 10;
    }
  }
  const levels = [
    { name: 'one_sigma' as const, label: '68.3 % (1 sigma)', confidence: 0.683, delta_chi2: 2.3, chi2: 4.3 },
    { name: 'p95' as const, label: '95 %', confidence: 0.95, delta_chi2: 5.99, chi2: 7.99 },
    { name: 'three_sigma' as const, label: '99.7 % (3 sigma)', confidence: 0.997, delta_chi2: 11.83, chi2: 13.83 },
  ];
  const min = {
    lat_deg: cLat,
    lon_deg: cLon,
    chi2: 2,
    delta_chi2: 0,
    shared_bias_arcmin: null,
    inside_grid: true,
    well_determined: true,
    converged: true,
  };
  return {
    bounds,
    crosses_antimeridian: bounds.east_deg > 180,
    n_lat: n,
    n_lon: n,
    lat_step_deg: latStep,
    lon_step_deg: lonStep,
    lat_deg: [],
    lon_deg: [],
    chi2,
    min,
    grid_min: { i: 20, j: 20, lat_deg: cLat, lon_deg: cLon, chi2: 2, delta_chi2: 0 },
    basins: [min],
    unknowns: 2,
    dof: 4,
    levels,
    bias_profiled: false,
    weighted: false,
    sights: [],
    notes: [],
    solve_kind: 'unique',
  };
}

const BOX = { south_deg: 39, north_deg: 41, west_deg: -76, east_deg: -74 };

describe('publishing on the map', () => {
  it('adds the fill under the lines, each line with its own dash and label, and removes them all', () => {
    const service = new MapServiceImpl();
    const events: string[] = [];
    service.subscribe((e) => events.push(e.kind === 'set' ? `set ${e.entry.id}` : `remove ${e.id}`));
    const overlay = publishMisfitTo(service, grid(BOX));
    const ids = service.overlays().map((e) => e.id);
    expect(ids).toEqual(['misfit-fill', 'misfit-line-three_sigma', 'misfit-line-p95']);
    const byId = new Map(service.overlays().map((e) => [e.id, e]));
    expect(byId.get('misfit-fill')!.style).toMatchObject({ fillOpacity: 0.14, width: 0, casing: false, color: '--accent' });
    expect(byId.get('misfit-line-p95')!.style).toMatchObject({ dash: 'solid', labelProperty: 'label', color: '--accent' });
    expect(byId.get('misfit-line-three_sigma')!.style.dash).toEqual([5, 3]);
    expect(byId.get('misfit-line-p95')!.data.features[0]!.properties).toMatchObject({ label: '95 %', level: 'p95' });
    // Every published coordinate is a real position.
    for (const e of service.overlays()) {
      const text = JSON.stringify(e.data);
      expect(text).not.toMatch(/null|NaN/);
    }
    overlay.update(grid({ ...BOX, south_deg: 38 }));
    expect(service.overlays()).toHaveLength(3);
    overlay.remove();
    expect(service.overlays()).toHaveLength(0);
    expect(events.filter((e) => e.startsWith('remove'))).toHaveLength(3);
  });

  it('draws the 1-sigma line and no fill when asked, under its own prefix', () => {
    const service = new MapServiceImpl();
    publishMisfitTo(service, grid(BOX), { prefix: 'nav-misfit', levels: ['one_sigma', 'p95'], fill: false, z: 5 });
    const ids = service.overlays().map((e) => e.id);
    expect(ids).toEqual(['nav-misfit-line-p95', 'nav-misfit-line-one_sigma']);
    expect(service.overlays().every((e) => e.style.z === 7)).toBe(true);
  });
});

describe('image overlays on the map service', () => {
  it('holds a raster with its outline, so it can be framed and stacked', () => {
    const s = new MapServiceImpl();
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [
      [170, 10],
      [190, 10],
      [190, -10],
      [170, -10],
    ];
    s.addImageOverlay('heat', { url: 'data:image/png;base64,AAAA', coordinates }, { z: 3 });
    const entry = s.overlays()[0]!;
    expect(entry.image).toEqual({ url: 'data:image/png;base64,AAAA', coordinates, opacity: 0.7 });
    expect(entry.style.z).toBe(3);
    expect(entry.data.features[0]!.geometry.type).toBe('Polygon');
    const applied: { bounds?: number[] }[] = [];
    s.attachCamera({ apply: (r) => applied.push(r) });
    s.fitOverlay('heat');
    // The short way across the antimeridian.
    expect(applied[0]!.bounds![0]).toBeCloseTo(170, 9);
    expect(applied[0]!.bounds![2]).toBeCloseTo(190, 9);
    expect(() => s.addImageOverlay('web', { url: 'https://example.org/x.png', coordinates })).toThrow(/data: or blob:/);
    expect(() => s.addImageOverlay('bad', { url: 'data:,', coordinates: [[0, 0], [1, 0], [1, Number.NaN], [0, 1]] })).toThrow(/corners/);
  });
});

describe('the Mercator raster', () => {
  it('spaces its rows evenly in Web Mercator and keeps the grid box', () => {
    const g = grid({ south_deg: 10, north_deg: 60, west_deg: 170, east_deg: 190 });
    const heat = mercatorHeat(g, misfitRamp('light'), { width: 40, height: 100 });
    expect(heat.coordinates).toEqual([
      [170, 60],
      [190, 60],
      [190, 10],
      [170, 10],
    ]);
    expect(heat.data.length).toBe(40 * 100 * 4);
    // Every pixel is inside the grid, so opaque.
    for (let k = 3; k < heat.data.length; k += 4) expect(heat.data[k]).toBe(255);
    // The best point (the grid's centre) lands on the row Mercator puts 35 N on, not the
    // middle row: in Mercator 35 N is nearer the bottom of a 10-60 N box.
    const merc = (lat: number): number => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const expectedRow = ((merc(60) - merc(35)) / (merc(60) - merc(10))) * 100;
    let best = 0;
    let bestRow = 0;
    for (let py = 0; py < 100; py++) {
      const o = (py * 40 + 20) * 4;
      const lightness = heat.data[o]! + heat.data[o + 1]! + heat.data[o + 2]!;
      if (lightness > best) {
        best = lightness;
        bestRow = py;
      }
    }
    expect(Math.abs(bestRow - expectedRow)).toBeLessThan(2);
    expect(Math.abs(bestRow - 50)).toBeGreaterThan(5);
  });

  it('stops at the latitude MapLibre stops at', () => {
    const g = grid({ south_deg: 80, north_deg: 90, west_deg: -180, east_deg: 180 });
    const heat = mercatorHeat(g, misfitRamp('night'));
    expect(heat.coordinates[0]![1]).toBeCloseTo(85.051129, 6);
    expect(heat.width).toBe(82);
  });
});
