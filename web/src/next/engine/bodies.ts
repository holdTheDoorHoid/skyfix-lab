/**
 * Small helpers over the engine contract that every view needs: which coverage group
 * a body belongs to, and whether it may be offered for sights (EXPLORER_PLAN 3.3:
 * "validated or labelled").
 */

import type { BodyInfo, BodyKind, CoverageGroup, ExplorerCoverage } from './types.js';

/** The Sun, the Moon and the planets, in the contract's order. */
export const SOLAR_SYSTEM: readonly string[] = [
  'Sun',
  'Moon',
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
];

/** The planets a navigator may use (CONVENTIONS 13.1). */
export const NAVIGATIONAL_PLANETS: readonly string[] = ['Venus', 'Mars', 'Jupiter', 'Saturn'];

const KIND_PATTERN: Record<BodyKind, RegExp> = {
  sun: /\bsun\b/i,
  moon: /\bmoon\b/i,
  planet: /planet/i,
  star: /star/i,
};

/**
 * The coverage group responsible for a body: the group that lists it in `bodies`, or,
 * when groups do not list their bodies, the group whose name matches the body's kind.
 */
export function coverageGroupFor(info: BodyInfo, coverage: ExplorerCoverage): CoverageGroup | null {
  const listed = coverage.groups.find((g) => g.bodies?.includes(info.body));
  if (listed) return listed;
  if (coverage.groups.some((g) => g.bodies !== undefined && g.bodies.length > 0)) {
    // Groups do list their bodies and none lists this one: do not guess.
    return null;
  }
  return coverage.groups.find((g) => KIND_PATTERN[info.kind].test(g.name)) ?? null;
}

/**
 * True when the interface may offer this body for sights: a navigational body whose
 * provider is validated against the reference. Anything else is shown, and labelled.
 */
export function offeredForSights(info: BodyInfo, coverage: ExplorerCoverage): boolean {
  return info.navigational && coverageGroupFor(info, coverage)?.validated === true;
}
