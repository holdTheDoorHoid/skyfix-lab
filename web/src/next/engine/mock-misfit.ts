/**
 * MOCK MISFIT GRID — for developing the heat map with no WebAssembly build
 * (`?engine=mock`, or a development server without a complete package). Never a source of
 * results (EXPLORER_PLAN section 3.1): every number is illustrative and every result says
 * so in its notes. OWNER: misfit agent.
 *
 * It implements `MisfitEngine` with the contract's shapes and failure modes, over the old
 * workbench mock (`src/api/mock.ts`): its correction chain and plain Gauss-Newton fit,
 * with body directions from the mock explorer engine when a sight has none. The map is the
 * core's formula (CONVENTIONS section 8), shared bias profiled out when asked; there is no
 * robust reweighting and no polishing — the best point is the lowest of the grid's nodes
 * and the mock fit's answer, and the default frame is a simple box round that answer.
 */

import { mockSolve, reduceEntries } from '../../api/mock.js';
import type { FixResult, LatLon, Session, SolveOptions } from '../../types.js';
import { CHI2_95_2DOF, defaultSolveOptions } from '../../types.js';
import { jdFromIso } from '../time.js';
import type {
  EphemerisMode,
  ExplorerEngine,
  MisfitBounds,
  MisfitDefaultBounds,
  MisfitEngine,
  MisfitGrid,
  MisfitLevel,
  MisfitLevelName,
  MisfitPoint,
} from './types.js';
import { checkAxis } from './wasm-misfit.js';

export const MOCK_MISFIT_NOTE =
  'MOCK engine: an illustrative map from TypeScript geometry, not the SkyFix Lab numerical core.';

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
const ARCMIN = Math.PI / 10800;
const NAMES: MisfitLevelName[] = ['one_sigma', 'p95', 'three_sigma'];
const LABELS = ['68.3 % (1 sigma)', '95 %', '99.7 % (3 sigma)'];
const CONFIDENCE = [0.6826894921370859, 0.95, 0.9973002039367398];
const DELTAS_TWO = [2.295748928898636, CHI2_95_2DOF, 11.829158081900795];
const DELTAS_THREE = [3.52674038026172, 7.814727903251173, 14.156413609126663];

interface Term {
  id: string;
  body: string;
  gha: number;
  sdec: number;
  cdec: number;
  ho: number;
  sigmaArcmin: number;
  /** 1 / sigma², radians. */
  wn: number;
}

/** Supplied directions stay; a named body gets the mock explorer engine's. */
function withDirections(engine: ExplorerEngine, session: Session): Session {
  const observations = session.observations.map((o) => {
    if (o.geocentric) return o;
    const jd = jdFromIso(o.utc);
    if (jd === null) return o;
    try {
      const b = engine.skyState({ lat_deg: 0, lon_deg: 0 }, jd + session.clock.correction_s / 86400, [o.body]).bodies[0];
      if (!b) return o;
      return {
        ...o,
        geocentric: {
          gha_deg: b.gha_deg,
          dec_deg: b.dec_deg,
          semidiameter_arcmin: b.semidiameter_arcmin,
          horizontal_parallax_arcmin: b.horizontal_parallax_arcmin,
        },
      };
    } catch {
      return o;
    }
  });
  return { ...session, observations };
}

function fullOptions(session: Session, options: Partial<SolveOptions> | null): SolveOptions {
  const base = defaultSolveOptions();
  const o: SolveOptions = { ...base, ...(options ?? {}), multistart: { ...base.multistart, ...(options?.multistart ?? {}) } };
  const ap = session.observer.assumed_position;
  if (ap && !o.initializer && session.observer.assumed_position_role.role !== 'disabled') o.initializer = ap;
  return o;
}

interface Prepared {
  terms: Term[];
  options: SolveOptions;
  result: FixResult;
  notes: string[];
}

function prepare(engine: ExplorerEngine, session: Session, options: Partial<SolveOptions> | null): Prepared {
  const filled = withDirections(engine, session);
  const entries = reduceEntries(filled, 'supplied');
  const notes: string[] = [MOCK_MISFIT_NOTE];
  const terms: Term[] = [];
  for (const e of entries) {
    if (e.status === 'error') {
      notes.push(`${e.message}. This sight is not in the map.`);
      continue;
    }
    const s = e.sight;
    if (!(s.sigma_arcmin > 0) || !Number.isFinite(s.ho_deg)) continue;
    const sigma = s.sigma_arcmin * ARCMIN;
    terms.push({
      id: s.id,
      body: s.body,
      gha: s.gha_deg * D2R,
      sdec: Math.sin(s.dec_deg * D2R),
      cdec: Math.cos(s.dec_deg * D2R),
      ho: s.ho_deg * D2R,
      sigmaArcmin: s.sigma_arcmin,
      wn: 1 / (sigma * sigma),
    });
  }
  if (terms.length === 0) {
    throw new Error(
      session.observations.length === 0
        ? 'the session has no observations, so there is no misfit to map'
        : 'every observation was rejected before the solver, so there is no misfit to map',
    );
  }
  const full = fullOptions(session, options);
  if (full.robust) notes.push('The mock has no robust reweighting: every sight is weighted equally.');
  return { terms, options: full, result: mockSolve(filled, full), notes };
}

/** The map's value at one point (CONVENTIONS section 8, the core's formula). */
function valueAt(terms: Term[], bias: boolean, lat: number, lon: number, scratch: Float64Array): number {
  const sphi = Math.sin(lat);
  const cphi = Math.cos(lat);
  let num = 0;
  let den = 0;
  for (let k = 0; k < terms.length; k++) {
    const t = terms[k]!;
    const lha = t.gha + lon;
    const clha = Math.cos(lha);
    const up = sphi * t.sdec + cphi * t.cdec * clha;
    const north = cphi * t.sdec - sphi * t.cdec * clha;
    const east = -t.cdec * Math.sin(lha);
    const d = t.ho - Math.atan(up / Math.sqrt(north * north + east * east));
    scratch[k] = d;
    num += t.wn * d;
    den += t.wn;
  }
  const b = bias ? num / den : 0;
  let acc = 0;
  for (let k = 0; k < terms.length; k++) {
    const e = scratch[k]! - b;
    acc += terms[k]!.wn * e * e;
  }
  return acc;
}

/** The bias that fits best at one point, arcminutes (valueAt leaves the departures in `scratch`). */
function biasAt(terms: Term[], lat: number, lon: number, scratch: Float64Array): number {
  valueAt(terms, true, lat, lon, scratch);
  let num = 0;
  let den = 0;
  for (let k = 0; k < terms.length; k++) {
    num += terms[k]!.wn * scratch[k]!;
    den += terms[k]!.wn;
  }
  return num / den / ARCMIN;
}

function normalise(bounds: MisfitBounds): MisfitBounds {
  const { south_deg, north_deg, west_deg, east_deg } = bounds;
  for (const [name, v] of Object.entries({ south_deg, north_deg, west_deg, east_deg })) {
    if (!Number.isFinite(v)) throw new Error(`bounds: ${name} must be a finite number of degrees`);
  }
  if (south_deg < -90 || north_deg > 90) throw new Error('bounds: latitudes must lie in [-90, 90]');
  if (north_deg <= south_deg) throw new Error(`bounds: north_deg (${north_deg}) must be greater than south_deg (${south_deg})`);
  let span = east_deg - west_deg;
  if (span <= 0) span += 360;
  if (!(span > 0 && span <= 360)) throw new Error('bounds: the longitude span must be in (0, 360] degrees');
  const west = ((((west_deg + 180) % 360) + 360) % 360) - 180;
  return { south_deg, north_deg, west_deg: west, east_deg: west + span };
}

function norm180(lon: number): number {
  const x = ((lon % 360) + 360) % 360;
  return x > 180 ? x - 360 : x;
}

function inside(b: MisfitBounds, p: LatLon): boolean {
  if (p.lat_deg < b.south_deg - 1e-9 || p.lat_deg > b.north_deg + 1e-9) return false;
  const span = b.east_deg - b.west_deg;
  if (span >= 360 - 1e-9) return true;
  const east = (((p.lon_deg - b.west_deg) % 360) + 360) % 360;
  return east <= span + 1e-9 || east >= 360 - 1e-9;
}

/** The mock fit's answer points: the fix, or the candidates within the 95 % margin. */
function answers(result: FixResult): LatLon[] {
  if (result.kind === 'unique') return [result.fix.position];
  if (result.kind === 'ambiguous') {
    return result.candidates.filter((c, k) => k === 0 || c.delta_chi2_from_best <= CHI2_95_2DOF).map((c) => c.position);
  }
  return [];
}

/** A box round `points`, `radiusNm` round each; every longitude when it reaches a pole. */
function box(points: LatLon[], radiusNm: number, pad: number): MisfitBounds {
  const r = radiusNm / 60;
  let south = 90;
  let north = -90;
  let full = false;
  const lons: number[] = [];
  let dlon = 0;
  for (const p of points) {
    south = Math.min(south, Math.max(-90, p.lat_deg - r));
    north = Math.max(north, Math.min(90, p.lat_deg + r));
    if (Math.abs(p.lat_deg) + r >= 89.999) full = true;
    else dlon = Math.max(dlon, R2D * Math.asin(Math.min(1, Math.sin(r * D2R) / Math.cos(p.lat_deg * D2R))));
    lons.push(norm180(p.lon_deg));
  }
  const latPad = pad * (north - south);
  south = Math.max(-90, south - latPad);
  north = Math.min(90, north + latPad);
  if (full) return { south_deg: south, north_deg: north, west_deg: -180, east_deg: 180 };
  // The shortest arc through every longitude: cut the circle at its widest gap.
  const sorted = [...lons].sort((a, b) => a - b);
  let west = sorted[0]!;
  let span = sorted[sorted.length - 1]! - sorted[0]!;
  for (let k = 1; k < sorted.length; k++) {
    const s = 360 - (sorted[k]! - sorted[k - 1]!);
    if (s < span) {
      span = s;
      west = sorted[k]!;
    }
  }
  const width = span + 2 * dlon;
  const padded = width * (1 + 2 * pad);
  if (padded >= 360) return { south_deg: south, north_deg: north, west_deg: -180, east_deg: 180 };
  const w = west - dlon - pad * width;
  return normalise({ south_deg: south, north_deg: north, west_deg: w, east_deg: w + padded });
}

function defaultFrame(p: Prepared): MisfitDefaultBounds {
  const sigmaNm = Math.max(...p.terms.map((t) => t.sigmaArcmin));
  const floor = Math.max(0.5, 3 * sigmaNm);
  const found = answers(p.result);
  if (p.result.kind === 'unique') {
    const f = p.result.fix;
    const major = f.ellipse95 ? (f.ellipse95.semi_major_m / 1852) * Math.sqrt(11.829 / CHI2_95_2DOF) : 0;
    const radius = Math.min(3000, 1.6 * Math.max(major, floor));
    return {
      bounds: box(found, radius, 0),
      centre: f.position,
      centred_on: 'fix',
      radius_nm: radius,
      reason: `MOCK: centred on the fix, ${radius.toFixed(2)} NM each way`,
      solve_kind: 'unique',
    };
  }
  if (found.length > 0) {
    const radius = 1.6 * floor;
    return {
      bounds: box(found, radius, found.length > 1 ? 0.15 : 0),
      centre: found[0]!,
      centred_on: 'candidates',
      radius_nm: radius,
      reason: `MOCK: every candidate, ${radius.toFixed(2)} NM round each`,
      solve_kind: p.result.kind,
    };
  }
  const init = p.options.initializer;
  if (init) {
    const radius = Math.max(floor, 30);
    return {
      bounds: box([init], radius, 0),
      centre: init,
      centred_on: 'initializer',
      radius_nm: radius,
      reason: `MOCK: no point fix, ${radius.toFixed(2)} NM round the initializer`,
      solve_kind: p.result.kind,
    };
  }
  const t = p.terms[0]!;
  const gp = { lat_deg: Math.asin(t.sdec) * R2D, lon_deg: norm180(-t.gha * R2D) };
  const radius = Math.min(10800, (90 - t.ho * R2D) * 60 + 4 * floor);
  return {
    bounds: box([gp], radius, 0),
    centre: gp,
    centred_on: 'circle',
    radius_nm: radius,
    reason: 'MOCK: no point fix and no initializer: the whole first circle',
    solve_kind: p.result.kind,
  };
}

function gridFor(p: Prepared, boundsIn: MisfitBounds | null, nLat: number, nLon: number): MisfitGrid {
  const bounds = normalise(boundsIn ?? defaultFrame(p).bounds);
  const bias = p.options.estimate_shared_bias;
  const span = bounds.east_deg - bounds.west_deg;
  const latStep = (bounds.north_deg - bounds.south_deg) / (nLat - 1);
  const lonStep = span / (nLon - 1);
  const lat = Array.from({ length: nLat }, (_, i) => (i === nLat - 1 ? bounds.north_deg : bounds.south_deg + i * latStep));
  const lon = Array.from({ length: nLon }, (_, j) => norm180(j === nLon - 1 ? bounds.east_deg : bounds.west_deg + j * lonStep));
  const scratch = new Float64Array(p.terms.length);
  const chi2 = new Float64Array(nLat * nLon);
  let low = 0;
  for (let i = 0; i < nLat; i++) {
    for (let j = 0; j < nLon; j++) {
      const v = valueAt(p.terms, bias, lat[i]! * D2R, lon[j]! * D2R, scratch);
      chi2[i * nLon + j] = v;
      if (v < chi2[low]!) low = i * nLon + j;
    }
  }
  const gi = Math.floor(low / nLon);
  const gj = low % nLon;
  const candidates: { at: LatLon; chi2: number }[] = [{ at: { lat_deg: lat[gi]!, lon_deg: lon[gj]! }, chi2: chi2[low]! }];
  for (const a of answers(p.result)) {
    candidates.push({ at: a, chi2: valueAt(p.terms, bias, a.lat_deg * D2R, a.lon_deg * D2R, scratch) });
  }
  candidates.sort((a, b) => a.chi2 - b.chi2);
  const best = candidates[0]!.chi2;
  const point = (c: { at: LatLon; chi2: number }): MisfitPoint => ({
    lat_deg: c.at.lat_deg,
    lon_deg: c.at.lon_deg,
    chi2: c.chi2,
    delta_chi2: c.chi2 - best,
    shared_bias_arcmin: bias ? biasAt(p.terms, c.at.lat_deg * D2R, c.at.lon_deg * D2R, scratch) : null,
    inside_grid: inside(bounds, c.at),
    well_determined: p.result.kind === 'unique' || p.result.kind === 'ambiguous',
    converged: false,
  });
  const basins: MisfitPoint[] = [];
  for (const c of candidates) {
    const far = basins.every((b) => Math.hypot(b.lat_deg - c.at.lat_deg, norm180(b.lon_deg - c.at.lon_deg)) > 10 / 60);
    if (far) basins.push(point(c));
  }
  const unknowns = bias ? 3 : 2;
  const deltas = bias ? DELTAS_THREE : DELTAS_TWO;
  const levels: MisfitLevel[] = NAMES.map((name, k) => ({
    name,
    label: LABELS[k]!,
    confidence: CONFIDENCE[k]!,
    delta_chi2: deltas[k]!,
    chi2: best + deltas[k]!,
  }));
  return {
    bounds,
    crosses_antimeridian: span < 360 && bounds.east_deg > 180,
    n_lat: nLat,
    n_lon: nLon,
    lat_step_deg: latStep,
    lon_step_deg: lonStep,
    lat_deg: lat,
    lon_deg: lon,
    chi2,
    min: basins[0]!,
    grid_min: { i: gi, j: gj, lat_deg: lat[gi]!, lon_deg: lon[gj]!, chi2: chi2[low]!, delta_chi2: chi2[low]! - best },
    basins: basins.slice(0, 8),
    unknowns,
    dof: p.terms.length - unknowns,
    levels,
    bias_profiled: bias,
    weighted: false,
    sights: p.terms.map((t) => ({ id: t.id, body: t.body, sigma_arcmin: t.sigmaArcmin, weight: 1 })),
    notes: [...p.notes],
    solve_kind: p.result.kind,
  };
}

/** The mock misfit grid, over the mock explorer engine's astronomy. */
export function createMockMisfit(engine: ExplorerEngine): MisfitEngine {
  return {
    misfitGrid(session: Session, _mode: EphemerisMode, options, bounds, nLat, nLon): MisfitGrid {
      checkAxis('n_lat', nLat);
      checkAxis('n_lon', nLon);
      if (bounds) normalise(bounds);
      return gridFor(prepare(engine, session, options), bounds, nLat, nLon);
    },
    misfitDefaultBounds(session: Session, _mode: EphemerisMode, options): MisfitDefaultBounds {
      return defaultFrame(prepare(engine, session, options));
    },
  };
}
