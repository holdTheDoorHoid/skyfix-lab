/**
 * Display formatting for the explorer's chrome: angles in the chosen format, bearings,
 * compass points, magnitudes, lengths and distances in the chosen units, and times on a
 * zone's wall clock. OWNER: shell-design agent. Pure functions; no DOM.
 *
 * Minus signs are the true minus (U+2212). Angles follow the person's setting
 * (`settings.angleFormat`): `dm` 26° 02.3′ (the navigator's form), `dms` 26° 02′ 17″,
 * `decimal` 26.0381°. "Coarse" is for big readouts, "fine" for details.
 */

import { formatLatitude, formatLongitude, type CoordStyle } from '../geo/coords.js';
import type { AngleFormat, Units } from '../state.js';
import { formatTime, wallClock, type Zone } from '../time.js';

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
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
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

/** `Thu 24 Sep` (day first: unambiguous everywhere). */
export function dateShort(jd: number, zone: Zone): string {
  const w = wallClock(jd, zone);
  return `${DAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1]}`;
}

/** `Thu 24 Sep 2026`. */
export function dateMedium(jd: number, zone: Zone): string {
  const w = wallClock(jd, zone);
  return `${dateShort(jd, zone)} ${w.year}`;
}

/** `Thursday 24 September 2026`. */
export function dateLong(jd: number, zone: Zone): string {
  const w = wallClock(jd, zone);
  return `${DAYS_LONG[w.weekday]} ${w.day} ${MONTHS_LONG[w.month - 1]} ${w.year}`;
}

export function monthName(month: number): string {
  return MONTHS_LONG[month - 1] ?? '';
}

/** `16:30` on the zone's clock (truncated, as a clock shows it). */
export function clock(jd: number, zone: Zone): string {
  return formatTime(jd, zone);
}

/** `16:30:05`. */
export function clockSeconds(jd: number, zone: Zone): string {
  return formatTime(jd, zone, { seconds: true });
}

/** An event's time rounded to the nearest minute, as almanacs print it: `06:50`. */
export function eventTime(jd: number, zone: Zone): string {
  return formatTime(jd + 30 / 86_400, zone);
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
