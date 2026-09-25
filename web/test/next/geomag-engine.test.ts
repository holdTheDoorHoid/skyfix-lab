/**
 * Magnetic field and compass error in the engines (expansion programme, geomag agent):
 * how the WASM wrapper serialises and names errors, the mock's contract shapes and
 * failure modes, the guard, the memoised engine's forwarding, and — when a package has
 * been built with `npm run wasm` — the real exports against the numbers
 * docs/EXPLORER_API.md quotes.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import {
  isGeomagEngine,
  type CompassRequest,
  type ExplorerEngine,
  type GeomagEngine,
  type MagneticFieldValue,
} from '../../src/next/engine/types.js';
import {
  inspectWasmModule,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
} from '../../src/next/engine/wasm.js';
import { compassRequestJson, GEOMAG_EXPORTS } from '../../src/next/engine/wasm-geomag.js';
import { jdFromIso } from '../../src/next/time.js';

const jd = (iso: string): number => jdFromIso(iso)!;
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 };
const REQUEST: CompassRequest = {
  method: 'azimuth',
  body: 'Sun',
  utc: '2026-09-24T21:40:00Z',
  observer: PHILLY,
  compass_bearing_deg: 272.0,
  compass: 'magnetic',
};

type Calls = Record<string, unknown[][]>;

function fakeModule(withGeomag: boolean) {
  const calls: Calls = {};
  const module: Record<string, unknown> = { version: () => '9.9.9' };
  const names = [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS, ...(withGeomag ? GEOMAG_EXPORTS : [])];
  for (const name of names) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      if (name === 'compass_error' && String(args[0]).includes('Vulcan')) throw 'compass_error: unknown body "Vulcan"';
      return { from: name };
    };
  }
  return { module, calls };
}

describe('the WASM wrapper', () => {
  it('is a GeomagEngine to the type checker and to the guard', () => {
    const { module } = fakeModule(true);
    const engine: GeomagEngine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(isGeomagEngine(engine)).toBe(true);
    expect(isGeomagEngine({})).toBe(false);
    expect(isGeomagEngine(null)).toBe(false);
  });

  it('calls each export with the documented argument order', () => {
    const { module, calls } = fakeModule(true);
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    const t = jd('2026-09-24T12:00:00Z');
    expect(engine.magneticField(40, -75, 12, t)).toEqual({ from: 'magnetic_field' });
    expect(calls.magnetic_field![0]).toEqual([40, -75, 12, t]);
    engine.magneticField(40, -75, 12, t, 'igrf14');
    expect(calls.magnetic_field![1]).toEqual([40, -75, 12, t, 'igrf14']);
    engine.magneticGrid(t, -60, 60, 5, -180, 180, 7);
    expect(calls.magnetic_grid![0]).toEqual([t, -60, 60, 5, -180, 180, 7, 0]);
    engine.compassError({ ...REQUEST, observer: { ...PHILLY, label: 'home' } as CompassRequest['observer'] });
    expect(JSON.parse(String(calls.compass_error![0]![0]))).toEqual({
      method: 'azimuth',
      body: 'Sun',
      utc: '2026-09-24T21:40:00Z',
      compass_bearing_deg: 272,
      compass: 'magnetic',
      observer: { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 },
    });
  });

  it('sends only the contract fields, and keeps an explicit null variation', () => {
    const json = JSON.parse(
      compassRequestJson({
        ...REQUEST,
        variation_deg: null,
        extra: 1,
        observer: { lat_deg: 1, lon_deg: 2 },
      } as CompassRequest & { extra: number }),
    );
    expect(json).not.toHaveProperty('extra');
    expect(json.variation_deg).toBeNull();
    expect(json.observer).toEqual({ lat_deg: 1, lon_deg: 2 });
  });

  it('turns a thrown Rust string into an Error naming the export', () => {
    const { module } = fakeModule(true);
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(() => engine.compassError({ ...REQUEST, body: 'Vulcan' })).toThrow(/^compass_error: .*Vulcan/);
  });

  it('says to rebuild the core when a package predates the exports', () => {
    const { module } = fakeModule(false);
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(() => engine.magneticField(0, 0, 0, 2461308)).toThrow(/magnetic_field: .*Rebuild it/);
    expect(() => engine.magneticGrid(2461308, 0, 1, 2, 0, 1, 2)).toThrow(/magnetic_grid: .*Rebuild it/);
    expect(() => engine.compassError(REQUEST)).toThrow(/compass_error: .*Rebuild it/);
  });
});

describe('the mock (illustrative numbers, real shapes)', () => {
  const engine = new MockEngine({ syntheticStars: 0 });

  it('answers 2025-2030 with WMM2025, earlier with IGRF-14, and outside 1900-2030 with a reason', () => {
    const now = engine.magneticField(39.9526, -75.1652, 0, jd('2026-09-24T12:00:00Z'));
    expect(now.available).toBe(true);
    const f = now as MagneticFieldValue;
    expect(f.model).toBe('WMM2025');
    // A dipole alone: Philadelphia is near the dipole's meridian, so its (illustrative)
    // variation is small; the real model's is 11.8° W.
    expect(Math.abs(f.declination_deg)).toBeLessThan(5);
    expect(f.variation_text).toMatch(/^(\d+\.\d° [EW]|0\.0°)$/);
    expect(f.sentence).toMatch(/^Variation (\d+\.\d° [EW]|0\.0°) ±\d\.\d° \(WMM2025\), /);
    expect(f.zone).toBe('normal');
    expect(f.forecast).toBe(true);
    const old = engine.magneticField(39.9526, -75.1652, 0, jd('1950-06-01T00:00:00Z'));
    expect(old.available && old.model).toBe('IGRF-14');
    for (const iso of ['1850-01-01T00:00:00Z', '2045-01-01T00:00:00Z']) {
      const r = engine.magneticField(40, -75, 0, jd(iso));
      expect(r.available).toBe(false);
      if (!r.available) expect(r.reason).toMatch(/^No magnetic variation for /);
    }
    const wmm2020 = engine.magneticField(40, -75, 0, jd('2020-01-01T00:00:00Z'), 'wmm2025');
    expect(wmm2020.available).toBe(false);
    expect(() => engine.magneticField(95, 0, 0, jd('2026-01-01T00:00:00Z'))).toThrow(/lat_deg/);
  });

  it('reports the blackout zone where the horizontal field vanishes', () => {
    // The mock's dipole axis crosses the surface near 80.6 N 72.7 W in 2025.
    const f = engine.magneticField(80.6, -72.7, 0, jd('2025-01-01T00:00:00Z'));
    expect(f.available && f.zone).toBe('blackout');
    if (f.available) expect(f.uncertainty.declination_deg).toBeGreaterThan(2.7);
  });

  it('makes a grid in the documented layout', () => {
    const g = engine.magneticGrid(jd('2026-01-01T00:00:00Z'), -60, 60, 5, -180, 180, 7)!;
    expect(g.lat_deg).toBeInstanceOf(Float64Array);
    expect(g.declination_deg.length).toBe(35);
    const one = engine.magneticField(g.lat_deg[2]!, g.lon_deg[3]!, 0, jd('2026-01-01T00:00:00Z')) as MagneticFieldValue;
    expect(g.declination_deg[2 * 7 + 3]).toBeCloseTo(one.declination_deg, 12);
    expect(engine.magneticGrid(jd('2040-01-01T00:00:00Z'), 0, 1, 2, 0, 1, 2)).toBeNull();
    expect(() => engine.magneticGrid(jd('2026-01-01T00:00:00Z'), 10, 0, 2, 0, 1, 2)).toThrow(/lat_min/);
  });

  it('finds a compass error and splits it the navigator\'s way', () => {
    const r = engine.compassError(REQUEST);
    expect(r.body).toBe('Sun');
    expect(r.compass_error_deg).toBeCloseTo(((r.true_bearing_deg - 272 + 540) % 360) - 180, 9);
    expect(r.variation?.source).toBe('WMM2025');
    expect(r.deviation_deg).toBeCloseTo(r.compass_error_deg - r.variation!.deg, 9);
    expect(r.sentence).toMatch(/^Compass error \d+\.\d°( [EW])?; variation \d+\.\d°( [EW])?; deviation \d+\.\d°( [EW])?\.$/);
    expect(r.azimuth?.zn_spherical_deg).toBeTypeOf('number');
    expect(r.amplitude).toBeNull();
    const given = engine.compassError({ ...REQUEST, variation_deg: -12.5 });
    expect(given.variation?.source).toBe('given');
    expect(given.variation?.text).toBe('12.5° W');
    const gyro = engine.compassError({ ...REQUEST, compass: 'gyro' });
    expect(gyro.variation).toBeNull();
    expect(gyro.sentence).toMatch(/^Gyro error /);
  });

  it('takes an amplitude at sunset and names it Bowditch\'s way', () => {
    const r = engine.compassError({
      ...REQUEST,
      method: 'amplitude',
      utc: '2026-09-24T22:52:00Z',
      height_of_eye_m: 2.5,
      limb: 'lower',
    });
    expect(r.amplitude?.event).toBe('setting');
    expect(r.amplitude?.amplitude_text).toMatch(/^W \d+\.\d° [NS]$/);
    expect(r.amplitude!.altitude_deg).toBeLessThan(0);
  });

  it('refuses malformed requests with the field named', () => {
    expect(() => engine.compassError({ ...REQUEST, compass_bearing_deg: 360 })).toThrow(/compass_bearing_deg/);
    expect(() => engine.compassError({ ...REQUEST, observer: { lat_deg: 91, lon_deg: 0 } })).toThrow(/lat_deg/);
    expect(() => engine.compassError({ ...REQUEST, utc: undefined })).toThrow(/utc/);
    expect(() => engine.compassError({ ...REQUEST, bearing_sigma_deg: 0 })).toThrow(/bearing_sigma_deg/);
    expect(() => engine.compassError({ ...REQUEST, body: 'Vulcan' })).toThrow();
  });
});

describe('the memoised engine', () => {
  it('forwards the magnetic tools exactly when the engine has them', () => {
    const mock = new MockEngine({ syntheticStars: 0 });
    const memo = memoEngine(mock);
    expect(isGeomagEngine(memo)).toBe(true);
    if (isGeomagEngine(memo)) {
      const f = memo.magneticField(40, -75, 0, jd('2026-01-01T00:00:00Z'));
      expect(f.available).toBe(true);
    }
    const plain = memoEngine({ kind: 'mock', description: 'no magnetic tools' } as unknown as ExplorerEngine);
    expect(isGeomagEngine(plain)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package: magnetic tools', () => {
  let glue: Record<string, unknown>;

  beforeAll(async () => {
    glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as Record<string, unknown>;
    (glue.initSync as (input: { module: BufferSource }) => unknown)({ module: readFileSync(WASM_FILE) });
    (glue.init as (() => void) | undefined)?.();
  });

  it('gives the numbers EXPLORER_API.md quotes (needs a geomag build)', ({ skip }) => {
    if (typeof glue.magnetic_field !== 'function') {
      skip();
      return;
    }
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const engine = load.engine;
    const f = engine.magneticField(39.9526, -75.1652, 12, jd('2026-09-24T12:00:00Z'));
    expect(f.available).toBe(true);
    if (f.available) {
      expect(f.model).toBe('WMM2025');
      expect(f.declination_deg).toBeCloseTo(-11.8053, 3);
      expect(f.sentence).toBe('Variation 11.8° W ±0.4° (WMM2025), changing 1.6′ E a year.');
    }
    const none = engine.magneticField(39.9526, -75.1652, 12, jd('1850-01-01T00:00:00Z'));
    expect(none.available).toBe(false);
    const r = engine.compassError(REQUEST);
    expect(r.sentence).toBe('Compass error 14.4° W; variation 11.8° W; deviation 2.6° W.');
    const g = engine.magneticGrid(jd('2026-01-01T00:00:00Z'), -90, 90, 19, -180, 180, 37)!;
    expect(g.declination_deg).toBeInstanceOf(Float64Array);
    expect(g.declination_deg.length).toBe(19 * 37);
  });
});
