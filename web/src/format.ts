/**
 * Number and angle formatting. CONVENTIONS section 1: degrees on screen, small angles
 * in arcminutes, never radians. Every angle is offered as a decimal degree AND as
 * degrees + decimal arcminutes, because navigators read almanacs in the second form
 * and spreadsheets in the first.
 *
 * House rule: the word "accuracy" appears nowhere in this interface. What the solver
 * reports is a NOMINAL UNCERTAINTY under a stated model.
 */

export const DEG = '°';
const PRIME = '′';

/** Split |deg| into whole degrees and decimal arcminutes, carrying 59.96' -> 60 -> +1 deg. */
export function splitDegMin(absDeg: number, digits = 1): { deg: number; min: number } {
  const f = 10 ** digits;
  let deg = Math.floor(absDeg);
  let min = Math.round((absDeg - deg) * 60 * f) / f;
  if (min >= 60) {
    min -= 60;
    deg += 1;
  }
  return { deg, min };
}

/** `39.9526` -> `39 57.2'`. Keeps the sign; use `formatLat`/`formatLon` for hemispheres. */
export function degMin(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value < 0 ? '-' : '';
  const { deg, min } = splitDegMin(Math.abs(value), digits);
  return `${sign}${deg}${DEG} ${min.toFixed(digits).padStart(digits + 3, '0')}${PRIME}`;
}

/** `39.9526` -> `39.9526 deg (39 57.2')`: both readings, always. */
export function degBoth(value: number, decimals = 4, minDigits = 1): string {
  if (!Number.isFinite(value)) return String(value);
  return `${value.toFixed(decimals)}${DEG} (${degMin(value, minDigits)})`;
}

export function formatLat(latDeg: number, digits = 1): string {
  if (!Number.isFinite(latDeg)) return String(latDeg);
  const { deg, min } = splitDegMin(Math.abs(latDeg), digits);
  const hemi = latDeg < 0 ? 'S' : 'N';
  return `${String(deg).padStart(2, '0')}${DEG} ${min.toFixed(digits).padStart(digits + 3, '0')}${PRIME} ${hemi}`;
}

/** Input is EAST POSITIVE (CONVENTIONS section 2). Output carries E/W explicitly. */
export function formatLon(lonDeg: number, digits = 1): string {
  if (!Number.isFinite(lonDeg)) return String(lonDeg);
  const { deg, min } = splitDegMin(Math.abs(lonDeg), digits);
  const hemi = lonDeg < 0 ? 'W' : 'E';
  return `${String(deg).padStart(3, '0')}${DEG} ${min.toFixed(digits).padStart(digits + 3, '0')}${PRIME} ${hemi}`;
}

export function formatLatLon(p: { lat_deg: number; lon_deg: number }, digits = 1): string {
  return `${formatLat(p.lat_deg, digits)}, ${formatLon(p.lon_deg, digits)}`;
}

/** Decimal-degree form with the sign convention spelled out. */
export function formatLatLonDecimal(p: { lat_deg: number; lon_deg: number }): string {
  return `${p.lat_deg.toFixed(4)}, ${p.lon_deg.toFixed(4)} (east-positive)`;
}

/** Signed arcminutes, e.g. `+1.20'`. */
export function arcmin(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toFixed(digits)}${PRIME}`;
}

/** Unsigned arcminutes, for uncertainties. */
export function arcminMagnitude(value: number, digits = 2): string {
  return `${Math.abs(value).toFixed(digits)}${PRIME}`;
}

export function metres(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const a = Math.abs(value);
  if (a >= 10000) return `${(value / 1000).toFixed(1)} km`;
  if (a >= 1000) return `${(value / 1000).toFixed(2)} km`;
  if (a >= 10) return `${value.toFixed(0)} m`;
  return `${value.toFixed(1)} m`;
}

export function nauticalMiles(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  return `${value.toFixed(digits)} NM`;
}

/** Metres expressed the way a chart reader thinks: metres and nautical miles. */
export function metresBoth(value: number): string {
  return `${metres(value)} (${nauticalMiles(value / 1852)})`;
}

export function fixed(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return String(value);
  return value.toFixed(digits);
}

/** Condition numbers and chi-squares span decades; switch to exponent when large. */
export function magnitude(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  const a = Math.abs(value);
  if (a >= 1e5) return value.toExponential(2);
  if (a >= 100) return value.toFixed(0);
  return value.toFixed(2);
}

/** `2026-10-01T01:30:00Z` -> `2026-10-01 01:30:00 UTC`. Unparseable input is echoed. */
export function formatUtc(value: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z$/.exec(value);
  if (!m) return value;
  return `${m[1]} ${m[2]} UTC`;
}
