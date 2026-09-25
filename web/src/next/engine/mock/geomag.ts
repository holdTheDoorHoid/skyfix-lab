/**
 * MOCK magnetic field and compass error — interface development only (EXPLORER_PLAN 3.1).
 * OWNER: geomag agent.
 *
 * Same shapes, ranges, conventions and failure modes as `crates/skyfix-wasm/src/geomag.rs`
 * (EXPLORER_API "Expansion programme — magnetic field and compass error"): WMM2025 from
 * 2025.0 to 2030.0 and IGRF-14 from 1900.0 by name, `available: false` with a reason
 * outside 1900–2030, zones, uncertainty, sentences. The numbers are ILLUSTRATIVE: the field
 * is only the tilted dipole (the three degree-1 coefficients, IGRF-14 1900.0 and WMM2025
 * 2025.0 with its rate, linear in between), so a declination can be several degrees from
 * the real model's; an amplitude is taken at the given time rather than at the crossing.
 */

import { isoUtc } from '../../time.js';
import * as A from './astro.js';
import type {
  AmplitudeHorizon,
  CompassError,
  CompassKind,
  CompassMethod,
  CompassRequest,
  CompassVariation,
  ExplorerEngine,
  MagneticField,
  MagneticGrid,
  MagneticModelChoice,
  MagneticModelName,
  MagneticZone,
  RiseSet,
} from '../types.js';

const REFERENCE_RADIUS_KM = 6371.2;
/** Degree-1 Gauss coefficients (nT): IGRF-14 at 1900.0, WMM2025 at 2025.0 and its rate. */
const G1900 = { g10: -31543, g11: -2298, h11: 5922 };
const G2025 = { g10: -29351.8, g11: -1410.8, h11: 4545.4 };
const SV2025 = { g10: 12.0, g11: 9.7, h11: -21.5 };

function finite(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`);
  return v;
}

/** Decimal year of a jd_utc: `Y + (jd - JD(Y-01-01)) / days in Y` (CONVENTIONS 14.1). */
export function mockDecimalYear(jdUtc: number): number {
  const ms = (jdUtc - 2_440_587.5) * 86_400_000;
  const y = new Date(ms).getUTCFullYear();
  const start = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  return y + (ms - start) / (end - start);
}

function dipole(t: number): { g10: number; g11: number; h11: number } {
  if (t >= 2025) {
    const dt = t - 2025;
    return {
      g10: G2025.g10 + SV2025.g10 * dt,
      g11: G2025.g11 + SV2025.g11 * dt,
      h11: G2025.h11 + SV2025.h11 * dt,
    };
  }
  const f = (t - 1900) / 125;
  return {
    g10: G1900.g10 + (G2025.g10 - G1900.g10) * f,
    g11: G1900.g11 + (G2025.g11 - G1900.g11) * f,
    h11: G1900.h11 + (G2025.h11 - G1900.h11) * f,
  };
}

/** North, east, down (nT) of the tilted dipole; the latitude is treated as geocentric. */
function xyz(latDeg: number, lonDeg: number, heightM: number, t: number): [number, number, number] {
  const c = dipole(t);
  const theta = (90 - latDeg) * A.D2R;
  const lam = lonDeg * A.D2R;
  const st = Math.max(Math.sin(theta), 1e-12);
  const ct = Math.cos(theta);
  const ratio = REFERENCE_RADIUS_KM / (REFERENCE_RADIUS_KM + heightM / 1000);
  const r3 = ratio ** 3;
  const a11 = c.g11 * Math.cos(lam) + c.h11 * Math.sin(lam);
  const x = r3 * (-c.g10 * st + a11 * ct);
  const y = r3 * (c.g11 * Math.sin(lam) - c.h11 * Math.cos(lam));
  const z = -2 * r3 * (c.g10 * ct + a11 * st);
  return [x, y, z];
}

function selectModel(t: number, choice: MagneticModelChoice): MagneticModelName | string {
  const words = t.toFixed(1);
  const before = `No magnetic variation for ${words}: the models start in 1900 (IGRF-14), and the field's earlier changes are not known well enough to show one.`;
  const after = `No magnetic variation for ${words}: WMM2025 and IGRF-14 end in 2030, and the field's later changes cannot be predicted.`;
  if (choice === 'wmm2025') {
    return t >= 2025 && t <= 2030
      ? 'WMM2025'
      : `WMM2025 covers 2025.0 to 2030.0, not ${words}; IGRF-14 covers 1900 to 2030.`;
  }
  if (t < 1900) return before;
  if (t > 2030) return after;
  if (choice === 'igrf14') return 'IGRF-14';
  return t >= 2025 ? 'WMM2025' : 'IGRF-14';
}

function eastWest(deg: number, decimals = 1): string {
  const scale = 10 ** decimals;
  const rounded = Math.round(Math.abs(deg) * scale) / scale;
  if (rounded === 0) return `${(0).toFixed(decimals)}°`;
  return `${rounded.toFixed(decimals)}° ${deg < 0 ? 'W' : 'E'}`;
}

function declinationSigma(h: number): number {
  if (h <= 0) return 180;
  return Math.min(180, Math.hypot(0.26, 5417 / h));
}

function zoneOf(h: number): MagneticZone {
  return h < 2000 ? 'blackout' : h < 6000 ? 'caution' : 'normal';
}

export function mockMagneticField(
  latDeg: number,
  lonDeg: number,
  heightM: number,
  jdUtc: number,
  model: MagneticModelChoice = 'auto',
): MagneticField {
  const lat = finite(latDeg, 'lat_deg');
  const lon0 = finite(lonDeg, 'lon_deg');
  const height = finite(heightM, 'height_m');
  const jd = finite(jdUtc, 'jd_utc');
  if (lat < -90 || lat > 90) throw new Error(`magnetic_field: lat_deg ${lat} is outside [-90, 90]`);
  if (!['auto', 'wmm2025', 'igrf14'].includes(model)) {
    throw new Error(`magnetic_field: unknown magnetic model "${String(model)}"`);
  }
  const t = mockDecimalYear(jd);
  const lon = A.wrap180(lon0);
  const chosen = selectModel(t, model);
  const unavailable = (reason: string): MagneticField => ({
    available: false,
    jd_utc: jd,
    utc: isoUtc(jd),
    decimal_year: t,
    lat_deg: lat,
    lon_deg: lon0,
    height_m: height,
    reason,
  });
  if (chosen !== 'WMM2025' && chosen !== 'IGRF-14') return unavailable(chosen);
  if (height < -1000 || height > 850_000) {
    return unavailable(
      `The magnetic models are specified from 1 km below sea level to 850 km above the ellipsoid; ${height} m is outside that.`,
    );
  }
  const at = (tt: number) => {
    const [x, y, z] = xyz(lat, lon, height, tt);
    const h = Math.hypot(x, y);
    return { x, y, z, h, f: Math.hypot(h, z), d: Math.atan2(y, x) * A.R2D, i: Math.atan2(z, h) * A.R2D };
  };
  const e = at(t);
  const a = at(t - 0.5);
  const b = at(t + 0.5);
  const zone = zoneOf(e.h);
  const sigma = declinationSigma(e.h);
  const notes: string[] = [];
  if (zone === 'blackout') {
    notes.push(
      `Blackout zone: the horizontal field is only ${e.h.toFixed(0)} nT (under 2000 nT), so a magnetic compass is unreliable here and the variation can be wrong by tens of degrees (WMM military specification).`,
    );
  } else if (zone === 'caution') {
    notes.push(
      `Caution zone: the horizontal field is only ${e.h.toFixed(0)} nT (under 6000 nT) near the magnetic pole, so compass accuracy may be degraded.`,
    );
  }
  const changeArcmin = A.wrap180(b.d - a.d) * 60;
  const changeRounded = Math.round(Math.abs(changeArcmin) * 10) / 10;
  const annualText =
    changeRounded === 0 ? 'no change a year' : `${changeRounded.toFixed(1)}′ ${changeArcmin < 0 ? 'W' : 'E'} a year`;
  const variationText = eastWest(e.d);
  return {
    available: true,
    jd_utc: jd,
    utc: isoUtc(jd),
    model: chosen,
    decimal_year: t,
    lat_deg: lat,
    lon_deg: lon,
    height_m: height,
    declination_deg: e.d,
    inclination_deg: e.i,
    horizontal_nt: e.h,
    north_nt: e.x,
    east_nt: e.y,
    down_nt: e.z,
    total_nt: e.f,
    annual_change: {
      declination_deg_per_year: A.wrap180(b.d - a.d),
      inclination_deg_per_year: b.i - a.i,
      horizontal_nt_per_year: b.h - a.h,
      north_nt_per_year: b.x - a.x,
      east_nt_per_year: b.y - a.y,
      down_nt_per_year: b.z - a.z,
      total_nt_per_year: b.f - a.f,
    },
    uncertainty: {
      declination_deg: sigma,
      inclination_deg: 0.2,
      horizontal_nt: 133,
      north_nt: 137,
      east_nt: 89,
      down_nt: 141,
      total_nt: 138,
      basis: 'MOCK: the WMM2025 error model applied to a tilted dipole (illustrative)',
    },
    zone,
    forecast: t > 2025,
    notes,
    variation_text: variationText,
    annual_change_text: annualText,
    sentence: `Variation ${variationText} ±${sigma.toFixed(1)}° (${chosen}), ${
      annualText === 'no change a year' ? 'with no measurable annual change' : `changing ${annualText}`
    }.`,
  };
}

export function mockMagneticGrid(
  jdUtc: number,
  latMin: number,
  latMax: number,
  nLat: number,
  lonMin: number,
  lonMax: number,
  nLon: number,
  heightM = 0,
): MagneticGrid | null {
  for (const [name, v] of [
    ['jd_utc', jdUtc],
    ['lat_min', latMin],
    ['lat_max', latMax],
    ['lon_min', lonMin],
    ['lon_max', lonMax],
    ['height_m', heightM],
  ] as const) {
    finite(v, `magnetic_grid: ${name}`);
  }
  if (latMin < -90 || latMax > 90 || latMax < latMin) throw new Error('magnetic_grid: need -90 <= lat_min <= lat_max <= 90');
  if (lonMax < lonMin) throw new Error('magnetic_grid: lon_max must not be below lon_min');
  if (!Number.isInteger(nLat) || !Number.isInteger(nLon) || nLat < 1 || nLon < 1 || nLat * nLon > 70_000) {
    throw new Error('magnetic_grid: n_lat and n_lon must be at least 1 and their product at most 70000');
  }
  const step = (min: number, max: number, n: number, i: number) => (n === 1 ? min : min + ((max - min) * i) / (n - 1));
  const lat = Float64Array.from({ length: nLat }, (_, i) => step(latMin, latMax, nLat, i));
  const lon = Float64Array.from({ length: nLon }, (_, i) => step(lonMin, lonMax, nLon, i));
  const first = mockMagneticField(lat[0]!, lon[0]!, heightM, jdUtc);
  if (!first.available) return null;
  const dec = new Float64Array(nLat * nLon);
  const h = new Float64Array(nLat * nLon);
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const f = mockMagneticField(lat[i]!, lon[j]!, heightM, jdUtc);
      if (!f.available) return null;
      dec[i * nLon + j] = f.declination_deg;
      h[i * nLon + j] = f.horizontal_nt;
    }
  }
  return { model: first.model, decimal_year: first.decimal_year, lat_deg: lat, lon_deg: lon, declination_deg: dec, horizontal_nt: h };
}

function jdOfRequest(r: CompassRequest): number {
  if (r.utc !== undefined && r.jd_utc !== undefined) throw new Error('compass_error: utc: give utc or jd_utc, not both');
  if (r.jd_utc !== undefined) return finite(r.jd_utc, 'compass_error: jd_utc');
  if (typeof r.utc !== 'string') throw new Error('compass_error: utc: the time of the bearing is required');
  const ms = Date.parse(r.utc);
  if (!r.utc.trim().endsWith('Z') || !Number.isFinite(ms)) throw new Error(`compass_error: invalid timestamp ${r.utc}`);
  return ms / 86_400_000 + 2_440_587.5;
}

export function mockCompassError(engine: ExplorerEngine, r: CompassRequest): CompassError {
  if (!r || typeof r !== 'object' || typeof r.body !== 'string' || !r.body.trim()) {
    throw new Error('compass_error: body: name the body whose bearing was taken');
  }
  const method: CompassMethod = r.method ?? 'azimuth';
  const compass: CompassKind = r.compass ?? 'magnetic';
  const horizon: AmplitudeHorizon = r.horizon ?? 'visible';
  const obs = r.observer;
  const lat = finite(obs?.lat_deg, 'compass_error: observer.lat_deg');
  const lon = finite(obs?.lon_deg, 'compass_error: observer.lon_deg');
  const height = obs?.height_m === undefined ? 0 : finite(obs.height_m, 'compass_error: observer.height_m');
  if (lat < -90 || lat > 90) throw new Error('compass_error: observer.lat_deg must be within [-90, 90]');
  const bearing = finite(r.compass_bearing_deg, 'compass_error: compass_bearing_deg');
  if (bearing < 0 || bearing >= 360) throw new Error('compass_error: compass_bearing_deg: a compass bearing is within [0, 360)');
  const hoe = r.height_of_eye_m ?? 0;
  if (!(hoe >= 0)) throw new Error('compass_error: height_of_eye_m must be 0 or more');
  for (const k of ['variation_sigma_deg', 'bearing_sigma_deg'] as const) {
    const v = r[k];
    if (v !== undefined && v !== null && !(finite(v, `compass_error: ${k}`) > 0)) {
      throw new Error(`compass_error: ${k}: a standard deviation is greater than 0`);
    }
  }
  const jd = jdOfRequest(r);
  const observer = { lat_deg: lat, lon_deg: lon, height_m: height };
  const sky = engine.skyState(observer, jd, [r.body]);
  const state = sky.bodies[0];
  if (!state) throw new Error(`compass_error: ${sky.errors[0]?.message ?? `no direction for ${r.body}`}`);
  const notes: string[] = [];
  let trueBearing: number;
  let azimuth: CompassError['azimuth'] = null;
  let amplitude: CompassError['amplitude'] = null;
  if (method === 'azimuth') {
    const dt = 30 / 86_400;
    const before = engine.skyState(observer, jd - dt, [r.body]).bodies[0];
    const after = engine.skyState(observer, jd + dt, [r.body]).bodies[0];
    const rate = before && after ? A.wrap180(after.az_deg - before.az_deg) : 0;
    trueBearing = state.az_deg;
    azimuth = {
      gha_deg: state.gha_deg,
      dec_deg: state.dec_deg,
      altitude_deg: state.alt_deg,
      zn_spherical_deg: state.zn_deg,
      azimuth_rate_deg_per_min: rate,
    };
    if (state.alt_deg < -1) {
      notes.push(`The ${state.body} was ${(-state.alt_deg).toFixed(1)}° below the horizon at that time: check the time, the date and the body.`);
    }
  } else {
    const lha = A.norm360(state.gha_deg + lon);
    const event: RiseSet = r.event ?? (lha > 0 && lha < 180 ? 'setting' : 'rising');
    const dip = hoe > 0 ? 1.76 * Math.sqrt(hoe) : 0;
    const refraction = horizon === 'visible' ? A.refractionArcmin(-dip / 60) : 0;
    const limb = r.limb ?? 'center';
    const sd = horizon === 'visible' && limb !== 'center' ? state.semidiameter_arcmin : 0;
    const hTopo = horizon === 'visible' ? (-dip - refraction + (limb === 'lower' ? sd : -sd)) / 60 : 0;
    const parallax = horizon === 'visible' ? state.horizontal_parallax_arcmin * Math.cos(hTopo * A.D2R) : 0;
    const h = horizon === 'visible' ? hTopo + parallax / 60 : 0;
    const bearingAt = (hDeg: number): number | null => {
      const c =
        (Math.sin(state.dec_deg * A.D2R) - Math.sin(lat * A.D2R) * Math.sin(hDeg * A.D2R)) /
        (Math.cos(lat * A.D2R) * Math.cos(hDeg * A.D2R));
      if (!Number.isFinite(c) || Math.abs(c) > 1) return null;
      const z = Math.acos(c) * A.R2D;
      return event === 'rising' ? z : A.norm360(360 - z);
    };
    const b = bearingAt(h);
    if (b === null) throw new Error(`compass_error: The ${state.body} does not ${event === 'rising' ? 'rise' : 'set'} here: no amplitude.`);
    const s = Math.sin(state.dec_deg * A.D2R) / Math.cos(lat * A.D2R);
    const amp = Math.abs(s) <= 1 ? Math.asin(s) * A.R2D : null;
    const celestial = amp === null ? null : event === 'rising' ? A.norm360(90 - amp) : A.norm360(270 + amp);
    trueBearing = b;
    amplitude = {
      event,
      horizon,
      dec_deg: state.dec_deg,
      amplitude_deg: amp,
      amplitude_text:
        amp === null ? null : `${event === 'rising' ? 'E' : 'W'} ${Math.abs(amp).toFixed(1)}° ${amp < 0 ? 'S' : 'N'}`,
      celestial_bearing_deg: celestial,
      altitude_deg: h,
      visible_horizon_correction_deg: horizon === 'visible' && celestial !== null ? A.wrap180(b - celestial) : 0,
      dip_arcmin: dip,
      refraction_arcmin: refraction,
      semidiameter_arcmin: sd,
      parallax_arcmin: parallax,
      bearing_per_altitude: 1,
      minutes_from_given_time: 0,
    };
  }
  const ce = A.wrap180(trueBearing - bearing);
  let variation: CompassVariation | null = null;
  if (compass === 'magnetic') {
    if (r.variation_deg !== undefined && r.variation_deg !== null) {
      const v = finite(r.variation_deg, 'compass_error: variation_deg');
      variation = { deg: v, sigma_deg: r.variation_sigma_deg ?? null, source: 'given', text: eastWest(v), notes: [] };
    } else {
      const f = mockMagneticField(lat, lon, height, jd, r.magnetic_model ?? 'auto');
      if (f.available) {
        variation = {
          deg: f.declination_deg,
          sigma_deg: f.uncertainty.declination_deg,
          source: f.model,
          text: f.variation_text,
          notes: f.notes,
        };
      } else {
        notes.push(`No variation from the magnetic model: ${f.reason}`);
      }
    }
    if (!variation) {
      notes.push('Give the variation (from the chart\'s compass rose) to split the compass error into variation and deviation.');
    } else {
      notes.push(...variation.notes);
    }
  }
  const deviation = variation ? A.wrap180(ce - variation.deg) : null;
  const bs = r.bearing_sigma_deg ?? null;
  const deviationSigma =
    variation === null ? null : variation.sigma_deg !== null && bs !== null ? Math.hypot(variation.sigma_deg, bs) : (variation.sigma_deg ?? bs);
  const ceText = eastWest(ce);
  const sentence =
    compass === 'gyro'
      ? `Gyro error ${ceText}.`
      : variation && deviation !== null
        ? `Compass error ${ceText}; variation ${variation.text}; deviation ${eastWest(deviation)}.`
        : `Compass error ${ceText}.`;
  const clock = isoUtc(jd).slice(11, 19);
  const word = compass === 'gyro' ? 'gyrocompass' : 'compass';
  const explanation =
    method === 'azimuth'
      ? `The ${state.body} bore ${trueBearing.toFixed(1)}° true at ${clock} UTC, ${state.alt_deg.toFixed(1)}° high; the ${word} read ${bearing.toFixed(1)}°.`
      : `The ${state.body} ${amplitude!.event === 'rising' ? 'rose' : 'set'} bearing ${trueBearing.toFixed(1)}° true at ${clock} UTC; the ${word} read ${bearing.toFixed(1)}°.`;
  return {
    method,
    body: state.body,
    compass,
    jd_utc: jd,
    utc: isoUtc(jd),
    true_bearing_deg: A.norm360(trueBearing),
    compass_bearing_deg: bearing,
    compass_error_deg: ce,
    compass_error_text: ceText,
    compass_error_sigma_deg: bs,
    variation,
    deviation_deg: deviation,
    deviation_sigma_deg: deviationSigma,
    deviation_text: deviation === null ? null : eastWest(deviation),
    sentence,
    explanation,
    azimuth,
    amplitude,
    direction_source: 'MOCK: low-precision positions (illustrative)',
    notes,
  };
}
