/**
 * Engine results the chrome shares, asked the same way by every section so the memoised
 * engine answers each question once per frame (`memoEngine`, component.ts). Failures
 * become one keyed notice instead of an exception. OWNER: shell-design agent; coverage
 * gating: time-ui agent (the tiers themselves are time/tier.ts `tierAt`: `covered` is true
 * in the validated and the labelled tier, where the engine answers).
 */

import type { Ctx } from '../component.js';
import type { BodyEvents, BodyState, DayEvents, ExplorerEngine, PhaseSegment, SkyEvent, SkyState } from '../engine/types.js';
import { currentDayWindow, displayZone, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { jdFromIso, type Zone } from '../time.js';
import { isUp, passageNow, type Passage } from './sky.js';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Spans worked out, by the coverage report they came from: the memoised engine returns the
 * same report until a data pack widens it (`memoEngine(...).invalidate()`), and a new
 * report is worked out again (packs agent, 2026-09-24).
 */
const ranges = new WeakMap<object, readonly [number, number] | null>();

/** The span of time the engine covers (explorer_coverage), or null if it does not say. */
export function coverageSpan(ctx: Pick<Ctx, 'engine'>): readonly [number, number] | null {
  let c: ReturnType<ExplorerEngine['coverage']>;
  try {
    c = ctx.engine.coverage();
  } catch {
    return null;
  }
  if (!ranges.has(c)) {
    const a = jdFromIso(c.start_utc);
    const b = jdFromIso(c.end_utc);
    ranges.set(c, a !== null && b !== null ? [a, b] : null);
  }
  return ranges.get(c) ?? null;
}

/** True when the engine can compute at `jd`. Outside, the shell asks nothing and says why once. */
export function covered(ctx: Pick<Ctx, 'engine'>, jd: number): boolean {
  const span = coverageSpan(ctx);
  return !span || (jd >= span[0] && jd <= span[1]);
}

/** A window cut to the engine's coverage, or null when nothing of it is covered. */
export function clampToCoverage(ctx: Pick<Ctx, 'engine'>, a: number, b: number): [number, number] | null {
  const span = coverageSpan(ctx);
  if (!span) return [a, b];
  const s = Math.max(a, span[0]);
  const e = Math.min(b, span[1]);
  return e > s ? [s, e] : null;
}

/** Run an engine call; on failure show one keyed notice and return null. */
export function attempt<T>(ctx: Pick<Ctx, 'notices'>, key: string, what: string, fn: () => T): T | null {
  try {
    const value = fn();
    ctx.notices.dismissKey(key);
    return value;
  } catch (error) {
    ctx.notices.push('error', `${what} failed: ${errorText(error)}`, { key });
    return null;
  }
}

/**
 * Every body now (Sun, Moon, planets, the 58 stars). The costliest call the chrome makes
 * (several milliseconds), so only "In the sky now" and the body chooser use it, and the
 * former at most a few times a second while time runs.
 */
export function skyNow(ctx: Ctx, s: ExplorerState): SkyState | null {
  if (!covered(ctx, s.time.jd_utc)) return null;
  return attempt(ctx, 'engine-sky', 'Computing the sky', () => ctx.engine.skyState(engineObserver(s), s.time.jd_utc, 'all'));
}

/**
 * The selected body now, with the sky phase (every `sky_state` result carries it): about
 * a millisecond, cheap enough for every frame while time runs.
 */
export function skySelected(ctx: Ctx, s: ExplorerState): SkyState | null {
  if (!covered(ctx, s.time.jd_utc)) return null;
  const body = s.selection.body ?? 'Sun';
  return attempt(ctx, 'engine-sky', 'Computing the sky', () => ctx.engine.skyState(engineObserver(s), s.time.jd_utc, [body]));
}

let lastDay: { key: string; window: [number, number] } | null = null;

function zoneId(zone: Zone): string {
  return zone.kind === 'iana' ? zone.zone : `${zone.name}${zone.offsetMs}`;
}

/**
 * `currentDayWindow` (state.ts), remembered: the local day only changes when the time
 * crosses a midnight or the zone changes, and working it out goes through `Intl` several
 * times. Every section asks for it on every change of state.
 */
export function dayOf(s: ExplorerState): [number, number] {
  // The zone itself, resolved at the time shown: before 1850 a zone that follows the place
  // is local mean time (time.ts `resolveZone`), so the same choice can mean another clock.
  const key = `${s.settings.timeDisplay}|${JSON.stringify(s.observer.zone)}|${s.observer.lon_deg}|${zoneId(displayZone(s))}`;
  const jd = s.time.jd_utc;
  if (lastDay && lastDay.key === key && jd >= lastDay.window[0] && jd < lastDay.window[1]) return lastDay.window;
  const window = currentDayWindow(s);
  lastDay = { key, window };
  return window;
}

export function bodyIn(sky: SkyState | null, body: string | null): BodyState | null {
  if (!sky || !body) return null;
  return sky.bodies.find((b) => b.body === body) ?? null;
}

/** Why a body is missing from a result (outside the coverage window, not yet available). */
export function bodyError(sky: SkyState | null, body: string | null): string | null {
  if (!sky || !body) return null;
  return sky.errors.find((e) => e.body === body)?.message ?? null;
}

export interface Day {
  /** Local midnight to local midnight in the display zone. */
  window: [number, number];
  phases: PhaseSegment[];
  sun: BodyEvents | null;
}

/** The Sun over the local day being shown: its sky phases and events. */
export function sunToday(ctx: Ctx, s: ExplorerState): Day | null {
  const window = dayOf(s);
  const span = clampToCoverage(ctx, window[0], window[1]);
  if (!span) return null;
  const day = attempt(ctx, 'engine-day', 'Computing the day', () =>
    ctx.engine.dayEvents(engineObserver(s), span[0], span[1], ['Sun'], eventOptions(s)),
  );
  if (!day) return null;
  return { window, phases: day.phases, sun: day.bodies.find((b) => b.body === 'Sun') ?? null };
}

/**
 * A body's events from the day before to the day after the one shown (with the Sun's
 * phases over the same span): enough to find the passage around now and the next
 * twilight. Cached per day, so dragging within a day costs nothing.
 */
export function aroundToday(ctx: Ctx, s: ExplorerState, body: string): DayEvents | null {
  const [a, b] = dayOf(s);
  if (!covered(ctx, s.time.jd_utc)) return null;
  const span = clampToCoverage(ctx, a - 1, b + 1);
  if (!span) return null;
  return attempt(ctx, `engine-around-${body}`, `Computing rise and set for ${body}`, () =>
    ctx.engine.dayEvents(engineObserver(s), span[0], span[1], [body], eventOptions(s)),
  );
}

/** A body's pass around the time shown: what the panel's Selected cards and the map's dial draw. */
export interface PassNow {
  /** Rise, highest point and set of the pass the body is on (or the next, while it is down). */
  passage: Passage;
  /** Up at the time shown, by its own rise and set events. */
  up: boolean;
  /** Its events from the day before to the day after the one shown (`aroundToday`). */
  events: readonly SkyEvent[];
  /** False when the events could not be computed (outside the coverage, or an error). */
  known: boolean;
}

/**
 * The body's current pass, asked the same way by every part of the page so that none of
 * them can disagree about when the Moon sets: from `aroundToday` (memoised per day) and
 * `passageNow`. `aboveHorizon` (from `sky_state`) decides only when the events say nothing.
 */
export function passNow(ctx: Ctx, s: ExplorerState, body: string, aboveHorizon: boolean): PassNow {
  const around = aroundToday(ctx, s, body);
  const entry = around?.bodies.find((x) => x.body === body);
  const events = entry?.events ?? [];
  const jd = s.time.jd_utc;
  const up = isUp(events, jd, aboveHorizon);
  return { passage: passageNow(events, entry, jd, up), up, events, known: entry !== undefined };
}

/** Only write when the text changes (no needless layout work every frame). */
export function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}
