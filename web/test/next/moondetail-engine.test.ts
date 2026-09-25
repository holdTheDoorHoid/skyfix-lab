/**
 * The Moon in detail (expansion programme P8): the mock's shapes, the WASM wrapper's
 * serialisation, the memoised engine's forwarding, and — when a WebAssembly package has
 * been built (`npm run wasm`) — the real engine against numbers the Rust tests validate
 * (the Mars occultation of 2025-01-14 seen from Philadelphia).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import { isMoonDetailEngine, type MoonDetailEngine } from '../../src/next/engine/types.js';
import {
  inspectWasmModule,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
  type WasmLoad,
} from '../../src/next/engine/wasm.js';

const PHILADELPHIA = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 10 };
const T = 2461309.0; // 2026-09-25T12:00Z
const JAN_2025 = 2460688.5; // 2025-01-13T00:00Z

describe('the mock Moon-detail engine', () => {
  const mock = new MockEngine();

  it('is a Moon-detail engine, and so is the memoised wrapper around it', () => {
    expect(isMoonDetailEngine(mock)).toBe(true);
    const memo = memoEngine(mock);
    expect(isMoonDetailEngine(memo)).toBe(true);
    const m = memo as unknown as MoonDetailEngine;
    expect(m.moonOrientation(PHILADELPHIA, T)).toBe(m.moonOrientation(PHILADELPHIA, T));
    expect(m.moonOrientation(null, T)).not.toBe(m.moonOrientation(PHILADELPHIA, T));
    expect(isMoonDetailEngine({})).toBe(false);
    expect(isMoonDetailEngine(null)).toBe(false);
  });

  it('gives an orientation in the contract shape, topocentric or geocentric', () => {
    const topo = mock.moonOrientation(PHILADELPHIA, T);
    expect(topo.topocentric).toBe(true);
    expect(topo.alt_deg).not.toBeNull();
    expect(topo.parallactic_angle_deg).not.toBeNull();
    expect(Math.abs(topo.libration.lat_deg)).toBeLessThan(10);
    expect(Math.abs(topo.libration.lon_deg)).toBeLessThan(10);
    expect(topo.terminator.points).toHaveLength(72);
    expect(topo.colongitude_deg).toBeGreaterThanOrEqual(0);
    expect(topo.colongitude_deg).toBeLessThan(360);
    expect(topo.apparent_diameter_arcmin).toBeGreaterThan(28);
    expect(topo.apparent_diameter_arcmin).toBeLessThan(35);
    const geo = mock.moonOrientation(null, T);
    expect(geo.topocentric).toBe(false);
    expect(geo.alt_deg).toBeNull();
    expect(geo.libration.diurnal_lon_deg).toBe(0);
    expect(() => mock.moonOrientation(null, Number.NaN)).toThrow();
    expect(() => mock.moonOrientation(null, 2400000.5)).toThrow(/coverage/);
  });

  it('lists features with their state and the ones near the terminator', () => {
    const f = mock.moonFeatures(PHILADELPHIA, T);
    expect(f.features.length).toBeGreaterThan(10);
    for (const s of f.features) {
      expect(s.lit).toBe(s.sun_altitude_deg > 0);
      if (s.near_terminator) expect(f.tonight).toContain(s.name);
    }
    expect(f.source).toMatch(/MOCK/);
  });

  it('finds perigees, apogees and the year’s supermoons', () => {
    const a = mock.moonApsides(2461041.5, 2461406.5); // 2026
    const per = a.apsides.filter((x) => x.kind === 'perigee').length;
    expect(per).toBeGreaterThanOrEqual(12);
    expect(per).toBeLessThanOrEqual(15);
    const full = a.syzygies.filter((s) => s.kind === 'full_moon');
    expect(full.filter((s) => s.largest_of_year)).toHaveLength(1);
    for (const s of a.syzygies) {
      expect(s.supermoon).toBe(s.perigee_fraction >= 0.9);
      expect(s.micromoon).toBe(s.perigee_fraction <= 0.1);
    }
    expect(() => mock.moonApsides(T, T - 1)).toThrow();
  });

  it('finds occultations in the contract shape', () => {
    const r = mock.occultations(PHILADELPHIA, JAN_2025, JAN_2025 + 3, { bodies: ['Mars'] });
    expect(r.bodies_searched).toBe(1);
    expect(r.limb_note).toMatch(/MOCK/);
    for (const e of r.events) {
      expect(e.body).toBe('Mars');
      expect(e.disappearance?.kind).toBe('disappearance');
      expect(['dark', 'bright']).toContain(e.reappearance?.limb);
    }
    expect(() => mock.occultations(PHILADELPHIA, T, T + 500)).toThrow(/400/);
    expect(() => mock.occultations(PHILADELPHIA, T, T + 5, { bodies: ['Vulcan'] })).toThrow(/Vulcan|vulcan/);
  });
});

describe('the WASM wrapper for the Moon in detail', () => {
  function fake(present: boolean) {
    const calls: Record<string, unknown[][]> = {};
    const module: Record<string, unknown> = { version: () => '9.9.9' };
    for (const name of [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS]) module[name] = () => ({ from: name });
    if (present) {
      for (const name of ['moon_orientation', 'moon_features', 'moon_apsides', 'occultations']) {
        module[name] = (...args: unknown[]) => {
          (calls[name] ??= []).push(args);
          return { from: name };
        };
      }
    }
    return { engine: new WasmEngine(module as unknown as ExplorerWasmExports), calls };
  }

  it('sends the documented arguments, `null` for the Earth’s centre', () => {
    const { engine, calls } = fake(true);
    expect(isMoonDetailEngine(engine)).toBe(true);
    engine.moonOrientation(PHILADELPHIA, T);
    engine.moonOrientation(null, T);
    engine.moonFeatures(null, T);
    engine.moonApsides(1, 2);
    engine.occultations(PHILADELPHIA, 1, 2, { max_magnitude: 4, bodies: ['Regulus'] });
    engine.occultations(PHILADELPHIA, 1, 2);
    expect(calls.moon_orientation).toEqual([
      ['{"lat_deg":39.9526,"lon_deg":-75.1652,"height_m":10}', T],
      ['null', T],
    ]);
    expect(calls.moon_features).toEqual([['null', T]]);
    expect(calls.moon_apsides).toEqual([[1, 2]]);
    expect(calls.occultations?.[0]).toEqual([
      '{"lat_deg":39.9526,"lon_deg":-75.1652,"height_m":10}',
      1,
      2,
      '{"max_magnitude":4,"bodies":["Regulus"]}',
    ]);
    expect(calls.occultations?.[1]?.[3]).toBe('{}');
  });

  it('says to rebuild when the package predates the exports', () => {
    const { engine } = fake(false);
    expect(() => engine.moonOrientation(null, T)).toThrow(/Rebuild/);
    expect(() => engine.occultations(PHILADELPHIA, 1, 2)).toThrow(/occultations/);
  });
});

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package: the Moon in detail', () => {
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

  it('occults Mars for Philadelphia on 2025-01-14 at the validated times', ({ skip }) => {
    if (load.status !== 'ready' || !isMoonDetailEngine(load.engine)) {
      skip();
      return;
    }
    const r = load.engine.occultations(PHILADELPHIA, JAN_2025, JAN_2025 + 2, { bodies: ['Mars'] });
    expect(r.events).toHaveLength(1);
    const e = r.events[0]!;
    expect(e.kind).toBe('planet');
    // The Rust engine (validated against Skyfield to 1.4 s) gives 02:19:25 and 03:34:37 UTC.
    expect(e.disappearance!.utc.slice(0, 19)).toBe('2025-01-14T02:19:25');
    expect(e.reappearance!.utc.slice(0, 19)).toBe('2025-01-14T03:34:37');
    expect(e.disappearance!.limb).toBe('bright');
    expect(e.reappearance!.limb).toBe('dark');
  });

  it('answers orientation, features and apsides in the contract shapes', ({ skip }) => {
    if (load.status !== 'ready' || !isMoonDetailEngine(load.engine)) {
      skip();
      return;
    }
    const o = load.engine.moonOrientation(PHILADELPHIA, T);
    expect(o.terminator.points).toHaveLength(72);
    // The pole faces the observer exactly when the libration in latitude exceeds the
    // Moon's angular radius (the pole's altitude seen from the disc's centre).
    expect(o.north_pole_disc.visible).toBe(o.sub_observer.lat_deg > o.semidiameter_arcmin / 60);
    const f = load.engine.moonFeatures(null, T);
    expect(f.features).toHaveLength(150);
    const a = load.engine.moonApsides(2461041.5, 2461406.5);
    expect(a.apsides.length).toBeGreaterThanOrEqual(26);
  });
});
