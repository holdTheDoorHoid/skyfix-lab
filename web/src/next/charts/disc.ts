/**
 * The Moon's phase disc: geometry only. OWNER: charts agent.
 *
 * The lit part is bounded by the bright limb (a half circle) and the terminator (half an
 * ellipse whose half-width is `r · |1 − 2k|` for an illuminated fraction `k`). It is drawn
 * with the bright limb toward +x and then turned to where the engine says the bright limb
 * is (`bright_limb_angle_deg`, a position angle from celestial north through east).
 *
 * The calendar shows the Moon with celestial north up for observers north of the equator
 * (east on the left, as it looks in the sky facing south) and south up for observers
 * south of it, so a waxing Moon is lit on the right in Philadelphia and on the left in
 * Sydney, as people there see it.
 */

import { px } from './scale.js';

/**
 * SVG path of the lit part of a disc of radius `r` centred on the origin, bright limb
 * toward +x. `k` is the illuminated fraction, clamped to [0, 1]. Empty for `k` = 0.
 */
export function litPath(k: number, r: number): string {
  const f = Math.min(1, Math.max(0, Number.isFinite(k) ? k : 0));
  if (f <= 0 || r <= 0) return '';
  if (f >= 1) {
    return `M0 ${px(-r)}A${px(r)} ${px(r)} 0 1 1 0 ${px(r)}A${px(r)} ${px(r)} 0 1 1 0 ${px(-r)}Z`;
  }
  const rx = px(r * Math.abs(1 - 2 * f));
  // Bright limb: top to bottom through +x (clockwise on screen). Terminator: bottom back
  // to top, bulging toward +x for a crescent (sweep 0) and toward -x when gibbous (sweep 1).
  const sweep = f > 0.5 ? 1 : 0;
  return `M0 ${px(-r)}A${px(r)} ${px(r)} 0 0 1 0 ${px(r)}A${rx} ${px(r)} 0 0 ${sweep} 0 ${px(-r)}Z`;
}

/**
 * The screen rotation (degrees, clockwise, as SVG `rotate`) that turns +x toward the bright
 * limb. `southUp` for the southern-hemisphere view.
 */
export function limbRotation(brightLimbDeg: number, southUp: boolean): number {
  const chi = (brightLimbDeg * Math.PI) / 180;
  // North up, east left: position angle chi points at (-sin chi, -cos chi) on screen.
  const x = southUp ? Math.sin(chi) : -Math.sin(chi);
  const y = southUp ? Math.cos(chi) : -Math.cos(chi);
  const deg = (Math.atan2(y, x) * 180) / Math.PI;
  return Math.round(deg * 10) / 10 || 0;
}

/**
 * The rotation to use when the engine gives no bright-limb angle: a waxing Moon is lit on
 * the west side, which is on the right with north up.
 */
export function fallbackRotation(waxing: boolean, southUp: boolean): number {
  return waxing === southUp ? 180 : 0;
}
