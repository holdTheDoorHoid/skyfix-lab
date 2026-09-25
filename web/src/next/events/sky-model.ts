/**
 * Plain words for the meteor showers (`meteor_showers`, `tonight`), the Earth's perihelion
 * and aphelion (`earth_apsides`), and the events of the view's first tabs (Moon phases,
 * equinoxes and solstices, the planets' highlights, eclipses) as `EventItem`s, so every tab
 * saves calendar files and tables the same way. OWNER: events2 agent. Pure: tested in
 * events-models.test.ts.
 *
 * Meteor rates are estimates from a stated model (EXPLORER_API "deep sky"): every sentence
 * about a rate says "about" and the tab labels the model.
 */

import type {
  Eclipse,
  EclipseLocal,
  EarthApsisEvent,
  PhaseEvent,
  SeasonEvent,
  ShowerDates,
  ShowerNight,
} from '../engine/types.js';
import type { EventItem, Words } from './items.js';
import { utcDate } from './items.js';
import {
  eclipseSpan,
  eclipseTitle,
  eclipseTypeWords,
  hereLabel,
  PHASE_NAMES,
  planetEventTitle,
  planetEventWords,
  SEASON_NAMES,
  seasonWords,
  type PlanetRow,
  type PlanetWords,
} from './model.js';

// ---------------------------------------------------------------------------------------
// Meteor showers
// ---------------------------------------------------------------------------------------

export type MoonGlare = 'dark' | 'some' | 'bright';

/** How much the Moon gets in the way at a shower's peak (its illuminated fraction). */
export function moonGlare(fraction: number): MoonGlare {
  if (fraction < 0.25) return 'dark';
  if (fraction < 0.6) return 'some';
  return 'bright';
}

/** `Moon 12% lit: a dark sky`, `Moon 85% lit: its light hides the fainter meteors`. */
export function moonWords(fraction: number): string {
  const pct = `${Math.round(fraction * 100)}%`;
  switch (moonGlare(fraction)) {
    case 'dark':
      return `Moon ${pct} lit: little moonlight`;
    case 'some':
      return `Moon ${pct} lit: some moonlight, while it is up`;
    case 'bright':
      return `Moon ${pct} lit: its light hides the fainter meteors while it is up`;
  }
}

/** `about 40 an hour`, `about 1 an hour`, `under 1 an hour`. */
export function rateText(perHour: number): string {
  if (!Number.isFinite(perHour) || perHour < 0.5) return 'under 1 an hour';
  return `about ${Math.round(perHour)} an hour`;
}

/** What one night at the place offers, from the engine's estimate: rate, best time, radiant. */
export function nightWords(n: ShowerNight, w: Words): string {
  if (!n.best) return 'Its radiant does not rise high enough in the dark part of the night here.';
  const when = `around ${w.time(n.best.jd_utc)}`;
  return `At your place ${rateText(n.expected_rate_per_hour)} at best, ${when}, with the radiant ${w.altitude(n.best.alt_deg)} up in the ${w.direction(n.best.az_deg)}.`;
}

export function showerId(d: Pick<ShowerDates, 'shower' | 'peak'>): string {
  return `meteors-${d.shower.code}-${utcDate(d.peak.jd_utc)}`;
}

export function showerItem(d: ShowerDates, w: Words): EventItem {
  const s = d.shower;
  const parts: string[] = [];
  parts.push(
    `Active ${w.date(d.start.jd_utc)} to ${w.date(d.end.jd_utc)}; at the peak up to ${s.zhr} meteors an hour under a perfect sky with the radiant overhead (the ZHR)${s.variable ? ', and it varies a lot from year to year' : ''}.`,
  );
  parts.push(`${moonWords(d.moon_illuminated_fraction)}.`);
  if (d.at_site) parts.push(nightWords(d.at_site, w));
  if (s.parent) parts.push(`Dust from ${s.parent}.`);
  return {
    id: showerId(d),
    group: 'Meteor showers',
    kind: 'Meteor shower peak',
    title: `${s.name} peak`,
    term: `ZHR ${s.zhr}`,
    start: d.peak.jd_utc,
    end: null,
    jump: d.at_site?.best?.jd_utc ?? d.peak.jd_utc,
    body: null,
    sentence: parts.join(' '),
    local: d.at_site !== null,
    columns: [
      ['Shower', s.name],
      ['IAU code', s.code],
      ['ZHR', s.zhr],
      ['Variable', s.variable ? 'yes' : ''],
      ['Start UTC', d.start.utc],
      ['End UTC', d.end.utc],
      ['Moon illuminated (%)', Math.round(d.moon_illuminated_fraction * 100)],
      ['Expected rate at best (per hour, estimate)', d.at_site ? Number(d.at_site.expected_rate_per_hour.toFixed(1)) : ''],
      ['Best time UTC', d.at_site?.best?.utc ?? ''],
      ['Radiant RA (deg, J2000)', s.ra_deg],
      ['Radiant Dec (deg, J2000)', s.dec_deg],
      ['Speed (km/s)', s.v_inf_kms],
      ['Parent', s.parent ?? ''],
    ],
  };
}

/** Tonight's line for a shower active now: `Orionids (4 days before the peak): about 6 an hour at best, around 04:30`. */
export function tonightLine(n: ShowerNight, w: Words): string {
  const days = Math.round(n.days_from_peak);
  const when = days === 0 ? 'at the peak' : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} ${days < 0 ? 'before' : 'after'} the peak`;
  const best = n.best ? `, around ${w.time(n.best.jd_utc)}` : '';
  return `${n.name} (${when}): ${rateText(n.expected_rate_per_hour)} at best${best}`;
}

// ---------------------------------------------------------------------------------------
// The Earth's perihelion and aphelion
// ---------------------------------------------------------------------------------------

export function earthApsisItem(e: EarthApsisEvent, other: EarthApsisEvent | null = null): EventItem {
  const near = e.kind === 'perihelion';
  const million = (km: number): string => `${(km / 1e6).toFixed(2)} million km`;
  const diff = other ? Math.abs(other.distance_km - e.distance_km) / Math.max(other.distance_km, e.distance_km) : null;
  const parts = [
    near
      ? `The Earth is closest to the Sun: ${million(e.distance_km)} (${e.distance_au.toFixed(5)} AU)${diff !== null ? `, ${(diff * 100).toFixed(1)}% nearer than at aphelion` : ''}, and the Sun looks about 3% larger than in July.`
      : `The Earth is farthest from the Sun: ${million(e.distance_km)} (${e.distance_au.toFixed(5)} AU)${diff !== null ? `, ${(diff * 100).toFixed(1)}% farther than at perihelion` : ''}.`,
    'The seasons come from the tilt of the Earth’s axis, not from this distance: perihelion falls in the northern winter.',
  ];
  return {
    id: `earth-${e.kind}-${utcDate(e.jd_utc)}`,
    group: 'Seasons',
    kind: near ? 'Perihelion' : 'Aphelion',
    title: near ? 'Earth closest to the Sun' : 'Earth farthest from the Sun',
    term: e.kind,
    start: e.jd_utc,
    end: null,
    jump: e.jd_utc,
    body: 'Sun',
    sentence: parts.join(' '),
    local: false,
    columns: [
      ['Distance (km)', Math.round(e.distance_km)],
      ['Distance (AU)', Number(e.distance_au.toFixed(6))],
    ],
  };
}

// ---------------------------------------------------------------------------------------
// The first tabs' events, for files
// ---------------------------------------------------------------------------------------

export function phaseItem(p: PhaseEvent): EventItem {
  const words: Record<PhaseEvent['kind'], string> = {
    new_moon: 'The Moon is between the Earth and the Sun: it cannot be seen.',
    first_quarter: 'Half the Moon is lit, on the side toward the evening Sun: it is high at sunset.',
    full_moon: 'The Moon is opposite the Sun: fully lit, it rises at sunset and is up all night.',
    last_quarter: 'Half the Moon is lit, on the side toward the morning Sun: it is high at sunrise.',
  };
  return {
    id: `${p.kind.replace('_', '-')}-${utcDate(p.jd_utc)}`,
    group: 'Moon',
    kind: 'Moon phase',
    title: PHASE_NAMES[p.kind],
    start: p.jd_utc,
    end: null,
    jump: p.jd_utc,
    body: 'Moon',
    sentence: words[p.kind],
    local: false,
    columns: [],
  };
}

export function seasonItem(e: SeasonEvent, latDeg: number): EventItem {
  return {
    id: `${e.kind.replace('_', '-')}-${utcDate(e.jd_utc)}`,
    group: 'Seasons',
    kind: e.kind.endsWith('equinox') ? 'Equinox' : 'Solstice',
    title: SEASON_NAMES[e.kind],
    start: e.jd_utc,
    end: null,
    jump: e.jd_utc,
    body: 'Sun',
    sentence: seasonWords(e.kind, latDeg),
    local: false,
    columns: [],
  };
}

export function planetEventItem(row: PlanetRow, w: PlanetWords): EventItem {
  const e = row.event;
  return {
    id: `planet-${e.body}-${e.kind.replace(/_/g, '-')}-${utcDate(e.jd_utc)}`,
    group: 'Planets',
    kind: e.kind.replace(/_/g, ' '),
    title: planetEventTitle(e),
    start: e.jd_utc,
    end: null,
    jump: e.jd_utc,
    body: e.body,
    sentence: planetEventWords(e, w, row.approach),
    local: false,
    columns: [
      ['Planet', e.body],
      ['Elongation (deg)', Number(e.elongation_deg.toFixed(2))],
      ['Distance (AU)', Number(e.distance_au.toFixed(6))],
      ['Magnitude', e.magnitude ?? ''],
    ],
  };
}

/** An eclipse as a calendar entry: from its first to its last contact, with what the place sees. */
export function eclipseItem(e: Eclipse, local: EclipseLocal | null, w: Words): EventItem {
  const span = eclipseSpan(e);
  const here = local ? hereLabel(e, local, (jd) => w.time(jd)) : null;
  const seenFrom = local?.events.filter((ev) => ev.visible) ?? [];
  const start = seenFrom.length ? seenFrom[0]!.jd_utc : span.start;
  const end = seenFrom.length ? seenFrom[seenFrom.length - 1]!.jd_utc : span.end;
  return {
    id: `eclipse-${e.id}`,
    group: 'Eclipses',
    kind: e.kind === 'solar' ? 'Solar eclipse' : 'Lunar eclipse',
    title: eclipseTitle(e),
    start,
    end: end > start ? end : null,
    jump: e.greatest.jd_utc,
    body: e.kind === 'solar' ? 'Sun' : 'Moon',
    sentence: [here ? `${here.text}.` : '', eclipseTypeWords(e)].filter(Boolean).join(' '),
    local: local !== null,
    columns: [
      ['Greatest eclipse UTC', e.greatest.utc],
      ['Type', e.type],
      ['Saros', e.saros],
      ['Seen here', here ? (here.seen ? 'yes' : 'no') : ''],
    ],
  };
}
