/**
 * Data for "the Moon through the year" (charts2 agent, expansion programme Q5): the Moon's
 * height above the horizon and its bearing at one hour of the local clock, every day of the
 * year. OWNER: charts2 agent.
 *
 * `sample_bodies` for the Moon, one sample a day. Local days are grouped into runs whose
 * chosen hour falls exactly a day apart (a clock change starts a new run), so a year is two
 * or three calls instead of 365; every sample is an exact evaluation of the ephemeris (the
 * engine interpolates only for dense sampling), and a run takes the Earth's rotation
 * (DUT1) at its middle, so a sample differs from `sky_state` at the same instant by under
 * 1″ (0.7″ measured over 2026; test/next/charts-real-engine.test.ts). Heights are apparent
 * (what the eye sees).
 */

import type { ExplorerEngine, Observer } from '../engine/types.js';
import type { Zone } from '../time.js';
import { coverageRange } from './coverage.js';
import { daysOfYear, hasClockChange, jdAtWallHours, type LocalDay } from './windows.js';

export interface MoonYearInput {
  readonly observer: Observer;
  readonly zone: Zone;
  readonly year: number;
  /** The hour of the local clock, 0-23. */
  readonly hour: number;
}

export interface MoonYearDay {
  readonly day: LocalDay;
  /** Day of the year, 0 = 1 January. */
  readonly index: number;
  /** The instant: `hour` on the local clock that day. */
  readonly jd: number;
  readonly alt: number;
  readonly az: number;
}

export interface MoonYearData {
  readonly input: MoonYearInput;
  readonly days: readonly MoonYearDay[];
  /** Days the engine could not compute (outside its coverage). */
  readonly missing: number;
  readonly errors: readonly string[];
  readonly timing: { readonly engineMs: number; readonly calls: number };
}

/** The default hour: 21:00, an evening hour when the Moon is often looked for. */
export const MOON_YEAR_DEFAULT_HOUR = 21;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** `hour` on the local clock of each day (exact on the days the clocks change). */
export function instantsAt(days: readonly LocalDay[], hour: number, zone: Zone): number[] {
  return days.map((d) => (hasClockChange(d) ? jdAtWallHours(d.date, hour, zone) : d.jd_start + hour / 24));
}

/** Runs of consecutive instants exactly a day apart: `[first index, count]`. */
export function dailyRuns(instants: readonly number[]): [number, number][] {
  const runs: [number, number][] = [];
  let start = 0;
  for (let i = 1; i <= instants.length; i += 1) {
    const brk = i === instants.length || Math.abs(instants[i]! - instants[i - 1]! - 1) > 1e-7;
    if (brk) {
      if (i > start) runs.push([start, i - start]);
      start = i;
    }
  }
  return runs;
}

export function computeMoonYear(engine: ExplorerEngine, input: MoonYearInput): MoonYearData {
  const t0 = now();
  const days = daysOfYear(input.zone, input.year);
  const instants = instantsAt(days, input.hour, input.zone);
  const range = coverageRange(engine);
  const out: MoonYearDay[] = [];
  const errors: string[] = [];
  let calls = 0;
  let missing = 0;
  for (const [first, count] of dailyRuns(instants)) {
    // Only the part of the run inside the coverage (the engine leaves out a body it cannot compute).
    let a = first;
    let b = first + count - 1;
    while (a <= b && range && instants[a]! < range.start) a += 1;
    while (b >= a && range && instants[b]! > range.end) b -= 1;
    missing += count - (b >= a ? b - a + 1 : 0);
    if (b < a) continue;
    calls += 1;
    try {
      const res = engine.sampleBodies(input.observer, ['Moon'], instants[a]!, instants[b]! + 1e-6, 1440);
      const moon = res.bodies.find((x) => x.body === 'Moon');
      if (!moon) {
        errors.push(res.errors[0]?.message ?? 'The Moon could not be computed.');
        missing += b - a + 1;
        continue;
      }
      const got = Math.min(b - a + 1, moon.alt_apparent_deg.length);
      for (let k = 0; k < got; k += 1) {
        const i = a + k;
        out.push({ day: days[i]!, index: i, jd: instants[i]!, alt: moon.alt_apparent_deg[k]!, az: moon.az_deg[k]! });
      }
      missing += b - a + 1 - got;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      missing += b - a + 1;
    }
  }
  return { input, days: out, missing, errors, timing: { engineMs: now() - t0, calls } };
}
