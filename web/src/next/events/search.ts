/**
 * Long searches in pieces: an engine call over a long window (a year of conjunctions is
 * a second of WebAssembly, a century of transits more) is split into chunks, each one
 * call, run one after another between frames, so the page keeps answering; the list fills
 * in as each chunk returns, with a progress line; results are kept per window, so going
 * back to a list, or moving the time inside it, costs nothing. OWNER: events2 agent.
 *
 * The engine is synchronous and lives on the main thread (engine/types.ts); a chunk is the
 * unit that cannot be interrupted, so chunk sizes are chosen per call to keep each piece
 * to tens of milliseconds (measured in `docs/ACCURACY.md`, "Events view"). While the time
 * bar is dragged or playing the pieces wait (`pace`), so a search never makes a drag late.
 *
 * Pure scheduling logic with an injectable timer (tests drive it with FakeTimers).
 */

import { errorText } from './env.js';
import type { Span } from './model.js';

/** One piece of a search: an engine call over `span`, and what it found. */
export interface ChunkResult<T> {
  items: readonly T[];
}

export interface SearchSpec<T> {
  /** Run the engine over one chunk (throws a string or an Error on failure). */
  compute(span: Span): readonly T[];
  /** Days per chunk. */
  chunkDays: number;
  /** Names an item, so one found by two neighbouring chunks is kept once. */
  key(item: T): string;
  /** The instant an item is sorted by. */
  time(item: T): number;
  /**
   * Of two finds of the same item (neighbouring chunks both reach it), true when `b` is
   * the better one to keep (say, it has both contacts); default: keep the first.
   */
  better?(a: T, b: T): boolean;
}

export interface SearchState<T> {
  /** Found so far, sorted by time, each once. */
  items: readonly T[];
  /** Every chunk has run. */
  done: boolean;
  /** Share of the window searched, 0 to 1. */
  progress: number;
  /** The window being searched (clipped to the coverage). */
  span: Span | null;
  /** How far the search has got: the searched part of the window. */
  searched: Span | null;
  /** The request reached outside the coverage and was clipped. */
  truncated: boolean;
  /** The first chunk that failed, in words (the search stops there). */
  error: string | null;
}

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMER: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SearchOptions<T> extends SearchSpec<T> {
  /** Called after each chunk, besides the subscribers (the tab schedules a redraw). */
  onUpdate?: () => void;
  /** Milliseconds to wait before the next chunk (0: at once); see TabEnv.pace. */
  pace?: () => number;
  /** The engine's coverage: requests are clipped to it. */
  coverage?: () => Span | null;
  /** Windows kept, newest first (default 4). */
  keep?: number;
  timer?: Timer;
}

export type Order = 'forward' | 'backward';

interface Entry<T> {
  /** The window as asked (after padding), and as searched (clipped). */
  asked: Span;
  span: Span | null;
  order: Order;
  chunks: Span[];
  next: number;
  found: Map<string, T>;
  sorted: T[] | null;
  error: string | null;
  truncated: boolean;
}

/** Split a window into chunks of at most `days` (the last may be shorter), in time order. */
export function chunksOf(span: Span, days: number): Span[] {
  const out: Span[] = [];
  if (!(span.end >= span.start) || !(days > 0)) return out;
  const n = Math.max(1, Math.ceil((span.end - span.start) / days - 1e-9));
  for (let i = 0; i < n; i += 1) {
    const start = span.start + i * days;
    out.push({ start, end: i === n - 1 ? span.end : Math.min(span.end, start + days) });
  }
  return out;
}

function contains(outer: Span, inner: Span): boolean {
  return outer.start <= inner.start && outer.end >= inner.end;
}

/**
 * A search over windows of time, computed a chunk at a time in the background.
 * `get(window, order)` returns what is known now and makes sure the rest is being found.
 */
export class BackgroundSearch<T> {
  private readonly entries: Entry<T>[] = [];
  private running: Entry<T> | null = null;
  private handle: unknown = null;
  private destroyed = false;
  private timer: Timer;
  private readonly listeners = new Set<() => void>();
  /** The caller's callbacks; null once detached (the view closed), until `attach`. */
  private o: SearchOptions<T> | null;

  constructor(options: SearchOptions<T>) {
    this.o = options;
    this.timer = options.timer ?? REAL_TIMER;
  }

  /**
   * What is known for `window`: a window already searched (or being searched) that holds it
   * is reused; otherwise a new search starts, nearest the anchor first (`forward` from the
   * window's start, `backward` from its end).
   */
  get(window: Span, order: Order = 'forward'): SearchState<T> {
    if (!this.o) return { items: [], done: true, progress: 1, span: null, searched: null, truncated: false, error: 'the search is detached' };
    let entry = this.entries.find((e) => contains(e.asked, window));
    if (!entry) {
      entry = this.create(window, order);
      this.entries.unshift(entry);
      const keep = this.o.keep ?? 4;
      // Forget the oldest windows; one still being searched stops.
      for (const old of this.entries.splice(keep)) if (old === this.running) this.stop();
    } else if (entry !== this.entries[0]) {
      this.entries.splice(this.entries.indexOf(entry), 1);
      this.entries.unshift(entry);
    }
    if (entry.next < entry.chunks.length && !entry.error && this.running !== entry) this.start(entry);
    return this.state(entry);
  }

  /** Hear about every chunk that returns. Returns the stop function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stop working for now (the view is closed): what was found is kept, and `get` resumes. */
  pause(): void {
    this.stop();
  }

  /**
   * The view closed: stop, and let go of its callbacks (they hold the view's closures, and
   * through them its page), keeping what was found. `attach` gives the next view's.
   */
  detach(): void {
    this.stop();
    this.listeners.clear();
    this.o = null;
  }

  attach(options: SearchOptions<T>): void {
    this.o = options;
    if (options.timer) this.timer = options.timer;
  }

  /** True between `detach` and `attach`. */
  get detached(): boolean {
    return this.o === null;
  }

  /** Forget everything (the observer or the options changed; a pack widened the coverage). */
  clear(): void {
    this.stop();
    this.entries.length = 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
    this.clear();
  }

  /** True while a chunk is waiting to run. */
  get busy(): boolean {
    return this.running !== null;
  }

  private create(window: Span, order: Order): Entry<T> {
    const o = this.o!;
    const coverage = o.coverage?.() ?? null;
    let span: Span | null = window;
    let truncated = false;
    if (coverage) {
      const start = Math.max(window.start, coverage.start);
      const end = Math.min(window.end, coverage.end);
      truncated = start > window.start || end < window.end;
      span = start <= end ? { start, end } : null;
    }
    const chunks = span ? chunksOf(span, o.chunkDays) : [];
    if (order === 'backward') chunks.reverse();
    return { asked: window, span, order, chunks, next: 0, found: new Map(), sorted: [], error: null, truncated };
  }

  private state(e: Entry<T>): SearchState<T> {
    const o = this.o!;
    if (!e.sorted) e.sorted = [...e.found.values()].sort((a, b) => o.time(a) - o.time(b));
    const total = e.chunks.length;
    const done = e.next >= total || e.error !== null;
    let searched: Span | null = null;
    if (e.span && e.next > 0) {
      const doneChunks = e.chunks.slice(0, e.next);
      searched = {
        start: Math.min(...doneChunks.map((c) => c.start)),
        end: Math.max(...doneChunks.map((c) => c.end)),
      };
    }
    return {
      items: e.sorted,
      done,
      progress: total ? Math.min(1, e.next / total) : 1,
      span: e.span,
      searched,
      truncated: e.truncated,
      error: e.error,
    };
  }

  private stop(): void {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
    this.running = null;
  }

  private start(entry: Entry<T>): void {
    this.stop();
    this.running = entry;
    this.handle = this.timer.set(() => this.step(), 0);
  }

  private step(): void {
    this.handle = null;
    const e = this.running;
    const o = this.o;
    if (!e || this.destroyed || !o) return;
    const wait = o.pace?.() ?? 0;
    if (wait > 0) {
      this.handle = this.timer.set(() => this.step(), wait);
      return;
    }
    const chunk = e.chunks[e.next];
    if (!chunk) {
      this.running = null;
      return;
    }
    try {
      for (const item of o.compute(chunk)) {
        const k = o.key(item);
        const had = e.found.get(k);
        if (had === undefined || o.better?.(had, item)) e.found.set(k, item);
      }
      e.next += 1;
    } catch (error) {
      e.error = errorText(error);
    }
    e.sorted = null;
    if (e.next < e.chunks.length && !e.error) this.handle = this.timer.set(() => this.step(), 0);
    else this.running = null;
    o.onUpdate?.();
    for (const listener of [...this.listeners]) listener();
  }
}

/** "Searching… 40%" for a status line, or '' when done. */
export function progressText(state: Pick<SearchState<unknown>, 'done' | 'progress'>, what = 'Searching'): string {
  if (state.done) return '';
  return `${what}… ${Math.round(state.progress * 100)}%`;
}
