/**
 * Picking one point on the map for another part of the page. Added to the map module by the
 * photo agent (expansion programme Q8, append-only): the Selected card's alignment finder
 * asks "click the point the bearing should run to" and gets the point clicked, so a street,
 * a mountain or a window can give the direction from the place.
 *
 * One picker per page (per store), found with `mapPickerFor(ctx)`, like the map service
 * (`mapServiceFor`). While a pick waits, the map's next click (a tap, or a press and hold, on
 * a touch screen) goes to it instead of setting the place; the map shows the request's
 * sentence with a Cancel button, and Escape cancels. A newer request cancels an older one.
 * The pick exists without a map on screen: the map shows the prompt when it mounts.
 *
 * The map view calls `offer(point)` first thing in its click handling and
 * `attachPickPrompt(root, ctx)` once (map-view.ts, the lines marked "photo agent").
 */

import './pick.css';
import type { Ctx } from '../component.js';
import type { LatLonDeg } from '../engine/types.js';

export interface PickRequest {
  /** What the map says while it waits, as a sentence: "Click the point the bearing should run to." */
  prompt: string;
  /** Called once with the point clicked (longitude in (−180, 180]); the pick then ends. */
  onPick(point: LatLonDeg): void;
  /** Called when the pick ends without a point: Cancel, Escape, a newer request, or `cancel()`. */
  onCancel?(): void;
}

export interface MapPicker {
  /** Wait for one click on the map. Returns the function that cancels this request. */
  request(req: PickRequest): () => void;
  /** The pick waiting for a click, or null. */
  active(): PickRequest | null;
  /**
   * For the map view: a click at `point`. True when a pick took it (the map then does
   * nothing else with the click); false when no pick is waiting.
   */
  offer(point: LatLonDeg): boolean;
  /** End the waiting pick, if any, without a point. */
  cancel(): void;
  /** Called whenever a pick starts or ends. Returns the stop function. */
  subscribe(listener: () => void): () => void;
}

function wrapLon(lon: number): number {
  const x = (((lon + 180) % 360) + 360) % 360 - 180;
  return x === -180 ? 180 : x;
}

/** The picker, without a DOM: exported for tests. */
export function createMapPicker(): MapPicker {
  let current: PickRequest | null = null;
  const listeners = new Set<() => void>();
  const emit = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error('map pick listener failed', error);
      }
    }
  };
  const end = (req: PickRequest, point: LatLonDeg | null): void => {
    if (current !== req) return;
    current = null;
    emit();
    if (point) req.onPick(point);
    else req.onCancel?.();
  };
  return {
    request(req) {
      const previous = current;
      current = req;
      if (previous) previous.onCancel?.();
      emit();
      return () => end(req, null);
    },
    active: () => current,
    offer(point) {
      const req = current;
      if (!req || !Number.isFinite(point.lat_deg) || !Number.isFinite(point.lon_deg)) return false;
      end(req, { lat_deg: Math.max(-90, Math.min(90, point.lat_deg)), lon_deg: wrapLon(point.lon_deg) });
      return true;
    },
    cancel() {
      if (current) end(current, null);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const pickers = new WeakMap<object, MapPicker>();

/** The map picker of the page `ctx` belongs to (one per store). */
export function mapPickerFor(ctx: Pick<Ctx, 'store'>): MapPicker {
  let p = pickers.get(ctx.store);
  if (!p) {
    p = createMapPicker();
    pickers.set(ctx.store, p);
  }
  return p;
}

/**
 * For the map view: while a pick waits, a floating line at the top of the map with the
 * request's sentence and a Cancel button, a crosshair cursor (`sfm--picking` on `root`),
 * and Escape to cancel. Returns the clean-up function.
 */
export function attachPickPrompt(root: HTMLElement, ctx: Pick<Ctx, 'store'>): () => void {
  const picker = mapPickerFor(ctx);
  const box = document.createElement('div');
  box.className = 'sfm-pick sf-float sf-on-stage';
  box.setAttribute('role', 'status');
  box.hidden = true;
  const text = document.createElement('p');
  text.className = 'sfm-pick__text';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sf-btn sf-btn--secondary sf-btn--sm';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => picker.cancel());
  box.append(text, cancel);
  root.appendChild(box);
  const sync = (): void => {
    const req = picker.active();
    box.hidden = !req;
    root.classList.toggle('sfm--picking', Boolean(req));
    if (req && text.textContent !== req.prompt) text.textContent = req.prompt;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && picker.active()) {
      e.preventDefault();
      picker.cancel();
    }
  };
  document.addEventListener('keydown', onKey);
  const stop = picker.subscribe(sync);
  sync();
  return () => {
    stop();
    document.removeEventListener('keydown', onKey);
    root.classList.remove('sfm--picking');
    box.remove();
  };
}
