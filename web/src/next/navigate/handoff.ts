/**
 * Sessions handed to the Navigate view by another view (Learn's Simulator: "Open in
 * Navigate"). OWNER: navigate agent (added by the polish pass).
 *
 * Rules
 * - A hand-off carries the SESSION and nothing else of a simulated run: the solver's own
 *   input. The simulated truth (the answer key) has no field here and is never passed.
 * - The session arrives labelled SIMULATED (`meta.kind = 'simulated'`) whatever it said.
 * - It waits here, per explorer page, until the Navigate view mounts and takes it; the view
 *   loads it the way it loads an example, with Undo, so the person's own sights are never
 *   lost without a way back.
 */

import type { Session } from '../../types.js';
import type { EphemerisMode } from '../engine/types.js';
import type { SolveForm } from './model.js';

export interface NavigateHandoff {
  /** What the solver was given: sights, observer, instrument, clock. Never the truth. */
  session: Session;
  /** Where it came from, for the message ("the Learn simulator's “Three stars”"). */
  from: string;
  /** Where directions come from, as the sender solved it. */
  mode: EphemerisMode;
  /** The solver switches the sender used, so the fix there is the fix here. */
  solve?: Partial<SolveForm>;
}

const pending = new WeakMap<object, NavigateHandoff>();

/** Leave a session for the Navigate view of this explorer page (the latest one wins). */
export function handOffToNavigate(store: object, handoff: NavigateHandoff): void {
  const session = structuredClone(handoff.session);
  session.meta = { ...session.meta, kind: 'simulated' };
  pending.set(store, { ...handoff, session });
}

/** The session waiting for this page's Navigate view, removed as it is taken. */
export function takeNavigateHandoff(store: object): NavigateHandoff | null {
  const handoff = pending.get(store) ?? null;
  pending.delete(store);
  return handoff;
}
