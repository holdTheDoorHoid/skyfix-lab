/**
 * navigate2 (expansion programme): the printables and the star finder — the plotting
 * sheet's lines of position, the worksheet's figures, and the star finder's template set to
 * LHA ♈ — with the mock engine, and against the real core when a package is built.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ReducedSight, Session } from '../../src/types.js';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { StarFinderGeometry } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';
import { ghaAriesFor } from '../../src/next/navigate/print/open.js';
import { crossing, gridStep, lopOf, sheetHalfSpan, sheetOffset } from '../../src/next/navigate/print/plotting.js';
import { lhaDeg, worksheetRows } from '../../src/next/navigate/print/worksheet.js';
import { lhaAries, templatePoint, templateToBase, templateTurnDeg } from '../../src/next/navigate/starfinder/draw.js';

const D = Math.PI / 180;

function sightTo(id: string, zn: number, aNm: number): ReducedSight {
  return {
    id,
    body: 'Vega',
    utc: '2026-10-01T01:30:00Z',
    jd_utc: 2461314.5625,
    gha_deg: 100,
    dec_deg: 38.8,
    direction_source: 'test',
    ho_deg: 40,
    sigma_arcmin: 1,
    corrections: { input_kind: 'observed_ho', input_deg: 40, steps: [], ho_deg: 40, sigma_ho_arcmin: 1, warnings: [] },
    hc_deg: 40 - aNm / 60,
    zn_deg: zn,
    intercept_nm: aNm,
    warnings: [],
    horizontal_parallax_arcmin: 0,
    earth_shape_arcmin: null,
  };
}

describe('the plotting sheet', () => {
  it('lays each intercept along Zn (toward) or its reciprocal (away), the line at right angles', () => {
    const t = lopOf(sightTo('t', 90, 5))!;
    expect(t.foot.x).toBeCloseTo(5, 12);
    expect(t.foot.y).toBeCloseTo(0, 12);
    expect(t.along.x * Math.sin(90 * D) + t.along.y * Math.cos(90 * D)).toBeCloseTo(0, 12);
    const a = lopOf(sightTo('a', 90, -5))!;
    expect(a.foot.x).toBeCloseTo(-5, 12);
  });

  it('draws every line through the position the sights were taken from', () => {
    // Sights from a position 7 NM east and 4 NM south of the AP: each intercept is the
    // component of that offset along its Zn, so every line passes through it.
    const truth = { x: 7, y: -4 };
    const lops = [20, 135, 250, 310].map((zn, i) => lopOf(sightTo(`s${i}`, zn, truth.x * Math.sin(zn * D) + truth.y * Math.cos(zn * D)))!);
    for (let i = 1; i < lops.length; i += 1) {
      const p = crossing(lops[0]!, lops[i]!)!;
      expect(p.x).toBeCloseTo(truth.x, 9);
      expect(p.y).toBeCloseTo(truth.y, 9);
    }
    expect(crossing(lops[0]!, lopOf(sightTo('p', 200, 3))!)).toBeNull();
  });

  it('frames the intercepts and the fix, with a grid of about five lines each side', () => {
    const lops = [lopOf(sightTo('a', 45, 7.7))!, lopOf(sightTo('b', 180, -12.4))!];
    const S = sheetHalfSpan(lops, { x: 3, y: -2 });
    expect(S).toBe(20);
    expect(gridStep(S)).toBe(5);
    expect(sheetHalfSpan([], null)).toBe(3);
    const off = sheetOffset({ lat_deg: 60, lon_deg: 179.9 }, { lat_deg: 60.1, lon_deg: -179.9 });
    expect(off.y).toBeCloseTo(6, 9);
    expect(off.x).toBeCloseTo(0.2 * 60 * 0.5, 6);
  });
});

describe('the worksheet', () => {
  it('works LHA from GHA and the longitude east', () => {
    expect(lhaDeg(58.285, -75.4167)).toBeCloseTo(342.868, 3);
    expect(lhaDeg(350, 20)).toBeCloseTo(10, 12);
    expect(lhaDeg(0, 0)).toBe(0);
  });

  it('lists the six steps in order, with the intercept toward or away', () => {
    const session: Session = {
      schema: 'skyfix.session/1',
      meta: { name: 'w', notes: '', kind: 'real' },
      observer: { height_of_eye_m: 2.5, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40.0833, lon_deg: -75.4167 }, assumed_position_role: { role: 'initializer' } },
      instrument: { name: '', index_correction_arcmin: -1.2, horizon: 'sea' },
      clock: { uncertainty_s: 0, correction_s: 0 },
      observations: [],
    };
    const sight = sightTo('obs-1', 149.3, -12.4);
    const rows = worksheetRows({ session, obs: { id: 'obs-1', body: 'Vega', utc: sight.utc, altitude_deg: 40, altitude_kind: 'observed_ho', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' }, sight, ghaAriesDeg: 90 });
    expect([...new Set(rows.map((r) => r.step))]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows.find((r) => r.term === 'SHA')!.value).toBe('10° 00.00′');
    expect(rows.find((r) => r.term === 'LHA')!.value).toBe('24° 35.00′');
    expect(rows.find((r) => r.term === 'Zn')!.value).toBe('149.3°');
    expect(rows.find((r) => r.term === 'a = Ho − Hc')!.value).toBe('12.40′ = 12.40 NM Away');
    expect(rows.find((r) => r.plain === 'Plot')!.value).toMatch(/along 329\.3°/);
  });
});

describe('the worksheet’s sums close', () => {
  it('to the 0.01′ it prints: Ho − Hc = a (Deneb of the dusk example, where 0.1′ would show 28.1 − 20.3 against 7.7)', () => {
    const session: Session = {
      schema: 'skyfix.session/1',
      meta: { name: 'w', notes: '', kind: 'simulated' },
      observer: { height_of_eye_m: 2.5, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40.0833, lon_deg: -75.4167 }, assumed_position_role: { role: 'initializer' } },
      instrument: { name: '', index_correction_arcmin: -1.2, horizon: 'sea' },
      clock: { uncertainty_s: 0, correction_s: 0 },
      observations: [],
    };
    const sight = { ...sightTo('obs-1', 66.2, (67.46755 - 67.338646) * 60), ho_deg: 67.46755, hc_deg: 67.338646 };
    const rows = worksheetRows({ session, obs: { id: 'obs-1', body: 'Deneb', utc: sight.utc, altitude_deg: 67.54, altitude_kind: 'sextant_hs', sigma_arcmin: 0.5, limb: 'center', horizon: null, geocentric: null, notes: '' }, sight, ghaAriesDeg: null });
    const minutes = (v: string): number => Number(/(\d+)° (\d+\.\d+)′/.exec(v)![1]) * 60 + Number(/(\d+)° (\d+\.\d+)′/.exec(v)![2]);
    const ho = minutes(rows.find((r) => r.term === 'Ho')!.value);
    const hc = minutes(rows.find((r) => r.term === 'Hc')!.value);
    const a = Number(/^(\d+\.\d+)′/.exec(rows.find((r) => r.term === 'a = Ho − Hc')!.value)![1]);
    expect(rows.find((r) => r.term === 'Ho')!.value).toBe('67° 28.05′');
    expect(rows.find((r) => r.term === 'Hc')!.value).toBe('67° 20.32′');
    expect(Math.abs(ho - hc - a)).toBeLessThan(0.0051);
  });
});

describe('the star finder', () => {
  it('reads LHA ♈ from GHA ♈ and the longitude, and turns the template by it (anticlockwise north, clockwise south)', () => {
    expect(lhaAries(300, 75)).toBeCloseTo(15, 12);
    expect(lhaAries(10, -20)).toBeCloseTo(350, 12);
    expect(templateTurnDeg({ rotation_sign: 1 }, 30)).toBe(30);
    expect(templateTurnDeg({ rotation_sign: -1 }, 30)).toBe(-30);
    const p = templateToBase([1, 0], 90);
    expect(p[0]).toBeCloseTo(0, 12);
    expect(p[1]).toBeCloseTo(1, 12);
  });

  it('the mock gives a finder of the same shape', () => {
    const g = new MockEngine().starFinderGeometry(39.95);
    expect(g.side).toBe('north');
    expect(g.stars.length).toBeGreaterThan(10);
    expect(g.template.altitude_circles.length).toBeGreaterThan(5);
  });
});

const PKG = resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm.js');

describe.skipIf(!existsSync(PKG))('against the built core (npm run wasm)', () => {
  async function engine(): Promise<WasmEngine | null> {
    const mod = (await import(pathToFileURL(PKG).href)) as Record<string, unknown> & { initSync: (o: { module: Buffer }) => void };
    mod.initSync({ module: readFileSync(resolve(__dirname, '../../src/wasm-pkg/skyfix_wasm_bg.wasm')) });
    if (typeof mod.star_finder_geometry !== 'function') return null;
    return new WasmEngine(mod as unknown as ExplorerWasmExports);
  }

  /** Altitude and azimuth on the sphere (CONVENTIONS 3). */
  function altAz(latDeg: number, decDeg: number, lhaDegValue: number): { h: number; A: number } {
    const phi = latDeg * D;
    const dec = decDeg * D;
    const t = lhaDegValue * D;
    const h = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(t));
    const A = Math.atan2(-Math.cos(dec) * Math.sin(t), Math.cos(phi) * Math.sin(dec) - Math.sin(phi) * Math.cos(dec) * Math.cos(t));
    return { h: h / D, A: (((A / D) % 360) + 360) % 360 };
  }

  it('draws the template where the engine puts it, and each star where the set template reads it (both hemispheres)', async () => {
    const e = await engine();
    if (!e) return;
    for (const lat of [39.95, -33.9]) {
      const g: StarFinderGeometry = e.starFinderGeometry(lat);
      // Our template formula reproduces the engine's points (and index 36 is azimuth 180).
      const ten = g.template.altitude_circles.find((c) => c.value_deg === 10)!;
      for (const k of [0, 9, 18, 36, 54]) {
        const mine = templatePoint(g, 10, 5 * k);
        expect(mine[0]).toBeCloseTo(ten.points[k]![0], 5);
        expect(mine[1]).toBeCloseTo(ten.points[k]![1], 5);
      }
      // Set to LHA ♈ 123.4°, every star above the horizon lies under its altitude and azimuth.
      const lhaA = 123.4;
      const turn = templateTurnDeg(g, lhaA);
      let checked = 0;
      for (const star of g.stars) {
        const { h, A } = altAz(g.template_latitude_deg, star.dec_deg, lhaA + star.sha_deg);
        if (h < 1) continue;
        const onBase = g.side === 'north' ? star.north : star.south;
        const read = templateToBase(templatePoint(g, h, A), turn);
        expect(Math.hypot(read[0] - onBase[0], read[1] - onBase[1])).toBeLessThan(1e-5);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(15);
    }
  });

  it('GHA ♈ on the session’s UT1: GHA ♈ + SHA gives the star’s GHA from the core', async () => {
    const e = await engine();
    if (!e) return;
    const mod = (await import(pathToFileURL(PKG).href)) as { reduce: (s: string, m: string) => { status: string; sight: ReducedSight }[] };
    const base: Session = {
      schema: 'skyfix.session/1',
      meta: { name: 'w', notes: '', kind: 'real' },
      observer: { height_of_eye_m: 2.5, pressure_hpa: 1010, temperature_c: 10, assumed_position: { lat_deg: 40, lon_deg: -75 }, assumed_position_role: { role: 'initializer' } },
      instrument: { name: '', index_correction_arcmin: 0, horizon: 'sea' },
      clock: { uncertainty_s: 0, correction_s: 0 },
      observations: [{ id: 'v', body: 'Vega', utc: '2026-10-01T01:30:00Z', altitude_deg: 60, altitude_kind: 'observed_ho', sigma_arcmin: 1, limb: 'center', horizon: null, geocentric: null, notes: '' }],
    };
    for (const dut1 of [undefined, 0.6, -0.8]) {
      const session: Session = { ...base, clock: { ...base.clock, ...(dut1 === undefined ? {} : { dut1_s: dut1 }) } };
      const sight = mod.reduce(JSON.stringify(session), 'auto')[0]!.sight;
      const gha = ghaAriesFor(e, session, sight, true)!;
      // The star's SHA is the same whatever the UT1: check it against DUT1 = automatic's.
      const sha = (((sight.gha_deg - gha) % 360) + 360) % 360;
      const auto = mod.reduce(JSON.stringify(base), 'auto')[0]!.sight;
      const shaAuto = (((auto.gha_deg - e.sidereal(auto.jd_utc).gha_aries_deg) % 360) + 360) % 360;
      expect(Math.abs(sha - shaAuto) * 3600).toBeLessThan(0.05);
    }
  });
});
