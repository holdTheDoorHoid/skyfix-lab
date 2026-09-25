/**
 * Coverage tiers for the mock engine (EXPLORER_API "`explorer_coverage()` — tiers";
 * CONVENTIONS §15.1). OWNER: deeptime agent.
 *
 * The real core answers two tiers: `validated`, 1550-01-01 to 2650-01-22, and
 * `labelled`, 2000 BC to AD 3000 (display only). The mock's formulas answer only its own
 * window (1990–2060), which lies inside the validated tier, so the mock reports that
 * window as its validated tier, no labelled tier, and `outside` beyond it: the tier of an
 * instant never promises a position the mock would refuse. The core's bounds are exported
 * for the interface's own labels.
 */

import type { CoverageTier, CoverageTierSpan } from '../types.js';

/** The core's validated tier. */
export const VALIDATED_START_UTC = '1550-01-01T00:00:00Z';
export const VALIDATED_END_UTC = '2650-01-22T00:00:00Z';
/** The core's labelled tier (proleptic Gregorian, astronomical year numbering). */
export const LABELLED_START_UTC = '-2000-01-01T00:00:00Z';
export const LABELLED_END_UTC = '3000-12-31T23:59:59Z';

/** The mock's window, with the Julian dates of its ends. */
export interface MockWindow {
  startUtc: string;
  endUtc: string;
  startJd: number;
  endJd: number;
}

/** The tier of an instant for the mock: `validated` inside its window, else `outside`. */
export function mockTierAt(jdUtc: number, w: MockWindow): CoverageTier {
  return Number.isFinite(jdUtc) && jdUtc >= w.startJd && jdUtc <= w.endJd ? 'validated' : 'outside';
}

/** A group's tiers: the mock's window as its validated tier, with the group's accuracy. */
export function mockTiers(w: MockWindow, accuracyArcmin: number): CoverageTierSpan[] {
  return [{ tier: 'validated', start_utc: w.startUtc, end_utc: w.endUtc, accuracy_arcmin: accuracyArcmin }];
}
