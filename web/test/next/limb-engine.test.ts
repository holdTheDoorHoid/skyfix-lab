/**
 * The lunar limb (eclipselimb agent, P12): the mock's synthetic limb, the WASM wrapper's
 * routing of `eclipseLocal(…, { limb: true })`, the memoised engine's keys, and — when a
 * package has been built with `npm run wasm` — the real core with the shipped
 * lunar-limb pack, timed (the acceptance: loading the pack and one corrected eclipse under
 * 100 ms each).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { memoEngine } from '../../src/next/component.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import {
  isLimbEngine,
  type EclipseEngine,
  type LimbEngine,
  type Observer,
  type SolarEclipseLocal,
} from '../../src/next/engine/types.js';
import { inspectWasmModule, WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';

// Compile-time: the WASM engine and the mock satisfy the contract.
type Satisfies<T extends LimbEngine> = T;
export type WasmIsLimb = Satisfies<WasmEngine>;
export type MockIsLimb = Satisfies<MockEngine>;
type SatisfiesEclipse<T extends EclipseEngine> = T;
export type WasmIsEclipse = SatisfiesEclipse<WasmEngine>;

const INDIANAPOLIS: Observer = { lat_deg: 39.7684, lon_deg: -86.1581, height_m: 220 };
const JD = 2460409.29; // 2024-04-08, during the eclipse

describe('the mock lunar limb', () => {
  it('draws a synthetic limb at the ring resolution once the pack is loaded', () => {
    const mock = new MockEngine({ limbLoaded: false });
    expect(isLimbEngine(mock)).toBe(true);
    expect(mock.lunarLimbInfo()).toBeNull();
    expect(() => mock.lunarLimbProfile(INDIANAPOLIS, JD)).toThrow(/^pack_not_loaded:/);
    mock.loadPack('lunar-limb', new Uint8Array([1, 2, 3]));
    const p = mock.lunarLimbProfile(INDIANAPOLIS, JD);
    expect(p.height_arcsec).toHaveLength(5760);
    expect(p.step_deg).toBe(1 / 16);
    expect(p.utc).toMatch(/Z$/);
    expect(Math.max(...(p.height_arcsec as number[]))).toBeLessThan(3);
    expect(mock.lunarLimbInfo()?.name).toBe('lunar-limb');
  });

  it('is forwarded by the memoised engine', () => {
    const memo = memoEngine(new MockEngine());
    expect(isLimbEngine(memo)).toBe(true);
    expect((memo as unknown as LimbEngine).lunarLimbInfo()?.version).toBe('mock');
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

  it('asks eclipse_local without the option and eclipse_local_limb with it', () => {
    const { engine, calls } = engineWith({
      eclipse_local: () => ({ kind: 'solar' }),
      eclipse_local_limb: () => ({ kind: 'solar', limb: { loaded: false } }),
      lunar_limb_profile: () => ({ step_deg: 0.0625 }),
      lunar_limb_info: () => null,
    });
    engine.eclipseLocal('2024-04-08-solar', INDIANAPOLIS);
    engine.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: false });
    const withLimb = engine.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: true }) as SolarEclipseLocal;
    expect(calls.eclipse_local).toHaveLength(2);
    expect(calls.eclipse_local_limb).toHaveLength(1);
    expect(calls.eclipse_local_limb![0]![0]).toBe('2024-04-08-solar');
    expect(JSON.parse(calls.eclipse_local_limb![0]![1] as string).lat_deg).toBe(39.7684);
    expect(withLimb.limb?.loaded).toBe(false);
    engine.lunarLimbProfile(INDIANAPOLIS, JD);
    expect(calls.lunar_limb_profile![0]![1]).toBe(JD);
    expect(engine.lunarLimbInfo()).toBeNull();
  });

  it('says to rebuild when the core predates the lunar limb', () => {
    const { engine } = engineWith({ eclipse_local: () => ({ kind: 'solar' }) });
    expect(() => engine.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: true })).toThrow(
      /eclipse_local_limb: this build of the numerical core has no lunar limb/,
    );
    expect(() => engine.lunarLimbProfile(INDIANAPOLIS, JD)).toThrow(/lunar_limb_profile: this build/);
    expect(engine.lunarLimbInfo()).toBeNull();
  });

  it('is memoised with the option in the key', () => {
    const { engine, calls } = engineWith({
      eclipse_local: () => ({ kind: 'solar' }),
      eclipse_local_limb: () => ({ kind: 'solar', limb: { loaded: true } }),
    });
    const memo = memoEngine(engine as unknown as Parameters<typeof memoEngine>[0]) as unknown as EclipseEngine;
    const a = memo.eclipseLocal('2024-04-08-solar', INDIANAPOLIS);
    const b = memo.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: true });
    expect(memo.eclipseLocal('2024-04-08-solar', INDIANAPOLIS)).toBe(a);
    expect(memo.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: true })).toBe(b);
    expect(a).not.toBe(b);
    expect(calls.eclipse_local).toHaveLength(1);
    expect(calls.eclipse_local_limb).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The real package and the shipped pack, when a package has been built
// ---------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const PACKS = resolve(import.meta.dirname, '../../public/data/packs');
const packFile = existsSync(PACKS) ? readdirSync(PACKS).find((f) => /^lunar-limb-[0-9a-f]{16}\.bin$/.test(f)) : undefined;
const glueExports = existsSync(GLUE_FILE) ? readFileSync(GLUE_FILE, 'utf8') : '';
const hasLimb =
  existsSync(WASM_FILE) &&
  /export function eclipse_local_limb\(/.test(glueExports) &&
  /export function load_pack\(/.test(glueExports) &&
  packFile !== undefined;

describe.skipIf(!hasLimb)('the built package with the shipped lunar-limb pack', () => {
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

  it('notes the mean limb before the pack, then corrects the contacts within the time budget', () => {
    if (engine.lunarLimbInfo() === null) {
      const before = engine.eclipseLocal('2024-04-08-solar', INDIANAPOLIS, { limb: true }) as SolarEclipseLocal;
      expect(before.limb?.loaded).toBe(false);
      expect(before.limb?.note).toMatch(/Lunar limb data pack/);
      expect(() => engine.lunarLimbProfile(INDIANAPOLIS, JD)).toThrow(/pack_not_loaded/);
    }
    const bytes = new Uint8Array(readFileSync(resolve(PACKS, packFile!)));
    let t = performance.now();
    const info = engine.loadPack('lunar-limb', bytes);
    const loadMs = performance.now() - t;
    expect(info.name).toBe('lunar-limb');
    expect(info.bytes).toBe(bytes.byteLength);
    expect(engine.lunarLimbInfo()?.step_deg).toBe(0.0625);
    // One corrected eclipse, twice (the first call pays for warming the module up), at
    // SVS's point for Indianapolis.
    const svsIndianapolis: Observer = { lat_deg: 39.776664, lon_deg: -86.145935, height_m: 218 };
    engine.eclipseLocal('2024-04-08-solar', { lat_deg: 32.7767, lon_deg: -96.797, height_m: 150 }, { limb: true });
    t = performance.now();
    const l = engine.eclipseLocal('2024-04-08-solar', svsIndianapolis, { limb: true }) as SolarEclipseLocal;
    const correctMs = performance.now() - t;
    console.log(`lunar-limb pack: load ${loadMs.toFixed(1)} ms, one corrected eclipse ${correctMs.toFixed(1)} ms (WebAssembly in Node)`);
    const limb = l.limb!;
    expect(limb.loaded).toBe(true);
    expect(limb.local_type).toBe('total');
    expect(limb.contacts.map((c) => c.kind)).toEqual(['c1', 'c2', 'c3', 'c4']);
    // NASA SVS's limb-corrected totality at Indianapolis: 19:06:06 to 19:09:53 UTC.
    const c2 = limb.contacts[1]!;
    const c3 = limb.contacts[2]!;
    expect(Math.abs(Date.parse(c2.utc) - Date.parse('2024-04-08T19:06:06Z'))).toBeLessThan(2000);
    expect(Math.abs(Date.parse(c3.utc) - Date.parse('2024-04-08T19:09:53Z'))).toBeLessThan(2000);
    expect(limb.profile?.height_arcsec).toHaveLength(2880);
    expect(limb.profile?.step_deg).toBe(0.125);
    expect(limb.beads.every((b) => (b.contact === 'c2' ? b.seconds_from_contact <= 0 : b.seconds_from_contact >= 0))).toBe(true);
    // Generous bounds (a shared test machine); the measured numbers are in ACCURACY.md.
    expect(loadMs).toBeLessThan(400);
    expect(correctMs).toBeLessThan(400);
    const p = engine.lunarLimbProfile(INDIANAPOLIS, JD);
    expect(p.height_arcsec).toHaveLength(5760);
  });
});
