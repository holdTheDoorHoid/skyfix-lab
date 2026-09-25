/**
 * Coverage tiers (EXPLORER_API "`explorer_coverage()` — tiers" and "coverage tiers as
 * built", deeptime agent): the mock's tiers and `tierAt`, the WASM engine's `tierAt`
 * pass-through, and the real package's answers when one is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { LABELLED_END_UTC, LABELLED_START_UTC, VALIDATED_END_UTC, VALIDATED_START_UTC } from '../../src/next/engine/mock/coverage.js';
import { isCoverageTierEngine } from '../../src/next/engine/types.js';
import { WasmEngine, inspectWasmModule } from '../../src/next/engine/wasm.js';
import { jdFromIso } from '../../src/next/time.js';

const jd = (iso: string): number => jdFromIso(iso)!;

describe('the mock engine', () => {
  const engine = new MockEngine({ syntheticStars: 0 });

  it('is a coverage-tier engine whose validated tier is its own window', () => {
    expect(isCoverageTierEngine(engine)).toBe(true);
    const c = engine.coverage();
    expect(c.validated_start_utc).toBe(c.start_utc);
    expect(c.validated_end_utc).toBe(c.end_utc);
    expect(c.packs_loaded).toEqual([]);
    for (const g of c.groups) {
      expect(g.tiers).toEqual([
        { tier: 'validated', start_utc: c.start_utc, end_utc: c.end_utc, accuracy_arcmin: g.accuracy_arcmin },
      ]);
    }
  });

  it('never promises a date its formulas refuse', () => {
    expect(engine.tierAt(jd('2026-10-01T01:30:00Z'))).toBe('validated');
    expect(engine.tierAt(jd('1990-01-01T00:00:00Z'))).toBe('validated');
    expect(engine.tierAt(jd('1989-12-31T23:59:59Z'))).toBe('outside');
    expect(engine.tierAt(jd('1600-01-01T00:00:00Z'))).toBe('outside');
    expect(engine.tierAt(Number.NaN)).toBe('outside');
    expect(engine.timeInfo(jd('2061-06-01T00:00:00Z')).tier).toBe('outside');
    expect(engine.timeInfo(jd('2026-10-01T00:00:00Z')).tier).toBe('validated');
  });

  it('lists a loaded pack', () => {
    const e = new MockEngine({ syntheticStars: 0 });
    e.loadPack('tides-us', new Uint8Array(4));
    expect(e.coverage().packs_loaded).toEqual(['tides-us']);
  });

  it('exports the core tiers for the interface', () => {
    expect([VALIDATED_START_UTC, VALIDATED_END_UTC]).toEqual(['1550-01-01T00:00:00Z', '2650-01-22T00:00:00Z']);
    expect([LABELLED_START_UTC, LABELLED_END_UTC]).toEqual(['-2000-01-01T00:00:00Z', '3000-12-31T23:59:59Z']);
    expect(jdFromIso(LABELLED_START_UTC)).toBe(990_574.5);
  });
});

describe('the WASM engine', () => {
  it('passes tier_at through, and says to rebuild when the export is missing', () => {
    const calls: number[] = [];
    const fake = { tier_at: (j: number) => (calls.push(j), j > 2_400_000 ? 'validated' : 'labelled') };
    const engine = Object.create(WasmEngine.prototype) as WasmEngine;
    Object.assign(engine, { x: fake });
    // `call` is the engine's error wrapper; the fake needs none.
    (engine as unknown as { call: (n: string, f: () => unknown) => unknown }).call = (_n, f) => f();
    expect(engine.tierAt(2_461_314.5)).toBe('validated');
    expect(engine.tierAt(1_507_900)).toBe('labelled');
    expect(calls).toEqual([2_461_314.5, 1_507_900]);
    const old = Object.create(WasmEngine.prototype) as WasmEngine;
    Object.assign(old, { x: {} });
    expect(() => old.tierAt(2_461_314.5)).toThrow(/tier_at.*npm run wasm/);
  });
});

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const hasPackage = existsSync(WASM_FILE) && existsSync(GLUE_FILE);

describe.skipIf(!hasPackage)('the built WebAssembly package (src/wasm-pkg)', () => {
  it('reports both tiers and answers tier_at (needs a package built with tier_at)', async ({ skip }) => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
      tier_at?: unknown;
    };
    glue.initSync({ module: readFileSync(WASM_FILE) });
    glue.init?.();
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready' || typeof glue.tier_at !== 'function') {
      skip();
      return;
    }
    const engine = load.engine;
    const c = engine.coverage();
    expect(c.start_utc).toBe('-2000-01-01T00:00:00Z');
    expect(c.validated_start_utc).toBe('1550-01-01T00:00:00Z');
    expect(c.groups.every((g) => g.tiers?.length === 2 && g.tiers[1]!.tier === 'labelled')).toBe(true);
    expect(engine.tierAt(jd('2026-10-01T01:30:00Z'))).toBe('validated');
    expect(engine.tierAt(jd('-0584-05-28T12:00:00Z'))).toBe('labelled');
    expect(engine.tierAt(jd('3001-06-01T00:00:00Z'))).toBe('outside');
  });
});
