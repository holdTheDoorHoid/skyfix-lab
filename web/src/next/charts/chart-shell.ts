/**
 * The wiring every chart of the charts2 agent shares (expansion programme Q5): the card,
 * its data (recomputed only when what it depends on changes, heavy work when the time
 * settles), its drawing (when the data, the width or the chart's own controls change), a
 * cheap per-frame update for the app's time cursor, the Table view and the Save menu.
 * OWNER: charts2 agent.
 *
 * A chart supplies a `ShellSpec`: how to read its input from the app's state, a key that
 * says when the input changed, the engine work, and how to draw, update the cursor and fill
 * the table. The rules of `component.ts` hold: drawing happens in the scheduler's frame,
 * engine results are never mutated, and everything is cleaned up on destroy.
 */

import { h } from '../../dom.js';
import { disposer, watch, type Ctx } from '../component.js';
import { fastPlayback } from '../playback.js';
import type { ExplorerState, Store } from '../state.js';
import type { Zone } from '../time.js';
import { attachExport } from './export-menu.js';
import {
  applyMode,
  bindTimeButtons,
  card,
  errorText,
  message,
  mockBadge,
  observeWidth,
  scrollToCurrent,
  type Card,
  type ChartUi,
} from './frame.js';
import { settler } from './settle.js';
import { localDayAt, zoneKey, type LocalDay } from './windows.js';

export interface Shell<I, D> {
  readonly c: Card;
  readonly ctx: Ctx;
  readonly ui: Store<ChartUi>;
  /** The plot's width, CSS pixels (0 until measured). */
  readonly width: number;
  readonly input: I;
  /** The data for `input`, or the previous data while heavy work for a new input waits. */
  readonly data: D | null;
  /** The data belongs to the current input. */
  readonly current: boolean;
  readonly failure: string | null;
  /** The chart's own controls changed what is drawn. */
  redraw(): void;
  /** The chart's own controls changed the input: compute again. */
  refresh(): void;
}

export interface ShellSpec<I, D> {
  /** The card's modifier class (`sfc-card--<kind>`) and first heading. */
  readonly kind: string;
  readonly heading: string;
  /** The input from the app's state (and the chart's own controls). Called on every state change: keep it cheap. */
  input(state: ExplorerState): I;
  /** A string that changes exactly when the input does. */
  key(input: I): string;
  /** The engine work; throw to show a message instead of a chart. */
  compute(input: I): D;
  /** Heavy work (tens of milliseconds or more): run when the time settles, not in the frame. */
  readonly heavy?: boolean;
  /** Text for a failure, from what `compute` threw. */
  failureText?(error: unknown, input: I): string;
  /** Called once, after the card is built: put controls in the card, return clean-ups. */
  setup?(shell: Shell<I, D>): (() => void) | void;
  /** Title, subtitle and the navigation label. The engine badge is added after. */
  header(shell: Shell<I, D>): void;
  /** Fill `c.plot` (and the caption and notes); return the SVG a picture is made from. */
  draw(shell: Shell<I, D>): SVGSVGElement | null;
  /** Cheap update when only the app's time changed (every frame while it moves). */
  cursor?(shell: Shell<I, D>): void;
  /** The Table view's tables (already filled). */
  table(shell: Shell<I, D>): HTMLElement[];
  /** Settings that change only how things are written (angle format, units): redraw. */
  displayKey?(state: ExplorerState): string;
  /** File names: `['sun-path', '2026-09-24']`. */
  fileParts(shell: Shell<I, D>): (string | number)[];
  /** Lines every picture and file must carry (what the numbers are, how far to trust them). */
  labels?(shell: Shell<I, D>): string[];
}

const CACHE_SIZE = 4;

/**
 * The local day containing an instant, remembered while the instant stays in it: a chart's
 * `input` runs on every state change (every frame while time moves), and finding a day's
 * midnight asks the zone rules several times.
 */
export function localDayCache(): (jd: number, zone: Zone) => LocalDay {
  let cache: { zone: string; day: LocalDay } | null = null;
  return (jd, zone) => {
    const zk = zoneKey(zone);
    if (!cache || cache.zone !== zk || jd < cache.day.jd_start || jd >= cache.day.jd_end) cache = { zone: zk, day: localDayAt(jd, zone) };
    return cache.day;
  };
}

/** Thrown by a chart whose engine lacks what it needs (an older core, a mock without it). */
export class NotAvailableError extends Error {
  constructor(what: string) {
    super(`${what} ${what.endsWith('s') ? 'are' : 'is'} not available in this engine: it is an older build of the calculation core. Reload the page to get the current one.`);
    this.name = 'NotAvailableError';
  }
}

/** The place's name, or its coordinates. */
export function placeName(state: ExplorerState): string {
  const o = state.observer;
  return o.label || `${o.lat_deg.toFixed(3)}°, ${o.lon_deg.toFixed(3)}°`;
}

export function mountChart<I, D>(host: HTMLElement, ctx: Ctx, ui: Store<ChartUi>, spec: ShellSpec<I, D>): { destroy(): void } {
  const d = disposer();
  const c = card(spec.kind, spec.heading);
  host.append(c.root);
  d.add(() => c.root.remove());

  const cache = new Map<string, D>();
  const settle = settler();
  d.add(() => settle.cancel());
  let alive = true;
  d.add(() => {
    alive = false;
  });

  let width = 0;
  let input = spec.input(ctx.store.get());
  let key = spec.key(input);
  let data: D | null = null;
  let dataKey: string | null = null;
  let failure: string | null = null;
  let svg: SVGSVGElement | null = null;

  const shell: Shell<I, D> = {
    c,
    ctx,
    ui,
    get width() {
      return width;
    },
    get input() {
      return input;
    },
    get data() {
      return data;
    },
    get current() {
      return data !== null && dataKey === key;
    },
    get failure() {
      return failure;
    },
    redraw: () => {
      if (alive) schedule();
    },
    refresh: () => {
      if (!alive) return;
      dataDirty = true;
      schedule();
    },
  };

  const cacheKey = (k: string): string => `${ctx.engine.kind}|${k}`;
  const remember = (k: string, value: D): void => {
    cache.delete(cacheKey(k));
    cache.set(cacheKey(k), value);
    while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  };

  function run(k: string, inp: I): void {
    try {
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const value = spec.compute(inp);
      const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
      // For the developer page and ui-check.mjs, as the other charts publish theirs.
      c.root.dataset.compute = `${spec.kind} ${ms.toFixed(0)} ms`;
      remember(k, value);
      if (k === key) {
        data = value;
        dataKey = k;
        failure = null;
      }
    } catch (error) {
      if (k === key) {
        data = null;
        dataKey = null;
        failure =
          error instanceof NotAvailableError
            ? error.message
            : (spec.failureText?.(error, inp) ?? `The engine could not compute this chart: ${errorText(error)}`);
      }
    }
  }

  function recompute(): void {
    input = spec.input(ctx.store.get());
    key = spec.key(input);
    const hit = cache.get(cacheKey(key));
    if (hit !== undefined) {
      settle.cancel();
      data = hit;
      dataKey = key;
      failure = null;
      return;
    }
    if (!spec.heavy) {
      run(key, input);
      return;
    }
    const k = key;
    const inp = input;
    c.root.dataset.computing = '1';
    settle.request(() => {
      if (!alive) return;
      run(k, inp);
      if (k === key) delete c.root.dataset.computing;
      drawDirty = true;
      ctx.scheduler.schedule(frame);
    });
  }

  function header(): void {
    spec.header(shell);
    if (ctx.engine.kind === 'mock' && !c.title.querySelector('.sf-badge')) c.title.append(mockBadge(ctx.engine.description));
  }

  function draw(): void {
    header();
    const tableShown = ui.get().mode === 'table';
    if (failure !== null) {
      message(c.plot, failure);
      svg = null;
      c.caption.replaceChildren();
      if (tableShown) renderTable();
      c.root.dataset.ready = '1';
      delete c.root.dataset.computing;
      return;
    }
    if (data === null) return;
    // The table does not need the plot's width: with the chart hidden it has none.
    if (tableShown) renderTable();
    if (width > 0) svg = spec.draw(shell);
    if (shell.current && (width > 0 || tableShown)) c.root.dataset.ready = '1';
  }

  function renderTable(): void {
    if (failure !== null || data === null) {
      c.tableWrap.replaceChildren(h('p', { class: 'sfc-message' }, failure ?? 'Working it out…'));
      return;
    }
    c.tableWrap.replaceChildren(...spec.table(shell));
    // time-ui: the tier chip belongs beside each table's caption (the ±ΔT band outside the validated tier).
  }

  let dataDirty = true;
  let drawDirty = true;
  function frame(): void {
    if (dataDirty) {
      dataDirty = false;
      drawDirty = true;
      recompute();
      if (ui.get().mode === 'table') {
        header();
        renderTable();
      }
    }
    if (drawDirty) {
      drawDirty = false;
      draw();
    }
    if (data !== null && failure === null) spec.cursor?.(shell);
  }
  function schedule(): void {
    drawDirty = true;
    ctx.scheduler.schedule(frame);
  }

  const cleanup = spec.setup?.(shell);
  if (cleanup) d.add(cleanup);

  d.add(
    watch(
      ctx,
      // Faster than eight days a second (playback.ts `fastPlayback`) the chart keeps its data
      // and asks the engine nothing (verify2): a heavy one ran every 0.7 s. It catches up once
      // time slows.
      (s) => (fastPlayback(s) ? 'fast' : spec.key(spec.input(s))),
      () => {
        if (fastPlayback(ctx.store.get())) return;
        dataDirty = true;
        frame();
      },
    ),
  );
  if (spec.cursor) {
    d.add(
      watch(
        ctx,
        (s) => s.time.jd_utc,
        () => {
          if (data !== null && failure === null) spec.cursor?.(shell);
        },
        { immediate: false },
      ),
    );
  }
  if (spec.displayKey) {
    const displayKey = spec.displayKey;
    d.add(watch(ctx, (s) => displayKey(s), () => schedule(), { immediate: false }));
  }
  d.add(
    ui.select(
      (u) => u.mode,
      (mode) => {
        applyMode(c, mode);
        if (mode === 'table') {
          header();
          renderTable();
          scrollToCurrent(c);
        } else schedule();
      },
      { immediate: true },
    ),
  );
  d.add(
    observeWidth(c.plot, (w) => {
      width = w;
      schedule();
    }),
  );
  d.add(bindTimeButtons(c.tableWrap, ctx));
  d.add(bindTimeButtons(c.plot, ctx));
  d.add(
    attachExport(c, {
      fileParts: () => spec.fileParts(shell),
      picture: () => svg,
      tables: () => {
        renderTable();
        return [...c.tableWrap.querySelectorAll('table')];
      },
      labels: () => spec.labels?.(shell) ?? [],
    }),
  );
  d.add(() => ctx.scheduler.cancel(frame));

  return { destroy: () => d.dispose() };
}
