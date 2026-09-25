/**
 * Planet detail (expansion programme P9): the WASM wrapper's serialisation, the type
 * guard, the mock's shapes and sanity, and a smoke test against the real built package
 * when there is one (`npm run wasm`). The mock is low-precision: its tests check the
 * contract and the physics' signs and orders, not accuracy (that is the Rust suite's).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import {
  isPlanetDetailEngine,
  type ManualOrbitalElements,
  type Observer,
  type PlanetDetailEngine,
} from '../../src/next/engine/types.js';
import {
  conjunctionOptionsJson,
  inspectWasmModule,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
  type WasmLoad,
} from '../../src/next/engine/wasm.js';
import { jdFromIso } from '../../src/next/time.js';

const jd = (iso: string): number => jdFromIso(iso)!;
const PHILLY: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 };
const TOKYO: Observer = { lat_deg: 35.6762, lon_deg: 139.6503 };
const PARIS: Observer = { lat_deg: 48.8566, lon_deg: 2.3522 };

/** MPC lines as the Minor Planet Center publishes them (Source: Minor Planet Center). */
const CERES =
  '00001    3.34  0.15 K2669 274.41935   73.29420   80.24863   10.58803  0.0796923  0.21430445   2.7655526  0 ' +
  'E2026-SD4  7376 127 1801-2026 0.82 M-v 30k MPCORBFIT  4000      (1) Ceres              20260922';
const PONS_BROOKS =
  '0012P         2024 04 21.2023  0.781885  0.954746  199.0345  255.8673   74.1494  20260924   5.0  6.0  ' +
  '12P/Pons-Brooks                                          MPC191593';
const MANUAL: ManualOrbitalElements = {
  name: 'Test comet',
  class: 'comet',
  q_au: 1.2,
  e: 1.0,
  i_deg: 45,
  node_deg: 100,
  peri_deg: 30,
  tp_tt: '2026-10-01T00:00:00Z',
  m1: 8,
  k1: 10,
};

// Compile-time: both engines provide the whole planet-detail interface.
const typed: PlanetDetailEngine[] = [new MockEngine({ syntheticStars: 0 })];
void typed;
const typedWasm = (x: ExplorerWasmExports): PlanetDetailEngine => new WasmEngine(x);
void typedWasm;

type Calls = Record<string, unknown[][]>;

const PLANET_DETAIL_EXPORTS = [
  'galilean_moons',
  'galilean_events',
  'saturn_rings',
  'planet_disc',
  'transits',
  'conjunctions',
  'stations',
  'earth_apsides',
  'parse_orbits',
  'custom_body_states',
  'sample_custom_bodies',
] as const;

function fakeModule(withPlanetDetail: boolean) {
  const calls: Calls = {};
  const module: Record<string, unknown> = { version: () => '9.9.9' };
  const names: string[] = [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS];
  if (withPlanetDetail) names.push(...PLANET_DETAIL_EXPORTS);
  for (const name of names) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return { from: name };
    };
  }
  return { module: module as unknown as ExplorerWasmExports, calls };
}

describe('the WASM wrapper', () => {
  it('calls each planet-detail export with the documented argument order', () => {
    const { module, calls } = fakeModule(true);
    const engine = new WasmEngine(module);
    expect(isPlanetDetailEngine(engine)).toBe(true);
    expect(engine.galileanMoons(1)).toEqual({ from: 'galilean_moons' });
    engine.galileanEvents(1, 2);
    engine.saturnRings(3);
    engine.planetDisc('Mars', 4);
    engine.transits(5, 6);
    engine.transits(5, 6, { ...PHILLY, label: 'x' } as never);
    engine.conjunctions(7, 8);
    engine.conjunctions(7, 8, { moon: false, max_separation_deg: 2, observer: PHILLY });
    engine.stations(9, 10);
    engine.earthApsides(2026);
    engine.parseOrbits(CERES);
    engine.customBodyStates(PHILLY, 11, [MANUAL]);
    engine.sampleCustomBodies(PHILLY, [MANUAL], 12, 13, 60);
    const here = '{"lat_deg":39.9526,"lon_deg":-75.1652,"height_m":12}';
    expect(calls.galilean_events).toEqual([[1, 2]]);
    expect(calls.saturn_rings).toEqual([[3]]);
    expect(calls.planet_disc).toEqual([['Mars', 4]]);
    expect(calls.transits).toEqual([
      [5, 6, ''],
      [5, 6, here],
    ]);
    expect(calls.conjunctions).toEqual([
      [7, 8, ''],
      [7, 8, `{"moon":false,"max_separation_deg":2,"observer":${here}}`],
    ]);
    expect(calls.stations).toEqual([[9, 10]]);
    expect(calls.earth_apsides).toEqual([[2026]]);
    expect(calls.parse_orbits).toEqual([[CERES]]);
    expect(calls.custom_body_states).toEqual([[here, 11, JSON.stringify([MANUAL])]]);
    expect(calls.sample_custom_bodies).toEqual([[here, JSON.stringify([MANUAL]), 12, 13, 60]]);
  });

  it('sends only the fields ConjunctionOptions defines (the Rust side rejects others)', () => {
    const withExtras = { planets: ['Mars'], stars: [], colour: 'red' } as never;
    expect(conjunctionOptionsJson(withExtras)).toBe('{"planets":["Mars"],"stars":[]}');
    expect(conjunctionOptionsJson(undefined)).toBe('');
  });

  it('says to rebuild the core when a package predates planet detail', () => {
    const engine = new WasmEngine(fakeModule(false).module);
    expect(isPlanetDetailEngine(engine)).toBe(true);
    expect(() => engine.galileanMoons(1)).toThrow(/^galilean_moons: .*no planet detail\. Rebuild it with: npm run wasm/);
    expect(() => engine.conjunctions(1, 2)).toThrow(/^conjunctions: /);
    expect(() => engine.parseOrbits('x')).toThrow(/^parse_orbits: /);
  });

  it('turns a thrown Rust error string into an Error naming the export', () => {
    const { module } = fakeModule(true);
    (module as unknown as Record<string, unknown>).planet_disc = () => {
      throw 'planet_disc: "Pluto" is not a planet';
    };
    expect(() => new WasmEngine(module).planetDisc('Pluto', 1)).toThrow(/^planet_disc: planet_disc: "Pluto"/);
  });

  it('is told apart from engines without it', () => {
    expect(isPlanetDetailEngine({ galileanMoons: () => 0 })).toBe(false);
    expect(isPlanetDetailEngine(null)).toBe(false);
  });
});

describe('the mock', () => {
  const engine = new MockEngine({ syntheticStars: 0 });

  it('is a planet-detail engine, and says its numbers are illustrative', () => {
    expect(isPlanetDetailEngine(engine)).toBe(true);
    expect(engine.galileanMoons(jd('2026-01-10T00:00:00Z')).theory).toMatch(/^MOCK/);
    expect(engine.planetDisc('Mars', jd('2026-01-10T00:00:00Z')).rotation_model).toMatch(/^MOCK/);
  });

  it('places the four moons consistently with their flags', () => {
    const m = engine.galileanMoons(jd('2026-01-10T00:00:00Z'));
    expect(m.moons.map((x) => x.name)).toEqual(['Io', 'Europa', 'Ganymede', 'Callisto']);
    for (const moon of m.moons) {
      expect(moon.in_front).toBe(moon.z_rj < 0);
      if (moon.in_transit) expect(moon.in_front).toBe(true);
      if (moon.occulted) expect(moon.in_front).toBe(false);
      expect(moon.shadow_x_rj === null).toBe(!moon.shadow_on_disc);
      // x is positive west: well off the disc, the east offset has the opposite sign (the
      // pole is within 15 degrees of north).
      if (Math.abs(moon.x_rj) > 1) expect(Math.sign(moon.offset_east_arcsec)).toBe(-Math.sign(moon.x_rj));
    }
    expect(m.jupiter.polar_radius_arcsec).toBeLessThan(m.jupiter.equatorial_radius_arcsec);
  });

  it('lists the moons’ phenomena in order, with their hidden moments marked', () => {
    const ev = engine.galileanEvents(jd('2026-01-05T00:00:00Z'), jd('2026-01-25T00:00:00Z'));
    expect(ev.truncated).toBe(false);
    expect(ev.phenomena.length).toBeGreaterThan(40);
    for (const p of ev.phenomena) expect(p.end.jd_utc).toBeGreaterThan(p.start.jd_utc);
    const starts = ev.phenomena.map((p) => p.start.jd_utc);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    const kinds = new Set(ev.phenomena.map((p) => p.kind));
    expect([...kinds].sort()).toEqual(['eclipse', 'occultation', 'shadow_transit', 'transit']);
    // Near opposition (10 January 2026) Io's eclipses end behind the planet.
    expect(ev.phenomena.some((p) => p.kind === 'eclipse' && !p.end.observable)).toBe(true);
    expect(() => engine.galileanEvents(0, 1e9)).toThrow(/finite window|at most 400 days/);
    expect(engine.galileanEvents(jd('1989-12-25T00:00:00Z'), jd('1990-01-05T00:00:00Z')).truncated).toBe(true);
  });

  it('shows the unlit face of the rings between the Earth’s and the Sun’s crossings of 2025', () => {
    const r = engine.saturnRings(jd('2025-04-15T00:00:00Z'));
    expect(r.earth_latitude_deg).toBeLessThan(0);
    expect(r.sun_latitude_deg).toBeGreaterThan(0);
    expect(r.lit_face_visible).toBe(false);
    expect(r.edges.map((e) => e.name)).toEqual(['A outer', 'A inner', 'B outer', 'B inner', 'C inner']);
    const open = engine.saturnRings(jd('2032-01-01T00:00:00Z'));
    expect(Math.abs(open.earth_latitude_deg)).toBeGreaterThan(15);
    const sinB = Math.sin((Math.abs(open.earth_latitude_deg) * Math.PI) / 180);
    expect(open.minor_axis_arcsec).toBeCloseTo(open.major_axis_arcsec * sinB, 6);
  });

  it('gives Jupiter three systems, and Venus and Uranus east longitudes', () => {
    const t = jd('2026-01-10T00:00:00Z');
    const j = engine.planetDisc('jupiter', t);
    expect(j.body).toBe('Jupiter');
    expect(j.central_meridians.map((c) => c.system)).toEqual(['I', 'II', 'III']);
    expect(j.central_meridians[2]!.longitude_deg).toBeCloseTo(j.sub_earth_lon_deg, 9);
    expect(j.longitude_positive).toBe('west');
    expect(j.notes.join(' ')).toMatch(/Great Red Spot/);
    expect(engine.planetDisc('Venus', t).longitude_positive).toBe('east');
    expect(engine.planetDisc('Uranus', t).longitude_positive).toBe('east');
    const v = engine.planetDisc('Venus', jd('2026-10-24T00:00:00Z'));
    expect(v.illuminated_fraction).toBeLessThan(0.1);
    expect(v.defect_of_illumination_arcsec).toBeGreaterThan(0.8 * v.equatorial_diameter_arcsec);
    expect(() => engine.planetDisc('Pluto', t)).toThrow(/not a planet/);
  });

  it('finds the transits of 1990-2060 with the real engine’s ids', () => {
    const list = engine.transits(jd('1990-01-01T00:00:00Z'), jd('2060-12-31T00:00:00Z'));
    expect(list.transits.map((t) => t.id)).toEqual([
      '1993-11-06-mercury',
      '1999-11-15-mercury',
      '2003-05-07-mercury',
      '2004-06-08-venus',
      '2006-11-08-mercury',
      '2012-06-06-venus',
      '2016-05-09-mercury',
      '2019-11-11-mercury',
      '2032-11-13-mercury',
      '2039-11-07-mercury',
      '2049-05-07-mercury',
      '2052-11-09-mercury',
    ]);
    const venus = list.transits.find((t) => t.id === '2012-06-06-venus')!;
    expect(venus.contacts.map((c) => c.kind)).toEqual(['c1', 'c2', 'greatest', 'c3', 'c4']);
    expect(venus.path).toHaveLength(25);
    expect(venus.local).toBeNull();
  });

  it('says where the 2019 transit of Mercury could be seen', () => {
    const window: [number, number] = [jd('2019-11-01T00:00:00Z'), jd('2019-11-30T00:00:00Z')];
    const local = (o: Observer) => engine.transits(...window, o).transits[0]!.local!;
    expect(local(PHILLY).visibility).toBe('visible');
    expect(local(TOKYO).visibility).toBe('below_horizon');
    const paris = local(PARIS);
    expect(paris.visibility).toBe('partly_below_horizon');
    expect(paris.events.map((e) => e.kind)).toEqual(['c1', 'c2', 'greatest', 'sunset', 'c3', 'c4']);
  });

  it('finds the great conjunction of 2020, the inner planet as `body` whatever the order asked', () => {
    const list = engine.conjunctions(jd('2020-12-01T00:00:00Z'), jd('2021-01-01T00:00:00Z'), {
      planets: ['Saturn', 'Jupiter'],
      moon: false,
      stars: [],
    });
    expect(list.conjunctions).toHaveLength(1);
    const c = list.conjunctions[0]!;
    expect([c.body, c.other, c.kind]).toEqual(['Jupiter', 'Saturn', 'planet_planet']);
    expect(c.separation_deg).toBeGreaterThan(0.05);
    expect(c.separation_deg).toBeLessThan(0.15);
    expect(c.local).toBeNull();
  });

  it('checks its options as the real engine does', () => {
    const [a, b] = [jd('2026-01-01T00:00:00Z'), jd('2026-02-01T00:00:00Z')];
    expect(() => engine.conjunctions(a, b, { colour: 'red' } as never)).toThrow(/unknown field/);
    expect(() => engine.conjunctions(a, b, { max_separation_deg: 25 })).toThrow(/0.1 to 20/);
    expect(() => engine.conjunctions(a, b, { planets: ['Pluto'] })).toThrow(/not a planet/);
    expect(() => engine.conjunctions(a, b, { stars: ['Mizar'] })).toThrow(/not a navigational star/);
    const withSite = engine.conjunctions(a, b, { observer: PHILLY });
    expect(withSite.conjunctions.length).toBeGreaterThan(3);
    for (const c of withSite.conjunctions) {
      expect(c.local).not.toBeNull();
      if (c.local!.best) expect(c.local!.best.sun_alt_deg).toBeLessThan(-6);
    }
  });

  it('turns Mars retrograde in December 2024, in both coordinates', () => {
    const s = engine.stations(jd('2024-11-01T00:00:00Z'), jd('2025-03-01T00:00:00Z'));
    expect(s.ui_coordinate).toBe('ecliptic_longitude');
    const mars = s.stations.filter((x) => x.body === 'Mars' && x.coordinate === 'ecliptic_longitude');
    expect(mars.map((x) => [x.kind, x.utc.slice(0, 7)])).toEqual([
      ['retrograde_begins', '2024-12'],
      ['retrograde_ends', '2025-02'],
    ]);
    expect(s.stations.some((x) => x.body === 'Mars' && x.coordinate === 'right_ascension')).toBe(true);
  });

  it('puts the Earth’s perihelion in January and aphelion in July', () => {
    const a = engine.earthApsides(2026);
    expect(a.events.map((e) => [e.kind, e.utc.slice(0, 7)])).toEqual([
      ['perihelion', '2026-01'],
      ['aphelion', '2026-07'],
    ]);
    expect(() => engine.earthApsides(2026.5)).toThrow(/whole number/);
  });

  it('reads MPC lines and typed-in elements, and follows the bodies across the sky', () => {
    const [ceres, comet] = engine.parseOrbits(`${CERES}\n${PONS_BROOKS}`);
    expect(ceres!.class).toBe('asteroid');
    expect(ceres!.name).toBe('(1) Ceres');
    expect(ceres!.epoch_jd_tt).toBe(2461200.5);
    expect(ceres!.magnitude).toEqual({ model: 'hg', h: 3.34, g: 0.15 });
    expect(comet!.class).toBe('comet');
    expect(comet!.magnitude).toEqual({ model: 'comet', m1: 5, k1: 15 });
    expect(() => engine.parseOrbits('not an orbit')).toThrow(/no orbital elements found/);
    expect(() => engine.parseOrbits(JSON.stringify({ ...MANUAL, tp_tt: '2026-10-01' }))).toThrow(/RFC 3339/);
    const t = jd('2026-09-24T12:00:00Z');
    const states = engine.customBodyStates(PHILLY, t, [ceres!, MANUAL]);
    expect(states.errors).toEqual([]);
    const c = states.bodies[0]!;
    expect([c.body, c.kind, c.custom]).toEqual(['(1) Ceres', 'asteroid', true]);
    expect(c.heliocentric_distance_au).toBeGreaterThan(2.5);
    expect(c.heliocentric_distance_au).toBeLessThan(3);
    expect(c.warnings).toHaveLength(1);
    expect(typeof c.constellation).toBe('string');
    const s = engine.sampleCustomBodies(PHILLY, [MANUAL], t, t + 1, 60);
    expect(s.jd_utc).toBeInstanceOf(Float64Array);
    expect(s.bodies[0]!.alt_deg).toHaveLength(25);
    expect(() => engine.sampleCustomBodies(PHILLY, [MANUAL], t, t + 10, 1)).toThrow(/at most 5000/);
    const outside = engine.customBodyStates(PHILLY, jd('2070-01-01T00:00:00Z'), [MANUAL]);
    expect(outside.errors.map((e) => e.body)).toEqual(['Test comet']);
  });
});

// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package: planet detail', () => {
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

  it('answers every planet-detail call in the contract shapes (needs a build with them)', ({ skip }) => {
    if (load.status !== 'ready') {
      skip();
      return;
    }
    const engine = load.engine;
    const t = jd('2026-01-10T00:00:00Z');
    let moons;
    try {
      moons = engine.galileanMoons(t);
    } catch (error) {
      if (/Rebuild it/.test(String(error))) {
        skip();
        return;
      }
      throw error;
    }
    expect(moons.moons.map((m) => m.name)).toEqual(['Io', 'Europa', 'Ganymede', 'Callisto']);
    expect(moons.accuracy_arcsec).toBeLessThan(1);
    const ev = engine.galileanEvents(t, t + 2);
    expect(ev.phenomena.length).toBeGreaterThan(3);
    expect(engine.saturnRings(jd('2025-04-15T00:00:00Z')).lit_face_visible).toBe(false);
    const disc = engine.planetDisc('Jupiter', t);
    expect(disc.central_meridians.map((c) => c.system)).toEqual(['I', 'II', 'III']);
    const tr = engine.transits(jd('2012-01-01T00:00:00Z'), jd('2013-01-01T00:00:00Z'), PHILLY);
    expect(tr.transits.map((x) => x.id)).toEqual(['2012-06-06-venus']);
    expect(tr.transits[0]!.local!.visibility).toBe('partly_below_horizon');
    const cj = engine.conjunctions(jd('2020-12-01T00:00:00Z'), jd('2021-01-01T00:00:00Z'), {
      planets: ['Saturn', 'Jupiter'],
      moon: false,
      stars: [],
    });
    expect(cj.conjunctions.map((c) => [c.body, c.utc.slice(0, 10)])).toEqual([['Jupiter', '2020-12-21']]);
    const st = engine.stations(jd('2024-11-01T00:00:00Z'), jd('2025-03-01T00:00:00Z'));
    expect(st.stations.filter((s) => s.body === 'Mars').length).toBe(4);
    const ap = engine.earthApsides(2026);
    expect(ap.events.map((e) => e.utc.slice(0, 10))).toEqual(['2026-01-03', '2026-07-06']);
    const [ceres] = engine.parseOrbits(CERES);
    expect(ceres!.name).toBe('(1) Ceres');
    const cs = engine.customBodyStates(PHILLY, jd('2026-09-24T12:00:00Z'), [ceres!, MANUAL]);
    expect(cs.bodies.map((b) => [b.body, b.kind, b.custom])).toEqual([
      ['(1) Ceres', 'asteroid', true],
      ['Test comet', 'comet', true],
    ]);
    const sampled = engine.sampleCustomBodies(PHILLY, [ceres!], t, t + 1, 60);
    expect(sampled.jd_utc).toBeInstanceOf(Float64Array);
    expect(sampled.bodies[0]!.alt_deg).toHaveLength(25);
  });
});
