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
  isPackEngine,
  isPlanetEventsEngine,
  isSailingsEngine,
  isTidesEngine,
  type AlmanacEngine,
  type BodySelection,
  type EclipseEngine,
  type EclipseLocalOptions,
  type EventOptions,
  type ExplorerEngine,
  type Observer,
  type PackEngine,
  type PackService,
  type PlanetEventsEngine,
  type SailingsEngine,
  type TideDatum,
  type TidesEngine,
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
  /**
   * Optional data packs (packs/, EXPLORER_API "Packs"): `ensure(name, reason)` before using
   * what a pack adds; saved packs are already loaded when a view mounts. Developer pages
   * without packs pass `NO_PACKS` (packs/service.ts).
   */
  readonly packs: PackService;
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

/**
 * Settings that change how text is written without changing any value a view selects:
 * the 12- or 24-hour clock (shell/format.ts), the calendar and the way years are written
 * (time/civil.ts, time/format.ts; time-ui agent). When one changes, every `watch` draws
 * again once with its current value, so no time or date on screen keeps the old form.
 */
function displayForm(state: ExplorerState): string {
  return `${state.settings.hourCycle}|${state.settings.calendar}|${state.settings.yearStyle}`;
}

/** Every live `watch`'s way to draw again (see `redrawEverything`). */
const redrawers = new Set<() => void>();

/**
 * Every `watch` draws again once, with its current value. For a change no selector can see:
 * a data pack was loaded, so the engine now answers what it refused (packs/; main.ts calls
 * this after `memoEngine(...).invalidate()`).
 */
export function redrawEverything(): void {
  for (const redraw of [...redrawers]) redraw();
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
  const redraw = (): void => {
    latest = selector(ctx.store.get());
    ctx.scheduler.schedule(task);
  };
  const stopForm = ctx.store.select(displayForm, redraw);
  redrawers.add(redraw);
  if (options.immediate ?? true) ctx.scheduler.schedule(task);
  return () => {
    stop();
    stopForm();
    redrawers.delete(redraw);
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

/** A memoised engine; `invalidate` forgets every remembered result. */
export type MemoEngine = ExplorerEngine & {
  /**
   * Forget every remembered result: a data pack was loaded (packs/), so the engine can now
   * answer more (a date it refused, a wider coverage) and must be asked again.
   */
  invalidate(): void;
};

/**
 * Wrap an engine so identical calls return the same (shared, read-only) result. Keyed
 * by value: two components asking for `skyState(observer, jd, 'all')` in one frame get
 * one computation. Constant tables (`bodies`, `coverage`, `starfieldCatalog`,
 * `constellationBoundaries`) are computed once, until `invalidate`. Errors are not cached.
 */
export function memoEngine(engine: ExplorerEngine, options: MemoOptions = {}): MemoEngine {
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

  const memo: MemoEngine &
    Partial<AlmanacEngine> &
    Partial<EclipseEngine> &
    Partial<PlanetEventsEngine> &
    Partial<PackEngine> &
    Partial<TidesEngine> = {
    invalidate: () => caches.clear(),
    // Data packs pass through unmemoised (packs/ loads them; `packs()` changes when one does).
    ...(isPackEngine(engine)
      ? {
          packs: () => engine.packs(),
          // A pack lets the engine answer more (a date it refused, a wider coverage): forget
          // every remembered result, as the other mutations below do (verify2: the loop below
          // skips a name already here, so this one must clear the caches itself).
          loadPack: (name: string, bytes: Uint8Array) => {
            try {
              return engine.loadPack(name, bytes);
            } finally {
              caches.clear();
            }
          },
        }
      : {}),
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
          // With `options.limb` (P12) the result carries the limb block: its own key.
          eclipseLocal: (id: string, observer: Observer, options?: EclipseLocalOptions) =>
            cached('eclipseLocal', `${id}|${observerKey(observer)}|${options?.limb ? 'limb' : ''}`, 64, () =>
              options ? engine.eclipseLocal(id, observer, options) : engine.eclipseLocal(id, observer),
            ),
          eclipsePath: (id: string) => cached('eclipsePath', id, 4, () => engine.eclipsePath(id)),
        }
      : {}),
    ...(isPlanetEventsEngine(engine)
      ? {
          planetEvents: (jdStart: number, jdEnd: number) =>
            cached('planetEvents', `${jdStart}|${jdEnd}`, 4, () => engine.planetEvents(jdStart, jdEnd)),
        }
      : {}),
    // Optional (sailings agent): passage planning and sight extras run on demand, so they
    // pass through; the star finder's geometry is a table per latitude band and date.
    ...(isSailingsEngine(engine)
      ? {
          sailing: (request) => engine.sailing(request),
          drAdvance: (request) => engine.drAdvance(request),
          routePositions: (request) => engine.routePositions(request),
          starIdentify: (request) => engine.starIdentify(request),
          starFinderGeometry: (latBand: number, jdUtc?: number) =>
            cached('starFinderGeometry', `${latBand}|${jdUtc ?? ''}`, 4, () => engine.starFinderGeometry(latBand, jdUtc)),
        } satisfies SailingsEngine
      : {}),
    // Tides (tides agent): present exactly when the engine predicts tides
    // (`isTidesEngine`). Station lists and tables are kept a few at a time; the state
    // now and the pack summary change from call to call and pass through. Errors, such
    // as pack_not_loaded before the pack is installed, are never cached.
    ...(isTidesEngine(engine)
      ? {
          tideStationsNear: (latDeg: number, lonDeg: number, n: number) =>
            cached('tideStationsNear', `${latDeg}|${lonDeg}|${n}`, 4, () =>
              engine.tideStationsNear(latDeg, lonDeg, n),
            ),
          tideStation: (id: string) => cached('tideStation', id, 8, () => engine.tideStation(id)),
          tidePredict: (id: string, jdStart: number, jdEnd: number, stepMin: number, datum?: TideDatum | '') =>
            cached('tidePredict', `${id}|${jdStart}|${jdEnd}|${stepMin}|${datum ?? ''}`, 4, () =>
              engine.tidePredict(id, jdStart, jdEnd, stepMin, datum),
            ),
          tideExtremes: (id: string, jdStart: number, jdEnd: number, datum?: TideDatum | '') =>
            cached('tideExtremes', `${id}|${jdStart}|${jdEnd}|${datum ?? ''}`, 8, () =>
              engine.tideExtremes(id, jdStart, jdEnd, datum),
            ),
          tideNow: (id: string, jdUtc: number, datum?: TideDatum | '') => engine.tideNow(id, jdUtc, datum),
          tidePackInfo: () => engine.tidePackInfo(),
        }
      : {}),
    // --- end tides
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
  // Every other capability of the engine (the expansion programme's engines: sun tools,
  // geomagnetism, tides, time scales, packs, …) passes through unmemoised, bound to the
  // engine, so a view's type guard (`isSunToolsEngine(ctx.engine)` and the like) sees it
  // on the wrapper without this file naming each one. Methods named above keep their memo.
  const out = memo as unknown as Record<string, unknown>;
  for (const name of methodNames(engine)) {
    if (name in out) continue;
    const fn = (engine as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') continue;
    const call = fn as (...args: unknown[]) => unknown;
    if (/^(set|load|install|remove|clear|reset)/.test(name)) {
      // A mutation (`setDut1`, `loadPack`, …): pass it through, then forget every cached
      // result, since any of them may now be stale.
      out[name] = (...args: unknown[]): unknown => {
        try {
          return call.apply(engine, args);
        } finally {
          caches.clear();
        }
      };
    } else {
      // A query: memoised like the named methods, keyed by its arguments' JSON.
      out[name] = (...args: unknown[]): unknown => cached(name, argsKey(args), capacity, () => call.apply(engine, args));
    }
  }
  return memo;
}

/**
 * A cache key for a pass-through call: the arguments as JSON (typed arrays by their bytes'
 * length and a hash). JSON writes NaN and ±Infinity as `null` and cannot write a BigInt: they
 * get keys of their own (verify2), so `f(NaN)` never answers from `f(null)`'s entry.
 */
function argsKey(args: unknown[]): string {
  return JSON.stringify(args, (_key, value: unknown) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return `\u0000number:${value}`;
    if (typeof value === 'bigint') return `\u0000bigint:${value}`;
    if (value instanceof Uint8Array || value instanceof Float64Array || value instanceof Float32Array) {
      let h = 0;
      for (let i = 0; i < value.length; i += 1) h = (h * 31 + Number(value[i])) | 0;
      return `${value.constructor.name}:${value.length}:${h}`;
    }
    return value;
  });
}

/** Names of every function-valued property of `obj`, own or inherited (class methods live on the prototype). */
function methodNames(obj: object): string[] {
  const names = new Set<string>();
  for (let p: object | null = obj; p && p !== Object.prototype; p = Object.getPrototypeOf(p) as object | null) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (name === 'constructor') continue;
      const desc = Object.getOwnPropertyDescriptor(p, name);
      if (desc && typeof desc.value === 'function') names.add(name);
    }
  }
  return [...names];
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
