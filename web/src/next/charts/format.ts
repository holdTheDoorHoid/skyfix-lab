/**
 * Text for the charts: times in the display zone with UTC beside them, dates, durations,
 * altitudes and bearings. OWNER: charts agent. Deterministic English, so a chart reads the
 * same in every browser.
 */

import { splitDegMin } from '../../format.js';
import type { AngleFormat } from '../state.js';
import { formatHours, formatTime, msFromJd, UTC_ZONE, zoneOffsetMs, zoneShortName, type Zone } from '../time.js';
import type { LocalDate, LocalDay, LocalNight } from './windows.js';

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
export const MONTHS_LONG = [
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
] as const;
export const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
export const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const MINUS = '−';

/** 0 = Sunday. */
export function weekday(date: LocalDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** `24 Sep` */
export function dayMonth(date: LocalDate): string {
  return `${date.day} ${MONTHS_SHORT[date.month - 1]}`;
}

/** `Thu 24 Sep 2026` */
export function dateShort(date: LocalDate): string {
  return `${WEEKDAYS_SHORT[weekday(date)]} ${date.day} ${MONTHS_SHORT[date.month - 1]} ${date.year}`;
}

/** `Thursday 24 September 2026` */
export function dateLong(date: LocalDate): string {
  return `${WEEKDAYS_LONG[weekday(date)]} ${date.day} ${MONTHS_LONG[date.month - 1]} ${date.year}`;
}

/** `06:52` on the wall clock of `zone`. */
export function clock(jd: number, zone: Zone): string {
  return formatTime(jd, zone);
}

/** `10:52 UTC` */
export function clockUtc(jd: number): string {
  return `${formatTime(jd, UTC_ZONE)} UTC`;
}

/** `06:52 EDT` */
export function clockZoned(jd: number, zone: Zone): string {
  return `${formatTime(jd, zone)} ${zoneShortName(jd, zone)}`;
}

/** `06:52 EDT · 10:52 UTC`, or `10:52 UTC` when the zone is UTC. */
export function clockWithUtc(jd: number, zone: Zone): string {
  if (zone.kind === 'fixed' && zone.offsetMs === 0) return clockUtc(jd);
  return `${clockZoned(jd, zone)} · ${clockUtc(jd)}`;
}

/** `12 h 06 min` */
export function duration(hours: number): string {
  return formatHours(hours);
}

/** An hour-of-day label: `06:00`, or `06` when `short`. Hours may exceed 24 (the next day). */
export function hourLabel(hours: number, short = false): string {
  const h = ((Math.round(hours) % 24) + 24) % 24;
  const hh = String(h).padStart(2, '0');
  return short ? hh : `${hh}:00`;
}

/** An altitude in the chosen angle format: `42° 18′`, `42° 18′ 05″` or `42.31°`. */
export function altitude(value: number, format: AngleFormat): string {
  if (!Number.isFinite(value)) return '—';
  if (format === 'decimal') return `${value < 0 ? MINUS : ''}${Math.abs(value).toFixed(2)}°`;
  if (format === 'dms') {
    const sign = value < 0 ? MINUS : '';
    const totalSeconds = Math.round(Math.abs(value) * 3600);
    const d = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return `${sign}${d}° ${String(m).padStart(2, '0')}′ ${String(s).padStart(2, '0')}″`;
  }
  const { deg, min } = splitDegMin(Math.abs(value), 0);
  return `${value < 0 && (deg > 0 || min > 0) ? MINUS : ''}${deg}° ${String(min).padStart(2, '0')}′`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'] as const;

/** The 16-point compass name of a bearing. */
export function compassPoint(azimuthDeg: number): string {
  const i = Math.round((((azimuthDeg % 360) + 360) % 360) / 22.5) % 16;
  return POINTS[i]!;
}

/** `221° SW` */
export function bearing(azimuthDeg: number): string {
  if (!Number.isFinite(azimuthDeg)) return '—';
  let a = Math.round(azimuthDeg);
  if (a >= 360) a -= 360;
  return `${a}° ${compassPoint(azimuthDeg)}`;
}

/** `87 %` */
export function percent(fraction: number): string {
  return `${Math.round(fraction * 100)} %`;
}

/** A signed whole number of hours: `+1 h`, `−1 h`, `+30 min`. */
export function signedOffsetChange(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const sign = minutes < 0 ? MINUS : '+';
  const abs = Math.abs(minutes);
  return abs % 60 === 0 ? `${sign}${abs / 60} h` : `${sign}${abs} min`;
}

// ---------------------------------------------------------------------------------------
// Fast clocks for long lists (the year table has thousands of times). They give exactly what
// `formatTime` gives (the wall clock of the instant rounded to the millisecond, shown to the
// minute) without an Intl call per time: the zone offset is known for a day with no clock
// change.

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** The zone offset at `jd` on `day` (or in `night`): the known offset unless the clocks change then. */
export function offsetOn(span: LocalDay | LocalNight, jd: number, zone: Zone): number {
  if (span.offsetStartMs === span.offsetEndMs) return span.offsetStartMs;
  return zoneOffsetMs(msFromJd(jd), zone);
}

/** `06:52` at a known zone offset. */
export function clockAt(jd: number, offsetMs: number): string {
  const d = new Date(msFromJd(jd) + offsetMs);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** `10:52 UTC`, without Intl. */
export function clockUtcFast(jd: number): string {
  return `${clockAt(jd, 0)} UTC`;
}

const shortNames = new Map<string, string>();

/** `EDT` for a zone at an offset, cached (one Intl call per zone and offset). */
export function zoneNameAt(jd: number, zone: Zone, offsetMs: number): string {
  const key = `${zone.kind === 'iana' ? zone.zone : zone.name}|${offsetMs}`;
  let name = shortNames.get(key);
  if (name === undefined) {
    name = zoneShortName(jd, zone);
    shortNames.set(key, name);
  }
  return name;
}
