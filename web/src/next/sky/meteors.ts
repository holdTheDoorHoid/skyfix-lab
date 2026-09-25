/**
 * Meteor-shower radiants in the Sky view. OWNER: sky2 agent (expansion Q3).
 *
 * Engine use (EXPLORER_API "deep sky"): `meteor_showers(year)` for each year the time
 * shown needs (its instants of start, peak and end; the table's radiant at the peak and
 * its drift), computed away from the frame and kept; `tonight(observer, jd)` for each
 * shower's expected rate that night (an estimate by the engine's stated rule), made when
 * the time settles. Nothing here models a rate.
 *
 * The radiant at an instant: the table stores it at the peak (J2000) with its drift per
 * degree of solar longitude λ☉. λ☉ between the engine's own start, peak and end instants
 * is interpolated linearly in time (the Sun's longitude runs within 3 % of uniformly over
 * a shower's few weeks: under 0.05° of λ☉, so under 0.1° of radiant), and the J2000
 * radiant is carried into the frame of date with the star field's frame matrix.
 */

import type { MeteorShower, ShowerDates, ShowerNight, ShowerYear } from '../engine/types.js';
import { DEG, unitFromRaDec } from './astro.js';

/**
 * Solar longitude at `jd` between a shower's start, peak and end, relative to the peak
 * (degrees): the parabola through the engine's three instants, whose solar longitudes the
 * table gives. (verify2: a straight line on each side of the peak left out the Sun's
 * changing speed, up to 0.15° over the Southern Taurids' 46 days before their peak; the
 * parabola is within 0.01° of the Sun over every shower of the table.)
 */
export function lambdaFromPeak(s: Pick<ShowerDates, 'start' | 'peak' | 'end'> & { shower: Pick<MeteorShower, 'lambda_start_deg' | 'lambda_peak_deg' | 'lambda_end_deg'> }, jd: number): number {
  const up = (a: number, b: number): number => ((((b - a) % 360) + 360) % 360);
  const { start, peak, end, shower } = s;
  const t0 = start.jd_utc - peak.jd_utc;
  const t2 = end.jd_utc - peak.jd_utc;
  const l0 = -up(shower.lambda_start_deg, shower.lambda_peak_deg);
  const l2 = up(shower.lambda_peak_deg, shower.lambda_end_deg);
  const t = jd - peak.jd_utc;
  if (!(t0 < 0 && t2 > 0)) {
    // A degenerate table row (no time on one side of the peak): straight lines, as before.
    if (t <= 0) return t0 < 0 ? l0 * (t / t0) : 0;
    return t2 > 0 ? l2 * (t / t2) : 0;
  }
  // Lagrange through (t0, l0), (0, 0), (t2, l2).
  return (l0 * t * (t - t2)) / (t0 * (t0 - t2)) + (l2 * t * (t - t0)) / (t2 * (t2 - t0));
}

/** The radiant (J2000 degrees) at `dLambda` degrees of solar longitude from the peak. */
export function radiantJ2000(shower: Pick<MeteorShower, 'ra_deg' | 'dec_deg' | 'dra_deg' | 'ddec_deg'>, dLambda: number): { ra: number; dec: number } {
  const ra = (((shower.ra_deg + shower.dra_deg * dLambda) % 360) + 360) % 360;
  const dec = Math.max(-90, Math.min(90, shower.dec_deg + shower.ddec_deg * dLambda));
  return { ra, dec };
}

/** A shower active at the instant shown, with its radiant in the frame of date. */
export interface ActiveShower {
  dates: ShowerDates;
  /** Degrees of solar longitude from the peak (negative before it). */
  dLambda: number;
  /** Days from the peak (negative before it). */
  daysFromPeak: number;
  ra2000: number;
  dec2000: number;
  /** Unit vector, equator and equinox of date. */
  unit: Float64Array;
}

/** Which showers of these years are active at `jd`, with their radiants of date. */
export function activeShowers(years: readonly (ShowerYear | null)[], jd: number, frame: ArrayLike<number>): ActiveShower[] {
  const out: ActiveShower[] = [];
  const seen = new Set<string>();
  const v = new Float64Array(3);
  for (const y of years) {
    if (!y) continue;
    for (const d of y.showers) {
      if (jd < d.start.jd_utc || jd > d.end.jd_utc) continue;
      const key = `${d.shower.code}|${d.peak.jd_utc.toFixed(3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const dLambda = lambdaFromPeak(d, jd);
      const { ra, dec } = radiantJ2000(d.shower, dLambda);
      unitFromRaDec(ra * DEG, dec * DEG, v);
      const unit = new Float64Array(3);
      for (let i = 0; i < 3; i += 1) unit[i] = frame[3 * i]! * v[0]! + frame[3 * i + 1]! * v[1]! + frame[3 * i + 2]! * v[2]!;
      out.push({ dates: d, dLambda, daysFromPeak: jd - d.peak.jd_utc, ra2000: ra, dec2000: dec, unit });
    }
  }
  // The strongest first (labels and the keyboard).
  return out.sort((a, b) => b.dates.shower.zhr - a.dates.shower.zhr);
}

/** The UTC calendar years whose shower lists can hold a shower active at `jd`. */
export function yearsFor(jd: number): number[] {
  const year = new Date((jd - 2_440_587.5) * 86_400_000).getUTCFullYear();
  // A shower's activity can reach about two months past its peak year's ends.
  const dayOfYear = jd - jdOfYearStart(year);
  const out = [year];
  if (dayOfYear < 75) out.push(year - 1);
  if (dayOfYear > 290) out.push(year + 1);
  return out;
}

function jdOfYearStart(year: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, 0, 1);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime() / 86_400_000 + 2_440_587.5;
}

/** The night's estimate for a shower (the engine's `tonight`), matched by code. */
export function tonightFor(nights: readonly ShowerNight[] | null | undefined, code: string): ShowerNight | null {
  return nights?.find((n) => n.code === code) ?? null;
}

/** Short text for the rate beside a radiant: "about 40 an hour at best", "a few an hour". */
export function rateWords(rate: number): string {
  if (!Number.isFinite(rate) || rate < 0.5) return 'hardly any';
  if (rate < 3) return 'a few an hour';
  const r = rate < 20 ? Math.round(rate) : Math.round(rate / 5) * 5;
  return `about ${r} an hour`;
}
