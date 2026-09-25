/**
 * The generated files in web/public/data (tools/mapdata/build.mjs): the manifest matches the
 * files, the size budget holds, and every layer keeps the conventions the map relies on
 * (ranges, antimeridian, winding). Also the page-relative data URLs (data.ts, basemap.ts).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { BASEMAP, basemapUrl, loadBasemapManifest, type BasemapManifest } from '../../src/next/geo/basemap.js';
import { dataRootUrl, dataUrl, setDataRoot } from '../../src/next/geo/data.js';
import { parseGazetteer } from '../../src/next/geo/gazetteer.js';

const DATA = join(import.meta.dirname, '../../public/data');
const BASE = join(DATA, 'basemap');
const text = (f: string) => readFileSync(join(DATA, f), 'utf8');
const manifest = JSON.parse(text('basemap/manifest.json')) as BasemapManifest;

type Pos = [number, number];
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: string; coordinates: unknown };
}

function linesOf(g: Feature['geometry']): Pos[][] {
  switch (g.type) {
    case 'LineString':
      return [g.coordinates as Pos[]];
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates as Pos[][];
    case 'MultiPolygon':
      return (g.coordinates as Pos[][][]).flat();
    default:
      return [];
  }
}

function signedArea(r: Pos[]): number {
  let s = 0;
  for (let i = 1; i < r.length; i++) s += r[i - 1]![0] * r[i]![1] - r[i]![0] * r[i - 1]![1];
  return s / 2;
}

describe('manifest', () => {
  it('lists every file with its true size and hash', () => {
    const onDisk = readdirSync(BASE).filter((f) => f !== 'manifest.json').sort();
    const listed = manifest.files.map((f) => f.path).filter((p) => !p.startsWith('../')).sort();
    expect(listed).toEqual(onDisk);
    for (const f of manifest.files) {
      const buf = readFileSync(join(BASE, f.path));
      expect(buf.length, f.path).toBe(f.bytes);
      expect(createHash('sha256').update(buf).digest('hex'), f.path).toBe(f.sha256);
      expect(gzipSync(buf, { level: 9 }).length, f.path).toBe(f.gzip_bytes);
    }
    expect(manifest.files.some((f) => f.path === '../gazetteer.json')).toBe(true);
  }, 30_000); // hashes 6.5 MB of basemap files: slow on a loaded machine

  it('stays within the 3 MB gzip budget', () => {
    const total = manifest.files.reduce((a, f) => a + f.gzip_bytes, 0);
    expect(manifest.total_gzip_bytes).toBe(total);
    expect(total).toBeLessThanOrEqual(3 * 1024 * 1024);
  });

  it('records sources, licence and how to rebuild', () => {
    expect(manifest.format).toBe('skyfix.basemap/1');
    expect(manifest.generator).toBe('node tools/mapdata/fetch.mjs && node tools/mapdata/build.mjs');
    const ne = manifest.sources.find((s) => s.name === 'Natural Earth')!;
    expect(ne.version).toBe('5.1.2');
    expect(ne.licence).toMatch(/Public domain/);
    expect(manifest.sources.find((s) => s.name === 'IANA time zone database')!.version).toBe('2026d');
  });

  it('every layer constant names a file in the manifest', () => {
    const listed = new Set(manifest.files.map((f) => `basemap/${f.path}`));
    for (const path of Object.values(BASEMAP)) expect(listed.has(path), path).toBe(true);
  });
});

describe('every layer', () => {
  const layers = readdirSync(BASE).filter((f) => f.endsWith('.geojson'));

  for (const file of layers) {
    it(`${file}: valid GeoJSON in range, nothing wraps the long way round`, () => {
      const fc = JSON.parse(readFileSync(join(BASE, file), 'utf8')) as { type: string; features: Feature[] };
      expect(fc.type).toBe('FeatureCollection');
      expect(fc.features.length).toBeGreaterThan(0);
      const problems: string[] = [];
      const bad = (msg: string) => problems.length < 20 && problems.push(msg);
      fc.features.forEach((f, fi) => {
        if (f.type !== 'Feature') bad(`feature ${fi} is not a Feature`);
        if (f.geometry.type === 'Point') {
          const [x, y] = f.geometry.coordinates as Pos;
          if (!(Math.abs(x) <= 180 && Math.abs(y) <= 90)) bad(`feature ${fi}: point ${x},${y} out of range`);
          return;
        }
        const polygon = f.geometry.type.endsWith('Polygon');
        for (const line of linesOf(f.geometry)) {
          if (line.length < (polygon ? 4 : 2)) bad(`feature ${fi}: ${line.length} vertices`);
          for (let i = 0; i < line.length; i++) {
            const [x, y] = line[i]!;
            if (!(Number.isFinite(x) && Math.abs(x) <= 180 && Math.abs(y) <= 90)) bad(`feature ${fi}: ${x},${y} out of range`);
            if (i > 0 && Math.abs(x - line[i - 1]![0]) > 180) bad(`feature ${fi}: a segment spans the world at ${x},${y}`);
          }
        }
        const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as Pos[][]] : f.geometry.type === 'MultiPolygon' ? (f.geometry.coordinates as Pos[][][]) : [];
        for (const poly of polys) {
          poly.forEach((ring, i) => {
            const [a, b] = [ring[0]!, ring[ring.length - 1]!];
            if (a[0] !== b[0] || a[1] !== b[1]) bad(`feature ${fi}: ring ${i} is not closed`);
            // RFC 7946: exterior counter-clockwise, holes clockwise.
            if (signedArea(ring) > 0 !== (i === 0)) bad(`feature ${fi}: ring ${i} has the wrong winding`);
          });
        }
      });
      expect(problems).toEqual([]);
    });
  }
});

describe('the antimeridian', () => {
  const load = (f: string) => (JSON.parse(readFileSync(join(BASE, f), 'utf8')) as { features: Feature[] }).features;

  it('land polygons meet exactly on +180 and -180', () => {
    const lons = new Set<number>();
    for (const f of load('land-50m.geojson')) for (const line of linesOf(f.geometry)) for (const [x] of line) if (Math.abs(x) > 179.99) lons.add(x);
    expect([...lons].sort()).toEqual([-180, 180]);
  });

  for (const scale of ['50m', '110m']) {
    it(`coastline-${scale} has no artificial edges along the seam or the South Pole`, () => {
      let edges = 0;
      for (const f of load(`coastline-${scale}.geojson`))
        for (const line of linesOf(f.geometry))
          for (let i = 1; i < line.length; i++) {
            const [a, b] = [line[i - 1]!, line[i]!];
            if (Math.abs(a[0]) === 180 && a[0] === b[0]) edges++;
            if (a[1] <= -89.99 && b[1] <= -89.99) edges++;
          }
      expect(edges).toBe(0);
    });
  }

  it('the civil date line is there, split at the antimeridian', () => {
    const idl = load('geolines-50m.geojson').find((f) => f.properties.kind === 'date-line')!;
    expect(idl.properties.name).toBe('International Date Line');
    expect(linesOf(idl.geometry).length).toBeGreaterThan(1);
  });
});

describe('the lookup polygons agree with the gazetteer', () => {
  const g = parseGazetteer(JSON.parse(text('gazetteer.json')));
  it('country and state indices name the same things', () => {
    for (const f of (JSON.parse(text('basemap/countries-50m.geojson')) as { features: Feature[] }).features) {
      const c = g.countries[f.properties.c as number]!;
      expect(c.name).toBe(f.properties.name);
      expect(c.lookup).toBe(c.index);
    }
    for (const f of (JSON.parse(text('basemap/admin1-50m.geojson')) as { features: Feature[] }).features) {
      const r = g.regions[f.properties.r as number]!;
      expect(r.name).toBe(f.properties.name);
      expect(r.country).toBe(f.properties.c);
    }
  });
});

describe('data URLs are relative to the page', () => {
  afterEach(() => setDataRoot(null));

  it.each([
    ['https://someone.github.io/skyfix-lab/next/', 'https://someone.github.io/skyfix-lab/data/'],
    ['https://someone.github.io/skyfix-lab/next/index.html', 'https://someone.github.io/skyfix-lab/data/'],
    ['https://someone.github.io/skyfix-lab/next/?engine=mock#map', 'https://someone.github.io/skyfix-lab/data/'],
    ['https://someone.github.io/skyfix-lab/', 'https://someone.github.io/skyfix-lab/data/'],
    ['https://someone.github.io/skyfix-lab/index.html', 'https://someone.github.io/skyfix-lab/data/'],
    ['http://localhost:5173/next/', 'http://localhost:5173/data/'],
    ['http://localhost:5173/', 'http://localhost:5173/data/'],
  ])('%s -> %s', (page, root) => {
    expect(dataRootUrl(page)).toBe(root);
    expect(dataUrl('gazetteer.json', page)).toBe(`${root}gazetteer.json`);
  });

  it('basemap layers resolve the same way', () => {
    expect(basemapUrl('land50m', 'https://someone.github.io/skyfix-lab/next/')).toBe('https://someone.github.io/skyfix-lab/data/basemap/land-50m.geojson');
  });

  it('can be overridden, and refuses absolute paths', () => {
    setDataRoot('https://cdn.invalid/mirror/data');
    expect(dataUrl('gazetteer.json', 'https://x.test/next/')).toBe('https://cdn.invalid/mirror/data/gazetteer.json');
    setDataRoot(null);
    expect(() => dataUrl('/data/gazetteer.json', 'https://x.test/')).toThrow(/relative/);
    expect(() => dataUrl('https://evil.test/x.json', 'https://x.test/')).toThrow(/relative/);
  });

  it('needs a page URL outside a browser', () => {
    expect(() => dataRootUrl()).toThrow(/No page URL/);
  });

  it('loads the manifest', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => manifest });
    const m = await loadBasemapManifest({ fetch: fetchImpl, pageUrl: 'https://x.test/next/' });
    expect(m.files.length).toBe(manifest.files.length);
    const bad = async () => ({ ok: true, status: 200, json: async () => ({}) });
    await expect(loadBasemapManifest({ fetch: bad, pageUrl: 'https://x.test/next/' })).rejects.toThrow(/unexpected format/);
  });
});
