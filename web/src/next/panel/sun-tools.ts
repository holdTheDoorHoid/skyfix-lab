/**
 * Small pure helpers behind the Selected card's SunCalc-style tools: the length of a
 * shadow, and reading a height typed for "When is it at…?". OWNER: shell-design agent
 * (added by the polish pass). Tested in panel-tools.test.ts.
 *
 * Nothing here computes astronomy: the altitude comes from the engine (`sky_state`,
 * apparent altitude) and the times from `find_altitude`.
 */

/** What to say about a shadow: none (the Sun is down), too long to measure, or its length. */
export type Shadow = { kind: 'none' } | { kind: 'long' } | { kind: 'length'; m: number };

/** Below this apparent altitude the shadow is too long to be worth a number (over 115 × the height). */
export const SHADOW_MIN_ALT_DEG = 0.5;

/**
 * The shadow of an upright object `heightM` tall on level ground, with the Sun at apparent
 * altitude `altDeg` (refraction included: the shadow follows the light as it arrives):
 * `height / tan(altitude)`. No shadow with the Sun at or below the horizon.
 */
export function shadowOf(heightM: number, altDeg: number): Shadow {
  if (!(altDeg > 0) || !Number.isFinite(heightM)) return { kind: 'none' };
  if (altDeg < SHADOW_MIN_ALT_DEG) return { kind: 'long' };
  return { kind: 'length', m: heightM / Math.tan((altDeg * Math.PI) / 180) };
}

/** Heights "When is it at…?" accepts, degrees: down to astronomical twilight, up to the zenith. */
export const FIND_ALT_MIN = -18;
export const FIND_ALT_MAX = 90;

/**
 * A height typed as degrees (`30`, `-6`, `30.5`, `30°`) or degrees and minutes (`30 15`,
 * `30° 15′`, `-0 50`), or null when it is not one or is outside −18°..90°.
 */
export function parseAltitude(text: string): number | null {
  const t = text
    .trim()
    .replace(/[−–]/g, '-')
    .replace(/[°º′'’″"]/g, ' ')
    .replace(/,/g, '.')
    .trim();
  if (!t) return null;
  const parts = t.split(/\s+/);
  if (parts.length > 2 || !parts.every((p) => /^-?\d+(\.\d+)?$|^-?\.\d+$/.test(p))) return null;
  const negative = parts[0]!.startsWith('-');
  const deg = Math.abs(Number(parts[0]));
  const min = parts.length === 2 ? Number(parts[1]) : 0;
  if (parts.length === 2 && (parts[1]!.startsWith('-') || min >= 60 || !Number.isInteger(deg))) return null;
  const value = (negative ? -1 : 1) * (deg + min / 60);
  return Number.isFinite(value) && value >= FIND_ALT_MIN && value <= FIND_ALT_MAX ? value : null;
}
