/**
 * Which night the Tonight view shows, and the stretches of it the view draws. Pure
 * functions over engine results; no DOM. OWNER: tonight agent (expansion programme Q2).
 *
 * The night. A night runs from one local mean noon (12:00 at the observer's longitude) to
 * the next, as the deep-sky engine's `NightSummary` does (CONVENTIONS 13.6). Which night a
 * moment belongs to (the brief's rule):
 *
 *   - from local mean noon to local mean midnight: the night starting at that noon (the
 *     coming one in the afternoon, the current one after sunset);
 *   - after local mean midnight: still that night while it is dark, and the coming one once
 *     its darkness is over — at astronomical dawn (the Sun back above −18°), or, where the Sun
 *     never gets that low, when the darkest stretch ends; with no darkness at all (the Sun
 *     never 6° down) at sunrise; with no sunrise either (midsummer inside the Arctic circle)
 *     at local mean midnight; in the polar night, at local mean noon.
 *
 * The engine's own rule switches at sunrise instead of astronomical dawn, so the view never
 * lets the engine choose: it works out the night itself and asks `tonight` for an instant
 * a minute after that night's first local mean noon, which the engine puts in the same
 * night (docs/EXPLORER_GUIDE.md, "Tonight", states the rule).
 */

import type { BodyEvents, PhaseSegment, SkyEvent, SkyPhase } from '../engine/types.js';

/** A minute, in days. */
export const MINUTE = 1 / 1440;

/** Local mean noon (12:00 at the longitude) at or before `jd`: the engine's formula. */
export function localNoonBefore(lonDeg: number, jd: number): number {
  const shift = lonDeg / 360;
  return Math.floor(jd + shift) - shift;
}

/** The instant the view asks `tonight` (and the other per-night calls) for: inside the night, never ambiguous. */
export function nightProbe(nightStart: number): number {
  return nightStart + MINUTE;
}

export type DarkKind = 'night' | 'astronomical_twilight' | 'nautical_twilight';

export interface DarkRun {
  kind: DarkKind;
  start: number;
  end: number;
}

const TIERS: readonly [DarkKind, readonly SkyPhase[]][] = [
  ['night', ['night']],
  ['astronomical_twilight', ['night', 'astronomical']],
  ['nautical_twilight', ['night', 'astronomical', 'nautical']],
];

/**
 * The night's darkness as the engine defines it (`NightSummary.darkness`): the longest run
 * of consecutive sky phases at least this dark, trying full night first, then astronomical
 * and then nautical twilight; null when the Sun never goes 6° down.
 */
export function darkRun(phases: readonly PhaseSegment[]): DarkRun | null {
  for (const [kind, ok] of TIERS) {
    let best: [number, number] | null = null;
    let run: [number, number] | null = null;
    for (const p of phases) {
      run = ok.includes(p.phase) ? (run ? [run[0], p.jd_end] : [p.jd_start, p.jd_end]) : null;
      if (run && (!best || run[1] - run[0] > best[1] - best[0])) best = run;
    }
    if (best) return { kind, start: best[0], end: best[1] };
  }
  return null;
}

/** The Sun's events and the sky phases over one night window (noon to noon). */
export interface SunWindow {
  phases: readonly PhaseSegment[];
  sun: Pick<BodyEvents, 'events' | 'always_above' | 'always_below'> | null;
}

/**
 * When the night starting at `n0` gives way to the next one, on the view's rule: the end of
 * its darkness when it has some darkness after local mean midnight, else sunrise, else local
 * mean midnight (the Sun up all night), else the next noon (polar night).
 */
export function nightSwitch(n0: number, day: SunWindow): number {
  const midnight = n0 + 0.5;
  const dark = darkRun(day.phases);
  if (dark && dark.end > midnight) return Math.min(dark.end, n0 + 1);
  const rise = day.sun?.events.find((e) => e.kind === 'rise' && e.jd_utc > midnight);
  if (rise) return rise.jd_utc;
  if (day.sun?.always_above) return midnight;
  if (dark) return midnight; // the darkness ended before midnight: nothing more to wait for
  return n0 + 1;
}

/** The local mean noon starting the night that `jd` belongs to (the rule above). */
export function nightStartFor(jd: number, lonDeg: number, sunWindow: (n0: number) => SunWindow): number {
  const n0 = localNoonBefore(lonDeg, jd);
  if (jd - n0 < 0.5) return n0;
  return jd >= nightSwitch(n0, sunWindow(n0)) ? n0 + 1 : n0;
}

// -------------------------------------------------------------------------------------
// Stretches of time
// -------------------------------------------------------------------------------------

export type Span = readonly [number, number];

/** Where `a` and `b` overlap, or null. */
export function intersect(a: Span, b: Span): Span | null {
  const s = Math.max(a[0], b[0]);
  const e = Math.min(a[1], b[1]);
  return e > s ? [s, e] : null;
}

/** `span` less every one of `cuts` (sorted or not); the pieces in time order. */
export function subtract(span: Span, cuts: readonly Span[]): Span[] {
  let pieces: Span[] = [span];
  for (const c of cuts) {
    const next: Span[] = [];
    for (const p of pieces) {
      if (c[1] <= p[0] || c[0] >= p[1]) {
        next.push(p);
        continue;
      }
      if (c[0] > p[0]) next.push([p[0], c[0]]);
      if (c[1] < p[1]) next.push([c[1], p[1]]);
    }
    pieces = next;
  }
  return pieces.sort((a, b) => a[0] - b[0]);
}

/** Total length of some spans, days. */
export function spanDays(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + (s[1] - s[0]), 0);
}

/**
 * When a body is above the horizon inside `window`, from its rise and set events over that
 * window (`day_events`, CONVENTIONS 13.3): up before a first set, after a last rise, all the
 * window when `always_above`.
 */
export function upSpans(window: Span, body: Pick<BodyEvents, 'events' | 'always_above' | 'always_below'> | null): Span[] {
  if (!body) return [];
  const edges = body.events.filter((e): e is SkyEvent => (e.kind === 'rise' || e.kind === 'set') && e.jd_utc >= window[0] && e.jd_utc <= window[1]);
  if (edges.length === 0) return body.always_above ? [[window[0], window[1]]] : [];
  const out: Span[] = [];
  let from: number | null = edges[0]!.kind === 'set' ? window[0] : null;
  for (const e of edges) {
    if (e.kind === 'rise') from ??= e.jd_utc;
    else if (from !== null) {
      if (e.jd_utc > from) out.push([from, e.jd_utc]);
      from = null;
    }
  }
  if (from !== null && window[1] > from) out.push([from, window[1]]);
  return out;
}

/** The first event of a kind inside `span`, or null. */
export function firstEvent(body: Pick<BodyEvents, 'events'> | null, kind: SkyEvent['kind'], span: Span): SkyEvent | null {
  return body?.events.find((e) => e.kind === kind && e.jd_utc >= span[0] && e.jd_utc <= span[1]) ?? null;
}
