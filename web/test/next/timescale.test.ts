/**
 * Time scales, Delta-T and calendars (EXPLORER_API.md "time_info", CONVENTIONS 15.2-15.3):
 * the mock engine's implementation against the Rust model's values, its calendars
 * against JavaScript's own proleptic Gregorian `Date`, and the WASM engine's wrappers.
 */
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import * as T from '../../src/next/engine/mock/timescale.js';
import type { CalendarKind, TimeInfo } from '../../src/next/engine/types.js';
import { isTimeEngine } from '../../src/next/engine/types.js';
import { WasmEngine, type ExplorerWasmExports } from '../../src/next/engine/wasm.js';

const engine = new MockEngine({ syntheticStars: 0 });
const jdTtOfYear = (y: number): number => 2_451_545 + (y - 2000) * 365.25;

describe('the mock engine speaks the time_info contract', () => {
  it('is a TimeEngine', () => {
    expect(isTimeEngine(engine)).toBe(true);
  });

  it('labels 2026-09-24 12:00 as UTC, Gregorian, with the Julian date beside it', () => {
    engine.setDut1(null);
    const t: TimeInfo = engine.timeInfo(2_461_308.0);
    for (const k of [
      'jd_utc',
      'utc',
      'scale',
      'tier',
      'delta_t_s',
      'delta_t_sigma_s',
      'delta_t_source',
      'tt_minus_clock_s',
      'dut1_s',
      'dut1_sigma_s',
      'dut1_source',
      'calendar',
      'civil',
      'julian_civil',
      'notes',
    ]) {
      expect(t, k).toHaveProperty(k);
    }
    expect(t.utc).toBe('2026-09-24T12:00:00.000Z');
    expect(t.scale).toBe('utc');
    expect(t.tier).toBe('validated');
    expect(t.tt_minus_clock_s).toBeCloseTo(69.184, 9);
    expect(t.delta_t_source).toBe('iers');
    expect(Math.abs(t.delta_t_s - 69.12)).toBeLessThan(0.3);
    expect(t.calendar).toBe('gregorian');
    expect([t.civil.year, t.civil.month, t.civil.day, t.civil.hour]).toEqual([2026, 9, 24, 12]);
    expect([t.julian_civil.year, t.julian_civil.month, t.julian_civil.day]).toEqual([2026, 9, 11]);
    expect(t.civil.era).toBe('AD');
  });

  it('labels 585 BC as UT, Julian, with an honest uncertainty', () => {
    const jd = T.jdFromCivil('julian', -584, 5, 28, 12);
    expect(jd).toBe(1_507_900.0);
    const t = engine.timeInfo(jd);
    expect(t.utc).toBe('-0584-05-22T12:00:00.000Z');
    expect(t.scale).toBe('ut');
    expect(t.tier).toBe('outside');
    expect(t.calendar).toBe('julian');
    expect([t.civil.year, t.civil.month, t.civil.day, t.civil.era_year, t.civil.era]).toEqual([-584, 5, 28, 585, 'BC']);
    expect(t.dut1_source).toBe('model');
    expect(t.delta_t_s).toBe(t.tt_minus_clock_s);
    expect(t.delta_t_source).toBe('smh2016');
    expect(t.delta_t_sigma_s).toBeGreaterThan(150);
    expect(t.notes.length).toBeGreaterThanOrEqual(4);
  });

  it('applies a DUT1 set by the user on the UTC scale only, and refuses nonsense', () => {
    engine.setDut1(-0.25);
    const now = engine.timeInfo(2_461_308.0);
    expect([now.dut1_s, now.dut1_source]).toEqual([-0.25, 'user']);
    const old = engine.timeInfo(1_507_900.0);
    expect([old.dut1_s, old.dut1_source]).toEqual([0, 'model']);
    expect(() => engine.setDut1(3)).toThrow(/set_dut1/);
    expect(() => engine.setDut1(Number.NaN)).toThrow(/set_dut1/);
    engine.setDut1(null);
    const back = engine.timeInfo(2_461_308.0);
    expect([back.dut1_s, back.dut1_sigma_s, back.dut1_source]).toEqual([0, 0.9, 'assumed']);
  });

  it('throws an Error for a non-finite instant', () => {
    expect(() => engine.timeInfo(Number.NaN)).toThrow(/time_info/);
  });
});

describe("the mock's Delta-T is the Rust model's outside the IERS table", () => {
  // skyfix_core::deltat::delta_t at the TT epochs of these years (value, sigma).
  const rust: Array<[number, number, number]> = [
    [-2000, 47229.5312, 3731.99],
    [-1000, 25310.5584, 621.9983],
    [-500, 16939.6259, 150.0],
    [0, 10441.3126, 90.0],
    [1000, 1650.393, 15.0],
    [1600, 109.127, 15.0],
    [1900, -1.977, 0.11],
    [2060, 78.6527, 9.8113],
    [2100, 104.5329, 32.3163],
    [2650, 1889.2748, 883.2723],
    [3000, 4167.0312, 1817.5825],
  ];
  it.each(rust)('%d', (year, value, sigma) => {
    const d = T.deltaT(jdTtOfYear(year));
    expect(Math.abs(d.value_s - value)).toBeLessThan(0.01);
    expect(Math.abs(d.sigma_s - sigma)).toBeLessThan(0.01 * Math.max(1, sigma));
  });

  it('is within 0.3 s of the IERS values over 1973-2026', () => {
    // skyfix_core values at 1990.0, 2000.0, 2010.0, 2020.0, 2026.0.
    for (const [y, v] of [
      [1990, 56.8558],
      [2000, 63.8283],
      [2010, 66.071],
      [2020, 69.3614],
      [2026, 69.1097],
    ] as const) {
      expect(Math.abs(T.deltaT(jdTtOfYear(y)).value_s - v), String(y)).toBeLessThan(0.3);
    }
  });

  it('labels its sources as the Rust model does', () => {
    expect(T.deltaT(jdTtOfYear(-2000)).source).toBe('parabola');
    expect(T.deltaT(jdTtOfYear(-1000)).source).toBe('parabola');
    expect(T.deltaT(jdTtOfYear(-500)).source).toBe('smh2016');
    expect(T.deltaT(jdTtOfYear(2000)).source).toBe('iers');
    expect(T.deltaT(jdTtOfYear(2027)).source).toBe('prediction');
    expect(T.deltaT(jdTtOfYear(2900)).source).toBe('parabola');
  });
});

describe('calendars', () => {
  it('knows the reform and the eras', () => {
    const r = engine.calendarConvert({ jd_utc: T.GREGORIAN_START_JD });
    expect([r.gregorian.month, r.gregorian.day, r.julian.month, r.julian.day]).toEqual([10, 15, 10, 5]);
    const back = engine.calendarConvert({ civil: { calendar: 'julian', year: 1582, month: 10, day: 4, hour: 12 } });
    expect(back.jd_utc).toBe(2_299_160.0);
    expect([back.gregorian.month, back.gregorian.day]).toEqual([10, 14]);
    expect(T.eraOf(0)).toEqual({ era_year: 1, era: 'BC' });
    expect(T.formatYear(-584)).toBe('-0584');
    expect(T.formatYear(12345)).toBe('+12345');
    expect(T.formatUtc(T.jdFromCivil('gregorian', 12345, 1, 1))).toBe('+12345-01-01T00:00:00.000Z');
  });

  it('refuses impossible requests with an Error', () => {
    expect(() => engine.calendarConvert({})).toThrow(/calendar_convert/);
    expect(() =>
      engine.calendarConvert({ civil: { calendar: 'gregorian', year: 1500, month: 2, day: 29 } }),
    ).toThrow(/29/);
    expect(() =>
      engine.calendarConvert({ civil: { calendar: 'julian', year: 585, month: 5, day: 28, era_year: 585, era: 'BC' } }),
    ).toThrow(/astronomical year/);
    expect(
      engine.calendarConvert({ civil: { calendar: 'julian', year: 1500, month: 2, day: 29 } }).julian.day,
    ).toBe(29);
  });

  it("agrees with JavaScript's proleptic Gregorian Date from -9999 to 9999", () => {
    const bad: string[] = [];
    for (let y = -9999; y <= 9999; y += 37) {
      for (const [m, d] of [
        [1, 1],
        [2, 28],
        [3, 1],
        [12, 31],
      ] as const) {
        const date = new Date(0);
        date.setUTCFullYear(y, m - 1, d);
        date.setUTCHours(0, 0, 0, 0);
        const jd = date.getTime() / 86_400_000 + 2_440_587.5;
        const c = T.civilFromJd(jd, 'gregorian');
        if (T.jdFromCivil('gregorian', y, m, d) !== jd || c.year !== y || c.month !== m || c.day !== d) {
          bad.push(`${y}-${m}-${d}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('round-trips every 97th day over ten millennia in both calendars', () => {
    const bad: string[] = [];
    for (const cal of ['julian', 'gregorian'] as CalendarKind[]) {
      const first = T.jdnFromCivil(cal, -5000, 1, 1);
      const last = T.jdnFromCivil(cal, 5000, 12, 31);
      for (let jdn = first; jdn <= last; jdn += 97) {
        const [y, m, d] = T.civilFromJdn(cal, jdn);
        if (T.jdnFromCivil(cal, y, m, d) !== jdn || d > T.daysInMonth(cal, y, m)!) bad.push(`${cal} ${jdn}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('the WASM engine passes the time exports through', () => {
  const calls: unknown[][] = [];
  const x = {
    time_info: (jd: number) => {
      calls.push(['time_info', jd]);
      return { jd_utc: jd };
    },
    set_dut1: (s: number | null) => {
      calls.push(['set_dut1', s]);
      if (s !== null && Math.abs(s) > 1) throw 'DUT1 too large';
    },
    calendar_convert: (json: string) => {
      calls.push(['calendar_convert', json]);
      return { jd_utc: 0 };
    },
  } as unknown as ExplorerWasmExports;
  const wasm = new WasmEngine(x);

  it('calls the exports with the documented arguments', () => {
    expect(isTimeEngine(wasm)).toBe(true);
    expect(wasm.timeInfo(2_461_308)).toEqual({ jd_utc: 2_461_308 });
    wasm.setDut1(-0.1);
    wasm.setDut1(null);
    wasm.calendarConvert({ jd_utc: 1 });
    expect(calls).toEqual([
      ['time_info', 2_461_308],
      ['set_dut1', -0.1],
      ['set_dut1', null],
      ['calendar_convert', '{"jd_utc":1}'],
    ]);
    expect(() => wasm.setDut1(5)).toThrow('set_dut1: DUT1 too large');
  });

  it('says to rebuild when the core predates the exports', () => {
    const old = new WasmEngine({} as ExplorerWasmExports);
    expect(() => old.timeInfo(0)).toThrow(/rebuild/i);
    expect(() => old.setDut1(null)).toThrow(/rebuild/i);
    expect(() => old.calendarConvert({ jd_utc: 0 })).toThrow(/rebuild/i);
  });
});
