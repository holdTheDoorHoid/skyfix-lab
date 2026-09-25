/**
 * The navigation tools behind the Navigate view: the WASM wrapper's serialisation and
 * errors (a fake module), the mock's shapes and refusals (the contract's failure modes),
 * and, when a package is built, the real engine against the published and Skyfield
 * worked examples the view ships as examples.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../src/types.js';
import { memoEngine } from '../../src/next/component.js';
import { createMockNav, createMockSessionApi, mockChain, mockEarthShapeArcmin } from '../../src/next/engine/mock-nav.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine } from '../../src/next/engine/types.js';
import { inspectWasmModule } from '../../src/next/engine/wasm.js';
import { createWasmNav, instrumentJson, missingNavExports, NAV_EXPORTS, sightObserverJson, type NavTools } from '../../src/next/engine/wasm-nav.js';
import { DUSK_SIGHTS, DUSK_TRUTH, EXAMPLES, exampleById } from '../../src/next/navigate/examples.js';
import { fixSession, lunarInputFor, noonOptionsFor, noonSession, polarisOptionsFor, polarisSession, averageOptionsFor, averageSession, runningRequestFor, solveOptionsFor } from '../../src/next/navigate/model.js';
import { jdFromIso } from '../../src/next/time.js';

type Calls = Record<string, unknown[][]>;

function fakeNavModule(): { module: Record<string, (...a: unknown[]) => unknown>; calls: Calls } {
  const calls: Calls = {};
  const module: Record<string, (...a: unknown[]) => unknown> = {};
  for (const name of NAV_EXPORTS) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      if (name === 'lunar_distance') throw 'lunar distance: the other body cannot be the Moon';
      return name === 'sight_bodies' ? [{ body: 'Sun', kind: 'sun' }] : { from: name };
    };
  }
  return { module, calls };
}

const SESSION: Session = {
  schema: 'skyfix.session/1',
  meta: { name: 't', notes: '', kind: 'simulated' },
  observer: { height_of_eye_m: 2, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40, lon_deg: -75 }, assumed_position_role: { role: 'initializer' } },
  instrument: { name: '', index_correction_arcmin: 0, horizon: 'sea' },
  clock: { uncertainty_s: 0, correction_s: 0 },
  observations: [],
};

describe('the WASM navigation wrapper', () => {
  it('is absent when any navigation export is missing, and names them', () => {
    const { module } = fakeNavModule();
    const partial = { ...module };
    delete partial.plan_sights;
    delete partial.noon_sight;
    expect(missingNavExports(partial)).toEqual(['noon_sight', 'plan_sights']);
    expect(createWasmNav(partial)).toBeNull();
    expect(createWasmNav(module)).not.toBeNull();
  });

  it('sends each export its documented arguments as JSON text', () => {
    const { module, calls } = fakeNavModule();
    const nav = createWasmNav(module)!;
    nav.noonSight(SESSION, { dr: { lat_deg: 40, lon_deg: -75, sigma_nm: null } });
    nav.polarisLatitude(SESSION, undefined, 'supplied');
    nav.averageSights(SESSION, { reject_outliers: false });
    nav.runningFix(SESSION, { legs: [{ course_deg: 45, speed_kn: 12 }] });
    nav.predictSextant({ lat_deg: 1, lon_deg: 2, height_of_eye_m: 3, extra: 9 } as never, { index_correction_arcmin: -1.2 }, 'Moon', 'lower', 2461308.5);
    nav.planSights({ lat_deg: 1, lon_deg: 2 }, 10, 11, {});
    expect(calls.noon_sight![0]).toEqual([JSON.stringify(SESSION), '{"dr":{"lat_deg":40,"lon_deg":-75,"sigma_nm":null}}', 'auto']);
    expect(calls.polaris_latitude![0]).toEqual([JSON.stringify(SESSION), '{}', 'supplied']);
    expect(calls.average_sights![0]![1]).toBe('{"reject_outliers":false}');
    expect(calls.running_fix![0]![1]).toBe('{"legs":[{"course_deg":45,"speed_kn":12}]}');
    expect(calls.predict_sextant![0]).toEqual(['{"lat_deg":1,"lon_deg":2,"height_of_eye_m":3}', '{"index_correction_arcmin":-1.2}', 'Moon', 'lower', 2461308.5]);
    // UT1 − UTC travels with the observer when it is given (expansion programme).
    expect(sightObserverJson({ lat_deg: 1, lon_deg: 2, dut1_s: -0.3 })).toBe('{"lat_deg":1,"lon_deg":2,"dut1_s":-0.3}');
    expect(sightObserverJson({ lat_deg: 1, lon_deg: 2, dut1_s: null })).toBe('{"lat_deg":1,"lon_deg":2}');
    expect(calls.plan_sights![0]).toEqual(['{"lat_deg":1,"lon_deg":2}', 10, 11, '{}']);
    expect(sightObserverJson({ lat_deg: 1, lon_deg: 2, pressure_hpa: 990, temperature_c: -5 })).toBe('{"lat_deg":1,"lon_deg":2,"pressure_hpa":990,"temperature_c":-5}');
    expect(instrumentJson(undefined)).toBe('{}');
  });

  it('caches the sight bodies and turns a thrown string into an Error naming the export', () => {
    const { module, calls } = fakeNavModule();
    const nav = createWasmNav(module)!;
    nav.sightBodies();
    nav.sightBodies();
    expect(calls.sight_bodies).toHaveLength(1);
    expect(() => nav.lunarDistance({} as never)).toThrow('lunar_distance: lunar distance: the other body cannot be the Moon');
  });

  it('is composed into the WASM engine and survives the memoising wrapper', () => {
    const exports: Record<string, unknown> = { ...fakeNavModule().module };
    for (const name of ['explorer_bodies', 'explorer_coverage', 'sky_state', 'sample_bodies', 'day_events', 'day_events_batch', 'find_altitude', 'moon_phases', 'seasons', 'sidereal', 'starfield_catalog', 'starfield_apparent', 'constellation_at']) {
      exports[name] = () => ({});
    }
    const load = inspectWasmModule(exports);
    if (load.status !== 'ready') throw new Error('expected ready');
    expect(load.engine.nav).toBeDefined();
    expect(memoEngine(load.engine).nav).toBe(load.engine.nav);
    delete exports.running_fix;
    const old = inspectWasmModule(exports);
    if (old.status !== 'ready') throw new Error('expected ready');
    expect(old.engine.nav).toBeUndefined();
    expect('nav' in memoEngine(old.engine)).toBe(false);
  });
});

describe('the mock navigation tools (interface development only)', () => {
  const engine = new MockEngine();
  const nav = engine.nav;

  it('offers the navigational bodies only, Sun and Moon first', () => {
    const bodies = nav.sightBodies();
    expect(bodies.slice(0, 2).map((b) => b.body)).toEqual(['Sun', 'Moon']);
    const names = bodies.map((b) => b.body);
    for (const never of ['Mercury', 'Uranus', 'Neptune']) expect(names).not.toContain(never);
    expect(names).toContain('Polaris');
    expect(bodies).toHaveLength(64);
  });

  it('runs the correction chain once, in order, and refuses what the core refuses', () => {
    const base = { id: 'x', body: 'Sun', kind: 'sextant_hs' as const, altitude_deg: 45.9, sigma_arcmin: 1, limb: 'lower' as const, horizon: 'sea' as const, index_correction_arcmin: 0.2, height_of_eye_m: 20.7264, pressure_hpa: 1010, temperature_c: 10, semidiameter_arcmin: 16.1, horizontal_parallax_arcmin: 0.146 };
    const sun = mockChain(base);
    expect(sun.steps.map((s) => s.kind)).toEqual(['index_correction', 'dip', 'artificial_horizon_halving', 'refraction', 'semidiameter', 'parallax']);
    expect(sun.steps.map((s) => s.applied)).toEqual([true, true, false, true, true, true]);
    expect(sun.ho_deg).toBeCloseTo(46.02, 1);
    const ho = mockChain({ ...base, kind: 'observed_ho' });
    expect(ho.steps.every((s) => !s.applied)).toBe(true);
    expect(ho.ho_deg).toBe(45.9);
    expect(ho.warnings.map((w) => w.code)).toEqual(['already_corrected']);
    expect(() => mockChain({ ...base, body: 'Moon', horizontal_parallax_arcmin: 0 })).toThrow(/horizontal parallax/);
    expect(() => mockChain({ ...base, altitude_deg: -1 })).toThrow(/below the horizon/);
    expect(mockChain({ ...base, body: 'Vega', limb: 'upper' }).warnings.map((w) => w.code)).toContain('limb_ignored_for_star');
  });

  it('predicts a reading the chain reduces straight back to Hc', () => {
    const jd = jdFromIso('2026-09-25T02:00:00Z')!;
    const p = nav.predictSextant({ lat_deg: 39.9526, lon_deg: -75.1652, height_of_eye_m: 2 }, { index_correction_arcmin: -1.2 }, 'Moon', 'lower', jd);
    expect(p.corrections.ho_deg).toBeCloseTo(p.hc_deg, 6);
    expect(p.hs_deg).toBeLessThan(p.hc_deg);
    // The Moon's Hc carries its Earth-shape term (CONVENTIONS 15.4), as the core's does.
    expect(Math.abs(p.earth_shape_arcmin)).toBeGreaterThan(0);
    expect(p.earth_shape_arcmin).toBeCloseTo(mockEarthShapeArcmin(39.9526, -75.1652, p.gha_deg, p.dec_deg, p.horizontal_parallax_arcmin), 12);
    expect(() => nav.predictSextant({ lat_deg: 0, lon_deg: 0 }, {}, 'Mercury', 'center', jd)).toThrow(/not offered for sights/);
  });

  it('computes the Moon’s Earth-shape term as the core does', () => {
    // Independent Python values (the same ones skyfix-core's wgs84 tests pin).
    const cases: [number, number, number, number, number, number][] = [
      [54.7, 0.0, 0.0, 0.0, 61.5, 0.22332381215033395],
      [39.9526, -75.1652, 352.0833, 26.305, 59.341, 0.05668299809180458],
      [-33.9, 151.2, 200.0, -20.0, 55.0, 0.15560159358638626],
      [12.0, -40.0, 80.0, 5.0, 57.3, 0.01216113580316577],
    ];
    for (const [lat, lon, gha, dec, hp, want] of cases) expect(mockEarthShapeArcmin(lat, lon, gha, dec, hp)).toBeCloseTo(want, 10);
    expect(mockEarthShapeArcmin(40, -75, 10, 20, 0)).toBe(0);
  });

  it('keeps the methods’ failure modes', () => {
    const two = { ...SESSION, observations: [{ id: 'a', body: 'Sun', utc: '2026-09-23T16:52:58Z', altitude_deg: 49.6, altitude_kind: 'sextant_hs' as const, sigma_arcmin: 0.5, limb: 'lower' as const, horizon: null, geocentric: null, notes: '' }, { id: 'b', body: 'Vega', utc: '2026-09-23T16:54:58Z', altitude_deg: 30, altitude_kind: 'sextant_hs' as const, sigma_arcmin: 0.5, limb: 'center' as const, horizon: null, geocentric: null, notes: '' }] };
    expect(() => nav.noonSight(two)).toThrow(/one body/);
    expect(() => nav.noonSight({ ...two, observer: { ...two.observer, assumed_position: null }, observations: two.observations.slice(0, 1) })).toThrow(/DR/);
    expect(() => nav.runningFix(two, { legs: [] })).toThrow(/legs is required/);
    expect(() => nav.planSights({ lat_deg: 40, lon_deg: -75 }, 2461308, 2461316, {})).toThrow(/7 days/);
    expect(() => nav.lunarDistance({ observer: { lat_deg: 0, lon_deg: 0 }, body: 'Moon', utc_estimate: '2026-09-24T00:00:00Z', distance_deg: 50 })).toThrow(/cannot be the Moon/);
  });

  it('gives every example a result of the contract’s shape', () => {
    const run = (id: string) => exampleById(id)!.build(nav);
    const noon = run('noon-run');
    const n = nav.noonSight(noonSession(noon), noonOptionsFor(noon), noon.mode);
    expect(n.latitude.lat_deg).toBeCloseTo(39.95, 0);
    expect(n.warnings.map((w) => w.code)).toContain('flat_peak_longitude');
    const pol = run('polaris-bowditch');
    expect(nav.polarisLatitude(polarisSession(pol), polarisOptionsFor(pol)).polaris[0]!.almanac?.within_printed_table).toBe(true);
    const avg = run('vega-run');
    expect(nav.averageSights(averageSession(avg), averageOptionsFor(avg)).observation.altitude_kind).toBe('observed_ho');
    const rf = run('running-fix');
    expect(['unique', 'ambiguous', 'underdetermined', 'failed']).toContain(nav.runningFix(fixSession(rf), runningRequestFor(rf)).result.kind);
    const plan = nav.planSights({ lat_deg: 39.9526, lon_deg: -75.1652, height_of_eye_m: 2 }, jdFromIso('2026-09-24T16:00:00Z')!, jdFromIso('2026-09-25T16:00:00Z')!, {});
    expect(plan.windows.map((w) => w.kind)).toEqual(['evening', 'morning']);
    for (const w of plan.windows) expect(w.sights.length).toBeGreaterThanOrEqual(3);
  });

  it('reduces body-first sights in the mock session adapter, and solves them', async () => {
    const api = createMockSessionApi(engine as ExplorerEngine);
    const w = exampleById('dusk-stars')!.build(nav);
    const reduced = await api.reduce(w.session, 'auto');
    expect(reduced.every((e) => e.status === 'ok')).toBe(true);
    const supplied = await api.reduce(w.session, 'supplied');
    expect(supplied.every((e) => e.status === 'error')).toBe(true);
    const fix = await api.solve(w.session, solveOptionsFor(w), 'auto');
    expect(fix.kind).toBe('unique');
    if (fix.kind === 'unique') {
      expect(Math.abs(fix.fix.position.lat_deg - DUSK_TRUTH.lat_deg) * 60).toBeLessThan(3);
    }
  });

  it('is built on the public engine only, so the memoised mock works too', () => {
    const memo = memoEngine(engine);
    const tools = createMockNav(memo);
    expect(tools.sightBodies()).toHaveLength(64);
  });
});

// ---------------------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package: worked examples through the view’s requests', () => {
  let nav: NavTools | null = null;
  let solve: ((session: string, options: string, mode: string) => unknown) | null = null;

  beforeAll(async () => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as Record<string, unknown> & {
      initSync: (input: { module: BufferSource }) => unknown;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    nav = createWasmNav(glue);
    solve = typeof glue.solve === 'function' ? (glue.solve as typeof solve) : null;
  });

  it('has every navigation export (a stale package skips the rest)', ({ skip }) => {
    if (!nav) skip();
    expect(nav!.sightBodies()).toHaveLength(64);
  });

  it('Bowditch §1912: latitude by Polaris, 40° 48.4′ N in the book', ({ skip }) => {
    if (!nav) return skip();
    const w = exampleById('polaris-bowditch')!.build(nav);
    const r = nav.polarisLatitude(polarisSession(w), polarisOptionsFor(w), w.mode);
    expect(r.latitude.lat_deg).toBeCloseTo(40.807792, 5);
    expect((r.latitude.lat_deg - 40.806666667) * 60).toBeLessThan(0.1);
    expect(r.polaris[0]!.almanac!.a0_arcmin).toBeCloseTo(54.93, 2);
  });

  it('Bowditch §1910: one altitude at local apparent noon, 39° 48.6′ N in the book', ({ skip }) => {
    if (!nav) return skip();
    const w = exampleById('noon-bowditch')!.build(nav);
    const r = nav.noonSight(noonSession(w), noonOptionsFor(w), w.mode);
    expect(r.method).toBe('maximum_altitude');
    expect(Math.abs((r.latitude.lat_deg - 39.81) * 60)).toBeLessThan(0.2);
    expect(r.longitude).toBeNull();
  });

  it('the Skyfield noon run recovers Philadelphia’s latitude and longitude', ({ skip }) => {
    if (!nav) return skip();
    const w = exampleById('noon-run')!.build(nav);
    const r = nav.noonSight(noonSession(w), noonOptionsFor(w), w.mode);
    expect(Math.abs(r.latitude.lat_deg - 39.9526) * 60).toBeLessThan(0.01);
    expect(Math.abs(r.longitude!.lon_deg + 75.1652) * 60).toBeLessThan(0.01);
    expect(r.meridian_passage!.utc).toBe('2026-09-23T16:52:57.689Z');
  });

  it('the Vega run averages to the fixture’s value, and the lunar distance finds 01:15:25', ({ skip }) => {
    if (!nav) return skip();
    const w = exampleById('vega-run')!.build(nav);
    const avg = nav.averageSights(averageSession(w), averageOptionsFor(w), w.mode);
    expect(avg.ho_deg).toBeCloseTo(61.072473, 5);
    expect(avg.n_used).toBe(7);
    const l = exampleById('lunar-venus')!.build(nav);
    const made = lunarInputFor(l, { lat_deg: 0, lon_deg: 0 });
    if (!('input' in made)) throw new Error('expected an input');
    const r = nav.lunarDistance(made.input);
    expect(Math.abs(jdFromIso(r.utc)! - jdFromIso('2029-10-17T01:15:25Z')!) * 86400).toBeLessThan(2);
    expect(r.utc_minus_estimate_s).toBeGreaterThan(570);
  });

  it('the running fix lands within 0.1 NM of the truth', ({ skip }) => {
    if (!nav) return skip();
    const w = exampleById('running-fix')!.build(nav);
    const out = nav.runningFix(fixSession(w), runningRequestFor(w), w.mode);
    expect(out.result.kind).toBe('unique');
    if (out.result.kind !== 'unique') return;
    const p = out.result.fix.position;
    expect(Math.hypot(p.lat_deg - 40.424264069, (p.lon_deg + 69.444429733) * Math.cos(40.42 * (Math.PI / 180))) * 60).toBeLessThan(0.1);
  });

  it('the dusk star fix, built from the engine’s own predicted readings plus stated errors, lands within a mile of City Hall', ({ skip }) => {
    if (!nav || !solve) return skip();
    const w = exampleById('dusk-stars')!.build(nav);
    expect(w.session.observations).toHaveLength(DUSK_SIGHTS.length);
    const r = solve(JSON.stringify(fixSession(w)), JSON.stringify(solveOptionsFor(w)), w.mode) as { kind: string; fix?: { position: { lat_deg: number; lon_deg: number } } };
    expect(r.kind).toBe('unique');
    const p = r.fix!.position;
    expect(Math.hypot(p.lat_deg - DUSK_TRUTH.lat_deg, (p.lon_deg - DUSK_TRUTH.lon_deg) * Math.cos(0.7)) * 60).toBeLessThan(1);
  });

  it('the Timor Moon and planets session fixes to its Skyfield truth, and two stars stay ambiguous', ({ skip }) => {
    if (!nav || !solve) return skip();
    const t = exampleById('timor-moon-venus')!.build(nav);
    const r = solve(JSON.stringify(fixSession(t)), JSON.stringify(solveOptionsFor(t)), t.mode) as { kind: string; fix?: { position: { lat_deg: number; lon_deg: number } } };
    expect(r.kind).toBe('unique');
    expect(Math.abs(r.fix!.position.lat_deg + 12.2) * 60).toBeLessThan(0.01);
    expect(Math.abs(r.fix!.position.lon_deg - 128.5) * 60).toBeLessThan(0.01);
    const two = exampleById('two-stars')!.build(nav);
    const a = solve(JSON.stringify(fixSession(two)), JSON.stringify(solveOptionsFor(two)), two.mode) as { kind: string; candidates?: unknown[] };
    expect(a.kind).toBe('ambiguous');
    expect(a.candidates).toHaveLength(2);
  });

  it('tonight’s plan for Philadelphia has an evening and a morning window of three to five bodies', ({ skip }) => {
    if (!nav) return skip();
    const plan = nav.planSights({ lat_deg: 39.9526, lon_deg: -75.1652, height_of_eye_m: 2 }, jdFromIso('2026-09-24T16:00:00Z')!, jdFromIso('2026-09-25T16:00:00Z')!, {});
    expect(plan.windows.map((w) => w.kind)).toEqual(['evening', 'morning']);
    for (const w of plan.windows) {
      expect(w.sights.length).toBeGreaterThanOrEqual(3);
      expect(w.sights.length).toBeLessThanOrEqual(5);
      for (const s of w.sights) expect(s.prediction.corrections.ho_deg).toBeCloseTo(s.hc_deg, 6);
    }
  });

  it('every example builds with the real engine', ({ skip }) => {
    if (!nav) return skip();
    for (const e of EXAMPLES) expect(e.build(nav).session.meta.kind).toBe('simulated');
  });
});
