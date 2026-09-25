/**
 * "Coming up": the notable events of the next fourteen days from the night's start, from
 * the events engines — Moon phases, perigee and apogee (supermoons), eclipses, conjunctions,
 * lunar occultations, meteor-shower peaks, the planets' oppositions, elongations and
 * stations, equinoxes and solstices, the Earth's perihelion and aphelion, and transits of
 * Mercury and Venus. OWNER: tonight agent (expansion programme Q2).
 *
 * Each source is one engine call (plus, for eclipses and transits, the local circumstances),
 * run in its own task by the view so the page keeps answering; a source the engine does not
 * have is named in `missing`, one that fails in `errors`. Items say what is seen from here:
 * a conjunction or an occultation is listed only when the place sees it in the dark.
 */

import type { Ctx } from '../component.js';
import {
  isEclipseEngine,
  isMoonDetailEngine,
  isPlanetDetailEngine,
  isPlanetEventsEngine,
  isDeepSkyEngine,
  type Conjunction,
  type EclipseVisibility,
  type MoonApsides,
  type Occultation,
  type PlanetEvent,
  type PlanetStation,
} from '../engine/types.js';
import { formatMagnitude } from '../shell/format.js';
import { wallClock } from '../time.js';
import type { NightQuery } from './data.js';
import { cap, clock, degrees, distanceText, percentLit, type Fmt } from './format.js';

/** How far ahead the list looks, days (the brief: the next 14 days). */
export const COMING_DAYS = 14;

export type ComingKind =
  | 'phase'
  | 'apsis'
  | 'eclipse'
  | 'conjunction'
  | 'occultation'
  | 'shower'
  | 'planet'
  | 'station'
  | 'season'
  | 'earth'
  | 'transit';

export interface ComingItem {
  kind: ComingKind;
  /** The instant: set on the explorer when the item is chosen. */
  jd: number;
  title: string;
  detail: string;
  /** The body to select when Events opens (the Moon for its phases, the planet…). */
  body: string | null;
  /** False when it happens but cannot be seen from here (shown dimmed). */
  seen: boolean;
}

/** What one source gives: its items, and (the apsides source) notes for the phases' titles. */
export interface ComingResult {
  items: ComingItem[];
  notes?: SyzygyNote[];
}

export interface ComingSource {
  id: string;
  /** For the note that names what this build cannot give: `occultations`. */
  label: string;
  /** Present in this engine. */
  available(ctx: Pick<Ctx, 'engine'>): boolean;
  run(ctx: Pick<Ctx, 'engine'>, q: NightQuery, f: Fmt): ComingResult;
}

function span(q: NightQuery): [number, number] {
  return [q.n, q.n + COMING_DAYS];
}

function inside(jd: number, q: NightQuery): boolean {
  return jd >= q.n && jd < q.n + COMING_DAYS;
}

/** The UTC calendar years the window touches (a shower table and the seasons are per year). */
export function yearsOf(q: NightQuery): number[] {
  const a = wallClock(q.n, { kind: 'fixed', offsetMs: 0, name: 'UTC' }).year;
  const b = wallClock(q.n + COMING_DAYS, { kind: 'fixed', offsetMs: 0, name: 'UTC' }).year;
  return a === b ? [a] : [a, b];
}

const PHASE_TITLES: Record<string, string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter Moon',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter Moon',
};

const phases: ComingSource = {
  id: 'phases',
  label: 'Moon phases',
  available: () => true,
  run(ctx, q) {
    const [a, b] = span(q);
    return {
      items: ctx.engine.moonPhases(a, b).map((p) => ({
        kind: 'phase',
        jd: p.jd_utc,
        title: PHASE_TITLES[p.kind] ?? p.kind,
        detail: p.kind === 'full_moon' ? 'Up all night; a bright sky for faint objects.' : p.kind === 'new_moon' ? 'The darkest nights of the month.' : '',
        body: 'Moon',
        seen: true,
      })),
    };
  },
};

/** Perigee and apogee; supermoons and micromoons are added to the phases' titles (`mergeComing`). */
function apsisItems(a: MoonApsides, q: NightQuery, f: Fmt): ComingItem[] {
  return a.apsides
    .filter((x) => inside(x.jd_utc, q))
    .map((x) => {
      const pct = x.diameter_vs_mean_percent;
      return {
        kind: 'apsis' as const,
        jd: x.jd_utc,
        title: x.kind === 'perigee' ? 'The Moon at its closest (perigee)' : 'The Moon at its farthest (apogee)',
        detail: `${distanceText(x.distance_km, f.units)} away; it looks ${Math.abs(pct).toFixed(0)}% ${pct >= 0 ? 'larger' : 'smaller'} than average.`,
        body: 'Moon',
        seen: true,
      };
    });
}

/** Supermoon notes keyed by the syzygy's instant, for `mergeComing`. */
export interface SyzygyNote {
  jd: number;
  note: string;
}

function syzygyNotes(a: MoonApsides): SyzygyNote[] {
  return a.syzygies
    .filter((z) => z.supermoon || z.micromoon)
    .map((z) => ({
      jd: z.jd_utc,
      note: `${z.supermoon ? 'a supermoon' : 'a micromoon'}${z.largest_of_year ? ', the largest full Moon of the year' : z.smallest_of_year ? ', the smallest full Moon of the year' : ''}`,
    }));
}

const apsides: ComingSource = {
  id: 'apsides',
  label: 'perigee and apogee',
  available: (ctx) => isMoonDetailEngine(ctx.engine),
  run(ctx, q, f) {
    if (!isMoonDetailEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    const result = ctx.engine.moonApsides(a, b);
    return { items: apsisItems(result, q, f), notes: syzygyNotes(result) };
  },
};

const SEEN_WORDS: Record<EclipseVisibility, [string, boolean]> = {
  visible: ['seen from here from start to end', true],
  partly_below_horizon: ['partly seen from here', true],
  below_horizon: ['below the horizon here', false],
  none: ['not seen from here', false],
};

const eclipses: ComingSource = {
  id: 'eclipses',
  label: 'eclipses',
  available: (ctx) => isEclipseEngine(ctx.engine),
  run(ctx, q, f) {
    const engine = ctx.engine;
    if (!isEclipseEngine(engine)) return { items: [] };
    const [a, b] = span(q);
    const items = engine.eclipses(a, b).eclipses.map((e) => {
      let seen = false;
      let words = 'not worked out for this place';
      try {
        const local = engine.eclipseLocal(e.id, q.observer);
        [words, seen] = SEEN_WORDS[local.visibility];
        if (local.kind === 'solar' && local.visible_max && seen) {
          words += `, ${percentLit(local.visible_max.obscuration ?? local.obscuration)} of the Sun covered at ${clock(local.visible_max.jd_utc, f)}`;
        }
      } catch {
        // The global circumstances still stand.
      }
      const what = e.kind === 'solar' ? 'the Sun' : 'the Moon';
      const type = e.type === 'penumbral' ? 'Penumbral' : cap(e.type);
      return {
        kind: 'eclipse' as const,
        jd: e.greatest.jd_utc,
        title: `${type} eclipse of ${what}`,
        detail: `${cap(words)}.${e.kind === 'solar' ? ' Never look at the Sun without proper eye protection.' : ''}`,
        body: e.kind === 'solar' ? 'Sun' : 'Moon',
        seen,
      };
    });
    return { items };
  },
};

function pointWords(pa: number): string {
  const a = ((pa % 360) + 360) % 360;
  return a < 45 || a >= 315 ? 'north' : a < 135 ? 'east' : a < 225 ? 'south' : 'west';
}

/** `The Moon 2.1° north of Jupiter`. */
export function conjunctionTitle(c: Conjunction): string {
  const sep = c.separation_deg < 1 ? `${c.separation_deg.toFixed(1)}°` : `${c.separation_deg.toFixed(1)}°`;
  const body = c.body === 'Moon' ? 'The Moon' : c.body;
  return `${body} ${sep} ${pointWords(c.position_angle_deg)} of ${c.other}`;
}

const conjunctions: ComingSource = {
  id: 'conjunctions',
  label: 'conjunctions',
  available: (ctx) => isPlanetDetailEngine(ctx.engine),
  run(ctx, q, f) {
    if (!isPlanetDetailEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    const items = ctx.engine
      .conjunctions(a, b, { observer: q.observer })
      .conjunctions.filter((c) => c.visible && c.local?.best)
      .map((c) => {
        const best = c.local!.best!;
        const low = Math.min(best.body_alt_deg, best.other_alt_deg);
        return {
          kind: 'conjunction' as const,
          jd: best.jd_utc,
          title: conjunctionTitle(c),
          detail: `Best seen at ${clock(best.jd_utc, f)}, ${degrees(low)} up or more; closest at ${clock(c.jd_utc, f)}.`,
          body: c.body,
          seen: true,
        };
      });
    return { items };
  },
};

/** An occultation in words (mean limb: the result says so). */
export function occultationItem(o: Occultation, f: Fmt): ComingItem {
  const d = o.disappearance;
  const r = o.reappearance;
  const parts: string[] = [];
  if (d) parts.push(`disappears ${clock(d.jd_utc, f)} at the ${d.limb} limb`);
  if (r) parts.push(`reappears ${clock(r.jd_utc, f)} at the ${r.limb} limb`);
  const star = o.kind === 'star' ? ` (magnitude ${formatMagnitude(o.magnitude)})` : '';
  return {
    kind: 'occultation',
    jd: d?.jd_utc ?? o.closest.jd_utc,
    title: `${o.graze ? 'The Moon grazes' : 'The Moon hides'} ${o.body}${star}`,
    detail: `${cap(parts.join(', '))}. Times at the Moon’s mean edge: the real edge can shift them by seconds, up to a minute.`,
    body: o.kind === 'planet' ? o.body : 'Moon',
    seen: o.visible,
  };
}

const occultations: ComingSource = {
  id: 'occultations',
  label: 'occultations',
  available: (ctx) => isMoonDetailEngine(ctx.engine),
  run(ctx, q, f) {
    if (!isMoonDetailEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    return {
      items: ctx.engine
        .occultations(q.observer, a, b)
        .events.filter((o) => o.occulted && o.visible && (o.disappearance?.sky_phase !== 'day' || o.reappearance?.sky_phase !== 'day'))
        .map((o) => occultationItem(o, f)),
    };
  },
};

const showers: ComingSource = {
  id: 'showers',
  label: 'meteor showers',
  available: (ctx) => isDeepSkyEngine(ctx.engine),
  run(ctx, q) {
    const engine = ctx.engine;
    if (!isDeepSkyEngine(engine)) return { items: [] };
    const out: ComingItem[] = [];
    for (const year of yearsOf(q)) {
      for (const s of engine.meteorShowers(year).showers) {
        if (!inside(s.peak.jd_utc, q)) continue;
        const moon = s.moon_illuminated_fraction;
        out.push({
          kind: 'shower',
          jd: s.peak.jd_utc,
          title: `${s.shower.name} peak`,
          detail: `Up to ${Math.round(s.shower.zhr)} an hour under a perfect sky (ZHR${s.shower.variable ? ', variable' : ''}); the Moon ${percentLit(moon)} lit.`,
          body: null,
          seen: true,
        });
      }
    }
    return { items: out };
  },
};

const PLANET_WORDS: Record<PlanetEvent['kind'], (e: PlanetEvent) => [string, string, boolean]> = {
  opposition: (e) => [`${e.body} at opposition`, 'Opposite the Sun: up all night and near its brightest.', true],
  conjunction: (e) => [`${e.body} behind the Sun`, 'In conjunction with the Sun: lost in its glare for weeks around it.', false],
  inferior_conjunction: (e) => [
    `${e.body} between us and the Sun`,
    e.transit ? 'Inferior conjunction, with a transit across the Sun.' : 'Inferior conjunction: it moves from the evening sky to the morning sky.',
    Boolean(e.transit),
  ],
  superior_conjunction: (e) => [`${e.body} beyond the Sun`, 'Superior conjunction: lost in the Sun’s glare.', false],
  greatest_elongation_east: (e) => [`${e.body} farthest east of the Sun`, `${e.elongation_deg.toFixed(1)}° from the Sun: the best time to see it in the evening sky.`, true],
  greatest_elongation_west: (e) => [`${e.body} farthest west of the Sun`, `${e.elongation_deg.toFixed(1)}° from the Sun: the best time to see it in the morning sky.`, true],
  perigee: (e) => [`${e.body} closest to the Earth`, `${e.distance_au.toFixed(3)} AU away.`, true],
};

const planets: ComingSource = {
  id: 'planets',
  label: 'planet events',
  available: (ctx) => isPlanetEventsEngine(ctx.engine),
  run(ctx, q) {
    if (!isPlanetEventsEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    return {
      items: ctx.engine.planetEvents(a, b).events.map((e) => {
        const [title, detail, seen] = PLANET_WORDS[e.kind](e);
        return { kind: 'planet' as const, jd: e.jd_utc, title, detail, body: e.body, seen };
      }),
    };
  },
};

function stationItem(s: PlanetStation): ComingItem {
  const begins = s.kind === 'retrograde_begins';
  return {
    kind: 'station',
    jd: s.jd_utc,
    title: `${s.body} stands still`,
    detail: begins ? 'Its backward (retrograde) loop against the stars begins.' : 'Its backward (retrograde) loop ends; it moves east against the stars again.',
    body: s.body,
    seen: true,
  };
}

const stations: ComingSource = {
  id: 'stations',
  label: 'stations',
  available: (ctx) => isPlanetDetailEngine(ctx.engine),
  run(ctx, q) {
    if (!isPlanetDetailEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    const list = ctx.engine.stations(a, b);
    return { items: list.stations.filter((s) => s.coordinate === list.ui_coordinate).map(stationItem) };
  },
};

const SEASON_WORDS: Record<string, [string, string, string]> = {
  march_equinox: ['March equinox', 'spring', 'autumn'],
  june_solstice: ['June solstice', 'summer', 'winter'],
  september_equinox: ['September equinox', 'autumn', 'spring'],
  december_solstice: ['December solstice', 'winter', 'summer'],
};

const seasons: ComingSource = {
  id: 'seasons',
  label: 'equinoxes and solstices',
  available: () => true,
  run(ctx, q) {
    const north = q.observer.lat_deg >= 0;
    const out: ComingItem[] = [];
    for (const year of yearsOf(q)) {
      for (const s of ctx.engine.seasons(year)) {
        if (!inside(s.jd_utc, q)) continue;
        const [title, n, sth] = SEASON_WORDS[s.kind] ?? [s.kind, '', ''];
        const equinox = s.kind.endsWith('equinox');
        out.push({
          kind: 'season',
          jd: s.jd_utc,
          title,
          detail: `The astronomical start of ${north ? n : sth} here${equinox ? '; day and night about equally long' : ''}.`,
          body: 'Sun',
          seen: true,
        });
      }
    }
    return { items: out };
  },
};

const earth: ComingSource = {
  id: 'earth',
  label: 'perihelion and aphelion',
  available: (ctx) => isPlanetDetailEngine(ctx.engine),
  run(ctx, q) {
    if (!isPlanetDetailEngine(ctx.engine)) return { items: [] };
    const engine = ctx.engine;
    const out: ComingItem[] = [];
    for (const year of yearsOf(q)) {
      for (const e of engine.earthApsides(year).events) {
        if (!inside(e.jd_utc, q)) continue;
        out.push({
          kind: 'earth',
          jd: e.jd_utc,
          title: e.kind === 'perihelion' ? 'The Earth closest to the Sun (perihelion)' : 'The Earth farthest from the Sun (aphelion)',
          detail: `${(e.distance_km / 1e6).toFixed(1)} million km (${e.distance_au.toFixed(4)} AU).`,
          body: 'Sun',
          seen: true,
        });
      }
    }
    return { items: out };
  },
};

const transits: ComingSource = {
  id: 'transits',
  label: 'transits of Mercury and Venus',
  available: (ctx) => isPlanetDetailEngine(ctx.engine),
  run(ctx, q) {
    if (!isPlanetDetailEngine(ctx.engine)) return { items: [] };
    const [a, b] = span(q);
    const items = ctx.engine.transits(a, b, q.observer).transits.map((t) => {
      const v = t.local?.visibility ?? 'none';
      const [words, seen] = SEEN_WORDS[v];
      const greatest = t.contacts.find((c) => c.kind === 'greatest') ?? t.contacts[0]!;
      return {
        kind: 'transit' as const,
        jd: greatest.jd_utc,
        title: `Transit of ${t.planet} across the Sun`,
        detail: `${cap(words)}. Never look at the Sun without proper eye protection.`,
        body: t.planet,
        seen,
      };
    });
    return { items };
  },
};

/** Every source, in the order the view runs them (cheapest first, the year-long tables last). */
export const COMING_SOURCES: readonly ComingSource[] = [phases, eclipses, planets, transits, seasons, conjunctions, occultations, stations, apsides, showers, earth];

/**
 * The list the card shows: every source's items in time order, with the supermoon notes of
 * the apsides source added to the full and new Moons they belong to.
 */
export function mergeComing(results: ReadonlyMap<string, ComingResult>): ComingItem[] {
  const notes = [...results.values()].flatMap((r) => r.notes ?? []);
  const all: ComingItem[] = [];
  for (const r of results.values()) all.push(...r.items);
  return all
    .map((item) => {
      if (item.kind !== 'phase') return item;
      const n = notes.find((x) => Math.abs(x.jd - item.jd) < 1 / 1440);
      return n ? { ...item, title: `${item.title}: ${n.note}` } : item;
    })
    .sort((a, b) => a.jd - b.jd || a.title.localeCompare(b.title));
}

/** Items grouped under their local date (`Friday 25 September`). */
export function groupByDay(items: readonly ComingItem[], f: Fmt, dateText: (jd: number) => string): { date: string; items: ComingItem[] }[] {
  const out: { date: string; items: ComingItem[] }[] = [];
  for (const item of items) {
    const date = dateText(item.jd);
    const last = out[out.length - 1];
    if (last && last.date === date) last.items.push(item);
    else out.push({ date, items: [item] });
  }
  void f;
  return out;
}
