/**
 * How the Navigate view writes numbers: angles in the navigator's degrees and decimal
 * minutes (or the person's chosen format), small corrections in arcminutes, bearings with
 * their compass point, times in the display zone with UTC beside them, uncertainties with
 * their units. OWNER: navigate agent. Pure functions; no DOM.
 *
 * Positions go through `geo/coords.ts` (the map-data agent's formats), so a fix reads the
 * same as the place in the side panel.
 */

import { formatLatitude, formatLatLon, formatLongitude, type CoordStyle } from '../geo/coords.js';
import type { AngleFormat } from '../state.js';
import { formatWithUtc, wallClock, zoneShortName, UTC_ZONE, type Zone } from '../time.js';

export const DEG = '°';
export const PRIME = '′';
export const DOUBLE_PRIME = '″';
export const MINUS = '−';

export function coordStyle(format: AngleFormat): CoordStyle {
  return format === 'dms' ? 'dms' : format === 'decimal' ? 'decimal' : 'nav';
}

/**
 * An angle that is not a position (an altitude, a declination, an hour angle):
 * `45° 54.0′` (dm), `45° 54′ 00″` (dms) or `45.9000°` (decimal). Negative angles carry a
 * true minus sign: `−0° 16.3′`.
 */
export function fmtAngle(deg: number, format: AngleFormat = 'dm', digits?: number): string {
  if (!Number.isFinite(deg)) return '—';
  const sign = deg < 0 ? MINUS : '';
  const a = Math.abs(deg);
  if (format === 'decimal') {
    const d = digits ?? 4;
    const t = a.toFixed(d);
    return `${Number(t) === 0 ? '' : sign}${t}${DEG}`;
  }
  if (format === 'dms') {
    const d = digits ?? 0;
    const f = 10 ** d;
    let whole = Math.floor(a);
    let min = Math.floor((a - whole) * 60);
    let sec = Math.round(((a - whole) * 60 - min) * 60 * f) / f;
    if (sec >= 60) {
      sec -= 60;
      min += 1;
    }
    if (min >= 60) {
      min -= 60;
      whole += 1;
    }
    const zero = whole === 0 && min === 0 && sec === 0;
    return `${zero ? '' : sign}${whole}${DEG} ${String(min).padStart(2, '0')}${PRIME} ${sec.toFixed(d).padStart(d ? d + 3 : 2, '0')}${DOUBLE_PRIME}`;
  }
  const d = digits ?? 1;
  const f = 10 ** d;
  let whole = Math.floor(a);
  let min = Math.round((a - whole) * 60 * f) / f;
  if (min >= 60) {
    min -= 60;
    whole += 1;
  }
  const zero = whole === 0 && min === 0;
  return `${zero ? '' : sign}${whole}${DEG} ${min.toFixed(d).padStart(d ? d + 3 : 2, '0')}${PRIME}`;
}

/** The degrees-and-minutes text a person would type back into an angle field: `45 54.0`. */
export function angleInputText(deg: number, digits = 1): string {
  if (!Number.isFinite(deg)) return '';
  const sign = deg < 0 ? '-' : '';
  const a = Math.abs(deg);
  const f = 10 ** digits;
  let whole = Math.floor(a);
  let min = Math.round((a - whole) * 60 * f) / f;
  if (min >= 60) {
    min -= 60;
    whole += 1;
  }
  return `${sign}${whole} ${min.toFixed(digits).padStart(digits ? digits + 3 : 2, '0')}`;
}

/** Signed arcminutes with a true minus: `+0.2′`, `−8.0′`, `0.0′`. */
export function fmtArcmin(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  const t = Math.abs(value).toFixed(digits);
  const sign = Number(t) === 0 ? '' : value > 0 ? '+' : MINUS;
  return `${sign}${t}${PRIME}`;
}

/** An uncertainty in arcminutes: `±0.11′`. */
export function fmtSigma(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `±${Math.abs(value).toFixed(digits)}${PRIME}`;
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** The 16-point compass name of a true bearing. */
export function compassPoint(deg: number): string {
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return POINTS[i]!;
}

/** A true bearing as the navigator writes it, with the compass point: `146° SE`. */
export function fmtBearing(deg: number | null | undefined): string {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return '—';
  let whole = Math.round(((deg % 360) + 360) % 360);
  if (whole === 360) whole = 0;
  return `${String(whole).padStart(3, '0')}${DEG} ${compassPoint(deg)}`;
}

export function fmtPosition(p: { lat_deg: number; lon_deg: number }, format: AngleFormat = 'dm'): string {
  return formatLatLon(p, coordStyle(format), format === 'dm' ? { digits: 1 } : {});
}

export function fmtLatitude(lat: number, format: AngleFormat = 'dm', digits?: number): string {
  return formatLatitude(lat, coordStyle(format), digits === undefined ? {} : { digits });
}

export function fmtLongitude(lon: number, format: AngleFormat = 'dm', digits?: number): string {
  return formatLongitude(lon, coordStyle(format), digits === undefined ? {} : { digits });
}

/** The text a person would type back into a position field: `39 57.2 N, 075 09.9 W`. */
export function positionInputText(p: { lat_deg: number; lon_deg: number }): string {
  return formatLatLon(p, 'nav', { digits: 2 });
}

export function fmtMetres(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  const a = Math.abs(m);
  if (a >= 10_000) return `${(m / 1000).toFixed(1)} km`;
  if (a >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (a >= 10) return `${m.toFixed(0)} m`;
  return `${m.toFixed(1)} m`;
}

export function fmtNm(nm: number | null | undefined, digits = 2): string {
  if (nm === null || nm === undefined || !Number.isFinite(nm)) return '—';
  return `${nm.toFixed(digits)} NM`;
}

/** Metres the way a chart reader thinks: `290 m (0.16 NM)`. */
export function fmtMetresNm(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return 'no finite value';
  return `${fmtMetres(m)} (${fmtNm(m / 1852)})`;
}

/** Seconds of time: `7 s`, `41.7 s`, `9 min 42 s`, `2 h 03 min`. */
export function fmtSeconds(s: number | null | undefined): string {
  if (s === null || s === undefined || !Number.isFinite(s)) return '—';
  const a = Math.abs(s);
  const sign = s < 0 ? MINUS : '';
  if (a < 10) return `${sign}${a.toFixed(1)} s`;
  if (a < 60) return `${sign}${a.toFixed(0)} s`;
  if (a < 3600) {
    const m = Math.floor(a / 60);
    const r = Math.round(a - m * 60);
    return r === 60 ? `${sign}${m + 1} min 00 s` : `${sign}${m} min ${String(r).padStart(2, '0')} s`;
  }
  const h = Math.floor(a / 3600);
  const m = Math.round((a - h * 3600) / 60);
  return `${sign}${h} h ${String(m).padStart(2, '0')} min`;
}

/** An instant in the display zone with UTC beside it, to the second. */
export function fmtInstant(jd: number, zone: Zone): string {
  if (!Number.isFinite(jd)) return '—';
  return formatWithUtc(jd, zone, { seconds: true });
}

/** `01:30:05 UTC`. */
export function fmtUtcClock(jd: number): string {
  const w = wallClock(jd, UTC_ZONE);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(w.hour)}:${p(w.minute)}:${p(w.second)} UTC`;
}

/** `21:30:05 EDT` (the clock in a zone, with the zone's short name). */
export function fmtZoneClock(jd: number, zone: Zone): string {
  const w = wallClock(jd, zone);
  const p = (n: number) => String(n).padStart(2, '0');
  // Non-breaking spaces: "ZD −9" and its clock stay on one line.
  return `${p(w.hour)}:${p(w.minute)}:${p(w.second)}\u00a0${zoneShortName(jd, zone).replace(/ /g, '\u00a0')}`;
}

/** RFC 3339 as typed back into a time field: `2026-10-01 01:30:05` (UTC). */
export function utcInputText(utc: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(\.\d+)?Z$/.exec(utc);
  if (!m) return utc;
  const frac = m[3] && Number(m[3]) !== 0 ? m[3].replace(/0+$/, '') : '';
  return `${m[1]} ${m[2]}${frac}`;
}

/** A number with fixed digits, or a dash. */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const t = v.toFixed(digits);
  return Number(t) === 0 ? Math.abs(v).toFixed(digits) : t.replace('-', MINUS);
}

/** Condition numbers and chi-squares span decades. */
export function fmtMagnitude(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'singular (no finite value)';
  const a = Math.abs(v);
  if (a >= 1e5) return v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  return v.toFixed(2);
}
