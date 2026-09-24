/**
 * Which design token colours what, for the charts. OWNER: charts agent.
 *
 * Every colour is a CSS custom property from the design system (`theme/tokens.css`), used
 * through classes in `charts.css` with a fallback for when the tokens are not loaded, so
 * the three themes switch with no script. Nothing here reads a colour value.
 */

import type { BodyKind, SkyPhase } from '../engine/types.js';

const BODY_CLASSES = new Set(['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']);

/** The class that sets `--c` to a body's colour token (`--body-venus`; every star `--body-star`). */
export function bodyClass(body: string, kind?: BodyKind): string {
  const name = body.toLowerCase();
  if (kind !== 'star' && BODY_CLASSES.has(name)) return `sfc-b-${name}`;
  return 'sfc-b-star';
}

/** The class that fills with a sky phase's token (`--phase-nautical`). */
export function phaseClass(phase: SkyPhase): string {
  return `sfc-ph-${phase}`;
}

export const PHASE_LABELS: Record<SkyPhase, string> = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
};

/** Night to day: the order the sky brightens in (CONVENTIONS 13.4). */
export const PHASES_DARK_TO_LIGHT: readonly SkyPhase[] = ['night', 'astronomical', 'nautical', 'civil', 'day'];
