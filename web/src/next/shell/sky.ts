/**
 * What the chrome says about the sky, derived from engine results: the sky phase now and
 * what comes next, the current passage of a body (its rise, highest point and set around
 * now), and the Sun's twilight times for the day. OWNER: shell-design agent.
 *
 * Pure functions over `day_events` output (EXPLORER_API). Nothing here computes astronomy:
 * every instant comes from the engine; these only pick among them.
 */

import type { PhaseSegment, SkyEvent, SkyPhase } from '../engine/types.js';

/** Night is darkest (0), day brightest (4). */
export const PHASE_RANK: Record<SkyPhase, number> = { night: 0, astronomical: 1, nautical: 2, civil: 3, day: 4 };

export const PHASE_LABEL: Record<SkyPhase, string> = {
  day: 'Daylight',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
};

/** One sentence per phase, in plain words, with what it means for a navigator. */
export const PHASE_MEANING: Record<SkyPhase, string> = {
  day: 'The Sun is up.',
  civil: 'Bright twilight: the horizon is sharp and the brightest planets and stars appear.',
  nautical: 'Horizon and stars both visible: the time for star sights.',
  astronomical: 'Too dark to see the horizon, and the sky is not yet fully dark.',
  night: 'Full darkness: the stars are bright but the horizon cannot be seen.',
};

/** The segment containing `jd` (segments are half-open, `[jd_start, jd_end)`). */
export function segmentAt(phases: readonly PhaseSegment[], jd: number): PhaseSegment | null {
  for (const p of phases) if (jd >= p.jd_start && jd < p.jd_end) return p;
  const last = phases[phases.length - 1];
  return last && jd === last.jd_end ? last : null;
}

/** Segments clipped to `[a, b)`, neighbours with the same phase joined. */
export function clipPhases(phases: readonly PhaseSegment[], a: number, b: number): PhaseSegment[] {
  const out: PhaseSegment[] = [];
  for (const p of phases) {
    const s = Math.max(a, p.jd_start);
    const e = Math.min(b, p.jd_end);
    if (e <= s) continue;
    const prev = out[out.length - 1];
    if (prev && prev.phase === p.phase && Math.abs(prev.jd_end - s) < 1e-9) prev.jd_end = e;
    else out.push({ jd_start: s, jd_end: e, phase: p.phase });
  }
  return out;
}

/** True when the sky is getting brighter at `jd` (dawn side), false when darker, null when unknown. */
export function brightening(phases: readonly PhaseSegment[], jd: number): boolean | null {
  const i = phases.findIndex((p) => jd >= p.jd_start && jd < p.jd_end);
  if (i < 0) return null;
  const cur = PHASE_RANK[phases[i]!.phase];
  const next = phases[i + 1];
  if (next) return PHASE_RANK[next.phase] > cur;
  const prev = phases[i - 1];
  return prev ? PHASE_RANK[prev.phase] < cur : null;
}

/** The current or next run of `phase` that has not ended at `jd`. */
export function nextRun(phases: readonly PhaseSegment[], jd: number, phase: SkyPhase): PhaseSegment | null {
  for (const p of phases) if (p.phase === phase && p.jd_end > jd) return p;
  return null;
}

export interface SkyFacts {
  phase: SkyPhase;
  /** When the current phase ends (null when not within the phases given). */
  endsAt: number | null;
  /** True on the dawn side, false on the dusk side, null when it cannot be told. */
  brightening: boolean | null;
  /** The current or next nautical twilight (star sights), or null if none in the phases given. */
  nautical: PhaseSegment | null;
  /** The next time the Sun is up (day), for "Sunrise at …". */
  nextDay: PhaseSegment | null;
}

/** The facts the "Now" section words: the phase, where it is going, and the next star sights. */
export function skyFacts(phases: readonly PhaseSegment[], jd: number, fallback: SkyPhase): SkyFacts {
  const seg = segmentAt(phases, jd);
  return {
    phase: seg?.phase ?? fallback,
    endsAt: seg?.jd_end ?? null,
    brightening: brightening(phases, jd),
    nautical: nextRun(phases, jd, 'nautical'),
    nextDay: nextRun(phases, jd, 'day'),
  };
}

export type PassageKind = 'up' | 'down' | 'always-up' | 'always-down';

/** A body's passage around now: the rise, highest point and set that bracket it. */
export interface Passage {
  kind: PassageKind;
  rise: SkyEvent | null;
  transit: SkyEvent | null;
  set: SkyEvent | null;
}

function nearest(events: readonly SkyEvent[], jd: number): SkyEvent | null {
  let best: SkyEvent | null = null;
  for (const e of events) if (!best || Math.abs(e.jd_utc - jd) < Math.abs(best.jd_utc - jd)) best = e;
  return best;
}

/**
 * Pick the passage around `jd` from a body's events over several days (sorted by time).
 * While the body is up: the rise before now, the set after it, and the upper transit
 * between them. While it is down: the next rise, the set after that, and the transit
 * between. With no rise and no set it stays up (or down) all through the events given.
 */
export function passageAround(events: readonly SkyEvent[], jd: number, up: boolean): Passage {
  const rises = events.filter((e) => e.kind === 'rise');
  const sets = events.filter((e) => e.kind === 'set');
  const transits = events.filter((e) => e.kind === 'transit');
  if (up) {
    const rise = [...rises].reverse().find((e) => e.jd_utc <= jd) ?? null;
    const set = sets.find((e) => e.jd_utc >= jd) ?? null;
    const lo = rise?.jd_utc ?? Number.NEGATIVE_INFINITY;
    const hi = set?.jd_utc ?? Number.POSITIVE_INFINITY;
    const inside = transits.filter((t) => t.jd_utc >= lo && t.jd_utc <= hi);
    return { kind: rise || set ? 'up' : 'always-up', rise, set, transit: nearest(inside.length ? inside : transits, jd) };
  }
  const rise = rises.find((e) => e.jd_utc >= jd) ?? null;
  const set = rise ? (sets.find((e) => e.jd_utc >= rise.jd_utc) ?? null) : null;
  const lo = rise?.jd_utc ?? jd;
  const hi = set?.jd_utc ?? Number.POSITIVE_INFINITY;
  const inside = transits.filter((t) => t.jd_utc >= lo && t.jd_utc <= hi);
  return { kind: rise ? 'down' : 'always-down', rise, set, transit: inside[0] ?? nearest(transits, jd) };
}

export interface SunDay {
  rise: SkyEvent | null;
  transit: SkyEvent | null;
  set: SkyEvent | null;
  civil: [SkyEvent | null, SkyEvent | null];
  nautical: [SkyEvent | null, SkyEvent | null];
  astronomical: [SkyEvent | null, SkyEvent | null];
}

/** The Sun's events inside one local day (the first of each kind). */
export function sunDay(events: readonly SkyEvent[], a: number, b: number): SunDay {
  const first = (kind: string): SkyEvent | null => events.find((e) => e.kind === kind && e.jd_utc >= a && e.jd_utc < b) ?? null;
  return {
    rise: first('rise'),
    transit: first('transit'),
    set: first('set'),
    civil: [first('civil_dawn'), first('civil_dusk')],
    nautical: [first('nautical_dawn'), first('nautical_dusk')],
    astronomical: [first('astronomical_dawn'), first('astronomical_dusk')],
  };
}

/** Hours in the given phases (e.g. the day's daylight from its `day` segments). */
export function hoursIn(phases: readonly PhaseSegment[], phase: SkyPhase): number {
  return phases.reduce((sum, p) => (p.phase === phase ? sum + (p.jd_end - p.jd_start) * 24 : sum), 0);
}
