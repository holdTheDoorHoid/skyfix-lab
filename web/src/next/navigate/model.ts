/**
 * The Navigate view's working state: the session of sights (a `skyfix.session/1`
 * document, CONVENTIONS section 10), which sights the fix leaves out, the bodies still to
 * shoot, and each method's inputs. Pure data and pure functions; the store, autosave and
 * rendering live elsewhere. OWNER: navigate agent.
 *
 * One session, many methods. Sights are entered once; each method takes the sights it
 * works on (the fix: every sight not left out; a noon sight or an average: the sights of
 * one body; Polaris: the Polaris sights) and builds the engine's request from the
 * session and its own inputs. The session is never mutated: every edit returns a new one.
 */

import type { Objective, PlanOptions } from '../../api/adapter.js';
import { defaultPlanOptions } from '../../api/adapter.js';
import type { LatLon, Observation, Session, SolveOptions } from '../../types.js';
import { defaultSolveOptions, SESSION_SCHEMA } from '../../types.js';
import type {
  AmplitudeHorizon,
  AveragingOptions,
  BodyBearing,
  CompassKind,
  CompassMethod,
  DrMethod,
  DrPosition,
  EphemerisMode,
  LunarDistanceInput,
  MeridionalParts,
  NoonCurvature,
  NoonSightOptions,
  PolarisOptions,
  RiseSet,
  RunningFixRequest,
  SightLimb,
  SingleAltitudeMode,
  VesselMotion,
} from '../engine/types.js';
import type { MethodId } from './text.js';

/** A body the planner recommends, not yet observed. It becomes a sight only with a reading. */
export interface PlannedSight {
  body: string;
  kind: 'sun' | 'moon' | 'planet' | 'star';
  limb: SightLimb;
  /** When the prediction is for (RFC 3339 UTC). */
  utc: string;
  /** Predicted sextant reading, computed altitude and bearing: a guide, never an observation. */
  hs_deg: number;
  hc_deg: number;
  zn_deg: number;
  /** Where it came from ("Tonight's sights, evening twilight"). */
  from: string;
}

export interface SolveForm {
  estimate_shared_bias: boolean;
  robust: boolean;
  posterior_scaling: boolean;
  multistart: boolean;
  max_iterations: number;
}

/** Constant course and speed; both null means "not stated" (a stationary observer). */
export interface VesselForm {
  course_deg: number | null;
  speed_kn: number | null;
}

export interface NoonForm {
  /** The body of the run; null means "the body with the most sights". */
  body: string | null;
  bearing: BodyBearing;
  curvature: NoonCurvature;
  single: SingleAltitudeMode;
  /** The DR's 1-sigma, NM; null = not stated (never replaced by a guess). */
  drSigmaNm: number | null;
  vessel: VesselForm;
}

export interface PolarisForm {
  drSigmaNm: number | null;
  vessel: VesselForm;
  referenceUtc: string | null;
}

export interface AverageForm {
  body: string | null;
  referenceUtc: string | null;
  drSigmaNm: number | null;
  vessel: VesselForm;
  rejectOutliers: boolean;
  threshold: number;
}

export interface LegForm {
  /** Null only for the first leg: it then starts at the earliest sight. */
  start_utc: string | null;
  course_deg: number;
  speed_kn: number;
}

export interface RunningForm {
  legs: LegForm[];
  referenceUtc: string | null;
  endUtc: string | null;
  speedSigmaKn: number;
  courseSigmaDeg: number;
  walkNmPerSqrtHour: number;
}

export interface LunarAltitudeForm {
  /** Null: computed from the DR instead of observed. */
  deg: number | null;
  kind: 'sextant_hs' | 'apparent_ha';
  limb: SightLimb;
}

export interface LunarForm {
  body: string;
  watchUtc: string | null;
  distanceDeg: number | null;
  moonLimb: 'near' | 'far';
  bodyLimb: 'near' | 'far' | 'center';
  moonAltitude: LunarAltitudeForm;
  bodyAltitude: LunarAltitudeForm;
  sigmaArcmin: number;
  searchHours: number;
  drSigmaNm: number | null;
}

export interface PlannerForm {
  /** Null: the DR (session) or, without one, the map's place. */
  position: LatLon | null;
  /** Null: the time bar's time. */
  utc: string | null;
  select: number;
  objective: Objective;
  minAlt: number;
  maxAlt: number;
  baseSigma: number;
}

// --- Expansion programme (navigate2 agent): the compass and the passage --------------------

/** The Compass tab's inputs (`compass_error`, EXPLORER_API "magnetic field and compass error"). */
export interface CompassForm {
  method: CompassMethod;
  body: string;
  /** When the bearing was taken (RFC 3339 UTC); null: the time bar's time. */
  utc: string | null;
  /** What the compass read, [0, 360); null until typed. */
  bearingDeg: number | null;
  compass: CompassKind;
  /** The chart's variation, east positive; null: the magnetic model's. */
  variationDeg: number | null;
  /** 1-sigma of the compass reading; null: not stated (never guessed). */
  bearingSigmaDeg: number | null;
  /** Amplitude only. */
  horizon: AmplitudeHorizon;
  limb: SightLimb;
  /** Amplitude only; null: from the body's side of the meridian. */
  event: RiseSet | null;
  /** The ship's heading by this compass when the bearing was taken (for the deviation table). */
  headingDeg: number | null;
}

/** One line of the deviation table: this compass's deviation on one heading. */
export interface DeviationEntry {
  id: string;
  /** The ship's heading by this compass, [0, 360). */
  headingDeg: number;
  /** East positive (compass error minus variation). */
  deviationDeg: number;
  /** When it was found (RFC 3339 UTC), or null when typed from elsewhere. */
  utc: string | null;
  /** Where it came from ("Sun by azimuth", "typed"). */
  source: string;
  note: string;
}

/** How a leg of the route is sailed. */
export type LegKind = 'great_circle' | 'rhumb';

export interface RouteWaypoint {
  id: string;
  name: string;
  lat_deg: number;
  lon_deg: number;
  /** How the leg that arrives here is sailed (ignored on the first waypoint). */
  leg: LegKind;
}

/** The forward dead-reckoning calculator (`dr_advance`). */
export interface DrForm {
  /** Null: the session's assumed position, or the map's place. */
  from: LatLon | null;
  courseDeg: number | null;
  speedKn: number | null;
  /** Hours run; negative: where the vessel was. */
  hours: number | null;
  /** When the run starts (RFC 3339 UTC), for the arrival time; null: none. */
  startUtc: string | null;
  method: DrMethod;
}

/** The Passage tab: a route of waypoints sailed at a speed from a departure time. */
export interface PassageForm {
  waypoints: RouteWaypoint[];
  speedKn: number | null;
  departureUtc: string | null;
  /** Meridional parts for the rhumb-line legs (Mercator sailing). */
  parts: MeridionalParts;
  /** Draw the route on the explorer's map. */
  showOnMap: boolean;
  /** A dead-reckoning mark every so many hours along the route (0: none). */
  tickHours: number;
  dr: DrForm;
}

export interface Working {
  session: Session;
  /** Sight ids the fix and the running fix leave out ("use in fix" unticked). */
  excluded: string[];
  /** Bodies to shoot, from the planner: guides, not observations. */
  planned: PlannedSight[];
  /** Where directions come from (EXPLORER_API "Common to all four"). */
  mode: EphemerisMode;
  method: MethodId;
  solve: SolveForm;
  noon: NoonForm;
  polaris: PolarisForm;
  average: AverageForm;
  running: RunningForm;
  lunar: LunarForm;
  planner: PlannerForm;
  /** Expansion programme (navigate2): the Compass tab. */
  compass: CompassForm;
  /** This compass's deviations by heading (the deviation table). */
  deviations: DeviationEntry[];
  /** Expansion programme (navigate2): the Passage tab. */
  passage: PassageForm;
}

export interface SessionSeed {
  name?: string;
  position?: LatLon | null;
  heightOfEyeM?: number;
  indexCorrectionArcmin?: number;
}

/** A new, empty session: a real one (the person's own sights), sea horizon. */
export function emptySession(seed: SessionSeed = {}): Session {
  return {
    schema: SESSION_SCHEMA,
    meta: { name: seed.name ?? 'My sights', notes: '', kind: 'real' },
    observer: {
      height_of_eye_m: seed.heightOfEyeM ?? 2,
      pressure_hpa: 1010,
      temperature_c: 10,
      assumed_position: seed.position ? { lat_deg: seed.position.lat_deg, lon_deg: seed.position.lon_deg } : null,
      assumed_position_role: { role: 'initializer' },
    },
    instrument: { name: '', index_correction_arcmin: seed.indexCorrectionArcmin ?? 0, horizon: 'sea' },
    clock: { uncertainty_s: 0, correction_s: 0 },
    observations: [],
  };
}

export function defaultSolveForm(): SolveForm {
  return { estimate_shared_bias: false, robust: false, posterior_scaling: false, multistart: true, max_iterations: 50 };
}

const noVessel = (): VesselForm => ({ course_deg: null, speed_kn: null });

export function defaultWorking(seed: SessionSeed = {}): Working {
  const plan = defaultPlanOptions();
  return {
    session: emptySession(seed),
    excluded: [],
    planned: [],
    mode: 'auto',
    method: 'fix',
    solve: defaultSolveForm(),
    noon: { body: null, bearing: 'auto', curvature: 'predicted', single: 'maximum', drSigmaNm: null, vessel: noVessel() },
    polaris: { drSigmaNm: null, vessel: noVessel(), referenceUtc: null },
    average: { body: null, referenceUtc: null, drSigmaNm: null, vessel: noVessel(), rejectOutliers: true, threshold: 3 },
    running: { legs: [{ start_utc: null, course_deg: 0, speed_kn: 0 }], referenceUtc: null, endUtc: null, speedSigmaKn: 0, courseSigmaDeg: 0, walkNmPerSqrtHour: 0 },
    lunar: {
      body: 'Sun',
      watchUtc: null,
      distanceDeg: null,
      moonLimb: 'near',
      bodyLimb: 'near',
      moonAltitude: { deg: null, kind: 'sextant_hs', limb: 'lower' },
      bodyAltitude: { deg: null, kind: 'sextant_hs', limb: 'center' },
      sigmaArcmin: 0.2,
      searchHours: 12,
      drSigmaNm: null,
    },
    planner: {
      position: null,
      utc: null,
      select: plan.select,
      objective: plan.objective,
      minAlt: plan.min_altitude_deg,
      maxAlt: plan.max_altitude_deg,
      baseSigma: plan.base_sigma_arcmin,
    },
    compass: defaultCompassForm(),
    deviations: [],
    passage: defaultPassageForm(),
  };
}

export function defaultCompassForm(): CompassForm {
  return {
    method: 'azimuth',
    body: 'Sun',
    utc: null,
    bearingDeg: null,
    compass: 'magnetic',
    variationDeg: null,
    bearingSigmaDeg: null,
    horizon: 'visible',
    limb: 'center',
    event: null,
    headingDeg: null,
  };
}

export function defaultPassageForm(): PassageForm {
  return {
    waypoints: [],
    speedKn: null,
    departureUtc: null,
    parts: 'sphere',
    showOnMap: true,
    tickHours: 6,
    dr: { from: null, courseDeg: null, speedKn: null, hours: null, startUtc: null, method: 'rhumb' },
  };
}

// ---------------------------------------------------------------------------------------
// Editing the session (always a new object)
// ---------------------------------------------------------------------------------------

/** `obs-N`, one more than the largest `obs-N` in the session (the project's convention). */
export function nextObservationId(session: Session): string {
  let n = 0;
  for (const o of session.observations) {
    const m = /^obs-(\d+)$/.exec(o.id);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let id = `obs-${n + 1}`;
  const taken = new Set(session.observations.map((o) => o.id));
  while (taken.has(id)) id = `obs-${++n + 1}`;
  return id;
}

/** Add an observation, or replace the one with `replaceId` in place (keeping its position). */
export function withObservation(session: Session, obs: Observation, replaceId?: string | null): Session {
  const list = [...session.observations];
  const at = replaceId ? list.findIndex((o) => o.id === replaceId) : -1;
  if (at >= 0) list[at] = obs;
  else list.push(obs);
  return { ...session, observations: list };
}

export function withoutObservation(session: Session, id: string): Session {
  return { ...session, observations: session.observations.filter((o) => o.id !== id) };
}

/**
 * Whether the working session holds something the person entered: a sight, a lunar
 * reading, running-fix legs, notes. Autosave keeps nothing until it does. A new session's
 * assumed position is a copy of the map's place, and the explorer never stores the place
 * on its own, so opening Navigate, switching methods or taking tonight's bodies to shoot
 * (a plan the panel remakes in one click) must not store it either.
 */
export function hasOwnData(w: Working): boolean {
  const legs = w.running.legs;
  const untouchedLegs = legs.length === 1 && legs[0]!.start_utc === null && legs[0]!.course_deg === 0 && legs[0]!.speed_kn === 0;
  return (
    w.session.observations.length > 0 ||
    w.lunar.distanceDeg !== null ||
    w.lunar.watchUtc !== null ||
    w.lunar.moonAltitude.deg !== null ||
    w.lunar.bodyAltitude.deg !== null ||
    !untouchedLegs ||
    w.session.meta.notes.trim() !== '' ||
    // navigate2: a compass reading, the deviation table, a route or a DR worked out are
    // the person's own entries too; the error logs are part of the session's settings.
    w.compass.bearingDeg !== null ||
    w.deviations.length > 0 ||
    w.passage.waypoints.length > 0 ||
    w.passage.dr.from !== null ||
    (w.session.instrument.index_error_log?.length ?? 0) > 0 ||
    (w.session.clock.watch_log?.length ?? 0) > 0
  );
}

export interface SessionPatch {
  meta?: Partial<Session['meta']>;
  observer?: Partial<Session['observer']>;
  instrument?: Partial<Session['instrument']>;
  clock?: Partial<Session['clock']>;
}

export function patchSession(session: Session, patch: SessionPatch): Session {
  return {
    ...session,
    meta: patch.meta ? { ...session.meta, ...patch.meta } : session.meta,
    observer: patch.observer ? { ...session.observer, ...patch.observer } : session.observer,
    instrument: patch.instrument ? { ...session.instrument, ...patch.instrument } : session.instrument,
    clock: patch.clock ? { ...session.clock, ...patch.clock } : session.clock,
  };
}

/** Sort sights by time (then id), as a navigator's notebook reads. */
export function sortedByTime(observations: readonly Observation[]): Observation[] {
  return [...observations].sort((a, b) => (a.utc < b.utc ? -1 : a.utc > b.utc ? 1 : a.id.localeCompare(b.id)));
}

const norm = (s: string) => s.trim().toLowerCase();

/** The bodies in a session with how many sights each, most first (ties: Sun, then by name). */
export function bodyCounts(session: Session): { body: string; count: number }[] {
  const counts = new Map<string, { body: string; count: number }>();
  for (const o of session.observations) {
    const key = norm(o.body);
    if (!key) continue;
    const entry = counts.get(key) ?? { body: o.body.trim(), count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  return [...counts.values()].sort(
    (a, b) => b.count - a.count || (norm(a.body) === 'sun' ? -1 : norm(b.body) === 'sun' ? 1 : a.body.localeCompare(b.body)),
  );
}

/** The run's body: the one asked for if the session has it, else the one with the most sights. */
export function runBody(session: Session, wanted: string | null): string | null {
  const counts = bodyCounts(session);
  if (wanted && counts.some((c) => norm(c.body) === norm(wanted))) return counts.find((c) => norm(c.body) === norm(wanted))!.body;
  return counts[0]?.body ?? null;
}

export function sightsOf(session: Session, body: string | null): Session {
  return { ...session, observations: body ? session.observations.filter((o) => norm(o.body) === norm(body)) : [] };
}

/** The sights a fix uses: every one not left out. */
export function fixSession(w: Working): Session {
  const out = new Set(w.excluded);
  return { ...w.session, observations: w.session.observations.filter((o) => !out.has(o.id)) };
}

export function noonSession(w: Working): Session {
  return sightsOf(w.session, runBody(w.session, w.noon.body));
}

export function averageSession(w: Working): Session {
  return sightsOf(w.session, runBody(w.session, w.average.body));
}

export function polarisSession(w: Working): Session {
  return sightsOf(w.session, w.session.observations.some((o) => norm(o.body) === 'polaris') ? 'Polaris' : null);
}

// ---------------------------------------------------------------------------------------
// Requests for the engine
// ---------------------------------------------------------------------------------------

/**
 * Solve options from the form and the session, as the old workbench built them: the
 * assumed position is the initializer or the prior as its role says, never both, and the
 * clock's uncertainty comes from the session (CONVENTIONS sections 6 and 8).
 */
export function solveOptionsFor(w: Working): SolveOptions {
  const base = defaultSolveOptions();
  const session = w.session;
  const role = session.observer.assumed_position_role;
  const ap = session.observer.assumed_position;
  return {
    ...base,
    initializer: role.role === 'initializer' && ap ? { ...ap } : null,
    prior: role.role === 'prior' && ap ? { center: { ...ap }, sigma_nm: role.sigma_nm } : null,
    estimate_shared_bias: w.solve.estimate_shared_bias,
    robust: w.solve.robust ? { huber_k: 1.5, max_reweight_iterations: 10 } : null,
    clock_uncertainty_s: session.clock.uncertainty_s,
    posterior_scaling: w.solve.posterior_scaling,
    multistart: { ...base.multistart, enabled: w.solve.multistart },
    max_iterations: Math.max(1, Math.round(w.solve.max_iterations)),
  };
}

/** The DR a method uses: the session's assumed position with the method's stated sigma. */
export function drFor(session: Session, sigmaNm: number | null): DrPosition | null {
  const ap = session.observer.assumed_position;
  if (!ap) return null;
  return { lat_deg: ap.lat_deg, lon_deg: ap.lon_deg, sigma_nm: sigmaNm };
}

export function vesselFor(v: VesselForm): VesselMotion | null {
  return v.course_deg !== null && v.speed_kn !== null && v.speed_kn > 0 ? { course_deg: v.course_deg, speed_kn: v.speed_kn } : null;
}

export function noonOptionsFor(w: Working): NoonSightOptions {
  const out: NoonSightOptions = {
    dr: drFor(w.session, w.noon.drSigmaNm),
    body_bearing: w.noon.bearing,
    curvature: w.noon.curvature,
    single_altitude: w.noon.single,
  };
  const vessel = vesselFor(w.noon.vessel);
  if (vessel) out.vessel = vessel;
  return out;
}

export function polarisOptionsFor(w: Working): PolarisOptions {
  const out: PolarisOptions = { dr: drFor(w.session, w.polaris.drSigmaNm) };
  const vessel = vesselFor(w.polaris.vessel);
  if (vessel) out.vessel = vessel;
  if (w.polaris.referenceUtc) out.reference_utc = w.polaris.referenceUtc;
  return out;
}

export function averageOptionsFor(w: Working): AveragingOptions {
  const out: AveragingOptions = {
    dr: drFor(w.session, w.average.drSigmaNm),
    reject_outliers: w.average.rejectOutliers,
    outlier_threshold: w.average.threshold,
  };
  const vessel = vesselFor(w.average.vessel);
  if (vessel) out.vessel = vessel;
  if (w.average.referenceUtc) out.reference_utc = w.average.referenceUtc;
  return out;
}

export function runningRequestFor(w: Working): RunningFixRequest {
  const r = w.running;
  const request: RunningFixRequest = {
    legs: r.legs.map((leg, i) => ({
      ...(i === 0 && !leg.start_utc ? {} : { start_utc: leg.start_utc }),
      course_deg: leg.course_deg,
      speed_kn: leg.speed_kn,
    })),
    motion_uncertainty: {
      speed_sigma_kn: r.speedSigmaKn,
      course_sigma_deg: r.courseSigmaDeg,
      random_walk_nm_per_sqrt_hour: r.walkNmPerSqrtHour,
    },
    options: solveOptionsFor(w),
  };
  if (r.referenceUtc) request.reference_utc = r.referenceUtc;
  if (r.endUtc) request.end_utc = r.endUtc;
  return request;
}

/**
 * The lunar distance request, or the reason there is none yet. The DR is the session's
 * assumed position, or the map's place when the session has none.
 */
export function lunarInputFor(w: Working, place: LatLon): { input: LunarDistanceInput } | { missing: string } {
  const f = w.lunar;
  if (f.distanceDeg === null) return { missing: 'Enter the measured distance between the Moon and the other body.' };
  if (!f.watchUtc) return { missing: 'Enter the time your watch showed when you measured the distance (UTC).' };
  const ap = w.session.observer.assumed_position ?? place;
  const altitude = (a: LunarAltitudeForm) =>
    a.deg === null ? null : { altitude_deg: a.deg, altitude_kind: a.kind, limb: a.limb, sigma_arcmin: 1 };
  const bodyLimb = f.body === 'Sun' ? f.bodyLimb : 'center';
  return {
    input: {
      observer: {
        lat_deg: ap.lat_deg,
        lon_deg: ap.lon_deg,
        height_of_eye_m: w.session.observer.height_of_eye_m,
        pressure_hpa: w.session.observer.pressure_hpa,
        temperature_c: w.session.observer.temperature_c,
        // The session's UT1 − UTC, as its fix uses (expansion programme).
        dut1_s: w.session.clock.dut1_s ?? null,
      },
      instrument: {
        index_correction_arcmin: w.session.instrument.index_correction_arcmin,
        horizon: w.session.instrument.horizon,
      },
      body: f.body,
      utc_estimate: f.watchUtc,
      distance_deg: f.distanceDeg,
      moon_limb: f.moonLimb,
      body_limb: bodyLimb,
      moon_altitude: altitude(f.moonAltitude),
      body_altitude: altitude({ ...f.bodyAltitude, limb: f.body === 'Sun' ? f.bodyAltitude.limb : 'center' }),
      sigma_arcmin: f.sigmaArcmin,
      search_hours: f.searchHours,
      dr_uncertainty_nm: f.drSigmaNm ?? 0,
    },
  };
}

export function plannerOptionsFor(w: Working): PlanOptions {
  return {
    ...defaultPlanOptions(),
    select: Math.max(1, Math.round(w.planner.select)),
    objective: w.planner.objective,
    min_altitude_deg: w.planner.minAlt,
    max_altitude_deg: w.planner.maxAlt,
    base_sigma_arcmin: Math.max(w.planner.baseSigma, 0.01),
  };
}
