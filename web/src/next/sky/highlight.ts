/**
 * Highlighting bodies in the Sky view from anywhere in the explorer — the hook for the
 * "tonight's star sights" recommendation (EXPLORER_PLAN §2). OWNER: sky agent; sources and
 * `ringWhileShown` added by the sky2 agent.
 *
 * ```ts
 * import { highlightBodies } from '../sky/index.js';
 * highlightBodies(ctx, ['Vega', 'Arcturus', 'Jupiter']);   // ring them in the Sky view
 * highlightBodies(ctx, []);                                 // clear
 * ```
 *
 * One channel per explorer store (so tests and several pages never share one), and it
 * outlives the Sky view: a list set while another view is showing is drawn when the sky
 * is opened. Names are canonical body names or star-field proper names, matched without
 * regard to case; unknown names are ignored when drawn.
 *
 * Sources (sky2 agent): each caller may keep its own list under a name (`source`); the
 * Sky view rings the union, so the panel's Tonight's sights and a developer's list do not
 * clear each other. The default source is `'default'`.
 */

import type { Ctx } from '../component.js';

export interface SkyHighlights {
  /** The union of every source's names, first seen first. */
  get(): readonly string[];
  set(names: readonly string[], source?: string): void;
  subscribe(listener: (names: readonly string[]) => void): () => void;
}

const channels = new WeakMap<object, SkyHighlights>();

function createChannel(): SkyHighlights {
  const sources = new Map<string, readonly string[]>();
  let union: readonly string[] = [];
  const listeners = new Set<(names: readonly string[]) => void>();
  return {
    get: () => union,
    set(next, source = 'default') {
      const cleaned = [...new Set(next.map((n) => String(n).trim()).filter(Boolean))];
      const old = sources.get(source) ?? [];
      if (cleaned.length === old.length && cleaned.every((n, i) => n === old[i])) return;
      if (cleaned.length) sources.set(source, cleaned);
      else sources.delete(source);
      union = Object.freeze([...new Set([...sources.values()].flat())]);
      for (const listener of [...listeners]) {
        try {
          listener(union);
        } catch (error) {
          console.error('sky highlight listener failed', error);
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The highlight channel of this explorer (keyed by its store). */
export function skyHighlights(ctx: Pick<Ctx, 'store'>): SkyHighlights {
  let channel = channels.get(ctx.store);
  if (!channel) {
    channel = createChannel();
    channels.set(ctx.store, channel);
  }
  return channel;
}

/** Ring these bodies in the Sky view (replacing any earlier list of the same source); `[]` clears. */
export function highlightBodies(ctx: Pick<Ctx, 'store'>, names: readonly string[], source = 'default'): void {
  skyHighlights(ctx).set(names, source);
}

/**
 * Ring a list in the Sky view only while `host` — a section of the side panel — is on
 * screen: the panel open on a wide screen, the bottom sheet above its smallest rest on a
 * phone (the shell's `data-panel` and `data-sheet` on `.sf-app`). Outside the shell (a
 * developer page) it counts as shown. `set` replaces the list; `destroy` clears it.
 */
export function ringWhileShown(ctx: Pick<Ctx, 'store'>, host: HTMLElement, source: string): { set(names: readonly string[]): void; destroy(): void } {
  let names: readonly string[] = [];
  let alive = true;
  const app = host.closest<HTMLElement>('.sf-app');
  const phone = typeof matchMedia === 'function' ? matchMedia('(max-width: 767px)') : null;
  const shown = (): boolean => {
    if (!app) return true;
    if (app.dataset.panel === 'closed') return false;
    return !(phone?.matches && app.dataset.sheet === 'min');
  };
  const apply = (): void => {
    if (alive) highlightBodies(ctx, shown() ? names : [], source);
  };
  const observer = app && typeof MutationObserver === 'function' ? new MutationObserver(apply) : null;
  observer?.observe(app!, { attributes: true, attributeFilter: ['data-panel', 'data-sheet'] });
  phone?.addEventListener?.('change', apply);
  return {
    set(next) {
      names = [...next];
      apply();
    },
    destroy() {
      if (!alive) return;
      alive = false;
      observer?.disconnect();
      phone?.removeEventListener?.('change', apply);
      highlightBodies(ctx, [], source);
    },
  };
}
