/**
 * Naming a position the map puts the observer on, and choosing its time zone
 * (web/src/next/map/place.ts), with the real offline gazetteer and country polygons.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGazetteer } from '../../src/next/geo/gazetteer.js';
import { buildRegionIndex } from '../../src/next/geo/regions.js';
import { describePlace, sameZone, zoneChoiceFromGuess, zonePinned } from '../../src/next/map/place.js';
import { zonePinned as storeZonePinned } from '../../src/next/state.js';

const DATA = join(import.meta.dirname, '../../public/data');
const g = parseGazetteer(JSON.parse(readFileSync(join(DATA, 'gazetteer.json'), 'utf8')));
const regions = buildRegionIndex(
  JSON.parse(readFileSync(join(DATA, 'basemap/countries-50m.geojson'), 'utf8')),
  JSON.parse(readFileSync(join(DATA, 'basemap/admin1-50m.geojson'), 'utf8')),
);

describe('which zones are the person’s own choice', () => {
  it('keeps UTC and zones marked guessed: false', () => {
    expect(zonePinned({ kind: 'utc' })).toBe(true);
    expect(zonePinned({ kind: 'iana', zone: 'Asia/Tokyo', guessed: false })).toBe(true);
  });

  it('re-guesses zones that came with a place and guessed zones, nautical included', () => {
    expect(zonePinned({ kind: 'iana', zone: 'America/New_York' })).toBe(false);
    expect(zonePinned({ kind: 'iana', zone: 'America/New_York', guessed: true })).toBe(false);
    expect(zonePinned({ kind: 'nautical' })).toBe(false);
    expect(zonePinned({ kind: 'nautical', guessed: true })).toBe(false);
  });

  it('keeps a nautical zone chosen by hand (the panel writes guessed: false)', () => {
    expect(zonePinned({ kind: 'nautical', guessed: false })).toBe(true);
  });

  it('is the store’s rule, so the map and the panel agree', () => {
    const zones = [
      { kind: 'utc' },
      { kind: 'nautical' },
      { kind: 'nautical', guessed: true },
      { kind: 'nautical', guessed: false },
      { kind: 'iana', zone: 'Asia/Tokyo' },
      { kind: 'iana', zone: 'Asia/Tokyo', guessed: true },
      { kind: 'iana', zone: 'Asia/Tokyo', guessed: false },
    ] as const;
    for (const z of zones) expect(zonePinned(z)).toBe(storeZonePinned(z));
  });

  it('compares choices', () => {
    expect(sameZone({ kind: 'nautical' }, { kind: 'nautical' })).toBe(true);
    expect(sameZone({ kind: 'iana', zone: 'Europe/Oslo', guessed: true }, { kind: 'iana', zone: 'Europe/Oslo' })).toBe(false);
    expect(sameZone({ kind: 'iana', zone: 'Europe/Oslo', guessed: true }, { kind: 'iana', zone: 'Europe/Oslo', guessed: true })).toBe(true);
    expect(sameZone({ kind: 'utc' }, { kind: 'nautical' })).toBe(false);
  });
});

describe('describing a clicked position', () => {
  it('names a city and guesses its zone', () => {
    const info = describePlace(g, regions, 39.96, -75.16, { kind: 'iana', zone: 'Europe/London' });
    expect(info.label).toMatch(/^near Philadelphia/);
    expect(info.zone).toEqual({ kind: 'iana', zone: 'America/New_York', guessed: true });
    expect(info.reason).not.toBe('');
  });

  it('says "At sea" and gives the nautical zone in open ocean', () => {
    const info = describePlace(g, regions, 35, -40, { kind: 'iana', zone: 'America/New_York' });
    expect(info.label).toMatch(/^At sea, /);
    expect(info.zone).toEqual({ kind: 'nautical' });
  });

  it('keeps a zone the person chose', () => {
    const info = describePlace(g, regions, 51.5, -0.12, { kind: 'utc' });
    expect(info.label).toMatch(/London/);
    expect(info.zone).toBeNull();
  });

  it('keeps a nautical zone chosen by hand when the place moves ashore', () => {
    const info = describePlace(g, regions, 51.5, -0.12, { kind: 'nautical', guessed: false });
    expect(info.label).toMatch(/London/);
    expect(info.zone).toBeNull();
  });

  it('works before the country polygons load (no "At sea", nearby places only)', () => {
    const info = describePlace(g, null, 48.86, 2.35, { kind: 'nautical' });
    expect(info.label).toMatch(/Paris/);
    expect(info.zone).toEqual({ kind: 'iana', zone: 'Europe/Paris', guessed: true });
  });

  it('turns guesses into the store’s zone choice', () => {
    expect(zoneChoiceFromGuess({ zone: { kind: 'nautical', zd: 3 }, source: 'sea', reason: '', anchor: null, anchorDistanceNm: Number.NaN, country: null })).toEqual({
      kind: 'nautical',
    });
    expect(
      zoneChoiceFromGuess({ zone: { kind: 'iana', id: 'No/Such_Zone' }, source: 'nearest', reason: '', anchor: null, anchorDistanceNm: 0, country: null }),
    ).toEqual({ kind: 'nautical' });
  });
});
