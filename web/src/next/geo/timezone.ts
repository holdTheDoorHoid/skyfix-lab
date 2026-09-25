/**
 * Displayed time (CONVENTIONS 13.8). OWNER: map-data agent.
 *
 * The engine works only in UTC (Julian dates). The UI shows one chosen zone and always UTC
 * beside it. A zone is one of:
 *
 *   iana      a civil time zone such as America/New_York, formatted with the browser's Intl;
 *   nautical  the zone description of a ship at sea, ZD = round(lon_east / -15), so that
 *             zone time + ZD = UTC (75 W is ZD +5, zone time = UTC - 5 h);
 *   utc       UTC itself.
 *
 * `guessZone` picks a sensible default for a position from offline public-domain data:
 * Natural Earth's country and state polygons and the gazetteer's places and IANA zone.tab
 * locations. It is a guess, always overridable; see docs/THIRD_PARTY.md for how it was
 * measured.
 */

import { jdFromUnixMs } from '../engine/types.js';
import { addDaysToDate, gregorianMs, isValidDate, jdnFromLocalMs, dateFromJdn, localMsOfDate } from '../time/civil.js';
import { isoDateKey } from '../time/format.js';
import type { Country, Gazetteer, ZoneAnchor } from './gazetteer.js';
import { greatCircleDistanceNm } from './greatcircle.js';
import type { RegionIndex } from './regions.js';

export type DisplayZone = { readonly kind: 'iana'; readonly id: string } | { readonly kind: 'nautical'; readonly zd: number } | { readonly kind: 'utc' };

export const UTC_ZONE: DisplayZone = { kind: 'utc' };

const MINUS = String.fromCharCode(0x2212); // U+2212 MINUS SIGN, for display

// ---------------------------------------------------------------------------------------
// Nautical zones

/**
 * Zone description for a longitude (east-positive): ZD = round(lon / -15), an integer from
 * -12 to +12. Zone boundaries fall on odd multiples of 7.5 degrees; on a boundary JavaScript's
 * Math.round decides (7.5 E -> ZD 0, 7.5 W -> ZD +1). 180 degrees is ZD -12.
 */
export function zoneDescription(lonDeg: number): number {
  let lon = lonDeg;
  if (!(lon > -180 && lon <= 180)) {
    lon = ((((lon + 180) % 360) + 360) % 360) - 180;
    if (lon === -180) lon = 180;
  }
  const zd = Math.round(lon / -15);
  return zd === 0 ? 0 : zd;
}

export function nauticalZone(lonDeg: number): DisplayZone {
  return { kind: 'nautical', zd: zoneDescription(lonDeg) };
}

/** "+5", "−3", "0": how a navigator writes a zone description. */
export function formatZoneDescription(zd: number): string {
  if (zd === 0) return '0';
  return zd > 0 ? `+${zd}` : `${MINUS}${-zd}`;
}

/**
 * The zone's letter: Z for ZD 0; A-M (J skipped) east of Greenwich, where ZD is -1 to -12;
 * N-Y west, where ZD is +1 to +12. ZD +5 (UTC - 5 h) is R.
 */
export function zoneLetter(zd: number): string {
  if (zd === 0) return 'Z';
  if (zd < 0) return 'ABCDEFGHIKLM'[-zd - 1] ?? '';
  return 'NOPQRSTUVWXY'[zd - 1] ?? '';
}

// ---------------------------------------------------------------------------------------
// Zone ids the browser understands

/** Names IANA has since changed; an older browser may know only the old one. */
const LEGACY_NAMES: Readonly<Record<string, readonly string[]>> = {
  'Europe/Kyiv': ['Europe/Kiev'],
  'America/Nuuk': ['America/Godthab'],
  'Pacific/Kanton': ['Pacific/Enderbury'],
  'Asia/Yangon': ['Asia/Rangoon'],
  'Asia/Kolkata': ['Asia/Calcutta'],
  'Asia/Ho_Chi_Minh': ['Asia/Saigon'],
  'Asia/Kathmandu': ['Asia/Katmandu'],
  'Atlantic/Faroe': ['Atlantic/Faeroe'],
  'America/Atikokan': ['America/Coral_Harbour'],
  'Pacific/Chuuk': ['Pacific/Truk'],
  'Pacific/Pohnpei': ['Pacific/Ponape'],
};

const alternatives = new Map<string, readonly string[]>();

/**
 * Same-clock alternatives for zones a browser may not know yet (America/Coyhaique, 2025).
 * `parseGazetteer` registers the table shipped in gazetteer.json.
 */
export function registerZoneAlternatives(table: ReadonlyMap<string, readonly string[]>): void {
  for (const [k, v] of table) alternatives.set(k, v);
}

const supported = new Map<string, boolean>();

/** Whether this browser's Intl accepts `id`. */
export function isSupportedZone(id: string): boolean {
  let ok = supported.get(id);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: id });
      ok = true;
    } catch {
      ok = false;
    }
    supported.set(id, ok);
  }
  return ok;
}

/**
 * The id to give Intl for `id`: itself, else an older name for it, else a zone with the same
 * clock today (from the gazetteer). Null when none is known; the zone cannot be shown.
 */
export function resolveIntlZone(id: string): string | null {
  if (isSupportedZone(id)) return id;
  for (const old of LEGACY_NAMES[id] ?? []) if (isSupportedZone(old)) return old;
  for (const alt of alternatives.get(id) ?? []) if (isSupportedZone(alt)) return alt;
  return null;
}

/** An Intl time-zone id for any display zone (`Etc/GMT+5` is UTC - 5 h, i.e. ZD +5). */
export function intlZoneId(zone: DisplayZone): string | null {
  switch (zone.kind) {
    case 'utc':
      return 'UTC';
    case 'nautical':
      return zone.zd === 0 ? 'Etc/GMT' : `Etc/GMT${zone.zd > 0 ? '+' : '-'}${Math.abs(zone.zd)}`;
    case 'iana':
      return resolveIntlZone(zone.id);
  }
}

/** A string for storing the choice: "utc", "zd:+5", or the IANA id. */
export function zoneKey(zone: DisplayZone): string {
  switch (zone.kind) {
    case 'utc':
      return 'utc';
    case 'nautical':
      return `zd:${zone.zd > 0 ? '+' : ''}${zone.zd}`;
    case 'iana':
      return zone.id;
  }
}

export function zoneFromKey(key: string): DisplayZone | null {
  if (key === 'utc' || key === 'UTC') return UTC_ZONE;
  const m = /^zd:([+-]?\d{1,2})$/.exec(key);
  if (m) {
    const zd = Number(m[1]);
    return Number.isInteger(zd) && Math.abs(zd) <= 12 ? { kind: 'nautical', zd: zd === 0 ? 0 : zd } : null;
  }
  return resolveIntlZone(key) ? { kind: 'iana', id: key } : null;
}

// ---------------------------------------------------------------------------------------
// Offsets and wall-clock time

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>();

function wallFormatter(id: string): Intl.DateTimeFormat {
  let f = wallFormatters.get(id);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: id,
      hourCycle: 'h23',
      // The era, so a year before AD 1 is read as one (Intl writes 585 BC as "585" and "BC").
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallFormatters.set(id, f);
  }
  return f;
}

/** Intl's wall clock: proleptic Gregorian, the year astronomical (1 BC is year 0). */
function intlWall(id: string, ms: number): Wall {
  const w: Wall = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  let bc = false;
  for (const p of wallFormatter(id).formatToParts(ms)) {
    if (p.type === 'year') w.year = Number(p.value);
    else if (p.type === 'month') w.month = Number(p.value);
    else if (p.type === 'day') w.day = Number(p.value);
    else if (p.type === 'hour') w.hour = Number(p.value) % 24;
    else if (p.type === 'minute') w.minute = Number(p.value);
    else if (p.type === 'second') w.second = Number(p.value);
    else if (p.type === 'era') bc = /^b/i.test(p.value);
  }
  if (bc) w.year = 1 - w.year;
  return w;
}

function requireIntlId(zone: DisplayZone): string {
  const id = intlZoneId(zone);
  if (id === null) throw new RangeError(`This browser does not know the time zone ${zoneKey(zone)} or any zone with the same clock.`);
  return id;
}

/** UTC offset of `zone` at the instant `ms` (JS timestamp), minutes: local = UTC + offset. */
export function zoneOffsetMinutes(zone: DisplayZone, ms: number): number {
  if (zone.kind === 'utc') return 0;
  if (zone.kind === 'nautical') return zone.zd === 0 ? 0 : -60 * zone.zd;
  const w = intlWall(requireIntlId(zone), ms);
  const wallMs = gregorianMs(w.year, w.month, w.day, w.hour, w.minute, w.second);
  return (wallMs - Math.floor(ms / 1000) * 1000) / 60000;
}

/**
 * The wall clock of an instant in a zone, the date in the display calendar (time/civil.ts:
 * Julian before 15 October 1582 unless Settings chose ISO; time-ui agent).
 */
function wallAt(zone: DisplayZone, ms: number): Wall {
  const local = ms + zoneOffsetMinutes(zone, ms) * 60000;
  const jdn = jdnFromLocalMs(local);
  const d = dateFromJdn(jdn);
  const t = local - (jdn - 2_440_588) * 86_400_000;
  return {
    year: d.year,
    month: d.month,
    day: d.day,
    hour: Math.floor(t / 3_600_000),
    minute: Math.floor((t % 3_600_000) / 60_000),
    second: Math.floor((t % 60_000) / 1000),
  };
}

/** "-04:00" (ASCII, ISO 8601). */
export function formatOffsetIso(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const a = Math.round(Math.abs(minutes));
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/** "UTC−4", "UTC+5:30", "UTC+0" (for display, with a true minus sign). */
export function formatOffsetLabel(minutes: number): string {
  const a = Math.round(Math.abs(minutes));
  const h = Math.floor(a / 60);
  const m = a % 60;
  const sign = minutes < 0 ? MINUS : '+';
  return `UTC${sign}${h}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

// Abbreviations such as EDT, BST, CEST, AEST and IST exist only in the matching English
// locale, so several are tried; a "GMT+2"-style answer means there is none.
const ABBREVIATION_LOCALES = ['en-US', 'en-GB', 'en-AU', 'en-IN', 'en-CA', 'en-NZ'];
const abbreviationCache = new Map<string, string>();
const nameFormatters = new Map<string, Intl.DateTimeFormat>();

function abbreviationOf(id: string, ms: number, offset: number): string {
  const key = `${id}|${offset}`;
  const hit = abbreviationCache.get(key);
  if (hit !== undefined) return hit;
  let found = '';
  for (const loc of ABBREVIATION_LOCALES) {
    const fk = `${loc}|${id}`;
    let f = nameFormatters.get(fk);
    if (!f) {
      f = new Intl.DateTimeFormat(loc, { timeZone: id, timeZoneName: 'short' });
      nameFormatters.set(fk, f);
    }
    const name = f.formatToParts(ms).find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (name && !/^(GMT|UTC)[^A-Za-z]/.test(name)) {
      found = name;
      break;
    }
  }
  abbreviationCache.set(key, found);
  return found;
}

export interface ZonedTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  /** "2026-09-24" */
  readonly date: string;
  /** "14:05:09" */
  readonly time: string;
  readonly offsetMinutes: number;
  /** "-04:00" */
  readonly offsetIso: string;
  /** "UTC−4" */
  readonly offsetLabel: string;
  /** "EDT", "CEST", "AEST", "UTC"; "" when the zone has no English abbreviation; "ZD +5" for nautical zones. */
  readonly abbreviation: string;
}

/** Wall-clock time of the instant `ms` in `zone`. */
export function zonedTime(ms: number, zone: DisplayZone): ZonedTime {
  const w = wallAt(zone, ms);
  const offset = zoneOffsetMinutes(zone, ms);
  const abbreviation =
    zone.kind === 'utc' ? 'UTC' : zone.kind === 'nautical' ? `ZD ${formatZoneDescription(zone.zd)}` : abbreviationOf(requireIntlId(zone), ms, offset);
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    ...w,
    date: isoDateKey(w),
    time: `${p2(w.hour)}:${p2(w.minute)}:${p2(w.second)}`,
    offsetMinutes: offset,
    offsetIso: formatOffsetIso(offset),
    offsetLabel: formatOffsetLabel(offset),
    abbreviation,
  };
}

/**
 * "2026-09-24 14:05 EDT (UTC−4)", "2026-09-24 22:05 UTC+9" (no English abbreviation),
 * "2026-09-24 13:05 ZD +5 (UTC−5)", "2026-09-24 18:05 UTC".
 */
export function formatZoned(ms: number, zone: DisplayZone, opts: { seconds?: boolean; date?: boolean } = {}): string {
  const t = zonedTime(ms, zone);
  const clock = opts.seconds ? t.time : t.time.slice(0, 5);
  const when = opts.date === false ? clock : `${t.date} ${clock}`;
  if (zone.kind === 'utc') return `${when} UTC`;
  return t.abbreviation ? `${when} ${t.abbreviation} (${t.offsetLabel})` : `${when} ${t.offsetLabel}`;
}

/** A name for the zone itself: "America/New_York", "Nautical zone ZD +5 (R)", "UTC". */
export function zoneName(zone: DisplayZone): string {
  switch (zone.kind) {
    case 'utc':
      return 'UTC';
    case 'nautical':
      return `Nautical zone ZD ${formatZoneDescription(zone.zd)} (${zoneLetter(zone.zd)})`;
    case 'iana':
      return zone.id;
  }
}

// ---------------------------------------------------------------------------------------
// Local days as Julian-date windows

export interface LocalDate {
  readonly year: number;
  /** 1-12 */
  readonly month: number;
  readonly day: number;
}

export function localDate(ms: number, zone: DisplayZone): LocalDate {
  const w = wallAt(zone, ms);
  return { year: w.year, month: w.month, day: w.day };
}

/**
 * Calendar arithmetic on dates (no time zone involved), in the display calendar: one day
 * after 4 October 1582 is 15 October (time-ui agent).
 */
export function addDays(date: LocalDate, days: number): LocalDate {
  const d = addDaysToDate(date, days);
  return { year: d.year, month: d.month, day: d.day };
}

/** `2026-09-24`, `-0584-05-28`, `+12345-01-01`: a real date of the display calendar, or null. */
export function parseLocalDate(text: string): LocalDate | null {
  const m = /^([+-]?\d{4,6})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) return null;
  const date = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  return isValidDate(date) ? { ...date, year: date.year === 0 ? 0 : date.year } : null;
}

/**
 * The first instant (JS timestamp) of `date` in `zone`: local midnight. Where the clocks
 * skip midnight (a spring-forward at 00:00, as Chile, Cuba and Lebanon use) the day starts at
 * the transition, the first instant the calendar shows `date`; where midnight happens twice
 * (a fall-back to 00:00, or 24:00 back to 23:00) the earlier one that is displayed as
 * `date` 00:00 counts.
 */
export function startOfLocalDay(zone: DisplayZone, date: LocalDate): number {
  const target = localMsOfDate(date);
  if (zone.kind !== 'iana') return target - zoneOffsetMinutes(zone, target) * 60000;
  const off = (ms: number) => zoneOffsetMinutes(zone, ms);
  const before = off(target - 86_400_000);
  const after = off(target + 86_400_000);
  // The usual case: the offset does not change within a day either side of midnight.
  if (before === after) return target - before * 60000;
  const candidates = [...new Set([before, off(target), after])]
    .map((o) => target - o * 60000)
    .filter((t) => off(t) * 60000 === target - t)
    .sort((a, b) => a - b);
  if (candidates.length) return candidates[0] as number;
  // Midnight does not exist: find the transition, the first instant whose wall time is
  // at or after `target`.
  let lo = target - 86_400_000 / 2 - 14 * 3_600_000;
  let hi = target + 86_400_000 / 2 + 14 * 3_600_000;
  const wallOf = (t: number) => t + off(t) * 60000;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (wallOf(mid) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface DayWindow {
  readonly date: LocalDate;
  /** UTC Julian dates of local midnight and the next local midnight: [jd_start, jd_end). */
  readonly jd_start: number;
  readonly jd_end: number;
  readonly start_ms: number;
  readonly end_ms: number;
  /** 24, or 23 / 25 (or 23.5 / 24.5) on the days the clocks change. */
  readonly hours: number;
}

/** Local midnight to local midnight for `date` in `zone`, as `[jd_start, jd_end)` for the engine. */
export function dayWindow(zone: DisplayZone, date: LocalDate | string): DayWindow {
  const d = typeof date === 'string' ? parseLocalDate(date) : date;
  if (!d) throw new RangeError(`Not a date (YYYY-MM-DD): ${String(date)}`);
  const start = startOfLocalDay(zone, d);
  const end = startOfLocalDay(zone, addDays(d, 1));
  return { date: d, jd_start: jdFromUnixMs(start), jd_end: jdFromUnixMs(end), start_ms: start, end_ms: end, hours: (end - start) / 3_600_000 };
}

/** The local day that contains the instant `ms`. */
export function dayWindowAt(ms: number, zone: DisplayZone): DayWindow {
  return dayWindow(zone, localDate(ms, zone));
}

// ---------------------------------------------------------------------------------------
// The list of zones for a picker

/** Used only when the browser cannot list its zones and no gazetteer is loaded. */
const FALLBACK_ZONES = [
  'Africa/Cairo', 'Africa/Johannesburg', 'Africa/Lagos', 'Africa/Nairobi', 'America/Anchorage', 'America/Argentina/Buenos_Aires',
  'America/Bogota', 'America/Chicago', 'America/Denver', 'America/Halifax', 'America/Los_Angeles', 'America/Mexico_City',
  'America/New_York', 'America/Phoenix', 'America/Santiago', 'America/Sao_Paulo', 'America/St_Johns', 'America/Toronto',
  'America/Vancouver', 'Asia/Bangkok', 'Asia/Dhaka', 'Asia/Dubai', 'Asia/Hong_Kong', 'Asia/Jakarta', 'Asia/Karachi',
  'Asia/Kolkata', 'Asia/Manila', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Tehran', 'Asia/Tokyo',
  'Atlantic/Azores', 'Atlantic/Reykjavik', 'Australia/Adelaide', 'Australia/Brisbane', 'Australia/Perth', 'Australia/Sydney',
  'Europe/Athens', 'Europe/Berlin', 'Europe/Istanbul', 'Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'Europe/Moscow',
  'Europe/Paris', 'Europe/Rome', 'Pacific/Auckland', 'Pacific/Honolulu',
];

/**
 * Every zone the browser knows, one name per zone, with `preferred` names (the gazetteer's
 * current IANA names, e.g. Asia/Kolkata) winning over the older names some browsers list
 * (Asia/Calcutta). "UTC" first, then alphabetical.
 */
export function listTimeZones(preferred: readonly string[] = []): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let listed: string[] = [];
  try {
    listed = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    listed = [];
  }
  // The browser's own list is already canonical; only other names need Intl to say which
  // zone they are (constructing a formatter costs about a millisecond).
  const listedSet = new Set(listed);
  const byCanonical = new Map<string, string>();
  const add = (id: string) => {
    if (id === 'UTC') return;
    let canonical = id;
    if (!listedSet.has(id)) {
      if (!isSupportedZone(id)) return;
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: id }).resolvedOptions().timeZone;
    }
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, id);
  };
  for (const id of preferred) add(id);
  for (const id of listed.length ? listed : FALLBACK_ZONES) add(id);
  return ['UTC', ...[...byCanonical.values()].sort()];
}

// ---------------------------------------------------------------------------------------
// Guessing the zone for a position

/** "Near enough" to land or to a place: 12 NM, the territorial sea. */
export const NEAR_LAND_NM = 12;
/**
 * Without country polygons (only while they load), a place this close lends its zone: land
 * cannot be told from sea then, and places are typically 20-80 NM apart in open country.
 * Call `guessZone` again once the region index has loaded.
 */
export const NEARBY_WITHOUT_POLYGONS_NM = 150;

/** Countries with no civil time of their own: positions there use the nautical zone. */
const NO_CIVIL_TIME = new Set(['ATA']);

export type GuessSource =
  /** One zone for the whole country. */
  | 'country'
  /** One zone for the whole state or province (large multi-zone countries). */
  | 'region'
  /** The nearest place in the same country (and state, where there are several zones). */
  | 'nearest'
  /** On land in a country with no known zones: the nearest place anywhere. */
  | 'nearest-land'
  /** At sea but within 12 NM of a place: that place's zone. */
  | 'coast'
  /** No country polygons loaded (yet): a place within 150 NM. */
  | 'nearby'
  /** At sea: the nautical zone. */
  | 'sea';

export interface ZoneGuess {
  readonly zone: DisplayZone;
  readonly source: GuessSource;
  /** One English sentence saying where the zone came from. */
  readonly reason: string;
  /** The place or zone.tab location that lent its zone; null for the nautical zone. */
  readonly anchor: ZoneAnchor | null;
  readonly anchorDistanceNm: number;
  /**
   * The country whose 1:50m polygon the position is in or within 12 NM of; null at sea.
   * Antarctica is reported, although it takes the nautical zone. A territory too small for
   * the polygons reports the country around it (a click on Gibraltar reports Spain), so name
   * places with `describeLocation`, not with this.
   */
  readonly country: Country | null;
}

interface AnchorIndex {
  readonly byLookupCountry: ReadonlyMap<number, readonly ZoneAnchor[]>;
  /** region -> zone -> number of anchors */
  readonly regionZones: ReadonlyMap<number, ReadonlyMap<string, number>>;
}

const anchorIndexes = new WeakMap<Gazetteer, AnchorIndex>();

function anchorIndex(g: Gazetteer): AnchorIndex {
  let idx = anchorIndexes.get(g);
  if (idx) return idx;
  const byLookupCountry = new Map<number, ZoneAnchor[]>();
  const regionZones = new Map<number, Map<string, number>>();
  for (const a of g.anchors) {
    const lookup = g.countries[a.country]?.lookup ?? -1;
    if (lookup >= 0) {
      const list = byLookupCountry.get(lookup);
      if (list) list.push(a);
      else byLookupCountry.set(lookup, [a]);
    }
    if (a.region >= 0) {
      let m = regionZones.get(a.region);
      if (!m) regionZones.set(a.region, (m = new Map()));
      m.set(a.zone, (m.get(a.zone) ?? 0) + 1);
    }
  }
  idx = { byLookupCountry, regionZones };
  anchorIndexes.set(g, idx);
  return idx;
}

function nearestAnchor(anchors: Iterable<ZoneAnchor>, at: { lat_deg: number; lon_deg: number }, exclude: number, maxNm = Infinity) {
  let best: ZoneAnchor | null = null;
  let bestD = maxNm;
  for (const a of anchors) {
    if (exclude >= 0 && a.place === exclude) continue;
    // One degree of latitude is 60 NM: anything farther north or south cannot be closer.
    if (Math.abs(a.lat_deg - at.lat_deg) * 60 > bestD) continue;
    const d = greatCircleDistanceNm(at, a);
    if (d < bestD || (best === null && d === bestD)) {
      best = a;
      bestD = d;
    }
  }
  return best ? { anchor: best, distanceNm: bestD } : null;
}

export interface GuessOptions {
  /**
   * Leave this place out of the guess, as if it were not in the gazetteer (used by the
   * hold-out test that measures the guess on the gazetteer's own cities).
   */
  excludePlace?: number;
}

const round = (x: number) => (x < 10 ? x.toFixed(1) : Math.round(x).toString());

/**
 * A display zone for a position, with the reason. Needs the gazetteer; the region index
 * (country and state polygons) makes it much better and should be passed when loaded.
 *
 *  1. On land or within 12 NM of it (country polygons): the zone of the nearest place or
 *     zone.tab location in that country. In the large multi-zone countries (United States,
 *     Canada, Russia, Brazil, Australia, Indonesia, China) only zones used in the same state
 *     are considered. Antarctica has no civil time and counts as sea.
 *  2. Otherwise, within 12 NM of a place or zone.tab location: its zone (small islands).
 *  3. Otherwise the nautical zone, ZD = round(lon / -15).
 *
 * Without the region index, step 1 is skipped and step 2 uses 150 NM; call again once the
 * region index has loaded.
 */
export function guessZone(lat: number, lon: number, g: Gazetteer, regions: RegionIndex | null, opts: GuessOptions = {}): ZoneGuess {
  const exclude = opts.excludePlace ?? -1;
  const at = { lat_deg: lat, lon_deg: lon };
  const idx = anchorIndex(g);
  let country: Country | null = null;
  if (regions) {
    const hit = regions.locateCountry(lat, lon, NEAR_LAND_NM);
    country = hit ? (g.countries[hit.index] ?? null) : null;
    if (hit && country && !NO_CIVIL_TIME.has(country.a3)) {
      const all = idx.byLookupCountry.get(hit.index) ?? [];
      let pool: readonly ZoneAnchor[] = all.filter((a) => a.place !== exclude || exclude < 0);
      if (pool.length) {
        const countrySingle = pool.every((a) => a.zone === pool[0]?.zone);
        let regionName: string | null = null;
        const region = countrySingle ? null : regions.locateRegion(lat, lon, hit.index, NEAR_LAND_NM);
        if (region) {
          const counts = idx.regionZones.get(region.index);
          if (counts) {
            const zonesHere = new Set<string>();
            for (const [z, n] of counts) {
              const own = exclude >= 0 && g.places[exclude]?.region === region.index && g.places[exclude]?.zone === z ? 1 : 0;
              if (n - own > 0) zonesHere.add(z);
            }
            const narrowed = pool.filter((a) => zonesHere.has(a.zone));
            if (narrowed.length) {
              pool = narrowed;
              regionName = g.regions[region.index]?.name ?? null;
            }
          }
        }
        const best = nearestAnchor(pool, at, exclude);
        if (best) {
          const single = pool.every((a) => a.zone === best.anchor.zone);
          const zone = best.anchor.zone;
          const [source, reason]: [GuessSource, string] = countrySingle
            ? ['country', `${zone}, the time zone of ${country.name}.`]
            : single && regionName
              ? ['region', `${zone}, the time zone of ${regionName}, ${country.name}.`]
              : ['nearest', `${zone}, the time zone of ${best.anchor.label} (${round(best.distanceNm)} NM away), the nearest place with a known zone.`];
          return { zone: { kind: 'iana', id: zone }, source, reason, anchor: best.anchor, anchorDistanceNm: best.distanceNm, country };
        }
      }
      if (hit.distanceNm === 0) {
        const best = nearestAnchor(g.anchors, at, exclude);
        if (best) {
          return {
            zone: { kind: 'iana', id: best.anchor.zone },
            source: 'nearest-land',
            reason: `${best.anchor.zone}, the time zone of ${best.anchor.label} (${round(best.distanceNm)} NM away); no zone is known for ${country.name}.`,
            anchor: best.anchor,
            anchorDistanceNm: best.distanceNm,
            country,
          };
        }
      }
    }
  }
  const limit = regions ? NEAR_LAND_NM : NEARBY_WITHOUT_POLYGONS_NM;
  const near = nearestAnchor(g.anchors, at, exclude, limit);
  if (near) {
    return {
      zone: { kind: 'iana', id: near.anchor.zone },
      source: regions ? 'coast' : 'nearby',
      reason: `${near.anchor.zone}, the time zone of ${near.anchor.label}, ${round(near.distanceNm)} NM away.`,
      anchor: near.anchor,
      anchorDistanceNm: near.distanceNm,
      country: regions ? country : (g.countries[near.anchor.country] ?? null),
    };
  }
  const zd = zoneDescription(lon);
  return {
    zone: { kind: 'nautical', zd },
    source: 'sea',
    reason: `At sea: nautical zone ZD ${formatZoneDescription(zd)} (${zoneLetter(zd)}), zone time = UTC ${zd > 0 ? MINUS : '+'} ${Math.abs(zd)} h.`,
    anchor: null,
    anchorDistanceNm: Number.NaN,
    country,
  };
}
