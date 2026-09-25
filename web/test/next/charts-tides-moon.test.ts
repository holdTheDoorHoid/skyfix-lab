/**
 * The Tides tab and the Moon's charts (charts2 agent, expansion programme Q5) against the mock
 * engine: the tide window, station and datum chosen; heights read off the predicted curve
 * against the engine's own `tide_now` (the cursor's readout); units; the pack's absence; the
 * Moon at one hour through the year (`sample_bodies` runs split at clock changes, every value
 * the engine's `sky_state`); perigee and apogee on the calendar's days.
 */
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import { isTidePackNotLoaded, type MoonApsides, type TideStationNear } from '../../src/next/engine/types.js';
import type { Zone } from '../../src/next/time.js';
import {
  chooseStation,
  computeTides,
  datumFor,
  EXTREMES_MARGIN_DAYS,
  heightAt,
  heightText,
  heightUnit,
  heightValue,
  rateAt,
  rateText,
  tideAround,
  tideWindow,
  TIDE_STEP_MIN,
} from '../../src/next/charts/tides-data.js';
import { computeMoonYear, dailyRuns, instantsAt } from '../../src/next/charts/moon-year-data.js';
import { apsidesOn, APSIS_WORDS, syzygyWords } from '../../src/next/charts/moon-data.js';
import { daysOfYear, localDay } from '../../src/next/charts/windows.js';

const engine = new MockEngine();
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
const OPTIONS = { horizon: 'standard', height_of_eye_m: 0 } as const;
const DAY = localDay(NEW_YORK, { year: 2026, month: 9, day: 24 });

function station(id: string, extra: Partial<TideStationNear> = {}): TideStationNear {
  return {
    id,
    name: id,
    state: null,
    lat_deg: 0,
    lon_deg: 0,
    kind: 'harmonic',
    reference_id: null,
    reference_name: null,
    tide_type: 'semidiurnal',
    form_number: 0.2,
    datums: ['MHHW', 'MSL', 'MLLW'],
    default_datum: 'MLLW',
    curve: 'harmonic',
    flags: [],
    notes: [],
    distance_km: 1,
    distance_nm: 0.54,
    bearing_deg: 90,
    ...extra,
  };
}

describe('tides', () => {
  it('draws the app’s local day, or seven local days from it', () => {
    expect(tideWindow(NEW_YORK, DAY, 'day')).toEqual({ start: DAY.jd_start, end: DAY.jd_end, days: [DAY] });
    const week = tideWindow(NEW_YORK, DAY, 'week');
    expect(week.days).toHaveLength(7);
    expect(week.start).toBe(DAY.jd_start);
    for (let i = 1; i < 7; i += 1) expect(week.days[i]!.jd_start).toBe(week.days[i - 1]!.jd_end);
    expect(week.end).toBeCloseTo(DAY.jd_start + 7, 9);
  });

  it('keeps the person’s station while it is among the nearest, else the nearest; and a datum the station has', () => {
    const near = [station('A'), station('B')];
    expect(chooseStation(near, 'B')?.id).toBe('B');
    expect(chooseStation(near, 'Z')?.id).toBe('A');
    expect(chooseStation(near, null)?.id).toBe('A');
    expect(chooseStation([], null)).toBeNull();
    expect(datumFor(station('A'), 'MHHW')).toBe('MHHW');
    expect(datumFor(station('A'), 'NAVD88')).toBe('MLLW');
    expect(datumFor(station('A'), '')).toBe('MLLW');
  });

  it('asks the engine for the curve, high and low water and the sky, and keeps only the window’s extremes', () => {
    const data = computeTides(engine, { observer: PHILLY, zone: NEW_YORK, day: DAY, span: 'day', datum: '', stationId: null, options: OPTIONS });
    expect(data.station.id).toBe('MOCK001');
    expect(data.datum).toBe('MLLW');
    expect(data.curve!.jd_utc.length).toBe(Math.floor((DAY.jd_end - DAY.jd_start) * 1440 / TIDE_STEP_MIN.day + 1e-9) + 1);
    expect(data.extremes.extremes.length).toBeGreaterThanOrEqual(3);
    for (const e of data.extremes.extremes) {
      expect(e.jd_utc).toBeGreaterThanOrEqual(DAY.jd_start);
      expect(e.jd_utc).toBeLessThan(DAY.jd_end);
    }
    expect(data.around.length).toBeGreaterThan(data.extremes.extremes.length);
    expect(data.around[0]!.jd_utc).toBeLessThan(DAY.jd_start);
    expect(data.around.at(-1)!.jd_utc).toBeGreaterThan(DAY.jd_end);
    expect(data.around[0]!.jd_utc).toBeGreaterThanOrEqual(DAY.jd_start - EXTREMES_MARGIN_DAYS);
    expect(data.phases.length).toBeGreaterThan(0);
    // The engine's own high and low waters, not a re-search.
    const direct = engine.tideExtremes('MOCK001', DAY.jd_start, DAY.jd_end, 'MLLW').extremes;
    expect(data.extremes.extremes.map((e) => e.kind)).toEqual(direct.map((e) => e.kind));
    data.extremes.extremes.forEach((e, i) => expect(Math.abs(e.jd_utc - direct[i]!.jd_utc) * 86_400).toBeLessThan(1));
  });

  it('reads the height and rate off the curve within a millimetre of the engine’s own value', () => {
    const data = computeTides(engine, { observer: PHILLY, zone: NEW_YORK, day: DAY, span: 'day', datum: 'MSL', stationId: 'MOCK001', options: OPTIONS });
    expect(data.datum).toBe('MSL');
    let worstH = 0;
    let worstR = 0;
    for (let k = 1; k < 97; k += 1) {
      const t = DAY.jd_start + (k * 0.2373) / 24;
      const now = engine.tideNow('MOCK001', t, 'MSL');
      worstH = Math.max(worstH, Math.abs(heightAt(data.curve!, t)! - now.height_m));
      worstR = Math.max(worstR, Math.abs(rateAt(data.curve!, t)! - now.rate_m_per_h));
    }
    expect(worstH).toBeLessThan(0.001);
    expect(worstR).toBeLessThan(0.02);
    expect(heightAt(data.curve!, DAY.jd_start - 0.01)).toBeNull();
    expect(heightAt(data.curve!, data.curve!.jd_utc[0]!)).toBe(data.curve!.height_m[0]);
    const mid = DAY.jd_start + 0.4;
    const around = tideAround(data.around, mid);
    const now = engine.tideNow('MOCK001', mid, 'MSL');
    expect(around.next?.jd_utc).toBeCloseTo(now.next!.jd_utc, 5);
    expect(around.nextHigh?.kind).toBe('high');
    expect(around.nextLow?.kind).toBe('low');
    expect(around.previous!.jd_utc).toBeLessThanOrEqual(mid);
  });

  it('writes heights in metres or feet, with a true minus', () => {
    expect(heightUnit('metric')).toEqual({ unit: 'm', perMetre: 1, digits: 2 });
    expect(heightText(1.234, 'metric')).toBe('1.23 m');
    expect(heightText(1.234, 'nautical')).toBe('1.23 m');
    expect(heightText(-0.31, 'metric')).toBe('−0.31 m');
    expect(heightText(-0.001, 'metric')).toBe('0.00 m');
    expect(heightText(1.2192, 'imperial')).toBe('4.0 ft');
    expect(heightValue(1.2192, 'imperial')).toBe('4.00');
    expect(rateText(-0.3048, 'imperial')).toBe('1.0 ft an hour');
  });

  it('says the pack is missing, in the engine’s own words', () => {
    const bare = new MockEngine({ tidesLoaded: false });
    expect(bare.tidePackInfo()).toBeNull();
    let error: unknown = null;
    try {
      computeTides(bare, { observer: PHILLY, zone: NEW_YORK, day: DAY, span: 'day', datum: '', stationId: null, options: OPTIONS });
    } catch (e) {
      error = e;
    }
    expect(isTidePackNotLoaded(error)).toBe(true);
    bare.loadPack('tides-us', new Uint8Array(1));
    expect(computeTides(bare, { observer: PHILLY, zone: NEW_YORK, day: DAY, span: 'week', datum: '', stationId: null, options: OPTIONS }).window.days).toHaveLength(7);
  });
});

describe('the Moon through the year', () => {
  it('takes the chosen hour of every local day, exact on the days the clocks change', () => {
    const days = daysOfYear(NEW_YORK, 2026);
    const at = instantsAt(days, 21, NEW_YORK);
    expect(at).toHaveLength(365);
    // 21:00 EST is 02:00 UTC the next day; 21:00 EDT is 01:00 UTC.
    expect(((at[10]! - 0.5) % 1) * 24).toBeCloseTo(2, 6);
    expect(((at[200]! - 0.5) % 1) * 24).toBeCloseTo(1, 6);
    const runs = dailyRuns(at);
    expect(runs.length).toBe(3);
    expect(runs.reduce((n, r) => n + r[1], 0)).toBe(365);
    expect(dailyRuns([0, 1, 2, 3.5, 4.5])).toEqual([
      [0, 3],
      [3, 2],
    ]);
    expect(dailyRuns([])).toEqual([]);
  });

  it('gives the engine’s Moon at each of those instants', () => {
    const data = computeMoonYear(engine, { observer: PHILLY, zone: NEW_YORK, year: 2026, hour: 21 });
    expect(data.days).toHaveLength(365);
    expect(data.missing).toBe(0);
    expect(data.timing.calls).toBe(3);
    for (const i of [0, 67, 68, 180, 305, 364]) {
      const d = data.days[i]!;
      const moon = engine.skyState(PHILLY, d.jd, ['Moon']).bodies[0]!;
      expect(d.alt).toBeCloseTo(moon.alt_apparent_deg, 6);
      expect(d.az).toBeCloseTo(moon.az_deg, 6);
    }
    expect(data.days.filter((d) => d.alt >= 0).length).toBeGreaterThan(120);
  }, 30_000);

  it('leaves out the days outside the engine’s coverage and counts them', () => {
    const data = computeMoonYear(engine, { observer: PHILLY, zone: NEW_YORK, year: 2061, hour: 21 });
    expect(data.days.length + data.missing).toBe(365);
    expect(data.missing).toBeGreaterThan(300);
  });
});

describe('perigee and apogee on the Moon calendar', () => {
  const apsides: MoonApsides = engine.moonApsides(DAY.jd_start - 30, DAY.jd_end + 30);

  it('marks each apsis on its local day, and only there', () => {
    expect(apsides.apsides.length).toBeGreaterThanOrEqual(2);
    for (const a of apsides.apsides) {
      const days = daysOfYear(NEW_YORK, 2026).filter((d) => apsidesOn(apsides, d).some((m) => m.jd === a.jd_utc));
      expect(days).toHaveLength(1);
      expect(a.jd_utc).toBeGreaterThanOrEqual(days[0]!.jd_start);
      expect(a.jd_utc).toBeLessThan(days[0]!.jd_end);
      const mark = apsidesOn(apsides, days[0]!).find((m) => m.jd === a.jd_utc)!;
      expect(mark.short).toBe(APSIS_WORDS[a.kind].short);
      expect(mark.title('metric', NEW_YORK)).toMatch(a.kind === 'perigee' ? /perigee/ : /apogee/);
    }
    expect(apsidesOn(null, DAY)).toEqual([]);
  });

  it('names supermoons and micromoons in plain words', () => {
    const sz = apsides.syzygies[0]!;
    expect(syzygyWords({ ...sz, kind: 'full_moon', supermoon: true, micromoon: false, largest_of_year: true })).toBe(
      'Full Moon near perigee: a supermoon, the year’s largest',
    );
    expect(syzygyWords({ ...sz, kind: 'full_moon', supermoon: false, micromoon: true, smallest_of_year: false })).toBe('Full Moon near apogee: a micromoon');
    expect(syzygyWords({ ...sz, kind: 'new_moon', supermoon: false, micromoon: false })).toBe('New Moon');
  });
});
