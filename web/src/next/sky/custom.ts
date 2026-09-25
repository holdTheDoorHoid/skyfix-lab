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
 * No credit line (verify2): nothing on screen credits anything but OpenStreetMap
 * (EXPANSION_PLAN, "Data credit"). The worked example's values are JPL's Small-Body
 * Database's, which asks for none (THIRD_PARTY.md, verify2), and elements the person pastes
 * are theirs to bring: the explorer does not ship them, so it owes no line for them.
 */

import type { Ctx } from '../component.js';
import type { OrbitalElements } from '../engine/types.js';

export interface CustomBodies {
  get(): readonly OrbitalElements[];
  /** Add or replace (by name) these bodies; `credit` is shown wherever they are described. */
  add(bodies: readonly OrbitalElements[], credit?: string): void;
  /** The credit line given with a body when it was added, or '' (none is given today). */
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
      return credits.get(body.name) ?? '';
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

/** True when the elements came from one of the Minor Planet Center's formats. */
export function fromMpc(body: Pick<OrbitalElements, 'source'>): boolean {
  return body.source === 'mpcorb' || body.source === 'mpc_comet';
}


/**
 * A worked example for the add dialog: (1) Ceres as typed-in elements, JPL's Small-Body
 * Database solution (JPL 48 of 2021-04-13) at epoch JD 2461200.5 TDB, rounded
 * (verify2: they were the Minor Planet Center's, which asks for an on-screen credit; the
 * two orbits agree to every digit shown but the time of perihelion, which is JPL's next
 * passage rather than the MPC's last, and G, 0.12 against 0.15).
 */
export const CUSTOM_EXAMPLE = `{"name": "(1) Ceres", "class": "asteroid", "epoch_jd_tt": 2461200.5,
 "q_au": 2.545159, "e": 0.079692, "i_deg": 10.58803, "node_deg": 80.24863,
 "peri_deg": 73.2942, "tp_jd_tt": 2461599.841467, "h": 3.34, "g": 0.12}`;
