/**
 * The Events view's pure logic: which events a list shows around the explorer's time,
 * what an eclipse looks like from the observer's place in plain words, the names of
 * things, and the spans of time asked of the engine. OWNER: eclipse agent (Events view).
 * No DOM; tested in web/test/next/events.test.ts.
 */

import type {
  Eclipse,
  EclipseLocal,
  EclipseLocalEvent,
  EclipseLocalEventKind,
  LunarEclipse,
  LunarEclipseLocal,
  PhaseEvent,
  PlanetEvent,
  SeasonEvent,
  SolarEclipse,
  SolarEclipseLocal,
} from '../engine/types.js';

export const YEAR_DAYS = 365.25;
/** How far the eclipse lists reach: ten years ahead, or ten back. */
export const ECLIPSE_HORIZON_DAYS = 10 * YEAR_DAYS;
/** Planet events: a year ahead, or a year back. */
export const PLANET_HORIZON_DAYS = YEAR_DAYS;
export const SYNODIC_MONTH_DAYS = 29.530589;
/** Moon phases: this many lunations, starting with the one in progress. */
export const LUNATIONS = 7;
/** Equinoxes and solstices: the year before the explorer's and this many after it. */
export const SEASON_YEARS_AHEAD = 4;

export type Direction = 'upcoming' | 'past';
export type EclipseKindFilter = 'all' | 'solar' | 'lunar';

// ---------------------------------------------------------------------------
// Spans of time asked of the engine
// ---------------------------------------------------------------------------

/** A span of UTC Julian dates. */
export interface Span {
  start: number;
  end: number;
}

/**
 * What a list needs around `anchor`: `horizonDays` ahead (upcoming) or back (past), and
 * `leadDays` the other way, so that an event in progress is still found.
 */
export function neededSpan(anchor: number, direction: Direction, horizonDays: number, leadDays = 1): Span {
  return direction === 'upcoming'
    ? { start: anchor - leadDays, end: anchor + horizonDays }
    : { start: anchor - horizonDays, end: anchor + leadDays };
}

export function covers(have: Span | null, need: Span): boolean {
  return have !== null && have.start <= need.start && have.end >= need.end;
}

/** The span to compute for `need`: whole days, widened by `slackDays` both ways. */
export function paddedSpan(need: Span, slackDays: number): Span {
  return { start: Math.floor(need.start - slackDays), end: Math.ceil(need.end + slackDays) };
}

/**
 * One engine result for a span, recomputed only when a request is no longer inside the
 * span it was computed for: the explorer's clock or playback moves the lists' anchor a
 * little at a time, and each move must not cost an engine call.
 */
export class SpanCache<T> {
  private span: Span | null = null;
  private value: T | null = null;

  constructor(
    private readonly compute: (span: Span) => T,
    private readonly slackDays: number,
  ) {}

  get(need: Span): T {
    if (this.value === null || !covers(this.span, need)) {
      const span = paddedSpan(need, this.slackDays);
      this.value = this.compute(span);
      this.span = span;
    }
    return this.value;
  }

  clear(): void {
    this.span = null;
    this.value = null;
  }
}

// ---------------------------------------------------------------------------
// Eclipses: which ones a list shows
// ---------------------------------------------------------------------------

/** From the first global contact to the last. */
export function eclipseSpan(e: Eclipse): Span {
  let start = e.greatest.jd_utc;
  let end = e.greatest.jd_utc;
  for (const c of e.contacts) {
    start = Math.min(start, c.jd_utc);
    end = Math.max(end, c.jd_utc);
  }
  return { start, end };
}

export function inProgress(e: Eclipse, jd: number): boolean {
  const s = eclipseSpan(e);
  return jd >= s.start && jd <= s.end;
}

/**
 * The eclipses a list shows. Upcoming: not over at `anchor` (one in progress counts),
 * soonest first. Past: over, the most recent first.
 */
export function eclipsesAround(
  list: readonly Eclipse[],
  anchor: number,
  direction: Direction,
  kind: EclipseKindFilter = 'all',
  horizonDays = ECLIPSE_HORIZON_DAYS,
): Eclipse[] {
  const ofKind = list.filter((e) => kind === 'all' || e.kind === kind);
  if (direction === 'upcoming') {
    return ofKind
      .filter((e) => eclipseSpan(e).end >= anchor && e.greatest.jd_utc <= anchor + horizonDays)
      .sort((a, b) => a.greatest.jd_utc - b.greatest.jd_utc);
  }
  return ofKind
    .filter((e) => eclipseSpan(e).end < anchor && e.greatest.jd_utc >= anchor - horizonDays)
    .sort((a, b) => b.greatest.jd_utc - a.greatest.jd_utc);
}

/** Something of the eclipse can be seen from the place (the Sun or Moon up for part of it). */
export function seenHere(local: EclipseLocal): boolean {
  return local.visibility === 'visible' || local.visibility === 'partly_below_horizon';
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** `Total solar eclipse`, `Penumbral lunar eclipse`. */
export function eclipseTitle(e: Eclipse): string {
  return `${capital(e.type)} ${e.kind} eclipse`;
}

/** What the type means, in one sentence. */
export function eclipseTypeWords(e: Eclipse): string {
  if (e.kind === 'solar') {
    switch (e.type) {
      case 'total':
        return 'The Moon covers the whole Sun along a narrow path; on either side of it the eclipse is partial.';
      case 'annular':
        return 'The Moon is too far from the Earth to cover the whole Sun: along a narrow path it leaves a ring of sunlight, and on either side the eclipse is partial.';
      case 'hybrid':
        return 'Total along part of the path and annular (a ring of sunlight) along the rest; partial on either side.';
      case 'partial':
        return 'The Moon’s dark central shadow misses the Earth: the eclipse is partial everywhere it is seen.';
    }
  }
  switch (e.type) {
    case 'total':
      return 'The whole Moon passes into the Earth’s dark shadow, and usually turns a coppery red.';
    case 'partial':
      return 'Part of the Moon passes into the Earth’s dark shadow.';
    case 'penumbral':
      return 'The Moon passes only through the Earth’s faint outer shadow (the penumbra): a subtle dimming, easy to miss.';
  }
}

export interface EventName {
  /** Plain words: `Totality begins`. */
  name: string;
  /** The astronomer's term: `second contact`, or '' when the name is the term. */
  term: string;
}

/** The name of a local eclipse event. `central` is the local type where there is a central phase. */
export function localEventName(kind: EclipseLocalEventKind, central: 'total' | 'annular' | null = null): EventName {
  const phase = central === 'annular' ? 'Annular phase' : 'Totality';
  switch (kind) {
    case 'c1':
      return { name: 'Partial eclipse begins', term: 'first contact' };
    case 'c2':
      return { name: `${phase} begins`, term: 'second contact' };
    case 'max':
      return { name: 'Greatest eclipse', term: 'maximum' };
    case 'c3':
      return { name: `${phase} ends`, term: 'third contact' };
    case 'c4':
      return { name: 'Partial eclipse ends', term: 'fourth contact' };
    case 'p1':
      return { name: 'Penumbral eclipse begins', term: 'P1' };
    case 'u1':
      return { name: 'Partial eclipse begins', term: 'U1' };
    case 'u2':
      return { name: 'Total eclipse begins', term: 'U2' };
    case 'u3':
      return { name: 'Total eclipse ends', term: 'U3' };
    case 'u4':
      return { name: 'Partial eclipse ends', term: 'U4' };
    case 'p4':
      return { name: 'Penumbral eclipse ends', term: 'P4' };
    case 'sunrise':
      return { name: 'Sunrise', term: '' };
    case 'sunset':
      return { name: 'Sunset', term: '' };
    case 'moonrise':
      return { name: 'Moonrise', term: '' };
    case 'moonset':
      return { name: 'Moonset', term: '' };
  }
}

// ---------------------------------------------------------------------------
// Numbers in words
// ---------------------------------------------------------------------------

/** `58 s`, `3 min 12 s`, `2 h 39 min`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.round(Math.max(0, seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} min ${String(r).padStart(2, '0')} s` : `${m} min`;
  }
  const minutes = Math.round(s / 60);
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** A fraction as a percentage that never claims 100 % or 0 % when it is not. */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return '—';
  if (fraction >= 1) return '100%';
  if (fraction <= 0) return '0%';
  if (fraction > 0.99) return `${(Math.floor(fraction * 1000) / 10).toFixed(1)}%`;
  if (fraction < 0.01) return 'under 1%';
  return `${Math.round(fraction * 100)}%`;
}

/** An eclipse magnitude: `1.057`, `0.342`. */
export function formatEclipseMagnitude(m: number | null | undefined): string {
  if (m === null || m === undefined || !Number.isFinite(m)) return '—';
  return m.toFixed(3).replace('-', '−');
}

// ---------------------------------------------------------------------------
// What an eclipse looks like from the place
// ---------------------------------------------------------------------------

export function eventOf(local: EclipseLocal, kind: EclipseLocalEventKind): EclipseLocalEvent | null {
  return local.events.find((e) => e.kind === kind) ?? null;
}

/** The central phase (total or annular) of a solar eclipse here, when there is one. */
export function centralPhase(local: SolarEclipseLocal): 'total' | 'annular' | null {
  return local.local_type === 'total' || local.local_type === 'annular' ? local.local_type : null;
}

export type HereTone = 'central' | 'partial' | 'faint' | 'none';

export interface HereLabel {
  seen: boolean;
  /** `Total here, 3 min 12 s`, `Partial here, 23% covered, at sunset`, `Not seen here`. */
  text: string;
  tone: HereTone;
}

/**
 * One line for a list: what the place sees of the eclipse, and when (`time` formats a
 * local time; without it the line has no times).
 */
export function hereLabel(e: Eclipse, local: EclipseLocal, time: (jd: number) => string = () => ''): HereLabel {
  if (local.kind === 'solar') return solarHere(local, time);
  return lunarHere(e as LunarEclipse, local, time);
}

function solarHere(local: SolarEclipseLocal, time: (jd: number) => string): HereLabel {
  if (local.visibility === 'none') return { seen: false, text: 'Not seen here', tone: 'none' };
  if (local.visibility === 'below_horizon') return { seen: false, text: 'Not seen here: the Sun is down', tone: 'none' };
  const at = (jd: number): string => (time(jd) ? ` at ${time(jd)}` : '');
  const central = centralPhase(local);
  const c2 = eventOf(local, 'c2');
  const c3 = eventOf(local, 'c3');
  if (central && c2?.visible && c3?.visible) {
    return {
      seen: true,
      text: `${central === 'total' ? 'Total' : 'Annular'} here${at(c2.jd_utc)}, for ${formatDuration(local.central_duration_s)}`,
      tone: 'central',
    };
  }
  const best = local.visible_max;
  const covered = formatPercent(best?.obscuration ?? local.obscuration);
  if (best && (best.kind === 'sunrise' || best.kind === 'sunset')) {
    const t = time(best.jd_utc);
    return { seen: true, text: `Partial here at ${best.kind}${t ? ` (${t})` : ''}, ${covered} covered`, tone: 'partial' };
  }
  return { seen: true, text: `Partial here${best ? at(best.jd_utc) : ''}, ${covered} covered`, tone: 'partial' };
}

function lunarHere(e: LunarEclipse, local: LunarEclipseLocal, time: (jd: number) => string): HereLabel {
  if (!seenHere(local)) return { seen: false, text: 'Not seen here: the Moon is down', tone: 'none' };
  const rise = eventOf(local, 'moonrise');
  const set = eventOf(local, 'moonset');
  const max = eventOf(local, 'max');
  const at = (jd: number): string => (time(jd) ? ` at ${time(jd)}` : '');
  const part =
    rise && set
      ? ', between moonrise and moonset'
      : rise
        ? `, from moonrise${at(rise.jd_utc)}`
        : set
          ? `, until moonset${at(set.jd_utc)}`
          : max && time(max.jd_utc)
            ? `, greatest${at(max.jd_utc)}`
            : '';
  if (e.type === 'penumbral') return { seen: true, text: `Seen here (faint)${part}`, tone: 'faint' };
  return { seen: true, text: `Seen here${part}`, tone: e.type === 'total' ? 'central' : 'partial' };
}

/** How the summaries format what they mention. */
export interface Words {
  /** "Philadelphia City Hall", or "this place". */
  place: string;
  /** A local time, with seconds for contacts: `15:21:03`. */
  time(jd: number): string;
  /** An altitude: `45°`. */
  altitude(deg: number): string;
  /** A direction in words: `south-west`. */
  direction(azDeg: number): string;
  /** A position: `25° 17′ N, 104° 09′ W`. */
  position(latDeg: number, lonDeg: number): string;
}

function upIn(ev: EclipseLocalEvent, w: Words, body: 'Sun' | 'Moon'): string {
  return `the ${body} ${w.altitude(ev.alt_deg)} up in the ${w.direction(ev.az_deg)}`;
}

/** A plain-language account of a solar eclipse from the place, a few sentences. */
export function solarSummary(e: SolarEclipse, local: SolarEclipseLocal, w: Words): string[] {
  const where = `Greatest eclipse is at ${w.position(e.greatest.lat_deg, e.greatest.lon_deg)}, at ${w.time(e.greatest.jd_utc)} your time.`;
  if (local.visibility === 'none') {
    return [`The Moon’s shadow misses ${w.place}: nothing of this eclipse can be seen there.`, where];
  }
  if (local.visibility === 'below_horizon') {
    return [
      `The eclipse happens while the Sun is below the horizon at ${w.place}, so none of it can be seen there.`,
      where,
    ];
  }
  const out: string[] = [];
  const c1 = eventOf(local, 'c1');
  const c2 = eventOf(local, 'c2');
  const c3 = eventOf(local, 'c3');
  const c4 = eventOf(local, 'c4');
  const max = eventOf(local, 'max');
  const sunrise = eventOf(local, 'sunrise');
  const sunset = eventOf(local, 'sunset');
  const central = centralPhase(local);

  if (central && c2 && c3) {
    const pathName = central === 'total' ? 'the path of totality' : 'the path of the annular eclipse';
    if (c2.visible && c3.visible) {
      const what =
        central === 'total'
          ? `The Moon covers the Sun completely for ${formatDuration(local.central_duration_s)}`
          : `For ${formatDuration(local.central_duration_s)} the Moon sits inside the Sun’s disc and leaves a ring of sunlight`;
      out.push(
        `${capital(w.place)} is inside ${pathName}. ${what}, from ${w.time(c2.jd_utc)} to ${w.time(c3.jd_utc)}, with ${upIn(max ?? c2, w, 'Sun')}.`,
      );
    } else {
      out.push(
        `${capital(w.place)} is inside ${pathName}, but the ${central === 'total' ? 'total' : 'annular'} phase comes with the Sun below the horizon there; only the partial eclipse can be seen.`,
      );
    }
  } else {
    const best = local.visible_max;
    if (max && best && best.kind === 'max') {
      out.push(
        `From ${w.place} it is a partial eclipse. At its greatest, at ${w.time(max.jd_utc)}, the Moon covers ${formatPercent(max.obscuration ?? local.obscuration)} of the Sun’s disc (magnitude ${formatEclipseMagnitude(max.magnitude ?? local.magnitude)}), with ${upIn(max, w, 'Sun')}.`,
      );
    } else if (best) {
      const edge = best.kind === 'sunrise' ? 'sunrise' : 'sunset';
      out.push(
        `From ${w.place} it is a partial eclipse. Its greatest (${formatPercent(local.obscuration)} of the Sun covered) comes with the Sun below the horizon; the most you can see is at ${edge}, ${w.time(best.jd_utc)}, with ${formatPercent(best.obscuration)} covered.`,
      );
    }
  }

  if (sunrise && sunset) {
    out.push(`The Sun rises already eclipsed at ${w.time(sunrise.jd_utc)} and sets still eclipsed at ${w.time(sunset.jd_utc)}.`);
  } else if (sunrise && c4) {
    out.push(`The Sun rises already eclipsed at ${w.time(sunrise.jd_utc)}; the eclipse ends at ${w.time(c4.jd_utc)}.`);
  } else if (sunset && c1) {
    out.push(`The eclipse begins at ${w.time(c1.jd_utc)}; the Sun sets still eclipsed at ${w.time(sunset.jd_utc)}.`);
  } else if (c1 && c4) {
    out.push(
      `It begins at ${w.time(c1.jd_utc)} and ends at ${w.time(c4.jd_utc)}, ${formatDuration(local.duration_s)} in all.`,
    );
  }
  return out;
}

/** A plain-language account of a lunar eclipse from the place, a few sentences. */
export function lunarSummary(e: LunarEclipse, local: LunarEclipseLocal, w: Words): string[] {
  const out: string[] = [];
  const max = eventOf(local, 'max');
  if (!seenHere(local)) {
    return [
      `The Moon is below the horizon at ${w.place} throughout this eclipse, so none of it can be seen there.`,
      `It can be seen wherever the Moon is up: at greatest eclipse, ${w.time(e.greatest.jd_utc)} your time, the Moon is overhead at ${w.position(e.greatest.lat_deg, e.greatest.lon_deg)}.`,
    ];
  }
  const rise = eventOf(local, 'moonrise');
  const set = eventOf(local, 'moonset');
  if (local.visibility === 'visible') out.push(`The whole eclipse can be seen from ${w.place}: the Moon is up from beginning to end.`);
  else if (rise && set) out.push(`At ${w.place} the Moon rises during the eclipse, at ${w.time(rise.jd_utc)}, and sets before it is over, at ${w.time(set.jd_utc)}.`);
  else if (rise) out.push(`At ${w.place} the Moon rises at ${w.time(rise.jd_utc)}, with the eclipse already under way.`);
  else if (set) out.push(`At ${w.place} the Moon sets at ${w.time(set.jd_utc)}, before the eclipse is over.`);

  const atMax = max
    ? max.visible
      ? `at greatest eclipse, ${w.time(max.jd_utc)}, ${upIn(max, w, 'Moon')}`
      : `greatest eclipse, at ${w.time(max.jd_utc)}, comes with the Moon below the horizon there`
    : '';
  if (e.type === 'total') {
    const u2 = eventOf(local, 'u2');
    const u3 = eventOf(local, 'u3');
    if (u2 && u3) {
      const hidden = u2.visible && u3.visible ? '' : ' (not all of it with the Moon up there)';
      out.push(
        `Totality lasts ${formatDuration(e.total_duration_s)}, from ${w.time(u2.jd_utc)} to ${w.time(u3.jd_utc)}${hidden}; ${atMax}.`,
      );
    }
  } else if (e.type === 'partial') {
    out.push(
      `At most ${formatPercent(e.umbral_magnitude)} of the Moon’s diameter is inside the Earth’s dark shadow; ${atMax}.`,
    );
  } else {
    out.push(
      `The Moon passes only through the Earth’s faint outer shadow, so the dimming is subtle and easiest to notice near greatest eclipse; ${atMax}.`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Planet events
// ---------------------------------------------------------------------------

const INNER = new Set(['Mercury', 'Venus']);

/** `Mars at opposition`, `Transit of Mercury`, `Venus closest to the Earth`. */
export function planetEventTitle(e: PlanetEvent): string {
  switch (e.kind) {
    case 'opposition':
      return `${e.body} at opposition`;
    case 'conjunction':
      return `${e.body} in conjunction with the Sun`;
    case 'inferior_conjunction':
      return e.transit ? `Transit of ${e.body}` : `${e.body} at inferior conjunction`;
    case 'superior_conjunction':
      return `${e.body} at superior conjunction`;
    case 'greatest_elongation_east':
      return `${e.body} at greatest elongation east`;
    case 'greatest_elongation_west':
      return `${e.body} at greatest elongation west`;
    case 'perigee':
      return `${e.body} closest to the Earth`;
  }
}

export interface PlanetWords {
  angle(deg: number): string;
  magnitude(m: number | null): string;
  distance(km: number): string;
  date(jd: number): string;
}

/** The magnitude in brackets, saying when the eye alone is not enough. */
export function brightnessWords(m: number | null, format: (m: number | null) => string): string {
  if (m === null || !Number.isFinite(m)) return '';
  if (m > 6) return ` (magnitude ${format(m)}: too faint for the eye alone; binoculars show it)`;
  if (m > 5) return ` (magnitude ${format(m)}: only just visible to the eye, from a dark place)`;
  return ` (magnitude ${format(m)})`;
}

/** What the event means for someone looking at the sky, one or two sentences. */
export function planetEventWords(e: PlanetEvent, w: PlanetWords, approach: PlanetEvent | null = null): string {
  const bright = brightnessWords(e.magnitude, w.magnitude);
  const closest = approach
    ? ` Closest to the Earth on ${w.date(approach.jd_utc)}: ${w.distance(approach.distance_km)}.`
    : '';
  switch (e.kind) {
    case 'opposition':
      return `Opposite the Sun in the sky: up all night, highest around midnight, and near its brightest${bright}.${closest}`;
    case 'conjunction':
      return `Behind the Sun as seen from the Earth, lost in its glare for some weeks either side.${closest}`;
    case 'inferior_conjunction':
      return e.transit
        ? `It passes between the Earth and the Sun and crosses the Sun’s face (as seen from the Earth’s centre; when and whether it can be seen from here is not computed).${closest}`
        : `It passes between the Earth and the Sun, ${w.angle(e.elongation_deg)} from the Sun’s centre, and is lost in its glare; afterwards it moves into the morning sky.${closest}`;
    case 'superior_conjunction':
      return `It passes behind the Sun, lost in its glare; afterwards it moves into the evening sky.${closest}`;
    case 'greatest_elongation_east':
      return `At its greatest angle east of the Sun, ${w.angle(e.elongation_deg)}${bright}: around the best time to look for it in the evening sky after sunset.`;
    case 'greatest_elongation_west':
      return `At its greatest angle west of the Sun, ${w.angle(e.elongation_deg)}${bright}: around the best time to look for it in the morning sky before sunrise.`;
    case 'perigee':
      return `Closest to the Earth: ${w.distance(e.distance_km)}.`;
  }
}

export interface PlanetRow {
  event: PlanetEvent;
  /** The closest approach folded into this row (an opposition, or an inferior conjunction). */
  approach: PlanetEvent | null;
}

/** How near a closest approach must be to an opposition or inferior conjunction to be told with it. */
export const APPROACH_FOLD_DAYS = 10;

/**
 * The planet events a list shows, with each closest approach told with the opposition
 * (Mars to Neptune) or inferior conjunction (Mercury, Venus) it goes with when that event
 * is in the list too: they are days apart and are one story.
 */
export function planetRows(
  events: readonly PlanetEvent[],
  anchor: number,
  direction: Direction,
  horizonDays = PLANET_HORIZON_DAYS,
): PlanetRow[] {
  const inList = (e: PlanetEvent): boolean =>
    direction === 'upcoming'
      ? e.jd_utc >= anchor && e.jd_utc <= anchor + horizonDays
      : e.jd_utc < anchor && e.jd_utc >= anchor - horizonDays;
  const shown = events.filter(inList);
  const rows = new Map<PlanetEvent, PlanetRow>();
  for (const e of shown) if (e.kind !== 'perigee') rows.set(e, { event: e, approach: null });
  for (const p of shown) {
    if (p.kind !== 'perigee') continue;
    const partnerKind = INNER.has(p.body) ? 'inferior_conjunction' : 'opposition';
    let partner: PlanetEvent | null = null;
    for (const e of shown) {
      if (e.body !== p.body || e.kind !== partnerKind) continue;
      const gap = Math.abs(e.jd_utc - p.jd_utc);
      if (gap <= APPROACH_FOLD_DAYS && (!partner || gap < Math.abs(partner.jd_utc - p.jd_utc))) partner = e;
    }
    const row = partner ? rows.get(partner) : undefined;
    if (row && !row.approach) row.approach = p;
    else rows.set(p, { event: p, approach: null });
  }
  const out = [...rows.values()];
  out.sort((a, b) => (direction === 'upcoming' ? a.event.jd_utc - b.event.jd_utc : b.event.jd_utc - a.event.jd_utc));
  return out;
}

// ---------------------------------------------------------------------------
// Moon phases
// ---------------------------------------------------------------------------

export const PHASE_NAMES: Record<PhaseEvent['kind'], string> = {
  new_moon: 'New Moon',
  first_quarter: 'First quarter',
  full_moon: 'Full Moon',
  last_quarter: 'Last quarter',
};

export const PHASE_ORDER: readonly PhaseEvent['kind'][] = ['new_moon', 'first_quarter', 'full_moon', 'last_quarter'];

/** The drawn disc for a principal phase: lit fraction and whether it is waxing. */
export function phaseLook(kind: PhaseEvent['kind']): { illuminated: number; waxing: boolean } {
  switch (kind) {
    case 'new_moon':
      return { illuminated: 0, waxing: true };
    case 'first_quarter':
      return { illuminated: 0.5, waxing: true };
    case 'full_moon':
      return { illuminated: 1, waxing: false };
    case 'last_quarter':
      return { illuminated: 0.5, waxing: false };
  }
}

export interface Lunation {
  /** The new moon that starts it. */
  start: PhaseEvent;
  /** New moon, first quarter, full moon, last quarter (the last ones may be missing at the end of the data). */
  phases: PhaseEvent[];
}

/** The Moon phases to ask for: a lunation before the anchor to `count` lunations after it. */
export function lunationSpan(anchor: number, count = LUNATIONS): Span {
  return { start: anchor - SYNODIC_MONTH_DAYS - 1, end: anchor + count * SYNODIC_MONTH_DAYS + 1 };
}

/** `count` lunations from the one in progress at `anchor` (from the last new moon at or before it). */
export function lunations(phases: readonly PhaseEvent[], anchor: number, count = LUNATIONS): Lunation[] {
  const sorted = [...phases].sort((a, b) => a.jd_utc - b.jd_utc);
  let first = -1;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.kind === 'new_moon' && sorted[i]!.jd_utc <= anchor) first = i;
  }
  if (first < 0) first = sorted.findIndex((p) => p.kind === 'new_moon');
  if (first < 0) return [];
  const out: Lunation[] = [];
  for (let i = first; i < sorted.length; i++) {
    const p = sorted[i]!;
    if (p.kind === 'new_moon') {
      if (out.length === count) break;
      out.push({ start: p, phases: [p] });
    } else {
      out[out.length - 1]!.phases.push(p);
    }
  }
  return out;
}

/** The eclipse at a Moon phase, if any: a solar eclipse at a new moon, a lunar one at a full moon. */
export function eclipseAtPhase(p: PhaseEvent, eclipses: readonly Eclipse[]): Eclipse | null {
  const kind = p.kind === 'new_moon' ? 'solar' : p.kind === 'full_moon' ? 'lunar' : null;
  if (!kind) return null;
  return eclipses.find((e) => e.kind === kind && Math.abs(e.greatest.jd_utc - p.jd_utc) < 1) ?? null;
}

// ---------------------------------------------------------------------------
// Equinoxes and solstices
// ---------------------------------------------------------------------------

export const SEASON_NAMES: Record<SeasonEvent['kind'], string> = {
  march_equinox: 'March equinox',
  june_solstice: 'June solstice',
  september_equinox: 'September equinox',
  december_solstice: 'December solstice',
};

export const SEASON_ORDER: readonly SeasonEvent['kind'][] = [
  'march_equinox',
  'june_solstice',
  'september_equinox',
  'december_solstice',
];

/** What the moment means, told for the observer's hemisphere first. */
export function seasonWords(kind: SeasonEvent['kind'], latDeg: number): string {
  const south = latDeg < 0;
  const here = (north: string, southern: string): string =>
    south
      ? `${capital(southern)} begins in the southern hemisphere, where you are, and ${north} in the northern.`
      : `${capital(north)} begins in the northern hemisphere, where you are, and ${southern} in the southern.`;
  switch (kind) {
    case 'march_equinox':
      return `The Sun crosses the equator heading north; day and night are nearly equal everywhere. ${here('spring', 'autumn')}`;
    case 'june_solstice':
      return `The Sun is at its furthest north: the ${south ? 'shortest' : 'longest'} day of the year where you are. ${here('summer', 'winter')}`;
    case 'september_equinox':
      return `The Sun crosses the equator heading south; day and night are nearly equal everywhere. ${here('autumn', 'spring')}`;
    case 'december_solstice':
      return `The Sun is at its furthest south: the ${south ? 'longest' : 'shortest'} day of the year where you are. ${here('winter', 'summer')}`;
  }
}

/** The first event at or after `jd`, from a list in any order. */
export function nextAfter<T extends { jd_utc: number }>(list: readonly T[], jd: number): T | null {
  let best: T | null = null;
  for (const e of list) if (e.jd_utc >= jd && (!best || e.jd_utc < best.jd_utc)) best = e;
  return best;
}
