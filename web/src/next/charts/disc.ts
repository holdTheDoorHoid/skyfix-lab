/**
 * Which way the Moon's bright limb points on the page. OWNER: charts agent.
 *
 * The disc itself is the design system's `phaseDisc` (theme/glyphs.ts), which takes the
 * bright limb's direction as degrees counter-clockwise from "up". The engine gives the
 * bright limb as a position angle from celestial north through east
 * (`bright_limb_angle_deg`, EXPLORER_API).
 *
 * The charts draw the Moon with celestial north up for observers north of the equator
 * (east on the left, as it looks in the sky facing south) and south up for observers south
 * of it, so a waxing Moon is lit on the right in Philadelphia and on the left in Sydney, as
 * people there see it. With north up and east on the left, a position angle already runs
 * counter-clockwise from up; turning the picture over adds 180°.
 */

function norm360(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** `limbFromUpDeg` for `phaseDisc`, from the engine's bright-limb position angle. */
export function limbFromUp(brightLimbDeg: number, southUp: boolean): number {
  return norm360(southUp ? brightLimbDeg + 180 : brightLimbDeg);
}

/**
 * The same when the engine gives no bright-limb angle: a waxing Moon is lit on its west
 * side (position angle 270°), a waning one on its east side (90°).
 */
export function fallbackLimbFromUp(waxing: boolean, southUp: boolean): number {
  return limbFromUp(waxing ? 270 : 90, southUp);
}
