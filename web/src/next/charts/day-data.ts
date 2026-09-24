/**
 * Data for the day chart: every body's apparent altitude through the observer's local day,
 * the sky phases behind it, the rise / transit / set markers and the best star-sight
 * windows. OWNER: charts agent.
 *
 * Every number comes from the engine (EXPLORER_PLAN 3.1): `sample_bodies` at 5-minute
 * steps for the curves, `day_events` for the phases and events. This module only decides
 * which window to ask for and shapes the answers for drawing.
 */

import type {
  BodyError,
  BodyEvents,
  BodyKind,
  EventOptions,
  ExplorerEngine,
  Observer,
  PhaseSegment,
  SkyEvent,
  SkyPhase,
} from '../engine/types.js';
import type { Zone } from '../time.js';
import type { LocalDay } from './windows.js';

/** Sample spacing for the altitude curves (the task's 5 minutes; 289 samples a day). */
export const DAY_STEP_MINUTES = 5;

export interface DayInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly day: LocalDay;
  /** Canonical names, in drawing order (later ones on top). */
  readonly bodies: readonly string[];
  readonly options: EventOptions;
}

export interface DaySeries {
  readonly body: string;
  readonly kind: BodyKind;
  /** `alt_apparent_deg`: what the eye sees (display refraction included). */
  readonly alt: Float64Array;
  readonly az: Float64Array;
  /** Index of the highest sample, and its altitude. */
  readonly peakIndex: number;
  readonly peakAlt: number;
  /** Some sample is above the horizon. */
  readonly everUp: boolean;
}

export type MarkerKind = 'rise' | 'transit' | 'set';

export interface DayMarker {
  readonly body: string;
  readonly kind: MarkerKind;
  /** The engine's event (time, geometric altitude and azimuth of the centre). */
  readonly event: SkyEvent;
}

export type StarSightWhen = 'morning' | 'evening' | 'night' | 'midday';

/** A stretch of nautical twilight: horizon still sharp, brighter stars already out. */
export interface StarSightWindow {
  readonly jd_start: number;
  readonly jd_end: number;
  readonly when: StarSightWhen;
  /** The window cuts it: it began before local midnight, or runs on past the next one. */
  readonly clippedStart: boolean;
  readonly clippedEnd: boolean;
}

export interface DayData {
  readonly input: DayInput;
  /** Sample instants, `jd_utc`. */
  readonly times: Float64Array;
  readonly series: readonly DaySeries[];
  readonly phases: readonly PhaseSegment[];
  readonly markers: readonly DayMarker[];
  readonly events: ReadonlyMap<string, BodyEvents>;
  readonly starSights: readonly StarSightWindow[];
  readonly errors: readonly BodyError[];
  /** Milliseconds spent: engine calls, and everything. */
  readonly timing: { readonly engineMs: number; readonly totalMs: number };
}

const PHASE_RANK: Record<SkyPhase, number> = { night: 0, astronomical: 1, nautical: 2, civil: 3, day: 4 };

export function phaseRank(phase: SkyPhase): number {
  return PHASE_RANK[phase];
}

/**
 * The nautical-twilight stretches of a day, from the engine's phases, each labelled by what
 * the sky does around it: brightening into civil twilight is a morning, darkening into
 * astronomical twilight an evening. Where the Sun dips into nautical twilight and climbs
 * back out without the sky getting darker (a summer night far north), it is `night`; where
 * it climbs into it and sinks back (a polar winter's noon), `midday`.
 */
export function starSightWindows(phases: readonly PhaseSegment[], jdStart: number, jdEnd: number): StarSightWindow[] {
  const out: StarSightWindow[] = [];
  phases.forEach((seg, i) => {
    if (seg.phase !== 'nautical') return;
    const prev = phases[i - 1];
    const next = phases[i + 1];
    const before = prev ? PHASE_RANK[prev.phase] : null;
    const after = next ? PHASE_RANK[next.phase] : null;
    let when: StarSightWhen;
    if (before !== null && after !== null) {
      if (before < 2 && after > 2) when = 'morning';
      else if (before > 2 && after < 2) when = 'evening';
      else if (before > 2) when = 'night';
      else when = 'midday';
    } else if (after !== null) {
      when = after > 2 ? 'morning' : 'evening';
    } else if (before !== null) {
      when = before < 2 ? 'morning' : 'evening';
    } else {
      when = 'night';
    }
    out.push({
      jd_start: seg.jd_start,
      jd_end: seg.jd_end,
      when,
      clippedStart: seg.jd_start <= jdStart,
      clippedEnd: seg.jd_end >= jdEnd,
    });
  });
  return out;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Ask the engine for one local day and shape the answer. Engine faults (malformed input)
 * propagate; bodies the engine cannot compute are listed in `errors` and left out.
 */
export function computeDay(engine: ExplorerEngine, input: DayInput): DayData {
  const t0 = now();
  const { observer, day, options } = input;
  const bodies = [...input.bodies];
  const kinds = new Map(engine.bodies().map((b) => [b.body, b.kind] as const));

  const e0 = now();
  const sampled = engine.sampleBodies(observer, bodies, day.jd_start, day.jd_end, DAY_STEP_MINUTES);
  const events = engine.dayEvents(observer, day.jd_start, day.jd_end, bodies, options);
  const engineMs = now() - e0;

  const series: DaySeries[] = [];
  for (const name of bodies) {
    const track = sampled.bodies.find((b) => b.body === name);
    if (!track) continue;
    const alt = track.alt_apparent_deg;
    let peakIndex = 0;
    let peakAlt = -Infinity;
    let everUp = false;
    for (let i = 0; i < alt.length; i += 1) {
      const a = alt[i]!;
      if (a > peakAlt) {
        peakAlt = a;
        peakIndex = i;
      }
      if (a > 0) everUp = true;
    }
    series.push({ body: name, kind: kinds.get(name) ?? 'star', alt, az: track.az_deg, peakIndex, peakAlt, everUp });
  }

  const byBody = new Map<string, BodyEvents>();
  const markers: DayMarker[] = [];
  for (const be of events.bodies) {
    byBody.set(be.body, be);
    for (const event of be.events) {
      if (event.kind === 'rise' || event.kind === 'set' || event.kind === 'transit') {
        markers.push({ body: be.body, kind: event.kind, event });
      }
    }
  }

  const errors: BodyError[] = [...sampled.errors];
  for (const e of events.errors) if (!errors.some((x) => x.body === e.body)) errors.push(e);

  return {
    input,
    times: sampled.jd_utc,
    series,
    phases: events.phases,
    markers,
    events: byBody,
    starSights: starSightWindows(events.phases, day.jd_start, day.jd_end),
    errors,
    timing: { engineMs, totalMs: now() - t0 },
  };
}

/** Index of the sample nearest to `jd` (samples are evenly spaced from the day's start). */
export function nearestSample(times: Float64Array, jd: number): number {
  if (times.length < 2) return 0;
  const step = times[1]! - times[0]!;
  const i = Math.round((jd - times[0]!) / step);
  return Math.min(times.length - 1, Math.max(0, i));
}

/**
 * The drawn curve's height at `jd`: linear between the two samples either side, exactly as
 * the polyline is drawn. Used only to sit a marker on its line; readouts ask the engine.
 */
export function curveAt(times: Float64Array, values: Float64Array, jd: number): number {
  const n = times.length;
  if (n === 0) return Number.NaN;
  if (n === 1 || jd <= times[0]!) return values[0]!;
  if (jd >= times[n - 1]!) return values[n - 1]!;
  const step = times[1]! - times[0]!;
  const i = Math.min(n - 2, Math.floor((jd - times[0]!) / step));
  const f = (jd - times[i]!) / (times[i + 1]! - times[i]!);
  return values[i]! + f * (values[i + 1]! - values[i]!);
}
