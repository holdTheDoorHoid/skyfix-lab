/**
 * MOCK ENGINE ONLY — time scales, Delta-T and calendars for developing the interface.
 *
 * The shapes, scale boundaries, calendars, sources and uncertainty rules are those of
 * the Rust core (`skyfix_core::{time, deltat, calendar}`, CONVENTIONS 15.2-15.3,
 * EXPLORER_API.md "time_info"). The calendars are exact. Delta-T is the Rust model
 * without its IERS table: the Stephenson-Morrison-Hohenkerk 2020 splines to 2019, a
 * straight line to the table's end (2027.74, 69.330 s), the same joins to the
 * long-term parabola; it is within 0.3 s of the real model over 1973-2027 and equal
 * elsewhere. DUT1 is not modelled: 0 (`assumed`) on the UTC scale unless set, 0
 * (`model`) on the UT scale, as the real engine does where it has no IERS value.
 */

import type {
  CalendarConversion,
  CalendarConvertRequest,
  CalendarKind,
  CivilDate,
  CoverageTier,
  DeltaTSource,
  Dut1Source,
  TimeInfo,
  TimeScale,
} from '../types.js';

// ---------------------------------------------------------------------------
// Calendars (exact integer arithmetic, as skyfix_core::calendar)
// ---------------------------------------------------------------------------

const JDN_MARCH_0_GREGORIAN = 1_721_120;
const JDN_MARCH_0_JULIAN = 1_721_118;
const JDN_UNIX_EPOCH = 2_440_588;
/** JD of 1582-10-15T00:00 (Gregorian), the day after Julian 1582-10-04. */
export const GREGORIAN_START_JD = 2_299_160.5;

function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function mod(a: number, b: number): number {
  return a - b * Math.floor(a / b);
}

export function isLeapYear(calendar: CalendarKind, year: number): boolean {
  if (calendar === 'julian') return mod(year, 4) === 0;
  return mod(year, 4) === 0 && (mod(year, 100) !== 0 || mod(year, 400) === 0);
}

export function daysInMonth(calendar: CalendarKind, year: number, month: number): number | null {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (month === 2) return isLeapYear(calendar, year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function jdnFromCivil(calendar: CalendarKind, year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const mp = mod(month + 9, 12);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  if (calendar === 'gregorian') {
    const era = floorDiv(y, 400);
    const yoe = y - era * 400;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146_097 + doe + JDN_MARCH_0_GREGORIAN;
  }
  const era = floorDiv(y, 4);
  const yoe = y - era * 4;
  return era * 1_461 + yoe * 365 + doy + JDN_MARCH_0_JULIAN;
}

export function civilFromJdn(calendar: CalendarKind, jdn: number): [number, number, number] {
  let y: number;
  let doy: number;
  if (calendar === 'gregorian') {
    const z = jdn - JDN_MARCH_0_GREGORIAN;
    const era = floorDiv(z, 146_097);
    const doe = mod(z, 146_097);
    const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
    y = yoe + era * 400;
    doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  } else {
    const z = jdn - JDN_MARCH_0_JULIAN;
    const era = floorDiv(z, 1_461);
    const doe = mod(z, 1_461);
    const yoe = Math.floor((doe - Math.floor(doe / 1_460)) / 365);
    y = yoe + era * 4;
    doy = doe - 365 * yoe;
  }
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  return [month <= 2 ? y + 1 : y, month, day];
}

export function calendarFor(jd: number): CalendarKind {
  return jd < GREGORIAN_START_JD ? 'julian' : 'gregorian';
}

export function eraOf(year: number): { era_year: number; era: 'BC' | 'AD' } {
  return year >= 1 ? { era_year: year, era: 'AD' } : { era_year: 1 - year, era: 'BC' };
}

/** `-0584`, `2026`, `+12345`: ISO 8601 expanded years outside 0000-9999. */
export function formatYear(year: number): string {
  if (year >= 0 && year <= 9999) return String(year).padStart(4, '0');
  if (year < 0) return `-${String(-year).padStart(4, '0')}`;
  return `+${year}`;
}

/** The civil date and time of `jd` in `calendar`, rounded to the millisecond. */
export function civilFromJd(jd: number, calendar: CalendarKind): CivilDate {
  const ms = Math.round((jd - 2_440_587.5) * 86_400_000);
  const days = floorDiv(ms, 86_400_000);
  const msOfDay = ms - days * 86_400_000;
  const [year, month, day] = civilFromJdn(calendar, days + JDN_UNIX_EPOCH);
  return {
    calendar,
    year,
    month,
    day,
    hour: Math.floor(msOfDay / 3_600_000),
    minute: Math.floor(msOfDay / 60_000) % 60,
    second: (msOfDay % 60_000) / 1000,
    ...eraOf(year),
  };
}

/** The wire timestamp: proleptic Gregorian, expanded years, milliseconds, `Z`. */
export function formatUtc(jd: number): string {
  if (!Number.isFinite(jd)) return `JD ${jd}`;
  const c = civilFromJd(jd, 'gregorian');
  const ms = Math.round(c.second * 1000);
  const two = (n: number): string => String(n).padStart(2, '0');
  return (
    `${formatYear(c.year)}-${two(c.month)}-${two(c.day)}T${two(c.hour)}:${two(c.minute)}:` +
    `${two(Math.floor(ms / 1000))}.${String(ms % 1000).padStart(3, '0')}Z`
  );
}

/** Julian date of a civil instant; throws a string on an impossible date or time. */
export function jdFromCivil(
  calendar: CalendarKind,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  const max = daysInMonth(calendar, year, month);
  if (max === null) throw `month ${month} is not 1-12`;
  if (!Number.isInteger(year) || !Number.isInteger(day) || day < 1 || day > max) {
    throw `${calendar} ${year}-${month} has ${max} days, not ${day}`;
  }
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    !(second >= 0 && second <= 60)
  ) {
    throw `time of day ${hour}:${minute}:${second} is out of range`;
  }
  const jdn = jdnFromCivil(calendar, year, month, day);
  return 2_440_587.5 + ((jdn - JDN_UNIX_EPOCH) * 86_400 + hour * 3_600 + minute * 60 + second) / 86_400;
}

export function calendarConvert(request: CalendarConvertRequest): CalendarConversion {
  const hasJd = request.jd_utc !== undefined && request.jd_utc !== null;
  const hasCivil = request.civil !== undefined && request.civil !== null;
  if (hasJd === hasCivil) throw 'give exactly one of jd_utc or civil';
  let jd: number;
  if (hasJd) {
    jd = request.jd_utc as number;
    if (!Number.isFinite(jd)) throw `jd_utc ${jd} is not finite`;
  } else {
    const c = request.civil!;
    if (c.calendar !== 'julian' && c.calendar !== 'gregorian') throw `calendar ${String(c.calendar)}: expected julian or gregorian`;
    if (c.era_year !== undefined && c.era !== undefined) {
      const y = c.era === 'AD' ? c.era_year : 1 - c.era_year;
      if (y !== c.year) throw `era_year ${c.era_year} ${c.era} is astronomical year ${y}, not ${c.year}`;
    }
    jd = jdFromCivil(c.calendar, c.year, c.month, c.day, c.hour ?? 0, c.minute ?? 0, c.second ?? 0);
  }
  return { jd_utc: jd, gregorian: civilFromJd(jd, 'gregorian'), julian: civilFromJd(jd, 'julian') };
}

// ---------------------------------------------------------------------------
// Time scales and Delta-T
// ---------------------------------------------------------------------------

/** First instant of the UTC scale (1972-01-01) and the first after it (2036-01-01). */
export const UTC_SCALE_START_JD = 2_441_317.5;
export const UTC_SCALE_END_JD = 2_464_693.5;

/** (JD of 0h UTC on the date, TAI - UTC). */
const LEAP_SECONDS: ReadonlyArray<readonly [number, number]> = [
  [2_441_317.5, 10], [2_441_499.5, 11], [2_441_683.5, 12], [2_442_048.5, 13], [2_442_413.5, 14],
  [2_442_778.5, 15], [2_443_144.5, 16], [2_443_509.5, 17], [2_443_874.5, 18], [2_444_239.5, 19],
  [2_444_786.5, 20], [2_445_151.5, 21], [2_445_516.5, 22], [2_446_247.5, 23], [2_447_161.5, 24],
  [2_447_892.5, 25], [2_448_257.5, 26], [2_448_804.5, 27], [2_449_169.5, 28], [2_449_534.5, 29],
  [2_450_083.5, 30], [2_450_630.5, 31], [2_451_179.5, 32], [2_453_736.5, 33], [2_454_832.5, 34],
  [2_456_109.5, 35], [2_457_204.5, 36], [2_457_754.5, 37],
];

export function deltaAt(jdUtc: number): number {
  let v = 10;
  for (const [jd, s] of LEAP_SECONDS) {
    if (jdUtc >= jd) v = s;
    else break;
  }
  return v;
}

export function scaleAt(jd: number): TimeScale {
  return jd >= UTC_SCALE_START_JD && jd < UTC_SCALE_END_JD ? 'utc' : 'ut';
}

/** Table S15.2020 (Morrison, Stephenson, Hohenkerk & Zawilski 2021): [K_i, K_i+1, a0..a3]. */
// prettier-ignore
const S15: ReadonlyArray<readonly [number, number, number, number, number, number]> = [
  [-720, -100, 20371.848, -9999.586, 776.247, 409.16], [-100, 400, 11557.668, -5822.27, 1303.151, -503.433],
  [400, 1000, 6535.116, -5671.519, -298.291, 1085.087], [1000, 1150, 1650.393, -753.21, 184.811, -25.346],
  [1150, 1300, 1056.647, -459.628, 108.771, -24.641], [1300, 1500, 681.149, -421.345, 61.953, -29.414],
  [1500, 1600, 292.343, -192.841, -6.572, 16.197], [1600, 1650, 109.127, -78.697, 10.505, 3.018],
  [1650, 1720, 43.952, -68.089, 38.333, -2.127], [1720, 1800, 12.068, 2.507, 41.731, -37.939],
  [1800, 1810, 18.367, -3.481, -1.126, 1.918], [1810, 1820, 15.678, 0.021, 4.629, -3.812],
  [1820, 1830, 16.516, -2.157, -6.806, 3.25], [1830, 1840, 10.804, -6.018, 2.944, -0.096],
  [1840, 1850, 7.634, -0.416, 2.658, -0.539], [1850, 1855, 9.338, 1.642, 0.261, -0.883],
  [1855, 1860, 10.357, -0.486, -2.389, 1.558], [1860, 1865, 9.04, -0.591, 2.284, -2.477],
  [1865, 1870, 8.255, -3.456, -5.148, 2.72], [1870, 1875, 2.371, -5.593, 3.011, -0.914],
  [1875, 1880, -1.126, -2.314, 0.269, -0.039], [1880, 1885, -3.21, -1.893, 0.152, 0.563],
  [1885, 1890, -4.388, 0.101, 1.842, -1.438], [1890, 1895, -3.884, -0.531, -2.474, 1.871],
  [1895, 1900, -5.017, 0.134, 3.138, -0.232], [1900, 1905, -1.977, 5.715, 2.443, -1.257],
  [1905, 1910, 4.923, 6.828, -1.329, 0.72], [1910, 1915, 11.142, 6.33, 0.831, -0.825],
  [1915, 1920, 17.479, 5.518, -1.643, 0.262], [1920, 1925, 21.617, 3.02, -0.856, 0.008],
  [1925, 1930, 23.789, 1.333, -0.831, 0.127], [1930, 1935, 24.418, 0.052, -0.449, 0.142],
  [1935, 1940, 24.164, -0.419, -0.022, 0.702], [1940, 1945, 24.426, 1.645, 2.086, -1.106],
  [1945, 1950, 27.05, 2.499, -1.232, 0.614], [1950, 1953, 28.932, 1.127, 0.22, -0.277],
  [1953, 1956, 30.002, 0.737, -0.61, 0.631], [1956, 1959, 30.76, 1.409, 1.282, -0.799],
  [1959, 1962, 32.652, 1.577, -1.115, 0.507], [1962, 1965, 33.621, 0.868, 0.406, 0.199],
  [1965, 1968, 35.093, 2.275, 1.002, -0.414], [1968, 1971, 37.956, 3.035, -0.242, 0.202],
  [1971, 1974, 40.951, 3.157, 0.364, -0.229], [1974, 1977, 44.244, 3.199, -0.323, 0.172],
  [1977, 1980, 47.291, 3.069, 0.193, -0.192], [1980, 1983, 50.361, 2.878, -0.384, 0.081],
  [1983, 1986, 52.936, 2.354, -0.14, -0.165], [1986, 1989, 54.984, 1.577, -0.637, 0.448],
  [1989, 1992, 56.373, 1.648, 0.708, -0.276], [1992, 1995, 58.453, 2.235, -0.121, 0.11],
  [1995, 1998, 60.678, 2.324, 0.21, -0.313], [1998, 2001, 62.898, 1.804, -0.729, 0.109],
  [2001, 2004, 64.083, 0.674, -0.402, 0.199], [2004, 2007, 64.553, 0.466, 0.194, -0.017],
  [2007, 2010, 65.197, 0.804, 0.144, -0.084], [2010, 2013, 66.061, 0.839, -0.109, 0.128],
  [2013, 2016, 66.92, 1.007, 0.277, -0.095], [2016, 2019, 68.109, 1.277, -0.007, -0.139],
];

/** The error column of Table DT-lod4500yrs.2020 at its change points, -720..2019. */
// prettier-ignore
const SMH_SIGMA: ReadonlyArray<readonly [number, number]> = [
  [-720, 180], [-700, 170], [-600, 160], [-500, 150], [-400, 130], [-300, 120], [-200, 110],
  [-100, 100], [0, 90], [100, 80], [200, 70], [300, 60], [400, 50], [500, 40], [600, 40],
  [700, 30], [800, 25], [900, 20], [1000, 15], [1610, 15], [1620, 20], [1650, 20], [1660, 15],
  [1670, 10], [1680, 5], [1720, 5], [1730, 2], [1760, 2], [1770, 1], [1790, 1], [1800, 0.5],
  [1801, 0.5], [1802, 0.4], [1804, 0.4], [1805, 0.3], [1808, 0.3], [1809, 0.2], [1830, 0.2],
  [1831, 0.1], [1870, 0.1], [1871, 0.05], [2019, 0.05],
];

/** The real model's table: first and last sample (Julian epoch, TT), last observed day. */
const TABLE_START_YEAR = 1973.0034;
const TABLE_END_YEAR = 2027.7385;
const TABLE_END_DELTA_T_S = 69.33;
const TABLE_END_SLOPE_S_PER_Y = 0.12706;
/** JD (UTC, 0h) of the last observed day, 2026-09-24. */
const LAST_OBSERVED_JD = 2_461_307.5;

function epochYear(jdTt: number): number {
  return (jdTt - 1_721_045.0) / 365.25;
}

function parabola(y: number): number {
  const t = (y - 1825) / 100;
  return -320 + 32.5 * t * t;
}

function parabolaSlope(y: number): number {
  return (0.65 * (y - 1825)) / 100;
}

/** Skyfield's `build_spline_given_ends`, evaluated at `y`. */
function hermite(y: number, x0: number, y0: number, s0: number, x1: number, y1: number, s1: number): number {
  const w = x1 - x0;
  const t = (y - x0) / w;
  const a1 = s0 * w;
  const a2 = -2 * s0 * w - s1 * w - 3 * y0 + 3 * y1;
  const a3 = s0 * w + s1 * w + 2 * y0 - 2 * y1;
  return ((a3 * t + a2) * t + a1) * t + y0;
}

function s15(y: number): number {
  let row = S15[0]!;
  for (const r of S15) {
    if (r[0] <= y) row = r;
    else break;
  }
  const t = (y - row[0]) / (row[1] - row[0]);
  return ((row[5] * t + row[4]) * t + row[3]) * t + row[2];
}

export function huberSigmaS(nYears: number): number {
  const n = Math.abs(nYears);
  return (365.25 * n * Math.sqrt(((n * 0.058) / 3) * (1 + n / 2500))) / 1000;
}

/** Delta-T at the TT instant `jdTt`: value, standard uncertainty, source. */
export function deltaT(jdTt: number): { value_s: number; sigma_s: number; source: DeltaTSource } {
  const y = epochYear(jdTt);
  const rejoin = Math.floor((TABLE_END_YEAR + 800) / 100) * 100;
  let value: number;
  let source: DeltaTSource;
  if (y < -1520) {
    value = parabola(y);
    source = 'parabola';
  } else if (y < -720) {
    const s0 = S15[0]!;
    value = hermite(y, -1520, parabola(-1520), parabolaSlope(-1520), -720, s0[2], s0[3] / (s0[1] - s0[0]));
    source = 'parabola';
  } else if (y < 2019) {
    value = s15(y);
    source = y < TABLE_START_YEAR ? 'smh2016' : 'iers';
  } else if (y <= TABLE_END_YEAR) {
    const a = s15(2019);
    value = a + ((TABLE_END_DELTA_T_S - a) * (y - 2019)) / (TABLE_END_YEAR - 2019);
    source = jdTt - 69.184 / 86_400 < LAST_OBSERVED_JD + 1 ? 'iers' : 'prediction';
  } else if (y < rejoin) {
    value = hermite(y, TABLE_END_YEAR, TABLE_END_DELTA_T_S, TABLE_END_SLOPE_S_PER_Y, rejoin, parabola(rejoin), parabolaSlope(rejoin));
    source = 'prediction';
  } else {
    value = parabola(y);
    source = 'parabola';
  }
  return { value_s: value, sigma_s: deltaTSigma(y, jdTt), source };
}

function deltaTSigma(y: number, jdTt: number): number {
  if (y < -720) return Math.max(180, huberSigmaS(-500 - y));
  if (y < TABLE_START_YEAR) {
    let s = SMH_SIGMA[SMH_SIGMA.length - 1]![1];
    for (let i = 1; i < SMH_SIGMA.length; i++) {
      const [yb, sb] = SMH_SIGMA[i]!;
      if (y <= yb) {
        const [ya, sa] = SMH_SIGMA[i - 1]!;
        s = sa + ((sb - sa) * (y - ya)) / (yb - ya);
        break;
      }
    }
    return Math.max(s, 0.11);
  }
  const nDays = jdTt - 69.184 / 86_400 - LAST_OBSERVED_JD;
  if (nDays <= 0) return 0.001;
  return Math.max(0.001, 0.00025 * nDays ** 0.75, huberSigmaS(nDays / 365.25));
}

/** TT - clock, seconds: 32.184 + (TAI - UTC) on the UTC scale, Delta-T on the UT scale. */
export function ttMinusClockS(jd: number): number {
  if (scaleAt(jd) === 'utc') return 32.184 + deltaAt(jd);
  const first = jd + deltaT(jd).value_s / 86_400;
  return deltaT(first).value_s;
}

export function dut1Info(jd: number, user: number | null): { value_s: number; sigma_s: number; source: Dut1Source } {
  if (scaleAt(jd) === 'ut') return { value_s: 0, sigma_s: 0, source: 'model' };
  if (user !== null && Number.isFinite(user)) return { value_s: user, sigma_s: 0.05, source: 'user' };
  return { value_s: 0, sigma_s: 0.9, source: 'assumed' };
}

/** Throws a string for anything but a finite value within +-1 s, or null. */
export function checkDut1(seconds: number | null): number | null {
  if (seconds === null) return null;
  if (!(Number.isFinite(seconds) && Math.abs(seconds) <= 1)) {
    throw `DUT1 ${seconds} s: UT1 - UTC stays within +-0.9 s while leap seconds last; give a value within +-1 s, or null`;
  }
  return seconds;
}

function humanDuration(s: number): string {
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

export function timeInfo(jdUtc: number, user: number | null, tier: CoverageTier): TimeInfo {
  if (!Number.isFinite(jdUtc)) throw `invalid timestamp: jd_utc ${jdUtc}`;
  const scale = scaleAt(jdUtc);
  const ttMinus = ttMinusClockS(jdUtc);
  const dt = deltaT(jdUtc + ttMinus / 86_400);
  const deltaValue = scale === 'ut' ? ttMinus : dt.value_s;
  const dut1 = dut1Info(jdUtc, user);
  const calendar = calendarFor(jdUtc);
  const civil = civilFromJd(jdUtc, calendar);
  const notes: string[] = [];
  if (scale === 'ut') {
    notes.push(
      jdUtc < UTC_SCALE_START_JD
        ? 'The clock is UT (Universal Time, UT1): UTC with leap seconds began in 1972.'
        : "The clock is UT (Universal Time, UT1): after 2035 leap seconds may stop, so UTC cannot be tied to the Earth's rotation.",
    );
    if (user !== null) notes.push('A DUT1 you set applies to the UTC years 1972-2035 only.');
  } else if (jdUtc >= 2_461_587.5) {
    notes.push('Leap seconds after June 2027 are not yet announced: TT - UTC is taken as 69.184 s.');
  }
  if (dut1.source === 'assumed') {
    notes.push('UT1 - UTC is not known for this date: taken as 0 s, +-0.9 s (up to 0.23\' of longitude).');
  }
  if (dt.sigma_s > 30) {
    notes.push(
      `Delta-T is uncertain by +-${humanDuration(dt.sigma_s)}: times and Earth-fixed positions carry it (15" of longitude per second).`,
    );
  }
  if (calendar === 'julian') notes.push('Julian calendar: the Gregorian calendar began on 1582-10-15.');
  if (civil.year <= 0) notes.push(`Astronomical year ${civil.year} is ${civil.era_year} ${civil.era}.`);
  return {
    jd_utc: jdUtc,
    utc: formatUtc(jdUtc),
    scale,
    tier,
    delta_t_s: deltaValue,
    delta_t_sigma_s: dt.sigma_s,
    delta_t_source: dt.source,
    tt_minus_clock_s: ttMinus,
    dut1_s: dut1.value_s,
    dut1_sigma_s: dut1.sigma_s,
    dut1_source: dut1.source,
    calendar,
    civil,
    julian_civil: civilFromJd(jdUtc, 'julian'),
    notes,
  };
}
