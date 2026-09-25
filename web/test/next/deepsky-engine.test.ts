/**
 * Deep sky (EXPLORER_API.md, "Expansion programme — deep sky"): the WASM wrapper's
 * argument order and serialisation, the mock's shapes, the memoised engine's forwarding,
 * the summary's time tokens, and, when a package has been built (`npm run wasm`), the real
 * exports end to end.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import {
  formatSummaryTimes,
  isDeepSkyEngine,
  type DeepSkyEngine,
  type ExplorerEngine,
} from '../../src/next/engine/types.js';
import {
  conditionsJson,
  inspectWasmModule,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
  type WasmLoad,
} from '../../src/next/engine/wasm.js';

const HERE = { lat_deg: 39.95, lon_deg: -75.17 };
const DEEP = [
  'dso_catalog',
  'dso_list',
  'dso_visibility',
  'meteor_showers',
  'milky_way_outline',
  'sky_search',
  'tonight',
  'extinction_table',
];

function fakeModule(withDeep: boolean) {
  const calls: Record<string, unknown[][]> = {};
  const module: Record<string, unknown> = { version: () => '9.9.9' };
  for (const name of [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS, ...(withDeep ? DEEP : [])]) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return { from: name };
    };
  }
  return { engine: new WasmEngine(module as unknown as ExplorerWasmExports), calls };
}

describe('the WASM wrapper', () => {
  it('calls the deep-sky exports with the documented arguments', () => {
    const { engine, calls } = fakeModule(true);
    expect(isDeepSkyEngine(engine)).toBe(true);
    engine.dsoCatalog();
    engine.dsoCatalog(); // cached
    engine.dsoList(null, 1);
    engine.dsoList({ ...HERE, height_m: 5 }, 2, { kinds: ['galaxy'], above_horizon: true });
    engine.dsoVisibility('M31', HERE, 3, { bortle: 4 });
    engine.meteorShowers(2026);
    engine.meteorShowers(2027, HERE, { nelm: 6.1, k: 0.3 });
    engine.milkyWayOutline();
    engine.skySearch('vega');
    engine.skySearch('vega', HERE, 4, 5);
    engine.tonight(HERE, 5, { bortle: 3, limit: 7 });
    engine.extinction({ k: 0.2 });
    expect(calls.dso_catalog).toHaveLength(1);
    expect(calls.dso_list).toEqual([
      ['', 1, ''],
      ['{"lat_deg":39.95,"lon_deg":-75.17,"height_m":5}', 2, '{"kinds":["galaxy"],"above_horizon":true}'],
    ]);
    expect(calls.dso_visibility).toEqual([['M31', '{"lat_deg":39.95,"lon_deg":-75.17}', 3, '{"bortle":4}']]);
    expect(calls.meteor_showers).toEqual([
      [2026, '', ''],
      [2027, '{"lat_deg":39.95,"lon_deg":-75.17}', '{"nelm":6.1,"k":0.3}'],
    ]);
    expect(calls.sky_search).toEqual([
      ['vega', '', undefined, undefined],
      ['vega', '{"lat_deg":39.95,"lon_deg":-75.17}', 4, 5],
    ]);
    expect(calls.tonight).toEqual([['{"lat_deg":39.95,"lon_deg":-75.17}', 5, '{"bortle":3,"limit":7}']]);
    expect(calls.extinction_table).toEqual([['{"k":0.2}']]);
  });

  it('sends only the known condition fields', () => {
    expect(conditionsJson(undefined)).toBe('');
    expect(conditionsJson({ bortle: null, nelm: 6.2 })).toBe('{"nelm":6.2}');
    expect(conditionsJson({ k: 0.25, extra: 1 } as never)).toBe('{"k":0.25}');
  });

  it('says to rebuild the core when a package predates the deep-sky exports', () => {
    const { engine } = fakeModule(false);
    expect(() => engine.dsoCatalog()).toThrow(/dso_catalog: .*deep-sky.*Rebuild it with: npm run wasm/);
    expect(() => engine.tonight(HERE, 1)).toThrow(/^tonight: /);
    expect(() => engine.skySearch('x')).toThrow(/^sky_search: /);
  });
});

describe('the mock', () => {
  const mock = new MockEngine();

  it('has every deep-sky call in the contract shapes', () => {
    expect(isDeepSkyEngine(mock)).toBe(true);
    const cat = mock.dsoCatalog();
    expect(cat.objects.length).toBeGreaterThan(10);
    const m31 = cat.objects.find((o) => o.id === 'M31')!;
    expect(m31).toMatchObject({ category: 'galaxy', type: 'spiral_galaxy', constellation: 'And' });
    const t = 2461308.4; // 2026-09-24 21:36 UT
    const pos = mock.dsoList(HERE, t);
    expect(pos.index).toBeInstanceOf(Int32Array);
    expect(pos.ra_deg).toBeInstanceOf(Float64Array);
    expect(pos.alt_deg!.length).toBe(pos.index.length);
    expect(mock.dsoList(null, t).alt_deg).toBeNull();
    const galaxies = mock.dsoList(null, t, { kinds: ['galaxy'] });
    for (const i of galaxies.index) expect(cat.objects[i]!.category).toBe('galaxy');

    const v = mock.dsoVisibility('m 31', HERE, t);
    expect(v.object.id).toBe('M31');
    expect(v.track.jd_utc).toHaveLength(145);
    expect(v.night.darkness?.kind).toBe('night');

    const y = mock.meteorShowers(2026);
    expect(y.showers.map((s) => s.shower.code)).toContain('PER');
    const per = y.showers.find((s) => s.shower.code === 'PER')!;
    expect(per.peak.utc.slice(0, 7)).toBe('2026-08');

    const mw = mock.milkyWayOutline();
    expect(mw.rings[0]!.ra_deg).toBeInstanceOf(Float64Array);
    expect(mw.rings[0]!.ra_deg[0]).toBeCloseTo(mw.rings[0]!.ra_deg.at(-1)!, 6);

    expect(mock.skySearch('andromeda').hits[0]!.id).toBe('M31');
    expect(mock.skySearch('vega', HERE, t).hits[0]!.alt_deg).not.toBeNull();
    expect(() => mock.skySearch('vega', HERE)).toThrow(/needs a time/);

    const tonight = mock.tonight(HERE, t, { limit: 3 });
    expect(tonight.deep_sky.length).toBeLessThanOrEqual(3);
    expect(tonight.summary).toMatch(/\{jd:\d+\.\d+\}/);

    const e = mock.extinction({ nelm: 6 });
    expect(e.alt_deg).toHaveLength(91);
    expect(e.limiting_mag[90]).toBeCloseTo(6, 3);
    expect(() => mock.extinction({ k: 0.9 })).toThrow(/k must be/);
  });
});

describe('the memoised engine', () => {
  it('forwards the deep-sky calls exactly when the engine has them', () => {
    const plain = memoEngine(new MockEngine() as unknown as ExplorerEngine);
    expect(isDeepSkyEngine(plain)).toBe(true);
    const deep = plain as unknown as DeepSkyEngine;
    expect(deep.dsoCatalog()).toBe(deep.dsoCatalog());
    expect(deep.milkyWayOutline()).toBe(deep.milkyWayOutline());
    const t = 2461308.4;
    expect(deep.tonight(HERE, t)).toBe(deep.tonight(HERE, t));
    // An engine without the calls (a build of the mock or core from before them).
    const without = new MockEngine();
    for (const name of ['dsoCatalog', 'dsoList', 'tonight', 'skySearch']) {
      Object.defineProperty(without, name, { value: undefined });
    }
    expect(isDeepSkyEngine(without)).toBe(false);
    expect(isDeepSkyEngine(memoEngine(without as unknown as ExplorerEngine))).toBe(false);
  });
});

describe('summary tokens', () => {
  it('become times in the caller’s format', () => {
    const s = 'Dark from {jd:2461308.517173} to {jd:2461308.889353} (8.9 hours).';
    expect(formatSummaryTimes(s, (jd) => (jd > 2461308.7 ? 'B' : 'A'))).toBe('Dark from A to B (8.9 hours).');
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package, deep sky', () => {
  let load: WasmLoad;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    load = inspectWasmModule(glue);
  });

  it('answers every deep-sky call (smoke test, needs a build with the deep-sky exports)', ({ skip }) => {
    if (load.status !== 'ready' || !isDeepSkyEngine(load.engine)) {
      skip();
      return;
    }
    const engine = load.engine;
    let cat;
    try {
      cat = engine.dsoCatalog();
    } catch (error) {
      if (/Rebuild it/.test(String(error))) {
        skip();
        return;
      }
      throw error;
    }
    expect(cat.objects).toHaveLength(213);
    const t = 2461308.4;
    const pos = engine.dsoList(HERE, t);
    expect(pos.index).toBeInstanceOf(Int32Array);
    expect(pos.index).toHaveLength(213);
    expect(pos.alt_apparent_deg).toBeInstanceOf(Float64Array);
    const v = engine.dsoVisibility('M31', HERE, t);
    expect(v.visibility.best!.alt_deg).toBeGreaterThan(60);
    const y = engine.meteorShowers(2026);
    expect(y.showers).toHaveLength(32);
    expect(y.showers.find((s) => s.shower.code === 'PER')!.peak.utc.slice(0, 10)).toBe('2026-08-13');
    const mw = engine.milkyWayOutline();
    expect(mw.rings.length).toBeGreaterThan(10);
    expect(mw.rings[0]!.ra_deg).toBeInstanceOf(Float64Array);
    expect(engine.skySearch('alpha cma').hits[0]!.label).toBe('Sirius');
    const tn = engine.tonight(HERE, t, { bortle: 4 });
    expect(tn.deep_sky.length).toBe(12);
    expect(tn.summary.startsWith('Dark from {jd:')).toBe(true);
    const e = engine.extinction();
    expect(e.limiting_mag).toBeInstanceOf(Float64Array);
    expect(() => engine.tonight(HERE, t, { k: 1 })).toThrow(/^tonight: .*k must be/);
  });
});
