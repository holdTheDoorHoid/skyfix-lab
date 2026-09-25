/**
 * The charts2 agent's charts against the real core (when a WebAssembly package has been
 * built, `npm run wasm`, and the tides-us pack is in public/data/packs): what the charts
 * compute themselves on top of the engines stays within what the page shows.
 *
 * - The tide readout under the cursor is read off the predicted 6-minute curve (tides-data.ts
 *   `heightAt`, `rateAt`: the cubic through the four nearest samples) instead of asking
 *   `tide_now` sixty times a second: its distance from the engine's own `tide_now` is
 *   measured at large and small tidal ranges, day and week (ACCURACY.md, "Charts").
 * - The Moon through the year is `sample_bodies`, one exact sample a day: it equals
 *   `sky_state` at the same instants within 1″ (a run takes DUT1 at its middle).
 * - The sun path's hour marks are the engine's samples; the bearings chart's days are
 *   `rise_set_azimuths`' days.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { isSunToolsEngine, isTidesEngine } from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmEngine } from '../../src/next/engine/wasm.js';
import type { Zone } from '../../src/next/time.js';
import { computeTides, heightAt, rateAt } from '../../src/next/charts/tides-data.js';
import { computeMoonYear } from '../../src/next/charts/moon-year-data.js';
import { computeBearings, computeSunPath } from '../../src/next/charts/sun-data.js';
import { localDay } from '../../src/next/charts/windows.js';

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const PACKS = resolve(import.meta.dirname, '../../public/data/packs');
const packFile = existsSync(PACKS) ? readdirSync(PACKS).find((f) => /^tides-us-[0-9a-f]{16}\.bin$/.test(f)) : undefined;
const glue = existsSync(GLUE_FILE) ? readFileSync(GLUE_FILE, 'utf8') : '';
const ready =
  existsSync(WASM_FILE) &&
  /export function tide_extremes\(/.test(glue) &&
  /export function sun_path\(/.test(glue) &&
  packFile !== undefined;

const OPTIONS = { horizon: 'standard', height_of_eye_m: 0 } as const;

describe.skipIf(!ready)('the charts on the real core', () => {
  let engine: WasmEngine;

  beforeAll(async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as {
      initSync: (input: { module: BufferSource }) => unknown;
      init?: () => void;
    };
    mod.initSync({ module: readFileSync(WASM_FILE) });
    mod.init?.();
    const load = inspectWasmModule(mod);
    if (load.status !== 'ready') throw new Error('the package lacks the explorer');
    engine = load.engine;
    engine.loadPack('tides-us', new Uint8Array(readFileSync(resolve(PACKS, packFile!))));
  });

  const places: { name: string; lat: number; lon: number; zone: Zone; bound: { day: number; week: number } }[] = [
    // Anchorage: one of the largest US ranges (about 9 m at springs).
    { name: 'Anchorage', lat: 61.2383, lon: -149.89, zone: { kind: 'iana', zone: 'America/Anchorage' }, bound: { day: 0.001, week: 0.001 } },
    { name: 'Boston', lat: 42.3548, lon: -71.0534, zone: { kind: 'iana', zone: 'America/New_York' }, bound: { day: 0.001, week: 0.001 } },
    { name: 'San Francisco', lat: 37.8107, lon: -122.4771, zone: { kind: 'iana', zone: 'America/Los_Angeles' }, bound: { day: 0.001, week: 0.001 } },
  ];

  for (const place of places) {
    it(`reads the tide at the cursor within millimetres of tide_now (${place.name})`, () => {
      expect(isTidesEngine(engine)).toBe(true);
      const day = localDay(place.zone, { year: 2026, month: 9, day: 24 });
      const observer = { lat_deg: place.lat, lon_deg: place.lon, height_m: 0 };
      for (const span of ['day', 'week'] as const) {
        const data = computeTides(engine, { observer, zone: place.zone, day, span, datum: '', stationId: null, options: OPTIONS });
        expect(data.curve?.method).toBe('harmonic');
        let worstH = 0;
        let worstR = 0;
        const n = span === 'day' ? 97 : 157;
        for (let k = 0; k < n; k += 1) {
          const t = data.window.start + ((k + 0.37) / n) * (data.window.end - data.window.start) * 0.999;
          const now = engine.tideNow(data.station.id, t, data.datum);
          worstH = Math.max(worstH, Math.abs(heightAt(data.curve!, t)! - now.height_m));
          worstR = Math.max(worstR, Math.abs(rateAt(data.curve!, t)! - now.rate_m_per_h));
        }
        // Printed for ACCURACY.md (vitest shows it with --reporter=verbose).
        console.log(`${place.name} ${data.station.id} ${span}: height ${(worstH * 1000).toFixed(2)} mm, rate ${(worstR * 100).toFixed(2)} cm/h`);
        expect(worstH).toBeLessThan(place.bound[span]);
        // The rate is shown to the centimetre an hour.
        expect(worstR).toBeLessThan(0.01);
      }
    }, 60_000);
  }

  it('draws the Moon through the year from exact samples: sky_state at the same instants, within 1″', () => {
    const zone: Zone = { kind: 'iana', zone: 'America/New_York' };
    const observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
    const data = computeMoonYear(engine, { observer, zone, year: 2026, hour: 21 });
    expect(data.days).toHaveLength(365);
    expect(data.missing).toBe(0);
    let worst = 0;
    for (const i of [0, 40, 67, 68, 150, 250, 306, 307, 364]) {
      const d = data.days[i]!;
      const moon = engine.skyState(observer, d.jd, ['Moon']).bodies[0]!;
      worst = Math.max(worst, Math.abs(d.alt - moon.alt_apparent_deg), Math.abs(d.az - moon.az_deg));
    }
    // A run of samples takes DUT1 at its middle (EXPLORER_API, set_dut1): under 1″ over a year.
    console.log(`Moon through the year against sky_state: ${(worst * 3600).toFixed(3)}″`);
    expect(worst * 3600).toBeLessThan(1);
  });

  it('marks the sun path’s hours on the engine’s samples and lays out the engine’s year of bearings', () => {
    expect(isSunToolsEngine(engine)).toBe(true);
    const zone: Zone = { kind: 'iana', zone: 'America/New_York' };
    const observer = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
    const path = computeSunPath(engine, { observer, zone, day: localDay(zone, { year: 2026, month: 6, day: 21 }), options: OPTIONS });
    expect(path.hours.map((m) => m.hour)).toEqual([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    const bearings = computeBearings(engine, { observer, year: 2026, offsetH: -5, options: OPTIONS });
    expect(bearings.days).toHaveLength(365);
    // The June solstice sunrise at Philadelphia: 57.9° (ACCURACY.md section 14's engine).
    expect(bearings.riseRange!.min).toBeCloseTo(57.9, 0);
    expect(bearings.setRange!.max).toBeCloseTo(302.1, 0);
  });
});
