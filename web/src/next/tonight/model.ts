/**
 * The Tonight view's words: every card as plain data (text and instants) built from the
 * engines' results, so the tests can check each number against the engine that produced it
 * and the DOM layer (view.ts) only lays it out. Pure functions. OWNER: tonight agent
 * (expansion programme Q2).
 *
 * Plain words first (EXPANSION_PLAN §3): "the Moon, 3 days past first quarter (78% lit),
 * sets at 00:50"; the astronomer's or navigator's term goes beside it in the view. Every
 * estimate says it is one: meteor rates, the deep-sky ranking and limiting magnitudes are the
 * deep-sky engine's stated rules (EXPLORER_API "Deep sky"); darkness is "clear-sky".
 */

import type {
  BodyEvents,
  DeepSkySighting,
  Dso,
  GalacticWindow,
  GalileanPhenomenon,
  PhaseEvent,
  PlanetTonight,
  SaturnRings,
  ShowerNight,
  SunLightWindow,
} from '../engine/types.js';
import { dateLong, formatMagnitude } from '../shell/format.js';
import { wallClock } from '../time.js';
import { darknessOf, nightMiddle, type NightCore, type NightDetail } from './data.js';
import {
  cap,
  clock,
  clockRange,
  degrees,
  directionWords,
  distanceText,
  dsoTypeWords,
  duration,
  hoursText,
  instrumentWords,
  listWords,
  magnitudeText,
  percentLit,
  phaseEventWords,
  type Fmt,
} from './format.js';
import { firstEvent, intersect, subtract, spanDays, upSpans, type Span } from './night.js';

/** The naked-eye planets the header names (Uranus and Neptune are on the planets card only). */
export const BRIGHT_PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'] as const;

// -------------------------------------------------------------------------------------
// The night's frame
// -------------------------------------------------------------------------------------

export function bodyEvents(core: NightCore, body: string): BodyEvents | null {
  return core.day?.bodies.find((b) => b.body === body) ?? null;
}

/** Sunset and the sunrise after it inside the night (noon to noon), when they happen. */
export function sunsetSunrise(core: NightCore): { set: number | null; rise: number | null } {
  const sun = bodyEvents(core, 'Sun');
  const set = firstEvent(sun, 'set', [core.q.n, core.q.n + 1])?.jd_utc ?? null;
  const rise = firstEvent(sun, 'rise', [set ?? core.q.n, core.q.n + 1])?.jd_utc ?? null;
  return { set, rise };
}

/**
 * The stretch the planets are judged over, as the deep-sky engine does: the longest run of the
 * Sun at least 6° down (nautical twilight or darker). Null when it never gets that low.
 */
export function planetWindow(core: NightCore): Span | null {
  let best: Span | null = null;
  let run: Span | null = null;
  for (const p of core.day?.phases ?? []) {
    run = p.phase === 'nautical' || p.phase === 'astronomical' || p.phase === 'night' ? (run ? [run[0], p.jd_end] : [p.jd_start, p.jd_end]) : null;
    if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
  }
  return best;
}

/** The Moon above the horizon inside the night (rise and set on the person's horizon). */
export function moonUp(core: NightCore): Span[] {
  return upSpans([core.q.n, core.q.n + 1], bodyEvents(core, 'Moon'));
}

/**
 * The best stretch for faint objects: the darkness with the Moon down (a Moon under 3% lit
 * counts as down, as the engine's summary calls it new).
 */
export function moonlessDark(core: NightCore): Span[] {
  const d = darknessOf(core);
  if (!d) return [];
  const lit = core.tonight?.night.moon.illuminated_fraction ?? 1;
  return subtract([d.start, d.end], lit < 0.03 ? [] : moonUp(core));
}

// -------------------------------------------------------------------------------------
// The header
// -------------------------------------------------------------------------------------

export interface HeaderModel {
  /** `Tonight`, `Tomorrow night`, `Last night`, or `The night of`. */
  kicker: string;
  /** `Thursday 24 September` (the year when it is not this one). */
  date: string;
  /** Plain sentences: darkness, the Moon, the planets, meteors, an eclipse. */
  sentences: string[];
}

/** The evening's date: the local date at sunset (or at 18:00 local mean time without one). */
export function eveningDate(core: NightCore, f: Fmt, nowJd: number): string {
  const { set } = sunsetSunrise(core);
  const at = set ?? core.q.n + 0.25;
  // time-ui: the calendar formatter (Julian dates before 1582, BC years) once it lands.
  const text = dateLong(at, f.zone);
  return wallClock(at, f.zone).year === wallClock(nowJd, f.zone).year ? text.replace(/ -?\d+$/, '') : text;
}

/** How the night stands to the real present: `Tonight`, `Tomorrow night`, `Last night`, `The night of`. */
export function relativeNight(n: number, realNight: number | null): string {
  if (realNight === null) return 'The night of';
  const k = Math.round(n - realNight);
  return k === 0 ? 'Tonight' : k === 1 ? 'Tomorrow night' : k === -1 ? 'Last night' : 'The night of';
}

export function darknessSentence(core: NightCore, f: Fmt): string {
  const d = darknessOf(core);
  if (d) {
    const span = `${clockRange(d.start, d.end, f)} (${duration(d.end - d.start)})`;
    if (d.kind === 'night') return `Clear-sky darkness ${span}.`;
    if (d.kind === 'astronomical_twilight') return `The sky never gets fully dark: darkest ${span}, in astronomical twilight.`;
    return `Only twilight tonight: darkest ${span}, the Sun 6° to 12° down.`;
  }
  const sun = bodyEvents(core, 'Sun');
  if (sun?.always_above) return 'The Sun does not set tonight.';
  return 'No darkness tonight: the Sun stays within 6° of the horizon.';
}

/** `3 days past first quarter`, `2 days before full`, `full`, from the phase nearest `jd`. */
export function phaseWords(phases: readonly PhaseEvent[] | null, jd: number): string | null {
  if (!phases?.length) return null;
  let near = phases[0]!;
  for (const p of phases) if (Math.abs(p.jd_utc - jd) < Math.abs(near.jd_utc - jd)) near = p;
  const days = Math.round(Math.abs(jd - near.jd_utc));
  const name = phaseEventWords(near.kind).replace(' Moon', '');
  if (days === 0) return near.kind === 'full_moon' || near.kind === 'new_moon' ? name : `at ${name}`;
  return `${days === 1 ? 'a day' : `${days} days`} ${jd > near.jd_utc ? 'past' : 'before'} ${name}`;
}

/** The Moon's rises and sets that matter tonight: those in the dark, or between sunset and sunrise. */
export function moonEvents(core: NightCore): { kind: 'rise' | 'set'; jd: number }[] {
  const moon = bodyEvents(core, 'Moon');
  const { set, rise } = sunsetSunrise(core);
  const d = darknessOf(core);
  const span: Span = [set ?? d?.start ?? core.q.n + 0.25, rise ?? d?.end ?? core.q.n + 0.75];
  return (moon?.events ?? [])
    .filter((e) => (e.kind === 'rise' || e.kind === 'set') && e.jd_utc >= span[0] && e.jd_utc <= span[1])
    .map((e) => ({ kind: e.kind as 'rise' | 'set', jd: e.jd_utc }));
}

export function moonSentence(core: NightCore, detail: NightDetail | null, f: Fmt): string | null {
  const m = core.tonight?.night.moon;
  if (!m) return null;
  if (m.illuminated_fraction < 0.03) return 'The Moon is new: a dark night.';
  const words = phaseWords(detail?.phases ?? null, nightMiddle(core)) ?? m.phase;
  const who = words === 'full' || words === 'new' ? `The Moon is ${words}` : `The Moon, ${words}`;
  const lit = `(${percentLit(m.illuminated_fraction)} lit)`;
  const d = darknessOf(core);
  const events = moonEvents(core);
  const up = d ? spanDays(moonUp(core).map((s) => intersect(s, [d.start, d.end])).filter((s): s is Span => s !== null)) : 0;
  let what: string;
  if (events.length) {
    what = events.map((e) => `${e.kind === 'rise' ? 'rises' : 'sets'} at ${clock(e.jd, f)}`).join(' and ');
  } else if (d && up >= d.end - d.start - 1 / 1440) {
    what = 'is up all through the dark hours';
  } else if (d && up <= 0) {
    what = 'is down all through the dark hours';
  } else {
    what = bodyEvents(core, 'Moon')?.always_above ? 'is up all night' : 'stays down all night';
  }
  return who.startsWith('The Moon is') ? `${who} ${lit} and ${what}.` : `${who} ${lit}, ${what}.`;
}

/** When a planet is up in the dark, in words, against the planets' window (`planetWindow`). */
export function planetWhen(p: PlanetTonight, window: Span | null, f: Fmt): string {
  if (!p.up_from || !p.up_until || !window) return '';
  const slack = 20 / 1440;
  const a = p.up_from.jd_utc;
  const b = p.up_until.jd_utc;
  const mid = (window[0] + window[1]) / 2;
  const fromStart = a - window[0] <= slack;
  const toEnd = window[1] - b <= slack;
  if (fromStart && toEnd) return 'all night';
  if (fromStart) return b < mid ? 'in the evening' : `until ${clock(b, f)}`;
  if (toEnd) return a > mid ? 'in the morning' : `from ${clock(a, f)}`;
  return `${clock(a, f)}–${clock(b, f)}`;
}

/** Planets up in the dark (10° or more at some time while the Sun is 6° down). */
export function visiblePlanets(core: NightCore): PlanetTonight[] {
  return (core.tonight?.planets ?? []).filter((p) => p.best !== null && p.hours_up > 0);
}

export function planetsSentence(core: NightCore, f: Fmt): string | null {
  if (!core.tonight) return null;
  const window = planetWindow(core);
  const bright = visiblePlanets(core).filter((p) => (BRIGHT_PLANETS as readonly string[]).includes(p.body));
  if (!bright.length) return 'No bright planet is up in the dark.';
  // Group planets that share a phrase: "Jupiter and Saturn all night".
  const groups = new Map<string, string[]>();
  for (const p of bright) {
    const when = planetWhen(p, window, f);
    groups.set(when, [...(groups.get(when) ?? []), p.body]);
  }
  const parts = [...groups].map(([when, names]) => `${listWords(names)}${when ? ` ${when}` : ''}`);
  return `Planets: ${parts.join('; ')}.`;
}

/** A shower is "at its peak" within a day of it. */
export function atPeak(s: ShowerNight): boolean {
  return Math.abs(s.days_from_peak) < 1;
}

export function showersSentence(core: NightCore): string | null {
  const list = (core.tonight?.showers ?? []).filter((s) => s.expected_rate_per_hour >= 2);
  if (!list.length) return null;
  const parts = list.map((s) => `the ${s.name} ${atPeak(s) ? 'at their peak' : 'active'} (about ${Math.round(s.expected_rate_per_hour)} an hour here)`);
  return `Meteors: ${listWords(parts)}.`;
}

export function eclipseSentence(detail: NightDetail | null): string | null {
  const e = detail?.eclipses[0];
  if (!e) return null;
  const kind = e.eclipse.kind === 'lunar' ? 'of the Moon' : 'of the Sun';
  const type = e.eclipse.type === 'penumbral' ? 'A penumbral eclipse' : `A ${e.eclipse.type} eclipse`;
  const seen =
    !e.local || e.local.visibility === 'none'
      ? 'not seen from here'
      : e.local.visibility === 'below_horizon'
        ? `below the horizon here`
        : e.local.visibility === 'partly_below_horizon'
          ? 'partly seen from here'
          : 'seen from here';
  return `${type} ${kind}, ${seen}.`;
}

export function headerModel(core: NightCore, detail: NightDetail | null, f: Fmt, nowJd: number, realNight: number | null): HeaderModel {
  const sentences = [darknessSentence(core, f), eclipseSentence(detail), moonSentence(core, detail, f), planetsSentence(core, f), showersSentence(core)].filter(
    (x): x is string => Boolean(x),
  );
  return { kicker: relativeNight(core.q.n, realNight), date: eveningDate(core, f, nowJd), sentences };
}

// -------------------------------------------------------------------------------------
// The Moon
// -------------------------------------------------------------------------------------

export interface MoonModel {
  /** `Waxing gibbous`. */
  name: string;
  illuminated: number;
  /** `78% lit · 3 days past first quarter`. */
  lit: string;
  waxing: boolean;
  rows: { key: string; value: string; jd?: number; tip?: string }[];
  /** Moonless darkness, as sentences. */
  moonless: string;
  /** A note on the Moon's size: supermoon, micromoon, perigee. */
  note: string | null;
  /** Relief features along the terminator, when the engine names them. */
  terminator: string | null;
}

export function moonModel(core: NightCore, detail: NightDetail | null, f: Fmt): MoonModel | null {
  const m = core.tonight?.night.moon;
  const k = m?.illuminated_fraction ?? detail?.moon?.illuminated_fraction ?? null;
  if (k === null) return null;
  const waxing = m?.waxing ?? true;
  const name = m ? cap(m.phase) : 'The Moon';
  const words = phaseWords(detail?.phases ?? null, nightMiddle(core));
  const rows: MoonModel['rows'] = [];
  for (const e of moonEvents(core)) rows.push({ key: e.kind === 'rise' ? 'Moonrise' : 'Moonset', value: clock(e.jd, f), jd: e.jd });
  const moonBody = bodyEvents(core, 'Moon');
  if (!rows.length) rows.push({ key: 'Rise and set', value: moonBody?.always_above ? 'Up all night' : moonBody?.always_below ? 'Down all night' : 'None between sunset and sunrise' });
  const o = detail?.orientation;
  if (o) {
    const pct = o.diameter_vs_mean_percent;
    rows.push({
      key: 'Distance',
      value: distanceText(o.distance_km, f.units),
      tip: `From here, at ${clock(o.jd_utc, f)}. It looks ${Math.abs(pct).toFixed(0)}% ${pct >= 0 ? 'larger' : 'smaller'} than at its mean distance of 384 400 km.`,
    });
  } else if (detail?.moon?.distance_km) {
    rows.push({ key: 'Distance', value: distanceText(detail.moon.distance_km, f.units), tip: 'From the Earth’s centre.' });
  }
  const dark = darknessOf(core);
  const free = moonlessDark(core);
  let moonless: string;
  if (!dark) moonless = 'No real darkness tonight, Moon or not.';
  else if (k < 0.03) moonless = `The Moon is new: all ${duration(dark.end - dark.start)} of darkness are moonless.`;
  else if (!free.length) moonless = 'No moonless darkness: the Moon is up through all the dark hours.';
  else if (spanDays(free) >= dark.end - dark.start - 1 / 1440) moonless = `The Moon is down through all the dark hours (${duration(dark.end - dark.start)}).`;
  else moonless = `Moonless darkness ${free.map((s) => clockRange(s[0], s[1], f)).join(' and ')} (${duration(spanDays(free))}).`;
  let note: string | null = null;
  const z = detail?.syzygy;
  if (z && (z.supermoon || z.micromoon)) {
    const what = z.kind === 'full_moon' ? 'full Moon' : 'new Moon';
    const size = `${Math.abs(z.diameter_vs_mean_percent).toFixed(0)}% ${z.diameter_vs_mean_percent >= 0 ? 'larger' : 'smaller'} than average`;
    const extra = z.largest_of_year ? ', the largest full Moon of the year' : z.smallest_of_year ? ', the smallest full Moon of the year' : '';
    note = `${weekdayOf(z.jd_utc, f)}’s ${what} (${clock(z.jd_utc, f)}) is a ${z.supermoon ? 'supermoon' : 'micromoon'}${extra}: ${distanceText(z.distance_km, f.units)} away, ${size}.`;
  }
  const t = detail?.features?.tonight.slice(0, 4) ?? [];
  const terminator = t.length ? `Along the terminator tonight: ${listWords(t)}.` : null;
  return {
    name,
    illuminated: k,
    lit: `${percentLit(k)} lit${words ? ` · ${words}` : ''}`,
    waxing,
    rows,
    moonless,
    note,
    terminator,
  };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** `Saturday` (the local weekday of an instant). */
export function weekdayOf(jd: number, f: Pick<Fmt, 'zone'>): string {
  return WEEKDAYS[wallClock(jd, f.zone).weekday]!;
}

// -------------------------------------------------------------------------------------
// The planets
// -------------------------------------------------------------------------------------

export interface PlanetRow {
  body: string;
  /** `Jupiter, east, rises 22:10, highest 03:40 at 61°, magnitude −2.7`. */
  line: string;
  /** The best moment (for "show in Sky"). */
  best: DeepSkySighting;
  extra: string[];
}

export interface PlanetsModel {
  rows: PlanetRow[];
  /** `Not up in the dark: Mercury, Venus.` */
  others: string | null;
}

/** The planet's rise and set that fall between sunset and sunrise. */
function planetEvents(core: NightCore, body: string): { rise: number | null; set: number | null } {
  const ev = bodyEvents(core, body);
  const { set: sunset, rise: sunrise } = sunsetSunrise(core);
  const span: Span = [sunset ?? core.q.n, sunrise ?? core.q.n + 1];
  return { rise: firstEvent(ev, 'rise', span)?.jd_utc ?? null, set: firstEvent(ev, 'set', span)?.jd_utc ?? null };
}

export function planetLine(core: NightCore, p: PlanetTonight, f: Fmt): string {
  const best = p.best!;
  const ev = planetEvents(core, p.body);
  const parts = [p.body, directionWords(best.direction, best.az_deg)];
  const times: { jd: number; text: string }[] = [];
  if (ev.rise !== null) times.push({ jd: ev.rise, text: `rises ${clock(ev.rise, f)}` });
  times.push({ jd: best.jd_utc, text: `highest ${clock(best.jd_utc, f)} at ${degrees(best.alt_deg)}` });
  if (ev.set !== null) times.push({ jd: ev.set, text: `sets ${clock(ev.set, f)}` });
  times.sort((a, b) => a.jd - b.jd);
  parts.push(...times.map((t) => t.text));
  if (p.magnitude !== null) parts.push(magnitudeText(p.magnitude));
  return parts.join(', ');
}

const GALILEAN_WORDS: Record<GalileanPhenomenon['kind'], [string, string]> = {
  transit: ['crosses Jupiter’s disc', 'crossing the disc'],
  shadow_transit: ['’s shadow crosses Jupiter', 'shadow on the disc'],
  occultation: ['is hidden behind Jupiter', 'behind the planet'],
  eclipse: ['is in Jupiter’s shadow', 'in eclipse'],
};

/** Jupiter's moons' events while Jupiter is up in the dark, in words. */
export function galileanLines(core: NightCore, detail: NightDetail | null, f: Fmt): string[] {
  const jupiter = core.tonight?.planets.find((p) => p.body === 'Jupiter');
  if (!detail?.galilean || !jupiter?.up_from || !jupiter.up_until) return [];
  const span: Span = [jupiter.up_from.jd_utc, jupiter.up_until.jd_utc];
  const out: string[] = [];
  for (const e of detail.galilean.phenomena) {
    const seen = intersect([e.start.jd_utc, e.end.jd_utc], span);
    if (!seen) continue;
    const [verb] = GALILEAN_WORDS[e.kind];
    const who = e.kind === 'shadow_transit' ? `${e.moon}${verb}` : `${e.moon} ${verb}`;
    const start = e.start.observable ? clock(e.start.jd_utc, f) : `(${clock(e.start.jd_utc, f)}, unseen)`;
    const end = e.end.observable ? clock(e.end.jd_utc, f) : `(${clock(e.end.jd_utc, f)}, unseen)`;
    out.push(`${who} ${start}–${end}`);
  }
  return out;
}

export function ringsLine(rings: SaturnRings | null): string | null {
  if (!rings) return null;
  const b = rings.earth_latitude_deg;
  const face = b >= 0 ? 'north' : 'south';
  const tilt = `${Math.abs(b).toFixed(1)}°`;
  const how = Math.abs(b) < 2 ? `nearly edge-on (${tilt}): a thin line or none` : Math.abs(b) < 8 ? `open ${tilt}, a narrow ellipse` : `open ${tilt}`;
  const lit = rings.lit_face_visible ? '' : '; we see their unlit side, so they look faint';
  return `Saturn’s rings: ${how}, the ${face} face toward us${lit}.`;
}

export function planetsModel(core: NightCore, detail: NightDetail | null, f: Fmt): PlanetsModel | null {
  if (!core.tonight) return null;
  const rows: PlanetRow[] = visiblePlanets(core).map((p) => {
    const extra: string[] = [];
    if (p.body === 'Jupiter') {
      const lines = galileanLines(core, detail, f);
      if (lines.length) extra.push(`Jupiter’s moons: ${lines.join('; ')}.`);
    }
    if (p.body === 'Saturn') {
      const r = ringsLine(detail?.rings ?? null);
      if (r) extra.push(r);
    }
    return { body: p.body, line: planetLine(core, p, f), best: p.best!, extra };
  });
  const hidden = core.tonight.planets.filter((p) => !(p.best !== null && p.hours_up > 0)).map((p) => p.body);
  return { rows, others: hidden.length ? `Not up in the dark tonight: ${listWords(hidden)}.` : null };
}

// -------------------------------------------------------------------------------------
// Deep sky
// -------------------------------------------------------------------------------------

export interface DsoRow {
  id: string;
  title: string;
  /** `spiral galaxy in Andromeda · magnitude 3.4`. */
  what: string;
  /** `Best 22:40, 71° up in the east · 6.2 h above 20° · binoculars`. */
  when: string;
  description: string | null;
  moon: string | null;
  best: DeepSkySighting;
  ra_j2000_deg: number | null;
  dec_j2000_deg: number | null;
}

export function dsoRows(core: NightCore, catalog: readonly Dso[] | null, constellations: ReadonlyMap<string, string>, f: Fmt): DsoRow[] {
  const byId = new Map((catalog ?? []).map((d) => [d.id, d]));
  return (core.tonight?.deep_sky ?? []).map((d) => {
    const c = byId.get(d.id) ?? null;
    const place = constellations.get(d.constellation) ?? d.constellation;
    const mag = d.magnitude === null ? '' : ` · magnitude ${formatMagnitude(d.magnitude)}`;
    const moon =
      d.moon && d.moon.brightening_mag >= 0.3
        ? `The Moon (${degrees(d.moon.separation_deg)} away) brightens the sky around it by ${d.moon.brightening_mag.toFixed(1)} magnitudes.`
        : null;
    return {
      id: d.id,
      title: d.name ? `${d.label} · ${d.name}` : d.label,
      what: `${cap(dsoTypeWords(d.type))} in ${place}${mag}`,
      when: `Best ${clock(d.best.jd_utc, f)}, ${degrees(d.best.alt_deg)} up in the ${directionWords(d.best.direction, d.best.az_deg)} · ${hoursText(d.hours_above_20)} above 20° in darkness · ${instrumentWords(d.instrument)}`,
      description: c?.description ?? null,
      moon,
      best: d.best,
      ra_j2000_deg: c?.ra_j2000_deg ?? null,
      dec_j2000_deg: c?.dec_j2000_deg ?? null,
    };
  });
}

// -------------------------------------------------------------------------------------
// Meteor showers
// -------------------------------------------------------------------------------------

export interface ShowerRow {
  code: string;
  name: string;
  /** `About 12 an hour under this sky (ZHR 20)`. */
  rate: string;
  /** `Best 04:30, the radiant 58° up in the south-east · 2 days before the peak`. */
  when: string;
  moon: string;
  reason: string;
  best: DeepSkySighting | null;
}

export function showerRows(core: NightCore, f: Fmt): ShowerRow[] {
  const up = moonUp(core);
  const k = core.tonight?.night.moon.illuminated_fraction ?? 0;
  return (core.tonight?.showers ?? []).map((s) => {
    const rate = s.expected_rate_per_hour;
    const rateText = `${rate < 1 ? 'Under one' : `About ${Math.round(rate)}`} an hour under this sky (ZHR ${Math.round(s.zhr)}${s.variable ? ', variable' : ''})`;
    const peak = atPeak(s) ? 'at the peak' : `${Math.abs(Math.round(s.days_from_peak)) || 1} ${Math.abs(Math.round(s.days_from_peak)) === 1 ? 'day' : 'days'} ${s.days_from_peak < 0 ? 'before' : 'after'} the peak`;
    const when = s.best
      ? `Best ${clock(s.best.jd_utc, f)}, the radiant ${degrees(s.best.alt_deg)} up in the ${directionWords(s.best.direction, s.best.az_deg)} · ${peak}`
      : `The radiant stays low tonight · ${peak}`;
    let moon: string;
    if (k < 0.03) moon = 'No Moon to spoil it.';
    else if (!s.best) moon = `The Moon is ${percentLit(k)} lit.`;
    else {
      const upThen = up.some((sp) => s.best!.jd_utc >= sp[0] && s.best!.jd_utc <= sp[1]);
      moon = upThen
        ? `The Moon (${percentLit(k)} lit) is up at the best time: ${k > 0.5 ? 'only the brighter meteors will show' : 'it costs the faintest meteors'}.`
        : `The Moon (${percentLit(k)} lit) is down at the best time.`;
    }
    return { code: s.code, name: s.name, rate: rateText, when, moon, reason: s.reason, best: s.best };
  });
}

// -------------------------------------------------------------------------------------
// The Milky Way
// -------------------------------------------------------------------------------------

export interface MilkyWayModel {
  /** The first sentence: whether the core is up in the dark, and when. */
  headline: string;
  lines: string[];
  /** The best moment, or null. */
  best: { jd: number; alt: number; az: number } | null;
}

export function milkyWayModel(core: NightCore, f: Fmt): MilkyWayModel | null {
  const g = core.galactic;
  if (g) {
    const ws = g.windows;
    if (!ws.length) {
      const c = core.tonight?.milky_way_core;
      const low = c?.best ? ` At best it is ${degrees(c.best.alt_deg)} up in the ${directionWords(c.best.direction, c.best.az_deg)}.` : '';
      return {
        headline: `The Milky Way’s core is not ${g.min_altitude_deg}° up while the sky is fully dark tonight.${low}`,
        lines: ['The arch of the Milky Way can still cross the sky, fainter, away from the core.'],
        best: null,
      };
    }
    const total = ws.reduce((sum, w) => sum + (w.jd_end - w.jd_start), 0);
    const best = ws.reduce((a, w) => (w.best.alt_deg > a.best.alt_deg ? w : a), ws[0]!);
    const spans = ws.map((w: GalacticWindow) => `${clockRange(w.jd_start, w.jd_end, f)}${w.moon_up ? ` with the Moon up (${percentLit(w.moon_illuminated_fraction)} lit)` : ', Moon down'}`);
    const [e1, e2] = best.best.arch_ends_az_deg;
    return {
      headline: `The core is up in the dark ${spans.join('; ')} (${duration(total)} in all).`,
      lines: [
        `Best at ${clock(best.best.jd_utc, f)}: the core ${degrees(best.best.alt_apparent_deg)} up in the ${directionWords(compass16(best.best.az_deg), best.best.az_deg)}.`,
        `The arch then rises from the ${directionWords(compass16(e1), e1)} horizon to ${degrees(best.best.arch_top_alt_deg)} up in the ${directionWords(compass16(best.best.arch_top_az_deg), best.best.arch_top_az_deg)} and comes down in the ${directionWords(compass16(e2), e2)}.`,
      ],
      best: { jd: best.best.jd_utc, alt: best.best.alt_apparent_deg, az: best.best.az_deg },
    };
  }
  const c = core.tonight?.milky_way_core;
  if (!c) return null;
  return {
    headline: `${c.reason}.`,
    lines: [],
    best: c.best ? { jd: c.best.jd_utc, alt: c.best.alt_deg, az: c.best.az_deg } : null,
  };
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function compass16(az: number): string {
  return POINTS[Math.round((((az % 360) + 360) % 360) / 22.5) % 16]!;
}

// -------------------------------------------------------------------------------------
// Photography
// -------------------------------------------------------------------------------------

export interface LightRow {
  kind: SunLightWindow['kind'];
  period: 'evening' | 'morning' | 'other';
  /** `Golden hour`. */
  label: string;
  /** `18:05–18:49`. */
  range: string;
  jd: number;
  minutes: number;
}

export function lightRows(core: NightCore, f: Fmt): LightRow[] | null {
  const h = core.sunHours;
  if (!h) return null;
  return h.windows.map((w) => ({
    kind: w.kind,
    period: w.period === 'evening' ? 'evening' : w.period === 'morning' ? 'morning' : 'other',
    label: w.kind === 'golden' ? 'Golden hour' : 'Blue hour',
    range: `${w.open_start ? '…' : ''}${clock(w.jd_start, f)}–${clock(w.jd_end, f)}${w.open_end ? '…' : ''}`,
    jd: w.jd_start,
    minutes: w.duration_min,
  }));
}
