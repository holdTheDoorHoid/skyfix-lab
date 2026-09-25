/**
 * Comets and asteroids the person adds from orbital elements, for the Sky view.
 * OWNER: sky2 agent (expansion Q3).
 *
 * The elements come from the planet-detail engine's `parse_orbits` (MPC one-line formats
 * or JSON; EXPLORER_API "planet detail") and are kept per explorer (keyed by its store)
 * for the page session only, like the Sky view's own settings: nothing is written to
 * storage (state.ts privacy rules), and a reload forgets them. Each frame the Sky view
 * asks `custom_body_states` for their places.
 *
 * The Minor Planet Center asks that "Source: Minor Planet Center" accompany its data: a
 * body read from an MPC format carries that line wherever it is described.
 */

import type { Ctx } from '../component.js';
import type { OrbitalElements } from '../engine/types.js';

export interface CustomBodies {
  get(): readonly OrbitalElements[];
  /** Add or replace (by name) these bodies; `credit` is shown wherever they are described. */
  add(bodies: readonly OrbitalElements[], credit?: string): void;
  /** The credit line for a body: its own, or the MPC's for a body read from an MPC format. */
  creditOf(body: OrbitalElements): string;
  remove(name: string): void;
  clear(): void;
  subscribe(listener: (bodies: readonly OrbitalElements[]) => void): () => void;
}

const channels = new WeakMap<object, CustomBodies>();

/** At most this many bodies at once (each is a two-body solution a frame). */
export const MAX_CUSTOM_BODIES = 20;

function createChannel(): CustomBodies {
  let list: readonly OrbitalElements[] = [];
  const credits = new Map<string, string>();
  const listeners = new Set<(bodies: readonly OrbitalElements[]) => void>();
  const emit = (next: readonly OrbitalElements[]): void => {
    list = Object.freeze([...next]);
    for (const fn of [...listeners]) {
      try {
        fn(list);
      } catch (error) {
        console.error('custom bodies listener failed', error);
      }
    }
  };
  return {
    get: () => list,
    add(bodies, credit) {
      const names = new Set(bodies.map((b) => b.name));
      for (const b of bodies) {
        if (credit) credits.set(b.name, credit);
        else credits.delete(b.name);
      }
      emit([...list.filter((b) => !names.has(b.name)), ...bodies].slice(-MAX_CUSTOM_BODIES));
    },
    creditOf(body) {
      return credits.get(body.name) ?? (fromMpc(body) ? MPC_CREDIT : '');
    },
    remove(name) {
      if (list.some((b) => b.name === name)) emit(list.filter((b) => b.name !== name));
    },
    clear() {
      if (list.length) emit([]);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** This explorer's added bodies. */
export function customBodies(ctx: Pick<Ctx, 'store'>): CustomBodies {
  let channel = channels.get(ctx.store);
  if (!channel) {
    channel = createChannel();
    channels.set(ctx.store, channel);
  }
  return channel;
}

/** The line the Minor Planet Center asks to accompany its data. */
export const MPC_CREDIT = 'Source: Minor Planet Center';

/** True when the elements came from one of the Minor Planet Center's formats. */
export function fromMpc(body: Pick<OrbitalElements, 'source'>): boolean {
  return body.source === 'mpcorb' || body.source === 'mpc_comet';
}


/**
 * A worked example for the add dialog: (1) Ceres as typed-in elements (the values of the
 * API document's `parse_orbits` example, from the Minor Planet Center's MPCORB).
 */
export const CUSTOM_EXAMPLE = `{"name": "(1) Ceres", "class": "asteroid", "epoch_jd_tt": 2461200.5,
 "q_au": 2.545159, "e": 0.079692, "i_deg": 10.58803, "node_deg": 80.24863,
 "peri_deg": 73.2942, "tp_jd_tt": 2459919.988326, "h": 3.34, "g": 0.15}`;

/** Credit line shown with the example (its values are the MPC's). */
export const CUSTOM_EXAMPLE_CREDIT = 'Example values: Source: Minor Planet Center.';
