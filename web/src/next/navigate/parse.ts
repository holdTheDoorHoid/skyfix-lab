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
import { isoYear, jdFromIso } from '../time.js';
import { civilFromJdn, isGapDate, isValidDate, jdnFromDate } from '../time/civil.js';
import { parseYear } from '../time/format.js';

/**
 * A parsed value, or one sentence saying what is wrong. `warning`, on a value that was
 * understood, is a caution to show beside the field without refusing it.
 */
export type Parsed<T> = { ok: true; value: T; warning?: string } | { ok: false; error: string };

/**
 * Shown, not refused, when a sight time is typed as `HH:MM` (expansion programme,
 * moonshape): `:00` is then assumed, and every second of time is 15″ of hour angle,
 * 0.25′ of longitude (up to 15′ for a whole minute).
 */
export const SECONDS_OMITTED_WARNING = 'Seconds omitted: :00 assumed; each second is 0.25′ of longitude.';

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
  /^([+\-−]?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T\s]+)(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,6}))?)?\s*(?:Z|UTC|GMT|UT)?$/i;

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * An instant on the app's clock (UTC, or UT outside 1972-2035), returned as RFC 3339 with a
 * trailing `Z` (CONVENTIONS section 6): `2026-10-01 01:30:05`, `2026-10-01T01:30:05Z`,
 * `2026-10-01 01:30` (seconds 0, with [`SECONDS_OMITTED_WARNING`]), `2026-10-01 01:30:05.5`.
 * A time with a zone offset is refused: this field is the clock.
 *
 * The date is read in the **display calendar** (time/civil.ts, CONVENTIONS 15.3): in the
 * default historical calendar a date before 1582-10-15 is Julian, as people wrote it then,
 * and the ten dates the reform skipped are refused; in the ISO setting it is proleptic
 * Gregorian. The value returned is on the wire, which is proleptic Gregorian, so Julian
 * 1550-03-01 comes back as `1550-03-11T…Z` (`utcInputText` turns it back). Years may have
 * any number of digits and a sign, astronomical as ISO 8601 writes them (`-0584` is 585 BC,
 * `0079` or `79` is AD 79, `+12345`), read by the calendar formatter's `parseYear`.
 */
export function parseUtcInput(text: string): Parsed<string> {
  const raw = text.trim();
  if (!raw) return fail('The time is empty. Type the date and time on the app’s clock, UTC from 1972 to 2035 and UT outside, for example 2026-10-01 01:30:05.');
  if (/[+-]\d{2}:?\d{2}$/.test(raw) && !/^[+\-−]?\d{1,6}-\d{2}-\d{2}$/.test(raw)) {
    return fail('This field takes the app’s clock, UTC from 1972 to 2035 and UT outside, not a zone: remove the zone offset, for example 2026-10-01 01:30:05.');
  }
  const m = UTC_PATTERN.exec(raw);
  if (!m) return fail('Type the UTC date and time as year-month-day hours:minutes:seconds, for example 2026-10-01 01:30:05.');
  const year = parseYear(m[1]!);
  if (year === null) return fail(`${m[1]} is not a year this field can read: use up to five digits, with a minus sign for years before AD 1 (-0584 is 585 BC).`);
  const [month, day, hour, minute] = [m[2], m[3], m[4], m[5]].map(Number) as [number, number, number, number];
  const second = m[6] === undefined ? 0 : Number(m[6]);
  const date = { year, month, day };
  if (isGapDate(date)) {
    return fail(`${m[1]}-${pad2(month)}-${pad2(day)} is one of the ten dates the 1582 reform skipped: Thursday 4 October 1582 (Julian) was followed by Friday 15 October (Gregorian).`);
  }
  if (!isValidDate(date) || hour > 23 || minute > 59 || second > 59) {
    return fail(`${raw} is not a real date and time (check the month, day, hour and minute).`);
  }
  // The display calendar's date, as the wire's proleptic Gregorian one; the clock time as typed.
  const g = civilFromJdn('gregorian', jdnFromDate(date));
  const frac = m[7] ? `.${m[7]}` : '';
  const iso = `${isoYear(g.year)}-${pad2(g.month)}-${pad2(g.day)}T${pad2(hour)}:${m[5]}:${pad2(second)}${frac}Z`;
  if (jdFromIso(iso) === null) return fail(`${raw} is not a real date and time (check the month, day, hour and minute).`);
  return m[6] === undefined ? { ok: true, value: iso, warning: SECONDS_OMITTED_WARNING } : ok(iso);
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
