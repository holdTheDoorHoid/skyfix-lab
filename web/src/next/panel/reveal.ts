/**
 * Asking the shell to bring the panel into view (polish2, expansion programme list item 38):
 * a view that opens something in the panel (Tonight's "Plan a photo" opens the Milky Way
 * planner on the Selected card) calls `revealPanel(store)`. On a laptop the shell opens a
 * hidden panel; on a phone it raises the bottom sheet from its smallest rest to half the
 * screen (or to `full`), never lowering it. A per-explorer channel keyed by the store, as
 * `sky/sky-link.ts` and `events/link.ts` are: light, so any view can import it.
 */

export type PanelRest = 'peek' | 'full';

const channels = new WeakMap<object, Set<(to: PanelRest) => void>>();

/** Bring the panel into view: open it (laptop) or raise the sheet to at least `to` (phone). */
export function revealPanel(store: object, to: PanelRest = 'peek'): void {
  for (const fn of [...(channels.get(store) ?? [])]) {
    try {
      fn(to);
    } catch (error) {
      console.error('revealPanel listener failed', error);
    }
  }
}

/** The shell's side: called for each request. Returns the stop function. */
export function onRevealPanel(store: object, fn: (to: PanelRest) => void): () => void {
  let set = channels.get(store);
  if (!set) channels.set(store, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}
