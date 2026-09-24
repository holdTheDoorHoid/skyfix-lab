/**
 * The map's live layers (web/src/next/map/world.ts), its style (style.ts, validated against
 * the MapLibre style specification) and the overlay service (overlays.ts).
 */
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';
import type { BodyState } from '../../src/next/engine/types.js';
import { angularDistanceDeg, multiPolygonContains } from '../../src/next/map/geometry.js';
import {
  MapServiceImpl,
  capFeature,
  circleOfPositionFeature,
  collectionBounds,
  ellipseFeature,
  mapServiceFor,
  pathFeature,
  pointFeature,
  toFeatureCollection,
} from '../../src/next/map/overlays.js';
import { LAYER, LAYER_GROUPS, buildStyle, streetsLayer, streetsSource } from '../../src/next/map/style.js';
import { lineDash, type MapTokens } from '../../src/next/map/style-tokens.js';
import { altitudeRingData, equalAltitudeFeatures, shadeFeatures, terminatorFeatures } from '../../src/next/map/world.js';

const RAD = Math.PI / 180;

const TOKENS: MapTokens = {
  theme: 'light',
  water: '#c9dce6',
  land: '#f6f3ec',
  coast: '#9bb1bf',
  border: '#c3c9cd',
  graticule: 'rgba(58, 84, 108, 0.2)',
  shade: '#0e1d3a',
  shadeTargets: [0.13, 0.25, 0.36, 0.47],
  ice: '#fbfaf7',
  urban: '#e3e1dc',
  river: '#b4c9d4',
  labelInk: '#45525f',
  labelHalo: 'rgba(246, 243, 236, 0.9)',
  waterInk: '#6b7b88',
  waterHalo: 'rgba(201, 220, 230, 0.75)',
  stageInk: '#17202a',
  stageInk2: '#45525f',
  accent: '#f2b63c',
  lineHalo: 'rgba(22, 16, 4, 0.86)',
  body: {
    sun: '#f5b400',
    moon: '#a9bcd6',
    mercury: '#a7a7a7',
    venus: '#efdcb0',
    mars: '#d9683f',
    jupiter: '#d7a874',
    saturn: '#cebd7e',
    uranus: '#5cc2bf',
    neptune: '#6e93ee',
    star: '#ffffff',
  },
  rise: '#ff9f43',
  transit: '#ffd878',
  set: '#ff6b5e',
  dash: { now: [], path: [], rise: [7, 4], set: [0.5, 4.5], below: [2, 4], circle: [10, 4, 2, 4] },
};

/** A body state with the fields the map reads; Hc from the navigation formula (CONVENTIONS 3). */
function body(name: string, kind: BodyState['kind'], gp: { lat_deg: number; lon_deg: number }, observer: { lat_deg: number; lon_deg: number }): BodyState {
  const lha = (-gp.lon_deg + observer.lon_deg) * RAD;
  const hc =
    Math.asin(Math.sin(observer.lat_deg * RAD) * Math.sin(gp.lat_deg * RAD) + Math.cos(observer.lat_deg * RAD) * Math.cos(gp.lat_deg * RAD) * Math.cos(lha)) /
    RAD;
  return {
    body: name,
    kind,
    gha_deg: (360 - gp.lon_deg) % 360,
    dec_deg: gp.lat_deg,
    sha_deg: 0,
    ra_deg: 0,
    gp,
    alt_deg: hc,
    az_deg: 0,
    alt_apparent_deg: hc,
    hc_deg: hc,
    zn_deg: 0,
    above_horizon: hc > 0,
    distance_km: null,
    semidiameter_arcmin: 16,
    horizontal_parallax_arcmin: 0,
    magnitude: null,
    phase_angle_deg: null,
    illuminated_fraction: null,
    elongation_deg: null,
    bright_limb_angle_deg: null,
    parallactic_angle_deg: 0,
    constellation: null,
  };
}

describe('world layers', () => {
  const sunGp = { lat_deg: 12.3, lon_deg: -150 };

  it('shades four stacked bands with twilight on', () => {
    const fc = shadeFeatures(sunGp, { terminator: true, twilight: true }, TOKENS);
    expect(fc.features.map((f) => f.properties!.band)).toEqual(['civil', 'nautical', 'astronomical', 'night']);
    let clear = 1;
    fc.features.forEach((f, i) => {
      clear *= 1 - (f.properties!.alpha as number);
      expect(1 - clear).toBeCloseTo(TOKENS.shadeTargets[i]!, 12);
    });
  });

  it('shades the whole not-day side once with only day and night on', () => {
    const fc = shadeFeatures(sunGp, { terminator: true, twilight: false }, TOKENS);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties!.alpha).toBe(TOKENS.shadeTargets[1]);
    expect(shadeFeatures(sunGp, { terminator: false, twilight: false }, TOKENS).features).toHaveLength(0);
    expect(terminatorFeatures(sunGp).features[0]!.geometry.type).toBe('MultiLineString');
  });

  it('draws the circle of equal altitude through the observer, labelled with Hc', () => {
    const observer = { lat_deg: 39.9526, lon_deg: -75.1652 };
    const venus = body('Venus', 'planet', { lat_deg: -8.4, lon_deg: -20.3 }, observer);
    const fc = equalAltitudeFeatures(venus, TOKENS, 'dm');
    const f = fc.features[0]!;
    expect(f.properties!.color).toBe(TOKENS.body.venus);
    expect(f.properties!.label).toMatch(/^Venus at \d+° \d\d\.\d′$/);
    // The observer is on the circle: at 90 - Hc from the ground point.
    expect(angularDistanceDeg(venus.gp, observer)).toBeCloseTo(90 - venus.hc_deg, 9);
    for (const line of (f.geometry as { coordinates: number[][][] }).coordinates) {
      for (const [lon, lat] of line) expect(angularDistanceDeg(venus.gp, { lat_deg: lat!, lon_deg: lon! })).toBeCloseTo(90 - venus.hc_deg, 1);
    }
    expect(equalAltitudeFeatures(undefined, TOKENS, 'dm').features).toHaveLength(0);
  });

  it('colours the altitude rings with the body', () => {
    const moon = body('Moon', 'moon', { lat_deg: 5, lon_deg: 100 }, { lat_deg: 0, lon_deg: 0 });
    const fc = altitudeRingData(moon, TOKENS);
    expect(fc.features).toHaveLength(9);
    expect(new Set(fc.features.map((f) => f.properties!.color))).toEqual(new Set([TOKENS.body.moon]));
  });
});

describe('style', () => {
  it('is a valid MapLibre style in every theme', () => {
    for (const theme of ['light', 'dark', 'night'] as const) {
      for (const projection of ['mercator', 'globe'] as const) {
        const style = buildStyle({ ...TOKENS, theme }, { projection }, 'http://localhost/next/');
        const errors = validateStyleMin(style);
        expect(errors, JSON.stringify(errors.slice(0, 3))).toEqual([]);
      }
    }
    const withStreets = buildStyle(TOKENS, { projection: 'mercator' }, 'http://localhost/next/');
    withStreets.sources.streets = streetsSource();
    withStreets.layers.push(streetsLayer(TOKENS));
    expect(validateStyleMin(withStreets)).toEqual([]);
  });

  it('names only layers that exist, and loads basemap files relative to the page', () => {
    const style = buildStyle(TOKENS, { projection: 'mercator' }, 'https://example.org/skyfix-lab/next/');
    const ids = new Set(style.layers.map((l) => l.id));
    expect(ids.size).toBe(style.layers.length);
    for (const group of Object.values(LAYER_GROUPS)) for (const id of group) expect(ids.has(id), id).toBe(true);
    expect(ids.has(LAYER.overlaysBefore)).toBe(true);
    expect(ids.has(LAYER.streetsBefore)).toBe(true);
    const land = style.sources['bm-land110'] as { data: string };
    expect(land.data).toBe('https://example.org/skyfix-lab/data/basemap/land-110m.geojson');
    // No glyph server: MapLibre draws labels from the page's own font files.
    expect(style.glyphs).toBeUndefined();
    // The only network source is the optional street layer, never in the default style.
    expect(JSON.stringify(style)).not.toMatch(/openstreetmap/);
  });

  it('converts pixel dashes to line widths', () => {
    expect(lineDash([], 2)).toBeUndefined();
    expect(lineDash([10, 4, 2, 4], 2)).toEqual([5, 2, 1, 2]);
    expect(lineDash([0, 4], 2)![0]).toBeGreaterThan(0);
  });

  it('street tiles follow the OpenStreetMap usage policy', () => {
    const src = streetsSource();
    expect(src.tiles).toEqual(['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
    expect(src.maxzoom).toBe(19);
  });
});

describe('overlay service', () => {
  it('adds, replaces, orders and removes overlays, and tells its listeners', () => {
    const s = new MapServiceImpl();
    const events: string[] = [];
    const stop = s.subscribe((e) => events.push(e.kind === 'set' ? `set ${e.entry.id}` : `remove ${e.id}`));
    s.addOverlay('fix', pointFeature({ lat_deg: 40, lon_deg: -70 }), { z: 2 });
    s.addOverlay('cop-1', circleOfPositionFeature({ lat_deg: 10, lon_deg: 20 }, 50));
    s.addOverlay('fix', pointFeature({ lat_deg: 41, lon_deg: -70 }), { z: 2 });
    expect(s.overlays().map((e) => e.id)).toEqual(['cop-1', 'fix']); // by z, then first added
    expect(s.hasOverlay('fix')).toBe(true);
    s.removeOverlay('fix');
    s.removeOverlay('nothing');
    stop();
    s.addOverlay('late', pointFeature({ lat_deg: 0, lon_deg: 0 }));
    expect(events).toEqual(['set fix', 'set cop-1', 'set fix', 'remove fix']);
    expect(() => s.addOverlay('bad id!', pointFeature({ lat_deg: 0, lon_deg: 0 }))).toThrow(/overlay id/);
  });

  it('remembers a camera request until a map mounts', () => {
    const s = new MapServiceImpl();
    s.addOverlay('path', pathFeature([
      { lat_deg: 10, lon_deg: 170 },
      { lat_deg: 20, lon_deg: -170 },
    ]));
    s.fitOverlay('path');
    const applied: unknown[] = [];
    s.attachCamera({ apply: (r) => applied.push(r) });
    expect(applied).toHaveLength(1);
    const req = applied[0] as { kind: string; bounds: number[] };
    expect(req.kind).toBe('fit');
    // The short way across the antimeridian: from 170 E to 190 (= 170 W).
    expect(req.bounds[0]).toBeCloseTo(170, 9);
    expect(req.bounds[2]).toBeCloseTo(190, 9);
    s.flyTo({ lat_deg: 1, lon_deg: 2 }, 5);
    expect(applied).toHaveLength(2);
  });

  it('is one service per page (per store)', () => {
    const store = {};
    const a = mapServiceFor({ store } as never);
    expect(mapServiceFor({ store } as never)).toBe(a);
    expect(mapServiceFor({ store: {} } as never)).not.toBe(a);
  });

  it('builds features other views need', () => {
    expect(toFeatureCollection({ type: 'Point', coordinates: [1, 2] }).features).toHaveLength(1);
    const cap = capFeature({ lat_deg: -80, lon_deg: 0 }, 15);
    expect(multiPolygonContains(cap.geometry.coordinates, [123, -89])).toBe(true);
    const ellipse = ellipseFeature({ lat_deg: 40, lon_deg: 179.9 }, 30, 10, 45, { label: 'fix' });
    expect(ellipse.geometry.coordinates.length).toBe(2); // split at the antimeridian
    expect(collectionBounds({ type: 'FeatureCollection', features: [] })).toBeNull();
  });
});
