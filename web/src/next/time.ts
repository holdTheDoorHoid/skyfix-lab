/**
 * Time for the explorer: Julian Date <-> JS time, stepping by calendar units in a time
 * zone, and display formatting that can always show UTC beside local time.
 *
 * The engine works only in UTC (`jd_utc`, EXPLORER_API "Common rules"). Everything here
 * is presentation: which wall clock to show, and what "one day later" means on it.
 * Zones follow CONVENTIONS 13.8: an IANA zone (through the browser's `Intl`), the
 * nautical zone time for a longitude, or UTC.
 *
 * Arithmetic is done on whole milliseconds: a `jd_utc` is converted to a rounded Unix
 * millisecond count, stepped, and converted back, so repeated steps never accumulate
 * floating-point drift.
 */

import { jdFromUnixMs, unixMsFromJd } from './engine/types.js';

export const MS_PER_SECOND = 1_000;
export const MS_PER_MINUTE = 60_000;
export const MS_PER_HOUR = 3_600_000;
export const MS_PER_DAY = 86_400_000;

/**
 * What the user chose for a place (stored with the observer, never persisted).
 * `guessed: true` means the zone was guessed from the place and follows it: the shell
 * guesses again whenever the place moves. Without it the person pinned the zone and it
 * stays (`zonePinned` in state.ts). UTC is always a pinned choice.
 */
export type ZoneChoice =
  | { kind: 'iana'; zone: string; guessed?: boolean }
  | { kind: 'nautical'; guessed?: boolean }
  | { kind: 'utc' };

/** A zone ready for arithmetic: an IANA zone, or a fixed offset from UTC. */
export type Zone = { kind: 'iana'; zone: string } | { kind: 'fixed'; offsetMs: number; name: string };

export const UTC_ZONE: Zone = { kind: 'fixed', offsetMs: 0, name: 'UTC' };

/** Wall-clock fields in a zone. `month` is 1-12, `weekday` 0 = Sunday. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  weekday: number;
  /** Local time minus UTC, milliseconds (UTC-4 is -14 400 000). */
  offsetMs: number;
}

/** The date-and-time part of a wall clock, as accepted by `jdFromWallClock`. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour?: number;
  minute?: number;
  second?: number;
  millisecond?: number;
}

// ---------------------------------------------------------------------------
// Julian Date <-> JS time
// ---------------------------------------------------------------------------

/** Unix milliseconds of a `jd_utc`, rounded to the millisecond. */
export function msFromJd(jd: number): number {
  return Math.round(unixMsFromJd(jd));
}

export function jdFromMs(ms: number): number {
  return jdFromUnixMs(ms);
}

export function jdFromDate(date: Date): number {
  return jdFromUnixMs(date.getTime());
}

export function dateFromJd(jd: number): Date {
  return new Date(msFromJd(jd));
}

/** The current instant as a `jd_utc`. */
export function jdNow(nowMs: number = Date.now()): number {
  return jdFromUnixMs(nowMs);
}

/** RFC 3339 UTC with milliseconds and a trailing `Z` (CONVENTIONS section 6). */
export function isoUtc(jd: number): string {
  return new Date(msFromJd(jd)).toISOString();
}

const RFC3339_Z = /^(-?\d{4,6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;

/** Parse RFC 3339 UTC with a trailing `Z`. Anything else (offsets, bad fields) is `null`. */
export function jdFromIso(text: string): number | null {
  const m = RFC3339_Z.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  const second = m[6] ? Number(m[6]) : 0;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return jdFromUnixMs(utcMs(year, month, day, hour, minute, second, ms));
}

// ---------------------------------------------------------------------------
// Calendar helpers (proleptic Gregorian, as JS Date)
// ---------------------------------------------------------------------------

/** `Date.UTC` without its 0-99 => 1900-1999 year mapping. Fields may overflow. */
export function utcMs(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, millisecond);
  return d.getTime();
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 30;
}

function floorMod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(zone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFormatters.set(zone, f);
  }
  return f;
}

/** True when the browser knows this IANA zone name. */
export function isValidIanaZone(zone: string): boolean {
  if (typeof zone !== 'string' || zone.length === 0 || zone.length > 64) return false;
  try {
    partsFormatter(zone);
    return true;
  } catch {
    return false;
  }
}

/** The browser's own zone, or `UTC` if it cannot say. */
export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Nautical zone description for a longitude (CONVENTIONS 13.8): `ZD = round(lon_east / -15)`,
 * so zone time + ZD = UTC. 75 W is ZD +5.
 */
export function nauticalZoneDescription(lonDeg: number): number {
  let lon = floorMod(lonDeg, 360);
  if (lon > 180) lon -= 360;
  const zd = Math.round(lon / -15);
  return zd === 0 ? 0 : zd; // no -0
}

/** Turn a stored choice into a zone ready for arithmetic. An unknown IANA name falls back to UTC. */
export function resolveZone(choice: ZoneChoice, lonDeg: number): Zone {
  switch (choice.kind) {
    case 'iana':
      return isValidIanaZone(choice.zone) ? { kind: 'iana', zone: choice.zone } : UTC_ZONE;
    case 'nautical': {
      const zd = nauticalZoneDescription(lonDeg);
      return { kind: 'fixed', offsetMs: -zd * MS_PER_HOUR, name: `ZD ${formatSigned(zd)}` };
    }
    case 'utc':
      return UTC_ZONE;
  }
}

function formatSigned(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '0';
}

/** Local minus UTC at an instant, milliseconds. */
export function zoneOffsetMs(ms: number, zone: Zone): number {
  if (zone.kind === 'fixed') return zone.offsetMs;
  const base = ms - floorMod(ms, 1000); // whole second; no zone offset has a fraction of one
  const w = ianaParts(base, zone.zone);
  return utcMs(w.year, w.month, w.day, w.hour, w.minute, w.second) - base;
}

function ianaParts(
  ms: number,
  zone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const out = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const part of partsFormatter(zone).formatToParts(new Date(ms))) {
    switch (part.type) {
      case 'year':
        out.year = Number(part.value);
        break;
      case 'month':
        out.month = Number(part.value);
        break;
      case 'day':
        out.day = Number(part.value);
        break;
      case 'hour':
        out.hour = Number(part.value) % 24;
        break;
      case 'minute':
        out.minute = Number(part.value);
        break;
      case 'second':
        out.second = Number(part.value);
        break;
      case 'era':
        bc = /^b/i.test(part.value);
        break;
      default:
        break;
    }
  }
  if (bc) out.year = 1 - out.year;
  return out;
}

/** Wall-clock fields of an instant in a zone. */
export function wallClockMs(ms: number, zone: Zone): WallClock {
  const offsetMs = zoneOffsetMs(ms, zone);
  const local = new Date(ms + offsetMs);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
    hour: local.getUTCHours(),
    minute: local.getUTCMinutes(),
    second: local.getUTCSeconds(),
    millisecond: local.getUTCMilliseconds(),
    weekday: local.getUTCDay(),
    offsetMs,
  };
}

export function wallClock(jd: number, zone: Zone): WallClock {
  return wallClockMs(msFromJd(jd), zone);
}

/**
 * The instant a wall clock in `zone` shows `wall`. Fields may overflow (day 32 is the 1st
 * of the next month). Daylight-saving transitions are resolved the way `Temporal` does
 * by default ("compatible"): a time in a spring-forward gap moves forward by the length
 * of the gap (02:30 becomes 03:30); a repeated time in a fall-back overlap takes the
 * earlier of its two instants.
 */
export function msFromWallClock(wall: WallTime, zone: Zone): number {
  const local = utcMs(
    wall.year,
    wall.month,
    wall.day,
    wall.hour ?? 0,
    wall.minute ?? 0,
    wall.second ?? 0,
    wall.millisecond ?? 0,
  );
  if (zone.kind === 'fixed') return local - zone.offsetMs;
  const before = zoneOffsetMs(local - MS_PER_DAY, zone);
  const after = zoneOffsetMs(local + MS_PER_DAY, zone);
  const candidates = before === after ? [local - before] : [local - before, local - after];
  const valid = candidates.filter((t) => t + zoneOffsetMs(t, zone) === local);
  if (valid.length > 0) return Math.min(...valid);
  // A gap: the offset before the transition carries the wall time past it.
  return local - before;
}

export function jdFromWallClock(wall: WallTime, zone: Zone): number {
  return jdFromUnixMs(msFromWallClock(wall, zone));
}

// ---------------------------------------------------------------------------
// Stepping
// ---------------------------------------------------------------------------

/** Add an exact duration (independent of any zone). */
export function addDuration(
  jd: number,
  d: { days?: number; hours?: number; minutes?: number; seconds?: number },
): number {
  const delta =
    (d.days ?? 0) * MS_PER_DAY +
    (d.hours ?? 0) * MS_PER_HOUR +
    (d.minutes ?? 0) * MS_PER_MINUTE +
    (d.seconds ?? 0) * MS_PER_SECOND;
  return jdFromUnixMs(msFromJd(jd) + Math.round(delta));
}

/**
 * Step by calendar units on the wall clock of `zone`, keeping the clock time. Years and
 * months are applied first and clamp the day (31 January + 1 month = 28 or 29 February),
 * then days. Across a daylight-saving change one day is 23 or 25 hours long.
 */
export function addCalendar(
  jd: number,
  zone: Zone,
  step: { years?: number; months?: number; days?: number },
): number {
  const w = wallClock(jd, zone);
  const monthIndex = w.month - 1 + (step.months ?? 0) + 12 * (step.years ?? 0);
  const year = w.year + Math.floor(monthIndex / 12);
  const month = floorMod(monthIndex, 12) + 1;
  const day = Math.min(w.day, daysInMonth(year, month));
  const date = new Date(utcMs(year, month, day) + (step.days ?? 0) * MS_PER_DAY);
  return jdFromWallClock(
    {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: w.hour,
      minute: w.minute,
      second: w.second,
      millisecond: w.millisecond,
    },
    zone,
  );
}

export type CalendarUnit = 'day' | 'month' | 'year';

/**
 * The calendar day, month or year containing `jd` on the wall clock of `zone`, as
 * `[jd_start, jd_end)` from local midnight to local midnight. This is the window the
 * explorer asks `day_events` for (EXPLORER_API, `day_events`).
 */
export function periodWindow(jd: number, zone: Zone, unit: CalendarUnit = 'day'): [number, number] {
  const w = wallClock(jd, zone);
  const startWall =
    unit === 'day'
      ? { year: w.year, month: w.month, day: w.day }
      : unit === 'month'
        ? { year: w.year, month: w.month, day: 1 }
        : { year: w.year, month: 1, day: 1 };
  const endWall =
    unit === 'day'
      ? { ...startWall, day: startWall.day + 1 }
      : unit === 'month'
        ? { ...startWall, month: startWall.month + 1 }
        : { ...startWall, year: startWall.year + 1 };
  return [jdFromWallClock(startWall, zone), jdFromWallClock(endWall, zone)];
}

/** The local calendar day containing `jd`: `[local midnight, next local midnight)`. */
export function dayWindow(jd: number, zone: Zone): [number, number] {
  return periodWindow(jd, zone, 'day');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function pad(n: number, width = 2): string {
  const s = String(Math.abs(n)).padStart(width, '0');
  return n < 0 ? `-${s}` : s;
}

/** `UTC`, `UTC+1`, `UTC−4`, `UTC+5:30`, `UTC+12:45`. */
export function formatOffset(offsetMs: number): string {
  if (offsetMs === 0) return 'UTC';
  const sign = offsetMs > 0 ? '+' : '−';
  const total = Math.round(Math.abs(offsetMs) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (s) return `UTC${sign}${h}:${pad(m)}:${pad(s)}`;
  return m ? `UTC${sign}${h}:${pad(m)}` : `UTC${sign}${h}`;
}

const abbrevFormatters = new Map<string, Intl.DateTimeFormat[]>();

/**
 * A letters-only abbreviation such as `EDT` or `CEST` when the browser has one for this
 * zone and instant; `null` otherwise (many zones only have `GMT+9`-style names). For a
 * fixed zone, its own name (`UTC`, `ZD +5`).
 */
export function zoneAbbreviation(jd: number, zone: Zone): string | null {
  if (zone.kind === 'fixed') return zone.name;
  let list = abbrevFormatters.get(zone.zone);
  if (!list) {
    list = ['en-US', 'en-GB'].map(
      (locale) => new Intl.DateTimeFormat(locale, { timeZone: zone.zone, timeZoneName: 'short' }),
    );
    abbrevFormatters.set(zone.zone, list);
  }
  const date = new Date(msFromJd(jd));
  for (const f of list) {
    const name = f.formatToParts(date).find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (/^[A-Z]{2,5}$/.test(name)) return name;
  }
  return null;
}

/**
 * A human label for a zone at an instant: `America/New_York · EDT (UTC−4)`,
 * `ZD +5 (UTC−5)`, `UTC`.
 */
export function zoneLabel(jd: number, zone: Zone): string {
  if (zone.kind === 'fixed') {
    return zone.offsetMs === 0 && zone.name === 'UTC'
      ? 'UTC'
      : `${zone.name} (${formatOffset(zone.offsetMs)})`;
  }
  const w = wallClock(jd, zone);
  const abbr = zoneAbbreviation(jd, zone);
  const offset = formatOffset(w.offsetMs);
  return abbr ? `${zone.zone} · ${abbr} (${offset})` : `${zone.zone} (${offset})`;
}

/** Short name for use right after a time: `EDT`, `UTC−3`, `ZD +5`, `UTC`. */
export function zoneShortName(jd: number, zone: Zone): string {
  return zoneAbbreviation(jd, zone) ?? formatOffset(zoneOffsetMs(msFromJd(jd), zone));
}

export interface TimeFormat {
  /** Show seconds. Default false. */
  seconds?: boolean;
}

/** `08:05` or `08:05:09` on the wall clock of `zone`. */
export function formatTime(jd: number, zone: Zone, options: TimeFormat = {}): string {
  return clockText(wallClock(jd, zone), options);
}

function clockText(w: WallClock, options: TimeFormat): string {
  const hm = `${pad(w.hour)}:${pad(w.minute)}`;
  return options.seconds ? `${hm}:${pad(w.second)}` : hm;
}

/** `2026-09-24` on the wall clock of `zone` (ISO order: unambiguous in every locale). */
export function formatDate(jd: number, zone: Zone): string {
  return dateText(wallClock(jd, zone));
}

function dateText(w: WallClock): string {
  const y = w.year >= 0 && w.year <= 9999 ? pad(w.year, 4) : String(w.year);
  return `${y}-${pad(w.month)}-${pad(w.day)}`;
}

/** `2026-09-24 08:05`. */
export function formatDateTime(jd: number, zone: Zone, options: TimeFormat = {}): string {
  const w = wallClock(jd, zone);
  return `${dateText(w)} ${clockText(w, options)}`;
}

/**
 * Local time with UTC beside it, as CONVENTIONS 13.8 asks:
 * `2026-09-24 08:05 EDT · 12:05 UTC`, or with the UTC date when it differs:
 * `2026-09-24 20:05 EDT · 2026-09-25 00:05 UTC`. In UTC itself: `2026-09-24 12:05 UTC`.
 */
export function formatWithUtc(jd: number, zone: Zone, options: TimeFormat = {}): string {
  const utc = wallClock(jd, UTC_ZONE);
  const utcText = `${clockText(utc, options)} UTC`;
  if (zone.kind === 'fixed' && zone.offsetMs === 0) return `${dateText(utc)} ${utcText}`;
  const local = wallClock(jd, zone);
  const localText = `${dateText(local)} ${clockText(local, options)} ${zoneShortName(jd, zone)}`;
  const sameDate = local.year === utc.year && local.month === utc.month && local.day === utc.day;
  return sameDate ? `${localText} · ${utcText}` : `${localText} · ${dateText(utc)} ${utcText}`;
}

/** A duration in hours as `11 h 57 min`. */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours)) return String(hours);
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h} h ${pad(m)} min` : `${m} min`;
}
