/**
 * The ± chip follows each quantity's real sensitivity to ΔT (chip2; VERIFICATION_2 finding
 * V18, EXPANSION_PLAN §3 "V18: adopted"; CONVENTIONS 15.1-15.2; web/src/next/time/chip.ts):
 *
 * - the clock and an instant of the bodies' own motion (a phase, a season, an eclipse): σ;
 * - a time set by the Earth's turning (rise, set, transit, twilight): σ × k, k the body's
 *   rate in right ascension over the Earth's rotation relative to it, shown from 1 s;
 * - a place at the time shown: the body's angular speed × σ, in arcminutes, at a far date
 *   when over 0.1′; stars and deep-sky objects never.
 *
 * One test per branch on the mock engine (its positions cover 1990-2060, so a far σ is given
 * to it through `timeInfo` while its bodies move as they do in 2026), then the real core at
 * the verifier's two dates, 28 May 585 BC and 1 June 2000 BC (proleptic Gregorian −0584-05-28
 * and −1999-06-01, Philadelphia), against `time_info` and the bodies' rates worked out here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { CoverageTier, ExplorerEngine, SkyEvent, TimeInfo } from '../../src/next/engine/types.js';
import { inspectWasmModule, type WasmEngine } from '../../src/next/engine/wasm.js';
import { jdFromIso } from '../../src/next/time.js';
import {
  arcminText,
  bodyRates,
  chipOf,
  CLOCK,
  dtChip,
  farDate,
  INSTANT,
  position,
  ratesBetween,
  sigmaText,
  turning,
  TURNING_K_BOUND,
  uncertaintyText,
  uncertaintyTip,
  withUncertainty,
  type BodyRates,
  type ChipInfo,
} from '../../src/next/time/chip.js';

const jd = (iso: string): number => {
  const v = jdFromIso(iso);
  if (v === null) throw new Error(iso);
  return v;
};

const Y2026 = jd('2026-09-24T16:00:00Z');
const info = (sigma: number, tier: CoverageTier = 'labelled'): ChipInfo => ({ delta_t_sigma_s: sigma, tier });

/**
 * The mock engine with the σ and tier of a far date: its bodies still move as they do in
 * 2026 (the mock places them only in 1990-2060). Counts `sky_state` calls. Its coverage report
 * is one object, as the page's memoised engine keeps it (a new report forgets what is kept).
 */
function farMock(sigma: number, tier: CoverageTier = 'labelled'): { engine: ExplorerEngine; calls: () => number } {
  const mock = new MockEngine({ syntheticStars: 0 });
  let n = 0;
  const engine = Object.create(mock) as MockEngine;
  const coverage = mock.coverage();
  Object.assign(engine, {
    coverage: () => coverage,
    timeInfo: (j: number): TimeInfo => ({ ...mock.timeInfo(j), delta_t_sigma_s: sigma, tier }),
    skyState: (...a: Parameters<MockEngine['skyState']>) => {
      n += 1;
      return mock.skyState(...a);
    },
  });
  return { engine: engine as unknown as ExplorerEngine, calls: () => n };
}

const mock = new MockEngine({ syntheticStars: 0 });
const sun = bodyRates(mock, 'Sun', Y2026)!;
const moon = bodyRates(mock, 'Moon', Y2026)!;
const rates = (r: Record<string, BodyRates | null>) => (body: string) => r[body] ?? null;

describe('the bodies’ rates, from the engine’s places an hour apart at the middle of each quarter day', () => {
  it('the Sun about 1° a day in right ascension and 0.04″ a second; the Moon about 13° and 0.55″', () => {
    expect(sun.ra_deg_per_day).toBeGreaterThan(0.85);
    expect(sun.ra_deg_per_day).toBeLessThan(1.15);
    expect(sun.arcsec_per_s).toBeGreaterThan(0.035);
    expect(sun.arcsec_per_s).toBeLessThan(0.047);
    expect(moon.ra_deg_per_day).toBeGreaterThan(10);
    expect(moon.ra_deg_per_day).toBeLessThan(18);
    expect(moon.arcsec_per_s).toBeGreaterThan(0.45);
    expect(moon.arcsec_per_s).toBeLessThan(0.7);
    // The GHA turns by the Earth's rotation less the body's own motion: θ̇ − α̇.
    expect(sun.gha_deg_per_day + sun.ra_deg_per_day).toBeCloseTo(360.9856, 1);
    expect(moon.gha_deg_per_day + moon.ra_deg_per_day).toBeCloseTo(360.9856, 1);
    // k = |α̇| / (θ̇ − α̇): the Sun's share about 0.27 %, the Moon's about 3.7 %.
    expect(sun.k).toBeCloseTo(sun.ra_deg_per_day / sun.gha_deg_per_day, 12);
    expect(sun.k).toBeGreaterThan(0.0023);
    expect(sun.k).toBeLessThan(0.0032);
    expect(moon.k).toBeGreaterThan(0.029);
    expect(moon.k).toBeLessThan(0.052);
  });

  it('a star, a deep-sky object or any name not the Sun, the Moon or a planet is fixed on the sky', () => {
    for (const name of ['Sirius', 'Polaris', 'M31', 'Galactic centre', '']) {
      const r = bodyRates(mock, name, Y2026)!;
      expect(r.k).toBe(0);
      expect(r.arcsec_per_s).toBe(0);
    }
  });

  it('works across 0h of right ascension and gives null where the engine places nothing', () => {
    const r = ratesBetween({ ra: 359.9, dec: 0, gha: 350 }, { ra: 0.1, dec: 0.1, gha: 5 }, 1 / 24);
    expect(r.ra_deg_per_day).toBeCloseTo(4.8, 9);
    expect(r.gha_deg_per_day).toBeCloseTo(360, 9);
    expect(bodyRates(mock, 'Moon', jd('2500-06-01T12:00:00Z'))).toBeNull();
    expect(bodyRates({ coverage: () => ({}) } as unknown as ExplorerEngine, 'Moon', Y2026)).toBeNull();
  });
});

describe('the clock and the instants of the bodies’ own motion carry the whole σ', () => {
  it('as the clock did before: shown above 30 s, and always in the labelled tier', () => {
    for (const subject of [CLOCK, INSTANT]) {
      expect(chipOf(info(158.4), subject)).toMatchObject({ shown: true, text: '±3 min', value: 158.4, rate: 1, unit: 's' });
      expect(chipOf(info(3725.7), subject)?.text).toBe('±1 h');
      expect(chipOf(info(15, 'labelled'), subject)?.text).toBe('±15 s');
      expect(chipOf(info(15, 'validated'), subject)?.shown).toBe(false);
      expect(chipOf(info(31, 'validated'), subject)?.text).toBe('±31 s');
    }
    expect(chipOf(null, INSTANT)).toBeNull();
    expect(chipOf({ delta_t_sigma_s: Number.NaN, tier: 'labelled' }, INSTANT)).toBeNull();
    // Their words: the clock's says what σ moves and what it does not; an instant's, all of it.
    expect(uncertaintyTip(chipOf(info(158.4), CLOCK))).toMatch(/^The Earth’s rotation at this date is known only to ±3 min .*rising, setting or twilight time carries only the share.*Moon’s place at the time shown/);
    expect(uncertaintyTip(chipOf(info(158.4), INSTANT))).toMatch(/set by the bodies’ own motion, so its clock time carries all of it\. These years are an estimate/);
  });

  it('asks the engine for no rate', () => {
    const { engine, calls } = farMock(3725.7);
    expect(dtChip(engine, Y2026, INSTANT)?.text).toBe('±1 h');
    expect(dtChip(engine, Y2026, CLOCK)?.text).toBe('±1 h');
    expect(calls()).toBe(0);
  });
});

describe('a time set by the Earth’s turning carries the body’s share of σ, from 1 s', () => {
  it('the Sun’s at 585 BC is under a second: no chip; at 2000 BC about 10 s', () => {
    const at585 = chipOf(info(158.4), turning('Sun'), rates({ Sun: sun }))!;
    expect(at585.value!).toBeCloseTo(sun.k * 158.4, 12);
    expect(at585.value!).toBeGreaterThan(0.3);
    expect(at585.value!).toBeLessThan(0.5);
    expect(at585.shown).toBe(false);
    expect(withUncertainty('05:31', at585)).toBe('05:31');
    const at2000 = chipOf(info(3725.7), turning('Sun'), rates({ Sun: sun }))!;
    expect(at2000.shown).toBe(true);
    expect(at2000.value!).toBeGreaterThan(8);
    expect(at2000.value!).toBeLessThan(12);
    expect(at2000.text).toBe(sigmaText(sun.k * 3725.7));
    expect(at2000.body).toBe('Sun');
    expect(at2000.tip).toMatch(/set by the Earth’s turning, which the clock follows, so only the Sun’s own motion across the sky \(0\.\d\d % of the sky’s turning\) moves it, by about \d+ s\. These years are an estimate/);
  });

  it('the Moon’s at 585 BC a few seconds, at 2000 BC about two minutes', () => {
    const at585 = chipOf(info(158.4), turning('Moon'), rates({ Moon: moon }))!;
    expect(at585.shown).toBe(true);
    expect(at585.value!).toBeCloseTo(moon.k * 158.4, 12);
    expect(at585.value!).toBeGreaterThan(4);
    expect(at585.value!).toBeLessThan(8.5);
    expect(at585.text).toMatch(/^±\d s$/);
    const at2000 = chipOf(info(3725.7), turning('Moon'), rates({ Moon: moon }))!;
    expect(at2000.text).toMatch(/^±[23] min$/);
    // 1 s is the line: just under hides, 1 s shows.
    expect(chipOf(info(0.99 / moon.k), turning('Moon'), rates({ Moon: moon }))!.shown).toBe(false);
    expect(chipOf(info(1.0001 / moon.k), turning('Moon'), rates({ Moon: moon }))!).toMatchObject({ shown: true, text: '±1 s' });
    // Shown in the validated tier too, once it reaches a second (2100: σ about 32 s).
    expect(chipOf(info(32, 'validated'), turning('Moon'), rates({ Moon: moon }))!.shown).toBe(true);
  });

  it('several bodies: the fastest; stars and deep-sky objects add nothing', () => {
    const both = chipOf(info(3725.7), turning('Saturn', 'Sun'), rates({ Sun: sun, Saturn: { ...sun, k: sun.k / 10 } }))!;
    expect(both.body).toBe('Sun');
    expect(both.value!).toBeCloseTo(sun.k * 3725.7, 9);
    const moonSun = chipOf(info(3725.7), turning('Moon', 'Sun'), rates({ Sun: sun, Moon: moon }))!;
    expect(moonSun.body).toBe('Moon');
    for (const fixed of [turning(), turning('Sirius'), turning('M31', 'Polaris')]) {
      expect(chipOf(info(3725.7), fixed)).toMatchObject({ shown: false, value: 0, rate: 0 });
    }
  });

  it('a body the engine cannot place: the whole σ, as before the rule', () => {
    const c = chipOf(info(158.4), turning('Moon'), () => null)!;
    expect(c).toMatchObject({ shown: true, text: '±3 min', rate: null });
    expect(c.tip).toMatch(/could not be worked out here, so it is shown whole/);
  });

  it('asks for no rate while no body could reach a second (σ under 10 s), and remembers the quarter day', () => {
    const quiet = farMock(1 / TURNING_K_BOUND - 0.01, 'validated');
    expect(dtChip(quiet.engine, Y2026, turning('Moon'))).toMatchObject({ shown: false, value: null });
    expect(quiet.calls()).toBe(0);
    const far = farMock(158.4);
    const t = jd('2026-09-24T16:20:00Z');
    const first = dtChip(far.engine, t, turning('Moon'))!;
    expect(first.shown).toBe(true);
    expect(far.calls()).toBe(2);
    // The same quarter day again: from memory; the next one asks again.
    expect(dtChip(far.engine, t + 60 / 1440, turning('Moon'))!.value).toBe(first.value); // 17:20, the same quarter (12-18 UT)
    expect(far.calls()).toBe(2);
    dtChip(far.engine, t + 0.25, turning('Moon'));
    expect(far.calls()).toBe(4);
    // The engine's own rates at that hour.
    expect(first.value!).toBeCloseTo(bodyRates(mock, 'Moon', t)!.k * 158.4, 9);
  });
});

describe('a place at the time shown carries the body’s angular speed × σ, at far dates', () => {
  it('the Moon’s: 0.55″ for each second of σ, in arcminutes', () => {
    const at585 = chipOf(info(158.4), position('Moon'), rates({ Moon: moon }))!;
    expect(at585.unit).toBe('arcmin');
    expect(at585.value!).toBeCloseTo((moon.arcsec_per_s * 158.4) / 60, 12);
    expect(at585.value!).toBeGreaterThan(1.1);
    expect(at585.value!).toBeLessThan(1.9);
    expect(at585.text).toMatch(/^±1\.\d′$/);
    expect(at585.tip).toMatch(/^At the time shown the Moon’s place among the stars is uncertain by 1\.\d′: .* moves 0\.\d\d″ across the sky for each second of it\./);
    const at2000 = chipOf(info(3725.7), position('Moon'), rates({ Moon: moon }))!;
    expect(at2000.value!).toBeGreaterThan(28);
    expect(at2000.value!).toBeLessThan(44);
    expect(at2000.text).toMatch(/^±\d\d′$/);
  });

  it('none where the date is not far, and no rate asked there', () => {
    const near = farMock(15, 'validated');
    expect(dtChip(near.engine, Y2026, position('Moon'))).toMatchObject({ shown: false, value: null, far: false });
    expect(near.calls()).toBe(0);
    // In the labelled tier the same σ is far: the Moon's 8″ show as 0.1′.
    expect(chipOf(info(15, 'labelled'), position('Moon'), rates({ Moon: moon }))!.shown).toBe(true);
  });

  it('a planet’s or the Sun’s only above 0.1′; a star’s never', () => {
    expect(chipOf(info(158.4), position('Sun'), rates({ Sun: sun }))!.shown).toBe((sun.arcsec_per_s * 158.4) / 60 > 0.1);
    expect(chipOf(info(3725.7), position('Sun'), rates({ Sun: sun }))!.text).toMatch(/^±2\.\d′$/);
    const slow: BodyRates = { ...sun, arcsec_per_s: 0.003 };
    expect(chipOf(info(1800), position('Saturn'), rates({ Saturn: slow }))).toMatchObject({ shown: false });
    expect(chipOf(info(3725.7), position('Saturn'), rates({ Saturn: slow }))).toMatchObject({ shown: true, text: '±0.2′' });
    expect(chipOf(info(3725.7), position('Sirius'))).toMatchObject({ shown: false, value: 0 });
    // A body the engine cannot place then shows no place, so no chip.
    expect(chipOf(info(3725.7), position('Moon'), () => null)!.shown).toBe(false);
  });

  it('writes arcminutes to a tenth below 10′, whole above, degrees past a degree', () => {
    expect(arcminText(0.04)).toBe('±0.1′');
    expect(arcminText(1.45)).toBe('±1.4′');
    expect(arcminText(1.5)).toBe('±1.5′');
    expect(arcminText(9.96)).toBe('±10′');
    expect(arcminText(34.44)).toBe('±34′');
    expect(arcminText(75)).toBe('±1.3°');
    expect(uncertaintyText(chipOf(info(3725.7), position('Moon'), rates({ Moon: moon })))).toMatch(/′$/);
  });
});

describe('the far-date rule itself', () => {
  it('a far date is σ over 30 s or the labelled tier', () => {
    expect(farDate(info(30, 'validated'))).toBe(false);
    expect(farDate(info(30.5, 'validated'))).toBe(true);
    expect(farDate(info(0.1, 'labelled'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------
// The real core at the verifier's dates
// ---------------------------------------------------------------------------------

const PKG = resolve(import.meta.dirname, '../../src/wasm-pkg');
const WASM_FILE = resolve(PKG, 'skyfix_wasm_bg.wasm');
const GLUE_FILE = resolve(PKG, 'skyfix_wasm.js');
const glue = existsSync(GLUE_FILE) ? readFileSync(GLUE_FILE, 'utf8') : '';
const ready = existsSync(WASM_FILE) && /export function time_info\(/.test(glue) && /export function tier_at\(/.test(glue);

describe.skipIf(!ready)('the real core at 585 BC and 2000 BC (VERIFICATION_2 §8)', () => {
  let engine: WasmEngine;
  const PHILADELPHIA = { lat_deg: 39.9526, lon_deg: -75.1652 };

  beforeAll(async () => {
    const mod = (await import(/* @vite-ignore */ pathToFileURL(GLUE_FILE).href)) as { initSync: (input: { module: BufferSource }) => unknown; init?: () => void };
    mod.initSync({ module: readFileSync(WASM_FILE) });
    mod.init?.();
    const load = inspectWasmModule(mod);
    if (load.status !== 'ready') throw new Error('the package lacks the explorer');
    engine = load.engine;
  });

  /** The body's k and angular speed at `t` itself, from `sky_state` 10 minutes either side (not `bodyRates`' quarter day). */
  const independent = (body: string, t: number): { k: number; arcsecPerS: number } => {
    const h = 10 / 1440;
    const at = (x: number) => engine.skyState({ lat_deg: 0, lon_deg: 0 }, x, [body]).bodies[0]!;
    const a = at(t - h);
    const b = at(t + h);
    const turn = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
    const ra = turn(b.ra_deg - a.ra_deg) / (2 * h);
    const dec = (b.dec_deg - a.dec_deg) / (2 * h);
    const gha = ((((b.gha_deg - a.gha_deg) % 360) + 360) % 360) / (2 * h);
    const cosDec = Math.cos((((a.dec_deg + b.dec_deg) / 2) * Math.PI) / 180);
    return { k: Math.abs(ra) / gha, arcsecPerS: Math.hypot(ra * cosDec, dec) / 24 };
  };

  const cases = [
    // The verifier's dates (tools/verify2/dt_events.py): Skyfield's calendar, proleptic Gregorian.
    { label: '585 BC', day: '-0584-05-28', sunTurn: [0.3, 0.5], moonTurn: [4, 8], moonPlace: [1.3, 1.7], instant: '±3 min' },
    { label: '2000 BC', day: '-1999-06-01', sunTurn: [9, 12], moonTurn: [84, 186], moonPlace: [32, 37], instant: '±1 h' },
  ] as const;

  for (const c of cases) {
    it(`${c.label}: rising, setting and transit carry the body’s share of time_info’s σ`, () => {
      const a = jd(`${c.day}T04:00:00Z`);
      const ev = engine.dayEvents(PHILADELPHIA, a, a + 1, ['Sun', 'Moon']);
      const seen: string[] = [];
      for (const b of ev.bodies) {
        for (const e of b.events as SkyEvent[]) {
          if (e.kind !== 'rise' && e.kind !== 'set' && e.kind !== 'transit') continue;
          const sigma = engine.timeInfo(e.jd_utc).delta_t_sigma_s;
          const chip = dtChip(engine, e.jd_utc, turning(b.body))!;
          const want = independent(b.body, e.jd_utc).k * sigma;
          // The quarter day's rate against the instant's: within 2 % (the display rounds to the second).
          expect(Math.abs(chip.value! - want)).toBeLessThan(0.02 * want + 0.01);
          const [lo, hi] = b.body === 'Sun' ? c.sunTurn : c.moonTurn;
          expect(chip.value!).toBeGreaterThanOrEqual(lo);
          expect(chip.value!).toBeLessThanOrEqual(hi);
          // Under a second: no chip (the Sun at 585 BC); otherwise its seconds or minutes.
          expect(chip.shown).toBe(chip.value! >= 1);
          if (chip.shown) expect(chip.text).toBe(sigmaText(chip.value!));
          seen.push(`${b.body} ${e.kind}`);
        }
      }
      expect(seen).toEqual(expect.arrayContaining(['Sun rise', 'Sun set', 'Sun transit', 'Moon rise', 'Moon set', 'Moon transit']));
    });

    it(`${c.label}: the Moon’s place carries its angular speed × σ; instants the whole σ`, () => {
      const t = jd(`${c.day}T12:00:00Z`);
      const ti = engine.timeInfo(t);
      expect(ti.tier).toBe('labelled');
      const place = dtChip(engine, t, position('Moon'))!;
      const want = (independent('Moon', t).arcsecPerS * ti.delta_t_sigma_s) / 60;
      expect(Math.abs(place.value! - want)).toBeLessThan(0.01 * want);
      expect(place.value!).toBeGreaterThanOrEqual(c.moonPlace[0]);
      expect(place.value!).toBeLessThanOrEqual(c.moonPlace[1]);
      expect(place.shown).toBe(true);
      expect(place.text).toBe(arcminText(place.value!));
      // A phase, a season, an eclipse: all of σ, as time_info gives it.
      const instant = dtChip(engine, t, INSTANT)!;
      expect(instant.value).toBe(ti.delta_t_sigma_s);
      expect(instant.text).toBe(c.instant);
      expect(dtChip(engine, t, CLOCK)!.text).toBe(c.instant);
      // A star's place: none.
      expect(dtChip(engine, t, position('Sirius'))!.shown).toBe(false);
    });
  }

  it('the verifier’s own numbers (σ 150 s at 585 BC, 3 732 s at 2000 BC, the Moon at 0.55″ a second): 1.4′ and 34′', () => {
    const moonAt = (iso: string) => bodyRates(engine, 'Moon', jd(iso))!;
    // At the verifier's σ the engine's Moon gives the verifier's places.
    expect(arcminText((moonAt('-0584-05-28T12:00:00Z').arcsec_per_s * 150) / 60)).toBe('±1.4′');
    expect(arcminText((moonAt('-1999-06-01T12:00:00Z').arcsec_per_s * 3732) / 60)).toBe('±34′');
  });
});
