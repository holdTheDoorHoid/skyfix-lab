/**
 * The selected body's pass as the compass dial draws it: which stretch of time to sample for
 * its path, and the words and times beside the rise and set rays. OWNER: map agent (moved
 * here from map-view.ts by the polish pass so it can be tested). Pure: no DOM, no engine.
 *
 * The pass is the one the panel's Selected cards show (`passNow`, shell/derived.ts): from
 * rising through the highest point to setting, around the time shown — or the next one
 * while the body is down. So the dial and the panel never give two different moonsets.
 */

import type { Passage } from '../shell/sky.js';
import { otherDay } from '../shell/format.js';
import { formatTime, wallClock, type Zone } from '../time.js';
import type { DialEvent } from './compass.js';

/** Minutes between path samples; the sampling starts on a whole hour, so every twelfth is one. */
export const PATH_STEP_MIN = 5;

/** The words for a body's rise and set: "Sunrise", "Moonset", "Venus rises". */
export function eventWords(body: string, kind: 'rise' | 'set' | 'transit'): string {
  if (kind === 'transit') return 'Highest';
  if (body === 'Sun' || body === 'Moon') return `${body}${kind}`;
  return kind === 'rise' ? `${body} rises` : `${body} sets`;
}

/**
 * The window to sample for the path: the pass from its rise to one step past its set (so
 * the path meets the horizon), starting on a whole hour of the display clock. A pass whose
 * rise or set is outside the events given runs to the edge of those events (the day before
 * and after the one shown). A body up or down all through gets the local day.
 */
export function passWindow(passage: Passage, day: readonly [number, number], zone: Zone): [number, number] {
  const [start, end] = day;
  const onPass = passage.kind === 'up' || passage.kind === 'down';
  let a = onPass ? (passage.rise?.jd_utc ?? start - 1) : start;
  const b = onPass ? (passage.set?.jd_utc ?? end + 1) + PATH_STEP_MIN / 1440 : end;
  const w = wallClock(a, zone);
  a -= (w.minute * 60 + w.second + w.millisecond / 1000) / 86_400;
  return [a, b];
}

/**
 * The rise, highest point and set of the pass for the dial, in the display zone. A time on
 * another day than the one shown carries its weekday, as the panel's cards do: "Moonset
 * 05:37 Fri".
 */
export function dialEvents(body: string, passage: Passage, jd: number, zone: Zone): DialEvent[] {
  const events: DialEvent[] = [];
  for (const [kind, e] of [
    ['rise', passage.rise],
    ['transit', passage.transit],
    ['set', passage.set],
  ] as const) {
    if (!e) continue;
    const day = otherDay(e.jd_utc, jd, zone);
    const time = `${formatTime(e.jd_utc, zone)}${day ? ` ${day}` : ''}`;
    events.push({ kind, alt: e.alt_deg, az: e.az_deg, label: `${eventWords(body, kind)} ${time}`, time });
  }
  return events;
}

/** "Moon up all day" and the like, or '' for a body that rises and sets. */
export function passNote(body: string, passage: Passage): string {
  if (passage.kind === 'always-up') return `${body} up all day`;
  if (passage.kind === 'always-down') return `${body} down all day`;
  return '';
}
