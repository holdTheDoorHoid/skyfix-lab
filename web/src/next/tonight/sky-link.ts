/**
 * "Show in Sky" from the Tonight view. OWNER: tonight agent (expansion programme Q2).
 *
 * `showInSky` moves the explorer to the moment (the object's best time), selects the body
 * when there is one and rings it (sky/highlight.ts), opens the Sky view, and posts the
 * target on a per-explorer channel, `skyTargets(ctx)`, that the Sky view can read to centre
 * on it and open an inset (a deep-sky object, a meteor radiant, the Moon "up close"). The
 * channel outlives the views, like the highlight channel, so a target set here is waiting
 * when the Sky view mounts. Until the Sky view reads it (the sky2 package: search and centre,
 * the eyepiece insets), the Sky view opens at that moment with the body ringed, and the card
 * the person came from has already said where to look.
 */

import type { Ctx } from '../component.js';
import { setTime } from '../playback.js';
import { highlightBodies } from '../sky/highlight.js';

export type SkyTarget =
  /** A body of the engine's list; `inset` asks for its close-up (the Moon, Jupiter, Saturn). */
  | { kind: 'body'; name: string; inset?: boolean }
  /** A deep-sky object of `dso_catalog` (its id, as `dso_visibility` takes it). */
  | { kind: 'deep_sky'; id: string; label: string; ra_j2000_deg: number | null; dec_j2000_deg: number | null }
  /** A meteor shower's radiant (J2000, as `ShowerNight` gives it). */
  | { kind: 'radiant'; code: string; label: string; ra_j2000_deg: number; dec_j2000_deg: number }
  /** A direction on the sky at the target's moment (the Milky Way's core). */
  | { kind: 'direction'; label: string; alt_deg: number; az_deg: number };

/** A target with the moment it was asked for. */
export type TimedSkyTarget = SkyTarget & { jd_utc: number | null };

export interface SkyTargets {
  get(): TimedSkyTarget | null;
  set(target: TimedSkyTarget | null): void;
  subscribe(listener: (target: TimedSkyTarget | null) => void): () => void;
}

const channels = new WeakMap<object, SkyTargets>();

/** The explorer's channel (keyed by its store), created on first use. */
export function skyTargets(ctx: Pick<Ctx, 'store'>): SkyTargets {
  let channel = channels.get(ctx.store);
  if (!channel) {
    let current: TimedSkyTarget | null = null;
    const listeners = new Set<(t: TimedSkyTarget | null) => void>();
    channel = {
      get: () => current,
      set(target) {
        current = target;
        for (const listener of [...listeners]) {
          try {
            listener(current);
          } catch (error) {
            console.error('sky target listener failed', error);
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
    channels.set(ctx.store, channel);
  }
  return channel;
}

/** Open the Sky view on a target at a moment (`jd` null: keep the explorer's time). */
export function showInSky(ctx: Pick<Ctx, 'store'>, target: SkyTarget, jd: number | null): void {
  const { store } = ctx;
  store.batch(() => {
    if (jd !== null && Number.isFinite(jd)) setTime(store, jd);
    if (target.kind === 'body') store.patch({ selection: { body: target.name } });
    store.patch({ view: 'sky' });
  });
  highlightBodies(ctx, target.kind === 'body' ? [target.name] : []);
  skyTargets(ctx).set({ ...target, jd_utc: jd });
}
