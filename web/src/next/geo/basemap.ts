/**
 * The offline basemap: which files exist and where to fetch them. OWNER: map-data agent.
 *
 * Every layer is a GeoJSON FeatureCollection under `data/basemap/`, built by
 * tools/mapdata/build.mjs from Natural Earth (public domain; no credit needed). The
 * manifest lists sizes, sources and processing. Conventions for every file:
 *
 *  - [lon, lat] degrees, longitude east-positive, all within [-180, 180];
 *  - polygons are split at the antimeridian (RFC 7946) and meet exactly on +/-180, so draw
 *    them as fills only; stroke the matching `coastline-*` file, which leaves out the
 *    artificial edges along the seam and the South Pole;
 *  - no segment spans more than 180 degrees of longitude;
 *  - exterior rings counter-clockwise (RFC 7946);
 *  - `minzoom` properties are Natural Earth's (256-pixel tiles): subtract 1 for MapLibre.
 *
 * Display-only (CONVENTIONS 13.6).
 */

import { dataUrl, fetchJson, type FetchLike } from './data.js';

/** Layer files, relative to `data/`. */
export const BASEMAP = {
  land110m: 'basemap/land-110m.geojson',
  coastline110m: 'basemap/coastline-110m.geojson',
  land50m: 'basemap/land-50m.geojson',
  coastline50m: 'basemap/coastline-50m.geojson',
  lakes: 'basemap/lakes-50m.geojson',
  rivers: 'basemap/rivers-50m.geojson',
  boundaries: 'basemap/boundaries-50m.geojson',
  countries: 'basemap/countries-50m.geojson',
  admin1: 'basemap/admin1-50m.geojson',
  urban: 'basemap/urban-50m.geojson',
  glaciers: 'basemap/glaciers-50m.geojson',
  iceShelves: 'basemap/ice-shelves-50m.geojson',
  marineLabels: 'basemap/marine-labels.geojson',
  physicalLabels: 'basemap/physical-labels.geojson',
  geolines: 'basemap/geolines-50m.geojson',
} as const;

export type BasemapLayer = keyof typeof BASEMAP;

export const BASEMAP_MANIFEST = 'basemap/manifest.json';

/** Absolute URL of a layer, resolved against the page (see data.ts). */
export function basemapUrl(layer: BasemapLayer, pageUrl?: string): string {
  return dataUrl(BASEMAP[layer], pageUrl);
}

export interface BasemapManifestFile {
  /** Relative to the manifest. */
  readonly path: string;
  readonly layer: string;
  readonly source: string;
  readonly bytes: number;
  readonly gzip_bytes: number;
  readonly sha256: string;
  readonly features?: number;
  readonly vertices?: number;
  readonly precision_deg?: number;
  readonly simplify_deg?: number;
  readonly properties?: string;
  readonly use?: string;
}

export interface BasemapManifest {
  readonly format: 'skyfix.basemap/1';
  readonly generated: string;
  readonly generator: string;
  readonly built_with: string;
  readonly sources: readonly { name: string; version: string; url: string; licence: string; retrieved: string }[];
  readonly total_bytes: number;
  readonly total_gzip_bytes: number;
  readonly files: readonly BasemapManifestFile[];
}

export async function loadBasemapManifest(opts: { fetch?: FetchLike; signal?: AbortSignal; pageUrl?: string } = {}): Promise<BasemapManifest> {
  const json = (await fetchJson(dataUrl(BASEMAP_MANIFEST, opts.pageUrl), opts.fetch, opts.signal)) as Partial<BasemapManifest>;
  if (json.format !== 'skyfix.basemap/1' || !Array.isArray(json.files)) throw new Error('basemap/manifest.json: unexpected format');
  return json as BasemapManifest;
}
