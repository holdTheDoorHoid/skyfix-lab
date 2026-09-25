/**
 * How good is the time-zone guess? A hold-out measurement on the gazetteer's own cities:
 * for every place with a zone, guess the zone at its position as if the place were not in
 * the gazetteer, and compare with the place's zone.
 *
 *   exact       the same IANA id
 *   same clock  the same UTC offset on the 1st and 15th of every month of 2025-2026 (so
 *               America/Detroit counts as America/New_York; a zone with different daylight
 *               saving does not)
 *
 * A nautical-zone answer counts as a miss. "Truth" is Natural Earth's zone after the
 * build-time cleaning (tools/mapdata/build.mjs), so misses include places where Natural
 * Earth itself is wrong (Bali is filed under Asia/Jakarta, but uses Asia/Makassar).
 * Numbers are printed and recorded in docs/THIRD_PARTY.md; the thresholds below guard
 * against regressions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGazetteer } from '../../src/next/geo/gazetteer.js';
import { buildRegionIndex } from '../../src/next/geo/regions.js';
import { guessZone, zoneOffsetMinutes, type GuessSource } from '../../src/next/geo/timezone.js';

const DATA = join(import.meta.dirname, '../../public/data');
const json = (f: string) => JSON.parse(readFileSync(join(DATA, f), 'utf8')) as unknown;
const g = parseGazetteer(json('gazetteer.json'));
const regions = buildRegionIndex(json('basemap/countries-50m.geojson'), json('basemap/admin1-50m.geojson'));

const instants: number[] = [];
for (let y = 2025; y <= 2026; y++) for (let m = 0; m < 12; m++) for (const d of [1, 15]) instants.push(Date.UTC(y, m, d, 12));
const signatures = new Map<string, string>();
const clock = (id: string) => {
  let s = signatures.get(id);
  if (!s) {
    s = instants.map((t) => zoneOffsetMinutes({ kind: 'iana', id }, t)).join(',');
    signatures.set(id, s);
  }
  return s;
};

interface Tally {
  n: number;
  exact: number;
  sameClock: number;
  nautical: number;
}

function measure(useRegions: boolean) {
  const all: Tally = { n: 0, exact: 0, sameClock: 0, nautical: 0 };
  const bySource = new Map<GuessSource, Tally>();
  const missesByCountry = new Map<string, number>();
  for (const p of g.places) {
    if (!p.zone) continue;
    const r = guessZone(p.lat_deg, p.lon_deg, g, useRegions ? regions : null, { excludePlace: p.index });
    const t = bySource.get(r.source) ?? { n: 0, exact: 0, sameClock: 0, nautical: 0 };
    bySource.set(r.source, t);
    for (const x of [all, t]) x.n++;
    if (r.zone.kind !== 'iana') {
      for (const x of [all, t]) x.nautical++;
    } else {
      if (r.zone.id === p.zone) for (const x of [all, t]) x.exact++;
      if (clock(r.zone.id) === clock(p.zone)) {
        for (const x of [all, t]) x.sameClock++;
        continue;
      }
    }
    const c = g.countries[p.country]!.name;
    missesByCountry.set(c, (missesByCountry.get(c) ?? 0) + 1);
  }
  return { all, bySource, missesByCountry };
}

const pct = (a: number, n: number) => `${((100 * a) / n).toFixed(1)}%`;

describe('time-zone guess, hold-out on the gazetteer', () => {
  it('with country and state polygons (how the explorer runs)', () => {
    const { all, bySource, missesByCountry } = measure(true);
    const lines = [
      `hold-out, ${all.n} places: exact ${pct(all.exact, all.n)}, same clock ${pct(all.sameClock, all.n)}, nautical ${all.nautical}`,
      ...[...bySource].map(([s, t]) => `  ${s.padEnd(12)} ${String(t.n).padStart(5)}  exact ${pct(t.exact, t.n)}  same clock ${pct(t.sameClock, t.n)}`),
      `  misses by country: ${[...missesByCountry].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([c, n]) => `${c} ${n}`).join(', ')}`,
    ];
    console.info(lines.join('\n'));
    expect(all.n).toBeGreaterThan(6000);
    expect(all.sameClock / all.n).toBeGreaterThanOrEqual(0.975);
    expect(all.exact / all.n).toBeGreaterThanOrEqual(0.9);
  }, 30_000); // the hold-out runs 7 342 places through the polygons: slow on a loaded machine
});
