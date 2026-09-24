/**
 * Reading what a person types into the Navigate view: sextant readings in degrees and
 * decimal minutes, UTC instants, numbers with units, and positions. Every function
 * returns either a value or one plain sentence that says what is wrong and shows the form
 * that works; the view prints that sentence next to the field. OWNER: navigate agent.
 *
 * Angles and positions are parsed by `geo/coords.ts` (the map-data agent's navigator-style
 * parser: degree, minute and second symbols and their look-alikes, decimal commas, signs).
 * This module adds what an altitude needs: bare "45 54.0" (degrees then minutes, the way a
 * sextant is read), a range check that knows a reflected artificial horizon reads the
 * double angle, and a refusal of N/S/E/W, which have no meaning for an altitude.
 */

import { parseLatLon, parseLongitude } from '../geo/coords.js';
import { jdFromIso } from '../time.js';

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

/** "45 54.0", "-0 12.5", "45 54" -> degrees and minutes with symbols, for geo/coords. */
function symboliseBarePair(text: string): string {
  const m = /^\s*([+\-−]?)\s*(\d+)\s+(\d+(?:[.,]\d*)?)\s*$/.exec(text);
  if (!m) return text;
  return `${m[1] === '−' ? '-' : m[1]}${m[2]}° ${m[3]!.replace(',', '.')}′`;
}

export interface AngleRule {
  /** Inclusive range, degrees. */
  min: number;
  max: number;
  /** What the field holds, for messages ("The sextant reading"). */
  what: string;
  /** An example in the navigator's form, for messages ("45 54.0"). */
  example?: string;
}

/**
 * An angle that is not a position: an altitude, a distance, a declination. Accepts
 * `45 54.0` (degrees, then decimal minutes, as a sextant is read), `45° 54.0′`, `45°54'`,
 * `45 54 06` is not accepted (write `45° 54′ 06″`), `45.9` (decimal degrees) and signs.
 */
export function parseAngle(text: string, rule: AngleRule): Parsed<number> {
  const example = rule.example ?? '45 54.0';
  const raw = text.trim();
  if (!raw) return fail(`${rule.what} is empty. Type degrees and minutes, for example ${example}.`);
  const range = (v: number): Parsed<number> =>
    v < rule.min || v > rule.max
      ? fail(`${rule.what} must be between ${rule.min}° and ${rule.max}°; ${Number(v.toFixed(4))}° is outside that.`)
      : ok(v === 0 ? 0 : v);
  const withoutUnits = raw
    .replace(/(degrees?|deg|minutes?|min|seconds?|sec)/gi, ' ')
    .replace(/(\d)\s*[dms](?![a-z])/gi, '$1 ');
  if (/[NSEWnsew]/.test(withoutUnits)) {
    return fail(`${rule.what} has no north, south, east or west. Type degrees and minutes, for example ${example}.`);
  }
  const plain = raw.replace(/−/g, '-').replace(',', '.');
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(plain)) return range(Number(plain));
  const parsed = parseLongitude(symboliseBarePair(raw));
  if (!parsed.ok) {
    if (/out of range|between 180/i.test(parsed.error)) {
      return fail(`${rule.what} must be between ${rule.min}° and ${rule.max}°.`);
    }
    return fail(`${rule.what}: ${parsed.error.replace(/longitude/gi, 'angle').replace(/,? ?(takes )?E or W(, not N or S)?/g, '')} For example ${example}.`);
  }
  return range(parsed.value);
}

const UTC_PATTERN =
  /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?\s*(?:Z|UTC|GMT|UT)?$/i;

/**
 * An instant in UTC, returned as RFC 3339 with a trailing `Z` (CONVENTIONS section 6):
 * `2026-10-01 01:30:05`, `2026-10-01T01:30:05Z`, `2026-10-01 01:30` (seconds 0),
 * `2026-10-01 01:30:05.5`. A time with a zone offset is refused: this field is UTC.
 */
export function parseUtcInput(text: string): Parsed<string> {
  const raw = text.trim();
  if (!raw) return fail('The time is empty. Type the UTC date and time, for example 2026-10-01 01:30:05.');
  if (/[+-]\d{2}:?\d{2}$/.test(raw) && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return fail('This field is UTC: remove the zone offset and give the time in UTC, for example 2026-10-01 01:30:05.');
  }
  const m = UTC_PATTERN.exec(raw);
  if (!m) return fail('Type the UTC date and time as year-month-day hours:minutes:seconds, for example 2026-10-01 01:30:05.');
  const p = (s: string | undefined, n = 2) => (s ?? '0').padStart(n, '0');
  const frac = m[7] ? `.${m[7]}` : '';
  const iso = `${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${m[5]}:${p(m[6])}${frac}Z`;
  if (jdFromIso(iso) === null) return fail(`${raw} is not a real date and time (check the month, day, hour and minute).`);
  return ok(iso);
}

export interface NumberRule {
  what: string;
  min?: number;
  max?: number;
  /** Shown after the value in messages ("m", "′", "kn"). */
  unit?: string;
  /** Strictly greater than `min` (a sigma). */
  exclusiveMin?: boolean;
}

/** A plain number, with a decimal comma accepted. */
export function parseNumber(text: string, rule: NumberRule): Parsed<number> {
  const raw = text.trim().replace(/−/g, '-').replace(/\s+/g, '');
  if (!raw) return fail(`${rule.what} is empty.`);
  const normalised = /^[+-]?\d+,\d+$/.test(raw) ? raw.replace(',', '.') : raw;
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(normalised)) return fail(`${rule.what} must be a number.`);
  const v = Number(normalised);
  if (!Number.isFinite(v)) return fail(`${rule.what} must be a number.`);
  const unit = rule.unit ? ` ${rule.unit}` : '';
  if (rule.min !== undefined && (rule.exclusiveMin ? v <= rule.min : v < rule.min)) {
    return fail(`${rule.what} must be ${rule.exclusiveMin ? 'more than' : 'at least'} ${rule.min}${unit}.`);
  }
  if (rule.max !== undefined && v > rule.max) return fail(`${rule.what} must be at most ${rule.max}${unit}.`);
  return ok(v);
}

/** An optional number: empty means "not stated" (null). */
export function parseOptionalNumber(text: string, rule: NumberRule): Parsed<number | null> {
  return text.trim() === '' ? ok(null) : parseNumber(text, rule);
}

/**
 * A position, latitude first: `39° 57.2′ N, 075° 09.9′ W`, `39 57.2 N 75 9.9 W`,
 * `39.9526, -75.1652`. East-positive longitude out (CONVENTIONS section 2).
 */
export function parsePosition(text: string): Parsed<{ lat_deg: number; lon_deg: number }> {
  const raw = text.trim();
  if (!raw) return fail('The position is empty. Type latitude then longitude, for example 39 57.2 N, 075 09.9 W.');
  const parsed = parseLatLon(raw);
  return parsed.ok ? ok(parsed.value) : fail(parsed.error);
}
