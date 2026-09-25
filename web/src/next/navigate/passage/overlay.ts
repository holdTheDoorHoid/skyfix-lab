/**
 * The passage on the explorer's map: a new overlay kind for routes, drawn through the map
 * agent's service (`map/overlays.ts`) with its antimeridian-safe builders. Great-circle
 * legs are solid, rhumb-line legs dashed, and each carries its label (meaning never rests
 * on colour alone); the waypoints are named; the dead-reckoning marks carry their times;
 * "DR now" marks the time bar's position on the route. OWNER: navigate2 agent.
 *
 * Its ids start with `passage-`, never `navigate-`: the fix's overlays (overlays.ts) replace
 * every `navigate-` layer on each result, and a route must outlive a fix.
 */

import type { FeatureCollection } from 'geojson';
import type { LatLonDeg } from '../../engine/types.js';
import { pathFeature, pointFeature, type MapService } from '../../map/overlays.js';
import type { LegKind } from '../model.js';
import type { OverlayLayer } from '../overlays.js';

export const ROUTE_PREFIX = 'passage-';

export interface RouteOverlayData {
  legs: { kind: LegKind; track: LatLonDeg[]; label: string }[];
  waypoints: { position: LatLonDeg; label: string }[];
  /**
   * The great circles' vertices (the highest latitude a leg reaches), drawn with the
   * waypoints, so framing the waypoints frames the whole route (a rhumb line never goes
   * beyond its ends in latitude or longitude).
   */
  vertices: { position: LatLonDeg; label: string }[];
  /** Dead-reckoning marks every so many hours. */
  ticks: { position: LatLonDeg; label: string }[];
  /** The route's position at the time bar's time. */
  now: { position: LatLonDeg; label: string } | null;
}

export function emptyRouteData(): RouteOverlayData {
  return { legs: [], waypoints: [], vertices: [], ticks: [], now: null };
}

const collection = (features: FeatureCollection['features']): FeatureCollection => ({ type: 'FeatureCollection', features });

/** The layers for a route, bottom to top. Pure: no map needed. */
export function routeOverlayLayers(data: RouteOverlayData): OverlayLayer[] {
  const layers: OverlayLayer[] = [];
  const gc = data.legs.filter((l) => l.kind === 'great_circle' && l.track.length > 1);
  const rl = data.legs.filter((l) => l.kind === 'rhumb' && l.track.length > 1);
  if (gc.length) {
    layers.push({
      id: `${ROUTE_PREFIX}route-gc`,
      data: collection(gc.map((l) => pathFeature(l.track, { label: l.label }))),
      style: { color: '--accent', width: 3, labelProperty: 'label', z: 6 },
    });
  }
  if (rl.length) {
    layers.push({
      id: `${ROUTE_PREFIX}route-rhumb`,
      data: collection(rl.map((l) => pathFeature(l.track, { label: l.label }))),
      style: { color: '--accent', width: 3, dash: [8, 5], labelProperty: 'label', z: 6 },
    });
  }
  if (data.ticks.length) {
    layers.push({
      id: `${ROUTE_PREFIX}dr-ticks`,
      data: collection(data.ticks.map((t) => pointFeature(t.position, { label: t.label }))),
      style: { color: '--compass-tick', pointRadius: 3, labelProperty: 'label', z: 7 },
    });
  }
  if (data.waypoints.length) {
    layers.push({
      id: `${ROUTE_PREFIX}waypoints`,
      data: collection([...data.waypoints, ...data.vertices].map((w) => pointFeature(w.position, { label: w.label }))),
      style: { color: '--accent', pointRadius: 5, labelProperty: 'label', z: 8 },
    });
  }
  if (data.now) {
    layers.push({
      id: `${ROUTE_PREFIX}dr-now`,
      data: collection([pointFeature(data.now.position, { label: data.now.label })]),
      style: { color: '--caution', pointRadius: 6, labelProperty: 'label', z: 9 },
    });
  }
  return layers;
}

/** Replace the route's overlays with `data`'s; every other overlay is untouched. */
export function publishRoute(service: MapService | null, data: RouteOverlayData): string[] {
  if (!service) return [];
  const layers = routeOverlayLayers(data);
  const keep = new Set(layers.map((l) => l.id));
  for (const entry of service.overlays()) {
    if (entry.id.startsWith(ROUTE_PREFIX) && !keep.has(entry.id)) service.removeOverlay(entry.id);
  }
  for (const layer of layers) service.addOverlay(layer.id, layer.data, layer.style);
  return layers.map((l) => l.id);
}

/** Remove the route from the map. */
export function clearRoute(service: MapService | null): void {
  if (!service) return;
  for (const entry of service.overlays()) {
    if (entry.id.startsWith(ROUTE_PREFIX)) service.removeOverlay(entry.id);
  }
}

/** Frame the route (applied when the map next mounts, if it is hidden). */
export function fitRoute(service: MapService | null): void {
  if (!service) return;
  // The waypoints layer holds the great circles' vertices too, so it frames the whole route.
  if (service.hasOverlay(`${ROUTE_PREFIX}waypoints`)) service.fitOverlay(`${ROUTE_PREFIX}waypoints`, { padding: 64, maxZoom: 9 });
}
