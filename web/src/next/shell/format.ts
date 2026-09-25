/**
 * Display formatting for the explorer's chrome: angles in the chosen format, bearings,
 * compass points, magnitudes, lengths and distances in the chosen units, and times on a
 * zone's wall clock. OWNER: shell-design agent. Pure functions; no DOM.
 *
 * Minus signs are the true minus (U+2212). Angles follow the person's setting
 * (`settings.angleFormat`): `dm` 26° 02.3′ (the navigator's form), `dms` 26° 02′ 17″,
 * `decimal` 26.0381°. "Coarse" is for big readouts, "fine" for details.
 *
 * Times follow `settings.hourCycle` (`setHourCycle`, kept in step by the shell): 18:40, or
 * 6:40 PM. UTC is always written on the 24-hour clock, as navigators and almanacs write it.
 */

import { formatLatitude, formatLongitude, type CoordStyle } from '../geo/coords.js';
import type { AngleFormat, HourCycle, Units } from '../state.js';
import { formatTime, roundToMinute, roundToSecond, wallClock, type WallClock, type Zone } from '../time.js';
import { dateLongText, dateMediumText, dateShortText } from '../time/format.js';

export const MINUS = '−';
/** Groups digits: 386 920 (a narrow no-break space). */
const GROUP = ' ';

export type Precision = 'coarse' | 'fine';

function signOf(x: number): string {
  return x < 0 ? MINUS : '';
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Whole degrees and minutes rounded to `digits` decimals, carrying 60′ into the degree. */
function splitDm(abs: number, digits: number): [number, number] {
  const f = 10 ** digits;
  const totalMin = Math.round(abs * 60 * f) / f;
  const d = Math.floor(totalMin / 60 + 1e-12);
  const m = Math.max(0, Number((totalMin - d * 60).toFixed(digits)));
  return m >= 60 ? [d + 1, 0] : [d, m];
}

/** Degrees, minutes and seconds rounded to `digits` decimals of a second. */
function splitDms(abs: number, digits: number): [number, number, number] {
  const f = 10 ** digits;
  const totalSec = Math.round(abs * 3600 * f) / f;
  const d = Math.floor(totalSec / 3600 + 1e-12);
  const rest = totalSec - d * 3600;
  const m = Math.floor(rest / 60 + 1e-12);
  const s = Math.max(0, Number((rest - m * 60).toFixed(digits)));
  return [d, m, s];
}

function minutesText(m: number, digits: number): string {
  return digits ? m.toFixed(digits).padStart(digits + 3, '0') : pad2(Math.round(m));
}

function secondsText(s: number, digits: number): string {
  return digits ? s.toFixed(digits).padStart(digits + 3, '0') : pad2(Math.round(s));
}

/** A signed angle: `26° 02′` (coarse) or `26° 02.3′` (fine) in the navigator's form. */
export function formatAngle(deg: number, format: AngleFormat, precision: Precision = 'fine'): string {
  if (!Number.isFinite(deg)) return '—';
  const abs = Math.abs(deg);
  switch (format) {
    case 'decimal': {
      const text = abs.toFixed(precision === 'coarse' ? 2 : 4);
      return `${Number(text) === 0 ? '' : signOf(deg)}${text}°`;
    }
    case 'dms': {
      const digits = precision === 'coarse' ? 0 : 1;
      const [d, m, s] = splitDms(abs, digits);
      const zero = d === 0 && m === 0 && s === 0;
      return `${zero ? '' : signOf(deg)}${d}° ${pad2(m)}′ ${secondsText(s, digits)}″`;
    }
    case 'dm': {
      const digits = precision === 'coarse' ? 0 : 1;
      const [d, m] = splitDm(abs, digits);
      const zero = d === 0 && m === 0;
      return `${zero ? '' : signOf(deg)}${d}° ${minutesText(m, digits)}′`;
    }
  }
}

/** Degrees in [0, 360): the value is rounded first so it never shows as 360. */
export function formatAzimuth(az: number, format: AngleFormat, precision: Precision = 'fine'): string {
  if (!Number.isFinite(az)) return '—';
  const wrapped = ((az % 360) + 360) % 360;
  // The smallest unit shown, in degrees.
  const unit =
    format === 'decimal'
      ? precision === 'coarse'
        ? 0.01
        : 0.0001
      : format === 'dms'
        ? precision === 'coarse'
          ? 1 / 3600
          : 0.1 / 3600
        : precision === 'coarse'
          ? 1 / 60
          : 0.1 / 60;
  const rounded = Math.round(wrapped / unit) * unit;
  return formatAngle(rounded >= 360 - unit / 2 ? 0 : rounded, format, precision);
}

/** A navigator's azimuth, Zn, to a tenth of a degree: `244.7°` (never `360.0°`). */
export function formatZn(zn: number): string {
  if (!Number.isFinite(zn)) return '—';
  const tenths = ((Math.round(zn * 10) % 3600) + 3600) % 3600;
  return `${(tenths / 10).toFixed(1)}°`;
}

/** A bearing as three whole degrees: `090°`. */
export function bearing3(az: number): string {
  if (!Number.isFinite(az)) return '—';
  const a = ((Math.round(az) % 360) + 360) % 360;
  return `${String(a).padStart(3, '0')}°`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const POINT_WORDS: Record<string, string> = {
  N: 'north',
  NNE: 'north-north-east',
  NE: 'north-east',
  ENE: 'east-north-east',
  E: 'east',
  ESE: 'east-south-east',
  SE: 'south-east',
  SSE: 'south-south-east',
  S: 'south',
  SSW: 'south-south-west',
  SW: 'south-west',
  WSW: 'west-south-west',
  W: 'west',
  WNW: 'west-north-west',
  NW: 'north-west',
  NNW: 'north-north-west',
};

/** The 16-point compass name of a bearing: 244.7 -> `WSW`. */
export function compassPoint(az: number): string {
  if (!Number.isFinite(az)) return '';
  return POINTS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]!;
}

/** The same in words, for screen readers: `west-south-west`. */
export function compassWords(az: number): string {
  return POINT_WORDS[compassPoint(az)] ?? '';
}

/** Declination with its hemisphere letter, as an almanac prints it: `S 0° 43.1′`. */
export function formatDeclination(dec: number, format: AngleFormat): string {
  if (!Number.isFinite(dec)) return '—';
  return `${dec < 0 ? 'S' : 'N'} ${formatAngle(Math.abs(dec), format, 'fine')}`;
}

/** A visual magnitude with a true minus: `−4.6`. */
export function formatMagnitude(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  const text = Math.abs(m).toFixed(1);
  return `${m < 0 && Number(text) !== 0 ? MINUS : ''}${text}`;
}

/** Coordinates in the angle format chosen (the geo module's styles). */
export function coordStyle(format: AngleFormat): CoordStyle {
  return format === 'dms' ? 'dms' : format === 'decimal' ? 'decimal' : 'nav';
}

export function formatLat(lat: number, format: AngleFormat): string {
  return formatLatitude(lat, coordStyle(format)).replace('-', MINUS);
}

export function formatLon(lon: number, format: AngleFormat): string {
  return formatLongitude(lon, coordStyle(format)).replace('-', MINUS);
}

function group(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, GROUP);
}

const M_PER_FT = 0.3048;
const KM_PER_NM = 1.852;
const KM_PER_MI = 1.609344;
export const KM_PER_AU = 149_597_870.7;

/** A short length (height of eye, a shadow): metres, or feet for imperial units. */
export function formatLength(m: number, units: Units, digits = 1): string {
  if (!Number.isFinite(m)) return '—';
  if (units === 'imperial') {
    const ft = m / M_PER_FT;
    return `${ft.toFixed(ft >= 100 ? 0 : digits)} ft`;
  }
  return `${Number.isInteger(m) || m >= 100 ? Math.round(m) : m.toFixed(digits)} m`;
}

/**
 * A body's distance: astronomical units beyond two million kilometres (planets, the Sun),
 * otherwise kilometres, nautical miles or statute miles by the units chosen (the Moon).
 */
export function formatDistance(km: number | null | undefined, units: Units): string {
  if (km === null || km === undefined || !Number.isFinite(km)) return '—';
  if (km > 2e6) {
    const au = km / KM_PER_AU;
    return `${au.toFixed(au < 10 ? 4 : 3)} AU`;
  }
  switch (units) {
    case 'nautical':
      return `${group(km / KM_PER_NM)} NM`;
    case 'imperial':
      return `${group(km / KM_PER_MI)} mi`;
    default:
      return `${group(km)} km`;
  }
}

/** Metres from a length typed in the chosen units (feet for imperial). */
export function lengthToMetres(value: number, units: Units): number {
  return units === 'imperial' ? value * M_PER_FT : value;
}

/** A length in the chosen units, as a number (for an input box). */
export function metresToUnits(m: number, units: Units): number {
  return units === 'imperial' ? m / M_PER_FT : m;
}

// ---------------------------------------------------------------------------------
// Times and dates on a zone's wall clock
// ---------------------------------------------------------------------------------

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `Thu 24 Sep` (day first: unambiguous everywhere). Dates are in the display calendar
 * (Julian before 1582-10-15 unless Settings chose ISO) and years are written as Settings
 * chose (`585 BC`): time/format.ts (time-ui agent).
 */
export function dateShort(jd: number, zone: Zone): string {
  return dateShortText(wallClock(jd, zone));
}

/** `Thu 24 Sep 2026`, `Wed 28 May 585 BC`. */
export function dateMedium(jd: number, zone: Zone): string {
  return dateMediumText(wallClock(jd, zone));
}

/** `Thursday 24 September 2026`, `Wednesday 28 May 585 BC`. */
export function dateLong(jd: number, zone: Zone): string {
  return dateLongText(wallClock(jd, zone));
}

export function monthName(month: number): string {
  return MONTHS_LONG[month - 1] ?? '';
}

// --- the 12- or 24-hour clock -------------------------------------------------------

let hourCycle: HourCycle = 'h23';

/** The clock times are written on (shell.ts keeps it equal to `settings.hourCycle`). */
export function setHourCycle(cycle: HourCycle): void {
  hourCycle = cycle;
}

export function currentHourCycle(): HourCycle {
  return hourCycle;
}

/** A no-break space before AM and PM, so a time never wraps between its parts. */
const NBSP = '\u00a0';

function isUtc(zone: Zone): boolean {
  return zone.kind === 'fixed' && zone.offsetMs === 0;
}

/** Hours, minutes, optional seconds and AM/PM of a wall clock, in the chosen cycle. */
export interface ClockParts {
  /** `16:30` or `4:30`. */
  hm: string;
  /** `:05`, or '' without seconds. */
  seconds: string;
  /** ` PM` (with a no-break space), or '' on the 24-hour clock. */
  suffix: string;
}

function parts(w: WallClock, zone: Zone, seconds: boolean): ClockParts {
  const mm = pad2(w.minute);
  const ss = seconds ? `:${pad2(w.second)}` : '';
  if (hourCycle === 'h23' || isUtc(zone)) return { hm: `${pad2(w.hour)}:${mm}`, seconds: ss, suffix: '' };
  const h12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return { hm: `${h12}:${mm}`, seconds: ss, suffix: `${NBSP}${w.hour < 12 ? 'AM' : 'PM'}` };
}

/**
 * The parts of a clock showing `jd`: to the second, truncated (as a clock reads, so the
 * minute and the seconds beside it agree). The time bar draws them at different sizes.
 */
export function clockParts(jd: number, zone: Zone): ClockParts {
  return parts(wallClock(roundToSecond(jd), zone), zone, true);
}

/**
 * `16:30` or `4:30 PM`: the reading of a clock showing the current time without its seconds
 * (the minute it is in), so it agrees with `clockSeconds` shown beside it.
 */
export function clock(jd: number, zone: Zone): string {
  if (hourCycle === 'h23' || isUtc(zone)) return formatTime(jd, zone, { seconds: true }).slice(0, 5);
  const p = clockParts(jd, zone);
  return `${p.hm}${p.suffix}`;
}

/** `16:30:05` or `4:30:05 PM`. */
export function clockSeconds(jd: number, zone: Zone): string {
  if (hourCycle === 'h23' || isUtc(zone)) return formatTime(jd, zone, { seconds: true });
  const p = clockParts(jd, zone);
  return `${p.hm}${p.seconds}${p.suffix}`;
}

/** An event's time rounded to the nearest minute, as almanacs print it: `06:50` or `6:50 AM` (time.ts `formatTime`). */
export function eventTime(jd: number, zone: Zone): string {
  if (hourCycle === 'h23' || isUtc(zone)) return formatTime(jd, zone);
  const p = parts(wallClock(roundToMinute(jd), zone), zone, false);
  return `${p.hm}${p.suffix}`;
}

/** The end of a day on a time axis or in a range: `24:00`, or `12:00 AM` on the 12-hour clock. */
export function endOfDay(zone: Zone): string {
  return hourCycle === 'h23' || isUtc(zone) ? '24:00' : `12:00${NBSP}AM`;
}

/** An hour mark on a time axis: `06:00`, or `6 AM` on the 12-hour clock. */
export function axisTime(jd: number, zone: Zone): string {
  if (hourCycle === 'h23' || isUtc(zone)) return formatTime(jd, zone);
  const w = wallClock(roundToMinute(jd), zone);
  const h12 = w.hour % 12 === 0 ? 12 : w.hour % 12;
  return `${h12}${w.minute ? `:${pad2(w.minute)}` : ''}${NBSP}${w.hour < 12 ? 'AM' : 'PM'}`;
}

/**
 * A time of day typed by a person, on either clock: `18:40`, `18:40:05`, `6:40 pm`,
 * `6:40:05 PM`, `6.40pm`, `12:00 am` (midnight). Null for anything else.
 */
export function parseClock(text: string): { hour: number; minute: number; second: number } | null {
  const m = /^\s*(\d{1,2})[:.h](\d{2})(?:[:.](\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?\s*$/i.exec(text);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2]);
  const second = Number(m[3] ?? 0);
  if (minute > 59 || second > 59) return null;
  if (m[4]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[4].toLowerCase() === 'p' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  return { hour, minute, second };
}

/** The short weekday of `jd` when its local date differs from `ref`'s (`Fri`), else ''. */
export function otherDay(jd: number, ref: number, zone: Zone): string {
  const a = wallClock(jd + 30 / 86_400, zone);
  const b = wallClock(ref, zone);
  return a.year === b.year && a.month === b.month && a.day === b.day ? '' : (DAYS[a.weekday] ?? '');
}

/** `in 18 min`, `in 2 h 05 min`, `18 min ago`. */
export function relative(fromJd: number, toJd: number): string {
  const minutes = Math.round((toJd - fromJd) * 1440);
  const a = Math.abs(minutes);
  const text = a < 60 ? `${a} min` : `${Math.floor(a / 60)} h ${pad2(a % 60)} min`;
  return minutes >= 0 ? `in ${text}` : `${text} ago`;
}
