/**
 * MOCK SAILINGS — for developing the interface only (`?engine=mock`). Never a source of
 * results (EXPLORER_PLAN section 3.1): the numbers are illustrative, and every result's
 * notes say so. OWNER: sailings agent (expansion programme).
 *
 * It implements `SailingsEngine` with the contract's shapes and failure modes: the
 * sailings and dead reckoning on the sphere of 1′ = 1 NM with the textbook formulas (the
 * WGS84 meridional parts are honoured too), star identification with the core's
 * tangent-plane ranking over the mock sky (`skyState`), and the star finder's projection
 * over the mock's navigational-star rows. What it leaves out: the core's numerical care
 * near the poles and for coincident points, and composite sailing's waypoints on the
 * parallel (the parallel leg is one straight piece here).
 */

import { horizonDipArcmin, refractionArcmin } from '../../corrections.js';
import { isoUtc, jdFromIso } from '../time.js';
import { NAV_STAR_ROWS } from './mock/stars.js';
import type {
  AriesTick,
  CompositeLegReport,
  CompositeReport,
  DrMethod,
  DrReport,
  DrRequest,
  LatLonDeg,
  MeridionalParts,
  PassageReport,
  PassageRequest,
  RouteLegReport,
  RoutePoint,
  RouteReport,
  RouteRequest,
  RouteStatus,
  SailingArrival,
  SailingWaypoint,
  SailingsEngine,
  SkyState,
  StarFinderGeometry,
  StarFinderLine,
  StarFinderPoint,
  StarFinderSide,
  StarIdMatch,
  StarIdRequest,
  StarIdResult,
  Observer,
} from './types.js';

const D = Math.PI / 180;
const WGS84_E2 = 0.00669437999014;
const MOCK_NOTE = 'MOCK engine: illustrative numbers for interface work, not results from the SkyFix Lab core.';

const norm360 = (d: number): number => ((d % 360) + 360) % 360;
const norm180 = (d: number): number => {
  const x = norm360(d);
  return x > 180 ? x - 360 : x;
};

function check(p: LatLonDeg, name: string): void {
  if (!Number.isFinite(p?.lat_deg) || !Number.isFinite(p?.lon_deg) || Math.abs(p.lat_deg) > 90 || Math.abs(p.lon_deg) > 180) {
    throw new Error(`${name}: expected {lat_deg, lon_deg} within range`);
  }
}

function jdOf(utc: string | null | undefined, field: string): number | null {
  if (utc === null || utc === undefined) return null;
  const jd = jdFromIso(utc);
  if (jd === null) throw new Error(`${field}: ${JSON.stringify(utc)} is not an RFC 3339 UTC time`);
  return jd;
}

// --- sphere geometry ----------------------------------------------------------------

function gcDistanceDeg(a: LatLonDeg, b: LatLonDeg): number {
  const [p1, l1, p2, l2] = [a.lat_deg * D, a.lon_deg * D, b.lat_deg * D, b.lon_deg * D];
  const dl = l2 - l1;
  const y = Math.hypot(Math.cos(p2) * Math.sin(dl), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  const x = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  return Math.atan2(y, x) / D;
}

function bearingDeg(a: LatLonDeg, b: LatLonDeg): number {
  const [p1, l1, p2, l2] = [a.lat_deg * D, a.lon_deg * D, b.lat_deg * D, b.lon_deg * D];
  const dl = l2 - l1;
  return norm360(Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / D);
}

function destination(a: LatLonDeg, courseDeg: number, distNm: number): LatLonDeg {
  const [p1, l1, c, d] = [a.lat_deg * D, a.lon_deg * D, courseDeg * D, (distNm / 60) * D];
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(c));
  const l2 = l1 + Math.atan2(Math.sin(c) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat_deg: p2 / D, lon_deg: norm180(l2 / D) };
}

function psi(latDeg: number, parts: MeridionalParts): number {
  const s = Math.sin(latDeg * D);
  const e = parts === 'wgs84' ? Math.sqrt(WGS84_E2) : 0;
  return Math.atanh(s) - (e ? e * Math.atanh(e * s) : 0);
}

function qFactor(lat1: number, lat2: number, parts: MeridionalParts): number {
  const dlat = (lat2 - lat1) * D;
  if (Math.abs(dlat) < 1e-12) {
    const s = Math.sin(lat1 * D);
    const e2 = parts === 'wgs84' ? WGS84_E2 : 0;
    return (Math.cos(lat1 * D) * (1 - e2 * s * s)) / (1 - e2);
  }
  return dlat / (psi(lat2, parts) - psi(lat1, parts));
}

function rhumbInverse(a: LatLonDeg, b: LatLonDeg, parts: MeridionalParts) {
  const dlat = (b.lat_deg - a.lat_deg) * 60;
  const dlo = norm180(b.lon_deg - a.lon_deg) * 60;
  const east = qFactor(a.lat_deg, b.lat_deg, parts) * dlo;
  const distance = Math.hypot(dlat, east);
  return {
    course: distance > 0 ? norm360(Math.atan2(east, dlat) / D) : null,
    distance,
    dlat,
    dlo,
    departure: east,
    m: ((psi(b.lat_deg, parts) - psi(a.lat_deg, parts)) / D) * 60,
  };
}

function rhumbDirect(a: LatLonDeg, courseDeg: number, distNm: number, parts: MeridionalParts): LatLonDeg {
  const dlat = (distNm * Math.cos(courseDeg * D)) / 60;
  const lat2 = a.lat_deg + dlat;
  if (Math.abs(lat2) >= 90) throw new Error('distance_nm: a rhumb line cannot be held to or beyond the pole');
  const dlo = (distNm * Math.sin(courseDeg * D)) / qFactor(a.lat_deg, lat2, parts) / 60;
  return { lat_deg: lat2, lon_deg: norm180(a.lon_deg + dlo) };
}

function midLatDirect(a: LatLonDeg, courseDeg: number, distNm: number): LatLonDeg {
  const l = (distNm * Math.cos(courseDeg * D)) / 60;
  const p = distNm * Math.sin(courseDeg * D);
  const lat2 = a.lat_deg + l;
  if (Math.abs(lat2) >= 90) throw new Error('distance_nm: mid-latitude sailing cannot reach a pole');
  let dlo: number;
  if (a.lat_deg * lat2 < 0) {
    const f = Math.abs(a.lat_deg) / Math.abs(l);
    dlo = (p * f) / Math.cos(0.5 * a.lat_deg * D) + (p * (1 - f)) / Math.cos(0.5 * lat2 * D);
  } else dlo = p / Math.cos(0.5 * (a.lat_deg + lat2) * D);
  return { lat_deg: lat2, lon_deg: norm180(a.lon_deg + dlo / 60) };
}

function advance(a: LatLonDeg, courseDeg: number, distNm: number, method: DrMethod, parts: MeridionalParts): LatLonDeg {
  if (distNm === 0) return a;
  if (method === 'rhumb') return rhumbDirect(a, courseDeg, distNm, parts);
  if (method === 'mid_latitude') return midLatDirect(a, courseDeg, distNm);
  if (distNm > 0) return destination(a, courseDeg, distNm);
  // Backwards along a great-circle leg: a few fixed-point steps (illustrative).
  let q = destination(a, courseDeg + 180, -distNm);
  for (let k = 0; k < 6; k++) {
    const f = destination(q, courseDeg, -distNm);
    q = { lat_deg: q.lat_deg + (a.lat_deg - f.lat_deg), lon_deg: norm180(q.lon_deg + norm180(a.lon_deg - f.lon_deg)) };
  }
  return q;
}

function arrival(distNm: number, speed: number | null, departure: number | null): SailingArrival | null {
  if (speed === null) return null;
  const hours = distNm / speed;
  const jd = departure === null ? null : departure + hours / 24;
  return { hours, utc: jd === null ? null : isoUtc(jd), jd_utc: jd };
}

/** A path of straight-on-the-sphere pieces, sampled by distance. */
interface Piece {
  from: LatLonDeg;
  to: LatLonDeg;
  nm: number;
  at: (nm: number) => LatLonDeg;
  course: (nm: number) => number;
}

function gcPiece(a: LatLonDeg, b: LatLonDeg): Piece {
  const nm = gcDistanceDeg(a, b) * 60;
  const c0 = bearingDeg(a, b);
  return {
    from: a,
    to: b,
    nm,
    at: (s) => destination(a, c0, s),
    course: (s) => (nm - s > 1e-6 ? bearingDeg(destination(a, c0, s), b) : norm360(bearingDeg(b, a) + 180)),
  };
}

function parallelPiece(lat: number, lon1: number, dlo: number): Piece {
  const nm = Math.abs(dlo) * 60 * Math.cos(lat * D);
  return {
    from: { lat_deg: lat, lon_deg: norm180(lon1) },
    to: { lat_deg: lat, lon_deg: norm180(lon1 + dlo) },
    nm,
    at: (s) => ({ lat_deg: lat, lon_deg: norm180(lon1 + (nm > 0 ? (dlo * s) / nm : 0)) }),
    course: () => (dlo >= 0 ? 90 : 270),
  };
}

function sample(pieces: Piece[], s: number): { p: LatLonDeg; c: number } {
  let left = s;
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i]!;
    if (left <= piece.nm || i === pieces.length - 1) {
      const t = Math.min(left, piece.nm);
      return { p: piece.at(t), c: piece.course(t) };
    }
    left -= piece.nm;
  }
  return { p: pieces[0]!.from, c: 0 };
}

function stations(pieces: Piece[], req: PassageRequest): number[] {
  const total = pieces.reduce((a, p) => a + p.nm, 0);
  const w = req.waypoints;
  if (!w) return [];
  if ('every_nm' in w) {
    if (!(w.every_nm > 0)) throw new Error('waypoints.every_nm: must be a positive distance');
    const out: number[] = [];
    for (let s = w.every_nm; s < total - 1e-9; s += w.every_nm) {
      out.push(s);
      if (out.length > 2000) throw new Error('waypoints: at most 2000 waypoints are offered');
    }
    return out;
  }
  if (!(w.every_deg_lon > 0 && w.every_deg_lon <= 180)) throw new Error('waypoints.every_deg_lon: must be between 0 and 180 degrees');
  // Sample finely and find where the longitude passes each multiple of the step.
  const out: number[] = [];
  const n = Math.max(200, Math.ceil(total / 5));
  let prev = sample(pieces, 0).p.lon_deg;
  let unwrapped = prev;
  for (let k = 1; k <= n; k++) {
    const s = (total * k) / n;
    const lon = sample(pieces, s).p.lon_deg;
    const next = unwrapped + norm180(lon - prev);
    const lo = Math.min(unwrapped, next);
    const hi = Math.max(unwrapped, next);
    for (let m = Math.ceil(lo / w.every_deg_lon) * w.every_deg_lon; m <= hi; m += w.every_deg_lon) {
      if (m === lo && k > 1) continue;
      const f = hi === lo ? 0 : Math.abs(m - unwrapped) / (hi - lo);
      const st = s - total / n + f * (total / n);
      if (st > 1e-9 && st < total - 1e-9) out.push(st);
    }
    prev = lon;
    unwrapped = next;
  }
  return out;
}

function waypointList(pieces: Piece[], req: PassageRequest, speed: number | null, departure: number | null) {
  const total = pieces.reduce((a, p) => a + p.nm, 0);
  const inner = stations(pieces, req);
  if (inner.length === 0 && !req.waypoints) return { waypoints: [] as SailingWaypoint[], sailed: total };
  const all = [0, ...inner, total];
  const pts = all.map((s) => sample(pieces, s));
  let sailed = 0;
  const waypoints: SailingWaypoint[] = all.map((s, i) => {
    const next = pts[i + 1];
    const leg = next ? rhumbInverse(pts[i]!.p, next.p, req.meridional_parts ?? 'sphere') : null;
    const eta = speed !== null && departure !== null ? departure + sailed / speed / 24 : null;
    const w: SailingWaypoint = {
      index: i,
      lat_deg: pts[i]!.p.lat_deg,
      lon_deg: pts[i]!.p.lon_deg,
      distance_from_start_nm: s,
      track_course_deg: pts[i]!.c,
      leg_course_deg: leg?.course ?? null,
      leg_distance_nm: leg ? leg.distance : null,
      sailed_nm: sailed,
      eta_utc: eta === null ? null : isoUtc(eta),
      eta_jd_utc: eta,
    };
    sailed += leg ? leg.distance : 0;
    return w;
  });
  return { waypoints, sailed };
}

function track(pieces: Piece[]): LatLonDeg[] {
  const total = pieces.reduce((a, p) => a + p.nm, 0);
  const n = Math.max(1, Math.ceil(total / 60));
  return Array.from({ length: n + 1 }, (_, k) => sample(pieces, (total * k) / n).p);
}

export function mockSailing(req: PassageRequest): PassageReport {
  check(req.from, 'from');
  check(req.to, 'to');
  const parts = req.meridional_parts ?? 'sphere';
  const speed = req.speed_kn ?? null;
  if (speed !== null && !(speed > 0 && speed <= 1000)) throw new Error('speed_kn: must be above 0 and at most 1000 kn');
  const departure = jdOf(req.departure_utc, 'departure_utc');
  const dDeg = gcDistanceDeg(req.from, req.to);
  if (dDeg > 179.9999) throw new Error('to: the destination is the antipode of the departure; add a waypoint');
  const gc = [gcPiece(req.from, req.to)];
  const gcw = waypointList(gc, req, speed, departure);
  const c1 = bearingDeg(req.from, req.to);
  const cosLv = Math.abs(Math.cos(req.from.lat_deg * D) * Math.sin(c1 * D));
  const r = rhumbInverse(req.from, req.to, parts);
  const lm = 0.5 * (req.from.lat_deg + req.to.lat_deg);
  const sameSide = req.from.lat_deg * req.to.lat_deg >= 0;
  const p = r.dlo * Math.cos(lm * D);
  let composite: CompositeReport | null = null;
  if (req.limiting_latitude_deg !== null && req.limiting_latitude_deg !== undefined) {
    const lim = req.limiting_latitude_deg;
    if (!(Math.abs(lim) > 0 && Math.abs(lim) < 90)) throw new Error('limiting_latitude_deg: must be between the equator and a pole');
    const vLat = (Math.acos(Math.min(1, cosLv)) / D) * Math.sign(lim);
    const pieces: Piece[] =
      Math.abs(vLat) > Math.abs(lim)
        ? (() => {
            const dir = Math.sign(norm180(req.to.lon_deg - req.from.lon_deg)) || 1;
            const dlov = (lat: number) => Math.acos(Math.max(-1, Math.min(1, Math.tan(lat * D) / Math.tan(lim * D)))) / D;
            const lon1 = req.from.lon_deg + dir * dlov(req.from.lat_deg);
            const lon2 = req.to.lon_deg - dir * dlov(req.to.lat_deg);
            const t1 = { lat_deg: lim, lon_deg: norm180(lon1) };
            const t2 = { lat_deg: lim, lon_deg: norm180(lon2) };
            return [gcPiece(req.from, t1), parallelPiece(lim, lon1, dir * Math.abs(norm180(lon2 - lon1))), gcPiece(t2, req.to)];
          })()
        : gc;
    const cw = waypointList(pieces, req, speed, departure);
    const total = pieces.reduce((a, q) => a + q.nm, 0);
    composite = {
      limiting_latitude_deg: lim,
      applies: pieces.length > 1,
      distance_nm: total,
      distance_km: total * 1.852,
      extra_distance_nm: total - dDeg * 60,
      legs: pieces.map(
        (q, i): CompositeLegReport => ({
          kind: pieces.length > 1 && i === 1 ? 'parallel' : 'great_circle',
          from: q.from,
          to: q.to,
          distance_nm: q.nm,
          initial_course_deg: q.course(0),
          final_course_deg: q.course(q.nm),
        }),
      ),
      waypoints: cw.waypoints,
      waypoint_route_nm: cw.sailed,
      track: track(pieces),
      arrival: arrival(cw.sailed, speed, departure),
      note: pieces.length > 1 ? 'MOCK composite track' : 'MOCK: the great circle stays within the limit',
    };
  }
  return {
    from: req.from,
    to: req.to,
    great_circle: {
      distance_nm: dDeg * 60,
      distance_km: dDeg * 60 * 1.852,
      distance_deg: dDeg,
      initial_course_deg: dDeg > 0 ? c1 : null,
      final_course_deg: dDeg > 0 ? norm360(bearingDeg(req.to, req.from) + 180) : null,
      vertex: null,
      highest_latitude_deg: Math.max(Math.abs(req.from.lat_deg), Math.abs(req.to.lat_deg), Math.acos(Math.min(1, cosLv)) / D),
      equator_crossing: null,
      waypoints: gcw.waypoints,
      waypoint_route_nm: gcw.sailed,
      track: track(gc),
      arrival: arrival(gcw.sailed, speed, departure),
    },
    rhumb_line: {
      course_deg: r.course,
      distance_nm: r.distance,
      distance_km: r.distance * 1.852,
      dlat_arcmin: r.dlat,
      dlo_arcmin: r.dlo,
      departure_nm: r.departure,
      meridional_difference_arcmin: r.m,
      meridional_parts: parts,
      track: r.course === null ? [req.from, req.to] : Array.from({ length: 21 }, (_, k) => rhumbDirect(req.from, r.course!, (r.distance * k) / 20, parts)),
      arrival: arrival(r.distance, speed, departure),
    },
    mid_latitude: sameSide
      ? {
          course_deg: Math.hypot(r.dlat, p) > 0 ? norm360(Math.atan2(p, r.dlat) / D) : null,
          distance_nm: Math.hypot(r.dlat, p),
          mean_latitude_deg: lm,
          dlat_arcmin: r.dlat,
          dlo_arcmin: r.dlo,
          departure_nm: p,
          arrival: arrival(Math.hypot(r.dlat, p), speed, departure),
        }
      : null,
    composite,
    great_circle_saving_nm: r.distance - dDeg * 60,
    speed_kn: speed,
    departure_utc: departure === null ? null : isoUtc(departure),
    notes: [MOCK_NOTE],
  };
}

export function mockDrAdvance(req: DrRequest): DrReport {
  check(req.from, 'from');
  for (const k of ['course_deg', 'speed_kn', 'hours'] as const) {
    if (!Number.isFinite(req[k])) throw new Error(`${k}: value is not finite`);
  }
  const method = req.method ?? 'rhumb';
  const parts = req.meridional_parts ?? 'sphere';
  const dist = req.speed_kn * req.hours;
  const to = advance(req.from, req.course_deg, dist, method, parts);
  const start = jdOf(req.start_utc, 'start_utc');
  const arrivalJd = start === null ? null : start + req.hours / 24;
  return {
    from: req.from,
    to,
    course_deg: norm360(req.course_deg),
    speed_kn: req.speed_kn,
    hours: req.hours,
    distance_nm: dist,
    method,
    meridional_parts: parts,
    final_course_deg:
      method === 'great_circle' && dist > 0 ? norm360(bearingDeg(to, req.from) + 180) : norm360(req.course_deg),
    arrival_utc: arrivalJd === null ? null : isoUtc(arrivalJd),
    arrival_jd_utc: arrivalJd,
  };
}

export function mockRoutePositions(req: RouteRequest): RouteReport {
  check(req.start, 'start');
  const start = jdOf(req.start_utc, 'start_utc')!;
  const end = jdOf(req.end_utc, 'end_utc');
  const method = req.method ?? 'rhumb';
  const parts = req.meridional_parts ?? 'sphere';
  if (!req.legs?.length) throw new Error('legs: a route needs at least one leg');
  const starts = req.legs.map((l, i) => {
    if (l.start_utc === null || l.start_utc === undefined) {
      if (i === 0) return start;
      throw new Error(`legs[${i}].start_utc: every leg after the first needs its start time`);
    }
    return jdOf(l.start_utc, `legs[${i}].start_utc`)!;
  });
  const legs: RouteLegReport[] = [];
  let here = req.start;
  req.legs.forEach((l, i) => {
    const e = Math.min(starts[i + 1] ?? Infinity, end ?? Infinity);
    const to = Number.isFinite(e) ? advance(here, l.course_deg, l.speed_kn * (e - starts[i]!) * 24, method, parts) : null;
    legs.push({
      index: i,
      start_utc: isoUtc(starts[i]!),
      start_jd_utc: starts[i]!,
      end_utc: Number.isFinite(e) ? isoUtc(e) : null,
      end_jd_utc: Number.isFinite(e) ? e : null,
      from: here,
      to,
      course_deg: norm360(l.course_deg),
      speed_kn: l.speed_kn,
      distance_nm: Number.isFinite(e) ? Math.abs(l.speed_kn) * (e - starts[i]!) * 24 : null,
    });
    if (to) here = to;
  });
  const instants = (req.times_utc ?? []).map((u, i) => jdOf(u, `times_utc[${i}]`)!);
  if (req.step_minutes) {
    if (end === null) throw new Error('step_minutes: stepping along a route needs its end_utc');
    for (let t = start; t <= end + 1e-9; t += req.step_minutes / 1440) instants.push(t);
  }
  instants.sort((a, b) => a - b);
  const points: RoutePoint[] = instants.map((t) => {
    let status: RouteStatus = 'under_way';
    let leg: number | null = null;
    let p = req.start;
    if (t < start) status = 'before_start';
    else if (t < starts[0]!) status = 'waiting';
    else {
      const tt = end !== null && t > end ? end : t;
      if (end !== null && t > end) status = 'after_end';
      const i = starts.reduce((acc, s, k) => (s <= tt ? k : acc), 0);
      leg = status === 'under_way' ? i : null;
      p = advance(legs[i]!.from, req.legs[i]!.course_deg, req.legs[i]!.speed_kn * (tt - starts[i]!) * 24, method, parts);
    }
    const run = legs.reduce((a, l, i) => a + Math.abs(req.legs[i]!.speed_kn) * Math.max(0, Math.min(t, l.end_jd_utc ?? Infinity) - l.start_jd_utc) * 24, 0);
    return { utc: isoUtc(t), jd_utc: t, lat_deg: p.lat_deg, lon_deg: p.lon_deg, leg, status, distance_run_nm: run };
  });
  const last = points[points.length - 1];
  const mg = last ? rhumbInverse(req.start, { lat_deg: last.lat_deg, lon_deg: last.lon_deg }, parts) : null;
  const hours = last ? (last.jd_utc - start) * 24 : 0;
  return {
    method,
    meridional_parts: parts,
    legs,
    points,
    made_good: mg ? { course_deg: mg.course, distance_nm: mg.distance, hours, speed_kn: hours > 0 ? mg.distance / hours : null } : null,
    notes: [MOCK_NOTE],
  };
}

// --- star identification ----------------------------------------------------------------

export function mockLimitingMagnitude(sunAltDeg: number): number {
  const h = sunAltDeg;
  if (h >= 0) return -3;
  if (h > -6) return -3 + 0.75 * -h;
  if (h > -12) return 1.5 + 0.25 * (-6 - h);
  return Math.min(4.5, 3 + 0.25 * (-12 - h));
}

function unit(h: number, z: number): [number, number, number] {
  return [Math.cos(h * D) * Math.cos(z * D), Math.cos(h * D) * Math.sin(z * D), Math.sin(h * D)];
}

export function mockStarIdentify(req: StarIdRequest, skyState: (o: Observer, jd: number) => SkyState): StarIdResult {
  const jd = jdOf(req.utc, 'utc')!;
  const o = req.observer;
  check(o, 'observer');
  const tolH = req.altitude_tolerance_deg ?? 2;
  const tolZ = req.bearing_tolerance_deg ?? 5;
  const kind = req.altitude_kind ?? 'sextant_hs';
  const ic = req.instrument?.index_correction_arcmin ?? 0;
  let h0 = req.altitude_deg;
  if (kind === 'sextant_hs') h0 += (ic - horizonDipArcmin(req.instrument?.horizon ?? 'sea', o.height_of_eye_m ?? 0)) / 60;
  if (kind !== 'observed_ho') h0 -= refractionArcmin(h0, o.pressure_hpa ?? 1010, o.temperature_c ?? 10) / 60;
  const bearingKind = req.bearing_kind ?? 'true';
  const z0 = norm360(req.bearing_deg + (bearingKind === 'compass' ? (req.deviation_deg ?? 0) : 0) + (bearingKind === 'true' ? 0 : (req.variation_deg ?? 0)));
  const sky = skyState({ lat_deg: o.lat_deg, lon_deg: o.lon_deg }, jd);
  const limit = mockLimitingMagnitude(sky.sun_altitude_deg);
  const u0 = unit(h0, z0);
  const up: [number, number, number] = [-Math.sin(h0 * D) * Math.cos(z0 * D), -Math.sin(h0 * D) * Math.sin(z0 * D), Math.cos(h0 * D)];
  const across: [number, number, number] = [-Math.sin(z0 * D), Math.cos(z0 * D), 0];
  const tolX = Math.max(tolZ * Math.cos(h0 * D), tolH);
  const ranked: StarIdMatch[] = sky.bodies
    .filter((b) => b.kind !== 'sun' && (b.kind !== 'planet' || ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn'].includes(b.body)))
    .map((b) => {
      const h = b.hc_deg - (b.horizontal_parallax_arcmin * Math.cos(b.hc_deg * D)) / 60;
      const u = unit(h, b.zn_deg);
      const dot = u0[0] * u[0] + u0[1] * u[1] + u0[2] * u[2];
      const sep = Math.acos(Math.max(-1, Math.min(1, dot))) / D;
      const th = Math.atan2(u[0] * across[0] + u[1] * across[1], u[0] * up[0] + u[1] * up[1] + u[2] * up[2]);
      const y = sep * Math.cos(th);
      const x = sep * Math.sin(th);
      return {
        rank: 0,
        body: b.body,
        kind: b.kind === 'moon' ? 'moon' : b.kind === 'planet' ? 'planet' : 'star',
        navigational: b.body !== 'Mercury',
        altitude_deg: h,
        azimuth_deg: b.zn_deg,
        delta_altitude_deg: h0 - h,
        delta_bearing_deg: norm180(z0 - b.zn_deg),
        separation_deg: sep,
        score: Math.hypot(y / tolH, x / tolX),
        within_tolerance: Math.abs(y) <= tolH && Math.abs(x) <= tolX,
        magnitude: b.magnitude,
        bright_enough: b.magnitude === null ? null : b.magnitude <= limit,
      } satisfies StarIdMatch;
    })
    .sort((a, b) => Number(b.within_tolerance) - Number(a.within_tolerance) || a.score - b.score);
  const nMatch = ranked.filter((m) => m.within_tolerance).length;
  const shown = ranked.slice(0, nMatch + Math.max(0, 3 - nMatch)).map((m, i) => ({ ...m, rank: i + 1 }));
  const best = shown[0]?.within_tolerance ? shown[0].body : null;
  return {
    utc: isoUtc(jd),
    jd_utc: jd,
    observed_altitude_deg: h0,
    observed_bearing_deg: z0,
    corrections: { input_kind: kind, input_deg: req.altitude_deg, steps: [], ho_deg: h0, sigma_ho_arcmin: 1, warnings: [] },
    altitude_tolerance_deg: tolH,
    bearing_tolerance_deg: tolZ,
    sun_altitude_deg: sky.sun_altitude_deg,
    sky: sky.sky_phase,
    limiting_magnitude: limit,
    candidates: shown,
    best,
    ambiguous: nMatch > 1,
    message: best
      ? `${best} (${shown[0]!.separation_deg.toFixed(1)}° away). ${MOCK_NOTE}`
      : `Nothing lies within ${tolH}° of altitude and ${tolZ}° of bearing. ${MOCK_NOTE}`,
    source: 'MOCK sky',
    warnings: [],
    notes: [MOCK_NOTE],
  };
}

// --- star finder ------------------------------------------------------------------------

function baseXy(side: StarFinderSide, raDeg: number, decDeg: number): StarFinderPoint {
  const r = (side === 'north' ? 90 - decDeg : 90 + decDeg) / 180;
  return [r * Math.cos(raDeg * D), (side === 'north' ? 1 : -1) * r * Math.sin(raDeg * D)];
}

function templateXy(lat: number, alt: number, az: number): StarFinderPoint {
  const [sp, cp, sh, ch, sa, ca] = [Math.sin(lat * D), Math.cos(lat * D), Math.sin(alt * D), Math.cos(alt * D), Math.sin(az * D), Math.cos(az * D)];
  const n = cp * sh - sp * ch * ca;
  const e = -ch * sa;
  const z = sp * sh + cp * ch * ca;
  const rho = Math.hypot(e, n);
  const [ct, st] = rho > 0 ? [n / rho, e / rho] : [1, 0];
  const r = Math.atan2(rho, lat >= 0 ? z : -z) / Math.PI;
  return lat >= 0 ? [r * ct, -r * st] : [r * ct, r * st];
}

export function mockStarFinderGeometry(latBand: number): StarFinderGeometry {
  if (!Number.isFinite(latBand) || Math.abs(latBand) > 90) throw new Error(`lat_band must be a latitude in degrees (got ${latBand})`);
  const band = Math.min(85, Math.max(5, Math.floor(Math.min(Math.abs(latBand), 89.999) / 10) * 10 + 5));
  const lat = latBand < 0 ? -band : band;
  const side: StarFinderSide = lat >= 0 ? 'north' : 'south';
  const r6 = (p: StarFinderPoint): StarFinderPoint => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];
  const circle = (h: number): StarFinderPoint[] => Array.from({ length: 73 }, (_, k) => r6(templateXy(lat, h, k * 5)));
  const altitude_circles: StarFinderLine[] = Array.from({ length: 17 }, (_, k) => ({ value_deg: (k + 1) * 5, points: circle((k + 1) * 5) }));
  const azimuth_lines: StarFinderLine[] = Array.from({ length: 36 }, (_, k) => ({
    value_deg: k * 10,
    points: Array.from({ length: 37 }, (_, j) => r6(templateXy(lat, j * 2.5, k * 10))),
  }));
  const aries_index: AriesTick[] = Array.from({ length: 360 }, (_, g) => ({
    lha_aries_deg: g,
    north: r6(baseXy('north', g, -90)),
    south: r6(baseXy('south', g, 90)),
    kind: g % 10 === 0 ? 'label' : g % 5 === 0 ? 'major' : 'minor',
  }));
  return {
    requested_latitude_deg: latBand,
    template_latitude_deg: lat,
    side,
    rotation_sign: side === 'north' ? 1 : -1,
    equator_radius: 0.5,
    epoch: 'J2000.0 catalogue place',
    stars: NAV_STAR_ROWS.map(([name, , ra, dec, vmag]) => ({
      name,
      sha_deg: norm360(360 - ra),
      dec_deg: dec,
      magnitude: vmag,
      north: baseXy('north', ra, dec),
      south: baseXy('south', ra, dec),
    })),
    aries_index,
    template: { latitude_deg: lat, side, zenith: r6(templateXy(lat, 90, 0)), horizon: circle(0), altitude_circles, azimuth_lines },
    notes: [MOCK_NOTE],
  };
}

/** The mock's `SailingsEngine`, over the mock sky. */
export function createMockSailings(skyState: (o: Observer, jd: number) => SkyState): SailingsEngine {
  return {
    sailing: mockSailing,
    drAdvance: mockDrAdvance,
    routePositions: mockRoutePositions,
    starIdentify: (req) => mockStarIdentify(req, skyState),
    starFinderGeometry: (latBand) => mockStarFinderGeometry(latBand),
  };
}
