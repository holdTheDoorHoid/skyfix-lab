/**
 * The misfit grid's engine wrappers: how inputs are serialised for `misfit_grid` and
 * `misfit_default_bounds`, how errors come back, how a package without the exports is
 * detected, the mock's contract shapes, and — when a package has been built
 * (`npm run wasm`) — the real exports on the packaged demos.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { mockSimulate, mockSolve } from '../../src/api/mock.js';
import { MOCK_DEMOS } from '../../src/api/mockDemos.js';
import { memoEngine } from '../../src/next/component.js';
import { createMockMisfit, MOCK_MISFIT_NOTE } from '../../src/next/engine/mock-misfit.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { MisfitEngine, MisfitGrid } from '../../src/next/engine/types.js';
import { inspectWasmModule, REQUIRED_EXPORTS } from '../../src/next/engine/wasm.js';
import {
  checkAxis,
  createWasmMisfit,
  MISFIT_EXPORTS,
  misfitBoundsJson,
  misfitOptionsJson,
  missingMisfitExports,
} from '../../src/next/engine/wasm-misfit.js';
import { defaultSolveOptions, type Session } from '../../src/types.js';

const BOX = { south_deg: 39, north_deg: 41, west_deg: -76, east_deg: -74 };

function mockSession(k: number): Session {
  return mockSimulate(structuredClone(MOCK_DEMOS[k]!)).session;
}

function metres(a: { lat_deg: number; lon_deg: number }, b: { lat_deg: number; lon_deg: number }): number {
  const r = Math.PI / 180;
  const c =
    Math.sin(a.lat_deg * r) * Math.sin(b.lat_deg * r) +
    Math.cos(a.lat_deg * r) * Math.cos(b.lat_deg * r) * Math.cos((a.lon_deg - b.lon_deg) * r);
  return Math.acos(Math.min(1, Math.max(-1, c))) * ((1852 * 10800) / Math.PI);
}

describe('serialisation', () => {
  it('sends only the four fields of a box, and "" for the default frame', () => {
    const extra = { ...BOX, label: 'Philadelphia', zoom: 9 } as typeof BOX;
    expect(JSON.parse(misfitBoundsJson(extra))).toEqual(BOX);
    expect(misfitBoundsJson(null)).toBe('');
    expect(misfitBoundsJson(undefined)).toBe('');
    expect(misfitOptionsJson(null)).toBe('{}');
    expect(JSON.parse(misfitOptionsJson({ estimate_shared_bias: true }))).toEqual({ estimate_shared_bias: true });
  });

  it('refuses node counts the engine would refuse, before calling it', () => {
    expect(checkAxis('n_lat', 2)).toBe(2);
    expect(checkAxis('n_lon', 1024)).toBe(1024);
    for (const bad of [1, 1025, 12.5, Number.NaN, -3]) expect(() => checkAxis('n_lat', bad)).toThrow(/n_lat/);
  });
});

describe('the WASM wrapper', () => {
  function fake(result: unknown = { from: 'misfit_grid' }) {
    const calls: Record<string, unknown[][]> = {};
    const module: Record<string, unknown> = {};
    for (const name of MISFIT_EXPORTS) {
      module[name] = (...args: unknown[]) => {
        (calls[name] ??= []).push(args);
        if (result instanceof Error) throw 'misfit says no';
        return result;
      };
    }
    return { module, calls };
  }

  it('calls the exports with the documented argument order', () => {
    const { module, calls } = fake();
    const engine = createWasmMisfit(module)!;
    const session = mockSession(0);
    engine.misfitGrid(session, 'auto', { estimate_shared_bias: true }, BOX, 20, 30);
    engine.misfitGrid(session, 'supplied', null, null, 2, 2);
    engine.misfitDefaultBounds(session, 'auto', null);
    expect(calls.misfit_grid).toEqual([
      [JSON.stringify(session), 'auto', '{"estimate_shared_bias":true}', JSON.stringify(BOX), 20, 30],
      [JSON.stringify(session), 'supplied', '{}', '', 2, 2],
    ]);
    expect(calls.misfit_default_bounds).toEqual([[JSON.stringify(session), 'auto', '{}']]);
  });

  it('names the export in an error, and is absent from a package without the exports', () => {
    const { module } = fake(new Error('x'));
    const engine = createWasmMisfit(module)!;
    expect(() => engine.misfitGrid(mockSession(0), 'auto', null, null, 10, 10)).toThrow(/^misfit_grid: misfit says no$/);
    expect(missingMisfitExports({ misfit_grid: () => 1 })).toEqual(['misfit_default_bounds']);
    expect(createWasmMisfit({ misfit_grid: () => 1 })).toBeNull();
  });

  it('is composed into the WASM engine, and survives memoisation', () => {
    const module: Record<string, unknown> = { version: () => '9.9.9' };
    for (const name of REQUIRED_EXPORTS) module[name] = () => ({});
    const without = inspectWasmModule(module);
    expect(without.status === 'ready' && without.engine.misfit).toBeFalsy();
    for (const name of MISFIT_EXPORTS) module[name] = () => ({ from: name });
    const load = inspectWasmModule(module);
    if (load.status !== 'ready') throw new Error('expected a ready engine');
    expect(load.engine.misfit).toBeTruthy();
    expect(memoEngine(load.engine).misfit).toBe(load.engine.misfit);
    expect(memoEngine(new MockEngine()).misfit).toBeTruthy();
  });
});

describe('the mock', () => {
  const mock: MisfitEngine = createMockMisfit(new MockEngine());

  it('has the contract shape, says it is a mock, and puts the minimum on the mock fix', () => {
    const session = mockSession(0);
    const g = mock.misfitGrid(session, 'supplied', null, null, 41, 51);
    expect(g.chi2).toBeInstanceOf(Float64Array);
    expect(g.chi2.length).toBe(41 * 51);
    expect(g.lat_deg).toHaveLength(41);
    expect(g.lon_deg).toHaveLength(51);
    expect(g.notes[0]).toBe(MOCK_MISFIT_NOTE);
    expect(g.levels.map((l) => l.name)).toEqual(['one_sigma', 'p95', 'three_sigma']);
    expect(g.levels[1]!.chi2).toBeCloseTo(g.min.chi2 + 5.991464547, 9);
    expect(g.unknowns).toBe(2);
    expect(g.solve_kind).toBe('unique');
    const fix = mockSolve(session, defaultSolveOptions());
    if (fix.kind !== 'unique') throw new Error('mock fix expected');
    expect(metres(g.min, fix.fix.position)).toBeLessThan(1);
    const d = mock.misfitDefaultBounds(session, 'supplied', null);
    expect(d.bounds).toEqual(g.bounds);
    expect(d.centred_on).toBe('fix');
  });

  it('profiles a shared bias out when asked, and reports it', () => {
    const g = mock.misfitGrid(mockSession(1), 'supplied', { estimate_shared_bias: true }, null, 21, 21);
    expect(g.unknowns).toBe(3);
    expect(g.levels[1]!.delta_chi2).toBeCloseTo(7.8147, 3);
    expect(typeof g.min.shared_bias_arcmin).toBe('number');
  });

  it('frames both candidates of two sights', () => {
    const session = mockSession(2);
    const d = mock.misfitDefaultBounds(session, 'supplied', null);
    const g = mock.misfitGrid(session, 'supplied', null, null, 60, 60);
    expect(g.solve_kind).toBe('ambiguous');
    expect(d.centred_on).toBe('candidates');
    expect(g.basins.filter((b) => b.inside_grid).length).toBeGreaterThanOrEqual(2);
  });

  it('refuses what the real engine refuses', () => {
    const session = mockSession(0);
    expect(() => mock.misfitGrid(session, 'supplied', null, { ...BOX, north_deg: 38 }, 10, 10)).toThrow(/north_deg/);
    expect(() => mock.misfitGrid(session, 'supplied', null, null, 1, 10)).toThrow(/n_lat/);
    expect(() => mock.misfitGrid({ ...session, observations: [] }, 'supplied', null, null, 10, 10)).toThrow(
      /no observations/,
    );
  });
});

// ---------------------------------------------------------------------------
// The real package, when one has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

interface Glue {
  initSync: (input: { module: BufferSource }) => unknown;
  init?: () => void;
  demos: () => { name: string; scenario: unknown }[];
  simulate: (scenarioJson: string) => { session: Session };
  solve: (sessionJson: string, optionsJson: string, mode: string) => { kind: string; fix?: { position: { lat_deg: number; lon_deg: number }; chi2: number } };
}

describe.skipIf(!hasPackage)('the built WebAssembly package (src/wasm-pkg)', () => {
  let glue: Glue;
  let engine: MisfitEngine | null = null;

  beforeAll(async () => {
    glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as Glue;
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    engine = createWasmMisfit(glue);
  });

  function demoSession(name: string): Session {
    const demo = glue.demos().find((d) => d.name === name)!;
    return glue.simulate(JSON.stringify(demo.scenario)).session;
  }

  it('maps a packaged demo with its minimum on the fix (needs a package with the misfit exports)', ({ skip }) => {
    if (!engine) {
      skip();
      return;
    }
    const session = demoSession('philadelphia-stars');
    const t = performance.now();
    const g: MisfitGrid = engine.misfitGrid(session, 'auto', null, null, 200, 200);
    const ms = performance.now() - t;
    console.log(`misfit_grid 200 x 200, 5 sights, in WebAssembly under node: ${ms.toFixed(1)} ms (with the solve)`);
    expect(g.chi2).toBeInstanceOf(Float64Array);
    expect(g.chi2.length).toBe(40_000);
    expect(g.solve_kind).toBe('unique');
    const fix = glue.solve(JSON.stringify(session), '{}', 'auto');
    expect(metres(g.min, fix.fix!.position)).toBeLessThan(0.05);
    expect(Math.abs(g.grid_min.lat_deg - fix.fix!.position.lat_deg)).toBeLessThanOrEqual(g.lat_step_deg);
    expect(g.levels[1]!.chi2).toBeCloseTo(g.min.chi2 + 5.991464547, 9);
    expect(g.min.shared_bias_arcmin).toBeNull();
    const d = engine.misfitDefaultBounds(session, 'auto', null);
    expect(d.bounds).toEqual(g.bounds);
    expect(() => engine!.misfitGrid(session, 'moon' as never, null, null, 10, 10)).toThrow(/^misfit_grid: unknown ephemeris_mode/);
  });

  it('shows the two-sight demo as two basins inside the 95 % level', ({ skip }) => {
    if (!engine) {
      skip();
      return;
    }
    const g = engine.misfitGrid(demoSession('two-sight-ambiguous'), 'auto', null, null, 120, 120);
    const inside = g.basins.filter((b) => b.well_determined && b.inside_grid && b.delta_chi2 <= g.levels[1]!.delta_chi2);
    expect(inside).toHaveLength(2);
  });
});
