/**
 * What the Events view's tabs share: the view's own state, the jump that sets the
 * explorer's time from a list, a frame-scheduled watcher over both stores, the pace of
 * background searches, and the searches two tabs share.
 * OWNER: eclipse agent (Events view); events2 agent (expansion programme Q4): the Moon and
 * Planets groups, meteors, the pace and the shared searches.
 */

import { watch, type Ctx, type Mounted } from '../component.js';
import { shallowEqual, type ExplorerState, type ObserverState, type Store } from '../state.js';
import type { Direction, EclipseKindFilter } from './model.js';
import type { SharedSearches } from './shared.js';

/** The view's tabs (the Moon and Planets tabs hold sub-tabs, `MoonSub` and `PlanetSub`). */
export type EventsTab = 'eclipses' | 'moon' | 'planets' | 'meteors' | 'seasons';

/** The Moon tab's parts. */
export type MoonSub = 'phases' | 'apsides' | 'occultations';

/** The Planets tab's parts. */
export type PlanetSub = 'events' | 'conjunctions' | 'retrograde' | 'transits' | 'jupiter';

/** How far the eclipse list reaches, in years. */
export type EclipseYears = 10 | 100 | 1000;


/** The view's own state (not shared, not persisted; kept per explorer while the page lives). */
export interface EventsUi {
  tab: EventsTab;
  moonSub: MoonSub;
  planetSub: PlanetSub;
  /** The instant the lists are built around (see view.ts). */
  anchor: number;
  eclipseDirection: Direction;
  /** How many years the eclipse list reaches: 10, 100 or 1000 (searched in ten-year pieces). */
  eclipseYears: EclipseYears;
  eclipseKind: EclipseKindFilter;
  /** Only eclipses something of which can be seen from the place. */
  seenOnly: boolean;
  /** The eclipse whose card is open (its id). */
  selected: string | null;
  planetDirection: Direction;
  /** The Moon's perigees and apogees: the next or the last twelve months. */
  apsisDirection: Direction;
  occultationDirection: Direction;
  /** Occultations: include those with the Moon below the horizon and elsewhere on Earth. */
  occultationsAll: boolean;
  /** The occultation whose card is open. */
  occultation: string | null;
  conjunctionDirection: Direction;
  /** Conjunctions shown: planet pairs, with the Moon, with bright stars. */
  conjunctionKinds: { planets: boolean; moon: boolean; stars: boolean };
  /** Only conjunctions that can be seen from the place in a dark sky. */
  conjunctionsSeenOnly: boolean;
  transitDirection: Direction;
  /** The transit whose card is open (its id). */
  transit: string | null;
  /** Jupiter's moons: only what can be seen from the place (Jupiter up, the sky dark). */
  jupiterSeenOnly: boolean;
  /** Meteor showers: the calendar year shown, or null for the explorer's year. */
  showerYear: number | null;
  /** The shower whose card is open (its code). */
  shower: string | null;
  /** Files name the place their local times are for (the Save menu's check box). */
  namePlace: boolean;
}

export interface JumpOptions {
  /** Select this body (`Sun`, `Moon`, `Mars`…). */
  body?: string;
  /** Move the place as well (the point of greatest eclipse). */
  observer?: Partial<ObserverState>;
}

/** What each tab is given. */
export interface TabEnv {
  ctx: Ctx;
  ui: Store<EventsUi>;
  /** Set the explorer's time (and body, and place) from this view, without moving the lists. */
  jump(jd: number, options?: JumpOptions): void;
  /**
   * How long a background search should wait before its next piece of work, in
   * milliseconds: 0 when the page is idle, longer while the time bar is being dragged or
   * playing, so a search never makes the frames of a drag late (brief2-wave2 "Performance").
   */
  pace(): number;
  /** Searches two tabs share (the conjunctions feed the occultations "elsewhere"). */
  shared: SharedSearches;
}

export type TabComponent = (host: HTMLElement, env: TabEnv) => Mounted;

/**
 * Call `render` in the next frame whenever `select` of the explorer's state and the view's
 * state changes (element by element), and once now.
 */
export function watchAll<T>(
  env: Pick<TabEnv, 'ctx' | 'ui'>,
  select: (s: ExplorerState, u: EventsUi) => T,
  render: (value: T) => void,
): () => void {
  let latest = select(env.ctx.store.get(), env.ui.get());
  const task = (): void => render(latest);
  const check = (): void => {
    const next = select(env.ctx.store.get(), env.ui.get());
    if (shallowEqual(next, latest)) return;
    latest = next;
    env.ctx.scheduler.schedule(task);
  };
  const a = env.ctx.store.subscribe(check);
  const b = env.ui.subscribe(check);
  // Draw again, with the latest value, after a data pack is loaded or the clock's form
  // changes (component.ts redrawEverything): the engine may now answer what it refused.
  const c = watch(env.ctx, () => 0, () => env.ctx.scheduler.schedule(task), { immediate: false });
  env.ctx.scheduler.schedule(task);
  return () => {
    a();
    b();
    c();
    env.ctx.scheduler.cancel(task);
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
