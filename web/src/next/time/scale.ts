/**
 * The app's clock scale and local mean time (CONVENTIONS 15.2-15.3). OWNER: time-ui agent.
 *
 * The clock is **UTC from 1972-01-01 to 2035-12-31** and **UT** (Universal Time, UT1)
 * outside that span, as `skyfix_core::time::scale_at` and `time_info.scale` say; the words
 * on screen follow it ("UTC" or "UT"). Pure functions of the instant, so a label never needs
 * an engine call; `web/test/next/time-scale.test.ts` holds them to the engine's `time_info`.
 *
 * Before 1850 the default display zone is **local mean time** at the observer's longitude
 * ("LMT"): civil time zones did not exist (time.ts `resolveZone`).
 */

/** First instant of the UTC scale, 1972-01-01T00:00. */
export const UTC_SCALE_START_JD = 2_441_317.5;
/** First instant after it, 2036-01-01T00:00. */
export const UTC_SCALE_END_JD = 2_464_693.5;
/** 1850-01-01T00:00: before it a zone that follows the place is local mean time. */
export const LMT_BEFORE_JD = 2_396_758.5;
/** 1970-01-01T00:00: civil offsets before it come from the tz database's history and may be approximate. */
export const TZ_HISTORY_BEFORE_JD = 2_440_587.5;

export type ClockScale = 'utc' | 'ut';

/** The app's clock scale at an instant (`time::scale_at`). */
export function scaleAt(jd: number): ClockScale {
  return jd >= UTC_SCALE_START_JD && jd < UTC_SCALE_END_JD ? 'utc' : 'ut';
}

/** `UTC` inside 1972-2035, `UT` outside: the word written after a clock time. */
export function scaleLabel(jd: number): 'UTC' | 'UT' {
  return scaleAt(jd) === 'utc' ? 'UTC' : 'UT';
}

/** Why the clock is UT, in one or two sentences; '' on the UTC scale. */
export function scaleReason(jd: number): string {
  if (scaleAt(jd) === 'utc') return '';
  return jd < UTC_SCALE_START_JD
    ? 'UT is Universal Time, the time scale of the almanacs, kept by the Earth’s rotation. UTC with leap seconds began only in 1972, so earlier times are given in UT.'
    : 'UT is Universal Time, the time scale of the almanacs, kept by the Earth’s rotation. Leap seconds are to end by 2035, after which UTC drifts away from the Earth’s rotation, so later times are given in UT.';
}

/** Longitude east-positive, degrees, to an offset from UT in milliseconds, to the whole second. */
export function lmtOffsetMs(lonDeg: number): number {
  let lon = ((lonDeg % 360) + 360) % 360;
  if (lon > 180) lon -= 360;
  const ms = Math.round(lon * 240) * 1000;
  return ms === 0 ? 0 : ms; // no -0
}

/** True when a zone that follows the place is local mean time at this instant. */
export function lmtByDefault(jd: number): boolean {
  return jd < LMT_BEFORE_JD;
}
