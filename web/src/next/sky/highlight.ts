/**
 * Highlighting bodies in the Sky view from anywhere in the explorer — the hook for the
 * "tonight's star sights" recommendation (EXPLORER_PLAN §2). OWNER: sky agent.
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
 */

import type { Ctx } from '../component.js';

export interface SkyHighlights {
  get(): readonly string[];
  set(names: readonly string[]): void;
  subscribe(listener: (names: readonly string[]) => void): () => void;
}

const channels = new WeakMap<object, SkyHighlights>();

function createChannel(): SkyHighlights {
  let names: readonly string[] = [];
  const listeners = new Set<(names: readonly string[]) => void>();
  return {
    get: () => names,
    set(next) {
      const cleaned = [...new Set(next.map((n) => String(n).trim()).filter(Boolean))];
      if (cleaned.length === names.length && cleaned.every((n, i) => n === names[i])) return;
      names = Object.freeze(cleaned);
      for (const listener of [...listeners]) {
        try {
          listener(names);
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

/** Ring these bodies in the Sky view (replacing any earlier list); `[]` clears. */
export function highlightBodies(ctx: Pick<Ctx, 'store'>, names: readonly string[]): void {
  skyHighlights(ctx).set(names);
}
