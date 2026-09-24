/**
 * "Show on map": hand a run's circles, fix, ellipse, candidates and answer key to the
 * explorer's map through its overlay service (web/src/next/map/README.md), then switch
 * to the Map view. OWNER: learn agent.
 *
 * The same rules as the Learn chart: an ellipse only when the core emitted one, every
 * candidate alike, no point for an underdetermined result, and the truth labelled as the
 * simulation's answer key. The overlays stay on the map after this view closes (that is
 * the point of sending them); showing another run replaces them, and `clearFromMap`
 * removes them.
 *
 * Imported from `map/overlays.ts` directly, not `map/index.ts`, so the Learn view does not
 * pull MapLibre in: the overlay service needs no map on screen.
 */

import type { FeatureCollection } from 'geojson';
import type { Ctx } from '../component.js';
import { circleOfPositionFeature, ellipseFeature, mapServiceFor, pathFeature, pointFeature } from '../map/overlays.js';
import { NM_M } from '../../types.js';
import { PALETTE_SIZE, sheetFrame, type ChartModel } from './chart-model.js';
import { candidateLetter, metric } from './facts.js';
import { applyOffsetM, distanceM } from './geo.js';

/** Every overlay id this module may create. */
export const OVERLAY_IDS = [
  ...Array.from({ length: PALETTE_SIZE }, (_, i) => `learn-lines-${i}`),
  'learn-ellipse',
  'learn-error',
  'learn-points',
  'learn-truth',
  'learn-frame',
] as const;

/** Palette tokens, in the order learn.css assigns `--sfl-c0` … `--sfl-c5`. */
const PALETTE_TOKENS = ['--body-sun', '--body-neptune', '--body-mars', '--body-uranus', '--body-venus', '--body-moon'];

export function clearFromMap(ctx: Pick<Ctx, 'store'>): void {
  const map = mapServiceFor(ctx);
  for (const id of OVERLAY_IDS) map.removeOverlay(id);
}

export function onMap(ctx: Pick<Ctx, 'store'>): boolean {
  const map = mapServiceFor(ctx);
  return OVERLAY_IDS.some((id) => map.hasOverlay(id));
}

/** The GeoJSON for a model: one collection per overlay id (tests read this). */
export function overlaysFor(model: ChartModel, title: string): Map<string, FeatureCollection> {
  const out = new Map<string, FeatureCollection>();
  for (let color = 0; color < PALETTE_SIZE; color++) {
    const circles = model.circles.filter((c) => c.color === color);
    if (!circles.length) continue;
    out.set(`learn-lines-${color}`, {
      type: 'FeatureCollection',
      features: circles.map((c) => circleOfPositionFeature(c.gp, c.zenithDeg, { label: c.labelled ? c.body : '' })),
    });
  }
  if (model.ellipse) {
    const e = model.ellipse.ellipse;
    out.set('learn-ellipse', {
      type: 'FeatureCollection',
      features: [ellipseFeature(model.ellipse.center, e.semi_major_m / NM_M, e.semi_minor_m / NM_M, e.orientation_deg, { label: '95 % ellipse' })],
    });
  }
  const points = [
    ...(model.fix ? [pointFeature(model.fix, { label: `Fix · ${title}` })] : []),
    ...model.candidates.map((c, i) => pointFeature(c, { label: `Candidate ${candidateLetter(i)}` })),
  ];
  if (points.length) out.set('learn-points', { type: 'FeatureCollection', features: points });
  if (model.truth && model.fix && distanceM(model.truth, model.fix) > 1) {
    out.set('learn-error', {
      type: 'FeatureCollection',
      features: [pathFeature([model.truth, model.fix], { label: metric(distanceM(model.truth, model.fix)) })],
    });
  }
  if (model.truth) {
    out.set('learn-truth', {
      type: 'FeatureCollection',
      features: [pointFeature(model.truth, { label: 'Truth · answer key (simulated)' })],
    });
  }
  // The close-up's own frame (fix, answer key, ellipse, the nearby lines), as four
  // invisible corner points, so the map frames what the Learn chart shows.
  const frame = sheetFrame(model);
  if (frame) {
    const corners: [number, number][] = [
      [frame.maxN, frame.minE],
      [frame.maxN, frame.maxE],
      [frame.minN, frame.minE],
      [frame.minN, frame.maxE],
    ];
    out.set('learn-frame', { type: 'FeatureCollection', features: corners.map(([n, e]) => pointFeature(applyOffsetM(frame.origin, n, e))) });
  }
  return out;
}

/** Replace Learn's overlays with this model's, frame them, and open the Map view. */
export function showOnMap(ctx: Pick<Ctx, 'store'>, model: ChartModel, title: string): void {
  const map = mapServiceFor(ctx);
  clearFromMap(ctx);
  const overlays = overlaysFor(model, title);
  for (const [id, data] of overlays) {
    if (id.startsWith('learn-lines-')) {
      const color = Number(id.slice('learn-lines-'.length));
      map.addOverlay(id, data, { color: PALETTE_TOKENS[color] ?? '--accent', dash: '--dash-circle', labelProperty: 'label', width: 2 });
    } else if (id === 'learn-ellipse') {
      map.addOverlay(id, data, { color: '--accent', fillOpacity: 0.2, z: 1 });
    } else if (id === 'learn-error') {
      map.addOverlay(id, data, { color: '--info', dash: [2, 4], labelProperty: 'label', z: 1 });
    } else if (id === 'learn-points') {
      map.addOverlay(id, data, { color: '--accent', pointRadius: 6, labelProperty: 'label', z: 2 });
    } else if (id === 'learn-frame') {
      // Invisible: only for framing the camera.
      map.addOverlay(id, data, { color: 'rgba(0,0,0,0)', pointRadius: 0, casing: false, fillOpacity: 0 });
    } else {
      map.addOverlay(id, data, { color: '--info', pointRadius: 5, labelProperty: 'label', z: 3 });
    }
  }
  // Frame what matters: the close-up's own frame, the candidates, or the circle itself.
  const frame = overlays.has('learn-frame')
    ? 'learn-frame'
    : model.kind === 'underdetermined' || !overlays.has('learn-points')
      ? [...overlays.keys()][0]
      : 'learn-points';
  if (frame) map.fitOverlay(frame, { padding: 40, maxZoom: model.fix ? 13 : 4 });
  ctx.store.patch({ view: 'map' });
}
