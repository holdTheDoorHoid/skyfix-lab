/**
 * What every part of the Navigate view shares: the explorer's context, the working
 * session, the engine's navigation tools and the session adapter, the live reductions,
 * the map service, and small helpers for the person's display choices. OWNER: navigate
 * agent.
 */

import type { SkyfixApi } from '../../api/adapter.js';
import type { Ctx } from '../component.js';
import { offeredForSights } from '../engine/bodies.js';
import type { SightBodyInfo } from '../engine/types.js';
import type { NavTools } from '../engine/wasm-nav.js';
import type { MapService } from '../map/overlays.js';
import { displayZone, displayZoneAt, type AngleFormat } from '../state.js';
import type { Store } from '../state.js';
import type { Zone } from '../time.js';
import type { Reductions } from './reductions.js';
import type { WorkingHandle } from './working.js';

export interface NavCtx {
  readonly ctx: Ctx;
  readonly working: WorkingHandle;
  readonly api: SkyfixApi;
  readonly nav: NavTools | null;
  /** Why there are no navigation tools (a stale WASM package), or null. */
  readonly navMissing: string | null;
  readonly reductions: Store<Reductions>;
  readonly overlays: MapService | null;
  /** Bodies offered for sights: Sun, Moon, Venus, Mars, Jupiter, Saturn, the 58 stars. */
  readonly bodies: readonly SightBodyInfo[];
  /**
   * A short message in the view's status line (for example "Loaded example …"), with an
   * Undo button when `undo` is given (navigate2: the passage handed to the running fix).
   */
  say(text: string, level?: 'info' | 'caution' | 'error', undo?: () => void): void;
}

export function angleFormat(nc: NavCtx): AngleFormat {
  return nc.ctx.store.get().settings.angleFormat;
}

export function zone(nc: NavCtx, jd?: number | null): Zone {
  // navigate2 (time-ui, CONVENTIONS 15.3): with an instant, the zone of that instant, so a
  // sight's time is shown in the zone of its own date: before 1850 a zone that follows the
  // place is local mean time at its longitude, whatever the time bar shows.
  const s = nc.ctx.store.get();
  return typeof jd === 'number' && Number.isFinite(jd) ? displayZoneAt(s, jd) : displayZone(s);
}

/** The bodies the view offers for sights (EXPLORER_PLAN 3.3: validated or labelled). */
export function sightBodiesFor(ctx: Ctx, nav: NavTools | null): SightBodyInfo[] {
  if (nav) {
    try {
      return nav.sightBodies();
    } catch {
      // fall through to the explorer's own list
    }
  }
  const coverage = ctx.engine.coverage();
  return ctx.engine
    .bodies()
    .filter((b) => offeredForSights(b, coverage))
    .map((b) => ({ body: b.body, kind: b.kind }));
}

export function kindOf(nc: NavCtx, body: string): SightBodyInfo['kind'] {
  const key = body.trim().toLowerCase();
  const hit = nc.bodies.find((b) => b.body.toLowerCase() === key);
  if (hit) return hit.kind;
  if (key === 'sun') return 'sun';
  if (key === 'moon') return 'moon';
  if (['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'].includes(key)) return 'planet';
  return 'star';
}

/** Sun and Moon have a disc, so their sights say which edge (limb) was used. */
export function hasDisc(kind: SightBodyInfo['kind']): boolean {
  return kind === 'sun' || kind === 'moon';
}
