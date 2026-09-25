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

// ---------------------------------------------------------------------------------------
// Actions on a measurement. Appended by the navigate2 agent (expansion programme): another
// view registers an action for the page (Navigate: "Add as a leg of the passage"), and the
// measuring readout shows one button per action once both points are set (map-view.ts,
// `syncMeasure`). Keyed by the page's store, like the map service.

export interface MeasureAction {
  /** Unique per page; registering the same id again replaces the action. */
  id: string;
  /** The button's words ("Add as a leg of the passage"). */
  label: string;
  /** A sentence for the tooltip. */
  tip?: string;
  /** Called with the measurement's two points, A then B. */
  run(a: LatLonDeg, b: LatLonDeg): void;
}

const measureActionRegistry = new WeakMap<object, Map<string, MeasureAction>>();

/** Offer an action on the page's measurements; returns the function that withdraws it. */
export function registerMeasureAction(owner: object, action: MeasureAction): () => void {
  let actions = measureActionRegistry.get(owner);
  if (!actions) {
    actions = new Map();
    measureActionRegistry.set(owner, actions);
  }
  actions.set(action.id, action);
  return () => {
    if (measureActionRegistry.get(owner)?.get(action.id) === action) measureActionRegistry.get(owner)!.delete(action.id);
  };
}

/** The actions offered on the page's measurements, in the order they were registered. */
export function measureActions(owner: object): MeasureAction[] {
  return [...(measureActionRegistry.get(owner)?.values() ?? [])];
}
