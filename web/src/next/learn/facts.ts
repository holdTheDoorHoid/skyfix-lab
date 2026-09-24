/**
 * The numbers a run is judged by, taken from the solver's result and compared with the
 * answer key; and how they are written. OWNER: learn agent.
 *
 * Nothing here is invented or re-derived from the sights: positions, sigmas, ellipses,
 * residuals and circles are the core's. What this adds is the comparison with the truth
 * (distance, direction, whether it falls inside the nominal 95 % ellipse, error / sigma)
 * made exactly the way the experiment runner makes it for each repetition.
 */

import type { AngleFormat, Units } from '../state.js';
import { formatLatLon, formatLatitude, formatLongitude, type CoordStyle } from '../geo/coords.js';
import { NM_M, type CircleOfPosition, type ErrorEllipse, type FixResult, type LatLon, type Residual, type Warning } from '../../types.js';
import { MAHALANOBIS_95, circleRadius, distanceM, mahalanobis, offCircleM, tangentOffsetM } from './geo.js';

// ---------------------------------------------------------------------------------------
// Facts

export interface UniqueFacts {
  kind: 'unique';
  truth: LatLon;
  fix: LatLon;
  /** Great-circle distance from the truth to the fix, metres. */
  errorM: number;
  /** The fix relative to the truth in the tangent plane at the truth, metres. */
  errorNorthM: number;
  errorEastM: number;
  /** Fix minus truth, degrees (longitude wrapped). */
  dLatDeg: number;
  dLonDeg: number;
  sigmaNorthM: number;
  sigmaEastM: number;
  /** sqrt(sigma_north^2 + sigma_east^2): the run's predicted radial sigma (docs/SIMULATOR.md 6). */
  sigmaRadialM: number;
  clockSigmaEastM: number;
  /** The 95 % ellipse, or null when the core suppressed it (then never drawn). */
  ellipse: ErrorEllipse | null;
  ellipseSuppressedReason: string | null;
  /** Truth inside the nominal 95 % ellipse; null when there is no ellipse to test against. */
  inside95: boolean | null;
  mahalanobis: number | null;
  /** errorM / sigmaRadialM. */
  ratio: number | null;
  residuals: readonly Residual[];
  /** The residual with the largest |normalised| value. */
  worst: Residual | null;
  /** Largest |residual| in arcminutes. */
  maxResidualArcmin: number;
  residualRmsArcmin: number | null;
  conditionNumber: number | null;
  maxAzimuthGapDeg: number;
  sharedBiasArcmin: number | null;
  downweighted: readonly string[];
  /** Final weight of each downweighted sight. */
  weights: Readonly<Record<string, number>>;
  converged: boolean;
  chi2: number;
  dof: number;
  circles: readonly CircleOfPosition[];
  warnings: readonly Warning[];
}

export interface AmbiguousFacts {
  kind: 'ambiguous';
  truth: LatLon;
  candidates: readonly LatLon[];
  /** Distance between the first two candidates, metres. */
  separationM: number;
  /** The candidate nearest the answer key, and how near. */
  nearestIndex: number;
  nearestM: number;
  circles: readonly CircleOfPosition[];
  warnings: readonly Warning[];
}

export interface UnderdeterminedFacts {
  kind: 'underdetermined';
  truth: LatLon;
  reason: string;
  circles: readonly CircleOfPosition[];
  /** Radius of the first circle. */
  radiusNm: number;
  radiusM: number;
  /** How far the answer key is from the first circle, metres (0 = on it). */
  truthOffCircleM: number;
  warnings: readonly Warning[];
}

export interface FailedFacts {
  kind: 'failed';
  truth: LatLon;
  reason: string;
  warnings: readonly Warning[];
}

export type Facts = UniqueFacts | AmbiguousFacts | UnderdeterminedFacts | FailedFacts;

function wrap180(deg: number): number {
  const x = (((deg % 360) + 360) % 360);
  return x > 180 ? x - 360 : x;
}

/** Compare a result with its answer key. */
export function factsOf(result: FixResult, truth: LatLon): Facts {
  switch (result.kind) {
    case 'unique': {
      const f = result.fix;
      const errorM = distanceM(truth, f.position);
      const offset = tangentOffsetM(truth, f.position);
      const sigmaRadialM = Math.hypot(f.sigma_north_m, f.sigma_east_m);
      const d = mahalanobis(f.covariance_ne_m2, offset.north, offset.east);
      // Inside/outside is a statement about the ELLIPSE, so there is none without one.
      const inside95 = f.ellipse95 && d !== null ? d <= MAHALANOBIS_95 : null;
      let worst: Residual | null = null;
      let maxResidualArcmin = 0;
      let sum2 = 0;
      for (const r of f.residuals) {
        if (!worst || Math.abs(r.normalized) > Math.abs(worst.normalized)) worst = r;
        maxResidualArcmin = Math.max(maxResidualArcmin, Math.abs(r.residual_arcmin));
        sum2 += r.residual_arcmin ** 2;
      }
      const weights: Record<string, number> = {};
      for (const r of f.residuals) if (r.weight < 1) weights[r.id] = r.weight;
      return {
        kind: 'unique',
        truth,
        fix: f.position,
        errorM,
        errorNorthM: offset.north,
        errorEastM: offset.east,
        dLatDeg: f.position.lat_deg - truth.lat_deg,
        dLonDeg: wrap180(f.position.lon_deg - truth.lon_deg),
        sigmaNorthM: f.sigma_north_m,
        sigmaEastM: f.sigma_east_m,
        sigmaRadialM,
        clockSigmaEastM: f.clock_sigma_east_m,
        ellipse: f.ellipse95,
        ellipseSuppressedReason: f.ellipse95 ? null : f.ellipse_suppressed_reason,
        inside95,
        mahalanobis: d,
        ratio: sigmaRadialM > 0 ? errorM / sigmaRadialM : null,
        residuals: f.residuals,
        worst,
        maxResidualArcmin,
        residualRmsArcmin: f.residuals.length ? Math.sqrt(sum2 / f.residuals.length) : null,
        conditionNumber: f.conditioning.condition_number,
        maxAzimuthGapDeg: f.conditioning.max_azimuth_gap_deg,
        sharedBiasArcmin: f.shared_bias_arcmin,
        downweighted: f.robust?.downweighted_ids ?? [],
        weights,
        converged: f.converged,
        chi2: f.chi2,
        dof: f.dof,
        circles: result.circles,
        warnings: result.warnings,
      };
    }
    case 'ambiguous': {
      const candidates = result.candidates.map((c) => c.position);
      let nearestIndex = 0;
      let nearestM = Infinity;
      candidates.forEach((c, i) => {
        const d = distanceM(c, truth);
        if (d < nearestM) {
          nearestM = d;
          nearestIndex = i;
        }
      });
      return {
        kind: 'ambiguous',
        truth,
        candidates,
        separationM: candidates.length >= 2 ? distanceM(candidates[0]!, candidates[1]!) : 0,
        nearestIndex,
        nearestM,
        circles: result.circles,
        warnings: result.warnings,
      };
    }
    case 'underdetermined': {
      const first = result.circles[0];
      const radius = first ? circleRadius(first.zenith_distance_deg) : { m: NaN, nm: NaN };
      return {
        kind: 'underdetermined',
        truth,
        reason: result.reason,
        circles: result.circles,
        radiusNm: radius.nm,
        radiusM: radius.m,
        truthOffCircleM: first ? Math.abs(offCircleM(first.gp, first.zenith_distance_deg, truth)) : NaN,
        warnings: result.warnings,
      };
    }
    case 'failed':
      return { kind: 'failed', truth, reason: result.reason, warnings: result.warnings };
  }
}

/** Candidate letters: A, B, C… in the order the core returns them (no preference). */
export function candidateLetter(index: number): string {
  return String.fromCharCode(65 + index);
}

// ---------------------------------------------------------------------------------------
// Writing numbers

/** How distances and positions are written, from the explorer's settings. */
export interface Fmt {
  /** A distance in the primary unit: "796 m", "7.07 km", "3.82 NM". */
  dist(m: number): string;
  /** Primary and secondary: "7.07 km (3.82 NM)". */
  distBoth(m: number): string;
  /** A position in the chosen angle style. */
  pos(p: LatLon): string;
  lat(lat: number): string;
  lon(lon: number): string;
  readonly units: Units;
}

const nf = (digits: number) =>
  new Intl.NumberFormat('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: true });

/** Metres and kilometres: "796 m", "6.57 km", "21.35 km", "8,916 km". */
export function metric(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const a = Math.abs(m);
  if (a < 1000) return `${nf(0).format(m)} m`;
  if (a < 100_000) return `${nf(2).format(m / 1000)} km`;
  return `${nf(0).format(m / 1000)} km`;
}

/** Nautical miles: "0.43 NM", "11.53 NM", "4,815 NM". */
export function nautical(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const nm = m / NM_M;
  const a = Math.abs(nm);
  if (a < 100) return `${nf(2).format(nm)} NM`;
  return `${nf(0).format(nm)} NM`;
}

/** Statute miles: "0.49 mi", "4,431 mi". */
export function statute(m: number): string {
  if (!Number.isFinite(m)) return '—';
  const mi = m / 1609.344;
  const a = Math.abs(mi);
  if (a < 100) return `${nf(2).format(mi)} mi`;
  return `${nf(0).format(mi)} mi`;
}

const ANGLE_STYLE: Record<AngleFormat, CoordStyle> = { dm: 'nav', dms: 'dms', decimal: 'decimal' };

export function makeFmt(units: Units = 'metric', angles: AngleFormat = 'dm'): Fmt {
  const style = ANGLE_STYLE[angles];
  const primary = units === 'nautical' ? nautical : units === 'imperial' ? statute : metric;
  const secondary = units === 'metric' ? nautical : metric;
  return {
    units,
    dist: primary,
    distBoth: (m) => `${primary(m)} (${secondary(m)})`,
    pos: (p) => formatLatLon(p, style),
    lat: (v) => formatLatitude(v, style),
    lon: (v) => formatLongitude(v, style),
  };
}

/** Arcminutes with a sign: "+4.97′", "−1.75′", "0.00′". */
export function arcmin(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return '—';
  const r = Number(v.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)}′`;
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}′`;
}

/** Degrees with a sign: "−0.2507°". */
export function signedDeg(v: number, digits = 4): string {
  const r = Number(v.toFixed(digits));
  if (r === 0) return `${(0).toFixed(digits)}°`;
  return `${r > 0 ? '+' : '−'}${Math.abs(r).toFixed(digits)}°`;
}

/** "9.9" for a normalised residual or a ratio; big ones without decimals. */
export function times(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  return a >= 100 ? nf(0).format(v) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
}

/** Ellipse size "2.37 × 2.23 km" or "436 × 360 m", in the primary unit. */
export function ellipseSize(e: ErrorEllipse, fmt: Fmt): string {
  const major = fmt.dist(e.semi_major_m);
  const minor = fmt.dist(e.semi_minor_m);
  const [mv, mu] = splitUnit(major);
  const [nv, nu] = splitUnit(minor);
  return mu === nu ? `${mv} × ${nv} ${mu}` : `${major} × ${minor}`;
}

function splitUnit(text: string): [string, string] {
  const i = text.lastIndexOf(' ');
  return i < 0 ? [text, ''] : [text.slice(0, i), text.slice(i + 1)];
}

/** Compass words for a bearing: "west", "east-south-east"… (16 points). */
export function compassWords(bearing: number): string {
  const names = [
    'north', 'north-north-east', 'north-east', 'east-north-east', 'east', 'east-south-east', 'south-east', 'south-south-east',
    'south', 'south-south-west', 'south-west', 'west-south-west', 'west', 'west-north-west', 'north-west', 'north-north-west',
  ];
  const i = Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16;
  return names[i]!;
}

/** Bearing of the fix from the truth, degrees, from the tangent-plane components. */
export function errorBearing(f: UniqueFacts): number {
  return ((Math.atan2(f.errorEastM, f.errorNorthM) * 180) / Math.PI + 360) % 360;
}

/** A condition number or its absence (singular geometry arrives as null). */
export function conditionText(c: number | null): string {
  return c === null || !Number.isFinite(c) ? 'singular' : c.toFixed(2);
}
