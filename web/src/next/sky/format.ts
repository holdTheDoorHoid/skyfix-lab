/**
 * Angle and magnitude text for the Sky view's tooltips and screen-reader messages, in
 * the person's chosen format (`settings.angleFormat`). OWNER: sky agent.
 */

import { splitDegMin } from '../../format.js';
import type { AngleFormat } from '../state.js';

const MINUS = '−';

/** `34° 12.3′` (dm), `34° 12′ 18″` (dms) or `34.21°` (decimal); negative with a true minus sign. */
export function formatAngle(value: number, format: AngleFormat): string {
  if (!Number.isFinite(value)) return '—';
  const sign = value < 0 ? MINUS : '';
  const a = Math.abs(value);
  if (format === 'decimal') {
    const text = a.toFixed(2);
    return `${Number(text) === 0 ? '' : sign}${text}°`;
  }
  if (format === 'dms') {
    let deg = Math.floor(a);
    let min = Math.floor((a - deg) * 60);
    let sec = Math.round(((a - deg) * 60 - min) * 60);
    if (sec >= 60) {
      sec -= 60;
      min += 1;
    }
    if (min >= 60) {
      min -= 60;
      deg += 1;
    }
    const zero = deg === 0 && min === 0 && sec === 0;
    return `${zero ? '' : sign}${deg}° ${String(min).padStart(2, '0')}′ ${String(sec).padStart(2, '0')}″`;
  }
  const { deg, min } = splitDegMin(a, 1);
  const zero = deg === 0 && min === 0;
  return `${zero ? '' : sign}${deg}° ${min.toFixed(1).padStart(4, '0')}′`;
}

/** A bearing in [0, 360) that never shows as 360 after rounding. */
export function formatBearing(value: number, format: AngleFormat): string {
  if (!Number.isFinite(value)) return '—';
  const v = ((value % 360) + 360) % 360;
  const half = format === 'decimal' ? 0.005 : format === 'dms' ? 0.5 / 3600 : 0.05 / 60;
  return formatAngle(v >= 360 - half ? 0 : v, format);
}

/** Compass point of a bearing, 16 winds: "NNE". */
export function compassPoint(bearingDeg: number): string {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const v = ((bearingDeg % 360) + 360) % 360;
  return names[Math.round(v / 22.5) % 16]!;
}

export function formatMagnitude(mag: number): string {
  if (!Number.isFinite(mag)) return '—';
  const text = Math.abs(mag).toFixed(1);
  return mag < 0 && Number(text) !== 0 ? `${MINUS}${text}` : text;
}

// --- sky2 agent: equatorial coordinates -------------------------------------------------

/** Right ascension as `2h 31m 49s` (hours, minutes, whole seconds; 24h wraps to 0h). */
export function formatRa(raDeg: number): string {
  if (!Number.isFinite(raDeg)) return '—';
  let s = Math.round((((raDeg % 360) + 360) % 360) * 240); // seconds of time
  s %= 86_400;
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh}h ${String(mm).padStart(2, '0')}m ${String(ss).padStart(2, '0')}s`;
}

/** Declination as `+89° 15′` (signed, whole arcminutes), or in the chosen angle format with a sign. */
export function formatDec(decDeg: number, format: AngleFormat = 'dm'): string {
  if (!Number.isFinite(decDeg)) return '—';
  const sign = decDeg < 0 ? MINUS : '+';
  if (format === 'decimal') return `${sign}${Math.abs(decDeg).toFixed(2)}°`;
  let m = Math.round(Math.abs(decDeg) * 60);
  const d = Math.floor(m / 60);
  m -= d * 60;
  const text = `${d}° ${String(m).padStart(2, '0')}′`;
  return `${d === 0 && m === 0 ? '' : sign}${text}`;
}
