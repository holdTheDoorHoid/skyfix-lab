/**
 * The passage at page level, whether or not the Navigate view is open (OWNER: navigate2
 * agent): the map's measuring tool offers "Add as a leg of the passage" (map/measure.ts's
 * action registry), and the route, its dead-reckoning marks and "DR now" stay drawn on the
 * map (passage/overlay.ts) from the working session,
 * which autosave may have kept. Installed once per page by the side panel's star-sights
 * slot and by the Navigate view (`installPassage`), so it exists with either.
 */

import type { Ctx } from '../../component.js';
import { isSailingsEngine, type SailingsEngine } from '../../engine/types.js';
import { greatCircleDistanceNm } from '../../geo/greatcircle.js';
import { registerMeasureAction } from '../../map/measure.js';
import { mapServiceFor } from '../../map/overlays.js';
import { formatDateTime, zoneShortName } from '../../time.js';
import { displayZone } from '../../state.js';
import type { PassageForm, RouteWaypoint } from '../model.js';
import { workingFor, type WorkingStore } from '../working.js';
import { clearRoute, emptyRouteData, publishRoute, type RouteOverlayData } from './overlay.js';
import { legKindText, planPassage, positionsAt, tickTimes, waypointName, type PassagePlan } from './route.js';

const installed = new WeakSet<object>();

/** A new waypoint's id, unique in the route. */
export function newWaypointId(route: readonly RouteWaypoint[]): string {
  let n = route.length + 1;
  const taken = new Set(route.map((w) => w.id));
  while (taken.has(`wp-${n}`)) n += 1;
  return `wp-${n}`;
}

/** Two positions this close (NM) are the same waypoint for "Add as a leg". */
export const SAME_POINT_NM = 0.5;

/**
 * Add the measured A→B to the route: both points on an empty route; B alone when A is the
 * route's end; otherwise A then B (a connecting leg from the route's end to A). The legs
 * arriving at the new points are great circles (changed in the Passage tab).
 */
export function addMeasuredLeg(form: PassageForm, a: { lat_deg: number; lon_deg: number }, b: { lat_deg: number; lon_deg: number }): { form: PassageForm; added: number; connecting: boolean } {
  const route = [...form.waypoints];
  const last = route[route.length - 1];
  const push = (p: { lat_deg: number; lon_deg: number }): void => {
    route.push({ id: newWaypointId(route), name: '', lat_deg: p.lat_deg, lon_deg: p.lon_deg, leg: 'great_circle' });
  };
  let connecting = false;
  if (!last || greatCircleDistanceNm(last, a) > SAME_POINT_NM) {
    connecting = Boolean(last);
    push(a);
  }
  push(b);
  return { form: { ...form, waypoints: route }, added: route.length - form.waypoints.length, connecting };
}

// --- The plan, shared by the tab and the map (one per passage object) -----------------------

const planCache = new WeakMap<object, { passage: PassageForm; plan: PassagePlan }>();

/** The plan of this passage (remembered for the passage object: the tab and the map share it). */
export function planFor(engine: SailingsEngine, passage: PassageForm): PassagePlan {
  const hit = planCache.get(engine);
  if (hit && hit.passage === passage) return hit.plan;
  const plan = planPassage(engine, passage);
  planCache.set(engine, { passage, plan });
  return plan;
}

/** What the map shows of a passage at an instant (the time bar's). */
export function routeData(engine: SailingsEngine, passage: PassageForm, plan: PassagePlan, jdNow: number, zoneLabel: (jd: number) => string): RouteOverlayData {
  const data = emptyRouteData();
  data.legs = plan.legs.map((l) => ({
    kind: l.kind,
    track: l.track,
    label: `${legKindText(l.kind)} ${l.distanceNm.toFixed(0)} NM`,
  }));
  data.waypoints = passage.waypoints.map((w, i) => ({ position: { lat_deg: w.lat_deg, lon_deg: w.lon_deg }, label: waypointName(w, i) }));
  data.vertices = plan.legs.filter((l) => l.vertex).map((l) => ({ position: l.vertex!, label: `vertex ${Math.abs(l.vertex!.lat_deg).toFixed(1)}° ${l.vertex!.lat_deg >= 0 ? 'N' : 'S'}` }));
  try {
    const ticks = tickTimes(plan, passage.tickHours);
    data.ticks = positionsAt(engine, plan, ticks).map((p) => ({ position: { lat_deg: p.lat_deg, lon_deg: p.lon_deg }, label: zoneLabel(p.jd_utc) }));
    if (plan.departureJd !== null && plan.arrivalJd !== null && jdNow >= plan.departureJd && jdNow <= plan.arrivalJd) {
      const [now] = positionsAt(engine, plan, [jdNow]);
      if (now) data.now = { position: { lat_deg: now.lat_deg, lon_deg: now.lon_deg }, label: 'DR now (the time bar)' };
    }
  } catch {
    // A leg the engine refuses has no marks; the tab says why.
  }
  return data;
}

// --- Installing it on a page ------------------------------------------------------------------

/** Offer "Add as a leg" on the map's measurements and keep the route drawn. Once per page. */
export function installPassage(ctx: Ctx): void {
  if (installed.has(ctx.store)) return;
  installed.add(ctx.store);
  const engine = ctx.engine;
  if (!isSailingsEngine(engine)) return;
  const working: WorkingStore = workingFor(ctx.store).store;

  registerMeasureAction(ctx.store, {
    id: 'navigate-passage-leg',
    label: 'Add as a leg of the passage',
    tip: 'Adds A to B to the route in Navigate → Passage (a great-circle leg; change it there)',
    run(a, b) {
      const w = working.get();
      const out = addMeasuredLeg(w.passage, a, b);
      working.patch({ passage: out.form, method: 'passage' });
      const n = out.form.waypoints.length;
      ctx.notices.push(
        'info',
        `Added to the passage in Navigate: ${out.added === 2 ? 'A and B' : 'B'}${out.connecting ? ', with a leg from the route’s end to A' : ''}. The route has ${n} waypoints; open Navigate → Passage to plan it.`,
        { key: 'passage-leg' },
      );
    },
  });

  // The route on the map: again when the passage changes, and when the time bar settles
  // (the "DR now" mark), never per frame.
  const service = (() => {
    try {
      return mapServiceFor(ctx);
    } catch {
      return null;
    }
  })();
  if (!service) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = '';
  const draw = (): void => {
    timer = null;
    const w = working.get();
    const p = w.passage;
    const jd = ctx.store.get().time.jd_utc;
    const key = `${Math.round(jd * 1440)}`;
    if (!p.showOnMap || p.waypoints.length === 0) {
      clearRoute(service);
      lastKey = '';
      return;
    }
    const plan = planFor(engine, p);
    const zone = displayZone(ctx.store.get());
    const data = routeData(engine, p, plan, jd, (t) => `${formatDateTime(t, zone).slice(5)} ${zoneShortName(t, zone)}`);
    lastKey = key;
    publishRoute(service, data);
  };
  const schedule = (delay: number): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(draw, delay);
  };
  working.select((w) => w.passage, () => schedule(50));
  ctx.store.select(
    (s) => Math.round(s.time.jd_utc * 1440),
    (key) => {
      if (String(key) !== lastKey && working.get().passage.showOnMap && working.get().passage.departureUtc) schedule(300);
    },
  );
  schedule(0);
}
