/**
 * The skeleton the new Events lists share: a direction switch (the next or the last so
 * many months), filters, a Save menu, a status line, an optional lead sentence, the list
 * (and a card for the chosen event), notes, all fed by a background search kept per window
 * (search.ts, shared.ts) and drawn in the scheduler's frames. OWNER: events2 agent.
 *
 * A tab gives the engine call and how its answer reads (`ListTabConfig`); the skeleton does
 * the rest the same way everywhere: rows are rebuilt only when what they show changes; a
 * time change only moves the "next" mark; a search that is still running shows its
 * progress and the rows found so far; a list the coverage cut short says where it stops and
 * offers the data pack that would extend it.
 */

import { h } from '../../dom.js';
import { disposer, observerKey, watch, type Mounted } from '../component.js';
import { engineObserver, displayZone, type ExplorerState } from '../state.js';
import { segmented } from '../theme/primitives.js';
import { coverageBounds } from '../time/index.js';
import { chipsIn, listUncertaintySentence, rowTimeInfo, truncatedNote } from './deeptime.js';
import { errorText, type EventsUi, type TabEnv } from './env.js';
import { addToCalendarButton, exportMenu, type ExportMenu } from './export-ui.js';
import { fileWords, screenWords, utcDate, type EventItem, type Words } from './items.js';
import { neededSpan, nextAfter, paddedSpan, type Direction, type Span } from './model.js';
import { eventRow, searchStatus, splitView, type Row, type RowOptions, type Split } from './rows.js';
import type { SearchSpec, SearchState } from './search.js';
import type { Store } from '../state.js';

export interface ListTabConfig<T> {
  /** Class on the tab's root (`sfe-occ`, `sfe-conj`…); screenshots and tests find it. */
  className: string;
  /** A sentence when the engine cannot answer (the mock, an older module), else null. */
  unavailable: string | null;
  /** Plural words for notes: "Close approaches" ("… are computed for 1990 to 2060"). */
  what: string;
  /** The search: a slot name, what else its answers depend on, and the call per chunk. */
  search: {
    name: string;
    key(s: ExplorerState, u: EventsUi): string;
    spec(s: ExplorerState, u: EventsUi): SearchSpec<T>;
  };
  /**
   * A second search the list reads beside the first (the occultations seen elsewhere on
   * Earth, from the conjunctions), run only while `enabled`; its finds reach `items`,
   * `row` and `lead` as `aux` (null while disabled).
   */
  aux?: {
    name: string;
    key(s: ExplorerState, u: EventsUi): string;
    spec(s: ExplorerState, u: EventsUi): SearchSpec<unknown>;
    enabled(u: EventsUi): boolean;
  };
  /** How far the list reaches from the anchor, and how far before it an event may start and still show. */
  horizonDays: number;
  leadDays?: number;
  /** Extra days searched either side (so a small move of the time costs nothing). */
  slackDays?: number;
  direction?: {
    get(u: EventsUi): Direction;
    set(ui: Store<EventsUi>, d: Direction): void;
    labels: readonly [string, string];
    label: string;
  };
  /** Filters and switches after the direction switch. */
  controls?: readonly HTMLElement[];
  /** What else the list depends on in the view's state (filters), for redraws. */
  watch?(u: EventsUi): readonly unknown[];
  /** The list's events from what was found (screen or file words); the skeleton keeps those in range. */
  items(found: readonly T[], w: Words, s: ExplorerState, u: EventsUi, aux: readonly unknown[] | null): EventItem[];
  /** How a row looks beyond its item: glyph, badges, a dim state, a card to open. */
  row?(item: EventItem, found: readonly T[], s: ExplorerState, u: EventsUi): Partial<RowOptions>;
  /** A sentence or two above the list. */
  lead?(found: readonly T[], shown: readonly EventItem[], w: Words, s: ExplorerState, u: EventsUi): string;
  /** A drawing between the lead and the list (the retrograde timeline), rebuilt with the rows. */
  figure?(found: readonly T[], shown: readonly EventItem[], s: ExplorerState, u: EventsUi): { el: Element; setNow?(jd: number): void } | null;
  /** "12 close approaches in the next 12 months", for the status line. */
  count(n: number, dir: Direction): string;
  /** When the list is empty (and the search done). */
  empty(dir: Direction): string;
  /** Notes under the list (the model's labels: mean limb, estimates). */
  notes?(found: readonly T[], s: ExplorerState): string[];
  /** Files: title, name parts, whether the times are local, the table's labels. */
  file: {
    title(dir: Direction): string;
    parts(anchor: number, dir: Direction): (string | number)[];
    local: boolean;
  };
  /** A card for the chosen event (the id is the item's), with its own clean-up. */
  card?: {
    selected(u: EventsUi): string | null;
    select(ui: Store<EventsUi>, id: string | null): void;
    build(item: EventItem, found: readonly T[], env: TabEnv): { el: HTMLElement; setNow?(jd: number): void; destroy?(): void } | null;
    empty: string;
  };
}

/** The items of a list in range of the anchor, upcoming soonest first, past most recent first. */
export function inRange(items: readonly EventItem[], anchor: number, dir: Direction, horizonDays: number, leadDays = 0): EventItem[] {
  const out =
    dir === 'upcoming'
      ? items.filter((i) => (i.end ?? i.start) >= anchor - leadDays && i.start <= anchor + horizonDays)
      : items.filter((i) => i.start < anchor && i.start >= anchor - horizonDays);
  return out.sort((a, b) => (dir === 'upcoming' ? a.start - b.start : b.start - a.start));
}

/** The coverage as a span of Julian dates (for searches to clip to), or null. */
export function coverageSpan(env: TabEnv): Span | null {
  const c = coverageBounds(env.ctx.engine);
  return c ? { start: c.start, end: c.end } : null;
}

/** A key for what a search's answers depend on besides the window: the coverage (a pack widens it). */
export function coverageKey(env: TabEnv): string {
  const c = coverageBounds(env.ctx.engine);
  return c ? `${c.startUtc}|${c.endUtc}` : '';
}

/** The observer as the engine takes it, and its key. */
export function observerOf(s: ExplorerState): { observer: ReturnType<typeof engineObserver>; key: string } {
  const observer = engineObserver(s);
  return { observer, key: observerKey(observer) };
}

export function listTab<T>(host: HTMLElement, env: TabEnv, cfg: ListTabConfig<T>): Mounted {
  const { ctx, ui } = env;
  const d = disposer();
  const root = h('div', { class: `sfe-tabbody sfe-list2 ${cfg.className}` });
  host.append(root);
  d.add(() => root.remove());
  if (cfg.unavailable) {
    root.append(h('p', { class: 'sfe-message', role: 'alert' }, cfg.unavailable));
    return { destroy: () => d.dispose() };
  }

  // --- Controls --------------------------------------------------------------------------
  const controls = h('div', { class: 'sfe-controls' });
  const dir = cfg.direction;
  const direction = dir
    ? segmented<Direction>({
        label: dir.label,
        size: 'sm',
        value: dir.get(ui.get()),
        options: [
          { value: 'upcoming', label: dir.labels[0] },
          { value: 'past', label: dir.labels[1] },
        ],
        onChange: (v) => dir.set(ui, v),
      })
    : null;
  if (direction) controls.append(direction.el);
  for (const c of cfg.controls ?? []) controls.append(c);

  // --- The list's state ---------------------------------------------------------------------
  let state: SearchState<T> | null = null;
  let auxState: SearchState<unknown> | null = null;
  let shown: EventItem[] = [];
  let anchorNow = ui.get().anchor;
  let dirNow: Direction = dir ? dir.get(ui.get()) : 'upcoming';

  const itemsFor = (w: Words): EventItem[] =>
    state
      ? inRange(cfg.items(state.items, w, ctx.store.get(), ui.get(), auxState ? auxState.items : null), anchorNow, dirNow, cfg.horizonDays, cfg.leadDays ?? 0)
      : [];

  const saveMenu: ExportMenu = exportMenu(ctx, ui, {
    title: () => cfg.file.title(dirNow),
    fileParts: () => cfg.file.parts(anchorNow, dirNow),
    items: (w) => itemsFor(w),
    local: cfg.file.local,
    notes: () => (state ? (cfg.notes?.(state.items, ctx.store.get()) ?? []) : []),
  });
  d.add(() => saveMenu.destroy());
  controls.append(saveMenu.el);

  const status = h('p', { class: 'sfe-status', role: 'status', 'aria-live': 'polite' });
  const lead = h('p', { class: 'sfe-lead sfe-lead2' });
  const figureHost = h('div', { class: 'sfe-figure' });
  let figure: { el: Element; setNow?(jd: number): void } | null = null;
  const notes = h('div', { class: 'sfe-notes' });
  const listHost = h('div', { class: 'sfe-list2__rows' });
  let split: Split | null = null;
  if (cfg.card) {
    split = splitView(root);
    split.list.append(status, lead, figureHost, listHost, notes);
    root.append(controls, split.el);
    d.add(() => split?.destroy());
  } else {
    root.append(controls, status, lead, figureHost, listHost, notes);
  }

  // --- The search ---------------------------------------------------------------------------
  let subscribed: object | null = null;
  let stopSub: (() => void) | null = null;
  d.add(() => stopSub?.());
  let auxSubscribed: object | null = null;
  let stopAux: (() => void) | null = null;
  d.add(() => stopAux?.());
  const auxNow = () => {
    const a = cfg.aux;
    if (!a || !a.enabled(ui.get())) return null;
    const s = ctx.store.get();
    const u = ui.get();
    const search = env.shared.search<unknown>(a.name, `${a.key(s, u)}|${coverageKey(env)}`, (pace) => ({
      ...a.spec(s, u),
      pace,
      coverage: () => coverageSpan(env),
    }));
    if (search !== auxSubscribed) {
      stopAux?.();
      auxSubscribed = search;
      stopAux = search.subscribe(() => ctx.scheduler.schedule(render));
    }
    return search;
  };
  const searchNow = () => {
    const s = ctx.store.get();
    const u = ui.get();
    const search = env.shared.search<T>(cfg.search.name, `${cfg.search.key(s, u)}|${coverageKey(env)}`, (pace) => ({
      ...cfg.search.spec(s, u),
      pace,
      coverage: () => coverageSpan(env),
    }));
    if (search !== subscribed) {
      stopSub?.();
      subscribed = search;
      stopSub = search.subscribe(() => ctx.scheduler.schedule(render));
    }
    return search;
  };

  // --- Drawing ------------------------------------------------------------------------------
  let rows: { item: EventItem; row: Row }[] = [];
  let builtKey = '';
  let card: { el: HTMLElement; setNow?(jd: number): void; destroy?(): void; id: string } | null = null;

  const render = (): void => {
    const s = ctx.store.get();
    const u = ui.get();
    anchorNow = u.anchor;
    dirNow = dir ? dir.get(u) : 'upcoming';
    direction?.set(dirNow);
    const need = neededSpan(anchorNow, dirNow, cfg.horizonDays, cfg.leadDays ?? 1);
    try {
      const window = paddedSpan(need, cfg.slackDays ?? 15);
      const order = dirNow === 'upcoming' ? 'forward' : 'backward';
      state = searchNow().get(window, order);
      // The second search waits for the first: they would share the page's time otherwise.
      const aux = state.done ? auxNow() : null;
      auxState = aux ? aux.get(window, order) : cfg.aux?.enabled(u) ? auxState : null;
    } catch (error) {
      state = null;
      status.textContent = '';
      listHost.replaceChildren(h('p', { class: 'sfe-message', role: 'alert' }, `${cfg.what} could not be computed: ${errorText(error)}`));
      builtKey = '';
      return;
    }
    const w = screenWords(s);
    shown = itemsFor(w);
    const zone = displayZone(s);
    const chips = shown.length ? chipsIn(ctx.engine, shown[0]!.start, shown[shown.length - 1]!.start) : false;
    const extra = cfg.watch?.(u) ?? [];
    const key = JSON.stringify([
      dirNow,
      zone,
      s.settings.angleFormat,
      s.settings.units,
      s.settings.hourCycle,
      chips,
      extra,
      cfg.card?.selected(u) ?? null,
      auxState ? auxState.items.length : -1,
      shown.map((i) => `${i.id}|${i.start}|${i.sentence}`),
    ]);
    if (key !== builtKey) {
      builtKey = key;
      const selected = cfg.card?.selected(u) ?? null;
      rows = shown.map((item) => {
        const extraRow = cfg.row?.(item, state!.items, s, u) ?? {};
        const row = eventRow({
          item,
          zone,
          timeInfo: rowTimeInfo(ctx.engine, item.start, chips),
          onJump: () => env.jump(item.jump, item.body ? { body: item.body } : {}),
          add: addToCalendarButton(ctx, ui, () => fileItem(item.id) ?? item, `${item.title}, ${w.dateYear(item.start)}`),
          onSelect: cfg.card ? () => cfg.card!.select(ui, selected === item.id ? null : item.id) : null,
          ...extraRow,
        });
        row.setSelected(item.id === selected);
        return { item, row };
      });
      const groups: HTMLElement[] = [];
      let year = '';
      let ol: HTMLOListElement | null = null;
      for (const r of rows) {
        const y = w.dateYear(r.item.start).replace(/^\S+ \S+ \S+ /, '');
        if (y !== year || !ol) {
          year = y;
          ol = h('ol', { class: 'sfe-ev2-list', 'aria-label': `${cfg.what}, ${y}` });
          groups.push(h('h3', { class: 'sfe-year' }, y), ol);
        }
        ol.append(r.row.el);
      }
      listHost.replaceChildren(...groups);
      figure = cfg.figure?.(state.items, shown, s, u) ?? null;
      figureHost.replaceChildren(...(figure ? [figure.el] : []));
      figureHost.hidden = !figure;
      if (!rows.length && state.done && !state.error) listHost.append(h('p', { class: 'sfe-message' }, cfg.empty(dirNow)));
      if (state.error) listHost.append(h('p', { class: 'sfe-message', role: 'alert' }, `${cfg.what} could not be computed: ${state.error}`));
      // Notes: the model's labels, the uncertainty of far dates, and a cut-short list.
      const noteEls: HTMLElement[] = (cfg.notes?.(state.items, s) ?? []).map((t) => h('p', { class: 'sfe-note' }, t));
      const unc = chips ? listUncertaintySentence(ctx.engine, shown.map((i) => i.start)) : '';
      if (unc) noteEls.push(h('p', { class: 'sfe-note sfe-note--dt' }, unc));
      if (state.truncated && state.done) {
        const edge = dirNow === 'upcoming' ? need.end : need.start;
        noteEls.push(truncatedNote(ctx, cfg.what, edge));
      }
      notes.replaceChildren(...noteEls);
      saveMenu.refresh();
    }
    const leadText = cfg.lead?.(state.items, shown, w, s, u) ?? '';
    if (lead.textContent !== leadText) lead.textContent = leadText;
    lead.hidden = !leadText;
    const searching = !state.done ? state : auxState && !auxState.done ? auxState : state;
    const statusText = state.error ? '' : searchStatus(searching, shown.length ? cfg.count(shown.length, dirNow) : '');
    if (status.textContent !== statusText) status.textContent = statusText;
    root.dataset.state = state.done && (!cfg.aux?.enabled(u) || auxState?.done) ? 'done' : 'searching';
    renderCard();
    markNext();
  };

  /** The item with the file's words, for one row's calendar button. */
  const fileItem = (id: string): EventItem | null => itemsFor(fileWords(ctx.store.get())).find((i) => i.id === id) ?? null;

  const markNext = (): void => {
    const now = ctx.store.get().time.jd_utc;
    const next = nextAfter(rows.map((r) => ({ jd_utc: r.item.start, r })), now);
    for (const r of rows) r.row.setNext(next?.r === r);
    card?.setNow?.(now);
    figure?.setNow?.(now);
  };

  const renderCard = (): void => {
    if (!cfg.card || !split) return;
    const id = cfg.card.selected(ui.get());
    const item = id ? shown.find((i) => i.id === id) ?? null : null;
    const want = item ? `${item.id}|${builtKey}` : `empty|${builtKey}`;
    if (card && card.id === want) {
      split.place(card.el, item ? rows.find((r) => r.item.id === item.id)?.row.anchor ?? null : null);
      return;
    }
    card?.destroy?.();
    card = null;
    let built: { el: HTMLElement; setNow?(jd: number): void; destroy?(): void } | null = null;
    if (item && state) built = cfg.card.build(item, state.items, env);
    if (!built) built = { el: h('div', { class: 'sfe-card sfe-card--empty' }, h('p', {}, cfg.card.empty)) };
    card = { ...built, id: want };
    split.place(card.el, item ? rows.find((r) => r.item.id === item.id)?.row.anchor ?? null : null);
  };
  d.add(() => card?.destroy?.());

  // --- Wiring -------------------------------------------------------------------------------
  const selectKey = (s: ExplorerState, u: EventsUi): string =>
    JSON.stringify([
      u.anchor,
      dir ? dir.get(u) : '',
      cfg.watch?.(u) ?? [],
      cfg.card?.selected(u) ?? null,
      s.observer.lat_deg,
      s.observer.lon_deg,
      s.observer.height_m,
      s.observer.zone,
      s.settings.timeDisplay,
      s.settings.angleFormat,
      s.settings.units,
      s.settings.hourCycle,
    ]);
  // `watch` also draws again after a data pack is loaded (component.ts redrawEverything).
  d.add(watch(ctx, (s) => selectKey(s, ui.get()), () => render()));
  let lastUi = selectKey(ctx.store.get(), ui.get());
  d.add(
    ui.subscribe(() => {
      const k = selectKey(ctx.store.get(), ui.get());
      if (k === lastUi) return;
      lastUi = k;
      ctx.scheduler.schedule(render);
    }),
  );
  // The time moves the "next" mark (and a card's "now") only.
  d.add(ctx.store.select((s) => s.time.jd_utc, () => ctx.scheduler.schedule(markNext)));
  d.add(() => {
    ctx.scheduler.cancel(render);
    ctx.scheduler.cancel(markNext);
  });
  return { destroy: () => d.dispose() };
}

/** A calendar id from a date, for tabs that name their events by kind and date. */
export { utcDate };
