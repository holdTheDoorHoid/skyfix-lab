/**
 * Calendar files: events as an RFC 5545 iCalendar file (`.ics`) that any calendar program
 * imports, made in the page and never sent anywhere. OWNER: events2 agent (expansion
 * programme Q4); shared by any view that offers "Add to calendar" (CONVENTIONS 15.8).
 *
 *   const text = icsCalendar({ name: 'SkyFix Lab: Moon', now: Date.now(), events: [
 *     { uid: 'full-moon-20261026@skyfix-lab.events', start: jd, summary: 'Full Moon',
 *       description: 'The Moon is opposite the Sun …' },
 *   ] });
 *   saveIcs(text, 'skyfix-full-moon-2026-10-26.ics');
 *
 * The rules, so every file means the same thing:
 *
 * - **Times are UTC** (`DTSTART:20261026T041200Z`), rounded to the second. On the app's
 *   clock outside 1972-2035 the instant is Universal Time (UT), which a calendar reads as
 *   UTC: the description says so (CONVENTIONS 15.2), and gives the uncertainty in the
 *   Earth's rotation when it exceeds the display precision.
 * - **An instant has no `DTEND`** (RFC 5545 3.6.1: it ends when it starts); an event with a
 *   duration (an eclipse, an occultation, a transit) has `DTEND` after `DTSTART`.
 * - **UIDs are stable**: the same event exported twice, from any place, has the same UID,
 *   so a calendar updates the entry instead of adding a second one. They never contain
 *   the place.
 * - **Only years 1 to 9999** fit the format (`date-fullyear = 4DIGIT`, Gregorian):
 *   `icsDateTime` is null outside them and such events are left out (`icsExportable`).
 * - TEXT values escape `\`, `;`, `,` and line breaks (3.3.11); lines are folded at 75
 *   octets without splitting a UTF-8 character (3.1); every line ends with CRLF.
 * - `TRANSP:TRANSPARENT`: an event in the sky never makes the person look busy.
 *
 * Pure functions except `saveIcs` and `shareIcs` (which need a document or a navigator).
 */

import { saveBlob } from './csv.js';

/** One event of a calendar file. */
export interface IcsEvent {
  /** Stable across exports (see the rules above). */
  readonly uid: string;
  /** The instant, or the start, as a UTC Julian date (the app's clock). */
  readonly start: number;
  /** The end, after `start`; null or absent for an instant. */
  readonly end?: number | null;
  readonly summary: string;
  readonly description?: string;
  /** Where the times hold: a place name and its coordinates, when the person included it. */
  readonly location?: string;
  readonly geo?: { readonly lat_deg: number; readonly lon_deg: number } | null;
  readonly categories?: readonly string[];
}

export interface IcsCalendarSpec {
  /** Shown by calendar programs as the imported calendar's name (`X-WR-CALNAME`). */
  readonly name?: string;
  /** When the file was made, Unix milliseconds (`DTSTAMP`; required by RFC 5545). */
  readonly now: number;
  readonly events: readonly IcsEvent[];
}

export const ICS_PRODID = '-//SkyFix Lab//Events//EN';
export const ICS_MIME = 'text/calendar;charset=utf-8';
/** The right-hand side of every UID this site makes. */
export const UID_DOMAIN = 'skyfix-lab.events';

const CRLF = '\r\n';
const MS_PER_DAY = 86_400_000;
const JD_UNIX_EPOCH = 2_440_587.5;

// ---------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** The UTC calendar fields of a Unix time (proleptic Gregorian, as `Date` and the wire). */
function utcFields(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } | null {
  if (!Number.isFinite(ms)) return null;
  const date = new Date(Math.round(ms / 1000) * 1000);
  const y = date.getUTCFullYear();
  if (!Number.isFinite(y)) return null;
  return {
    y,
    mo: date.getUTCMonth() + 1,
    d: date.getUTCDate(),
    h: date.getUTCHours(),
    mi: date.getUTCMinutes(),
    s: date.getUTCSeconds(),
  };
}

/** `20261026T041200Z` from Unix milliseconds, rounded to the second; null outside years 1-9999. */
export function icsDateTimeMs(ms: number): string | null {
  const f = utcFields(ms);
  if (!f || f.y < 1 || f.y > 9999) return null;
  return `${pad(f.y, 4)}${pad(f.mo)}${pad(f.d)}T${pad(f.h)}${pad(f.mi)}${pad(f.s)}Z`;
}

/** `20261026T041200Z` from a UTC Julian date; null outside years 1-9999. */
export function icsDateTime(jd: number): string | null {
  return Number.isFinite(jd) ? icsDateTimeMs((jd - JD_UNIX_EPOCH) * MS_PER_DAY) : null;
}

/** True when an instant can be written in a calendar file (years 1 to 9999). */
export function icsExportable(jd: number): boolean {
  return icsDateTime(jd) !== null;
}

/** A TEXT value (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks escaped. */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Octets of a string in UTF-8. */
function utf8Length(text: string): number {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

/**
 * Fold a content line at 75 octets (RFC 5545 3.1): each continuation starts with a space,
 * and no UTF-8 character is split. Returns the folded text without the final CRLF.
 */
export function foldLine(line: string, limit = 75): string {
  if (utf8Length(line) <= limit) return line;
  const parts: string[] = [];
  let current = '';
  let octets = 0;
  // The first line holds `limit` octets; continuations hold `limit - 1` after their space.
  let room = limit;
  for (const ch of line) {
    const size = utf8Length(ch);
    if (octets + size > room) {
      parts.push(current);
      current = '';
      octets = 0;
      room = limit - 1;
    }
    current += ch;
    octets += size;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

/** A GEO value: `39.9526;-75.1652` (degrees, north and east positive). */
export function icsGeo(latDeg: number, lonDeg: number): string | null {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg) || Math.abs(latDeg) > 90) return null;
  const clean = (x: number): string => {
    const t = x.toFixed(4);
    return Number(t) === 0 ? '0.0000' : t;
  };
  return `${clean(latDeg)};${clean(lonDeg)}`;
}

/** A UID from the parts that name an event: `full-moon-2026-10-26@skyfix-lab.events`. */
export function icsUid(parts: readonly (string | number | null | undefined)[]): string {
  const slug = parts
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .map((p) =>
      String(p)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('-');
  return `${slug || 'event'}@${UID_DOMAIN}`;
}

// ---------------------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------------------

function property(name: string, value: string): string {
  return foldLine(`${name}:${value}`);
}

function eventLines(e: IcsEvent, stamp: string): string[] | null {
  const start = icsDateTime(e.start);
  if (start === null) return null;
  const end = e.end !== null && e.end !== undefined && e.end > e.start ? icsDateTime(e.end) : null;
  const lines = [
    'BEGIN:VEVENT',
    property('UID', e.uid),
    `DTSTAMP:${stamp}`,
    `DTSTART:${start}`,
  ];
  // DTEND must be later than DTSTART (3.8.2.2): a start and end in the same second is an instant.
  if (end !== null && end !== start) lines.push(`DTEND:${end}`);
  lines.push(property('SUMMARY', icsText(e.summary)));
  if (e.description) lines.push(property('DESCRIPTION', icsText(e.description)));
  if (e.location) lines.push(property('LOCATION', icsText(e.location)));
  const geo = e.geo ? icsGeo(e.geo.lat_deg, e.geo.lon_deg) : null;
  if (geo) lines.push(`GEO:${geo}`);
  if (e.categories?.length) lines.push(property('CATEGORIES', e.categories.map(icsText).join(',')));
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return lines;
}

/**
 * The calendar file's text: a VCALENDAR with one VEVENT per event that fits the format
 * (years 1-9999), every line folded and ended with CRLF. Events with the same UID after
 * the first are left out (a calendar file names each event once).
 */
export function icsCalendar(spec: IcsCalendarSpec): string {
  const stamp = icsDateTimeMs(spec.now) ?? '19700101T000000Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${ICS_PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (spec.name) lines.push(property('X-WR-CALNAME', icsText(spec.name)));
  const seen = new Set<string>();
  for (const e of spec.events) {
    if (seen.has(e.uid)) continue;
    const block = eventLines(e, stamp);
    if (!block) continue;
    seen.add(e.uid);
    lines.push(...block);
  }
  lines.push('END:VCALENDAR');
  return `${lines.join(CRLF)}${CRLF}`;
}

/** How many of the events a file would hold (those in years 1-9999, one per UID). */
export function icsEventCount(events: readonly IcsEvent[]): number {
  const seen = new Set<string>();
  for (const e of events) if (icsExportable(e.start)) seen.add(e.uid);
  return seen.size;
}

/** `skyfix-full-moon-2026-10-26.ics` from its parts (lower case, dashes, no empty parts). */
export function icsFileName(parts: readonly (string | number | null | undefined)[]): string {
  const stem = ['skyfix', ...parts]
    .filter((p) => p !== null && p !== undefined && String(p) !== '')
    .map((p) =>
      String(p)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter(Boolean)
    .join('-')
    .slice(0, 90);
  return `${stem}.ics`;
}

// ---------------------------------------------------------------------------------------
// Saving and sharing (the only parts that touch the page)
// ---------------------------------------------------------------------------------------

/** Hand the file to the browser as a download (on phones this usually offers the calendar). */
export function saveIcs(text: string, fileName: string, doc: Document = document): void {
  saveBlob(new Blob([text], { type: ICS_MIME }), fileName, doc);
}

type ShareNavigator = Navigator & {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

function icsFile(text: string, fileName: string): File | null {
  try {
    return new File([text], fileName, { type: 'text/calendar' });
  } catch {
    return null;
  }
}

/**
 * True when this device's share sheet takes a calendar file (Web Share with files; most
 * desktop browsers and some phones do not, and then only the download is offered).
 */
export function canShareIcs(nav: ShareNavigator | undefined = globalThis.navigator as ShareNavigator | undefined): boolean {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  const file = icsFile('BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'event.ics');
  if (!file) return false;
  try {
    return nav.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unavailable' | 'failed';

/** Offer the file to the device's share sheet. Closing the sheet is `cancelled`, not a failure. */
export async function shareIcs(
  text: string,
  fileName: string,
  title: string,
  nav: ShareNavigator | undefined = globalThis.navigator as ShareNavigator | undefined,
): Promise<ShareOutcome> {
  const file = icsFile(text, fileName);
  if (!nav?.share || !file || !canShareIcs(nav)) return 'unavailable';
  try {
    await nav.share({ files: [file], title });
    return 'shared';
  } catch (error) {
    return (error as { name?: string } | null)?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
