/**
 * Publishing the Navigate view's result on the map: circles of position, the fix, its
 * nominal 95 % ellipse, ambiguous candidates, rejected alternatives, and the latitude line
 * of a noon or Polaris sight. OWNER: navigate agent.
 *
 * It uses the map agent's service (`map/overlays.ts`, see `map/README.md`): one service
 * per page, which keeps overlays while the map is hidden and draws them when it mounts, and
 * its antimeridian- and pole-safe feature builders. The shapes are built here as plain
 * data (`overlayLayers`, tested without a map) and handed over by `publishOverlays`, which
 * replaces exactly the layers this view owns (ids `navigate-…`) and no others. With no
 * service (`null`), publishing does nothing.
 *
 * Meaning never rests on colour alone (EXPLORER_PLAN 3.6): every circle is dash-dotted and
 * labelled with its body, the fix and each candidate carry a label, and a rejected
 * alternative says so in words.
 */

import type { FeatureCollection } from 'geojson';
import type { Ctx } from '../component.js';
import type { BodyKind, LatLonDeg } from '../engine/types.js';
import {
  circleOfPositionFeature,
  ellipseFeature,
  mapServiceFor,
  pathFeature,
  pointFeature,
  type MapService,
  type OverlayStyle,
} from '../map/overlays.js';
import { bodyToken } from '../theme/glyphs.js';

/** Every overlay id this view owns starts with this. */
export const OVERLAY_PREFIX = 'navigate-';

export interface OverlayCircle {
  id: string;
  body: string;
  kind?: BodyKind;
  gp: LatLonDeg;
  zenith_distance_deg: number;
}

export interface OverlayData {
  circles: OverlayCircle[];
  fix: LatLonDeg | null;
  /** Label beside the fix ("Fix", "Running fix 03:00 UTC", "Noon position"). */
  fixLabel?: string;
  ellipse: { centre: LatLonDeg; semi_major_m: number; semi_minor_m: number; orientation_deg: number } | null;
  candidates: LatLonDeg[];
  alternatives: { position: LatLonDeg; delta_chi2: number }[];
  /** Lines of latitude (a noon or Polaris latitude). */
  parallels: { lat_deg: number; label: string; body: string }[];
  /** Where to point the map's camera when there is no fix (a latitude line near the DR). */
  focus?: LatLonDeg;
}

export function emptyOverlayData(): OverlayData {
  return { circles: [], fix: null, ellipse: null, candidates: [], alternatives: [], parallels: [] };
}

export interface OverlayLayer {
  id: string;
  data: FeatureCollection;
  style: OverlayStyle;
}

const collection = (features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features });

/** The layers for a result, bottom to top. Pure: no map needed. */
export function overlayLayers(data: OverlayData): OverlayLayer[] {
  const layers: OverlayLayer[] = [];
  data.circles.forEach((c, i) => {
    layers.push({
      id: `${OVERLAY_PREFIX}cop-${i + 1}`,
      data: collection([
        circleOfPositionFeature(c.gp, c.zenith_distance_deg, { label: `${c.body} (circle of position)`, sight: c.id }),
      ]),
      style: { color: bodyToken(c.body, c.kind), dash: '--dash-circle', width: 2, labelProperty: 'label', z: 1 },
    });
  });
  if (data.parallels.length) {
    layers.push({
      id: `${OVERLAY_PREFIX}latitude`,
      data: collection(
        data.parallels.map((p) =>
          pathFeature(
            Array.from({ length: 73 }, (_, k) => ({ lat_deg: p.lat_deg, lon_deg: -180 + k * 5 })),
            { label: p.label },
          ),
        ),
      ),
      style: { color: bodyToken(data.parallels[0]!.body), dash: '--dash-rise', width: 2, labelProperty: 'label', z: 1 },
    });
  }
  if (data.ellipse) {
    const e = data.ellipse;
    layers.push({
      id: `${OVERLAY_PREFIX}ellipse`,
      data: collection([
        ellipseFeature(e.centre, e.semi_major_m / 1852, e.semi_minor_m / 1852, e.orientation_deg, {
          label: '95 % ellipse (nominal, independent-noise model)',
        }),
      ]),
      style: { color: '--accent', fillOpacity: 0.18, width: 1.5, z: 2 },
    });
  }
  if (data.alternatives.length) {
    layers.push({
      id: `${OVERLAY_PREFIX}alternatives`,
      data: collection(
        data.alternatives.map((a) => pointFeature(a.position, { label: `Rejected alternative (Δχ² ${a.delta_chi2.toFixed(1)})` })),
      ),
      style: { color: '--compass-tick', pointRadius: 4, labelProperty: 'label', z: 3 },
    });
  }
  if (data.candidates.length) {
    layers.push({
      id: `${OVERLAY_PREFIX}candidates`,
      data: collection(
        data.candidates.map((c, i) => pointFeature(c, { label: `Candidate ${String.fromCharCode(65 + i)} (ambiguous)` })),
      ),
      style: { color: '--caution', pointRadius: 6, labelProperty: 'label', z: 4 },
    });
  }
  if (data.fix) {
    layers.push({
      id: `${OVERLAY_PREFIX}fix`,
      data: collection([pointFeature(data.fix, { label: data.fixLabel ?? 'Fix' })]),
      style: { color: '--accent', pointRadius: 6, labelProperty: 'label', z: 5 },
    });
  }
  return layers;
}

/** The page's map service, or null when there is none (the adapter then does nothing). */
export function overlayServiceFor(ctx: Pick<Ctx, 'store'>): MapService | null {
  try {
    return mapServiceFor(ctx);
  } catch {
    return null;
  }
}

/** Replace this view's overlays with `data`'s; other views' overlays are untouched. */
export function publishOverlays(service: MapService | null, data: OverlayData): string[] {
  if (!service) return [];
  const layers = overlayLayers(data);
  const keep = new Set(layers.map((l) => l.id));
  for (const entry of service.overlays()) {
    if (entry.id.startsWith(OVERLAY_PREFIX) && !keep.has(entry.id)) service.removeOverlay(entry.id);
  }
  for (const layer of layers) service.addOverlay(layer.id, layer.data, layer.style);
  return layers.map((l) => l.id);
}

/** Remove every overlay this view published. */
export function clearOverlays(service: MapService | null): void {
  if (!service) return;
  for (const entry of service.overlays()) {
    if (entry.id.startsWith(OVERLAY_PREFIX)) service.removeOverlay(entry.id);
  }
}

/** Frame the result on the map (applied when the map next mounts, if it is hidden). */
export function fitOverlays(service: MapService | null, data: OverlayData): void {
  if (!service) return;
  if (data.fix) service.flyTo(data.fix, 7);
  else if (data.focus) service.flyTo(data.focus, 4);
  else if (data.candidates.length) service.fitOverlay(`${OVERLAY_PREFIX}candidates`, { maxZoom: 5 });
  else if (data.circles.length) service.fitOverlay(`${OVERLAY_PREFIX}cop-1`, { maxZoom: 4 });
}
