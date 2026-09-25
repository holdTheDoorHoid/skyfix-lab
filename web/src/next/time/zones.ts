/**
 * Words about the zone a clock shows (CONVENTIONS 13.8, 15.3). OWNER: time-ui agent.
 *
 * - Before 1850 a zone that follows the place is **local mean time** at the observer's
 *   longitude ("LMT"): the Sun's mean time there, which clocks kept before time zones.
 * - IANA zones before 1970 come from the tz database's history, which is approximate for
 *   many places (zones merged in tzdata can be off by up to an hour, and before standard
 *   time a zone's offset is its city's local mean time, not the observer's).
 */

import { formatOffset, isLmtZone, isUtcZone, zoneLabel, type Zone } from '../time.js';
import { LMT_BEFORE_JD, scaleLabel, scaleReason, TZ_HISTORY_BEFORE_JD } from './scale.js';

/** `75° 09.9′ W`: a longitude for a sentence, degrees and minutes. */
export function longitudeWords(lonDeg: number): string {
  let lon = ((lonDeg % 360) + 360) % 360;
  if (lon > 180) lon -= 360;
  const abs = Math.abs(lon);
  let deg = Math.floor(abs);
  let min = Math.round((abs - deg) * 600) / 10;
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  const hemi = lon < 0 ? 'W' : lon > 0 ? 'E' : '';
  return `${deg}° ${min.toFixed(1).padStart(4, '0')}′${hemi ? ` ${hemi}` : ''}`;
}

/**
 * Why the clock is local mean time, in one sentence (the time bar's and the place panel's
 * reason line): "Local mean time at 75° 09.9′ W (UT−5:00:40): before about 1850 clocks were
 * set by the Sun at each place, so this is what a local clock showed."
 */
export function lmtReason(jd: number, lonDeg: number, offsetMs: number): string {
  return `Local mean time at ${longitudeWords(lonDeg)} (${formatOffset(offsetMs, jd)}): before about 1850 clocks were set by the Sun at each place, not by time zones, so this is what a local clock showed. A zone you pin in Place → Edit is used instead.`;
}

/**
 * The tooltip for the zone beside a clock: its full name and offset, why it is local mean
 * time, the tz database's caution before 1970, and why the clock is UT outside 1972-2035.
 */
export function zoneTooltip(jd: number, zone: Zone, lonDeg: number): string {
  const parts = [zoneLabel(jd, zone)];
  if (zone.kind === 'fixed' && isLmtZone(zone)) parts.push(lmtReason(jd, lonDeg, zone.offsetMs));
  else if (zone.kind === 'iana' && jd < TZ_HISTORY_BEFORE_JD) {
    parts.push(`Civil offsets before 1970 may be approximate (tz database)${jd < LMT_BEFORE_JD ? '; before standard time this zone keeps its own city’s local mean time' : ''}.`);
  }
  if (isUtcZone(zone) || scaleLabel(jd) === 'UT') {
    const why = scaleReason(jd);
    if (why) parts.push(why);
  }
  return parts.join(' ');
}
