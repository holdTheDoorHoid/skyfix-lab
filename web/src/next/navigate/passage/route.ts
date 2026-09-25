/**
 * The Passage tab's arithmetic, over the engine's sailings (`sailing`, `route_positions`;
 * docs/NAVIGATION_METHODS.md section 9): a route of waypoints, each leg sailed on a great
 * circle or a rhumb line; the times along it at a speed from a departure; the dead-reckoning
 * positions every so many hours; the legs the running fix takes; the route as GPX. Pure
 * over a `SailingsEngine`; tested with the mock and against the core. OWNER: navigate2 agent.
 *
 * Handing a route to the running fix (docs/MOTION.md section 1): the running fix runs each
 * leg of its track as a great circle on the leg's course. A passage's great circle turns as
 * it goes (tens of degrees over an ocean), and a rhumb line is not a great circle, so each
 * leg goes over in pieces of at most `PIECE_NM`, between points of the leg as sailed, each
 * on its chord's course (`runningFixLegs`). Only the hours the running fix needs are handed
 * over, from the first sight to the last (or the fix's moment), so its leg list stays short.
 */

import type {
  DrMethod,
  LatLonDeg,
  MeridionalParts,
  PassageReport,
  RouteLeg,
  RoutePoint,
  SailingWaypoint,
  SailingsEngine,
} from '../../engine/types.js';
import { initialCourseDeg } from '../../geo/greatcircle.js';
import { isoUtc, jdFromIso } from '../../time.js';
import { escapeXml } from '../gpx.js';
import type { LegKind, PassageForm, RouteWaypoint } from '../model.js';
import { HONESTY } from '../text.js';

/** The longest piece a leg is handed to the running fix in, NM of run. */
export const PIECE_NM = 10;

export interface LegPlan {
  index: number;
  from: RouteWaypoint;
  to: RouteWaypoint;
  kind: LegKind;
  /** Along the leg as sailed: the great circle's or the rhumb line's length. */
  distanceNm: number;
  distanceKm: number;
  /** The course at the start (constant on a rhumb line); null for coincident ends. */
  initialCourseDeg: number | null;
  /** The course on arrival (equal to the initial one on a rhumb line). */
  finalCourseDeg: number | null;
  /** The other way's length (rhumb for a great-circle leg and the reverse): what the choice saves or costs. */
  otherNm: number;
  /** Points for drawing, at most 60 NM apart (the engine's track). */
  track: LatLonDeg[];
  /** Great-circle legs: points every 5° of longitude, each with the rhumb course to steer to the next. */
  steering: SailingWaypoint[];
  /** The vertex (highest latitude) when it lies on this leg. */
  vertex: LatLonDeg | null;
  /** Hours from departure at the start and end of the leg (null without a speed). */
  startHours: number | null;
  endHours: number | null;
  report: PassageReport;
}

export interface LegFailure {
  index: number;
  from: RouteWaypoint;
  to: RouteWaypoint;
  kind: LegKind;
  error: string;
}

export interface PassagePlan {
  legs: LegPlan[];
  failures: LegFailure[];
  totalNm: number;
  /** Null without a speed. */
  totalHours: number | null;
  departureJd: number | null;
  arrivalJd: number | null;
  speedKn: number | null;
  parts: MeridionalParts;
  notes: string[];
}

/** A leg's kind in words. */
export function legKindText(kind: LegKind): string {
  return kind === 'great_circle' ? 'great circle' : 'rhumb line';
}

/** Plan the passage: each leg through the engine, then times from the departure. */
export function planPassage(engine: SailingsEngine, form: PassageForm): PassagePlan {
  const legs: LegPlan[] = [];
  const failures: LegFailure[] = [];
  const speed = form.speedKn !== null && form.speedKn > 0 ? form.speedKn : null;
  const departureJd = form.departureUtc ? jdFromIso(form.departureUtc) : null;
  let hours = 0;
  const notes = new Set<string>();
  for (let i = 1; i < form.waypoints.length; i += 1) {
    const from = form.waypoints[i - 1]!;
    const to = form.waypoints[i]!;
    const kind = to.leg;
    let report: PassageReport;
    try {
      report = engine.sailing({
        from: { lat_deg: from.lat_deg, lon_deg: from.lon_deg },
        to: { lat_deg: to.lat_deg, lon_deg: to.lon_deg },
        meridional_parts: form.parts,
        ...(kind === 'great_circle' ? { waypoints: { every_deg_lon: 5 } } : {}),
      });
    } catch (error) {
      failures.push({ index: i - 1, from, to, kind, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const n of report.notes) notes.add(n);
    const gc = report.great_circle;
    const rl = report.rhumb_line;
    const isGc = kind === 'great_circle';
    const distanceNm = isGc ? gc.distance_nm : rl.distance_nm;
    const leg: LegPlan = {
      index: i - 1,
      from,
      to,
      kind,
      distanceNm,
      distanceKm: isGc ? gc.distance_km : rl.distance_km,
      initialCourseDeg: isGc ? gc.initial_course_deg : rl.course_deg,
      finalCourseDeg: isGc ? gc.final_course_deg : rl.course_deg,
      otherNm: isGc ? rl.distance_nm : gc.distance_nm,
      track: isGc ? gc.track : rl.track,
      steering: isGc && gc.waypoints.length > 2 ? gc.waypoints : [],
      vertex: isGc && gc.vertex?.on_route ? { lat_deg: gc.vertex.lat_deg, lon_deg: gc.vertex.lon_deg } : null,
      startHours: speed ? hours : null,
      endHours: speed ? hours + distanceNm / speed : null,
      report,
    };
    if (speed) hours += distanceNm / speed;
    legs.push(leg);
  }
  const totalNm = legs.reduce((s, l) => s + l.distanceNm, 0);
  return {
    legs,
    failures,
    totalNm,
    totalHours: speed && legs.length ? hours : null,
    departureJd,
    arrivalJd: speed && departureJd !== null && legs.length ? departureJd + hours / 24 : null,
    speedKn: speed,
    parts: form.parts,
    notes: [...notes],
  };
}

/** The instant a number of hours after the departure, as RFC 3339 (null without one). */
export function timeAt(plan: PassagePlan, hours: number): { jd: number; utc: string } | null {
  if (plan.departureJd === null) return null;
  const jd = plan.departureJd + hours / 24;
  return { jd, utc: isoUtc(jd) };
}

/** Where the leg is at `hours` after the departure: the leg and the distance run along it. */
export function legAt(plan: PassagePlan, hours: number): { leg: LegPlan; alongNm: number } | null {
  if (plan.speedKn === null || !plan.legs.length) return null;
  for (const leg of plan.legs) {
    if (hours >= leg.startHours! && hours <= leg.endHours!) return { leg, alongNm: (hours - leg.startHours!) * plan.speedKn };
  }
  return null;
}

/**
 * The positions at the given instants, each from its own leg by the engine's
 * `route_positions` (a great-circle leg as a great circle on its initial course, which is
 * the great circle itself; a rhumb-line leg on its course). Instants before the departure or
 * after the arrival are left out.
 */
export function positionsAt(engine: SailingsEngine, plan: PassagePlan, jds: readonly number[]): RoutePoint[] {
  if (plan.departureJd === null || plan.speedKn === null) return [];
  const out: RoutePoint[] = [];
  for (const leg of plan.legs) {
    if (leg.initialCourseDeg === null) continue;
    const t0 = plan.departureJd + leg.startHours! / 24;
    const t1 = plan.departureJd + leg.endHours! / 24;
    const last = leg === plan.legs[plan.legs.length - 1];
    const times = jds.filter((jd) => jd >= t0 && (jd < t1 || (last && jd <= t1)));
    if (!times.length) continue;
    const method: DrMethod = leg.kind === 'great_circle' ? 'great_circle' : 'rhumb';
    const r = engine.routePositions({
      start: { lat_deg: leg.from.lat_deg, lon_deg: leg.from.lon_deg },
      start_utc: isoUtc(t0),
      legs: [{ course_deg: leg.initialCourseDeg, speed_kn: plan.speedKn }],
      end_utc: isoUtc(t1),
      method,
      meridional_parts: plan.parts,
      times_utc: times.map((jd) => isoUtc(jd)),
    });
    out.push(...r.points);
  }
  return out.sort((a, b) => a.jd_utc - b.jd_utc);
}

/** The instants of the dead-reckoning marks: every `tickHours` from the departure to the arrival. */
export function tickTimes(plan: PassagePlan, tickHours: number): number[] {
  if (plan.departureJd === null || plan.totalHours === null || !(tickHours > 0)) return [];
  const n = Math.min(400, Math.floor(plan.totalHours / tickHours + 1e-9));
  return Array.from({ length: n }, (_, k) => plan.departureJd! + ((k + 1) * tickHours) / 24).filter((jd) => jd < plan.arrivalJd! - 1e-9);
}

/**
 * The running fix's legs for the hours `[fromJd, toJd]`. Each leg of the passage overlapping
 * them is cut into pieces of at most `PIECE_NM` of run; the points where the pieces meet are
 * the engine's positions along the leg as it is sailed (`route_positions`: the great circle,
 * or the rhumb line with the passage's meridional parts), and each piece goes to the running
 * fix on the course of its chord, the great circle between its two ends (the first from
 * where the vessel is when the hours begin). A dead-reckoning run over these legs (the
 * running fix's own model, docs/MOTION.md) follows the passage: tested to under 5 m over
 * three-hour runs (navigate-passage.test.ts). Every leg has its start time;
 * after the arrival the vessel is stationary (`endUtc`). Null without a speed and a
 * departure, or when the hours do not meet the passage.
 */
export function runningFixLegs(
  engine: SailingsEngine,
  plan: PassagePlan,
  fromJd: number,
  toJd: number,
): { legs: RouteLeg[]; endUtc: string | null; note: string } | null {
  if (plan.departureJd === null || plan.speedKn === null || plan.arrivalJd === null || !plan.legs.length) return null;
  const dep = plan.departureJd;
  const speed = plan.speedKn;
  const hoursOf = (jd: number): number => (jd - dep) * 24;
  const loH = Math.max(hoursOf(fromJd), 0);
  const hiH = Math.min(Math.max(hoursOf(toJd), loH), plan.totalHours!);
  if (loH > plan.totalHours! + 1e-12) return null;
  const legs: RouteLeg[] = [];
  for (const leg of plan.legs) {
    if (leg.initialCourseDeg === null || leg.endHours! <= loH - 1e-12 || leg.startHours! > hiH + 1e-12) continue;
    const n = Math.max(1, Math.ceil(leg.distanceNm / PIECE_NM));
    const bounds = Array.from({ length: n + 1 }, (_, k) => leg.startHours! + ((leg.endHours! - leg.startHours!) * k) / n);
    const wanted = bounds.map((hh, k) => ({ hh, k })).filter(({ k }) => {
      const s = bounds[Math.max(0, k - 1)]!;
      const e = bounds[Math.min(n, k + 1)]!;
      return e >= loH - 1e-12 && s <= hiH + 1e-12;
    });
    // The window may open inside a piece: its first leg then runs from where the vessel is
    // at the opening, on the chord from there (key -1), not from the piece's start.
    const opensInside = loH > leg.startHours! + 1e-12 && loH < leg.endHours! - 1e-12;
    if (opensInside) wanted.push({ hh: loH, k: -1 });
    const points = engine.routePositions({
      start: { lat_deg: leg.from.lat_deg, lon_deg: leg.from.lon_deg },
      start_utc: isoUtc(dep + leg.startHours! / 24),
      legs: [{ course_deg: leg.initialCourseDeg, speed_kn: speed }],
      end_utc: isoUtc(dep + leg.endHours! / 24),
      method: leg.kind === 'great_circle' ? 'great_circle' : 'rhumb',
      meridional_parts: plan.parts,
      times_utc: wanted.map(({ hh }) => isoUtc(dep + hh / 24)),
    }).points;
    const at = new Map<number, LatLonDeg>();
    for (const { hh, k } of wanted) {
      const jd = dep + hh / 24;
      const p = points.find((q) => Math.abs(q.jd_utc - jd) * 86_400 < 0.01);
      if (p) at.set(k, { lat_deg: p.lat_deg, lon_deg: p.lon_deg });
    }
    // The exact ends of the leg (the engine's run arrives there to its own precision).
    at.set(0, { lat_deg: leg.from.lat_deg, lon_deg: leg.from.lon_deg });
    at.set(n, { lat_deg: leg.to.lat_deg, lon_deg: leg.to.lon_deg });
    for (let k = 0; k < n; k += 1) {
      const startH = bounds[k]!;
      const endH = bounds[k + 1]!;
      if (endH <= loH - 1e-12 || startH > hiH + 1e-12) continue;
      const a = opensInside && startH < loH && loH < endH ? (at.get(-1) ?? at.get(k)) : at.get(k);
      const b = at.get(k + 1);
      const chord = a && b ? initialCourseDeg(a, b) : Number.NaN;
      legs.push({ start_utc: isoUtc(dep + Math.max(startH, loH) / 24), course_deg: Number.isNaN(chord) ? leg.initialCourseDeg : chord, speed_kn: speed });
    }
  }
  if (!legs.length) return null;
  const stops = plan.arrivalJd <= toJd;
  return {
    legs,
    endUtc: stops ? isoUtc(plan.arrivalJd) : null,
    note:
      `${legs.length} leg${legs.length === 1 ? '' : 's'} from the passage at ${speed} kn over the hours of the sights, each at most ${PIECE_NM} NM of the leg as sailed, so a great circle’s turning course is followed` +
      (stops ? '; stationary after the arrival' : '') +
      '. The motion uncertainty is not stated: set it below.',
  };
}

// ---------------------------------------------------------------------------------------
// GPX 1.1 route

const coord = (v: number): string => (Math.abs(v) < 5e-8 ? '0.0000000' : v.toFixed(7));
const bearing = (v: number | null): string => (v === null ? '—' : `${String(Math.round(v) % 360).padStart(3, '0')}°`);

export function waypointName(w: RouteWaypoint, i: number): string {
  return w.name.trim() || `WP ${i + 1}`;
}

/** The route as a GPX 1.1 `<rte>`: every waypoint, and each great circle's 5° steering points between. */
export function routeGpx(plan: PassagePlan, form: PassageForm, meta: { name: string; sessionKind: 'simulated' | 'real'; time: string }): string {
  const pts: { lat: number; lon: number; name: string; desc: string; type: string; time: string | null }[] = [];
  const eta = (hours: number | null): string | null => (hours === null ? null : (timeAt(plan, hours)?.utc ?? null));
  form.waypoints.forEach((w, i) => {
    const arriving = plan.legs.find((l) => l.index === i - 1);
    const leaving = plan.legs.find((l) => l.index === i);
    if (arriving && arriving.kind === 'great_circle') {
      // The great circle's steering points (between, not the ends), each with the rhumb course to the next.
      for (const s of arriving.steering.slice(1, -1)) {
        pts.push({
          lat: s.lat_deg,
          lon: s.lon_deg,
          name: `${waypointName(arriving.from, i - 1)}–${waypointName(w, i)} GC ${s.index}`,
          desc: `A point of the great circle from ${waypointName(arriving.from, i - 1)} to ${waypointName(w, i)}, ${s.distance_from_start_nm.toFixed(1)} NM along it; steer the rhumb line ${bearing(s.leg_course_deg)} to the next.`,
          type: 'great-circle point',
          time: s.leg_distance_nm === null || plan.speedKn === null ? null : eta(arriving.startHours! + s.distance_from_start_nm / plan.speedKn),
        });
      }
    }
    const leg = leaving
      ? `Next leg: ${legKindText(leaving.kind)} ${leaving.distanceNm.toFixed(1)} NM, initial course ${bearing(leaving.initialCourseDeg)}.`
      : 'The destination.';
    pts.push({
      lat: w.lat_deg,
      lon: w.lon_deg,
      name: waypointName(w, i),
      desc: `${leg}${arriving ? ` Arriving by ${legKindText(arriving.kind)}, ${arriving.distanceNm.toFixed(1)} NM.` : ''}`,
      type: 'waypoint',
      time: arriving ? eta(arriving.endHours) : plan.departureJd !== null ? isoUtc(plan.departureJd) : null,
    });
  });
  const kind = meta.sessionKind === 'simulated' ? 'SIMULATED session.' : 'REAL session.';
  const desc =
    `A passage of ${plan.legs.length} leg${plan.legs.length === 1 ? '' : 's'}, ${plan.totalNm.toFixed(1)} NM` +
    (plan.speedKn !== null ? ` at ${plan.speedKn} kn` : '') +
    '. Distances on the sphere of 1′ = 1 NM (within 0.52 % of WGS84). ' +
    `${kind} ${HONESTY}`;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SkyFix Lab (simulation and analysis workbench; not a navigation instrument)" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">',
    '  <metadata>',
    `    <name>${escapeXml(meta.name)}</name>`,
    `    <desc>${escapeXml(desc)}</desc>`,
    `    <time>${escapeXml(meta.time)}</time>`,
    '  </metadata>',
    '  <rte>',
    `    <name>${escapeXml(meta.name)}</name>`,
    `    <desc>${escapeXml(desc)}</desc>`,
  ];
  for (const p of pts) {
    lines.push(`    <rtept lat="${coord(p.lat)}" lon="${coord(p.lon)}">`);
    if (p.time) lines.push(`      <time>${escapeXml(p.time)}</time>`);
    lines.push(`      <name>${escapeXml(p.name)}</name>`);
    lines.push(`      <desc>${escapeXml(p.desc)}</desc>`);
    lines.push(`      <type>${escapeXml(p.type)}</type>`);
    lines.push('    </rtept>');
  }
  lines.push('  </rte>', '</gpx>');
  return `${lines.join('\n')}\n`;
}
