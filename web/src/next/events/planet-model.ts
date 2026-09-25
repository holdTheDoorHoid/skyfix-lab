/**
 * The planets' events in plain words: close approaches of planets, the Moon and bright
 * stars (`conjunctions`), stations and retrograde loops (`stations`), transits of Mercury
 * and Venus with what the place sees (`transits`), and the eclipses, transits, shadow
 * transits and occultations of Jupiter's four big moons (`galilean_events`), night by
 * night. OWNER: events2 agent. Pure: tested in events-models.test.ts.
 *
 * Definitions are the engine's (CONVENTIONS 13.13): a conjunction is a closest approach
 * in apparent separation; a station is where the ecliptic longitude of date stops
 * changing; transit contacts are the discs' tangencies; a Galilean phenomenon starts and
 * ends when the moon's centre crosses Jupiter's limb or the edge of a shadow.
 */

import type {
  Conjunction,
  GalileanPhenomenon,
  PlanetStation,
  PlanetTransit,
  PlanetTransitLocalEvent,
} from '../engine/types.js';
import type { EventItem, Words } from './items.js';
import { utcDate } from './items.js';
import { formatDuration } from './model.js';

const D2R = Math.PI / 180;

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------------------
// Conjunctions
// ---------------------------------------------------------------------------------------

export function conjunctionId(c: Pick<Conjunction, 'body' | 'other' | 'jd_utc'>): string {
  return `conjunction-${c.body}-${c.other}-${utcDate(c.jd_utc)}`;
}

/** The direction on the sky a position angle points: `north`, `south-east`… */
export function skyDirection(positionAngleDeg: number): string {
  const names = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const i = Math.round((((positionAngleDeg % 360) + 360) % 360) / 45) % 8;
  return names[i]!;
}

/** How close, in terms people picture: the full Moon is half a degree across. */
export function separationWords(sepDeg: number): string {
  if (sepDeg < 0.5) return 'closer than the width of the full Moon';
  if (sepDeg < 1.5) return `about ${Math.max(1, Math.round(sepDeg / 0.5))} full-Moon widths apart`;
  return 'close enough to share a view in binoculars';
}

function conjunctionName(c: Conjunction): string {
  return c.body === 'Moon' ? 'the Moon' : c.body;
}

export function conjunctionTitle(c: Conjunction, w: Words): string {
  return `${capital(conjunctionName(c))} and ${c.other}, ${w.angle(c.separation_deg)} apart`;
}

/** Where to look at the best moment (the tab measures it with `sky_state`). */
export interface ViewDirection {
  azDeg: number;
}

/** When a click on a conjunction goes: the best view from the place, else the closest approach. */
export function conjunctionJump(c: Conjunction): number {
  return c.local?.best?.jd_utc ?? c.jd_utc;
}

/** Seen from the place in a dark sky (the engine's best view exists), or, with no place, far enough from the Sun. */
export function conjunctionSeen(c: Conjunction): boolean {
  return c.local ? c.visible && c.local.best !== null : c.visible;
}

export function conjunctionItem(c: Conjunction, w: Words, best: ViewDirection | null = null): EventItem {
  const name = conjunctionName(c);
  const parts = [
    `${capital(name)} passes ${w.angle(c.separation_deg)} ${skyDirection(c.position_angle_deg)} of ${c.other}, ${separationWords(c.separation_deg)}.`,
  ];
  const sunGap = Math.min(c.body_elongation_deg, c.other_elongation_deg);
  if (!c.visible) {
    parts.push(`Too close to the Sun to see: ${w.angle(sunGap)} from it.`);
  } else if (c.local) {
    const b = c.local.best;
    if (b) {
      const low = Math.min(b.body_alt_deg, b.other_alt_deg);
      const where = best ? ` in the ${w.direction(best.azDeg)}` : '';
      const day = w.date(b.jd_utc) !== w.date(c.jd_utc) ? ` (${w.date(b.jd_utc)})` : '';
      parts.push(`Best seen from here at ${w.time(b.jd_utc)}${day}, ${low >= 10 ? `both at least ${w.altitude(low)} up` : `low, ${w.altitude(low)} up`}${where}, the sky dark enough.`);
    } else {
      parts.push('Not seen from here: they are never both up in a dark enough sky within 12 hours of it.');
    }
  }
  const mags = [c.body_magnitude, c.other_magnitude].filter((m): m is number => m !== null);
  if (c.kind === 'planet_planet' && mags.length === 2) {
    parts.push(`Magnitudes ${w.magnitude(c.body_magnitude)} and ${w.magnitude(c.other_magnitude)}.`);
  }
  const kindWord: Record<Conjunction['kind'], string> = {
    planet_planet: 'Planet pair',
    moon_planet: 'Moon and planet',
    moon_star: 'Moon and star',
    planet_star: 'Planet and star',
  };
  return {
    id: conjunctionId(c),
    group: 'Planets',
    kind: kindWord[c.kind],
    title: conjunctionTitle(c, w),
    term: 'conjunction',
    start: c.jd_utc,
    end: null,
    jump: conjunctionJump(c),
    body: c.body,
    sentence: parts.join(' '),
    local: c.local !== null,
    columns: [
      ['Bodies', `${c.body}, ${c.other}`],
      ['Separation (deg)', Number(c.separation_deg.toFixed(3))],
      ['Position angle (deg)', Number(c.position_angle_deg.toFixed(1))],
      ['Elongation from the Sun (deg)', Number(sunGap.toFixed(1))],
      ['Far enough from the Sun', c.visible ? 'yes' : 'no'],
      ['Best view UTC', c.local?.best ? c.local.best.utc : ''],
    ],
  };
}

// ---------------------------------------------------------------------------------------
// Stations and retrograde loops
// ---------------------------------------------------------------------------------------

export interface RetrogradePeriod {
  body: string;
  /** Null when the loop began before the stations searched. */
  begins: PlanetStation | null;
  /** Null when it ends after them. */
  ends: PlanetStation | null;
}

export const PLANET_ORDER = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;

/** Pair each planet's stations (in the coordinate the explorer shows) into retrograde loops. */
export function retrogradePeriods(stations: readonly PlanetStation[], coordinate: PlanetStation['coordinate']): RetrogradePeriod[] {
  const out: RetrogradePeriod[] = [];
  for (const body of PLANET_ORDER) {
    const mine = stations.filter((s) => s.body === body && s.coordinate === coordinate).sort((a, b) => a.jd_utc - b.jd_utc);
    let open: PlanetStation | null = null;
    let first = true;
    for (const s of mine) {
      if (s.kind === 'retrograde_begins') {
        if (open) out.push({ body, begins: open, ends: null });
        open = s;
      } else {
        out.push({ body, begins: open, ends: s });
        if (!open && !first) {
          // an end without its beginning in the middle of the list: keep it, its start unknown
        }
        open = null;
      }
      first = false;
    }
    if (open) out.push({ body, begins: open, ends: null });
  }
  return out.sort((a, b) => (a.begins?.jd_utc ?? a.ends!.jd_utc) - (b.begins?.jd_utc ?? b.ends!.jd_utc));
}

/** The loops under way at an instant. */
export function retrogradeAt(periods: readonly RetrogradePeriod[], jd: number): RetrogradePeriod[] {
  return periods.filter((p) => (p.begins ? p.begins.jd_utc <= jd : true) && (p.ends ? p.ends.jd_utc > jd : true) && (p.begins || p.ends));
}

/** Why the planet seems to go backwards, in one sentence. */
export function retrogradeWhy(body: string): string {
  return body === 'Mercury' || body === 'Venus'
    ? `${body} is passing between the Earth and the Sun, overtaking us on its faster inside track.`
    : `The Earth, on its faster inside track, is overtaking ${body}, which seems to slip backwards against the stars.`;
}

export function stationId(s: Pick<PlanetStation, 'body' | 'kind' | 'jd_utc'>): string {
  return `station-${s.body}-${s.kind === 'retrograde_begins' ? 'retrograde' : 'direct'}-${utcDate(s.jd_utc)}`;
}

export function stationItem(s: PlanetStation, period: RetrogradePeriod | null, w: Words): EventItem {
  const begins = s.kind === 'retrograde_begins';
  const other = begins ? period?.ends : period?.begins;
  const days = other ? Math.round(Math.abs(other.jd_utc - s.jd_utc)) : null;
  const parts: string[] = [];
  if (begins) {
    parts.push(`${s.body} seems to stop against the stars and turn back westward: its retrograde loop begins${other ? `, lasting ${days} days until ${w.dateYear(other.jd_utc)}` : ''}.`);
    parts.push(retrogradeWhy(s.body));
  } else {
    parts.push(`${s.body} stops again and resumes its usual eastward drift: the retrograde loop${other ? ` that began on ${w.dateYear(other.jd_utc)} (${days} days)` : ''} is over.`);
  }
  parts.push(`At the station it is ${w.angle(s.elongation_deg)} from the Sun${s.magnitude !== null ? `, magnitude ${w.magnitude(s.magnitude)}` : ''}.`);
  return {
    id: stationId(s),
    group: 'Planets',
    kind: begins ? 'Retrograde begins' : 'Retrograde ends',
    title: `${s.body} ${begins ? 'turns retrograde' : 'resumes direct motion'}`,
    term: 'station',
    start: s.jd_utc,
    end: null,
    jump: s.jd_utc,
    body: s.body,
    sentence: parts.join(' '),
    local: false,
    columns: [
      ['Planet', s.body],
      ['Ecliptic longitude (deg)', Number(s.ecliptic_longitude_deg.toFixed(3))],
      ['Right ascension (deg)', Number(s.ra_deg.toFixed(3))],
      ['Declination (deg)', Number(s.dec_deg.toFixed(3))],
      ['Elongation from the Sun (deg)', Number(s.elongation_deg.toFixed(1))],
      ['Magnitude', s.magnitude ?? ''],
      ['Loop length (days)', days ?? ''],
    ],
  };
}

// ---------------------------------------------------------------------------------------
// Transits of Mercury and Venus
// ---------------------------------------------------------------------------------------

export type TransitLocalKind = PlanetTransitLocalEvent['kind'];

export function transitEventName(kind: TransitLocalKind, planet: string): { name: string; term: string } {
  switch (kind) {
    case 'c1':
      return { name: `${planet} touches the Sun’s edge`, term: 'contact I' };
    case 'c2':
      return { name: `${planet} is wholly on the Sun’s face`, term: 'contact II' };
    case 'greatest':
      return { name: 'Nearest the Sun’s centre', term: 'greatest transit' };
    case 'c3':
      return { name: `${planet} touches the Sun’s edge again`, term: 'contact III' };
    case 'c4':
      return { name: `${planet} leaves the Sun’s face`, term: 'contact IV' };
    case 'sunrise':
      return { name: 'Sunrise', term: '' };
    case 'sunset':
      return { name: 'Sunset', term: '' };
  }
}

export interface TransitHere {
  seen: boolean;
  text: string;
  tone: 'central' | 'partial' | 'none';
}

function localEvent(t: PlanetTransit, kind: TransitLocalKind): PlanetTransitLocalEvent | null {
  return t.local?.events.find((e) => e.kind === kind) ?? null;
}

/** One line for the list: what the place sees of the transit. */
export function transitHere(t: PlanetTransit, w: Words): TransitHere {
  const l = t.local;
  if (!l) return { seen: false, text: 'Seen from the Earth’s centre', tone: 'none' };
  if (l.visibility === 'none') return { seen: false, text: `Not seen here: from here ${t.planet} misses the Sun’s disc`, tone: 'none' };
  if (l.visibility === 'below_horizon') return { seen: false, text: 'Not seen here: the Sun is down throughout', tone: 'none' };
  const c1 = localEvent(t, 'c1');
  const c4 = localEvent(t, 'c4');
  if (l.visibility === 'visible' && c1 && c4) return { seen: true, text: `Seen here from start to end, ${w.time(c1.jd_utc)}–${w.time(c4.jd_utc)}`, tone: 'central' };
  const rise = localEvent(t, 'sunrise');
  const set = localEvent(t, 'sunset');
  const part = rise && set ? 'between sunrise and sunset' : rise ? `from sunrise, ${w.time(rise.jd_utc)}` : set ? `until sunset, ${w.time(set.jd_utc)}` : '';
  return { seen: true, text: `Partly seen here${part ? `, ${part}` : ''}`, tone: 'partial' };
}

/** A few plain sentences on what the place sees. */
export function transitSummary(t: PlanetTransit, w: Words): string[] {
  const out: string[] = [];
  const l = t.local;
  const c1 = localEvent(t, 'c1');
  const c4 = localEvent(t, 'c4');
  const g = localEvent(t, 'greatest');
  const size = t.planet === 'Mercury' ? 'a tiny black dot, too small to see without a telescope' : 'a black disc about a thirtieth of the Sun’s width, just visible through a safe solar filter';
  out.push(`${t.planet} passes in front of the Sun: ${size}.`);
  if (!l) return out;
  if (l.visibility === 'none') {
    out.push(`Seen from here ${t.planet} just misses the Sun’s disc; observers elsewhere on Earth see a grazing transit.`);
    return out;
  }
  if (l.visibility === 'below_horizon') {
    out.push(`The Sun is below the horizon here for the whole transit${c1 && c4 ? ` (${w.time(c1.jd_utc)} to ${w.time(c4.jd_utc)})` : ''}.`);
    return out;
  }
  if (c1 && c4) out.push(`From here it crosses from ${w.time(c1.jd_utc)} to ${w.time(c4.jd_utc)} (${formatDuration((c4.jd_utc - c1.jd_utc) * 86_400)}).`);
  const rise = localEvent(t, 'sunrise');
  const set = localEvent(t, 'sunset');
  if (rise) out.push(`The Sun rises with the transit under way, at ${w.time(rise.jd_utc)}.`);
  if (set) out.push(`The Sun sets before it is over, at ${w.time(set.jd_utc)}.`);
  if (g) out.push(g.visible ? `At its middle, ${w.time(g.jd_utc)}, the Sun is ${w.altitude(g.sun_alt_deg)} up in the ${w.direction(g.sun_az_deg)}.` : `Its middle, at ${w.time(g.jd_utc)}, comes with the Sun below the horizon.`);
  return out;
}

/** The list's sentence: what the place sees, without repeating itself. */
export function transitSentence(t: PlanetTransit, w: Words): string {
  const l = t.local;
  const c1 = localEvent(t, 'c1');
  const c4 = localEvent(t, 'c4');
  const g = localEvent(t, 'greatest');
  const span = c1 && c4 ? `${w.time(c1.jd_utc)} to ${w.time(c4.jd_utc)}` : '';
  if (!l) {
    const gc = t.contacts.find((c) => c.kind === 'greatest');
    return `Seen from the Earth’s centre it lasts ${formatDuration(t.duration_s)}${gc ? `, greatest at ${w.time(gc.jd_utc)}` : ''}.`;
  }
  if (l.visibility === 'none') return `Not seen here: from here ${t.planet} just misses the Sun’s disc.`;
  if (l.visibility === 'below_horizon') return `Not seen here: the Sun is down for the whole transit${span ? ` (${span})` : ''}.`;
  const parts: string[] = [];
  if (l.visibility === 'visible') parts.push(`Seen here from start to end: ${t.planet} crosses from ${span} (${formatDuration((c4!.jd_utc - c1!.jd_utc) * 86_400)}).`);
  else {
    const rise = localEvent(t, 'sunrise');
    const set = localEvent(t, 'sunset');
    parts.push(
      `Partly seen here: it crosses from ${span}${rise ? `, and the Sun rises at ${w.time(rise.jd_utc)} with it under way` : ''}${set ? `, and the Sun sets at ${w.time(set.jd_utc)} before it is over` : ''}.`,
    );
  }
  if (g && g.visible) parts.push(`At its middle, ${w.time(g.jd_utc)}, the Sun is ${w.altitude(g.sun_alt_deg)} up in the ${w.direction(g.sun_az_deg)}.`);
  return parts.join(' ');
}

export function transitItem(t: PlanetTransit, w: Words): EventItem {
  const local = t.local;
  const events = local?.events ?? [];
  const c1 = (local ? events.find((e) => e.kind === 'c1') : null) ?? t.contacts.find((c) => c.kind === 'c1') ?? null;
  const c4 = (local ? events.find((e) => e.kind === 'c4') : null) ?? t.contacts.find((c) => c.kind === 'c4') ?? null;
  const greatest = t.contacts.find((c) => c.kind === 'greatest');
  const seen = local ? events.find((e) => e.visible && e.kind !== 'sunrise' && e.kind !== 'sunset') : null;
  return {
    id: `transit-${t.id}`,
    group: 'Planets',
    kind: `Transit of ${t.planet}`,
    title: `Transit of ${t.planet}`,
    term: t.grazing ? 'grazing transit' : 'transit',
    start: c1?.jd_utc ?? greatest?.jd_utc ?? t.path[0]?.jd_utc ?? 0,
    end: c4?.jd_utc ?? null,
    jump: seen?.jd_utc ?? greatest?.jd_utc ?? c1?.jd_utc ?? 0,
    body: t.planet,
    sentence: transitSentence(t, w),
    local: local !== null,
    columns: [
      ['Planet', t.planet],
      ['Greatest transit UTC (geocentric)', greatest?.utc ?? ''],
      ['Least separation (arcsec)', Number(t.min_separation_arcsec.toFixed(1))],
      ['Duration (geocentric, min)', Number((t.duration_s / 60).toFixed(1))],
      ['Grazing', t.grazing ? 'yes' : ''],
      ['Seen here', local ? local.visibility : ''],
    ],
  };
}

/** The planet's place on the Sun's disc at an instant, interpolated along the path (arcsec), or null outside it. */
export function transitPosition(path: readonly { jd_utc: number; east_arcsec: number; north_arcsec: number }[], jd: number): { east: number; north: number } | null {
  if (path.length < 2 || jd < path[0]!.jd_utc || jd > path[path.length - 1]!.jd_utc) return null;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1]!;
    const b = path[i]!;
    if (jd <= b.jd_utc) {
      const f = b.jd_utc > a.jd_utc ? (jd - a.jd_utc) / (b.jd_utc - a.jd_utc) : 0;
      return { east: a.east_arcsec + f * (b.east_arcsec - a.east_arcsec), north: a.north_arcsec + f * (b.north_arcsec - a.north_arcsec) };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Jupiter's moons
// ---------------------------------------------------------------------------------------

/**
 * Names a phenomenon: the moon, the kind and the UTC date it starts (Io, the quickest,
 * repeats every 42.5 hours, so a moon's phenomenon of one kind starts at most once a day).
 */
export function galileanId(p: Pick<GalileanPhenomenon, 'moon' | 'kind' | 'start'>): string {
  return `jupiter-${p.moon}-${p.kind.replace('_', '-')}-${utcDate(p.start.jd_utc)}`;
}

export function galileanTitle(p: Pick<GalileanPhenomenon, 'moon' | 'kind'>): { title: string; term: string } {
  switch (p.kind) {
    case 'transit':
      return { title: `${p.moon} crosses Jupiter’s face`, term: 'transit' };
    case 'shadow_transit':
      return { title: `${p.moon}’s shadow crosses Jupiter`, term: 'shadow transit' };
    case 'occultation':
      return { title: `${p.moon} hidden behind Jupiter`, term: 'occultation' };
    case 'eclipse':
      return { title: `${p.moon} in Jupiter’s shadow`, term: 'eclipse' };
  }
}

/** How Jupiter and the sky are at a moment, from the place. */
export interface JupiterSky {
  /** Jupiter's apparent altitude (degrees). */
  jupiterAlt: number;
  jupiterAz: number;
  /** The Sun's altitude (degrees). */
  sunAlt: number;
}

/** Jupiter at least this high, the Sun at least this low, for a moon event to count as seen. */
export const JUPITER_MIN_ALT = 5;
export const SUN_MAX_ALT = -6;
/** Nothing is seen of Jupiter's moons this close to the Sun (EXPLORER_API galilean_events). */
export const JUPITER_MIN_ELONGATION = 15;

export function skySeen(s: JupiterSky | null): boolean {
  return !!s && s.jupiterAlt >= JUPITER_MIN_ALT && s.sunAlt <= SUN_MAX_ALT;
}

/** Why a moment is not seen: Jupiter down, daylight, or too near the Sun; '' when seen. */
export function skyReason(s: JupiterSky | null, elongationDeg: number): string {
  if (elongationDeg < JUPITER_MIN_ELONGATION) return 'Jupiter is too near the Sun';
  if (!s) return '';
  if (s.jupiterAlt < JUPITER_MIN_ALT) return s.jupiterAlt < 0 ? 'Jupiter is below the horizon' : 'Jupiter is too low';
  if (s.sunAlt > SUN_MAX_ALT) return s.sunAlt > -0.83 ? 'it is daylight' : 'the sky is too bright';
  return '';
}

export function galileanItem(
  p: GalileanPhenomenon,
  w: Words,
  sky: { start: JupiterSky | null; end: JupiterSky | null } | null,
): EventItem {
  const { title, term } = galileanTitle(p);
  const parts: string[] = [];
  const startWord: Record<GalileanPhenomenon['kind'], [string, string]> = {
    transit: ['enters the disc', 'leaves it'],
    shadow_transit: ['falls on the disc', 'leaves it'],
    occultation: ['disappears behind Jupiter', 'reappears'],
    eclipse: ['fades into the shadow', 'reappears from it'],
  };
  const [a, b] = startWord[p.kind];
  const say = (edge: 'start' | 'end'): string => {
    const i = p[edge];
    const verb = edge === 'start' ? a : b;
    const hidden = i.observable ? '' : p.kind === 'eclipse' ? ' (unseen: behind Jupiter then)' : p.kind === 'occultation' ? ' (unseen: in Jupiter’s shadow then)' : ' (unseen)';
    const s = sky?.[edge] ?? null;
    const reason = i.observable ? skyReason(s, p.jupiter_elongation_deg) : '';
    return `${verb} at ${w.time(i.jd_utc)}${hidden}${reason ? ` (${reason})` : ''}`;
  };
  const subject = p.kind === 'shadow_transit' ? `${p.moon}’s shadow` : p.moon;
  parts.push(`${subject} ${say('start')} and ${say('end')}.`);
  if (p.kind === 'shadow_transit') parts.push('A small black dot on Jupiter’s clouds, for a telescope.');
  if (p.jupiter_elongation_deg < JUPITER_MIN_ELONGATION) parts.push(`Jupiter is only ${w.angle(p.jupiter_elongation_deg)} from the Sun: nothing can be seen.`);
  return {
    id: galileanId(p),
    group: 'Jupiter’s moons',
    kind: capital(term),
    title,
    term,
    start: p.start.jd_utc,
    end: p.end.jd_utc,
    jump: p.start.observable ? p.start.jd_utc : p.end.jd_utc,
    body: 'Jupiter',
    sentence: parts.join(' '),
    local: sky !== null,
    columns: [
      ['Moon', p.moon],
      ['Start observable', p.start.observable ? 'yes' : 'no'],
      ['End observable', p.end.observable ? 'yes' : 'no'],
      ['Jupiter from the Sun (deg)', Number(p.jupiter_elongation_deg.toFixed(1))],
      ['Jupiter altitude at start (deg)', sky?.start ? Number(sky.start.jupiterAlt.toFixed(1)) : ''],
      ['Sun altitude at start (deg)', sky?.start ? Number(sky.start.sunAlt.toFixed(1)) : ''],
    ],
  };
}

/** Either edge of a phenomenon can be seen from the place (observable, Jupiter up, the sky dark). */
export function galileanSeen(p: GalileanPhenomenon, sky: { start: JupiterSky | null; end: JupiterSky | null }): boolean {
  if (p.jupiter_elongation_deg < JUPITER_MIN_ELONGATION) return false;
  return (p.start.observable && skySeen(sky.start)) || (p.end.observable && skySeen(sky.end));
}

/** The position angle of the Sun's north point is not needed: paths are drawn north up (`transits.path`). */
export const TRANSIT_DRAWING_NOTE = 'Drawn as the Sun appears with north up and east to the left.';

export { D2R };
