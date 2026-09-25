/**
 * The Events view's background searches, kept while the page lives (per explorer), so a
 * tab switched away from and back, or the view left and reopened, shows what was found at
 * once. Each search is named, and keyed by everything its answers depend on besides the
 * window (the place, the options): a new key starts it afresh. OWNER: events2 agent.
 */

import type { ExplorerStore } from '../state.js';
import { BackgroundSearch, type SearchOptions } from './search.js';

interface Slot {
  key: string;
  search: BackgroundSearch<unknown>;
}

export class SharedSearches {
  private readonly slots = new Map<string, Slot>();
  /** How long a search waits before its next chunk; the mounted view sets it. */
  pace: () => number = () => 0;

  /**
   * The search called `name` for `key`, made by `make` the first time or when the key
   * changed (the old one is dropped). `make`'s options get this registry's pace.
   */
  search<T>(name: string, key: string, make: (pace: () => number) => SearchOptions<T>): BackgroundSearch<T> {
    const slot = this.slots.get(name);
    if (slot && slot.key === key) return slot.search as BackgroundSearch<T>;
    slot?.search.destroy();
    const search = new BackgroundSearch<T>(make(() => this.pace()));
    this.slots.set(name, { key, search: search as BackgroundSearch<unknown> });
    return search;
  }

  /** Stop every search's pending work (the view is closed); results are kept. */
  pause(): void {
    for (const slot of this.slots.values()) slot.search.pause();
  }

  /** Forget every result (a data pack was loaded: the engine now answers more). */
  clear(): void {
    for (const slot of this.slots.values()) slot.search.destroy();
    this.slots.clear();
  }
}

const perStore = new WeakMap<ExplorerStore, SharedSearches>();

/** The searches of the explorer that owns `store`. */
export function sharedSearches(store: ExplorerStore): SharedSearches {
  let shared = perStore.get(store);
  if (!shared) perStore.set(store, (shared = new SharedSearches()));
  return shared;
}
