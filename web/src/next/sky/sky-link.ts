/**
 * "Show in Sky" from the Tonight view. OWNER: tonight agent (expansion programme Q2); moved
 * here from tonight/ by the sky2 agent, whose Sky view reads the channel.
 *
 * `showInSky` moves the explorer to the moment (the object's best time), selects the body
 * when there is one and rings it (highlight.ts), opens the Sky view, and posts the target
 * on a per-explorer channel, `skyTargets(ctx)`. The channel outlives the views, like the
 * highlight channel, so a target set here is waiting when the Sky view mounts. The Sky view
 * takes it (`take`) once the sky has reached the moment: it centres the dome on the target
 * (zoomed in if it showed the whole sky; the panorama turns to face it), opens its card,
 * and for `inset` the body's "Up close" panel (targets.ts says how each kind is shown).
 *
 * The Sky view's own requests (requests.ts: `showInSky(ctx, target)`, `openUpClose`) do the
 * same without moving the time; this form is for callers that pick the moment.
 */

import type { Ctx } from '../component.js';
import { setTime } from '../playback.js';
import { highlightBodies } from './highlight.js';

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
  /** The pending target, cleared without telling the listeners (the Sky view carries it out). */
  take(): TimedSkyTarget | null;
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
      take() {
        const target = current;
        current = null;
        return target;
      },
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
