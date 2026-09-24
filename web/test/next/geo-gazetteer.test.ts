/**
 * The offline gazetteer (web/src/next/geo/gazetteer.ts) against the shipped
 * web/public/data/gazetteer.json.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GAZETTEER_FORMAT,
  PLACE_FLAGS,
  compassPoint,
  describeLocation,
  interpretQuery,
  loadGazetteer,
  nearestPlace,
  parseGazetteer,
  placeLabel,
  placesGeoJson,
  searchPlaces,
  type Gazetteer,
} from '../../src/next/geo/gazetteer.js';
import { isSupportedZone, resolveIntlZone } from '../../src/next/geo/timezone.js';

const FILE = join(import.meta.dirname, '../../public/data/gazetteer.json');
const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
const g: Gazetteer = parseGazetteer(raw);

const first = (q: string, opts = {}) => {
  const m = searchPlaces(g, q, opts)[0];
  return m ? placeLabel(g, m.place) : null;
};

describe('the shipped file', () => {
  it('parses and has the expected size', () => {
    expect(g.format).toBe(GAZETTEER_FORMAT);
    expect(g.places.length).toBe(7342);
    expect(g.places.filter((p) => p.zone).length).toBeGreaterThan(6100);
    // Every place with a zone is an anchor, plus the 418 zone.tab principal locations.
    expect(g.anchors.length).toBe(g.places.filter((p) => p.zone).length + 418);
    expect(g.regions.length).toBeGreaterThan(200);
    expect(g.sources.places).toMatch(/Natural Earth 5\.1\.2/);
  });

  it('lists places largest first, with sane values', () => {
    const problems: string[] = [];
    g.places.forEach((p, i) => {
      if (i > 0 && p.population > g.places[i - 1]!.population) problems.push(`${p.name}: out of population order`);
      if (!(Math.abs(p.lat_deg) <= 90 && p.lon_deg > -180 && p.lon_deg <= 180)) problems.push(`${p.name}: position out of range`);
      if (p.name !== p.name.trim() || /\s{2}/.test(p.name)) problems.push(`${p.name}: untidy whitespace`);
      if (/[?]/.test(p.admin1) || p.admin1.includes(String.fromCharCode(0xfffd))) problems.push(`${p.name}: damaged state name ${p.admin1}`);
    });
    expect(problems).toEqual([]);
  });

  it('every zone is one this runtime can show (directly or through a same-clock alternative)', () => {
    for (const z of g.zones) expect(resolveIntlZone(z), z).not.toBeNull();
    // This Node knows them all directly.
    expect(g.zones.filter((z) => !isSupportedZone(z))).toEqual([]);
  });

  it('carries the build-time zone corrections with their rule', () => {
    const prague = g.corrections.find((c) => c.place === 'Prague');
    expect(prague).toMatchObject({ from: 'America/Chicago', to: 'Europe/Prague', rule: 'B' });
    expect(g.corrections.find((c) => c.place === 'Punta Arenas')).toMatchObject({ to: 'America/Punta_Arenas', rule: 'C' });
    const p = g.places.find((x) => x.name === 'Prague')!;
    expect(p.zone).toBe('Europe/Prague');
    expect(p.flags & PLACE_FLAGS.zoneCorrected).toBeTruthy();
    expect(p.flags & PLACE_FLAGS.capital).toBeTruthy();
  });

  it('knows capitals, states and stations', () => {
    const phila = g.places.find((x) => x.name === 'Philadelphia')!;
    expect(g.countries[phila.country]!.name).toBe('United States');
    expect(g.regions[phila.region]).toMatchObject({ name: 'Pennsylvania', code: 'PA' });
    expect(phila.zone).toBe('America/New_York');
    const mcmurdo = g.places.find((x) => x.name === 'McMurdo Station')!;
    expect(mcmurdo.flags & PLACE_FLAGS.station).toBeTruthy();
    expect(mcmurdo.alt).not.toContain('USA');
  });
});

describe('parseGazetteer rejects damaged input', () => {
  it('wrong format or layout', () => {
    expect(() => parseGazetteer(null)).toThrow(/not an object/);
    expect(() => parseGazetteer({ ...raw, format: 'x' })).toThrow(/format is x/);
    expect(() => parseGazetteer({ ...raw, fields: { ...(raw.fields as object), places: ['name'] } })).toThrow(/unsupported places layout/);
  });

  it('out-of-range references', () => {
    const places = (raw.places as unknown[][]).slice(0, 3).map((r) => [...r]);
    places[0]![3] = 99999;
    expect(() => parseGazetteer({ ...raw, places })).toThrow(/country 99999 out of range/);
    const bad = (raw.places as unknown[][]).slice(0, 1).map((r) => [...r]);
    bad[0]![5] = 123;
    expect(() => parseGazetteer({ ...raw, places: bad })).toThrow(/position out of range/);
  });
});

describe('search', () => {
  it('finds exact names first, the biggest place first', () => {
    expect(first('philadelphia')).toBe('Philadelphia, Pennsylvania, United States');
    expect(first('Paris')).toBe('Paris, Île-de-France, France');
    expect(first('new york')).toBe('New York, United States');
    expect(first('lagos')).toBe('Lagos, Nigeria');
  });

  it('ignores accents, case and punctuation', () => {
    expect(first('sao paulo')).toBe('São Paulo, Brazil');
    expect(first('SÃO-PAULO')).toBe('São Paulo, Brazil');
    expect(first('reykjavik')).toMatch(/^Reykjavík/);
    expect(first('saint petersburg')).toMatch(/^St\. Petersburg, .*Russia$/);
    expect(first('st petersburg')).toMatch(/^St\. Petersburg, .*Russia$/);
  });

  it('knows other names and languages', () => {
    const m = searchPlaces(g, 'München')[0]!;
    expect(m.place.name).toBe('Munich');
    expect(m.matchedName).toBe('München');
    expect(first('munchen')).toMatch(/^Munich/);
    expect(first('bombay')).toMatch(/^Mumbai/);
    expect(first('den haag')).toMatch(/^The Hague/);
    expect(first('wien')).toMatch(/^Vienna/);
    expect(first('kiev')).toMatch(/^Kyiv/);
  });

  it('matches the start of a name before a word inside it', () => {
    const r = searchPlaces(g, 'york', { limit: 10 });
    const names = r.map((m) => m.place.name);
    expect(names.slice(0, 2)).toEqual(['York', 'York']);
    expect(names).toContain('New York');
    expect(r.find((m) => m.place.name === 'New York')!.how).toBe('word');
  });

  it('tolerates a typo when nothing matches exactly', () => {
    const m = searchPlaces(g, 'philadelpia')[0]!;
    expect(m.place.name).toBe('Philadelphia');
    expect(m.how).toBe('typo');
    // With good matches there are no typo fillers.
    expect(searchPlaces(g, 'sao paulo').every((x) => x.how !== 'typo')).toBe(true);
  });

  it('narrows by country, state or state code after a comma, or without one', () => {
    expect(first('Portland, ME')).toBe('Portland, Maine, United States');
    expect(first('portland, maine')).toBe('Portland, Maine, United States');
    expect(first('portland or')).toBe('Portland, Oregon, United States');
    expect(first('paris france')).toBe('Paris, Île-de-France, France');
    expect(first('Santiago, Chile')).toMatch(/Chile$/);
    expect(first('Springfield, MO')).toBe('Springfield, Missouri, United States');
    expect(first('london, uk')).toMatch(/^London, .*United Kingdom$/);
    expect(first('London, CA')).toMatch(/^London, Ontario, Canada$/);
    expect(searchPlaces(g, 'Paris, Texas')).toEqual([]);
  });

  it('a state name lists its places', () => {
    const texas = searchPlaces(g, 'Texas');
    expect(texas[0]!.how).toBe('state');
    expect(texas.every((m) => m.place.admin1 === 'Texas')).toBe(true);
    expect(texas.map((m) => m.place.name)).toContain('Houston');
    expect(texas.map((m) => m.place.name)).toContain('Austin');
    expect(searchPlaces(g, 'bayern').map((m) => m.place.name)).toContain('Munich');
  });

  it('a country name lists its places, capital first', () => {
    expect(first('France')).toMatch(/^Paris/);
    expect(first('usa')).toMatch(/^Washington, D\.C\./);
    const georgia = searchPlaces(g, 'Georgia');
    expect(georgia[0]!.how).toBe('country');
    expect(placeLabel(g, georgia[0]!.place)).toBe('Tbilisi, Georgia');
    // Georgia is also a US state: the second half of the list.
    expect(georgia.map((m) => m.place.name)).toContain('Atlanta');
    // Name matches follow the listing.
    expect(searchPlaces(g, 'France', { limit: 30 }).map((m) => m.place.name)).toContain('Franceville');
  });

  it('prefers places near a given point when names tie', () => {
    expect(first('portland', { near: { lat_deg: 44, lon_deg: -70 } })).toBe('Portland, Maine, United States');
    expect(first('portland', { near: { lat_deg: -38, lon_deg: 142 } })).toBe('Portland, Victoria, Australia');
  });

  it('respects the limit and returns nothing for nonsense', () => {
    expect(searchPlaces(g, 'san', { limit: 3 })).toHaveLength(3);
    expect(searchPlaces(g, 'zzqxj')).toEqual([]);
    expect(searchPlaces(g, '   ')).toEqual([]);
    expect(searchPlaces(g, ',')).toEqual([]);
  });

  it('is quick enough to run on every keystroke', () => {
    const t0 = performance.now();
    for (const q of ['p', 'ph', 'phi', 'phil', 'phila', 'philad', 'philade', 'philadel']) searchPlaces(g, q);
    expect((performance.now() - t0) / 8).toBeLessThan(80);
  });
});

describe('interpretQuery', () => {
  it('reads coordinates as a position', () => {
    expect(interpretQuery(g, '39.95, -75.17')).toEqual({ kind: 'position', position: { lat_deg: 39.95, lon_deg: -75.17 } });
    expect(interpretQuery(g, 'N 39 57.2 W 75 09.9')).toMatchObject({ kind: 'position' });
  });

  it('reads names as a place search', () => {
    const r = interpretQuery(g, 'Philadelphia');
    expect(r.kind).toBe('places');
    if (r.kind === 'places') expect(r.matches[0]!.place.name).toBe('Philadelphia');
  });

  it('explains a position that does not parse', () => {
    expect(interpretQuery(g, '39 57 N')).toEqual({ kind: 'none', message: expect.stringMatching(/Only one coordinate/) });
    expect(interpretQuery(g, '95, 10')).toEqual({ kind: 'none', message: expect.stringMatching(/beyond the pole/) });
    expect(interpretQuery(g, 'qqqzz')).toEqual({ kind: 'none', message: 'No place called "qqqzz" in the offline list.' });
    expect(interpretQuery(g, '')).toMatchObject({ kind: 'none' });
  });
});

describe('nearest place and descriptions', () => {
  it('finds the nearest place', () => {
    const n = nearestPlace(g, 39.9526, -75.1652)!;
    expect(n.place.name).toBe('Philadelphia');
    expect(n.distanceNm).toBeLessThan(2);
    expect(nearestPlace(g, 39.9526, -75.1652, { maxDistanceNm: 0.1 })).toBeNull();
    expect(nearestPlace(g, 39.9526, -75.1652, { minPopulation: 10_000_000 })!.place.name).toBe('New York');
  });

  it('works across the antimeridian', () => {
    // Just east of 180 in Fiji: the nearest place is on the other side of the seam.
    const n = nearestPlace(g, -16.8, -179.95)!;
    expect(g.countries[n.place.country]!.name).toBe('Fiji');
    expect(n.distanceNm).toBeLessThan(60);
  });

  it('names a suburb after the big city next to it', () => {
    expect(describeLocation(g, 39.93, -75.12).text).toBe('near Philadelphia, Pennsylvania, United States');
  });

  it('gives distance and direction farther out, and says when at sea', () => {
    const d = describeLocation(g, 38.9, -74.5, { atSea: true });
    expect(d.text).toMatch(/^At sea, \d+ NM [NESW]{1,3} of .+, New Jersey, United States$/);
    expect(d.distanceNm).toBeGreaterThan(8);
  });

  it('never names a place a thousand miles away for a remote point just because it is big', () => {
    const d = describeLocation(g, 1.87, -157.4);
    const n = nearestPlace(g, 1.87, -157.4)!;
    expect(d.place!.index).toBe(n.place.index);
  });

  it('compass points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(45)).toBe('NE');
    expect(compassPoint(202.5)).toBe('SSW');
    expect(compassPoint(-90)).toBe('W');
    expect(compassPoint(Number.NaN)).toBe('');
  });

  it('labels leave out a state that repeats the name', () => {
    const tokyo = g.places.find((p) => p.name === 'Tokyo')!;
    expect(placeLabel(g, tokyo)).toBe('Tokyo, Japan');
    const phila = g.places.find((p) => p.name === 'Philadelphia')!;
    expect(placeLabel(g, phila, { admin1: false })).toBe('Philadelphia, United States');
    expect(placeLabel(g, phila, { country: false })).toBe('Philadelphia, Pennsylvania');
  });
});

describe('map labels', () => {
  it('builds a GeoJSON point collection without copying data to disk', () => {
    const all = placesGeoJson(g);
    expect(all.type).toBe('FeatureCollection');
    expect(all.features).toHaveLength(g.places.length);
    const phila = all.features.find((f) => f.properties.name === 'Philadelphia')!;
    expect(phila.geometry.coordinates).toEqual([-75.1798, 39.9459]);
    const world = placesGeoJson(g, { maxMinZoom: 2 });
    expect(world.features.length).toBeGreaterThan(10);
    expect(world.features.length).toBeLessThan(100);
    const paris = world.features.find((f) => f.properties.name === 'Paris')!;
    expect(paris.properties.capital).toBe(2);
    expect(world.features.find((f) => f.properties.name === 'Philadelphia')).toBeUndefined();
    expect(placesGeoJson(g, { maxLabelRank: 0 }).features.every((f) => f.properties.rank === 0)).toBe(true);
    expect(placesGeoJson(g, { minPopulation: 10_000_000 }).features.every((f) => f.properties.population >= 10_000_000)).toBe(true);
  });
});

describe('loadGazetteer', () => {
  it('fetches once per URL and parses', async () => {
    let calls = 0;
    const fakeFetch = async () => {
      calls++;
      return { ok: true, status: 200, json: async () => raw };
    };
    const url = 'https://example.test/skyfix-lab/data/gazetteer.json';
    const [a, b] = await Promise.all([loadGazetteer({ url, fetch: fakeFetch }), loadGazetteer({ url, fetch: fakeFetch })]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(a.places.length).toBe(7342);
  });

  it('reports a failed download and retries next time', async () => {
    const url = 'https://example.test/missing/gazetteer.json';
    const failing = async () => ({ ok: false, status: 404, json: async () => null });
    await expect(loadGazetteer({ url, fetch: failing })).rejects.toThrow(/Could not load .* \(HTTP 404\)/);
    const working = async () => ({ ok: true, status: 200, json: async () => raw });
    await expect(loadGazetteer({ url, fetch: working })).resolves.toMatchObject({ format: GAZETTEER_FORMAT });
  });
});
