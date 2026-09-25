/**
 * How the Sky view carries out a target from the Tonight view's channel (sky-link.ts).
 * OWNER: sky2 agent (expansion Q3). Pure: no DOM, no engine, so it is tested directly.
 *
 * - a body: selected and centred, its card open; `inset` also opens its "Up close" panel
 *   (the Moon and the planets that have one);
 * - a deep-sky object: pinned by its catalogue id, or, should the Sky view's catalogue not
 *   have it, marked at the J2000 place the target carries;
 * - a meteor shower's radiant: pinned by its IAU code (the Sky view's radiant for the time
 *   shown), or marked at the target's place if the shower is not active then;
 * - a direction (the Milky Way's core): an apparent altitude and azimuth at the target's
 *   moment, turned into a J2000 place (`j2000OfApparent`) once the sky has reached that
 *   moment, and marked there like the Selected card's galactic centre.
 */

import { refractionArcmin } from './astro.js';
import type { SkyTarget as ShowTarget } from './requests.js';
import type { TimedSkyTarget } from './sky-link.js';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export interface TargetPlan {
  /** What to show first, or null for a direction (placed on the sky when the view has the moment). */
  show: ShowTarget | null;
  /** Shown instead when the Sky view does not know `show` (a J2000 place the target carried). */
  fallback: ShowTarget | null;
  /** A direction at the target's moment: apparent altitude and azimuth, degrees. */
  direction: { label: string; alt_deg: number; az_deg: number } | null;
  /** Also open this body's close-up. */
  upClose: string | null;
}

function place(label: string, ra: number | null | undefined, dec: number | null | undefined): ShowTarget | null {
  if (typeof ra !== 'number' || typeof dec !== 'number' || !Number.isFinite(ra) || !Number.isFinite(dec) || Math.abs(dec) > 90) return null;
  return { kind: 'point', id: label, ra_j2000_deg: ra, dec_j2000_deg: dec };
}

/** The Sky view's plan for a target from the Tonight view; `canCloseUp` says which bodies have an inset. */
export function planOfTarget(target: TimedSkyTarget, canCloseUp: (body: string) => boolean): TargetPlan {
  switch (target.kind) {
    case 'body':
      return { show: { kind: 'body', id: target.name }, fallback: null, direction: null, upClose: target.inset && canCloseUp(target.name) ? target.name : null };
    case 'deep_sky':
      return { show: { kind: 'deep_sky', id: target.id }, fallback: place(target.label, target.ra_j2000_deg, target.dec_j2000_deg), direction: null, upClose: null };
    case 'radiant':
      return { show: { kind: 'shower', id: target.code }, fallback: place(`Radiant of the ${target.label}`, target.ra_j2000_deg, target.dec_j2000_deg), direction: null, upClose: null };
    case 'direction':
      return Number.isFinite(target.alt_deg) && Number.isFinite(target.az_deg)
        ? { show: null, fallback: null, direction: { label: target.label, alt_deg: target.alt_deg, az_deg: target.az_deg }, upClose: null }
        : { show: null, fallback: null, direction: null, upClose: null };
    default:
      return { show: null, fallback: null, direction: null, upClose: null };
  }
}

/**
 * The J2000 (ICRS) place of an apparent altitude and azimuth (degrees), the inverse of how
 * the Sky view places a J2000 direction: `frame` carries ICRS to the frame of date and `hm`
 * the frame of date to the horizon, (E, N, U) = hm · frame · v (both row-major rotations),
 * and the altitude is then raised by `refractionArcmin` at `refraction` (astro.ts). The
 * refraction is undone by iteration (it changes slowly with altitude: under 0.2 per degree).
 */
export function j2000OfApparent(
  altDeg: number,
  azDeg: number,
  hm: ArrayLike<number>,
  frame: ArrayLike<number>,
  refraction: number,
): { ra_deg: number; dec_deg: number } {
  let h = altDeg;
  for (let i = 0; i < 30; i += 1) {
    const next = altDeg - refractionArcmin(h, refraction) / 60;
    const done = Math.abs(next - h) < 1e-12;
    h = next;
    if (done) break;
  }
  const a = h * DEG;
  const z = azDeg * DEG;
  const e = Math.cos(a) * Math.sin(z);
  const n = Math.cos(a) * Math.cos(z);
  const u = Math.sin(a);
  // The frame of date: hmᵀ (E, N, U); then ICRS: frameᵀ of that.
  const d0 = hm[0]! * e + hm[3]! * n + hm[6]! * u;
  const d1 = hm[1]! * e + hm[4]! * n + hm[7]! * u;
  const d2 = hm[2]! * e + hm[5]! * n + hm[8]! * u;
  const x = frame[0]! * d0 + frame[3]! * d1 + frame[6]! * d2;
  const y = frame[1]! * d0 + frame[4]! * d1 + frame[7]! * d2;
  const w = frame[2]! * d0 + frame[5]! * d1 + frame[8]! * d2;
  const ra = Math.atan2(y, x) * RAD;
  return { ra_deg: ra < 0 ? ra + 360 : ra, dec_deg: Math.asin(Math.max(-1, Math.min(1, w))) * RAD };
}
