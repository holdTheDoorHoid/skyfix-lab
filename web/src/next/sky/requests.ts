/**
 * Asking the Sky view to show something, from anywhere in the explorer. OWNER: sky2 agent
 * (expansion Q3). Deliberately tiny, with no drawing code, so another view (Tonight, the
 * Selected card) can import it without loading the Sky view.
 *
 * ```ts
 * import { showInSky, openUpClose } from '../sky/requests.js';
 * showInSky(ctx, { kind: 'deep_sky', id: 'M31' });       // opens Sky, centred on M31, its card open
 * showInSky(ctx, { kind: 'shower', id: 'PER' });         // the Perseids' radiant
 * showInSky(ctx, { kind: 'body', id: 'Jupiter' });       // selects Jupiter
 * showInSky(ctx, { kind: 'point', id: 'Galactic centre', ra_j2000_deg: 266.405, dec_j2000_deg: -28.936 });
 * openUpClose(ctx, 'Moon');                              // opens Sky with the Moon's close-up
 * openUpClose(ctx, 'Moon', { features: ['Copernicus'] }); // …with these features marked
 * ```
 *
 * One request is kept per explorer (keyed by its store) until the Sky view takes it, so
 * a request made before the view has loaded is carried out when it mounts. The view is
 * switched to Sky here; a request for something the engine does not know is shown as a
 * notice by the view, not thrown.
 */

import type { Ctx } from '../component.js';

/**
 * What to show: the kinds of `sky_search` hits (EXPLORER_API "deep sky"), a catalogue star
 * by index, an added comet or asteroid, or any direction by its J2000 place (`point`).
 */
export type SkyTargetKind = 'body' | 'star' | 'deep_sky' | 'constellation' | 'shower' | 'custom' | 'point';

export interface SkyTarget {
  kind: SkyTargetKind;
  /**
   * `body`: a canonical name ("Moon", "Vega"); `star`: "HR 7001" or a star-field index as
   * text ("6988"); `deep_sky`: an id or cross id ("M31", "NGC 224"); `constellation`: an IAU
   * abbreviation ("Ori"); `shower`: an IAU code ("PER"); `custom`: an added body's name;
   * `point`: the name the Sky view shows beside the mark ("Galactic centre").
   */
  id: string;
  /** `point` only: the direction, ICRS (J2000) degrees; carried to the frame of date by the view. */
  ra_j2000_deg?: number;
  dec_j2000_deg?: number;
}

export interface SkyRequest {
  target: SkyTarget | null;
  /** Open the "Up close" inset for this body (the Moon or a planet). */
  upClose: string | null;
  /** The Moon's close-up: named features to mark (the Selected card's list), or empty. */
  features?: string[];
  /** Turn the panorama to face the target (default true; the dome rings it). */
  face: boolean;
  /** Increases with every request, so the same request made twice is carried out twice. */
  seq: number;
}

export interface SkyRequests {
  /** The pending request, or null. */
  peek(): SkyRequest | null;
  /** Take the pending request (the Sky view does this). */
  take(): SkyRequest | null;
  post(request: Omit<SkyRequest, 'seq'>): void;
  subscribe(listener: () => void): () => void;
}

const channels = new WeakMap<object, SkyRequests>();
let seq = 0;

function createChannel(): SkyRequests {
  let pending: SkyRequest | null = null;
  const listeners = new Set<() => void>();
  return {
    peek: () => pending,
    take() {
      const r = pending;
      pending = null;
      return r;
    },
    post(request) {
      seq += 1;
      pending = { ...request, seq };
      for (const fn of [...listeners]) {
        try {
          fn();
        } catch (error) {
          console.error('sky request listener failed', error);
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

/** This explorer's request channel. */
export function skyRequests(ctx: Pick<Ctx, 'store'>): SkyRequests {
  let channel = channels.get(ctx.store);
  if (!channel) {
    channel = createChannel();
    channels.set(ctx.store, channel);
  }
  return channel;
}

/** Open the Sky view centred on `target` (panorama: faced; dome: ringed, with its card). */
export function showInSky(ctx: Pick<Ctx, 'store'>, target: SkyTarget, options: { face?: boolean } = {}): void {
  skyRequests(ctx).post({ target, upClose: null, face: options.face ?? true });
  if (ctx.store.get().view !== 'sky') ctx.store.patch({ view: 'sky' });
}

/**
 * Open the Sky view with the "Up close" inset of the Moon or a planet (and select it);
 * for the Moon, `features` (names from `moon_features`) are marked on the disc.
 */
export function openUpClose(ctx: Pick<Ctx, 'store'>, body: string, options: { features?: readonly string[] } = {}): void {
  skyRequests(ctx).post({ target: { kind: 'body', id: body }, upClose: body, face: true, features: [...(options.features ?? [])] });
  if (ctx.store.get().view !== 'sky') ctx.store.patch({ view: 'sky' });
}
