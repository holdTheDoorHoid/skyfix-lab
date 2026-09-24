/**
 * "Which country (and, in big multi-zone countries, which state) is this point in?"
 * OWNER: map-data agent.
 *
 * Built from `basemap/countries-50m.geojson` and `basemap/admin1-50m.geojson`, whose features
 * carry the gazetteer's country (`c`) and region (`r`) indices. The polygons are Natural
 * Earth 1:50m, simplified to about 1 km for lookups; borders are shared exactly between
 * neighbours. A point within `marginNm` of a polygon (12 NM, the territorial sea, is what the
 * time-zone guess uses) counts as in it, which also absorbs the ~1 km coastline error.
 */

import { dataUrl, fetchJson, type FetchLike } from './data.js';

export const COUNTRIES_FILE = 'basemap/countries-50m.geojson';
export const ADMIN1_FILE = 'basemap/admin1-50m.geojson';

type Ring = readonly (readonly [number, number])[];

interface Box {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** A run of up to CHUNK segments of one ring, with its bounding box (for the margin search). */
interface Chunk extends Box {
  readonly ring: Ring;
  readonly from: number;
  readonly to: number;
}

interface Part extends Box {
  readonly key: number;
  readonly rings: readonly Ring[];
  readonly chunks: readonly Chunk[];
}

const CHUNK = 32;

function boxOf(ring: Ring, from: number, to: number): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = from; i <= to; i++) {
    const [x, y] = ring[i] as readonly [number, number];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export interface LocateResult {
  /** Gazetteer country or region index. */
  readonly index: number;
  /** 0 when inside; otherwise the distance to the polygon's edge, nautical miles. */
  readonly distanceNm: number;
}

export interface RegionIndex {
  /** The country containing the point, or the nearest within `marginNm`. */
  locateCountry(lat: number, lon: number, marginNm?: number): LocateResult | null;
  /** The state of `country` containing the point, or the nearest within `marginNm`; null if the country has none. */
  locateRegion(lat: number, lon: number, country: number, marginNm?: number): LocateResult | null;
  /** Whether `country` has state polygons (the large multi-zone countries only). */
  hasRegions(country: number): boolean;
}

const NM_PER_DEG = 60;

function pointInRing(x: number, y: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i] as readonly [number, number];
    const b = ring[j] as readonly [number, number];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function inPart(x: number, y: number, part: Part): boolean {
  const [outer, ...holes] = part.rings;
  if (!outer || !pointInRing(x, y, outer)) return false;
  return !holes.some((h) => pointInRing(x, y, h));
}

/** Distance in NM from (lat, lon) to segment a-b, local flat approximation (fine for tens of NM). */
function segmentDistanceNm(lat: number, lon: number, a: readonly [number, number], b: readonly [number, number]): number {
  const k = Math.cos((lat * Math.PI) / 180);
  const wrap = (d: number) => (d > 180 ? d - 360 : d < -180 ? d + 360 : d);
  const ax = wrap(a[0] - lon) * k;
  const bx = wrap(b[0] - lon) * k;
  const ay = a[1] - lat;
  const by = b[1] - lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(ax + t * dx, ay + t * dy) * NM_PER_DEG;
}

interface GeoFeature {
  properties?: Record<string, unknown> | null;
  geometry?: { type: string; coordinates: unknown } | null;
}

function partsOf(features: readonly GeoFeature[], keyName: string, what: string): Part[] {
  const parts: Part[] = [];
  for (const f of features) {
    const key = f.properties?.[keyName];
    if (!Number.isInteger(key)) throw new Error(`${what}: feature without integer "${keyName}"`);
    const g = f.geometry;
    if (!g) continue;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : null) as
      | (readonly Ring[])[]
      | null;
    if (!polys) throw new Error(`${what}: ${g.type} is not a polygon`);
    for (const rings of polys) {
      const outer = rings[0];
      if (!outer || outer.length < 2) continue;
      const chunks: Chunk[] = [];
      for (const ring of rings)
        for (let from = 0; from < ring.length - 1; from += CHUNK) {
          const to = Math.min(ring.length - 1, from + CHUNK);
          chunks.push({ ring, from, to, ...boxOf(ring, from, to) });
        }
      parts.push({ key: key as number, rings, chunks, ...boxOf(outer, 0, outer.length - 1) });
    }
  }
  return parts;
}

function locate(parts: readonly Part[], lat: number, lon: number, marginNm: number, accept: (key: number) => boolean): LocateResult | null {
  for (const p of parts) {
    if (!accept(p.key)) continue;
    if (lon < p.minX || lon > p.maxX || lat < p.minY || lat > p.maxY) continue;
    if (inPart(lon, lat, p)) return { index: p.key, distanceNm: 0 };
  }
  if (!(marginNm > 0)) return null;
  const mLat = marginNm / NM_PER_DEG;
  const mLon = mLat / Math.max(0.01, Math.cos((Math.min(89, Math.abs(lat)) * Math.PI) / 180));
  // Near the antimeridian, also look on the other side of it.
  const lons = [lon];
  if (lon + mLon > 180) lons.push(lon - 360);
  if (lon - mLon < -180) lons.push(lon + 360);
  let best: LocateResult | null = null;
  let bestD = marginNm;
  const near = (b: Box) => lat >= b.minY - mLat && lat <= b.maxY + mLat && lons.some((x) => x >= b.minX - mLon && x <= b.maxX + mLon);
  for (const p of parts) {
    if (!accept(p.key) || !near(p)) continue;
    for (const c of p.chunks) {
      if (!near(c)) continue;
      for (let i = c.from + 1; i <= c.to; i++) {
        const d = segmentDistanceNm(lat, lon, c.ring[i - 1] as readonly [number, number], c.ring[i] as readonly [number, number]);
        if (d < bestD) {
          bestD = d;
          best = { index: p.key, distanceNm: d };
        }
      }
    }
  }
  return best;
}

/** Index the two GeoJSON FeatureCollections (as parsed JSON). */
export function buildRegionIndex(countries: unknown, admin1: unknown): RegionIndex {
  const feats = (fc: unknown, what: string): GeoFeature[] => {
    const f = (fc as { features?: unknown } | null)?.features;
    if (!Array.isArray(f)) throw new Error(`${what}: not a FeatureCollection`);
    return f as GeoFeature[];
  };
  const countryParts = partsOf(feats(countries, COUNTRIES_FILE), 'c', COUNTRIES_FILE);
  const regionFeatures = feats(admin1, ADMIN1_FILE);
  const regionParts = partsOf(regionFeatures, 'r', ADMIN1_FILE);
  const regionCountry = new Map<number, number>();
  const countriesWithRegions = new Set<number>();
  for (const f of regionFeatures) {
    const r = f.properties?.r;
    const c = f.properties?.c;
    if (Number.isInteger(r) && Number.isInteger(c)) {
      regionCountry.set(r as number, c as number);
      countriesWithRegions.add(c as number);
    }
  }
  return {
    locateCountry: (lat, lon, marginNm = 0) => locate(countryParts, lat, lon, marginNm, () => true),
    locateRegion: (lat, lon, country, marginNm = 0) =>
      countriesWithRegions.has(country) ? locate(regionParts, lat, lon, marginNm, (r) => regionCountry.get(r) === country) : null,
    hasRegions: (country) => countriesWithRegions.has(country),
  };
}

const loaded = new Map<string, Promise<RegionIndex>>();

/** Fetch both polygon files (relative to the page) once and index them. */
export function loadRegionIndex(opts: { fetch?: FetchLike; signal?: AbortSignal; pageUrl?: string } = {}): Promise<RegionIndex> {
  const cUrl = dataUrl(COUNTRIES_FILE, opts.pageUrl);
  const aUrl = dataUrl(ADMIN1_FILE, opts.pageUrl);
  const key = `${cUrl} ${aUrl}`;
  let p = loaded.get(key);
  if (!p) {
    p = Promise.all([fetchJson(cUrl, opts.fetch, opts.signal), fetchJson(aUrl, opts.fetch, opts.signal)]).then(([c, a]) =>
      buildRegionIndex(c, a),
    );
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}
