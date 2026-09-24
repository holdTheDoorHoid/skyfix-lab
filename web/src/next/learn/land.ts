/**
 * Land outlines for the Learn globe, from the offline basemap the site already ships
 * (`data/basemap/land-110m.geojson`, Natural Earth, public domain; see geo/basemap.ts and
 * docs/THIRD_PARTY.md). OWNER: learn agent.
 *
 * Display only (CONVENTIONS 13.6): the outlines make "the other crossing is in Nigeria"
 * visible and nothing else reads them. Loaded once per page, on first use; if the file
 * cannot be read the globe is drawn without land and says so.
 */

import { BASEMAP } from '../geo/basemap.js';
import { dataUrl } from '../geo/data.js';
import type { LandRings } from './chart.js';

let pending: Promise<LandRings> | null = null;

type Ring = [number, number][];
interface Geometry {
  type: string;
  coordinates: unknown;
}

/** Every ring of every polygon in a GeoJSON FeatureCollection, as [lon, lat] pairs. */
export function ringsOf(json: unknown): LandRings {
  const out: Ring[] = [];
  const features = (json as { features?: { geometry?: Geometry | null }[] } | null)?.features;
  if (!Array.isArray(features)) return out;
  const addPolygon = (poly: unknown): void => {
    if (!Array.isArray(poly)) return;
    for (const ring of poly) {
      if (!Array.isArray(ring)) continue;
      const pts: Ring = [];
      for (const p of ring) {
        if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') pts.push([p[0], p[1]]);
      }
      if (pts.length >= 3) out.push(pts);
    }
  };
  for (const f of features) {
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') addPolygon(g.coordinates);
    else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) for (const poly of g.coordinates) addPolygon(poly);
  }
  return out;
}

/** The land rings (cached for the page). Rejects when the file cannot be read. */
export function loadLand(fetchImpl: typeof fetch = fetch): Promise<LandRings> {
  pending ??= fetchImpl(dataUrl(BASEMAP.land110m))
    .then((res) => {
      if (!res.ok) throw new Error(`Could not load the land outlines (HTTP ${res.status}).`);
      return res.json() as Promise<unknown>;
    })
    .then(ringsOf)
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}
