/**
 * The Sun tab's data (charts2 agent, expansion programme Q5; web/src/next/charts/sun-data.ts)
 * against the mock engine: every number drawn is the engine's own, the clocks and windows
 * asked for are the right ones, and the shaping (runs above the horizon, whole hours, the
 * date axis, the sky projection) is exact. The mock's astronomy is illustrative, so broad
 * facts are checked, never precise times.
 */
import { describe, expect, it } from 'vitest';
import { MockEngine } from '../../src/next/engine/mock.js';
import type { SunPathPoint } from '../../src/next/engine/types.js';
import type { Zone } from '../../src/next/time.js';
import {
  aboveHorizonRuns,
  azAxisStart,
  azDelta,
  computeAnalemma,
  bearingsFromYear,
  computeEot,
  computeSolarDay,
  computeSolarYear,
  computeSunPath,
  dayOfYearOf,
  daysInYear,
  defaultPanel,
  enu,
  eotText,
  hourMarks,
  kwh,
  lmtOffsetHours,
  meanDirection,
  monthStarts,
  norm360,
  offsetText,
  standardOffsetHours,
  stereographic,
  unwrapAz,
} from '../../src/next/charts/sun-data.js';
import { hourTag } from '../../src/next/charts/sun-path.js';
import { clockWords } from '../../src/next/charts/analemma.js';
import { localDay } from '../../src/next/charts/windows.js';
import { computeYear } from '../../src/next/charts/year-data.js';
import { setHourCycle } from '../../src/next/shell/format.js';

const engine = new MockEngine();
const PHILLY = { lat_deg: 39.9526, lon_deg: -75.1652, height_m: 0 };
const SYDNEY = { lat_deg: -33.8568, lon_deg: 151.2153, height_m: 0 };
const TROMSO = { lat_deg: 69.6492, lon_deg: 18.9553, height_m: 0 };
const NEW_YORK: Zone = { kind: 'iana', zone: 'America/New_York' };
const SYD: Zone = { kind: 'iana', zone: 'Australia/Sydney' };
const OSLO: Zone = { kind: 'iana', zone: 'Europe/Oslo' };
const OPTIONS = { horizon: 'standard', height_of_eye_m: 0 } as const;

const pt = (jd: number, alt: number, az: number): SunPathPoint => ({ jd_utc: jd, alt_deg: alt, alt_apparent_deg: alt, az_deg: az });

describe('angles and clocks', () => {
  it('wraps azimuths and takes their differences the short way round', () => {
    expect(norm360(-10)).toBe(350);
    expect(norm360(725)).toBe(5);
    expect(azDelta(350, 10)).toBe(20);
    expect(azDelta(10, 350)).toBe(-20);
    expect(azDelta(0, 180)).toBe(180);
  });

  it('faces the equator: south in the middle north of it, north in the middle south of it', () => {
    expect(azAxisStart(40)).toBe(0);
    expect(azAxisStart(-34)).toBe(180);
    expect(unwrapAz(90, 0)).toBe(90);
    expect(unwrapAz(10, 180)).toBe(370);
    expect(unwrapAz(200, 180)).toBe(200);
  });

  it('local mean time follows the longitude; zone time is the zone’s standard time', () => {
    expect(lmtOffsetHours(-75.1652)).toBeCloseTo(-5.011013, 6);
    expect(standardOffsetHours(NEW_YORK, 2026)).toBe(-5);
    expect(standardOffsetHours(SYD, 2026)).toBe(10);
    expect(standardOffsetHours({ kind: 'fixed', offsetMs: 0, name: 'UTC' }, 2026)).toBe(0);
    expect(offsetText(-5)).toBe('UTC−5');
    expect(offsetText(5.5)).toBe('UTC+5:30');
    // −5.011013 h is 5 h 00 min 39.65 s: shown to the second.
    expect(offsetText(lmtOffsetHours(-75.1652))).toBe('UTC−5:00:40');
    expect(offsetText(0)).toBe('UTC');
    expect(clockWords({ clock: 'lmt', timeH: 12, zoneOffsetH: -5, observer: PHILLY })).toBe('12:00 local mean time (UTC−5:00:40)');
    expect(clockWords({ clock: 'zone', timeH: 9.5, zoneOffsetH: -5, observer: PHILLY })).toBe('09:30 zone time, UTC−5 all year (no daylight saving)');
  });

  it('puts dates on a year axis, leap years included', () => {
    expect(dayOfYearOf('2026-01-01')).toBe(0);
    expect(dayOfYearOf('2026-12-31')).toBe(364);
    expect(dayOfYearOf('2024-12-31')).toBe(365);
    expect(dayOfYearOf('2024-03-01')).toBe(60);
    // 585 BC (astronomical −584) is a leap year in the proleptic Gregorian calendar of the wire format.
    expect(dayOfYearOf('-0584-05-28')).toBe(148);
    expect(daysInYear(2024)).toBe(366);
    expect(monthStarts(2026)).toEqual([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]);
  });

  it('writes the equation of time and energy the way the page does', () => {
    expect(eotText(986.8)).toBe('+16 min 27 s');
    expect(eotText(-850.4)).toBe('−14 min 10 s');
    expect(eotText(-850.5)).toBe('−14 min 11 s');
    expect(eotText(42.2)).toBe('+42 s');
    expect(eotText(0.2)).toBe('0 s');
    expect(kwh(2448.2)).toBe('2 448');
    expect(kwh(7.032, 2)).toBe('7.03');
  });

  it('writes the hour on the path in the chosen clock', () => {
    setHourCycle('h23');
    expect(hourTag(6)).toBe('06');
    setHourCycle('h12');
    expect(hourTag(0)).toBe('12 AM');
    expect(hourTag(15)).toBe('3 PM');
    setHourCycle('h23');
  });
});

describe('the sun path', () => {
  it('cuts a path into runs above the horizon, each ending on it', () => {
    const pts = [pt(0, -5, 80), pt(1, 5, 90), pt(2, 30, 180), pt(3, 5, 270), pt(4, -5, 280), pt(5, -10, 300)];
    const runs = aboveHorizonRuns(pts);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run[0]).toEqual({ jd: 0.5, alt: 0, az: 85 });
    expect(run.at(-1)).toEqual({ jd: 3.5, alt: 0, az: 275 });
    expect(run.slice(1, -1).map((p) => p.alt)).toEqual([5, 30, 5]);
    // The crossing is interpolated the short way round north.
    const north = aboveHorizonRuns([pt(0, -2, 350), pt(1, 2, 10)]);
    expect(north[0]![0]!.az).toBeCloseTo(0, 9);
    // Midnight sun: one run, no crossings; polar night: none.
    expect(aboveHorizonRuns([pt(0, 3, 0), pt(1, 10, 90), pt(2, 3, 180)])).toEqual([[
      { jd: 0, alt: 3, az: 0 },
      { jd: 1, alt: 10, az: 90 },
      { jd: 2, alt: 3, az: 180 },
    ]]);
    expect(aboveHorizonRuns([pt(0, -3, 0), pt(1, -1, 90)])).toEqual([]);
  });

  it('draws the engine’s day and the year’s solstices and equinoxes, with whole hours on the local clock', () => {
    const day = localDay(NEW_YORK, { year: 2026, month: 9, day: 24 });
    const data = computeSunPath(engine, { observer: PHILLY, zone: NEW_YORK, day, options: OPTIONS });
    expect(data.raw.path.points.length).toBeGreaterThan(140);
    expect(data.envelope.map((e) => e.kind)).toEqual(['march_equinox', 'june_solstice', 'september_equinox', 'december_solstice']);
    expect(data.today.everUp).toBe(true);
    expect(data.today.runs).toHaveLength(1);
    // The highest sample is the engine's own.
    const top = Math.max(...data.raw.path.points.map((p) => p.alt_apparent_deg));
    expect(data.today.peak?.alt).toBe(top);
    // Whole hours from about 07 to 18 EDT, each one a sample of the engine's path.
    const hours = data.hours.map((m) => m.hour);
    expect(hours[0]).toBeGreaterThanOrEqual(6);
    expect(hours.at(-1)).toBeLessThanOrEqual(19);
    for (const m of data.hours) {
      const sample = data.raw.path.points.find((p) => p.jd_utc === m.jd);
      expect(sample?.alt_apparent_deg).toBe(m.alt);
      expect(sample?.az_deg).toBe(m.az);
      expect(m.alt).toBeGreaterThanOrEqual(0);
    }
    // June is higher than December, north of the equator.
    const june = data.envelope.find((e) => e.kind === 'june_solstice')!;
    const dec = data.envelope.find((e) => e.kind === 'december_solstice')!;
    expect(june.peak!.alt).toBeGreaterThan(dec.peak!.alt + 40);
  });

  it('knows the midnight sun and the polar night', () => {
    const june = computeSunPath(engine, { observer: TROMSO, zone: OSLO, day: localDay(OSLO, { year: 2026, month: 6, day: 21 }), options: OPTIONS });
    expect(june.today.alwaysUp).toBe(true);
    const dec = june.envelope.find((e) => e.kind === 'december_solstice')!;
    expect(dec.everUp).toBe(false);
    expect(dec.runs).toEqual([]);
  });

  it('marks hours by the clock on the day the clocks change (23-hour day)', () => {
    const day = localDay(NEW_YORK, { year: 2026, month: 3, day: 8 });
    expect(day.hours).toBe(23);
    const data = computeSunPath(engine, { observer: PHILLY, zone: NEW_YORK, day, options: OPTIONS });
    const hours = data.hours.map((m) => m.hour);
    expect(new Set(hours).size).toBe(hours.length);
    expect(hours).not.toContain(2);
    expect(hourMarks(day, data.raw.path.points, NEW_YORK)).toEqual(data.hours);
  });
});

describe('the sky projection of the analemma', () => {
  it('is one degree to one unit at its centre, up is up and right is increasing azimuth', () => {
    const p = stereographic(180, 45);
    const c = p(180, 45)!;
    expect(c.x).toBeCloseTo(0, 12);
    expect(c.y).toBeCloseTo(0, 12);
    const up = p(180, 46)!;
    expect(up.y).toBeCloseTo(1, 4);
    expect(Math.abs(up.x)).toBeLessThan(1e-9);
    const right = p(181.4142, 45)!;
    // One degree along the altitude circle at 45° is 1.414° of azimuth.
    expect(right.x).toBeCloseTo(1, 3);
    expect(Math.abs(right.y)).toBeLessThan(0.02);
  });

  it('keeps shapes (conformal) and passes through the zenith', () => {
    const p = stereographic(180, 85);
    // A point 2° past the zenith, on the far side, lands 7° above the centre.
    const beyond = p(0, 88)!;
    expect(beyond.y).toBeCloseTo(7, 1);
    expect(Math.abs(beyond.x)).toBeLessThan(1e-9);
    // Refuses the far side of the sky.
    expect(p(0, -80)).toBeNull();
  });

  it('centres on the mean direction of the points', () => {
    const m = meanDirection([
      { az: 170, alt: 40 },
      { az: 190, alt: 40 },
    ]);
    expect(m.az).toBeCloseTo(180, 9);
    expect(m.alt).toBeGreaterThan(40);
    const v = enu(90, 0);
    expect(v[0]).toBeCloseTo(1, 12);
  });

  it('gives the engine’s points and every first of the month', () => {
    const data = computeAnalemma(engine, { observer: PHILLY, year: 2026, timeH: 12, clock: 'lmt', zoneOffsetH: -5 });
    expect(data.raw.points).toHaveLength(365);
    expect(data.monthFirsts).toHaveLength(12);
    expect(data.monthFirsts.map((i) => data.raw.points[i]!.date.slice(5))).toEqual(
      ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].map((m) => `${m}-01`),
    );
    // At noon local mean time the figure is centred near the meridian, due south.
    expect(Math.abs(azDelta(180, data.centre.az))).toBeLessThan(3);
    const zone = computeAnalemma(engine, { observer: PHILLY, year: 2026, timeH: 9, clock: 'zone', zoneOffsetH: -5 });
    expect(zone.raw.clock).toBe('zone');
    expect(zone.raw.utc_offset_hours).toBe(-5);
    expect(zone.centre.az).toBeLessThan(180);
  });
});

describe('sunrise and sunset bearings, equation of time, solar panel', () => {
  it('lays each local day of the year out with its rise, set and solar noon: rise_set_azimuths’ numbers', () => {
    const year = computeYear(engine, { observer: PHILLY, zone: NEW_YORK, year: 2026, options: OPTIONS });
    const data = bearingsFromYear(2026, year.days);
    expect(data.days).toHaveLength(365);
    expect(data.missing).toBe(0);
    expect(data.days.map((d) => d.index)).toEqual(Array.from({ length: 365 }, (_, i) => i));
    for (const d of data.days) {
      expect(d.rise!.az).toBeGreaterThan(0);
      expect(d.rise!.az).toBeLessThan(180);
      expect(d.set!.az).toBeGreaterThan(180);
      expect(d.transit!.alt).toBeGreaterThan(20);
    }
    expect(data.riseRange!.min).toBeLessThan(65);
    expect(data.riseRange!.max).toBeGreaterThan(115);
    expect(data.setRange!.max).toBeGreaterThan(295);
    // The same event finder as rise_set_azimuths: the same sunrises, on every day.
    const rsa = engine.riseSetAzimuths(PHILLY, { body: 'Sun', year: 2026, utc_offset_hours: -5, options: OPTIONS });
    let worstS = 0;
    let worstAz = 0;
    for (const d of data.days) {
      const other = rsa.days.flatMap((x) => x.rises).find((r) => Math.abs(r.jd_utc - d.rise!.jd) < 0.01);
      expect(other).toBeDefined();
      worstS = Math.max(worstS, Math.abs(other!.jd_utc - d.rise!.jd) * 86_400);
      worstAz = Math.max(worstAz, Math.abs(other!.az_deg - d.rise!.az));
    }
    expect(worstS).toBeLessThan(1);
    expect(worstAz).toBeLessThan(0.01);
  });

  it('leaves out the days the engine cannot compute, and counts them', () => {
    const data = bearingsFromYear(2026, [
      { day: { key: '2026-01-01', date: { year: 2026 } }, events: [], alwaysAbove: false, alwaysBelow: false, error: 'outside' },
      { day: { key: '2026-01-02', date: { year: 2026 } }, events: [{ kind: 'rise', jd: 1, az: 120, alt: -0.83 }, { kind: 'set', jd: 1.4, az: 240, alt: -0.83 }, { kind: 'set', jd: 1.9, az: 250, alt: -0.83 }], alwaysAbove: false, alwaysBelow: false, error: null },
    ]);
    expect(data.missing).toBe(1);
    expect(data.days).toHaveLength(1);
    expect(data.days[0]).toMatchObject({ index: 1, rise: { jd: 1, az: 120 }, set: { jd: 1.9, az: 250 }, transit: null });
  });

  it('keeps the equation of time’s four turning points', () => {
    const data = computeEot(engine, 2026);
    expect(data.raw.points).toHaveLength(365);
    expect(data.raw.extremes.map((e) => e.kind)).toEqual(['minimum', 'maximum', 'minimum', 'maximum']);
  });

  it('tilts the default panel at the latitude, facing the equator', () => {
    expect(defaultPanel(39.95)).toEqual({ tilt: 40, azimuth: 180 });
    expect(defaultPanel(-33.86)).toEqual({ tilt: 34, azimuth: 0 });
    expect(defaultPanel(89.9)).toEqual({ tilt: 90, azimuth: 180 });
  });

  it('shows the engine’s clear-sky year, its best and worst days and the best tilt', () => {
    const data = computeSolarYear(engine, { observer: PHILLY, year: 2026, offsetH: -5, panel: { tilt: 40, azimuth: 180 } });
    expect(data.year.days).toHaveLength(365);
    expect(data.index).toEqual(data.year.days.map((d) => dayOfYearOf(d.date)));
    const poa = data.year.days.map((d) => d.poa_kwh_m2);
    expect(data.best!.poa).toBe(Math.max(...poa));
    expect(data.worst!.poa).toBe(Math.min(...poa));
    expect(data.year.optimal).not.toBeNull();
    expect(data.year.model.label).toBe('clear-sky estimate');
    const southern = computeSolarYear(engine, { observer: SYDNEY, year: 2026, offsetH: 10, panel: defaultPanel(SYDNEY.lat_deg) });
    expect(southern.year.panel.azimuth_deg).toBe(0);
    const day = computeSolarDay(engine, PHILLY, localDay(NEW_YORK, { year: 2026, month: 9, day: 24 }), { tilt: 40, azimuth: 180 });
    expect(day.panel.tilt_deg).toBe(40);
    expect(day.poa_kwh_m2).toBeGreaterThan(day.ghi_kwh_m2);
  });
});
