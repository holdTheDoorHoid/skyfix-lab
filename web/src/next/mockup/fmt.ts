/** Display formatting used by the mockup (and a sketch of what the panel will need). */

import { formatTime, wallClock, type Zone } from '../time.js';

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

/** `Thu 24 Sep 2026` (day first: unambiguous everywhere). */
export function dateLabel(jd: number, zone: Zone, options: { year?: boolean } = {}): string {
  const w = wallClock(jd, zone);
  const base = `${DAYS[w.weekday]} ${w.day} ${MONTHS[w.month - 1]}`;
  return options.year === false ? base : `${base} ${w.year}`;
}

/** `Thursday 24 September 2026`. */
export function dateLong(jd: number, zone: Zone): string {
  const w = wallClock(jd, zone);
  return `${DAYS_LONG[w.weekday]} ${w.day} ${MONTHS_LONG[w.month - 1]} ${w.year}`;
}

/** `06:50`, rounded to the nearest minute as almanacs do (time.ts `formatTime`). */
export function hm(jd: number, zone: Zone): string {
  return formatTime(jd, zone);
}

/** Whole degrees and arcminutes: `26° 02′`; negative with a true minus. */
export function dm0(deg: number): string {
  const sign = deg < 0 ? '−' : '';
  let total = Math.round(Math.abs(deg) * 60);
  const d = Math.floor(total / 60);
  total -= d * 60;
  return `${sign}${d}° ${String(total).padStart(2, '0')}′`;
}

/** Degrees and tenths of arcminutes: `129° 31.7′`. */
export function dm1(deg: number): string {
  const sign = deg < 0 ? '−' : '';
  const tenths = Math.round(Math.abs(deg) * 600);
  const d = Math.floor(tenths / 600);
  const m = (tenths - d * 600) / 10;
  return `${sign}${d}° ${m.toFixed(1).padStart(4, '0')}′`;
}

/** A bearing as three digits: `090°`. */
export function bearing(az: number): string {
  const a = ((Math.round(az) % 360) + 360) % 360;
  return `${String(a).padStart(3, '0')}°`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** The 16-point compass name of a bearing: 244.7 -> `WSW`. */
export function point16(az: number): string {
  return POINTS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]!;
}

/** Magnitude with a true minus: `−4.6`. */
export function mag(m: number | null): string {
  if (m === null) return '—';
  return (m < 0 ? '−' : '') + Math.abs(m).toFixed(1);
}

/** Declination with a hemisphere letter, navigator style: `S 0° 43.1′`. */
export function decl(deg: number): string {
  return `${deg < 0 ? 'S' : 'N'} ${dm1(Math.abs(deg))}`;
}
