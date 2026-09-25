/**
 * verify2: Settings → Sights → Air (polish2) reaches every refraction the same way. On the
 * built core, for 1030 hPa and −10 °C against the standard 1010 hPa and 10 °C, with the Sun
 * near 5° up: the height the page shows (sky_state, through `engineObserver`), the predicted
 * sextant reading (predict_sextant, as the Selected card asks it) and the almanac's
 * additional refraction correction (almanac_altitude_tables, Table A4's exact row) move by
 * the same amount.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAlmanacTablesEngine, type Observer } from '../../src/next/engine/types.js';
import { inspectWasmModule } from '../../src/next/engine/wasm.js';
import { createExplorerStore, engineObserver } from '../../src/next/state.js';

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const has = existsSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) && existsSync(resolve(PKG, 'skyfix_wasm.js'));
const AIR = { pressure_hpa: 1030, temperature_c: -10 };

describe('the air from Settings (verify2)', () => {
  it('goes into the engine observer only when it is not the standard air', () => {
    const store = createExplorerStore({ storage: null });
    const std = engineObserver(store.get());
    expect(std.pressure_hpa).toBeUndefined();
    store.patch({ settings: AIR });
    const o = engineObserver(store.get());
    expect(o.pressure_hpa).toBe(1030);
    expect(o.temperature_c).toBe(-10);
  });

  it.skipIf(!has)('moves the height shown, the predicted reading and the almanac’s A4 correction alike', async ({ skip }) => {
    const glue = (await import(/* @vite-ignore */ pathToFileURL(resolve(PKG, 'skyfix_wasm.js')).href)) as { initSync: (i: { module: BufferSource }) => unknown };
    glue.initSync({ module: readFileSync(resolve(PKG, 'skyfix_wasm_bg.wasm')) });
    const load = inspectWasmModule(glue);
    if (load.status !== 'ready' || !load.engine.nav || !isAlmanacTablesEngine(load.engine)) return skip();
    const engine = load.engine;
    const nav = engine.nav!;
    const here: Observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
    // The Sun about 5° up on a June morning in Philadelphia (standard air).
    let jd = 2_461_212.9; // 2026-06-20 09:36 UTC, before sunrise there
    const altStd = (t: number): number => engine.skyState(here, t, ['Sun']).bodies[0]!.alt_apparent_deg;
    while (altStd(jd) < 5) jd += 1 / 1440;
    const std = altStd(jd);
    const air = engine.skyState({ ...here, ...AIR }, jd, ['Sun']).bodies[0]!.alt_apparent_deg;
    const shown = (air - std) * 60;
    // Denser air bends light more: about 10 % more than the standard 9.9′ at 5°.
    expect(shown).toBeGreaterThan(0.7);
    expect(shown).toBeLessThan(1.2);
    const instrument = { index_correction_arcmin: 0, horizon: 'sea' as const };
    const eye = { lat_deg: here.lat_deg, lon_deg: here.lon_deg, height_of_eye_m: 0 };
    const hsStd = nav.predictSextant(eye, instrument, 'Sun', 'center', jd).hs_deg;
    const hsAir = nav.predictSextant({ ...eye, ...AIR }, instrument, 'Sun', 'center', jd).hs_deg;
    const predicted = (hsAir - hsStd) * 60;
    // Table A4 for the same air, interpolated to the Sun's height: a correction to add to the
    // observed altitude, so the opposite of the extra bending.
    const a4 = engine.almanacAltitudeTables(AIR).additional;
    const rows = a4.rows;
    const exact = a4.conditions!.corrections;
    let i = rows.findIndex((r) => r.alt_deg > std);
    if (i < 1) i = 1;
    const f = (std - rows[i - 1]!.alt_deg) / (rows[i]!.alt_deg - rows[i - 1]!.alt_deg);
    const table = exact[i - 1]!.arcmin + f * (exact[i]!.arcmin - exact[i - 1]!.arcmin);
    console.info(`air 1030 hPa −10 °C at ${std.toFixed(2)}°: height shown +${shown.toFixed(3)}′, predicted Hs +${predicted.toFixed(3)}′, A4 ${table.toFixed(3)}′`);
    // The predicted reading takes refraction at the apparent height it predicts, which the
    // denser air raises by the same 0.9′, where refraction is 0.025′ less (its slope at 5° is
    // −1.6′ a degree): 0.915′ against 0.944′. The same air, a convention a navigator's tables
    // share; well under the 0.1′ shown.
    expect(Math.abs(predicted - shown)).toBeLessThan(0.05);
    expect(predicted).toBeGreaterThan(0.7);
    // Bennett's refraction (the tables') against the engine's: a few hundredths at 5°.
    expect(Math.abs(table + shown)).toBeLessThan(0.1);
  });
});
