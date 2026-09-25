/**
 * The Compass tab's requests for the engine (`compass_error`, `magnetic_field`): where, when
 * and what, from the tab's form, the session and the explorer. Pure; tested in
 * navigate-compass.test.ts. OWNER: navigate2 agent (expansion programme).
 *
 * Where: the session's assumed position (the DR) when it has one, else the map's place,
 * with the site's height (0 at sea). When: the time typed in the form, else the time bar's.
 * The session's height of eye, pressure and temperature go with an amplitude on the
 * visible horizon (dip and refraction at the moment of rising or setting).
 */

import type { LatLon } from '../../../types.js';
import type { CompassRequest } from '../../engine/types.js';
import type { ExplorerState } from '../../state.js';
import { isoUtc } from '../../time.js';
import type { CompassForm, Working } from '../model.js';

export interface CompassPlace extends LatLon {
  /** Above the WGS84 ellipsoid, metres (the magnetic model's height; 0 at sea). */
  height_m: number;
  /** Where it came from, in words. */
  label: string;
  source: 'dr' | 'place';
}

export function compassPlace(w: Working, explorer: ExplorerState): CompassPlace {
  const ap = w.session.observer.assumed_position;
  if (ap) return { lat_deg: ap.lat_deg, lon_deg: ap.lon_deg, height_m: 0, label: 'the DR (the session’s assumed position)', source: 'dr' };
  const o = explorer.observer;
  return { lat_deg: o.lat_deg, lon_deg: o.lon_deg, height_m: o.height_m, label: o.label || 'the place on the map', source: 'place' };
}

/** The instant the tab works at: the form's time, else the time bar's (RFC 3339 UTC). */
export function compassUtc(form: CompassForm, explorer: ExplorerState): { utc: string; fromForm: boolean } {
  return form.utc ? { utc: form.utc, fromForm: true } : { utc: isoUtc(explorer.time.jd_utc).replace(/\.\d+Z$/, 'Z'), fromForm: false };
}

/** The request, or the sentence that says what is still missing. */
export function compassRequest(w: Working, explorer: ExplorerState, bearingDeg: number | null = w.compass.bearingDeg): { request: CompassRequest } | { missing: string } {
  const form = w.compass;
  if (bearingDeg === null) return { missing: 'Type what the compass read for the body.' };
  if (!form.body.trim()) return { missing: 'Choose the body you took the bearing of.' };
  const place = compassPlace(w, explorer);
  const request: CompassRequest = {
    method: form.method,
    body: form.body,
    utc: compassUtc(form, explorer).utc,
    observer: { lat_deg: place.lat_deg, lon_deg: place.lon_deg, height_m: place.height_m },
    compass_bearing_deg: bearingDeg,
    compass: form.compass,
  };
  if (form.compass === 'magnetic' && form.variationDeg !== null) request.variation_deg = form.variationDeg;
  if (form.bearingSigmaDeg !== null) request.bearing_sigma_deg = form.bearingSigmaDeg;
  if (form.method === 'amplitude') {
    request.horizon = form.horizon;
    request.event = form.event;
    if (form.horizon === 'visible') {
      request.height_of_eye_m = w.session.observer.height_of_eye_m;
      request.limb = form.limb;
      request.pressure_hpa = w.session.observer.pressure_hpa;
      request.temperature_c = w.session.observer.temperature_c;
    }
  }
  return { request };
}
