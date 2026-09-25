/**
 * Live reduction of every sight in the working session: the correction workings shown next
 * to each sight, recomputed by the core (`reduce`) a moment after the session or the
 * direction source changes. OWNER: navigate agent.
 */

import type { ReduceEntry, SkyfixApi } from '../../api/adapter.js';
import type { Session } from '../../types.js';
import type { EphemerisMode } from '../engine/types.js';
import { createStore, type Store } from '../state.js';
import { debounce, errorText } from './ui.js';
import type { WorkingStore } from './working.js';

export interface Reductions {
  /** By observation id. */
  byId: ReadonlyMap<string, ReduceEntry>;
  /** The session these reductions are for (identity: compare with the working session). */
  session: Session | null;
  mode: EphemerisMode;
  /** The whole call failed (a malformed session), with the core's message. */
  error: string | null;
  pending: boolean;
}

/**
 * The reductions once they are `session`'s and settled, or whatever there is after `ms`
 * (polish2). A fix is solved separately from the per-sight reductions (which wait `delayMs`
 * and run on their own), so right after the fix appears its sights may not be reduced yet:
 * the printables asked then had a plotting sheet and no worksheets.
 */
export function settledReductions(store: Store<Reductions>, session: Session, ms = 5000): Promise<Reductions> {
  const ready = (r: Reductions): boolean => !r.pending && r.session === session;
  if (ready(store.get())) return Promise.resolve(store.get());
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stop();
      resolve(store.get());
    };
    const stop = store.subscribe((r) => {
      if (ready(r)) finish();
    });
    const timer = setTimeout(finish, ms);
  });
}

export function createReductions(working: WorkingStore, api: SkyfixApi, delayMs = 120): { store: Store<Reductions>; dispose(): void; now(): void } {
  const store = createStore<Reductions>({ byId: new Map(), session: null, mode: working.get().mode, error: null, pending: true });
  let seq = 0;
  const run = async (): Promise<void> => {
    const my = ++seq;
    const { session, mode } = working.get();
    try {
      const entries = await api.reduce(session, mode);
      if (my !== seq) return;
      const byId = new Map<string, ReduceEntry>();
      entries.forEach((e, i) => byId.set(e.status === 'ok' ? e.sight.id : e.id ?? session.observations[i]?.id ?? String(i), e));
      store.set({ byId, session, mode, error: null, pending: false });
    } catch (error) {
      if (my !== seq) return;
      store.set({ byId: new Map(), session, mode, error: errorText(error), pending: false });
    }
  };
  const d = debounce(() => void run(), delayMs);
  const stop = working.select(
    (w) => [w.session, w.mode] as const,
    () => {
      store.patch({ pending: true });
      d.run();
    },
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );
  d.now();
  return {
    store,
    now: () => d.now(),
    dispose() {
      stop();
      d.cancel();
      seq += 1;
    },
  };
}
