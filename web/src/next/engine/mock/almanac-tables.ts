/**
 * MOCK almanac tables and three-day openings (almanac2 agent), for developing the
 * Almanac view without the WebAssembly core (`?engine=mock`). Same shapes and the same
 * printed conventions as `skyfix_almanac::tables` and `::opening`; the formula-only tables
 * (increments, arc to time) use the same formulas, the rest is illustrative: a simple
 * Moon, Polaris at a fixed mean position, Venus and Mars at a constant parallax. Nothing
 * here comes from the SkyFix Lab numerical core.
 */

import type {
  AlmanacCalendarChoice,
  AlmanacDay,
  AlmanacOpening,
  AltitudeTables,
  ArcminCell,
  ArcToTime,
  CalendarKind,
  CriticalTable,
  IncrementsMinute,
  PlanetCorrections,
  PolarisTable,
  RefractionConditions,
} from '../types.js';
import { civilFromJdn, eraOf, formatYear, jdnFromCivil } from './timescale.js';

const MOCK_NOTE = 'MOCK ENGINE: illustrative tables for interface development, not from the SkyFix Lab numerical core.';
const BANNER = 'Simulation and analysis workbench. Not a navigation instrument.';
const ZONES = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'J', 'K', 'L', 'M', 'N'];
const ADDITIONAL_ALTS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 6, 7, 8, 9, 10, 12, 14, 16, 18, 20, 25, 30, 35, 40, 50];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RAD = Math.PI / 180;

// ---------------------------------------------------------------------------
// Printing (half up), as the Rust prints
// ---------------------------------------------------------------------------

export function tenthsHalfUp(x: number): number {
  return Math.floor(x * 10 + 0.5);
}

function fmtTenths(t: number): string {
  const a = Math.abs(t);
  return `${t < 0 ? '-' : ''}${Math.floor(a / 10)}.${a % 10}`;
}

function fmtSigned(t: number): string {
  return t > 0 ? `+${fmtTenths(t)}` : fmtTenths(t);
}

function fmtDegMinTenths(t: number): string {
  const a = Math.abs(t);
  return `${t < 0 ? '-' : ''}${Math.floor(a / 600)} ${String(Math.floor((a % 600) / 10)).padStart(2, '0')}.${a % 10}`;
}

function fmtDegMinWhole(m: number): string {
  return `${Math.floor(m / 60)} ${String(m % 60).padStart(2, '0')}`;
}

function signed(arcmin: number): ArcminCell {
  return { arcmin, printed: fmtSigned(tenthsHalfUp(arcmin)) };
}

function plain(arcmin: number): ArcminCell {
  return { arcmin, printed: fmtTenths(tenthsHalfUp(arcmin)) };
}

// ---------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------

function calendarOf(choice: AlmanacCalendarChoice | undefined): CalendarKind | null {
  if (choice === 'julian' || choice === 'gregorian') return choice;
  return null;
}

/** The three JDNs of the opening containing `jdn`, and its index (the Rust rule). */
export function openingJdns(jdn: number, calendar: CalendarKind | null): { jdns: number[]; index: number } {
  const shown = calendar ?? (jdn < 2_299_161 ? 'julian' : 'gregorian');
  const [year] = civilFromJdn(shown, jdn);
  const startCal: CalendarKind = calendar ?? (year <= 1582 ? 'julian' : 'gregorian');
  const start = jdnFromCivil(startCal, year, 1, 1);
  const index = (((jdn - start) % 3) + 3) % 3;
  const first = jdn - index;
  return { jdns: [first, first + 1, first + 2], index };
}

function wireDate(jdn: number): string {
  const [y, m, d] = civilFromJdn('gregorian', jdn);
  return `${formatYear(y)}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function mockAlmanacOpening(
  almanacDay: (date: string) => AlmanacDay,
  date: string,
  choice: AlmanacCalendarChoice = '',
): AlmanacOpening {
  const m = /^([+-]?\d{4,})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) throw new Error(`date must be a UT calendar date written YYYY-MM-DD, got ${JSON.stringify(date)}`);
  const cal = calendarOf(choice);
  const jdn = jdnFromCivil('gregorian', Number(m[1]), Number(m[2]), Number(m[3]));
  const { jdns, index } = openingJdns(jdn, cal);
  const days = jdns.map((j) => almanacDay(wireDate(j)));
  const shown: CalendarKind = cal ?? (jdn < 2_299_161 ? 'julian' : 'gregorian');
  return {
    date: wireDate(jdn),
    calendar: shown,
    index,
    dates: jdns.map((j) => {
      const c: CalendarKind = cal ?? (j < 2_299_161 ? 'julian' : 'gregorian');
      const [year, month, day] = civilFromJdn(c, j);
      const { era_year, era } = eraOf(year);
      return { date: wireDate(j), calendar: c, year, month, day, era_year, era, weekday: WEEKDAYS[(((j + 1) % 7) + 7) % 7]! };
    }),
    days,
    moon_dates: [days[0]!.date, days[1]!.date, days[2]!.date, days[2]!.rise_set.moon_dates[1] ?? ''],
    moon_rows: days[1]!.rise_set.rows.map((row, i) => ({
      lat_deg: row.lat_deg,
      label: row.label,
      moonrise: [days[0]!.rise_set.rows[i]!.moonrise[0]!, days[1]!.rise_set.rows[i]!.moonrise[0]!, days[2]!.rise_set.rows[i]!.moonrise[0]!, days[2]!.rise_set.rows[i]!.moonrise[1]!],
      moonset: [days[0]!.rise_set.rows[i]!.moonset[0]!, days[1]!.rise_set.rows[i]!.moonset[0]!, days[2]!.rise_set.rows[i]!.moonset[0]!, days[2]!.rise_set.rows[i]!.moonset[1]!],
    })),
    planet_sha_00h: days[1]!.planets.map((p) => ({ body: p.body, sha_deg: p.sha_deg, printed: { gha: p.printed.sha } })),
    notes: [MOCK_NOTE, ...days[1]!.notes],
    errors: days.flatMap((d) => d.errors),
  };
}

// ---------------------------------------------------------------------------
// Increments and arc to time (the same formulas as the core)
// ---------------------------------------------------------------------------

export function mockIncrements(minute: number): IncrementsMinute {
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new Error(`the increments tables run from minute 0 to 59, not ${minute}`);
  }
  const aries = 360.98564736629 / 24;
  const rows = Array.from({ length: 61 }, (_, s) => {
    const secs = 60 * minute + s;
    return {
      second: s,
      sun_planets: { arcmin: secs / 4, printed: fmtDegMinTenths(Math.floor((secs * 10 + 2) / 4)) },
      aries: { arcmin: (aries * secs) / 60, printed: fmtDegMinTenths(Math.floor(((aries * secs) / 60) * 10 + 0.5)) },
      moon: { arcmin: (859 * secs) / 3600, printed: fmtDegMinTenths(Math.floor((2 * 859 * secs + 360) / 720)) },
    };
  });
  const corrections = Array.from({ length: 181 }, (_, v) => ({
    v_arcmin: v / 10,
    v_printed: fmtTenths(v),
    correction: { arcmin: ((v / 10) * (minute + 0.5)) / 60, printed: fmtTenths(Math.floor((v * (2 * minute + 1) + 60) / 120)) },
  }));
  return {
    minute,
    rows,
    corrections,
    how_to_use: 'Take GHA for the hour from the daily page; add the increment for the minutes and seconds, then the v correction; correct the declination by d.',
    example: 'Deneb at 08h 58m 27s UT: the 58-minute page, 27-second line, Aries column gives 14° 39.2′.',
    notes: [MOCK_NOTE, BANNER],
  };
}

export function mockArcToTime(): ArcToTime {
  const hm = (min: number): string => `${Math.floor(min / 60)} ${String(min % 60).padStart(2, '0')}`;
  return {
    degrees: Array.from({ length: 360 }, (_, deg) => ({ deg, minutes: 4 * deg, printed: hm(4 * deg) })),
    arcminutes: Array.from({ length: 60 }, (_, arcmin) => {
      const seconds = [0, 1, 2, 3].map((q) => 4 * arcmin + q);
      return { arcmin, seconds, printed: seconds.map(hm) };
    }),
    how_to_use: 'Add the time for the whole degrees to the time for the minutes of arc: 1° is 4 minutes of time, 1′ is 4 seconds.',
    example: 'Longitude 44° 27′: 2 h 56 m + 1 m 48 s = 2 h 57 m 48 s.',
    notes: [MOCK_NOTE, BANNER],
  };
}

// ---------------------------------------------------------------------------
// Altitude corrections (Bennett; a simple Moon)
// ---------------------------------------------------------------------------

function refraction(ha: number): number {
  return 1 / Math.tan((ha + 7.31 / (ha + 4.4)) * RAD);
}

function criticalOnGrid(start: number, end: number, lookback: number, value: (i: number) => number[]): { bounds: number[]; values: number[][] } {
  const same = (a: number[], b: number[]): boolean => a.every((x, k) => x === b[k]);
  const atStart = value(start);
  let first = start;
  for (let i = start - 1; i >= start - lookback; i -= 1) {
    if (!same(value(i), atStart)) {
      first = i;
      break;
    }
  }
  const bounds = [first];
  const values: number[][] = [];
  let current = value(first + 1);
  for (let i = first + 1; i < end; i += 1) {
    const next = value(i + 1);
    if (!same(next, current)) {
      bounds.push(i);
      values.push(current);
      current = next;
    }
  }
  bounds.push(end);
  values.push(current);
  return { bounds, values };
}

function altitudeCritical(columns: string[], value: (ha: number) => number[]): CriticalTable {
  const { bounds, values } = criticalOnGrid(600, 5400, 120, (i) => value(i / 60));
  return {
    argument: 'apparent altitude',
    unit: 'deg_min',
    columns,
    boundaries: bounds.map((i) => ({ value: i / 60, printed: fmtDegMinWhole(i) })),
    values: values.map((row) => row.map((t) => ({ arcmin: t / 10, printed: fmtSigned(t) }))),
  };
}

function sunLimbs(ha: number, sd: number): [number, number] {
  const upper = tenthsHalfUp(-refraction(ha) + (8.794 / 60) * Math.cos(ha * RAD) - sd);
  return [upper + Math.round(20 * sd), upper];
}

function dipCritical(unit: 'm' | 'ft', start: number, end: number, toM: number): CriticalTable {
  const { bounds, values } = criticalOnGrid(start, end, 20, (i) => [tenthsHalfUp(-1.76 * Math.sqrt((i / 10) * toM))]);
  return {
    argument: 'height of eye',
    unit,
    columns: ['Dip'],
    boundaries: bounds.map((i) => ({ value: i / 10, printed: `${Math.floor(i / 10)}.${i % 10}` })),
    values: values.map((row) => row.map((t) => ({ arcmin: t / 10, printed: fmtSigned(t) }))),
  };
}

/** A simple Moon: −R + SD (augmented) + HP cos h, illustrative. */
function moonCorrection(ha: number, hp: number, lower: boolean): number {
  const sd = 0.2725 * hp * (1 + Math.sin((hp / 60) * RAD) * Math.sin(ha * RAD));
  const h = ha - refraction(ha) / 60 + ((lower ? 1 : -1) * sd) / 60;
  return -refraction(ha) + (lower ? sd : -sd) + hp * Math.cos(h * RAD);
}

export function mockAltitudeTables(conditions?: RefractionConditions | null): AltitudeTables {
  const hps = Array.from({ length: 26 }, (_, k) => 54 + 0.3 * k);
  const lowMinutes = [
    ...Array.from({ length: 31 }, (_, k) => 3 * k),
    ...Array.from({ length: 54 }, (_, k) => 95 + 5 * k),
    ...Array.from({ length: 24 }, (_, k) => 370 + 10 * k),
  ];
  const factor = (k: number): number => 1 + (6 - k) * 0.02;
  const cond = conditions
    ? (() => {
        const f = (conditions.pressure_hpa / 1010) * (283 / (273 + conditions.temperature_c));
        const k = Math.round(6 - (f - 1) / 0.02);
        return {
          ...conditions,
          factor: f,
          zone: k >= 0 && k <= 12 ? ZONES[k]! : null,
          corrections: ADDITIONAL_ALTS.map((ha) => signed(refraction(ha) * (1 - f))),
        };
      })()
    : null;
  return {
    refraction: { model: 'Bennett (1982) — MOCK', pressure_hpa: 1010, temperature_c: 10 },
    sun_sd_oct_mar_arcmin: 16.15,
    sun_sd_apr_sep_arcmin: 15.9,
    sun_hp_arcmin: 8.794 / 60,
    sun_oct_mar: altitudeCritical(['Lower limb', 'Upper limb'], (ha) => sunLimbs(ha, 16.15)),
    sun_apr_sep: altitudeCritical(['Lower limb', 'Upper limb'], (ha) => sunLimbs(ha, 15.9)),
    stars_planets: altitudeCritical(['Corr'], (ha) => [tenthsHalfUp(-refraction(ha))]),
    low: lowMinutes.map((m) => {
      const ha = m / 60;
      const cells = (sd: number): [ArcminCell, ArcminCell] => {
        const [l, u] = sunLimbs(ha, sd);
        return [
          { arcmin: l / 10, printed: fmtSigned(l) },
          { arcmin: u / 10, printed: fmtSigned(u) },
        ];
      };
      return { alt_deg: ha, printed_alt: fmtDegMinWhole(m), sun_oct_mar: cells(16.15), sun_apr_sep: cells(15.9), stars_planets: signed(-refraction(ha)) };
    }),
    dip: {
      metres: dipCritical('m', 24, 214, 1),
      feet: dipCritical('ft', 80, 705, 0.3048),
      more_metres: [1, 1.5, 2, 22, 24, 26, 28, 30].map((h) => ({ height: h, printed_height: String(h), dip: signed(-1.76 * Math.sqrt(h)) })),
      more_feet: [2, 4, 6, 75, 80, 90, 100].map((h) => ({ height: h, printed_height: String(h), dip: signed(-1.76 * Math.sqrt(h * 0.3048)) })),
    },
    additional: {
      zones: ZONES.map((letter, k) => ({ letter, factor: factor(k), factor_low: factor(k) - 0.01, factor_high: factor(k) + 0.01 })),
      rows: ADDITIONAL_ALTS.map((ha) => ({
        alt_deg: ha,
        printed_alt: fmtDegMinWhole(Math.round(ha * 60)),
        standard_refraction_arcmin: refraction(ha),
        corrections: ZONES.map((_, k) => signed(refraction(ha) * (1 - factor(k)))),
      })),
      chart: { temperature_c: [-20, 40], pressure_hpa: [970, 1050] },
      conditions: cond,
    },
    moon: {
      hp0_arcmin: 57.7,
      hp_rows: hps,
      columns: Array.from({ length: 18 }, (_, c) => {
        const from = 5 * c;
        const mid = from + 2.5;
        const base = moonCorrection(mid, 57.7, true);
        return {
          from_deg: from,
          upper: Array.from({ length: 30 }, (_, r) => plain(moonCorrection(from + r / 6, 57.7, true) - 5)),
          lower_alt_deg: mid,
          lower_limb: hps.map((hp) => plain(moonCorrection(mid, hp, true) - base + 5)),
          upper_limb: hps.map((hp) => plain(moonCorrection(mid, hp, false) - base + 35)),
        };
      }),
      how_to_use: 'Upper part by apparent altitude, lower part by HP in the same column; subtract 30′ for the upper limb.',
      notes: [MOCK_NOTE],
    },
    how_to_use: ['Correct the sextant altitude for index error and dip, then enter the table for the body with the apparent altitude.'],
    examples: [{ title: 'A star', text: 'Apparent altitude 50° 26.6′: the Stars and Planets column gives the correction (illustrative).' }],
    notes: [MOCK_NOTE, BANNER],
  };
}

// ---------------------------------------------------------------------------
// Venus and Mars, Polaris (illustrative)
// ---------------------------------------------------------------------------

function yearCalendar(year: number, choice: AlmanacCalendarChoice | undefined): CalendarKind {
  return calendarOf(choice) ?? (year <= 1582 ? 'julian' : 'gregorian');
}

function parallaxTable(hp: number): CriticalTable {
  const { bounds, values } = criticalOnGrid(0, 90, 0, (d) => [tenthsHalfUp(hp * Math.cos(d * RAD))]);
  return {
    argument: 'apparent altitude',
    unit: 'deg',
    columns: ['Corr'],
    boundaries: bounds.map((d) => ({ value: d, printed: String(d) })),
    values: values.map((row) => row.map((t) => ({ arcmin: t / 10, printed: fmtSigned(t) }))),
  };
}

export function mockPlanetCorrections(year: number, choice?: AlmanacCalendarChoice): PlanetCorrections {
  const calendar = yearCalendar(year, choice);
  const start = jdnFromCivil(calendar, year, 1, 1) - 0.5;
  const end = jdnFromCivil(calendar, year + 1, 1, 1) - 1.5;
  const period = (hp: number) => ({
    from: { year, month: 1, day: 1 },
    to: { year, month: 12, day: 31 },
    from_jd_utc: start,
    to_jd_utc: end,
    hp_arcmin: hp,
    table: parallaxTable(hp),
  });
  return {
    year,
    calendar,
    venus: [period(0.2)],
    mars: [period(0.1)],
    how_to_use: 'Find the date range, then the correction for the apparent altitude.',
    notes: [MOCK_NOTE, BANNER],
    errors: [],
  };
}

export function mockPolaris(year: number, choice?: AlmanacCalendarChoice): PolarisTable {
  const calendar = yearCalendar(year, choice);
  const sha0 = 316.8 - 0.34 * (year - 2016);
  const dec0 = 89.332 + 0.0047 * (year - 2016);
  const p0 = (90 - dec0) * 60;
  const tan50 = Math.tan(50 * RAD);
  const second = (h0: number): number => 0.5 * p0 * Math.sin((p0 / 60) * RAD) * Math.sin(h0 * RAD) ** 2;
  const months = Array.from({ length: 12 }, (_, k) => ({
    month: k + 1,
    jd_utc: jdnFromCivil(calendar, year, k + 1, 15) - 0.5,
    sha_deg: sha0 + 0.25 * Math.sin(((k - 2) / 12) * 2 * Math.PI),
    dec_deg: dec0 + 0.004 * Math.cos(((k - 5) / 12) * 2 * Math.PI),
  }));
  const a1Lats = [0, 10, 20, 30, 40, 45, 50, 55, 60, 62, 64, 66, 68];
  const azLats = [0, 20, 40, 50, 55, 60, 65];
  const columns = Array.from({ length: 36 }, (_, c) => {
    const from = 10 * c;
    const h0 = from + 5 + sha0;
    return {
      from_deg: from,
      a0: Array.from({ length: 11 }, (_, r) => {
        const h = from + r + sha0;
        const v = 58.8 - p0 * Math.cos(h * RAD) + second(h) * tan50;
        return { arcmin: v, printed: fmtDegMinTenths(tenthsHalfUp(v)) };
      }),
      a1: a1Lats.map((lat) => plain(0.6 + second(h0) * (Math.tan(lat * RAD) - tan50))),
      a2: months.map((m) => plain(0.6 - (90 - m.dec_deg) * 60 * Math.cos((from + 5 + m.sha_deg) * RAD) + p0 * Math.cos(h0 * RAD))),
      azimuth: azLats.map((lat) => {
        const z = (Math.atan2(-Math.sin(h0 * RAD), Math.cos(lat * RAD) * Math.tan(dec0 * RAD) - Math.sin(lat * RAD) * Math.cos(h0 * RAD)) / RAD + 360) % 360;
        const t = ((tenthsHalfUp(z) % 3600) + 3600) % 3600;
        return { deg: z, printed: `${Math.floor(t / 10)}.${t % 10}` };
      }),
    };
  });
  return {
    year,
    calendar,
    mean_sha_deg: sha0,
    mean_dec_deg: dec0,
    printed_mean: { sha: fmtDegMinTenths(tenthsHalfUp(sha0 * 60)), dec: `N ${Math.floor(dec0)} ${((dec0 % 1) * 60).toFixed(1)}` },
    polar_distance_arcmin: p0,
    formula_error_arcmin: 0.006,
    a1_latitudes: a1Lats,
    azimuth_latitudes: azLats,
    months,
    columns,
    how_to_use: 'Latitude = Ho − 1° + a0 + a1 + a2, with a0 for LHA Aries, a1 for the latitude and a2 for the month.',
    example: null,
    notes: [MOCK_NOTE, BANNER],
    warnings: [],
  };
}
