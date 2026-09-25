/**
 * The magnetic field and compass error of the real engine: `GeomagEngine` over
 * `crates/skyfix-wasm/src/geomag.rs` (wire format: docs/EXPLORER_API.md, "Expansion
 * programme — magnetic field and compass error"; CONVENTIONS 14.1-14.2). OWNER: geomag agent.
 *
 * Like `wasm.ts`, this only serialises inputs to what the exports take and passes the
 * results through; typed arrays arrive as real typed arrays. `WasmEngine` delegates its
 * three `GeomagEngine` methods here. A package built before these exports throws an error
 * that names the export and says to rebuild, as the other optional exports do.
 */

import type {
  CompassError,
  CompassRequest,
  MagneticField,
  MagneticGrid,
  MagneticModelChoice,
} from './types.js';

/** The exports the magnetic tools call (all optional in older builds). */
export const GEOMAG_EXPORTS = ['magnetic_field', 'magnetic_grid', 'compass_error'] as const;

/** The wasm-bindgen functions (EXPLORER_API signatures). */
export interface GeomagWasmExports {
  magnetic_field(latDeg: number, lonDeg: number, heightM: number, jdUtc: number, model?: string): unknown;
  magnetic_grid(
    jdUtc: number,
    latMin: number,
    latMax: number,
    nLat: number,
    lonMin: number,
    lonMax: number,
    nLon: number,
    heightM: number,
  ): unknown;
  compass_error(requestJson: string): unknown;
}

function errorText(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function exported<K extends keyof GeomagWasmExports>(
  x: Partial<GeomagWasmExports>,
  name: K,
): GeomagWasmExports[K] {
  const fn = x[name];
  if (typeof fn !== 'function') {
    throw new Error(
      `${name}: this build of the numerical core has no magnetic field or compass error. ` +
        'Rebuild it with: npm run wasm --prefix web',
    );
  }
  return fn.bind(x) as GeomagWasmExports[K];
}

function call<T>(name: string, fn: () => unknown): T {
  try {
    return fn() as T;
  } catch (error) {
    throw new Error(`${name}: ${errorText(error)}`);
  }
}

/** The contract fields of a request only, so a UI object with extra fields serialises cleanly. */
export function compassRequestJson(r: CompassRequest): string {
  const keys: (keyof CompassRequest)[] = [
    'method',
    'body',
    'utc',
    'jd_utc',
    'compass_bearing_deg',
    'compass',
    'variation_deg',
    'variation_sigma_deg',
    'bearing_sigma_deg',
    'magnetic_model',
    'horizon',
    'height_of_eye_m',
    'limb',
    'event',
    'pressure_hpa',
    'temperature_c',
  ];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k];
  const o = r.observer;
  out.observer =
    o.height_m === undefined
      ? { lat_deg: o.lat_deg, lon_deg: o.lon_deg }
      : { lat_deg: o.lat_deg, lon_deg: o.lon_deg, height_m: o.height_m };
  return JSON.stringify(out);
}

export function wasmMagneticField(
  x: Partial<GeomagWasmExports>,
  latDeg: number,
  lonDeg: number,
  heightM: number,
  jdUtc: number,
  model?: MagneticModelChoice,
): MagneticField {
  const fn = exported(x, 'magnetic_field');
  return call('magnetic_field', () =>
    model === undefined ? fn(latDeg, lonDeg, heightM, jdUtc) : fn(latDeg, lonDeg, heightM, jdUtc, model),
  );
}

export function wasmMagneticGrid(
  x: Partial<GeomagWasmExports>,
  jdUtc: number,
  latMin: number,
  latMax: number,
  nLat: number,
  lonMin: number,
  lonMax: number,
  nLon: number,
  heightM = 0,
): MagneticGrid | null {
  const fn = exported(x, 'magnetic_grid');
  return call('magnetic_grid', () => fn(jdUtc, latMin, latMax, nLat, lonMin, lonMax, nLon, heightM));
}

export function wasmCompassError(x: Partial<GeomagWasmExports>, request: CompassRequest): CompassError {
  const fn = exported(x, 'compass_error');
  return call('compass_error', () => fn(compassRequestJson(request)));
}
