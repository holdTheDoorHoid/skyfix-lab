/**
 * verify2: fast playback asks the engine for no phases in the Selected card, so the Moon's
 * waxing or waning comes from its bright limb instead (panel/selected.ts `moonStory`). The
 * rule must agree with the phases wherever both exist, on the mock and on the built core.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { ExplorerEngine } from '../../src/next/engine/types.js';
import { inspectWasmModule } from '../../src/next/engine/wasm.js';
import { moonStory } from '../../src/next/panel/selected.js';

const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const T0 = 2_461_041.5; // 2026-01-01

/** Every 7.3 hours for a year: the phases' answer against the bright limb's. */
function disagreements(engine: ExplorerEngine): { n: number; bad: string[] } {
  const bad: string[] = [];
  let n = 0;
  const phases = engine.moonPhases(T0 - 40, T0 + 400);
  for (let jd = T0; jd < T0 + 365; jd += 0.3041) {
    const moon = engine.skyState(PHILLY, jd, ['Moon']).bodies[0]!;
    const byPhases = moonStory(phases, jd);
    const byLimb = moonStory([], jd, moon.bright_limb_angle_deg);
    n += 1;
    // Within an hour of new or full Moon either answer is fair.
    const near = phases.some((p) => (p.kind === 'new_moon' || p.kind === 'full_moon') && Math.abs(p.jd_utc - jd) < 1 / 24);
    if (!near && byPhases.waxing !== byLimb.waxing) bad.push(`${jd.toFixed(3)}: phases ${byPhases.waxing}, limb ${byLimb.waxing} (${moon.bright_limb_angle_deg?.toFixed(1)}°)`);
  }
  return { n, bad };
}

describe('the Moon without its phases, during fast playback (verify2)', () => {
  it('reads waxing from the bright limb, and leaves out the age and the next phase', () => {
    expect(moonStory([], T0, 250).waxing).toBe(true); // the bright limb toward the west: the Sun is west
    expect(moonStory([], T0, 80).waxing).toBe(false);
    expect(moonStory([], T0, 250).age).toBeNull();
    expect(moonStory([], T0, 250).next).toBeNull();
  });

  it('agrees with the phases for a year on the mock', () => {
    const { n, bad } = disagreements(new MockEngine({ syntheticStars: 0 }));
    expect(n).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });

  const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
  const has = existsSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) && existsSync(resolve(PKG, 'skyfix_wasm.js'));
  it.skipIf(!has)('agrees with the phases for a year on the built core', async ({ skip }) => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(resolve(PKG, 'skyfix_wasm.js')).href)) as { initSync: (i: { module: BufferSource }) => unknown };
    glue.initSync({ module: readFileSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) });
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready') return skip();
    const { n, bad } = disagreements(load.engine);
    expect(n).toBeGreaterThan(1000);
    expect(bad).toEqual([]);
  });
});
