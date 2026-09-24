/**
 * The engine's time coverage (`explorer_coverage`), for keeping every chart request inside
 * it. OWNER: charts agent.
 *
 * The engine refuses a whole `day_events_batch` when one window reaches outside its
 * coverage (the Sun defines each window's phases), so the charts send only the windows it
 * covers and mark the rest, and say in plain words why a date cannot be drawn.
 */

import type { ExplorerEngine } from '../engine/types.js';
import { jdFromIso } from '../time.js';

export interface CoverageRange {
  readonly start: number;
  readonly end: number;
  readonly startUtc: string;
  readonly endUtc: string;
}

const cache = new WeakMap<ExplorerEngine, CoverageRange | null>();

/** The engine's coverage as Julian dates, or null when it does not say. */
export function coverageRange(engine: ExplorerEngine): CoverageRange | null {
  if (cache.has(engine)) return cache.get(engine) ?? null;
  let range: CoverageRange | null = null;
  try {
    const c = engine.coverage();
    const start = jdFromIso(c.start_utc);
    const end = jdFromIso(c.end_utc);
    if (start !== null && end !== null && end > start) range = { start, end, startUtc: c.start_utc, endUtc: c.end_utc };
  } catch {
    range = null;
  }
  cache.set(engine, range);
  return range;
}

/** Whether `[jdStart, jdEnd]` lies inside the engine's coverage (true when it does not say). */
export function covers(engine: ExplorerEngine, jdStart: number, jdEnd: number): boolean {
  const range = coverageRange(engine);
  return !range || (jdStart >= range.start && jdEnd <= range.end);
}

/** A plain-words sentence for a request outside the coverage. */
export function outsideCoverage(engine: ExplorerEngine): string {
  const range = coverageRange(engine);
  if (!range) return 'This date is outside the time the engine can compute.';
  return `This date is outside the time the engine can compute: ${range.startUtc.slice(0, 10)} to ${range.endUtc.slice(0, 10)} (UTC).`;
}

/** Thrown for a request wholly outside the coverage; the charts show its message as it is. */
export class OutsideCoverageError extends Error {
  constructor(engine: ExplorerEngine) {
    super(outsideCoverage(engine));
    this.name = 'OutsideCoverageError';
  }
}
