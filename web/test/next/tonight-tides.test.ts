/**
 * The Tonight view's tides card: the one-degree station cells it decides the offer with
 * (tonight/tide-cells.ts) against the committed `tides-us` pack — the same cells, and never
 * a place with a station within 100 NM left without the offer — and the card's states with
 * the mock engine's synthetic station.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { NO_PACKS } from '../../src/next/packs/service.js';
import type { PackService, PackState } from '../../src/next/engine/types.js';
import { cellDistanceNm, mayHaveTideStation, TIDE_CELLS, TIDE_CELLS_FROM, tideCells } from '../../src/next/tonight/tide-cells.js';
import { tideCard, tideHeight, usableStations } from '../../src/next/tonight/tides.js';

const PACKS = resolve(import.meta.dirname, '../../public/data/packs');
const EARTH_KM = 6371.0088;

/** Station positions from the pack file (EXPLORER_API "The tides-us pack: file and payload"). */
function stations(file: string): { lat: number; lon: number }[] {
  const buf = readFileSync(file);
  let p = 10;
  const nameLen = buf.readUInt16LE(p);
  p += 2 + nameLen;
  const payloadLen = buf.readUInt32LE(p);
  p += 4;
  const pay = buf.subarray(p, p + payloadLen);
  let q = 6;
  const str8 = (): void => {
    q += 1 + pay[q]!;
  };
  str8();
  const k = pay[q]!;
  q += 1;
  for (let i = 0; i < k; i += 1) str8();
  const b = pay[q]!;
  q += 1;
  const count = pay.readUInt32LE(q);
  q += 4;
  const out: { lat: number; lon: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    str8();
    str8();
    str8();
    out.push({ lat: pay.readInt32LE(q) / 1e6, lon: pay.readInt32LE(q + 4) / 1e6 });
    const kind = pay[q + 8];
    q += 10;
    if (kind === 0) {
      q += 16;
      let bits = 0;
      for (let j = 0; j < b; j += 1) if (pay[q + (j >> 3)]! & (1 << (j & 7))) bits += 1;
      q += Math.ceil(b / 8) + bits * 4;
      q += 1 + pay[q]! * 5;
    } else {
      q += 11;
    }
  }
  expect(q).toBe(pay.length);
  return out;
}

function nm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return (2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)))) / 1.852;
}

/** A small deterministic generator (no Math.random: the test must be the same every run). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const file = readdirSync(PACKS).find((f) => /^tides-us-[0-9a-f]{16}\.bin$/.test(f))!;
const all = stations(join(PACKS, file));

describe('the tide-station cells', () => {
  it('are the committed pack’s (run dev/tide-cells.mjs when the pack changes)', () => {
    expect(TIDE_CELLS_FROM).toBe(file);
    const cells = [...new Set(all.map((s) => (Math.floor(s.lat) + 90) * 360 + ((((Math.floor(s.lon) + 180) % 360) + 360) % 360)))].sort((a, b) => a - b);
    expect([...tideCells()]).toEqual(cells);
    expect(TIDE_CELLS.length).toBeLessThan(2000);
  });

  it('measure the distance to a cell exactly on the sphere', () => {
    const cell = (40 + 90) * 360 + (-75 + 180); // 40..41 N, 75..74 W
    expect(cellDistanceNm(40.5, -74.5, cell)).toBe(0);
    expect(cellDistanceNm(42, -74.5, cell)).toBeCloseTo(nm(42, -74.5, 41, -74.5), 6);
    // West of the cell: the nearest point is on its west edge, at the foot of the perpendicular.
    const d = cellDistanceNm(40.5, -77, cell);
    let best = Infinity;
    for (let i = 0; i <= 1000; i += 1) best = Math.min(best, nm(40.5, -77, 40 + i / 1000, -75));
    expect(d).toBeCloseTo(best, 3);
  });

  it('never leave a place with a station within 100 NM without the offer', () => {
    const rnd = lcg(20260925);
    let near = 0;
    let offered = 0;
    let generous = 0;
    for (let i = 0; i < 4000; i += 1) {
      // Around a random station, out to 150 NM, so both sides of the radius are tried.
      const s = all[Math.floor(rnd() * all.length)]!;
      const r = (rnd() * 150) / 60;
      const a = rnd() * 2 * Math.PI;
      const lat = Math.max(-89.9, Math.min(89.9, s.lat + r * Math.cos(a)));
      const lon = s.lon + (r * Math.sin(a)) / Math.max(0.05, Math.cos((lat * Math.PI) / 180));
      const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
      let nearest = Infinity;
      for (const t of all) nearest = Math.min(nearest, nm(lat, wrapped, t.lat, t.lon));
      const may = mayHaveTideStation(lat, wrapped);
      if (nearest <= 100) {
        near += 1;
        expect(may, `${lat},${wrapped}: a station ${nearest.toFixed(1)} NM away`).toBe(true);
      }
      if (may) offered += 1;
      if (may && nearest > 100) generous += 1;
    }
    expect(near).toBeGreaterThan(1000);
    // Generous at most by a cell's width: rarely beyond the radius.
    expect(generous / offered).toBeLessThan(0.25);
  });

  it('offer tides on US coasts and islands, and not inland or abroad', () => {
    expect(mayHaveTideStation(39.9526, -75.1652)).toBe(true); // Philadelphia
    expect(mayHaveTideStation(37.8, -122.4)).toBe(true); // San Francisco
    expect(mayHaveTideStation(21.3, -157.86)).toBe(true); // Honolulu
    expect(mayHaveTideStation(61.2, -149.9)).toBe(true); // Anchorage
    expect(mayHaveTideStation(39.1, -94.58)).toBe(false); // Kansas City
    expect(mayHaveTideStation(40.42, -3.7)).toBe(false); // Madrid
    expect(mayHaveTideStation(-33.87, 151.21)).toBe(false); // Sydney
  });
});

describe('the tides card', () => {
  const PHILLY = { lat: 39.9526, lon: -75.1652 };
  const night: [number, number] = [2461308.45, 2461308.95];

  it('shows the nearest station’s high and low water through the night, as the engine gives them', () => {
    const engine = new MockEngine({ syntheticStars: 0 });
    const card = tideCard({ engine, packs: NO_PACKS }, PHILLY.lat, PHILLY.lon, night[0], night[1], false);
    expect(card.kind).toBe('ready');
    if (card.kind !== 'ready') return;
    const near = usableStations(engine.tideStationsNear(PHILLY.lat, PHILLY.lon, 5));
    expect(card.station.id).toBe(near[0]!.id);
    const t = engine.tideExtremes(card.station.id, night[0], Math.max(night[1], night[0] + 0.55), '');
    expect(card.extremes).toEqual(t.extremes);
    expect(card.label).toMatch(/predictions, not observations/);
  });

  it('offers the pack near a station when it is not loaded, and hides far from one', () => {
    const engine = new MockEngine({ syntheticStars: 0, tidesLoaded: false });
    const offered = { name: 'tides-us', offered: true, saved: false, bytes: 344543 } as PackState;
    const packs: PackService = { ...NO_PACKS, status: () => [offered] };
    const card = tideCard({ engine, packs }, PHILLY.lat, PHILLY.lon, night[0], night[1], false);
    expect(card).toEqual({ kind: 'offer', bytes: 344543, declined: false, offline: false });
    expect(tideCard({ engine, packs }, 40.42, -3.7, night[0], night[1], false)).toEqual({ kind: 'hidden', why: 'far' });
    expect(tideCard({ engine, packs }, PHILLY.lat, PHILLY.lon, night[0], night[1], true)).toEqual({ kind: 'loading' });
    // A site that does not offer the pack: nothing to offer.
    const none: PackService = { ...NO_PACKS, status: () => [{ ...offered, offered: false }] };
    expect(tideCard({ engine, packs: none }, PHILLY.lat, PHILLY.lon, night[0], night[1], false)).toEqual({ kind: 'hidden', why: 'engine' });
    // Before 1900 and after 2100 there are no predictions.
    expect(tideCard({ engine, packs }, PHILLY.lat, PHILLY.lon, 2400000, 2400000.5, false)).toEqual({ kind: 'hidden', why: 'outside' });
  });

  it('writes heights in the chosen units', () => {
    expect(tideHeight(1.94, 'metric')).toBe('1.9 m');
    expect(tideHeight(-0.1, 'nautical')).toBe('−0.1 m');
    expect(tideHeight(0.6096, 'imperial')).toBe('2.0 ft');
  });
});
