/**
 * verify2: an occultation of a planet times its centre (EXPLORER_API "occultations"); the
 * sentence says how long the disc takes to go in and to come out, and that the times given
 * are the centre's, halfway through. Checked on the built core against Skyfield
 * (tools/verify2/occ_planet_disc.py: Jupiter from Mumbai, 2019-11-28, 51.7 + 52.1 s in and
 * 45.7 + 46.2 s out).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isMoonDetailEngine, type Occultation, type OccultationContact } from '../../src/next/engine/types.js';
import { inspectWasmModule } from '../../src/next/engine/wasm.js';
import { occultationItem } from '../../src/next/events/moon-model.js';
import { screenWords } from '../../src/next/events/items.js';
import { createExplorerStore } from '../../src/next/state.js';

const W = screenWords(createExplorerStore({ storage: null }).get());

function contact(over: Partial<OccultationContact>): OccultationContact {
  return {
    kind: 'disappearance', jd_utc: 2458815.983, utc: '2019-11-28T11:35:24.744Z', position_angle_deg: 60, vertex_angle_deg: 60,
    cusp_angle_deg: 30, cusp: 'N', limb: 'dark', moon_alt_deg: 30, moon_az_deg: 200, moon_above_horizon: true, sun_alt_deg: 20,
    sky_phase: 'day', crossing_s: 103.7, ...over,
  };
}

describe('an occultation of a planet (verify2)', () => {
  it('says how long the disc takes to go in and to come out, and that the times are its centre’s', () => {
    const o = {
      body: 'Jupiter', kind: 'planet', designation: null, hr: null, magnitude: -1.9, navigational: true, occulted: true, graze: false,
      disappearance: contact({}),
      reappearance: contact({ kind: 'reappearance', jd_utc: 2458816.026, utc: '2019-11-28T12:37:23.063Z', limb: 'bright', crossing_s: 91.9 }),
      closest: { jd_utc: 2458816.0, utc: '', limb_distance_arcmin: -6.4, position_angle_deg: 0, moon_alt_deg: 30 },
      duration_s: 3718, body_semidiameter_arcsec: 16.07, moon_illuminated_fraction: 0.05, waxing: true, visible: true,
    } as Occultation;
    expect(occultationItem(o, W).sentence).toContain('The planet’s disc takes 1 min 44 s to disappear and 1 min 32 s to reappear; the times are those of its centre, halfway through.');
    // A star has no disc: no such sentence.
    const star = { ...o, body: 'Regulus', kind: 'star', body_semidiameter_arcsec: 0, disappearance: contact({ crossing_s: 0 }), reappearance: contact({ kind: 'reappearance', crossing_s: 0 }) } as Occultation;
    expect(occultationItem(star, W).sentence).not.toMatch(/disc takes/);
  });

  const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
  const has = existsSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) && existsSync(resolve(PKG, 'skyfix_wasm.js'));
  it.skipIf(!has)('takes the crossing times from the engine, which match Skyfield to 0.1 s (Jupiter, Mumbai, 2019-11-28)', async ({ skip }) => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(resolve(PKG, 'skyfix_wasm.js')).href)) as { initSync: (i: { module: BufferSource }) => unknown };
    glue.initSync({ module: readFileSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) });
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready' || !isMoonDetailEngine(load.engine)) return skip();
    const r = load.engine.occultations({ lat_deg: 19.076, lon_deg: 72.8777, height_m: 10 }, 2458815.5, 2458816.5, { stars: false });
    const jupiter = r.events.find((e) => e.body === 'Jupiter')!;
    // Skyfield: first touch to fully hidden 51.7 + 52.1 s; out 45.7 + 46.2 s.
    expect(Math.abs(jupiter.disappearance!.crossing_s - 103.8)).toBeLessThan(0.5);
    expect(Math.abs(jupiter.reappearance!.crossing_s - 91.9)).toBeLessThan(0.5);
    expect(occultationItem(jupiter, W).sentence).toMatch(/disc takes 1 min 4[34] s to disappear and 1 min 3[12] s to reappear; the times are those of its centre/);
  });
});
