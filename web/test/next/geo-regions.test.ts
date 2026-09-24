/**
 * Point-in-country and point-in-state lookups (web/src/next/geo/regions.ts) on the shipped
 * lookup polygons, including the antimeridian and the 12 NM coastal margin.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGazetteer } from '../../src/next/geo/gazetteer.js';
import { buildRegionIndex, loadRegionIndex } from '../../src/next/geo/regions.js';

const DATA = join(import.meta.dirname, '../../public/data');
const json = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as unknown;
const g = parseGazetteer(json('gazetteer.json'));
const idx = buildRegionIndex(json('basemap/countries-50m.geojson'), json('basemap/admin1-50m.geojson'));

const country = (lat: number, lon: number, margin = 0) => {
  const hit = idx.locateCountry(lat, lon, margin);
  return hit ? g.countries[hit.index]!.name : null;
};
const region = (lat: number, lon: number, countryName: string, margin = 0) => {
  const c = g.countries.findIndex((x) => x.name === countryName);
  const hit = idx.locateRegion(lat, lon, c, margin);
  return hit ? g.regions[hit.index]!.name : null;
};

describe('countries', () => {
  it.each([
    [39.9526, -75.1652, 'United States'],
    [48.8566, 2.3522, 'France'],
    [-33.8688, 151.2093, 'Australia'],
    [35.6762, 139.6503, 'Japan'],
    [-15.79, -47.88, 'Brazil'],
    [64.9, -18.5, 'Iceland'],
    [43.5, -87.0, 'United States'], // in Lake Michigan: lakes count as the country's
    [41.9022, 12.4539, 'Italy'], // the Vatican is too small for the 1:50m polygons
    [4.93, -52.33, 'France'], // French Guiana is part of France's polygon
    [-80, 0, 'Antarctica'],
  ])('%f, %f is in %s', (lat, lon, name) => {
    expect(country(lat, lon)).toBe(name);
  });

  it('coastal city centres can fall just outside the 1:50m coast; the 12 NM margin catches them', () => {
    // Rio de Janeiro and Reykjavik sit on bays that the simplified coastline cuts across.
    expect(country(-22.9, -43.2, 12)).toBe('Brazil');
    expect(country(64.14, -21.94, 12)).toBe('Iceland');
  });

  it('open sea is in no country', () => {
    expect(country(0, -30)).toBeNull();
    expect(country(45, -40, 12)).toBeNull();
  });

  it('counts the 12 NM coastal margin only when asked, with the distance', () => {
    // About 5 NM off Atlantic City.
    expect(country(39.3, -74.3)).toBeNull();
    const hit = idx.locateCountry(39.3, -74.3, 12)!;
    expect(g.countries[hit.index]!.name).toBe('United States');
    expect(hit.distanceNm).toBeGreaterThan(0);
    expect(hit.distanceNm).toBeLessThanOrEqual(12);
    // 30 NM off is beyond it.
    expect(country(38.9, -74.5, 12)).toBeNull();
  });

  it('works on both sides of the antimeridian', () => {
    expect(country(-16.8, -179.95)).toBe('Fiji'); // Taveuni, east of 180
    expect(country(-17.8, 177.4)).toBe('Fiji'); // Viti Levu, west of 180
    expect(country(66, -172)).toBe('Russia'); // Chukotka, east of 180
    expect(country(71.2, -179.5)).toBe('Russia'); // Wrangel Island
    expect(country(52.9, 173.1)).toBe('United States'); // Attu, Aleutians, west of 180
  });

  it('finds the coast across the seam when the point is on the other side', () => {
    // Just west of 180 at sea, a few miles from Fiji land that lies east of 180.
    const hit = idx.locateCountry(-16.75, 179.97, 12);
    expect(hit && g.countries[hit.index]!.name).toBe('Fiji');
  });
});

describe('states and provinces of the large multi-zone countries', () => {
  it.each([
    [39.9526, -75.1652, 'United States', 'Pennsylvania'],
    [41.8781, -87.6298, 'United States', 'Illinois'],
    [33.4484, -112.074, 'United States', 'Arizona'],
    [45.5017, -73.5673, 'Canada', 'Québec'],
    [-31.95, 141.45, 'Australia', 'New South Wales'],
    [55.7558, 37.6173, 'Russia', 'Moskva'],
    [43.8, 87.6, 'China', 'Xinjiang'],
  ])('%f, %f is in %s / %s', (lat, lon, c, r) => {
    expect(region(lat, lon, c)).toBe(r);
  });

  it('only the seven large countries have states', () => {
    const has = (name: string) => idx.hasRegions(g.countries.findIndex((x) => x.name === name));
    for (const name of ['United States', 'Canada', 'Russia', 'Brazil', 'Australia', 'Indonesia', 'China']) expect(has(name), name).toBe(true);
    for (const name of ['France', 'India', 'Mexico', 'Japan']) expect(has(name), name).toBe(false);
    expect(region(48.8566, 2.3522, 'France')).toBeNull();
  });

  it('a state is only looked for inside its own country', () => {
    // Windsor, Ontario is due south of Detroit: asking for a US state there finds none.
    expect(region(42.3, -83.0, 'Canada')).toBe('Ontario');
    expect(region(42.3, -83.0, 'United States')).toBeNull();
  });
});

describe('loading', () => {
  it('fetches both files relative to the page, once', async () => {
    const seen: string[] = [];
    const fakeFetch = async (url: string) => {
      seen.push(url);
      const file = url.endsWith('countries-50m.geojson') ? 'basemap/countries-50m.geojson' : 'basemap/admin1-50m.geojson';
      return { ok: true, status: 200, json: async () => json(file) };
    };
    const pageUrl = 'https://example.test/skyfix-lab/next/';
    const [a, b] = await Promise.all([loadRegionIndex({ fetch: fakeFetch, pageUrl }), loadRegionIndex({ fetch: fakeFetch, pageUrl })]);
    expect(a).toBe(b);
    expect(seen.sort()).toEqual([
      'https://example.test/skyfix-lab/data/basemap/admin1-50m.geojson',
      'https://example.test/skyfix-lab/data/basemap/countries-50m.geojson',
    ]);
    expect(a.locateCountry(39.9526, -75.1652)).not.toBeNull();
  });

  it('rejects files that are not what it expects', () => {
    expect(() => buildRegionIndex({}, { features: [] })).toThrow(/not a FeatureCollection/);
    expect(() => buildRegionIndex({ features: [{ properties: {}, geometry: null }] }, { features: [] })).toThrow(/without integer "c"/);
  });
});
