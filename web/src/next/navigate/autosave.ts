/**
 * Keeping the working session in this browser (localStorage), so a reload does not lose
 * the sights. OWNER: navigate agent.
 *
 * Rules (task brief and EXPLORER_PLAN section 1):
 * - It is the person's own data on their own device, and the view says so where the
 *   switch is. They can turn it off, and "Forget" removes the copy at once.
 * - Every access is wrapped: a private window, blocked site data or a full quota means
 *   "not saved", never an error.
 * - Nothing here, or anywhere in the Navigate view, writes a position to the address bar.
 * - What comes back is checked field by field; anything malformed takes its default, and a
 *   malformed observation is dropped rather than guessed at.
 */

import type {
  AltitudeKind,
  AssumedPositionRole,
  GeocentricDirection,
  IndexErrorLogEntry,
  Limb,
  Observation,
  Session,
  SessionKind,
  WatchLogEntry,
} from '../../types.js';
import { asHorizon, SESSION_SCHEMA } from '../../types.js';
import type { BodyBearing, EphemerisMode, NoonCurvature, SightLimb, SingleAltitudeMode } from '../engine/types.js';
import type { MethodId } from './text.js';
import { METHODS } from './text.js';
import { defaultWorking, type PlannedSight, type VesselForm, type Working } from './model.js';

/** The one key the Navigate view writes. */
export const AUTOSAVE_KEY = 'skyfix.navigate.working.v1';

export interface Envelope {
  v: 1;
  /** When it was saved (RFC 3339 UTC). */
  saved_utc: string | null;
  /** The person's choice: keep a copy in this browser. */
  autosave: boolean;
  working: Working | null;
}

export interface Loaded {
  working: Working | null;
  autosave: boolean;
  savedUtc: string | null;
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => x !== null && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown, d: string): string => (typeof x === 'string' ? x : d);
const num = (x: unknown, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const bool = (x: unknown, d: boolean): boolean => (typeof x === 'boolean' ? x : d);
const pick = <T extends string>(x: unknown, allowed: readonly T[], d: T): T => (allowed.includes(x as T) ? (x as T) : d);
const strOrNull = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

const KINDS: readonly AltitudeKind[] = ['sextant_hs', 'apparent_ha', 'observed_ho'];
const LIMBS: readonly Limb[] = ['center', 'lower', 'upper'];

/** An error log's entries that are usable (a time and a finite value); absent when none are. */
function logEntries<K extends 'ic_arcmin' | 'correction_s'>(x: unknown, key: K): Array<{ utc: string; note: string } & Record<K, number>> {
  if (!Array.isArray(x)) return [];
  const out: Array<{ utc: string; note: string } & Record<K, number>> = [];
  for (const e of x) {
    if (!isRec(e) || typeof e.utc !== 'string') continue;
    const v = numOrNull(e[key]);
    if (v === null) continue;
    out.push({ utc: e.utc, note: str(e.note, ''), [key]: v } as { utc: string; note: string } & Record<K, number>);
  }
  return out;
}

function position(x: unknown): { lat_deg: number; lon_deg: number } | null {
  if (!isRec(x)) return null;
  const lat = numOrNull(x.lat_deg);
  const lon = numOrNull(x.lon_deg);
  return lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat_deg: lat, lon_deg: lon } : null;
}

function direction(x: unknown): GeocentricDirection | null {
  if (!isRec(x)) return null;
  const gha = numOrNull(x.gha_deg);
  const dec = numOrNull(x.dec_deg);
  if (gha === null || dec === null) return null;
  return {
    gha_deg: gha,
    dec_deg: dec,
    semidiameter_arcmin: num(x.semidiameter_arcmin, 0),
    horizontal_parallax_arcmin: num(x.horizontal_parallax_arcmin, 0),
  };
}

function observation(x: unknown): Observation | null {
  if (!isRec(x) || typeof x.id !== 'string' || !x.id || typeof x.body !== 'string') return null;
  const altitude = numOrNull(x.altitude_deg);
  const sigma = numOrNull(x.sigma_arcmin);
  if (altitude === null || sigma === null || !(sigma > 0) || typeof x.utc !== 'string') return null;
  return {
    id: x.id,
    body: x.body,
    utc: x.utc,
    altitude_deg: altitude,
    altitude_kind: pick(x.altitude_kind, KINDS, 'sextant_hs'),
    sigma_arcmin: sigma,
    limb: pick(x.limb, LIMBS, 'center'),
    horizon: x.horizon === null || x.horizon === undefined ? null : (asHorizon(x.horizon) ?? 'sea'),
    geocentric: direction(x.geocentric),
    notes: str(x.notes, ''),
  };
}

/** A well-typed session from anything, or null when it is not one at all. */
export function sanitizeSession(raw: unknown): Session | null {
  if (!isRec(raw) || !Array.isArray(raw.observations)) return null;
  const meta = isRec(raw.meta) ? raw.meta : {};
  const observer = isRec(raw.observer) ? raw.observer : {};
  const instrument = isRec(raw.instrument) ? raw.instrument : {};
  const clock = isRec(raw.clock) ? raw.clock : {};
  const roleRaw = isRec(observer.assumed_position_role) ? observer.assumed_position_role : {};
  const role: AssumedPositionRole =
    roleRaw.role === 'prior' && num(roleRaw.sigma_nm, 0) > 0
      ? { role: 'prior', sigma_nm: num(roleRaw.sigma_nm, 20) }
      : roleRaw.role === 'disabled'
        ? { role: 'disabled' }
        : { role: 'initializer' };
  const seen = new Set<string>();
  const observations: Observation[] = [];
  for (const o of raw.observations) {
    const clean = observation(o);
    if (clean && !seen.has(clean.id)) {
      seen.add(clean.id);
      observations.push(clean);
    }
  }
  return {
    schema: str(raw.schema, SESSION_SCHEMA),
    meta: {
      name: str(meta.name, 'My sights'),
      notes: str(meta.notes, ''),
      kind: pick<SessionKind>(meta.kind, ['simulated', 'real'], 'real'),
    },
    observer: {
      height_of_eye_m: Math.max(0, num(observer.height_of_eye_m, 2)),
      pressure_hpa: num(observer.pressure_hpa, 1010),
      temperature_c: num(observer.temperature_c, 10),
      assumed_position: position(observer.assumed_position),
      assumed_position_role: role,
    },
    instrument: {
      name: str(instrument.name, ''),
      index_correction_arcmin: num(instrument.index_correction_arcmin, 0),
      horizon: asHorizon(instrument.horizon) ?? 'sea',
      ...((): { index_error_log?: IndexErrorLogEntry[] } => {
        const log = logEntries(instrument.index_error_log, 'ic_arcmin');
        return log.length > 0 ? { index_error_log: log } : {};
      })(),
    },
    clock: {
      uncertainty_s: Math.max(0, num(clock.uncertainty_s, 0)),
      correction_s: num(clock.correction_s, 0),
      // UT1 − UTC (expansion programme): kept when it is a number, else automatic.
      ...(typeof clock.dut1_s === 'number' && Number.isFinite(clock.dut1_s) ? { dut1_s: clock.dut1_s } : {}),
      ...((): { watch_log?: WatchLogEntry[] } => {
        const log = logEntries(clock.watch_log, 'correction_s');
        return log.length > 0 ? { watch_log: log } : {};
      })(),
    },
    observations,
  };
}

function vessel(x: unknown): VesselForm {
  const r = isRec(x) ? x : {};
  return { course_deg: numOrNull(r.course_deg), speed_kn: numOrNull(r.speed_kn) };
}

function planned(x: unknown): PlannedSight | null {
  if (!isRec(x) || typeof x.body !== 'string' || typeof x.utc !== 'string') return null;
  const hs = numOrNull(x.hs_deg);
  const hc = numOrNull(x.hc_deg);
  const zn = numOrNull(x.zn_deg);
  if (hs === null || hc === null || zn === null) return null;
  return {
    body: x.body,
    kind: pick(x.kind, ['sun', 'moon', 'planet', 'star'] as const, 'star'),
    limb: pick<SightLimb>(x.limb, LIMBS, 'center'),
    utc: x.utc,
    hs_deg: hs,
    hc_deg: hc,
    zn_deg: zn,
    from: str(x.from, ''),
  };
}

/** Everything the view keeps, from anything: bad fields take their defaults. */
export function sanitizeWorking(raw: unknown): Working | null {
  if (!isRec(raw)) return null;
  const session = sanitizeSession(raw.session);
  if (!session) return null;
  const d = defaultWorking();
  const ids = new Set(session.observations.map((o) => o.id));
  const rec = (x: unknown): Rec => (isRec(x) ? x : {});
  const solve = rec(raw.solve);
  const noon = rec(raw.noon);
  const polaris = rec(raw.polaris);
  const average = rec(raw.average);
  const running = rec(raw.running);
  const lunar = rec(raw.lunar);
  const planner = rec(raw.planner);
  const methods = METHODS.map((m) => m.id);
  const legs = Array.isArray(running.legs)
    ? running.legs
        .filter(isRec)
        .map((l, i) => ({
          start_utc: i === 0 ? strOrNull(l.start_utc) : str(l.start_utc, ''),
          course_deg: num(l.course_deg, 0),
          speed_kn: Math.max(0, num(l.speed_kn, 0)),
        }))
        .filter((l, i) => i === 0 || l.start_utc)
    : [];
  const alt = (x: unknown, dLimb: SightLimb) => {
    const r = rec(x);
    return {
      deg: numOrNull(r.deg),
      kind: pick(r.kind, ['sextant_hs', 'apparent_ha'] as const, 'sextant_hs'),
      limb: pick<SightLimb>(r.limb, LIMBS, dLimb),
    };
  };
  return {
    session,
    excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((x): x is string => typeof x === 'string' && ids.has(x)) : [],
    planned: Array.isArray(raw.planned) ? raw.planned.map(planned).filter((x): x is PlannedSight => x !== null) : [],
    mode: pick<EphemerisMode>(raw.mode, ['auto', 'supplied'], d.mode),
    method: pick<MethodId>(raw.method, methods, d.method),
    solve: {
      estimate_shared_bias: bool(solve.estimate_shared_bias, false),
      robust: bool(solve.robust, false),
      posterior_scaling: bool(solve.posterior_scaling, false),
      multistart: bool(solve.multistart, true),
      max_iterations: Math.min(500, Math.max(1, Math.round(num(solve.max_iterations, 50)))),
    },
    noon: {
      body: strOrNull(noon.body),
      bearing: pick<BodyBearing>(noon.bearing, ['auto', 'north', 'south'], 'auto'),
      curvature: pick<NoonCurvature>(noon.curvature, ['predicted', 'fitted'], 'predicted'),
      single: pick<SingleAltitudeMode>(noon.single, ['maximum', 'ex_meridian'], 'maximum'),
      drSigmaNm: numOrNull(noon.drSigmaNm),
      vessel: vessel(noon.vessel),
    },
    polaris: { drSigmaNm: numOrNull(polaris.drSigmaNm), vessel: vessel(polaris.vessel), referenceUtc: strOrNull(polaris.referenceUtc) },
    average: {
      body: strOrNull(average.body),
      referenceUtc: strOrNull(average.referenceUtc),
      drSigmaNm: numOrNull(average.drSigmaNm),
      vessel: vessel(average.vessel),
      rejectOutliers: bool(average.rejectOutliers, true),
      threshold: Math.max(1, num(average.threshold, 3)),
    },
    running: {
      legs: legs.length ? legs : d.running.legs,
      referenceUtc: strOrNull(running.referenceUtc),
      endUtc: strOrNull(running.endUtc),
      speedSigmaKn: Math.max(0, num(running.speedSigmaKn, 0)),
      courseSigmaDeg: Math.max(0, num(running.courseSigmaDeg, 0)),
      walkNmPerSqrtHour: Math.max(0, num(running.walkNmPerSqrtHour, 0)),
    },
    lunar: {
      body: str(lunar.body, d.lunar.body),
      watchUtc: strOrNull(lunar.watchUtc),
      distanceDeg: numOrNull(lunar.distanceDeg),
      moonLimb: pick(lunar.moonLimb, ['near', 'far'] as const, 'near'),
      bodyLimb: pick(lunar.bodyLimb, ['near', 'far', 'center'] as const, 'near'),
      moonAltitude: alt(lunar.moonAltitude, 'lower'),
      bodyAltitude: alt(lunar.bodyAltitude, 'center'),
      sigmaArcmin: Math.max(0.01, num(lunar.sigmaArcmin, 0.2)),
      searchHours: Math.min(48, Math.max(1, num(lunar.searchHours, 12))),
      drSigmaNm: numOrNull(lunar.drSigmaNm),
    },
    planner: {
      position: position(planner.position),
      utc: strOrNull(planner.utc),
      select: Math.min(12, Math.max(1, Math.round(num(planner.select, d.planner.select)))),
      objective: pick(planner.objective, ['min_trace', 'min_max_eigenvalue', 'min_condition_number'] as const, d.planner.objective),
      minAlt: num(planner.minAlt, d.planner.minAlt),
      maxAlt: num(planner.maxAlt, d.planner.maxAlt),
      baseSigma: Math.max(0.01, num(planner.baseSigma, d.planner.baseSigma)),
    },
  };
}

/** Read the saved copy. A missing, unreadable or malformed one is "nothing saved". */
export function loadWorking(storage: Storage | null): Loaded {
  let raw: unknown = null;
  try {
    const text = storage?.getItem(AUTOSAVE_KEY);
    raw = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    raw = null;
  }
  if (!isRec(raw) || raw.v !== 1) return { working: null, autosave: true, savedUtc: null };
  return {
    working: sanitizeWorking(raw.working),
    autosave: bool(raw.autosave, true),
    savedUtc: strOrNull(raw.saved_utc),
  };
}

/** Save now. False when the browser refused (private mode, quota): not an error. */
export function saveWorking(storage: Storage | null, working: Working, nowUtc: string): boolean {
  if (!storage) return false;
  const envelope: Envelope = { v: 1, saved_utc: nowUtc, autosave: true, working };
  try {
    storage.setItem(AUTOSAVE_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove the saved copy. With `stayOff`, remember only the choice not to save (no sights,
 * no position), so the next visit does not start saving again.
 */
export function forgetWorking(storage: Storage | null, stayOff: boolean): boolean {
  if (!storage) return false;
  try {
    if (stayOff) {
      const envelope: Envelope = { v: 1, saved_utc: null, autosave: false, working: null };
      storage.setItem(AUTOSAVE_KEY, JSON.stringify(envelope));
    } else {
      storage.removeItem(AUTOSAVE_KEY);
    }
    return true;
  } catch {
    return false;
  }
}
