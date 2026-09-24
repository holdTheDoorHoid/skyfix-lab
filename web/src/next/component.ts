/**
 * The component contract for explorer views, a per-frame render scheduler, and a
 * memoising wrapper so several components share one engine result per frame.
 *
 * A component is a function that takes over a host element:
 *
 * ```ts
 * export const clock: Component = (host, ctx) => {
 *   const out = host.appendChild(document.createElement('output'));
 *   const stop = watch(ctx, (s) => s.time.jd_utc, (jd) => {
 *     out.textContent = formatWithUtc(jd, displayZone(ctx.store.get()));
 *   });
 *   return { destroy: () => { stop(); out.remove(); } };
 * };
 * ```
 *
 * Rules: draw only in the scheduler's frame (use `watch`); never mutate what the engine
 * returns (results are shared, and frozen in development); clean up everything in
 * `destroy`.
 */

import {
  isAlmanacEngine,
  isEclipseEngine,
  isPlanetEventsEngine,
  type AlmanacEngine,
  type BodySelection,
  type EclipseEngine,
  type EventOptions,
  type ExplorerEngine,
  type Observer,
  type PlanetEventsEngine,
} from './engine/types.js';
import type { Notices } from './notices.js';
import type { Equality, ExplorerState, ExplorerStore } from './state.js';

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface Ctx {
  readonly store: ExplorerStore;
  /** Memoised (see `memoEngine`): identical calls in one frame return the same object. */
  readonly engine: ExplorerEngine;
  readonly notices: Notices;
  readonly scheduler: FrameScheduler;
}

export interface Mounted {
  destroy(): void;
}

export type Component = (host: HTMLElement, ctx: Ctx) => Mounted;

/** Collects clean-up functions; `dispose` runs them once, newest first. */
export function disposer(): { add(fn: () => void): void; dispose(): void } {
  const fns: (() => void)[] = [];
  let done = false;
  return {
    add(fn) {
      if (done) fn();
      else fns.push(fn);
    },
    dispose() {
      if (done) return;
      done = true;
      while (fns.length) {
        const fn = fns.pop()!;
        try {
          fn();
        } catch (error) {
          console.error('clean-up failed', error);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Frame scheduler
// ---------------------------------------------------------------------------

export interface FrameScheduler {
  /**
   * Run `task` once in the next frame. Scheduling the same function again before it runs
   * does nothing, so any number of state changes in one frame cause one redraw.
   */
  schedule(task: () => void): void;
  cancel(task: () => void): void;
  /**
   * Call `hook(time)` at the start of every frame until the returned function is called.
   * Hooks run before render tasks, and tasks they schedule run in the same frame (the
   * playback clock relies on this so a time step is drawn without a frame of lag).
   */
  onFrame(hook: (time: number) => void): () => void;
  /** Run pending hooks and tasks now (tests; or before measuring synchronously). */
  flush(time?: number): void;
  destroy(): void;
}

export interface SchedulerOptions {
  requestFrame?: (callback: (time: number) => void) => number;
  cancelFrame?: (id: number) => void;
  onError?: (error: unknown) => void;
}

export function createScheduler(options: SchedulerOptions = {}): FrameScheduler {
  const raf =
    options.requestFrame ??
    (typeof globalThis.requestAnimationFrame === 'function'
      ? (cb: (t: number) => void) => globalThis.requestAnimationFrame(cb)
      : (cb: (t: number) => void) => Number(setTimeout(() => cb(Date.now()), 16)));
  const caf =
    options.cancelFrame ??
    (typeof globalThis.cancelAnimationFrame === 'function'
      ? (id: number) => globalThis.cancelAnimationFrame(id)
      : (id: number) => clearTimeout(id));
  const onError = options.onError ?? ((error: unknown) => console.error('frame task failed', error));

  const tasks = new Set<() => void>();
  const hooks = new Set<(time: number) => void>();
  /** The tasks of the frame being run; `cancel` removes from here too. */
  let running: Set<() => void> | null = null;
  let frameId = 0;
  let destroyed = false;

  function request(): void {
    if (!frameId && !destroyed && (tasks.size || hooks.size)) frameId = raf(frame);
  }

  function run(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      onError(error);
    }
  }

  function frame(time: number): void {
    frameId = 0;
    for (const hook of [...hooks]) if (hooks.has(hook)) run(() => hook(time));
    running = new Set(tasks);
    tasks.clear();
    // A task cancelled while the frame runs (its view destroyed by an earlier task) is
    // skipped: deleting from a Set during iteration is well defined.
    for (const task of running) run(task);
    running = null;
    request();
  }

  return {
    schedule(task) {
      if (destroyed) return;
      tasks.add(task);
      request();
    },
    cancel(task) {
      tasks.delete(task);
      running?.delete(task);
    },
    onFrame(hook) {
      hooks.add(hook);
      request();
      return () => {
        hooks.delete(hook);
      };
    },
    flush(time = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
      if (frameId) {
        caf(frameId);
        frameId = 0;
      }
      frame(time);
    },
    destroy() {
      destroyed = true;
      tasks.clear();
      hooks.clear();
      if (frameId) caf(frameId);
      frameId = 0;
    },
  };
}

export interface WatchOptions<T> {
  /** Default `Object.is`; use `shallowEqual` for selectors that return tuples. */
  equals?: Equality<T>;
  /** Schedule a first render right away. Default true. */
  immediate?: boolean;
}

/**
 * Redraw with `render(value)` in the next frame whenever `selector(state)` changes.
 * Several changes within one frame produce one call, with the latest value.
 */
export function watch<T>(
  ctx: Pick<Ctx, 'store' | 'scheduler'>,
  selector: (state: ExplorerState) => T,
  render: (value: T) => void,
  options: WatchOptions<T> = {},
): () => void {
  let latest = selector(ctx.store.get());
  const task = (): void => render(latest);
  const stop = ctx.store.select(
    selector,
    (value) => {
      latest = value;
      ctx.scheduler.schedule(task);
    },
    options.equals ? { equals: options.equals } : {},
  );
  if (options.immediate ?? true) ctx.scheduler.schedule(task);
  return () => {
    stop();
    ctx.scheduler.cancel(task);
  };
}

// ---------------------------------------------------------------------------
// Memoised engine
// ---------------------------------------------------------------------------

class Lru<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly capacity: number) {}
  get(key: string): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }
}

/** A stable key for an observer (every field that changes a result). */
export function observerKey(o: Observer): string {
  return `${o.lat_deg}|${o.lon_deg}|${o.height_m ?? 0}|${o.pressure_hpa ?? 1010}|${o.temperature_c ?? 10}`;
}

export function selectionKey(bodies: BodySelection): string {
  return typeof bodies === 'string' ? bodies : JSON.stringify(bodies);
}

function optionsKey(options: EventOptions | undefined): string {
  return options ? `${options.horizon}|${options.height_of_eye_m}` : 'default';
}

/** Freeze plain objects and arrays recursively; typed arrays are left as they are. */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as object)) deepFreeze(child);
  return value;
}

export interface MemoOptions {
  /** Entries kept per method (default 8; day events 16). */
  capacity?: number;
  /** Deep-freeze results so a view that mutates a shared result fails loudly (development). */
  freeze?: boolean;
}

/**
 * Wrap an engine so identical calls return the same (shared, read-only) result. Keyed
 * by value: two components asking for `skyState(observer, jd, 'all')` in one frame get
 * one computation. Constant tables (`bodies`, `coverage`, `starfieldCatalog`,
 * `constellationBoundaries`) are computed once. Errors are not cached.
 */
export function memoEngine(engine: ExplorerEngine, options: MemoOptions = {}): ExplorerEngine {
  const capacity = options.capacity ?? 8;
  const finish = options.freeze ? deepFreeze : <T>(v: T): T => v;
  const caches = new Map<string, Lru<unknown>>();

  function cached<R>(method: string, key: string, size: number, compute: () => R): R {
    let cache = caches.get(method);
    if (!cache) {
      cache = new Lru<unknown>(size);
      caches.set(method, cache);
    }
    const hit = cache.get(key);
    if (hit !== undefined) return hit as R;
    const value = finish(compute());
    cache.set(key, value);
    return value;
  }

  const memo: ExplorerEngine & Partial<AlmanacEngine> & Partial<EclipseEngine> & Partial<PlanetEventsEngine> = {
    // Optional: present on the wrapper exactly when the engine makes almanac pages (the
    // Almanac view checks with `isAlmanacEngine`). A page is tens of milliseconds, so a
    // few dates are kept.
    ...(isAlmanacEngine(engine)
      ? { almanacDay: (date: string) => cached('almanacDay', date, 4, () => engine.almanacDay(date)) }
      : {}),
    // Optional, the same way (the Events view checks with `isEclipseEngine` and
    // `isPlanetEventsEngine`). Lists are asked for a few windows at a time; local
    // circumstances per eclipse and place; paths are the largest results (tens of kB).
    ...(isEclipseEngine(engine)
      ? {
          eclipses: (jdStart: number, jdEnd: number) =>
            cached('eclipses', `${jdStart}|${jdEnd}`, 4, () => engine.eclipses(jdStart, jdEnd)),
          eclipseLocal: (id: string, observer: Observer) =>
            cached('eclipseLocal', `${id}|${observerKey(observer)}`, 64, () => engine.eclipseLocal(id, observer)),
          eclipsePath: (id: string) => cached('eclipsePath', id, 4, () => engine.eclipsePath(id)),
        }
      : {}),
    ...(isPlanetEventsEngine(engine)
      ? {
          planetEvents: (jdStart: number, jdEnd: number) =>
            cached('planetEvents', `${jdStart}|${jdEnd}`, 4, () => engine.planetEvents(jdStart, jdEnd)),
        }
      : {}),
    kind: engine.kind,
    description: engine.description,
    // Navigation tools pass through unmemoised: they run on demand, never per frame.
    ...(engine.nav ? { nav: engine.nav } : {}),
    bodies: () => cached('bodies', '', 1, () => engine.bodies()),
    coverage: () => cached('coverage', '', 1, () => engine.coverage()),
    skyState: (observer, jd, bodies) =>
      cached(
        'skyState',
        `${observerKey(observer)}|${jd}|${selectionKey(bodies)}`,
        capacity,
        () => engine.skyState(observer, jd, bodies),
      ),
    sampleBodies: (observer, bodies, jdStart, jdEnd, step) =>
      cached(
        'sampleBodies',
        `${observerKey(observer)}|${selectionKey(bodies)}|${jdStart}|${jdEnd}|${step}`,
        capacity,
        () => engine.sampleBodies(observer, bodies, jdStart, jdEnd, step),
      ),
    dayEvents: (observer, jdStart, jdEnd, bodies, opts) =>
      cached(
        'dayEvents',
        `${observerKey(observer)}|${jdStart}|${jdEnd}|${selectionKey(bodies)}|${optionsKey(opts)}`,
        capacity * 2,
        () => engine.dayEvents(observer, jdStart, jdEnd, bodies, opts),
      ),
    dayEventsBatch: (observer, windows, bodies, opts) =>
      cached(
        'dayEventsBatch',
        `${observerKey(observer)}|${JSON.stringify(windows)}|${selectionKey(bodies)}|${optionsKey(opts)}`,
        4,
        () => engine.dayEventsBatch(observer, windows, bodies, opts),
      ),
    findAltitude: (observer, body, jdStart, jdEnd, altitude) =>
      cached(
        'findAltitude',
        `${observerKey(observer)}|${body}|${jdStart}|${jdEnd}|${altitude}`,
        capacity,
        () => engine.findAltitude(observer, body, jdStart, jdEnd, altitude),
      ),
    moonPhases: (jdStart, jdEnd) =>
      cached('moonPhases', `${jdStart}|${jdEnd}`, capacity, () => engine.moonPhases(jdStart, jdEnd)),
    seasons: (year) => cached('seasons', String(year), capacity, () => engine.seasons(year)),
    sidereal: (jd) => engine.sidereal(jd),
    starfieldCatalog: () => cached('starfieldCatalog', '', 1, () => engine.starfieldCatalog()),
    starfieldApparent: (jd) =>
      cached('starfieldApparent', String(jd), 2, () => engine.starfieldApparent(jd)),
    constellationAt: (ra, dec, jd) => engine.constellationAt(ra, dec, jd),
    constellationBoundaries: () =>
      cached('constellationBoundaries', '', 1, () => engine.constellationBoundaries()),
    // Optional in the contract: present on the wrapper exactly when the engine has it.
    starfieldFrameMatrix: engine.starfieldFrameMatrix
      ? (jd) => cached('starfieldFrameMatrix', String(jd), 2, () => engine.starfieldFrameMatrix!(jd))
      : undefined,
    // The residual heat map passes through unmemoised: it runs on demand, never per frame.
    ...(engine.misfit ? { misfit: engine.misfit } : {}),
  };
  return memo;
}

/** A small value-keyed memo for a component's own derived computations. */
export function memoize<A extends unknown[], R>(
  fn: (...args: A) => R,
  key: (...args: A) => string,
  capacity = 8,
): (...args: A) => R {
  const cache = new Lru<{ value: R }>(capacity);
  return (...args: A): R => {
    const k = key(...args);
    const hit = cache.get(k);
    if (hit) return hit.value;
    const value = fn(...args);
    cache.set(k, { value });
    return value;
  };
}
