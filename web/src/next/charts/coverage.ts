/**
 * The engine's time coverage (`explorer_coverage`), for keeping every chart request inside
 * it. OWNER: charts agent; the tiers and the words: time-ui agent (time/tier.ts has
 * `tierAt` and the notices for the validated and labelled tiers).
 *
 * The engine refuses a whole `day_events_batch` when one window reaches outside its
 * coverage (the Sun defines each window's phases), so the charts send only the windows it
 * covers and mark the rest, and say in plain words why a date cannot be drawn.
 */

import type { ExplorerEngine } from '../engine/types.js';
import { jdFromIso } from '../time.js';
import { wireDateText } from '../time/tier.js';

export interface CoverageRange {
  readonly start: number;
  readonly end: number;
  readonly startUtc: string;
  readonly endUtc: string;
}

/**
 * Ranges worked out, by the coverage report they came from: the memoised engine returns the
 * same report until a data pack widens it (a new report is then worked out again).
 */
const cache = new WeakMap<object, CoverageRange | null>();

/** The engine's coverage as Julian dates, or null when it does not say. */
export function coverageRange(engine: ExplorerEngine): CoverageRange | null {
  let c: ReturnType<ExplorerEngine['coverage']>;
  try {
    c = engine.coverage();
  } catch {
    return null;
  }
  if (!c || typeof c !== 'object') return null;
  if (cache.has(c)) return cache.get(c) ?? null;
  let range: CoverageRange | null = null;
  const start = jdFromIso(c.start_utc);
  const end = jdFromIso(c.end_utc);
  if (start !== null && end !== null && end > start) range = { start, end, startUtc: c.start_utc, endUtc: c.end_utc };
  cache.set(c, range);
  return range;
}

/** Whether `[jdStart, jdEnd]` lies inside the engine's coverage (true when it does not say). */
export function covers(engine: ExplorerEngine, jdStart: number, jdEnd: number): boolean {
  const range = coverageRange(engine);
  return !range || (jdStart >= range.start && jdEnd <= range.end);
}

/**
 * A plain-words sentence for a request outside the coverage, naming its bounds as dates:
 * "… 1 January 1990 to 31 December 2060." (a bound before 1582 is a proleptic Gregorian
 * date, as the engine states it, and says so).
 */
export function outsideCoverage(engine: ExplorerEngine): string {
  const range = coverageRange(engine);
  if (!range) return 'This date is outside the time the engine can compute.';
  const gregorian = range.start < 2_299_160.5 ? ' (Gregorian calendar)' : '';
  return `This date is outside the time the engine can compute: ${wireDateText(range.startUtc)} to ${wireDateText(range.endUtc)}${gregorian}.`;
}

/** Thrown for a request wholly outside the coverage; the charts show its message as it is. */
export class OutsideCoverageError extends Error {
  constructor(engine: ExplorerEngine) {
    super(outsideCoverage(engine));
    this.name = 'OutsideCoverageError';
  }
}
