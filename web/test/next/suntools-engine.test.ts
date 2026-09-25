/**
 * The sun tools (expansion programme P7): the type guard, how the WASM wrapper calls its
 * exports and says to rebuild an old core, the mock's contract shapes and failure modes,
 * and — when a WebAssembly package has been built (`npm run wasm`) — the real core
 * answering in the same shapes, with the headline numbers the Rust tests validate.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { isSunToolsEngine, type Observer, type SunToolsEngine } from '../../src/next/engine/types.js';
import {
  inspectWasmModule,
  OPTIONAL_EXPORTS,
  REQUIRED_EXPORTS,
  WasmEngine,
  type ExplorerWasmExports,
  type WasmLoad,
} from '../../src/next/engine/wasm.js';
import { jdFromIso } from '../../src/next/time.js';

const PHILLY: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 12 };
const SIDING_SPRING: Observer = { lat_deg: -31.2733, lon_deg: 149.0617, height_m: 1165 };
const jd = (iso: string): number => jdFromIso(iso)!;
/** 2026-09-24, midnight to midnight EDT. */
const DAY0 = jd('2026-09-24T04:00:00Z');

const SUN_EXPORTS = [
  'sun_hours',
  'find_azimuth',
  'alignment_days',
  'analemma',
  'sun_path',
  'rise_set_azimuths',
  'equation_of_time',
  'solar_day',
  'solar_year',
  'galactic_centre_windows',
] as const;

type Calls = Record<string, unknown[][]>;

function fakeModule(withSunTools: boolean): { module: Record<string, unknown>; calls: Calls } {
  const calls: Calls = {};
  const module: Record<string, unknown> = { version: () => '9.9.9' };
  const names = [...REQUIRED_EXPORTS, ...OPTIONAL_EXPORTS, ...(withSunTools ? SUN_EXPORTS : [])];
  for (const name of names) {
    module[name] = (...args: unknown[]) => {
      (calls[name] ??= []).push(args);
      return { from: name };
    };
  }
  return { module, calls };
}

describe('sun tools: detection and the WASM wrapper', () => {
  it('recognises an engine with all ten methods, and only that', () => {
    expect(isSunToolsEngine(new MockEngine({ syntheticStars: 0 }))).toBe(true);
    expect(isSunToolsEngine({})).toBe(false);
    expect(isSunToolsEngine(null)).toBe(false);
    const partial = { sunHours: () => null };
    expect(isSunToolsEngine(partial)).toBe(false);
  });

  it('calls each export with the documented argument order', () => {
    const { module, calls } = fakeModule(true);
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(isSunToolsEngine(engine)).toBe(true);
    const o = { ...PHILLY, label: 'Philadelphia' } as Observer;
    const oj = '{"lat_deg":39.9526,"lon_deg":-75.1652,"height_m":12}';
    expect(engine.sunHours(o, 1, 2)).toEqual({ from: 'sun_hours' });
    engine.findAzimuth(o, 'Sun', 1, 2, 250);
    engine.findAzimuth(o, 'Moon', 1, 2, 120, { min_deg: 10 });
    engine.alignmentDays(o, { year: 2026, azimuth_deg: 299, event: { kind: 'set' } });
    engine.analemma(o, { year: 2026, time_h: 12, clock: 'lmt' });
    engine.sunPath(o, 1, 2);
    engine.riseSetAzimuths(o, { year: 2026 });
    engine.equationOfTime(2026);
    engine.solarDay(o, 1, 2, { tilt_deg: 30 });
    engine.solarDay(o, 1, 2);
    engine.solarYear(o, { year: 2026, optimise_tilt: true });
    engine.galacticCentreWindows(o, 1, 31);
    expect(calls.sun_hours).toEqual([[oj, 1, 2]]);
    expect(calls.find_azimuth).toEqual([
      [oj, 'Sun', 1, 2, 250, ''],
      [oj, 'Moon', 1, 2, 120, '{"min_deg":10}'],
    ]);
    expect(calls.alignment_days).toEqual([[oj, '{"year":2026,"azimuth_deg":299,"event":{"kind":"set"}}']]);
    expect(calls.analemma).toEqual([[oj, '{"year":2026,"time_h":12,"clock":"lmt"}']]);
    expect(calls.sun_path).toEqual([[oj, 1, 2, 10]]);
    expect(calls.rise_set_azimuths).toEqual([[oj, '{"year":2026}']]);
    expect(calls.equation_of_time).toEqual([[2026, 12]]);
    expect(calls.solar_day).toEqual([
      [oj, 1, 2, '{"tilt_deg":30}', 10],
      [oj, 1, 2, '', 10],
    ]);
    expect(calls.solar_year).toEqual([[oj, '{"year":2026,"optimise_tilt":true}']]);
    expect(calls.galactic_centre_windows).toEqual([[oj, 1, 31, '']]);
  });

  it('says to rebuild the core when a package predates the sun tools', () => {
    const { module } = fakeModule(false);
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    // The methods exist on the wrapper; the export does not.
    expect(() => engine.sunHours(PHILLY, 1, 2)).toThrow(/sun_hours: .*no sun tools\. Rebuild it with: npm run wasm/);
    expect(() => engine.galacticCentreWindows(PHILLY, 1, 2)).toThrow(/^galactic_centre_windows: /);
  });

  it('passes the core\'s own error text through, prefixed with the export', () => {
    const { module } = fakeModule(true);
    module.sun_hours = () => {
      throw 'the window must end after it starts: jd_start 2, jd_end 1';
    };
    const engine = new WasmEngine(module as unknown as ExplorerWasmExports);
    expect(() => engine.sunHours(PHILLY, 2, 1)).toThrow('sun_hours: the window must end after it starts');
  });
});

describe('sun tools: the mock', () => {
  const mock: SunToolsEngine = new MockEngine({ syntheticStars: 0 });

  it('gives a mid-latitude day its two golden and two blue hours, in order', () => {
    const h = mock.sunHours(PHILLY, DAY0, DAY0 + 1);
    expect(h.boundaries.map((b) => b.altitude_deg)).toEqual([-6, -4, 6]);
    expect(h.windows.map((w) => `${w.period} ${w.kind}`)).toEqual([
      'morning blue',
      'morning golden',
      'evening golden',
      'evening blue',
    ]);
    for (const w of h.windows) {
      expect(w.duration_min).toBeGreaterThan(5);
      expect(w.duration_min).toBeLessThan(90);
      expect(w.open_start || w.open_end).toBe(false);
    }
    expect(h.windows[1]!.jd_end).toBeLessThan(h.windows[2]!.jd_start);
    expect(h.sun.body).toBe('Sun');
    expect(h.phases[0]!.jd_start).toBe(DAY0);
    expect(() => mock.sunHours(PHILLY, DAY0, DAY0 - 1)).toThrow(/must end after it starts/);
  });

  it('finds the Sun due south near noon and refuses malformed bands', () => {
    const south = mock.findAzimuth(PHILLY, 'Sun', DAY0, DAY0 + 1, 180);
    expect(south).toHaveLength(1);
    expect(south[0]!.clockwise).toBe(true);
    expect(Math.abs(south[0]!.az_deg - 180)).toBeLessThan(0.05);
    expect(mock.findAzimuth(PHILLY, 'Sun', DAY0, DAY0 + 1, 0)).toEqual([]);
    expect(mock.findAzimuth(PHILLY, 'Sun', DAY0, DAY0 + 1, 0, { min_deg: -90 })).toHaveLength(1);
    expect(() => mock.findAzimuth(PHILLY, 'Sun', DAY0, DAY0 + 1, 90, { min_deg: 20, max_deg: 10 })).toThrow(/above max_deg/);
    expect(() => mock.findAzimuth(PHILLY, 'Vulcan', DAY0, DAY0 + 1, 90)).toThrow();
  });

  it('finds a Manhattanhenge-like pair of sunsets and marks one best day per run', () => {
    const r = mock.alignmentDays(
      { lat_deg: 40.758, lon_deg: -73.9855 },
      { year: 2026, azimuth_deg: 299, tolerance_deg: 0.5, event: { kind: 'set' }, utc_offset_hours: -4 },
    );
    expect(r.events_considered).toBe(365);
    const best = r.matches.filter((m) => m.best).map((m) => m.date.slice(5, 7));
    expect(best).toEqual(['05', '07']);
    expect(r.closest).not.toBeNull();
    expect(() => mock.alignmentDays(PHILLY, { year: 2026, azimuth_deg: 90, tolerance_deg: 0, event: { kind: 'set' } })).toThrow(
      /tolerance_deg/,
    );
  });

  it('lays out an analemma, a sun path with its envelope, and a year of azimuths', () => {
    const a = mock.analemma(PHILLY, { year: 2026, time_h: 12, clock: 'lmt' });
    expect(a.points).toHaveLength(365);
    expect(a.utc_offset_hours).toBeCloseTo(PHILLY.lon_deg / 15, 12);
    expect(() => mock.analemma(PHILLY, { year: 2026, time_h: 12, clock: 'zone' })).toThrow(/utc_offset_hours/);
    const p = mock.sunPath(PHILLY, DAY0, DAY0 + 1);
    expect(p.path.points).toHaveLength(145);
    expect(p.envelope.map((d) => d.day)).toEqual(['march_equinox', 'june_solstice', 'september_equinox', 'december_solstice']);
    const r = mock.riseSetAzimuths(PHILLY, { year: 2026, utc_offset_hours: -5 });
    expect(r.days).toHaveLength(365);
    expect(r.days.every((d) => d.rises.length === 1 && d.sets.length === 1)).toBe(true);
  });

  it('gives the equation of time its four turning points', () => {
    const e = mock.equationOfTime(2026);
    expect(e.points).toHaveLength(365);
    expect(e.extremes.map((x) => x.kind)).toEqual(['minimum', 'maximum', 'minimum', 'maximum']);
    expect(() => mock.equationOfTime(2026.5)).toThrow(/whole number/);
  });

  it('labels its solar numbers as a clear-sky estimate and a flat panel sees the global irradiance', () => {
    const d = mock.solarDay(PHILLY, DAY0, DAY0 + 1);
    expect(d.model.label).toBe('clear-sky estimate');
    expect(d.poa_kwh_m2).toBeCloseTo(d.ghi_kwh_m2, 9);
    expect(d.panel).toEqual({ tilt_deg: 0, azimuth_deg: 180, albedo: 0.2 });
    const y = mock.solarYear(PHILLY, { year: 2026, panel: { tilt_deg: 30 }, optimise_tilt: true });
    expect(y.months).toHaveLength(12);
    expect(y.optimal!.tilt_deg).toBeGreaterThan(20);
    expect(y.optimal!.tilt_deg).toBeLessThan(50);
    expect(() => mock.solarDay(PHILLY, DAY0, DAY0 + 1, { tilt_deg: 95 })).toThrow(/tilt_deg/);
  });

  it('finds the Milky Way core high in a southern winter night', () => {
    const g = mock.galacticCentreWindows(SIDING_SPRING, jd('2026-06-15T02:00:00Z'), jd('2026-06-16T02:00:00Z'));
    expect(g.windows.length).toBeGreaterThan(0);
    const best = Math.max(...g.windows.map((w) => w.best.alt_apparent_deg));
    expect(best).toBeGreaterThan(80);
    expect(g.galactic_centre.ra_j2000_deg).toBeCloseTo(266.4168, 3);
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('sun tools on the built WebAssembly package (src/wasm-pkg)', () => {
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

  it('answers every sun tool in the contract shapes (needs a build with the sun tools)', ({ skip }) => {
    if (load.status !== 'ready' || !isSunToolsEngine(load.engine)) {
      skip();
      return;
    }
    const engine = load.engine;
    try {
      engine.equationOfTime(2026);
    } catch (error) {
      if (/Rebuild it/.test(String(error))) {
        skip();
        return;
      }
      throw error;
    }
    const h = engine.sunHours(PHILLY, DAY0, DAY0 + 1);
    expect(h.windows.map((w) => `${w.period} ${w.kind}`)).toEqual([
      'morning blue',
      'morning golden',
      'evening golden',
      'evening blue',
    ]);
    // Blue hour ends at civil dusk, exactly.
    const dusk = h.sun.events.find((e) => e.kind === 'civil_dusk')!;
    expect(Math.abs(h.windows[3]!.jd_end - dusk.jd_utc) * 86_400).toBeLessThan(0.01);
    // Manhattanhenge, the engine's sunsets (upper limb on a sea-level horizon).
    const r = engine.alignmentDays(
      { lat_deg: 40.758, lon_deg: -73.9855 },
      { year: 2026, azimuth_deg: 299, tolerance_deg: 0.3, event: { kind: 'set' }, utc_offset_hours: -4 },
    );
    expect(r.matches.filter((m) => m.best).map((m) => m.date)).toEqual(['2026-05-24', '2026-07-18']);
    const e = engine.equationOfTime(2026);
    expect(e.extremes).toHaveLength(4);
    const y = engine.solarYear(PHILLY, { year: 2026, panel: { tilt_deg: 30 }, utc_offset_hours: -5, optimise_tilt: true });
    expect(y.model.label).toBe('clear-sky estimate');
    expect(y.optimal!.tilt_deg).toBeGreaterThan(30);
    expect(y.optimal!.tilt_deg).toBeLessThan(40);
    const g = engine.galacticCentreWindows(SIDING_SPRING, jd('2026-06-15T02:00:00Z'), jd('2026-06-16T02:00:00Z'));
    expect(g.windows.length).toBeGreaterThan(0);
    expect(g.windows[0]!.best.arch_ends_az_deg).toHaveLength(2);
    const p = engine.sunPath(PHILLY, DAY0, DAY0 + 1);
    expect(p.envelope).toHaveLength(4);
    const a = engine.analemma(PHILLY, { year: 2026, time_h: 12, clock: 'lmt' });
    expect(a.points).toHaveLength(365);
    const rs = engine.riseSetAzimuths(PHILLY, { year: 2026, utc_offset_hours: -5 });
    expect(rs.days).toHaveLength(365);
    const az = engine.findAzimuth(PHILLY, 'Sun', DAY0, DAY0 + 1, 180);
    expect(az).toHaveLength(1);
    const sd = engine.solarDay(PHILLY, DAY0, DAY0 + 1, { tilt_deg: 30 });
    expect(sd.samples).toHaveLength(145);
  });
});
