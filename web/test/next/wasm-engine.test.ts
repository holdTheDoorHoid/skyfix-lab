/**
 * The WASM engine wrapper: how inputs are serialised for the Rust exports, how errors
 * come back, and how a package without the explorer exports is detected. The last block
 * runs against the real built package when there is one (`npm run wasm`), so a merge of
 * the Rust explorer work can be smoke-tested with `npm test`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  isEclipseEngine,
  isPlanetEventsEngine,
  type DayEvents,
  type SolarEclipseLocal,
  type SolarEclipsePath,
} from '../../src/next/engine/types.js';
import {
  bodiesJson,
  inspectWasmModule,
  missingExports,
  observerJson,
  optionsJson,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
  type WasmLoad,
} from '../../src/next/engine/wasm.js';

type Calls = Record<string, unknown[][]>;

/** A module whose every export records its arguments and returns a canned value. */
function fakeModule(overrides: Partial<Record<string, (...args: unknown[]) => unknown>> = {}) {
  const calls: Calls = {};
  const module: Record<string, unknown> = { version: () => '9.9.9' };
  for (const name of [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS]) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      const override = overrides[name];
      return override ? override(...args) : { from: name };
    };
  }
  return { module, calls };
}

const HERE = { lat_deg: 39.95, lon_deg: -75.17 };

describe('serialisation', () => {
  it('sends only the contract fields of an observer', () => {
    const withExtras = { ...HERE, height_m: 12, label: 'Philadelphia', zone: 'America/New_York' };
    expect(JSON.parse(observerJson(withExtras))).toEqual({ lat_deg: 39.95, lon_deg: -75.17, height_m: 12 });
    expect(JSON.parse(observerJson({ ...HERE, pressure_hpa: 990, temperature_c: -5 }))).toEqual({
      ...HERE,
      pressure_hpa: 990,
      temperature_c: -5,
    });
  });

  it('sends body lists as JSON text, group names quoted', () => {
    expect(bodiesJson('all')).toBe('"all"');
    expect(bodiesJson(['Sun', "Al Na'ir"])).toBe('["Sun","Al Na\'ir"]');
    expect(optionsJson(undefined)).toBe('{"horizon":"standard","height_of_eye_m":0}');
    expect(optionsJson({ horizon: 'dip', height_of_eye_m: 2.5 })).toBe('{"horizon":"dip","height_of_eye_m":2.5}');
  });

  it('calls each export with the documented argument order', () => {
    const { module, calls } = fakeModule();
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    engine.skyState({ ...HERE, height_m: 3 }, 2461308.25, 'navigational');
    engine.sampleBodies(HERE, ['Moon'], 1, 2, 15);
    engine.dayEvents(HERE, 1, 2, 'all');
    engine.dayEventsBatch(HERE, [[1, 2], [2, 3]], ['Sun'], { horizon: 'dip', height_of_eye_m: 4 });
    engine.findAltitude(HERE, 'Sun', 1, 2, 30);
    engine.moonPhases(1, 30);
    engine.seasons(2026);
    engine.sidereal(5);
    engine.starfieldApparent(6);
    engine.constellationAt(10, 20, 7);
    expect(calls.sky_state).toEqual([['{"lat_deg":39.95,"lon_deg":-75.17,"height_m":3}', 2461308.25, '"navigational"']]);
    expect(calls.sample_bodies).toEqual([['{"lat_deg":39.95,"lon_deg":-75.17}', '["Moon"]', 1, 2, 15]]);
    expect(calls.day_events).toEqual([
      ['{"lat_deg":39.95,"lon_deg":-75.17}', 1, 2, '"all"', '{"horizon":"standard","height_of_eye_m":0}'],
    ]);
    expect(calls.day_events_batch).toEqual([
      ['{"lat_deg":39.95,"lon_deg":-75.17}', '[[1,2],[2,3]]', '["Sun"]', '{"horizon":"dip","height_of_eye_m":4}'],
    ]);
    expect(calls.find_altitude).toEqual([['{"lat_deg":39.95,"lon_deg":-75.17}', 'Sun', 1, 2, 30]]);
    expect(calls.moon_phases).toEqual([[1, 30]]);
    expect(calls.seasons).toEqual([[2026]]);
    expect(calls.sidereal).toEqual([[5]]);
    expect(calls.starfield_apparent).toEqual([[6]]);
    expect(calls.constellation_at).toEqual([[10, 20, 7]]);
  });

  it('passes typed arrays through untouched', () => {
    const apparent = new Float64Array([1, 2]);
    const { module } = fakeModule({ starfield_apparent: () => apparent });
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(engine.starfieldApparent(1)).toBe(apparent);
  });

  it('computes the constant tables once', () => {
    const { module, calls } = fakeModule();
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    engine.bodies();
    engine.bodies();
    engine.coverage();
    engine.coverage();
    engine.starfieldCatalog();
    engine.starfieldCatalog();
    engine.constellationBoundaries();
    engine.constellationBoundaries();
    for (const name of ['explorer_bodies', 'explorer_coverage', 'starfield_catalog', 'constellation_boundaries']) {
      expect(calls[name]).toHaveLength(1);
    }
    expect(engine.description).toMatch(/9\.9\.9/);
    expect(engine.kind).toBe('wasm');
  });

  it('turns a thrown Rust error string into an Error that names the export', () => {
    const { module } = fakeModule({
      sky_state: () => {
        throw 'observer: lat_deg 91 is outside [-90, 90]';
      },
    });
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(() => engine.skyState({ lat_deg: 91, lon_deg: 0 }, 1, 'all')).toThrow(
      'sky_state: observer: lat_deg 91 is outside [-90, 90]',
    );
  });
});

describe('wave 2: eclipses and planet events', () => {
  it('calls the optional exports with the documented argument order', () => {
    const { module } = fakeModule();
    const calls: Calls = {};
    for (const name of ['eclipses', 'eclipse_local', 'eclipse_path', 'planet_events']) {
      module[name] = (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        return { from: name };
      };
    }
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(isEclipseEngine(engine)).toBe(true);
    expect(isPlanetEventsEngine(engine)).toBe(true);
    expect(engine.eclipses(1, 2)).toEqual({ from: 'eclipses' });
    engine.eclipseLocal('2024-04-08-solar', { ...HERE, height_m: 12, label: 'x' } as never);
    engine.eclipsePath('2024-04-08-solar');
    engine.planetEvents(3, 4);
    expect(calls.eclipses).toEqual([[1, 2]]);
    expect(calls.eclipse_local).toEqual([['2024-04-08-solar', '{"lat_deg":39.95,"lon_deg":-75.17,"height_m":12}']]);
    expect(calls.eclipse_path).toEqual([['2024-04-08-solar']]);
    expect(calls.planet_events).toEqual([[3, 4]]);
  });

  it('says to rebuild the core when a package predates them', () => {
    const { module } = fakeModule();
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(() => engine.eclipses(1, 2)).toThrow(/eclipses: .*no eclipses\. Rebuild it with: npm run wasm/);
    expect(() => engine.eclipseLocal('x', HERE)).toThrow(/^eclipse_local: /);
    expect(() => engine.eclipsePath('x')).toThrow(/^eclipse_path: /);
    expect(() => engine.planetEvents(1, 2)).toThrow(/planet_events: .*no planet events/);
  });
});

describe('detecting what a package can do', () => {
  it('names exactly the missing exports', () => {
    const { module } = fakeModule();
    delete module.sky_state;
    delete module.starfield_catalog;
    delete module.constellation_boundaries;
    expect(missingExports(module)).toEqual({
      required: ['sky_state', 'starfield_catalog'],
      optional: ['constellation_boundaries'],
    });
    const load = inspectWasmModule(module);
    expect(load).toEqual({
      status: 'incomplete',
      missing: ['sky_state', 'starfield_catalog'],
      missingOptional: ['constellation_boundaries'],
      version: '9.9.9',
    });
  });

  it('accepts a package without the optional boundaries, which then draws none', () => {
    const { module } = fakeModule();
    delete module.constellation_boundaries;
    const load = inspectWasmModule(module);
    expect(load.status).toBe('ready');
    if (load.status !== 'ready') return;
    expect(load.missingOptional).toEqual(['constellation_boundaries']);
    expect(load.engine.constellationBoundaries()).toEqual([]);
  });

  it('reports the old workbench-only package as incomplete, listing all explorer exports', () => {
    const oldPackage = { version: () => '0.1.0', init: () => undefined, reduce: () => null, catalog: () => [] };
    const load = inspectWasmModule(oldPackage);
    expect(load.status).toBe('incomplete');
    if (load.status === 'incomplete') expect(load.missing).toEqual([...REQUIRED_EXPORTS]);
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package (src/wasm-pkg)', () => {
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

  it('loads in node, and either has the explorer or says exactly what it lacks', () => {
    if (load.status === 'incomplete') {
      expect(load.missing.length).toBeGreaterThan(0);
      for (const name of load.missing) expect(REQUIRED_EXPORTS).toContain(name);
    } else {
      expect(load.status).toBe('ready');
    }
  });

  it('answers the explorer calls in the contract shapes (smoke test, needs the Rust explorer)', ({ skip }) => {
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const engine = load.engine;
    const bodies = engine.bodies();
    expect(bodies.length).toBe(67);
    const t = 2461308.0; // 2026-09-24T12:00Z
    const state = engine.skyState(HERE, t, 'all');
    expect(state.bodies.length + state.errors.length).toBe(67);
    const sampled = engine.sampleBodies(HERE, ['Sun'], t, t + 1, 60);
    expect(sampled.jd_utc).toBeInstanceOf(Float64Array);
    const day: DayEvents = engine.dayEvents(HERE, t - 0.5, t + 0.5, ['Sun']);
    expect(day.phases[0]!.jd_start).toBe(day.jd_start);
    expect(day.phases.at(-1)!.jd_end).toBe(day.jd_end);
    expect(engine.sidereal(t).gha_aries_deg).toBeCloseTo(state.gha_aries_deg, 6);
    const catalog = engine.starfieldCatalog();
    expect(engine.starfieldApparent(t).length).toBe(2 * catalog.count);
  });

  it('answers the eclipse and planet-event calls (smoke test, needs a wave-2 build)', ({ skip }) => {
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const engine = load.engine;
    let list;
    try {
      list = engine.eclipses(2460310.5, 2460676.5); // 2024
    } catch (error) {
      if (/Rebuild it/.test(String(error))) {
        skip();
        return;
      }
      throw error;
    }
    expect(list.eclipses.map((e) => e.id)).toContain('2024-04-08-solar');
    const dallas = engine.eclipseLocal('2024-04-08-solar', { lat_deg: 32.78, lon_deg: -96.8, height_m: 150 });
    expect((dallas as SolarEclipseLocal).local_type).toBe('total');
    const path = engine.eclipsePath('2024-04-08-solar') as SolarEclipsePath;
    expect(path.central_line.segments.length).toBeGreaterThan(0);
    const planets = engine.planetEvents(2460310.5, 2460676.5);
    const jupiter = planets.events.find((e) => e.body === 'Jupiter' && e.kind === 'opposition');
    expect(jupiter?.utc.slice(0, 10)).toBe('2024-12-07');
  });
});
