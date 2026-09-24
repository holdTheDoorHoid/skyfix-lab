/**
 * What the Events view's tabs share: the view's own state, the jump that sets the
 * explorer's time from a list, and a frame-scheduled watcher over both stores.
 * OWNER: eclipse agent (Events view).
 */

import type { Ctx, Mounted } from '../component.js';
import { shallowEqual, type ExplorerState, type ObserverState, type Store } from '../state.js';
import type { Direction, EclipseKindFilter } from './model.js';

export type EventsTab = 'eclipses' | 'moon' | 'seasons' | 'planets';

/** The view's own state (not shared, not persisted; kept per explorer while the page lives). */
export interface EventsUi {
  tab: EventsTab;
  /** The instant the lists are built around (see view.ts). */
  anchor: number;
  eclipseDirection: Direction;
  eclipseKind: EclipseKindFilter;
  /** Only eclipses something of which can be seen from the place. */
  seenOnly: boolean;
  /** The eclipse whose card is open (its id). */
  selected: string | null;
  planetDirection: Direction;
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
  env.ctx.scheduler.schedule(task);
  return () => {
    a();
    b();
    env.ctx.scheduler.cancel(task);
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
