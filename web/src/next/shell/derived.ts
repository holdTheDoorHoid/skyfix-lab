/**
 * Engine results the chrome shares, asked the same way by every section so the memoised
 * engine answers each question once per frame (`memoEngine`, component.ts). Failures
 * become one keyed notice instead of an exception. OWNER: shell-design agent.
 */

import type { Ctx } from '../component.js';
import type { BodyEvents, BodyState, DayEvents, ExplorerEngine, PhaseSegment, SkyState } from '../engine/types.js';
import { currentDayWindow, engineObserver, eventOptions, type ExplorerState } from '../state.js';
import { jdFromIso } from '../time.js';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ranges = new WeakMap<ExplorerEngine, readonly [number, number] | null>();

/** The span of time the engine covers (explorer_coverage), or null if it does not say. */
export function coverageSpan(ctx: Pick<Ctx, 'engine'>): readonly [number, number] | null {
  if (!ranges.has(ctx.engine)) {
    try {
      const c = ctx.engine.coverage();
      const a = jdFromIso(c.start_utc);
      const b = jdFromIso(c.end_utc);
      ranges.set(ctx.engine, a !== null && b !== null ? [a, b] : null);
    } catch {
      ranges.set(ctx.engine, null);
    }
  }
  return ranges.get(ctx.engine) ?? null;
}

/** True when the engine can compute at `jd`. Outside, the shell asks nothing and says why once. */
export function covered(ctx: Pick<Ctx, 'engine'>, jd: number): boolean {
  const span = coverageSpan(ctx);
  return !span || (jd >= span[0] && jd <= span[1]);
}

/** A window cut to the engine's coverage, or null when nothing of it is covered. */
function clampToCoverage(ctx: Pick<Ctx, 'engine'>, a: number, b: number): [number, number] | null {
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

/** Every body now (Sun, Moon, planets, the 58 stars): about a millisecond. */
export function skyNow(ctx: Ctx, s: ExplorerState): SkyState | null {
  if (!covered(ctx, s.time.jd_utc)) return null;
  return attempt(ctx, 'engine-sky', 'Computing the sky', () => ctx.engine.skyState(engineObserver(s), s.time.jd_utc, 'all'));
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
  const window = currentDayWindow(s);
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
  const [a, b] = currentDayWindow(s);
  if (!covered(ctx, s.time.jd_utc)) return null;
  const span = clampToCoverage(ctx, a - 1, b + 1);
  if (!span) return null;
  return attempt(ctx, `engine-around-${body}`, `Computing rise and set for ${body}`, () =>
    ctx.engine.dayEvents(engineObserver(s), span[0], span[1], [body], eventOptions(s)),
  );
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
