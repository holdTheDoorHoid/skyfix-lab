/**
 * Eclipses on the map: the Events view's overlays through the map service (map/README.md,
 * "The map service"). OWNER: eclipse agent (Events view). The builders are pure and tested
 * in web/test/next/events.test.ts; `showEclipse` and `clearEclipse` only talk to the service.
 *
 * Solar: the central line, the limits of totality or annularity (with the path between
 * them filled when that is safe to draw as one polygon), the small loops that close the
 * path at sunrise and sunset, the limits of the partial eclipse and its sunrise/sunset
 * curves, and the point of greatest eclipse. Every line is the engine's (`eclipse_path`),
 * already split at the antimeridian.
 *
 * Lunar: where the Moon is up at greatest eclipse (the half of the Earth around the point
 * under the Moon), and the Moon's horizon when the eclipse begins and when it ends.
 */

import type { Feature, FeatureCollection, MultiLineString } from 'geojson';
import type {
  EclipsePolyline,
  LatLonDeg,
  LunarEclipsePath,
  SolarEclipsePath,
  SublunarPoint,
} from '../engine/types.js';
import { unwrap } from '../map/geometry.js';
import {
  areaFeature,
  capFeature,
  circleOfPositionFeature,
  pointFeature,
  type MapService,
  type OverlayStyle,
} from '../map/overlays.js';

/** Every overlay this view draws starts with this; the rest of the map's overlays are not touched. */
export const OVERLAY_PREFIX = 'events-eclipse-';

/**
 * The Moon is above the rise/set altitude (CONVENTIONS 13.3, `−(34′ + SD)`) within about
 * 89.9° of the point under it: its parallax (0.95°) lowers it by about as much as
 * refraction and its semidiameter raise the horizon.
 */
export const MOON_UP_RADIUS_DEG = 89.9;

export interface OverlaySpec {
  id: string;
  data: FeatureCollection;
  style: OverlayStyle;
}

type Props = Record<string, unknown>;

function collection(features: (Feature | null)[]): FeatureCollection {
  return { type: 'FeatureCollection', features: features.filter((f): f is Feature => f !== null) };
}

/** A polyline as one GeoJSON feature, or null when it has no segment to draw. */
export function polylineFeature(line: EclipsePolyline, properties: Props): Feature<MultiLineString> | null {
  const coordinates = line.segments.filter((s) => s.length >= 2).map((s) => s.map(([lon, lat]) => [lon, lat]));
  return coordinates.length ? { type: 'Feature', properties, geometry: { type: 'MultiLineString', coordinates } } : null;
}

const SEAM_TOLERANCE_DEG = 1e-6;

/**
 * The polyline's pieces with the antimeridian cuts undone: consecutive segments that meet
 * on the seam (one ends at ±180, the next starts at ∓180 at the same latitude) are joined.
 */
export function joinSegments(line: EclipsePolyline): LatLonDeg[][] {
  const out: LatLonDeg[][] = [];
  let current: LatLonDeg[] | null = null;
  let last: [number, number] | null = null;
  for (const segment of line.segments) {
    if (segment.length === 0) continue;
    const first = segment[0]!;
    const joins =
      current !== null &&
      last !== null &&
      Math.abs(Math.abs(last[0]) - 180) < SEAM_TOLERANCE_DEG &&
      Math.abs(Math.abs(first[0]) - 180) < SEAM_TOLERANCE_DEG &&
      Math.abs(last[1] - first[1]) < SEAM_TOLERANCE_DEG;
    const points = segment.map(([lon, lat]) => ({ lat_deg: lat, lon_deg: lon }));
    if (joins && current) current.push(...points.slice(1));
    else {
      current = points;
      out.push(current);
    }
    last = segment[segment.length - 1]!;
  }
  return out;
}

function distance2(a: LatLonDeg, b: LatLonDeg): number {
  const dLon = Math.abs(a.lon_deg - b.lon_deg) % 360;
  const dx = Math.min(dLon, 360 - dLon) * Math.cos(((a.lat_deg + b.lat_deg) / 2) * (Math.PI / 180));
  const dy = a.lat_deg - b.lat_deg;
  return dx * dx + dy * dy;
}

/**
 * The outline of the path between two limits, as one ring, or null when that would be
 * wrong to fill: a limit in more than one piece, or a ring that goes round a pole or more
 * than once round in longitude (paths that cross the polar regions). The ends are closed
 * with straight edges; the loops that really close them at sunrise and sunset are drawn
 * as lines beside it.
 */
export function pathRing(north: EclipsePolyline, south: EclipsePolyline): LatLonDeg[] | null {
  const n = joinSegments(north);
  const s = joinSegments(south);
  if (n.length !== 1 || s.length !== 1) return null;
  const a = n[0]!;
  let b = s[0]!;
  if (a.length < 2 || b.length < 2) return null;
  // Run the second limit back from the end nearest the first limit's end.
  if (distance2(a[a.length - 1]!, b[0]!) < distance2(a[a.length - 1]!, b[b.length - 1]!)) b = [...b];
  else b = [...b].reverse();
  const ring = [...a, ...b];
  const unwrapped = unwrap([...ring, ring[0]!]);
  const closure = unwrapped[unwrapped.length - 1]![0]! - unwrapped[0]![0]!;
  if (Math.abs(closure) > 1) return null; // winds round a pole
  let min = Infinity;
  let max = -Infinity;
  for (const [lon] of unwrapped) {
    min = Math.min(min, lon!);
    max = Math.max(max, lon!);
  }
  if (max - min > 300) return null;
  if (ring.some((p) => Math.abs(p.lat_deg) > 85)) return null;
  return ring;
}

export interface SolarLabels {
  /** `Greatest eclipse, 18:17 UTC`. */
  greatest: string;
}

function isCentral(path: SolarEclipsePath): boolean {
  return path.central_line.segments.some((s) => s.length >= 2) || path.umbra_north.segments.length + path.umbra_south.segments.length > 0;
}

/** The overlays of a solar eclipse, bottom to top. */
export function solarOverlays(path: SolarEclipsePath, labels: SolarLabels): OverlaySpec[] {
  const eclipse = path.id;
  const annular = path.type === 'annular';
  const limitName = annular ? 'Limit of the annular eclipse' : path.type === 'hybrid' ? 'Limit of the central eclipse' : 'Limit of totality';
  const props = (label: string, extra: Props = {}): Props => ({ eclipse, label, ...extra });
  const out: OverlaySpec[] = [];

  out.push({
    id: `${OVERLAY_PREFIX}partial`,
    data: collection([
      polylineFeature(path.penumbra_north, props('Limit of the partial eclipse')),
      polylineFeature(path.penumbra_south, props('Limit of the partial eclipse')),
    ]),
    style: { color: '--body-moon', width: 1.5, dash: '--dash-rise', labelProperty: 'label', z: 1 },
  });
  out.push({
    id: `${OVERLAY_PREFIX}partial-horizon`,
    data: collection([polylineFeature(path.penumbra_horizon, props('Eclipse at sunrise or sunset'))]),
    style: { color: '--body-moon', width: 1.5, dash: '--dash-set', labelProperty: 'label', z: 1 },
  });

  if (isCentral(path)) {
    const ring = pathRing(path.umbra_north, path.umbra_south);
    if (ring) {
      out.push({
        id: `${OVERLAY_PREFIX}path-fill`,
        data: collection([areaFeature(ring, props(''))]),
        style: { color: '--body-sun', fill: '--body-sun', fillOpacity: 0.28, width: 0, casing: false, z: 2 },
      });
    }
    out.push({
      id: `${OVERLAY_PREFIX}path-limits`,
      data: collection([
        polylineFeature(path.umbra_north, props(limitName)),
        polylineFeature(path.umbra_south, props(limitName)),
      ]),
      style: { color: '--body-sun', width: 2, labelProperty: 'label', z: 3 },
    });
    out.push({
      id: `${OVERLAY_PREFIX}path-ends`,
      data: collection([polylineFeature(path.umbra_horizon, props(annular ? 'Annular at sunrise or sunset' : 'Total at sunrise or sunset'))]),
      style: { color: '--body-sun', width: 2, dash: '--dash-set', z: 3 },
    });
    out.push({
      id: `${OVERLAY_PREFIX}central-line`,
      data: collection([polylineFeature(path.central_line, props('Central line'))]),
      style: { color: '--body-sun', width: 1, labelProperty: 'label', z: 4 },
    });
  }
  out.push({
    id: `${OVERLAY_PREFIX}greatest`,
    data: collection([
      pointFeature({ lat_deg: path.greatest.lat_deg, lon_deg: path.greatest.lon_deg }, props(labels.greatest)),
    ]),
    style: { color: '--body-sun', pointRadius: 5, labelProperty: 'label', z: 5 },
  });
  return out;
}

function contactPoint(path: LunarEclipsePath, kinds: readonly string[]): SublunarPoint | null {
  for (const k of kinds) {
    const p = path.sublunar.find((s) => s.kind === k);
    if (p) return p;
  }
  return null;
}

export interface LunarLabels {
  /** `Moon overhead at greatest eclipse`. */
  overhead: string;
}

/** The overlays of a lunar eclipse, bottom to top. */
export function lunarOverlays(path: LunarEclipsePath, labels: LunarLabels): OverlaySpec[] {
  const eclipse = path.id;
  // The part people watch: the umbral eclipse when there is one, else the penumbral.
  const umbral = path.sublunar.some((s) => s.kind === 'u1');
  const start = contactPoint(path, umbral ? ['u1'] : ['p1']);
  const end = contactPoint(path, umbral ? ['u4'] : ['p4']);
  const max = contactPoint(path, ['max']);
  const at = (p: SublunarPoint): LatLonDeg => ({ lat_deg: p.lat_deg, lon_deg: p.lon_deg });
  const out: OverlaySpec[] = [];
  if (max) {
    out.push({
      id: `${OVERLAY_PREFIX}moon-up`,
      data: collection([capFeature(at(max), MOON_UP_RADIUS_DEG, { eclipse, label: 'Moon up at greatest eclipse' })]),
      style: { color: '--body-moon', fill: '--body-moon', fillOpacity: 0.16, width: 1.5, labelProperty: 'label', z: 1 },
    });
  }
  const phase = umbral ? 'partial eclipse' : 'eclipse';
  if (start) {
    out.push({
      id: `${OVERLAY_PREFIX}moon-start`,
      data: collection([
        circleOfPositionFeature(at(start), MOON_UP_RADIUS_DEG, { eclipse, label: `Moon on the horizon as the ${phase} begins` }),
      ]),
      style: { color: '--body-moon', width: 1.5, dash: '--dash-rise', labelProperty: 'label', z: 2 },
    });
  }
  if (end) {
    out.push({
      id: `${OVERLAY_PREFIX}moon-end`,
      data: collection([
        circleOfPositionFeature(at(end), MOON_UP_RADIUS_DEG, { eclipse, label: `Moon on the horizon as the ${phase} ends` }),
      ]),
      style: { color: '--body-moon', width: 1.5, dash: '--dash-set', labelProperty: 'label', z: 2 },
    });
  }
  if (max) {
    out.push({
      id: `${OVERLAY_PREFIX}overhead`,
      data: collection([pointFeature(at(max), { eclipse, label: labels.overhead })]),
      style: { color: '--body-moon', pointRadius: 5, labelProperty: 'label', z: 3 },
    });
  }
  return out;
}

/** The overlay to fit the camera to: the path when there is one, else the whole area. */
export function fitTarget(specs: readonly OverlaySpec[]): string | null {
  const prefer = ['path-limits', 'partial', 'partial-horizon', 'moon-up', 'greatest'];
  for (const name of prefer) {
    const spec = specs.find((s) => s.id === `${OVERLAY_PREFIX}${name}` && s.data.features.length > 0);
    if (spec) return spec.id;
  }
  return null;
}

/** Which eclipse (its id) this view has on the map, if any. */
export function eclipseOnMap(map: MapService): string | null {
  for (const entry of map.overlays()) {
    if (!entry.id.startsWith(OVERLAY_PREFIX)) continue;
    const id = entry.data.features[0]?.properties?.['eclipse'];
    if (typeof id === 'string') return id;
  }
  return null;
}

/** Take this view's eclipse off the map. */
export function clearEclipse(map: MapService): void {
  for (const entry of [...map.overlays()]) if (entry.id.startsWith(OVERLAY_PREFIX)) map.removeOverlay(entry.id);
}

/** Replace whatever eclipse this view had on the map with these overlays; returns the one to fit. */
export function showEclipse(map: MapService, specs: readonly OverlaySpec[]): string | null {
  clearEclipse(map);
  for (const s of specs) if (s.data.features.length) map.addOverlay(s.id, s.data, s.style);
  return fitTarget(specs.filter((s) => s.data.features.length));
}
