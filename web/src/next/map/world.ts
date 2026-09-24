/**
 * The map's live world layers as GeoJSON, from one `sky_state` result: day/night and
 * twilight, the selected body's circle of equal altitude and its altitude rings (the ground
 * points are markers: groundpoints.ts). OWNER: map agent. Pure; tested in map-world.test.ts.
 *
 * Every position is the engine's (EXPLORER_PLAN 3.1): the Sun's ground point `gp` from
 * `sky_state` centres the shading, the circle of equal altitude uses the navigation computed altitude `hc_deg`
 * at the observer, so it passes exactly through the observer on the reference sphere
 * (CONVENTIONS section 3).
 */

import type { FeatureCollection } from 'geojson';
import type { BodyState, LatLonDeg } from '../engine/types.js';
import type { AngleFormat, Layers } from '../state.js';
import { formatAngle } from './format.js';
import { altitudeRingFeatures, emptyCollection, equalAltitudeCircle, stackedAlphas, terminatorLine, twilightFeatures } from './geometry.js';
import { bodyColor, type MapTokens } from './style-tokens.js';

/**
 * Night-side shading. With `twilight`, the four bands of CONVENTIONS 13.4 stacked so each is
 * exactly the theme's darkness; with only `terminator`, one fill over the whole of the
 * not-day side at the nautical-twilight darkness.
 */
export function shadeFeatures(sunGp: LatLonDeg, layers: Pick<Layers, 'terminator' | 'twilight'>, t: MapTokens): FeatureCollection {
  if (layers.twilight) return twilightFeatures(sunGp, stackedAlphas(t.shadeTargets));
  if (layers.terminator) {
    const fc = twilightFeatures(sunGp, [t.shadeTargets[1], 0, 0, 0]);
    return { type: 'FeatureCollection', features: fc.features.slice(0, 1) };
  }
  return emptyCollection();
}

export function terminatorFeatures(sunGp: LatLonDeg): FeatureCollection {
  return { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: terminatorLine(sunGp) }] };
}

/** "Sun 41° 17.3′": the selected body's circle of equal altitude through the observer. */
export function equalAltitudeFeatures(body: BodyState | undefined, t: MapTokens, format: AngleFormat): FeatureCollection {
  if (!body || !Number.isFinite(body.hc_deg)) return emptyCollection();
  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { body: body.body, color: bodyColor(t, body.body, body.kind), label: `${body.body} at ${formatAngle(body.hc_deg, format)}` },
        geometry: equalAltitudeCircle(body.gp, body.hc_deg),
      },
    ],
  };
}

/** Altitude 0°, 10°, … 80° round the selected body's ground point, in its colour. */
export function altitudeRingData(body: BodyState | undefined, t: MapTokens): FeatureCollection {
  if (!body) return emptyCollection();
  const fc = altitudeRingFeatures(body.gp, 10);
  const color = bodyColor(t, body.body, body.kind);
  for (const f of fc.features) f.properties = { ...f.properties, color };
  return fc;
}
