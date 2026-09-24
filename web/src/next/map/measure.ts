/**
 * The measuring tool's numbers and lines: great circle and rhumb line between two points.
 * OWNER: map agent. Pure; tested in map-measure.test.ts. Distances and courses come from
 * geo/greatcircle.ts (the reference sphere, 1′ = 1 NM, CONVENTIONS section 1); display only.
 */

import type { Feature, FeatureCollection, Geometry } from 'geojson';
import type { LatLonDeg } from '../engine/types.js';
import {
  greatCircleDistanceNm,
  greatCirclePoints,
  initialCourseDeg,
  rhumbCourseDeg,
  rhumbDistanceNm,
  rhumbPoints,
} from '../geo/greatcircle.js';
import type { Units } from '../state.js';
import { formatBearing, formatDistance, NM_TO_KM, NM_TO_MI } from './format.js';
import { splitLine, wrapLon } from './geometry.js';

export interface Measurement {
  a: LatLonDeg;
  b: LatLonDeg;
  greatCircleNm: number;
  /** Initial true course along the great circle; NaN for coincident or antipodal points. */
  greatCircleCourseDeg: number;
  rhumbNm: number;
  rhumbCourseDeg: number;
}

export function measure(a: LatLonDeg, b: LatLonDeg): Measurement {
  return {
    a,
    b,
    greatCircleNm: greatCircleDistanceNm(a, b),
    greatCircleCourseDeg: initialCourseDeg(a, b),
    rhumbNm: rhumbDistanceNm(a, b),
    rhumbCourseDeg: rhumbCourseDeg(a, b),
  };
}

/** "3 012 NM · 5 578 km" (and statute miles for imperial units). */
export function distanceText(nm: number, units: Units): string {
  const parts = [`${formatDistance(nm)} NM`, `${formatDistance(nm * NM_TO_KM)} km`];
  if (units === 'imperial') parts.push(`${formatDistance(nm * NM_TO_MI)} mi`);
  return parts.join(' · ');
}

export interface MeasureLines {
  greatCircle: string;
  rhumb: string;
}

/** The two read-out lines, in plain words with the navigator's terms. */
export function measureText(m: Measurement, units: Units): MeasureLines {
  return {
    greatCircle: `Shortest route (great circle): ${distanceText(m.greatCircleNm, units)}, starting course ${formatBearing(m.greatCircleCourseDeg, 1)}`,
    rhumb: `Constant course (rhumb line): ${distanceText(m.rhumbNm, units)}, course ${formatBearing(m.rhumbCourseDeg, 1)}`,
  };
}

function point(p: LatLonDeg, label: string): Feature {
  return { type: 'Feature', properties: { kind: 'point', label }, geometry: { type: 'Point', coordinates: [wrapLon(p.lon_deg), p.lat_deg] } };
}

function lines(kind: string, label: string, pieces: number[][][]): Feature[] {
  return pieces.map((coordinates): Feature => ({ type: 'Feature', properties: { kind, label }, geometry: { type: 'LineString', coordinates } as Geometry }));
}

/** Points and both lines for the map's `measure` source. */
export function measureFeatures(a: LatLonDeg | null, b: LatLonDeg | null): FeatureCollection {
  const features: Feature[] = [];
  if (a && b) {
    const m = measure(a, b);
    if (m.greatCircleNm > 1e-6) {
      features.push(...lines('great-circle', 'great circle', splitLine(greatCirclePoints(a, b, { maxStepNm: 30 }))));
      features.push(...lines('rhumb', 'rhumb line', splitLine(rhumbPoints(a, b, { maxStepNm: 30 }))));
    }
  }
  if (a) features.push(point(a, 'A'));
  if (b) features.push(point(b, 'B'));
  return { type: 'FeatureCollection', features };
}
