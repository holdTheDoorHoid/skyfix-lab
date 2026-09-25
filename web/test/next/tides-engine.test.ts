/**
 * Tides (tides agent): the mock's synthetic station, the WASM wrapper's serialisation
 * and errors, the memoised engine's forwarding, and — when a package has been built with
 * `npm run wasm` — the real core with the shipped tides-us pack.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import { MOCK_TIDE_STATION } from '../../src/next/engine/mock/tides.js';
import {
  isTidePackNotLoaded,
  isTidesEngine,
  TIDE_LABEL,
  type TideExtremes,
  type TidesEngine,
} from '../../src/next/engine/types.js';
import { inspectWasmModule, WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';

// Compile-time: the WASM engine and the mock satisfy the contract.
type Satisfies<T extends TidesEngine> = T;
export type WasmIsTides = Satisfies<WasmEngine>;
export type MockIsTides = Satisfies<MockEngine>;

const JD = 2461307.5; // 2026-09-24T00:00Z

describe('the mock tides engine', () => {
  const mock = new MockEngine();

  it('is a tides engine with one synthetic station, labelled as such', () => {
    expect(isTidesEngine(mock)).toBe(true);
    const near = mock.tideStationsNear(39.95, -75.17, 5);
    expect(near).toHaveLength(1);
    expect(near[0]!.id).toBe(MOCK_TIDE_STATION.id);
    expect(near[0]!.distance_nm).toBeCloseTo(near[0]!.distance_km / 1.852, 9);
    expect(near[0]!.notes.join(' ')).toMatch(/illustrative/);
    expect(mock.tidePackInfo()?.name).toBe('tides-us');
  });

  it('gives high and low water that bound its own curve', () => {
    const ex: TideExtremes = mock.tideExtremes('MOCK001', JD, JD + 2);
    expect(ex.label).toBe(TIDE_LABEL);
    expect(ex.datum).toBe('MLLW');
    expect(ex.extremes.length).toBeGreaterThanOrEqual(6);
    const curve = mock.tidePredict('MOCK001', JD, JD + 2, 1);
    expect(curve.jd_utc).toBeInstanceOf(Float64Array);
    expect(curve.height_m.length).toBe(curve.jd_utc.length);
    for (const e of ex.extremes) {
      const k = Math.round((e.jd_utc - JD) * 1440);
      for (let j = Math.max(0, k - 20); j < Math.min(curve.height_m.length, k + 20); j += 1) {
        if (e.kind === 'high') expect(curve.height_m[j]!).toBeLessThanOrEqual(e.height_m + 1e-6);
        else expect(curve.height_m[j]!).toBeGreaterThanOrEqual(e.height_m - 1e-6);
      }
    }
    const now = mock.tideNow('MOCK001', JD + 0.3);
    expect(now.state === 'rising').toBe(now.rate_m_per_h > 0);
    expect(now.next!.jd_utc).toBeGreaterThan(now.jd_utc);
    expect(now.previous!.jd_utc).toBeLessThanOrEqual(now.jd_utc);
    const msl = mock.tidePredict('MOCK001', JD, JD + 1, 60, 'MSL');
    const mllw = mock.tidePredict('MOCK001', JD, JD + 1, 60, 'MLLW');
    expect(mllw.height_m[0]! - msl.height_m[0]!).toBeCloseTo(0.92, 9);
  });

  it('fails like the real engine, with the same codes', () => {
    expect(() => mock.tideStation('9414290')).toThrow(/^unknown_station:/);
    expect(() => mock.tideExtremes('MOCK001', JD, JD + 401)).toThrow(/^bad_request:/);
    expect(() => mock.tidePredict('MOCK001', JD, JD + 1, 0.1)).toThrow(/^bad_request:/);
    expect(() => mock.tideExtremes('MOCK001', 2415000, JD)).toThrow(/^outside_range:/);
    expect(() => mock.tidePredict('MOCK001', JD, JD + 1, 6, 'CD' as never)).toThrow(/^bad_request:/);
    const unloaded = new MockEngine({ tidesLoaded: false });
    let caught: unknown;
    try {
      unloaded.tideExtremes('MOCK001', JD, JD + 1);
    } catch (e) {
      caught = e;
    }
    expect(isTidePackNotLoaded(caught)).toBe(true);
    expect(unloaded.tidePackInfo()).toBeNull();
    unloaded.loadPack('tides-us', new Uint8Array([1, 2, 3]));
    expect(unloaded.tideExtremes('MOCK001', JD, JD + 1).extremes.length).toBeGreaterThan(0);
  });

  it('is forwarded by the memoised engine, tables cached, the state now not', () => {
    const memo = memoEngine(new MockEngine());
    expect(isTidesEngine(memo)).toBe(true);
    const tides = memo as unknown as TidesEngine;
    const a = tides.tideExtremes('MOCK001', JD, JD + 1);
    expect(tides.tideExtremes('MOCK001', JD, JD + 1)).toBe(a);
    expect(tides.tideExtremes('MOCK001', JD, JD + 1, 'MSL')).not.toBe(a);
    expect(tides.tideNow('MOCK001', JD)).not.toBe(tides.tideNow('MOCK001', JD));
  });
});

describe('the WASM wrapper', () => {
  function engineWith(exports: Partial<Record<keyof ExplorerWasmExports, (...a: unknown[]) => unknown>>) {
    const calls: Record<string, unknown[][]> = {};
    const x: Record<string, unknown> = {};
    for (const [name, fn] of Object.entries(exports)) {
      x[name] = (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return fn!(...args);
      };
    }
    return { engine: new WasmEngine(x as unknown as ExplorerWasmExports), calls };
  }

  it('passes arguments through and defaults the datum to the station default', () => {
    const jd = new Float64Array([JD]);
    const { engine, calls } = engineWith({
      tide_extremes: () => ({ extremes: [] }),
      tide_predict: () => ({ jd_utc: jd }),
      tide_now: () => ({ state: 'rising' }),
      tide_stations_near: () => [],
      tide_station: () => ({ id: '9414290' }),
      tide_pack_info: () => null,
    });
    engine.tideExtremes('9414290', JD, JD + 1);
    engine.tidePredict('9414290', JD, JD + 1, 6, 'MSL');
    engine.tideNow('9414290', JD);
    engine.tideStationsNear(37.8, -122.4, 5);
    engine.tideStation('9414290');
    expect(calls.tide_extremes![0]).toEqual(['9414290', JD, JD + 1, '']);
    expect(calls.tide_predict![0]).toEqual(['9414290', JD, JD + 1, 6, 'MSL']);
    expect(calls.tide_now![0]).toEqual(['9414290', JD, '']);
    expect(calls.tide_stations_near![0]).toEqual([37.8, -122.4, 5]);
    expect(engine.tidePredict('9414290', JD, JD + 1, 6).jd_utc).toBe(jd);
    expect(engine.tidePackInfo()).toBeNull();
  });

  it('names the export in errors, and says to rebuild when it is missing', () => {
    const { engine } = engineWith({
      tide_extremes: () => {
        throw 'pack_not_loaded: tide predictions need the tides-us pack (US stations, NOAA), which is not loaded';
      },
    });
    let caught: unknown;
    try {
      engine.tideExtremes('9414290', JD, JD + 1);
    } catch (e) {
      caught = e;
    }
    expect(String(caught)).toMatch(/tide_extremes: pack_not_loaded/);
    expect(isTidePackNotLoaded(caught)).toBe(true);
    expect(() => engine.tideNow('9414290', JD)).toThrow(/tide_now: this build of the numerical core has no tide predictions/);
    expect(engine.tidePackInfo()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The real package and the shipped pack, when a package has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const PACKS = resolve(import.meta.dirname, '../../public/data/packs');
const packFile = existsSync(PACKS) ? readdirSync(PACKS).find((f) => /^tides-us-[0-9a-f]{16}\.bin$/.test(f)) : undefined;
const glueExports = existsSync(GLUE_FILE) ? readFileSync(GLUE_FILE, 'utf8') : '';
const hasTides =
  existsSync(WASM_FILE) && glueExports.includes('tide_extremes') && glueExports.includes('load_pack') && packFile !== undefined;

describe.skipIf(!hasTides)('the built package with the shipped tides-us pack', () => {
  let engine: WasmEngine;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready') throw new Error('the package lacks the explorer');
    engine = load.engine;
  });

  it('refuses before the pack is installed, then answers in the contract shapes', () => {
    if (engine.tidePackInfo() === null) {
      expect(() => engine.tideExtremes('8443970', JD, JD + 1)).toThrow(/pack_not_loaded/);
    }
    const bytes = new Uint8Array(readFileSync(resolve(PACKS, packFile!)));
    const info = engine.loadPack('tides-us', bytes);
    expect(info.name).toBe('tides-us');
    expect(info.bytes).toBe(bytes.byteLength);
    expect(engine.packs().find((p) => p.name === 'tides-us')?.loaded).toBe(true);
    expect(engine.tidePackInfo()?.stations).toBe(3499);
    const near = engine.tideStationsNear(42.3548, -71.0534, 3);
    expect(near[0]!.id).toBe('8443970');
    const ex = engine.tideExtremes('8443970', JD, JD + 1);
    expect(ex.extremes.length).toBe(4);
    expect(ex.extremes[0]!.utc).toMatch(/Z$/);
    const curve = engine.tidePredict('8443970', JD, JD + 1, 6);
    expect(curve.jd_utc).toBeInstanceOf(Float64Array);
    expect(curve.height_m.length).toBe(241);
    const now = engine.tideNow('8443970', JD + 0.25);
    expect(['rising', 'falling']).toContain(now.state);
    expect(engine.tidePackInfo()?.harmonic).toBe(1256);
  });
});
