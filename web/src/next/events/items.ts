/**
 * One shape for every event the Events view lists — a Moon phase, a perigee, an
 * occultation, a meteor shower's peak — so every list can be clicked, drawn, added to a
 * calendar and saved as a table in the same way. OWNER: events2 agent.
 *
 * Each tab turns the engine's answer into `EventItem`s with a `Words` (how times, angles
 * and distances are written): the screen's words for the list, the file's words (times
 * with their zone's name) for a calendar file. Pure: no DOM, tested in
 * web/test/next/events-export.test.ts.
 */

import type { ExplorerEngine } from '../engine/types.js';
import { icsCalendar, icsUid, type IcsEvent } from '../export/ics.js';
import {
  clockSeconds,
  compassWords,
  dateMedium,
  dateShort,
  eventTime,
  formatAngle,
  formatDistance,
  formatLat,
  formatLon,
  formatMagnitude,
} from '../shell/format.js';
import { cellText, rowsToCsv, type CsvCell } from '../export/csv.js';
import { displayZone, type ExplorerState } from '../state.js';
import { isoUtc, roundToMinute, UTC_ZONE, zoneShortName, type Zone } from '../time.js';
import { chipNeeded, scaleLabel, scaleReason, timeInfoAt, uncertaintyText, uncertaintyTip } from '../time/index.js';

/** An event as every list, calendar file and table sees it. */
export interface EventItem {
  /** Names the event wherever it is computed (the UID's name part; see CONVENTIONS 15.8). */
  readonly id: string;
  /** The list it belongs to, for files: `Moon`, `Planets`, `Meteor showers`… */
  readonly group: string;
  /** What kind of event, briefly: `Perigee`, `Occultation`, `Station`… */
  readonly kind: string;
  /** Plain words: `Regulus hidden by the Moon`. */
  readonly title: string;
  /** The astronomer's term beside it (`occultation`), shown with the navigator's terms. */
  readonly term?: string;
  /** The instant, or the start (UTC Julian date). */
  readonly start: number;
  /** The end, for an event that lasts; null for an instant. */
  readonly end: number | null;
  /** Where a click sets the explorer's time (the best moment to look, else the start). */
  readonly jump: number;
  /** The body a click selects, or null to leave the selection. */
  readonly body: string | null;
  /** One to three plain sentences. */
  readonly sentence: string;
  /** The times hold for the observer's place only (local circumstances). */
  readonly local: boolean;
  /** Extra columns for a table, in order: `[heading, value]`. */
  readonly columns: readonly (readonly [string, CsvCell])[];
}

/** How a tab writes what its sentences mention. */
export interface Words {
  /** A clock time rounded to the minute: `03:12` (screen) or `03:12 EDT` (file). */
  time(jd: number): string;
  /** To the second: `03:12:08`. */
  seconds(jd: number): string;
  /** `Thu 24 Sep`. */
  date(jd: number): string;
  /** `Thu 24 Sep 2026`. */
  dateYear(jd: number): string;
  /** An angle in the chosen format, coarse: `0° 31′`. */
  angle(deg: number): string;
  /** A height above the horizon in whole degrees: `34°`. */
  altitude(deg: number): string;
  /** A direction in words: `south-east`. */
  direction(azDeg: number): string;
  /** A distance in the chosen units: `357 123 km`. */
  distance(km: number): string;
  /** A magnitude with a true minus: `−1.2`. */
  magnitude(m: number | null): string;
}

function isUtc(zone: Zone): boolean {
  return zone.kind === 'fixed' && zone.offsetMs === 0;
}

/** The name written after a time in `zone`: `EDT`, `LMT`, or `UTC`/`UT` (the clock's scale). */
function tagOf(zone: Zone, jd: number): string {
  return isUtc(zone) ? scaleLabel(jd) : zoneShortName(jd, zone);
}

/** The screen's words: times in the display zone (the view's header names it). */
export function screenWords(state: ExplorerState): Words {
  const zone = displayZone(state);
  const format = state.settings.angleFormat;
  return {
    time: (jd) => eventTime(jd, zone),
    seconds: (jd) => clockSeconds(jd, zone),
    date: (jd) => dateShort(roundToMinute(jd), zone),
    dateYear: (jd) => dateMedium(roundToMinute(jd), zone),
    angle: (deg) => formatAngle(deg, format, 'coarse'),
    altitude: (deg) => `${Math.round(deg)}°`.replace('-', '−'),
    direction: (az) => compassWords(az),
    distance: (km) => formatDistance(km, state.settings.units),
    magnitude: (m) => formatMagnitude(m),
  };
}

/** A file's words: every time carries its zone's name (`03:12 EDT`), since a file travels. */
export function fileWords(state: ExplorerState): Words {
  const zone = displayZone(state);
  const w = screenWords(state);
  return {
    ...w,
    time: (jd) => `${eventTime(jd, zone)} ${tagOf(zone, jd)}`,
    seconds: (jd) => `${clockSeconds(jd, zone)} ${tagOf(zone, jd)}`,
  };
}

// ---------------------------------------------------------------------------------------
// Calendar files
// ---------------------------------------------------------------------------------------

/** Where the times hold, when the person chose to name the place in a file. */
export interface FilePlace {
  label: string;
  lat_deg: number;
  lon_deg: number;
}

export interface FileContext {
  engine: ExplorerEngine;
  /** Null: the file does not name the place (local times still say they are for one). */
  place: FilePlace | null;
  /** How coordinates are written (the person's angle format). */
  format: ExplorerState['settings']['angleFormat'];
}

/** `Philadelphia City Hall (39° 57′ N, 75° 10′ W)`. */
export function placeText(place: FilePlace, format: FileContext['format']): string {
  const where = `${formatLat(place.lat_deg, format)}, ${formatLon(place.lon_deg, format)}`;
  return place.label ? `${place.label} (${where})` : where;
}

/**
 * What a calendar file says about an event's clock: UT outside 1972-2035 (a calendar reads
 * the file's times as UTC), and the uncertainty of the Earth's rotation when it counts.
 */
export function clockNote(engine: ExplorerEngine, jd: number): string {
  const parts: string[] = [];
  const reason = scaleReason(jd);
  if (reason) parts.push(`The time is Universal Time (UT), written as UTC in this file. ${reason}`);
  const info = timeInfoAt(engine, jd);
  if (chipNeeded(info)) parts.push(`Uncertain by ${uncertaintyText(info).slice(1)}: ${uncertaintyTip(info)}`);
  return parts.join(' ');
}

/** The calendar entry for an event. */
export function icsEventOf(item: EventItem, fc: FileContext): IcsEvent {
  const lines = [item.sentence];
  if (item.local) {
    lines.push(fc.place ? `Times for ${placeText(fc.place, fc.format)}.` : 'Times for the place it was computed for (not named in this file).');
  }
  const clock = clockNote(fc.engine, item.start);
  if (clock) lines.push(clock);
  lines.push('Computed offline by SkyFix Lab (https://holdthedoorhoid.github.io/skyfix-lab/); a prediction, not an observation.');
  return {
    uid: icsUid([item.id]),
    start: item.start,
    end: item.end,
    summary: item.term ? `${item.title} (${item.term})` : item.title,
    description: lines.join('\n'),
    location: item.local && fc.place ? placeText(fc.place, fc.format) : undefined,
    geo: item.local && fc.place ? { lat_deg: fc.place.lat_deg, lon_deg: fc.place.lon_deg } : null,
    categories: ['SkyFix Lab', item.group],
  };
}

/** A calendar file holding the items. `now` is when it is made (Unix ms). */
export function icsOfItems(items: readonly EventItem[], name: string, fc: FileContext, now: number): string {
  return icsCalendar({ name: `SkyFix Lab: ${name}`, now, events: items.map((i) => icsEventOf(i, fc)) });
}

// ---------------------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------------------

const BASE_COLUMNS = ['Instant', 'Scale', 'Local date', 'Local time', 'Zone', 'Kind', 'Event', 'End', 'Uncertainty', 'Body', 'Description'];

/** A table of the items: common columns, then each kind's own (the union, in the order met). */
export function csvOfItems(
  items: readonly EventItem[],
  state: ExplorerState,
  engine: ExplorerEngine,
  comments: readonly string[],
): string {
  const zone = displayZone(state);
  const extra: string[] = [];
  for (const item of items) for (const [name] of item.columns) if (!extra.includes(name)) extra.push(name);
  const text = (v: CsvCell): CsvCell => (typeof v === 'string' ? cellText(v) : v);
  const second = (jd: number): string => isoUtc(Math.round(jd * 86_400) / 86_400).replace(/\.\d{3}Z$/, 'Z');
  const rows: CsvCell[][] = [[...BASE_COLUMNS, ...extra]];
  for (const item of items) {
    const own = new Map(item.columns.map(([k, v]) => [k, v] as const));
    rows.push(
      [
        second(item.start),
        scaleLabel(item.start),
        dateMedium(roundToMinute(item.start), zone),
        eventTime(item.start, zone),
        tagOf(zone, item.start),
        item.kind,
        item.term ? `${item.title} (${item.term})` : item.title,
        item.end === null ? '' : second(item.end),
        uncertaintyText(timeInfoAt(engine, item.start)),
        item.body ?? '',
        item.sentence,
        ...extra.map((name) => own.get(name) ?? ''),
      ].map(text),
    );
  }
  return rowsToCsv(rows, { comments });
}

/**
 * The header lines of a table: what it is, where (when the person chose to name the place
 * and the times are local), the clock, what the numbers are.
 */
export function csvComments(
  title: string,
  state: ExplorerState,
  place: FilePlace | null,
  local: boolean,
  notes: readonly string[] = [],
): string[] {
  const zone = displayZone(state);
  const lines = [`SkyFix Lab: ${title}`];
  if (local) lines.push(place ? `Seen from ${placeText(place, state.settings.angleFormat)}` : 'Times for the place they were computed for (not named in this file)');
  lines.push(
    `Instants: ISO 8601 on the app's clock (UTC in 1972-2035, Universal Time UT outside; the Scale column says which), and local times in ${isUtc(zone) ? 'the same clock' : `the ${zoneShortName(state.time.jd_utc, zone)} zone`}. Computed offline by SkyFix Lab: predictions, not observations.`,
  );
  return [...lines, ...notes];
}

/** `2026-10-26`: the UTC date of an instant, for ids. */
export function utcDate(jd: number): string {
  // Years outside 0000-9999 are ISO expanded years (`-0584-05-28`): cut at the `T`.
  const iso = isoUtc(jd);
  return iso.slice(0, iso.indexOf('T'));
}

/** The display zone's short name at an instant (`EDT`), `UTC` or `UT` for the clock itself. */
export function zoneTag(state: ExplorerState, jd: number): string {
  return tagOf(displayZone(state), jd);
}

export { UTC_ZONE };
