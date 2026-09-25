/**
 * The Moon's events in plain words: perigee and apogee, supermoons and the year's largest
 * and smallest full Moon (`moon_apsides`), and occultations of stars and planets seen from
 * the place (`occultations`) or somewhere else on Earth (from the conjunctions: see
 * `occultedSomewhere`). OWNER: events2 agent. Pure: tested in events-models.test.ts.
 *
 * Definitions are the engine's (CONVENTIONS 13.10): a supermoon is Nolle's (a new or full
 * Moon at least 90 % of the way from apogee to perigee), contacts are at the Moon's mean
 * limb, sizes are against the mean distance of 384 400 km.
 */

import type {
  Conjunction,
  MoonApsides,
  MoonApsis,
  MoonSyzygy,
  Occultation,
  OccultationContact,
  SkyPhase,
} from '../engine/types.js';
import type { EventItem, Words } from './items.js';
import { wireYear, yearText } from './deeptime.js';
import { utcDate } from './items.js';
import { formatDuration } from './model.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

function oneDecimal(x: number): string {
  return Math.abs(x).toFixed(1);
}

/** `22 hours after perigee`, `5 hours before perigee`, `at perigee`. */
export function hoursFromPerigee(hours: number): string {
  const h = Math.round(Math.abs(hours));
  if (h < 1) return 'within an hour of perigee';
  return `${h} hour${h === 1 ? '' : 's'} ${hours < 0 ? 'before' : 'after'} perigee`;
}

/** The UTC calendar year of an instant (the engine's "of the year"; astronomical numbering). */
export function utcYear(jd: number): number {
  return wireYear(jd);
}

// ---------------------------------------------------------------------------------------
// Perigee, apogee and supermoons
// ---------------------------------------------------------------------------------------

export function apsisItem(a: MoonApsis, w: Words): EventItem {
  const closest = a.kind === 'perigee';
  const size = closest
    ? `looks ${oneDecimal(a.diameter_vs_mean_percent)}% larger than at its average distance`
    : `looks ${oneDecimal(a.diameter_vs_mean_percent)}% smaller than at its average distance`;
  return {
    id: `moon-${a.kind}-${utcDate(a.jd_utc)}`,
    group: 'Moon',
    kind: closest ? 'Perigee' : 'Apogee',
    title: closest ? 'Moon at its closest' : 'Moon at its farthest',
    term: a.kind,
    start: a.jd_utc,
    end: null,
    jump: a.jd_utc,
    body: 'Moon',
    sentence: `${w.distance(a.distance_km)} from the Earth, centre to centre: the Moon ${size} (${a.diameter_arcmin.toFixed(1)}′ across).`,
    local: false,
    columns: [
      ['Distance (km)', Math.round(a.distance_km)],
      ['Apparent diameter (arcmin)', Number(a.diameter_arcmin.toFixed(2))],
      ['Size vs mean (%)', Number(a.diameter_vs_mean_percent.toFixed(2))],
    ],
  };
}

export interface SyzygyBadges {
  supermoon: boolean;
  micromoon: boolean;
  largest: boolean;
  smallest: boolean;
}

export function syzygyBadges(s: MoonSyzygy): SyzygyBadges {
  return { supermoon: s.supermoon, micromoon: s.micromoon, largest: s.largest_of_year, smallest: s.smallest_of_year };
}

/**
 * A full Moon (always) or a new Moon (only a supermoon or micromoon, which the news calls
 * one) as an item; null for an ordinary new Moon.
 */
export function syzygyItem(s: MoonSyzygy, w: Words): EventItem | null {
  const full = s.kind === 'full_moon';
  if (!full && !s.supermoon && !s.micromoon) return null;
  const pct = s.perigee_fraction * 100;
  const size = s.diameter_vs_mean_percent;
  const bigger = size >= 0 ? `${oneDecimal(size)}% larger` : `${oneDecimal(size)}% smaller`;
  const year = utcYear(s.jd_utc);
  let sentence: string;
  if (s.supermoon) {
    sentence = `A supermoon: ${full ? 'full' : 'new'} ${hoursFromPerigee(s.hours_from_perigee)}, ${Math.round(pct)}% of the way from apogee to perigee, ${w.distance(s.distance_km)} away`;
    sentence += full ? `, so it looks ${bigger} than an average full Moon.` : '.';
  } else if (s.micromoon) {
    sentence = `A micromoon: ${full ? 'full' : 'new'} near apogee, only ${Math.round(pct)}% of the way from apogee to perigee, ${w.distance(s.distance_km)} away`;
    sentence += full ? `, so it looks ${bigger} than an average full Moon.` : '.';
  } else {
    sentence = `It looks ${bigger} than an average full Moon: ${w.distance(s.distance_km)} away, ${Math.round(pct)}% of the way from apogee to perigee.`;
  }
  if (s.largest_of_year) sentence += ` The largest full Moon of ${yearText(year)}.`;
  if (s.smallest_of_year) sentence += ` The smallest full Moon of ${yearText(year)}.`;
  if (!full) sentence += ' A new Moon cannot be seen (it is between the Earth and the Sun), but the tides around it run a little higher.';
  const kind = full ? (s.supermoon ? 'Supermoon' : s.micromoon ? 'Micromoon' : 'Full Moon') : s.supermoon ? 'New-Moon supermoon' : 'New-Moon micromoon';
  return {
    id: `${full ? 'full' : 'new'}-moon-${utcDate(s.jd_utc)}`,
    group: 'Moon',
    kind,
    title: full ? 'Full Moon' : 'New Moon',
    start: s.jd_utc,
    end: null,
    jump: s.jd_utc,
    body: 'Moon',
    sentence,
    local: false,
    columns: [
      ['Distance (km)', Math.round(s.distance_km)],
      ['Apparent diameter (arcmin)', Number(s.diameter_arcmin.toFixed(2))],
      ['Size vs mean (%)', Number(size.toFixed(2))],
      ['Perigee fraction', Number(s.perigee_fraction.toFixed(4))],
      ['Hours from perigee', Number(s.hours_from_perigee.toFixed(1))],
      ['Supermoon', s.supermoon ? 'yes' : ''],
      ['Micromoon', s.micromoon ? 'yes' : ''],
      ['Largest of the year', s.largest_of_year ? 'yes' : ''],
      ['Smallest of the year', s.smallest_of_year ? 'yes' : ''],
    ],
  };
}

/** Everything the Perigee list shows, in time order. */
export function apsidesItems(list: Pick<MoonApsides, 'apsides' | 'syzygies'>, w: Words): EventItem[] {
  const out: EventItem[] = list.apsides.map((a) => apsisItem(a, w));
  for (const s of list.syzygies) {
    const item = syzygyItem(s, w);
    if (item) out.push(item);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The list's lead: the next supermoon, and this year's largest and smallest full Moons. */
export function apsidesLead(syzygies: readonly MoonSyzygy[], anchor: number, w: Words): string {
  const parts: string[] = [];
  const next = syzygies
    .filter((s) => s.supermoon && s.kind === 'full_moon' && s.jd_utc >= anchor)
    .sort((a, b) => a.jd_utc - b.jd_utc)[0];
  if (next) parts.push(`Next supermoon: the full Moon of ${w.dateYear(next.jd_utc)}, ${oneDecimal(next.diameter_vs_mean_percent)}% larger than average.`);
  const year = utcYear(anchor);
  const largest = syzygies.find((s) => s.largest_of_year && utcYear(s.jd_utc) === year);
  const smallest = syzygies.find((s) => s.smallest_of_year && utcYear(s.jd_utc) === year);
  const y = yearText(year);
  if (largest && smallest) {
    const across = (smallest.distance_km / largest.distance_km - 1) * 100;
    parts.push(
      `The largest full Moon of ${y} is on ${w.date(largest.jd_utc)} (${w.distance(largest.distance_km)} away), the smallest on ${w.date(smallest.jd_utc)} (${w.distance(smallest.distance_km)}): the largest looks ${Math.round(across)}% bigger across.`,
    );
  } else if (largest) {
    parts.push(`The largest full Moon of ${y} is on ${w.date(largest.jd_utc)} (${w.distance(largest.distance_km)} away).`);
  } else if (smallest) {
    parts.push(`The smallest full Moon of ${y} is on ${w.date(smallest.jd_utc)} (${w.distance(smallest.distance_km)} away).`);
  }
  return parts.join(' ');
}

// ---------------------------------------------------------------------------------------
// Occultations seen from the place
// ---------------------------------------------------------------------------------------

/** Names an occultation wherever it is seen from: the body and the UTC date of closest approach. */
export function occultationId(o: Pick<Occultation, 'body' | 'closest'>): string {
  return `occultation-${o.body}-${utcDate(o.closest.jd_utc)}`;
}

/** `in daylight`, `in twilight`, `in a dark sky` (CONVENTIONS 13.4). */
export function skyWords(phase: SkyPhase): string {
  switch (phase) {
    case 'day':
      return 'in daylight';
    case 'civil':
      return 'in bright twilight';
    case 'nautical':
    case 'astronomical':
      return 'in twilight';
    case 'night':
      return 'in a dark sky';
  }
}

/**
 * The clock position of a point on the Moon's edge as the observer sees it, with 12 o'clock
 * toward the zenith: the vertex angle runs from the zenith through east, anticlockwise on
 * the sky, so 90° is 9 o'clock.
 */
export function clockPosition(vertexAngleDeg: number): number {
  const h = Math.round((((360 - vertexAngleDeg) % 360) + 360) % 360 / 30) % 12;
  return h === 0 ? 12 : h;
}

export function occultationTitle(o: Pick<Occultation, 'body' | 'occulted' | 'graze'>): { title: string; term: string } {
  if (!o.occulted) return { title: `${o.body} just misses the Moon`, term: 'near miss (appulse)' };
  if (o.graze) return { title: `${o.body} grazes the Moon’s edge`, term: 'grazing occultation' };
  return { title: `The Moon hides ${o.body}`, term: 'occultation' };
}

/** `the dark edge`, `the bright edge`. */
export function limbWords(limb: 'dark' | 'bright'): string {
  return limb === 'dark' ? 'dark edge' : 'bright edge';
}

/** Where the Moon is at a contact: `34° up in the south-east, in a dark sky`, or below the horizon. */
export function contactPlace(c: OccultationContact, w: Words): string {
  if (!c.moon_above_horizon) return 'with the Moon below the horizon';
  return `with the Moon ${w.altitude(c.moon_alt_deg)} up in the ${w.direction(c.moon_az_deg)}, ${skyWords(c.sky_phase)}`;
}

/** The instant a click on an occultation goes to: the first contact seen, else closest approach. */
export function occultationJump(o: Occultation): number {
  const seen = [o.disappearance, o.reappearance].find((c) => c && c.moon_above_horizon);
  return seen?.jd_utc ?? o.disappearance?.jd_utc ?? o.closest.jd_utc;
}

export function occultationItem(o: Occultation, w: Words): EventItem {
  const { title, term } = occultationTitle(o);
  const d = o.disappearance;
  const r = o.reappearance;
  const lit = `${Math.round(o.moon_illuminated_fraction * 100)}% lit and ${o.waxing ? 'waxing' : 'waning'}`;
  const parts: string[] = [];
  if (o.occulted && d && r) {
    parts.push(
      `${o.body} disappears at the Moon’s ${limbWords(d.limb)} at ${w.time(d.jd_utc)} and reappears at its ${limbWords(r.limb)} at ${w.time(r.jd_utc)}, ${formatDuration(o.duration_s)} later.`,
    );
    parts.push(
      d.moon_above_horizon
        ? `At the start the Moon is ${w.altitude(d.moon_alt_deg)} up in the ${w.direction(d.moon_az_deg)}, ${skyWords(d.sky_phase)}; it is ${lit}.`
        : `At the start the Moon is below the horizon here; it is ${lit}.`,
    );
  } else if (o.occulted && (d || r)) {
    const c = (d ?? r)!;
    parts.push(`${o.body} ${c.kind === 'disappearance' ? 'disappears' : 'reappears'} at the Moon’s ${limbWords(c.limb)} at ${w.time(c.jd_utc)}, ${contactPlace(c, w)}.`);
  } else {
    parts.push(
      `From here it passes ${Math.abs(o.closest.limb_distance_arcmin).toFixed(1)}′ outside the Moon’s edge at ${w.time(o.closest.jd_utc)}: close, but not hidden; a little way off it is.`,
    );
  }
  if (o.graze) parts.push('It runs along the edge, where the Moon’s mountains may hide and show it several times; the times are for the mean edge.');
  if (o.kind === 'planet' && d && d.crossing_s > 0) parts.push(`The planet’s disc takes ${formatDuration(d.crossing_s)} to disappear.`);
  const first = d ?? r;
  return {
    id: occultationId(o),
    group: 'Moon',
    kind: o.occulted ? (o.graze ? 'Grazing occultation' : 'Occultation') : 'Near miss',
    title,
    term,
    start: first?.jd_utc ?? o.closest.jd_utc,
    end: first && r && r !== first ? r.jd_utc : null,
    jump: occultationJump(o),
    body: o.body,
    sentence: parts.join(' '),
    local: true,
    columns: [
      ['Occulted body', o.body],
      ['Designation', o.designation ?? ''],
      ['Magnitude', o.magnitude ?? ''],
      ['Disappearance UTC', d ? d.utc : ''],
      ['Disappearance limb', d ? d.limb : ''],
      ['Disappearance position angle (deg)', d ? Number(d.position_angle_deg.toFixed(1)) : ''],
      ['Moon altitude at disappearance (deg)', d ? Number(d.moon_alt_deg.toFixed(1)) : ''],
      ['Reappearance UTC', r ? r.utc : ''],
      ['Reappearance limb', r ? r.limb : ''],
      ['Reappearance position angle (deg)', r ? Number(r.position_angle_deg.toFixed(1)) : ''],
      ['Moon altitude at reappearance (deg)', r ? Number(r.moon_alt_deg.toFixed(1)) : ''],
      ['Graze', o.graze ? 'yes' : ''],
      ['Closest to the mean limb (arcmin)', Number(o.closest.limb_distance_arcmin.toFixed(2))],
      ['Moon illuminated (%)', Math.round(o.moon_illuminated_fraction * 100)],
      ['Seen from here', o.visible ? 'yes' : 'no'],
    ],
  };
}

/** Of two finds of the same occultation (neighbouring search windows), the one with more contacts. */
export function betterOccultation(a: Occultation, b: Occultation): boolean {
  const n = (o: Occultation): number => (o.disappearance ? 1 : 0) + (o.reappearance ? 1 : 0);
  return n(b) > n(a);
}

// ---------------------------------------------------------------------------------------
// Occultations somewhere else on Earth
// ---------------------------------------------------------------------------------------

/**
 * True when an occultation is seen from somewhere on the Earth: the Moon's shadow cast by
 * the body (for a star, a cylinder of the Moon's radius) meets the Earth when the Moon's
 * centre passes within `R☾ + R⊕` of the line from the Earth's centre to the body. At the
 * Moon's distance that is `sin(sep) < sin(HP) + sin(SD☾)`, with the geocentric least
 * separation `sep`, horizontal parallax `HP` and semidiameter `SD☾`; a planet's own
 * semidiameter is added (a partial cover counts). The Earth is taken as a sphere of its
 * equatorial radius, which the parallax is defined on: at the poles this overstates the
 * reach by 0.3% of HP (11″).
 */
export function occultedSomewhere(sepDeg: number, hpDeg: number, sdMoonDeg: number, sdBodyDeg = 0): boolean {
  if (![sepDeg, hpDeg, sdMoonDeg, sdBodyDeg].every(Number.isFinite)) return false;
  const reach = Math.asin(Math.min(1, Math.sin(hpDeg * D2R) + Math.sin(sdMoonDeg * D2R))) * R2D + sdBodyDeg;
  return sepDeg < reach;
}

/**
 * Which part of the half of the Earth facing the Moon sees it (a rule of thumb): parallax
 * lowers the Moon toward each observer's horizon, so when the Moon passes north of the body
 * as seen from the Earth's centre it covers the body for observers in the north of that
 * half, and the other way round; when it passes over it, near the middle.
 */
export function whereSeen(sepDeg: number, positionAngleDeg: number, sdMoonDeg: number): 'middle' | 'north' | 'south' {
  if (sepDeg <= sdMoonDeg) return 'middle';
  return Math.cos(positionAngleDeg * D2R) >= 0 ? 'north' : 'south';
}

export interface ElsewhereOccultation {
  conjunction: Conjunction;
  where: 'middle' | 'north' | 'south';
}

/** The body a Moon conjunction is with, or null for a conjunction without the Moon. */
export function moonPartner(c: Conjunction): string | null {
  if (c.kind !== 'moon_planet' && c.kind !== 'moon_star') return null;
  return c.body === 'Moon' ? c.other : c.body;
}

/** An occultation seen elsewhere on Earth but not from here, as an item. */
export function elsewhereItem(e: ElsewhereOccultation, w: Words, utcTime: (jd: number) => string): EventItem {
  const c = e.conjunction;
  const body = moonPartner(c) ?? c.other;
  const part =
    e.where === 'middle'
      ? 'across the middle of the half of the Earth facing the Moon'
      : `from the ${e.where}ern part of the half of the Earth facing the Moon`;
  return {
    id: `occultation-${body}-${utcDate(c.jd_utc)}`,
    group: 'Moon',
    kind: 'Occultation elsewhere',
    title: `The Moon hides ${body}, elsewhere`,
    term: 'occultation (not seen from here)',
    start: c.jd_utc,
    end: null,
    jump: c.jd_utc,
    body,
    sentence: `Not seen from here. Seen from the Earth’s centre the Moon passes ${w.angle(c.separation_deg)} ${Math.cos(c.position_angle_deg * D2R) >= 0 ? 'north' : 'south'} of ${body} around ${utcTime(c.jd_utc)} UTC, so ${body} is hidden for observers ${part} (roughly: the exact track needs their places).`,
    local: false,
    columns: [
      ['Occulted body', body],
      ['Geocentric separation (deg)', Number(c.separation_deg.toFixed(3))],
      ['Moon position angle from the body (deg)', Number(c.position_angle_deg.toFixed(1))],
      ['Seen from', e.where === 'middle' ? 'middle of the Moon-facing hemisphere' : `${e.where}ern part of the Moon-facing hemisphere`],
      ['Seen from here', 'no'],
    ],
  };
}
